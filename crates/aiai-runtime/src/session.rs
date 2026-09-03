// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{
    ActivationState, ActivationTransition, Admitted, Authority, AuthorityDecision, Candidate,
    Clock, ContinuityRelation, DelegationScope, IdentifierGeneration, Inference, PortError,
    PortKind, SubjectBinding,
};
use aiai_contracts::{
    AdmissionEnvelope, ContextPort, ContractVersion, DecimalU64, EffectRequestEnvelope,
    FoundationError, OperationId, ProposalEnvelope, ProposalId, SessionId, WakeEnvelope,
};
use std::collections::BTreeMap;

const fn context_port(port: PortKind) -> ContextPort {
    match port {
        PortKind::Clock => ContextPort::Clock,
        PortKind::Entropy => ContextPort::Entropy,
        PortKind::IdentifierGeneration => ContextPort::IdentifierGeneration,
        PortKind::Inference => ContextPort::Inference,
        PortKind::Authority => ContextPort::Authority,
    }
}

/// One bounded activation of a replaceable runtime on behalf of one durable subject.
///
/// The session owns the order in which a turn may happen:
///
/// ```text
/// wake -> propose -> admit -> dispatch
/// ```
///
/// Each step is gated. A dormant session proposes nothing; a proposal becomes an
/// [`Admitted`] value only through an authority decision inside the session's delegation
/// scope; and only an [`Admitted`] value can become an effect request. There is no path
/// from a [`ProposalEnvelope`] to an [`EffectRequestEnvelope`].
///
/// # Proposal ownership
///
/// The session owns the canonical content of every proposal it produced. [`propose`] keeps
/// the complete envelopes and hands back only their identifiers; [`admit`] resolves the
/// proposal it decides exclusively from that owned state. No method accepts a
/// caller-supplied [`ProposalEnvelope`], so a caller holding a legitimate [`ProposalId`]
/// cannot turn it into authority for different payload, sequence, operation, or contract
/// version — there is no input through which substituted content could arrive. Read access
/// to a pending proposal is available through [`pending_proposal`], which lends the
/// original rather than reconstructing it.
///
/// # Transactional propose
///
/// [`propose`] stages an entire batch before touching session state. When any step fails —
/// unavailable computation, unavailable identifier generation, a duplicate identifier, an
/// exhausted counter — the call returns `Err` having mutated nothing: no pending entry, no
/// sequence advance, and no revision advance. A failed proposal round therefore leaves no
/// proposal the caller never received.
///
/// [`propose`]: RuntimeSession::propose
/// [`admit`]: RuntimeSession::admit
/// [`pending_proposal`]: RuntimeSession::pending_proposal
#[derive(Debug)]
pub struct RuntimeSession<P> {
    session_id: SessionId,
    binding: SubjectBinding,
    scope: DelegationScope,
    activation: ActivationState,
    sequence: DecimalU64,
    revision: DecimalU64,
    pending: BTreeMap<ProposalId, ProposalEnvelope<P>>,
}

impl<P> RuntimeSession<P> {
    /// Opens a dormant session for `binding` bounded by `scope`.
    #[must_use]
    pub fn new(session_id: SessionId, binding: SubjectBinding, scope: DelegationScope) -> Self {
        Self {
            session_id,
            binding,
            scope,
            activation: ActivationState::Dormant,
            sequence: DecimalU64::new(0),
            revision: DecimalU64::new(0),
            pending: BTreeMap::new(),
        }
    }

    /// Returns this session's identifier.
    #[must_use]
    pub const fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// Returns the subject binding this session serves.
    #[must_use]
    pub const fn binding(&self) -> &SubjectBinding {
        &self.binding
    }

    /// Returns the delegation scope bounding every admission in this session.
    #[must_use]
    pub const fn scope(&self) -> &DelegationScope {
        &self.scope
    }

    /// Returns the current activation state.
    #[must_use]
    pub const fn activation(&self) -> ActivationState {
        self.activation
    }

    /// Returns the monotonic session revision.
    #[must_use]
    pub const fn revision(&self) -> DecimalU64 {
        self.revision
    }

    /// Returns the number of proposals awaiting an authority decision.
    #[must_use]
    pub fn pending_proposals(&self) -> usize {
        self.pending.len()
    }

    /// Lends the original proposal this session produced under `proposal_id`.
    ///
    /// This is read access to session-owned state, not a round trip: the value returned
    /// here is the one [`RuntimeSession::admit`] will hand to the authority port. A
    /// product serializes or renders it; it cannot substitute it.
    #[must_use]
    pub fn pending_proposal(&self, proposal_id: &ProposalId) -> Option<&ProposalEnvelope<P>> {
        self.pending.get(proposal_id)
    }

    /// Returns the identifiers of every proposal awaiting an authority decision.
    pub fn pending_proposal_ids(&self) -> impl Iterator<Item = &ProposalId> {
        self.pending.keys()
    }

    /// Drives activation toward `target`, which makes setting a product mode idempotent.
    ///
    /// A product that owns a mode enumeration — one mode per activation state — maps modes
    /// onto states rather than onto edges. Re-applying the mode a session is already in is
    /// a no-op that neither fails nor advances the revision.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] when no single defined transition
    /// reaches `target`. In particular reaching activity from
    /// [`ActivationState::Quiescing`] is refused here rather than resolved by settling
    /// first: settling asserts that in-flight work reached its boundary, and the session
    /// will not make that assertion on the owner's behalf.
    pub fn ensure_activation(
        &mut self,
        operation_id: Option<OperationId>,
        target: ActivationState,
    ) -> Result<ActivationState, FoundationError> {
        let resolved = self
            .activation
            .transition_to(target)
            .map_err(|_| FoundationError::runtime_inactive(operation_id.clone()))?;
        match resolved {
            None => Ok(self.activation),
            Some(transition) => self.apply_activation(operation_id, transition),
        }
    }

    /// Applies an activation transition.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] when the transition is not defined
    /// from the current state. Quiescing never resumes into activity, so leaving activity
    /// cannot silently restart in-flight work.
    pub fn apply_activation(
        &mut self,
        operation_id: Option<OperationId>,
        transition: ActivationTransition,
    ) -> Result<ActivationState, FoundationError> {
        let next = self
            .activation
            .apply(transition)
            .map_err(|_| FoundationError::runtime_inactive(operation_id))?;
        self.activation = next;
        self.bump_revision()?;
        Ok(next)
    }

    /// Replaces the computation serving this session's subject.
    ///
    /// Pending proposals survive a rebind: the subject did not change, so work it already
    /// started is neither completed nor cancelled by swapping the runtime behind it.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::subject_continuity_violation`] if `replacement` names a
    /// different subject, and [`FoundationError::sequence_exhausted`] at the counter
    /// ceiling.
    pub fn rebind(
        &mut self,
        operation_id: Option<OperationId>,
        replacement: SubjectBinding,
    ) -> Result<ContinuityRelation, FoundationError> {
        let relation = self.binding.classify(&replacement);
        if relation == ContinuityRelation::DistinctSubject {
            return Err(FoundationError::subject_continuity_violation(
                operation_id,
                self.binding.subject_id().clone(),
                replacement.subject_id().clone(),
            ));
        }
        self.binding = replacement;
        self.bump_revision()?;
        Ok(relation)
    }

    /// Records the external occurrence that woke this session.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] unless the session is active, and
    /// [`FoundationError::missing_context`] when the clock port is unavailable.
    pub fn wake<R>(
        &mut self,
        operation_id: OperationId,
        reason: R,
        clock: &impl Clock,
    ) -> Result<WakeEnvelope<R>, FoundationError> {
        if !self.activation.may_initiate() {
            return Err(FoundationError::runtime_inactive(Some(operation_id)));
        }
        let observed_at_unix_ms = clock
            .now_unix_ms()
            .map_err(|error| Self::port_failure(Some(operation_id.clone()), error))?;
        self.bump_revision()?;
        Ok(WakeEnvelope {
            contract_version: ContractVersion::CURRENT,
            operation_id,
            session_id: self.session_id.clone(),
            observed_at_unix_ms,
            reason,
        })
    }

    /// Asks computation for candidate actions and records them as pending proposals.
    ///
    /// The whole batch is staged in local state first and committed only once every step
    /// has succeeded, so a failed round mutates nothing at all. Only the identifiers are
    /// returned: the session keeps the canonical envelopes, which
    /// [`RuntimeSession::pending_proposal`] lends for display or serialization and
    /// [`RuntimeSession::admit`] reads when an authority decides.
    ///
    /// Computation that cannot be reached through a synchronous port — a model in another
    /// process, another language, or behind an async boundary — goes through
    /// [`RuntimeSession::propose_candidates`] instead.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] unless the session is active,
    /// [`FoundationError::inference_unavailable`] when computation cannot answer, and
    /// whatever [`RuntimeSession::propose_candidates`] returns for the batch itself. A
    /// dormant session never reaches the inference port at all, an unavailable runtime
    /// never yields an empty success, and none of these failures leaves a pending proposal
    /// behind.
    pub fn propose<I>(
        &mut self,
        operation_id: OperationId,
        request: &I::Request,
        inference: &mut I,
        identifiers: &mut impl IdentifierGeneration,
    ) -> Result<Vec<ProposalId>, FoundationError>
    where
        I: Inference<Proposal = P>,
    {
        if !self.activation.may_initiate() {
            return Err(FoundationError::runtime_inactive(Some(operation_id)));
        }

        let candidates = inference
            .propose(request)
            .map_err(|_| FoundationError::inference_unavailable(Some(operation_id.clone())))?;

        self.propose_candidates(operation_id, candidates, identifiers)
    }

    /// Records candidates that computation already produced elsewhere.
    ///
    /// The [`Inference`] port is synchronous, which a model reached across an async or
    /// foreign-language boundary — a browser worker, a separate process, a remote service —
    /// cannot satisfy without blocking. Such a runtime runs its computation on its own side
    /// and hands the resulting candidates here.
    ///
    /// This grants a caller nothing that the [`Inference`] port does not. A candidate is
    /// pre-proposal input in both paths: the session still mints the `proposal_id`,
    /// `sequence`, `operation_id`, and `contract_version`, still owns the resulting
    /// envelopes, and still requires an [`Authority`] decision before any of them can
    /// become an action. What the caller does take on is reporting its own computation
    /// failure: there is no port here to return [`PortError`], so an unreachable model is
    /// the caller's explicit outcome to surface rather than an empty batch passed off as
    /// success.
    ///
    /// Staging and commit are the same as [`RuntimeSession::propose`], so a failed batch
    /// mutates nothing.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] unless the session is active,
    /// [`FoundationError::missing_context`] when identifier generation is unavailable,
    /// [`FoundationError::duplicate_proposal_id`] when identifier generation repeats an
    /// identifier this session already holds, and [`FoundationError::sequence_exhausted`]
    /// at a counter ceiling.
    pub fn propose_candidates(
        &mut self,
        operation_id: OperationId,
        candidates: Vec<Candidate<P>>,
        identifiers: &mut impl IdentifierGeneration,
    ) -> Result<Vec<ProposalId>, FoundationError> {
        if !self.activation.may_initiate() {
            return Err(FoundationError::runtime_inactive(Some(operation_id)));
        }

        // Stage. Nothing below this point reads or writes committed session state, so
        // returning early here leaves the session exactly as it was found.
        let mut sequence = self.sequence;
        let mut staged: Vec<ProposalEnvelope<P>> = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let proposal_id = identifiers
                .next_proposal_id()
                .map_err(|error| Self::port_failure(Some(operation_id.clone()), error))?;
            if self.pending.contains_key(&proposal_id)
                || staged
                    .iter()
                    .any(|envelope| envelope.proposal_id == proposal_id)
            {
                return Err(FoundationError::duplicate_proposal_id(
                    Some(operation_id.clone()),
                    proposal_id,
                ));
            }
            sequence = sequence
                .next()
                .ok_or_else(|| FoundationError::sequence_exhausted(Some(operation_id.clone())))?;
            staged.push(ProposalEnvelope {
                contract_version: ContractVersion::CURRENT,
                operation_id: operation_id.clone(),
                proposal_id,
                sequence,
                requested_capability: candidate.requested_capability,
                proposal: candidate.proposal,
            });
        }
        let revision = self
            .revision
            .next()
            .ok_or_else(|| FoundationError::sequence_exhausted(Some(operation_id)))?;

        // Commit. Every fallible step is behind us.
        let mut proposal_ids = Vec::with_capacity(staged.len());
        for envelope in staged {
            proposal_ids.push(envelope.proposal_id.clone());
            self.pending.insert(envelope.proposal_id.clone(), envelope);
        }
        self.sequence = sequence;
        self.revision = revision;
        Ok(proposal_ids)
    }

    /// Submits the proposal this session produced under `proposal_id` to an authority port.
    ///
    /// The decided proposal is resolved from session-owned state. There is no parameter
    /// through which a caller could supply proposal content, so a legitimate identifier
    /// cannot become authority for anything other than the proposal this session actually
    /// produced under it.
    ///
    /// Admission is permitted while quiescing so that work already started can reach a
    /// boundary, but a quiescing session still starts nothing new.
    ///
    /// The pending proposal is released only on a terminal authority decision — admitted,
    /// withheld, or granted outside scope. An unavailable authority port is not a decision:
    /// the proposal stays pending so the same decision can be sought again.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] when the session cannot settle
    /// in-flight work, [`FoundationError::unknown_proposal`] when this session holds no
    /// pending proposal under `proposal_id`, [`FoundationError::missing_context`] when the
    /// authority port is unavailable, [`FoundationError::authority_withheld`] when it
    /// declines, and [`FoundationError::authority_scope_exceeded`] when it grants a
    /// capability outside this session's delegation scope.
    pub fn admit<A>(
        &mut self,
        operation_id: OperationId,
        proposal_id: &ProposalId,
        authority: &A,
    ) -> Result<Admitted<P>, FoundationError>
    where
        A: Authority<Proposal = P>,
    {
        if !self.activation.may_settle_in_flight() {
            return Err(FoundationError::runtime_inactive(Some(operation_id)));
        }

        let Some(proposal) = self.pending.get(proposal_id) else {
            return Err(FoundationError::unknown_proposal(
                Some(operation_id),
                proposal_id.clone(),
            ));
        };

        // The authority decides the session's own proposal, borrowed in place.
        let decision = authority
            .decide(proposal)
            .map_err(|error| Self::port_failure(Some(operation_id.clone()), error))?;

        let AuthorityDecision::Admit { granted_capability } = decision else {
            let withheld = self.release_decided(proposal_id)?;
            return Err(FoundationError::authority_withheld(
                Some(operation_id),
                withheld.proposal_id,
                withheld.requested_capability,
            ));
        };

        if !self.scope.permits(&granted_capability) {
            let refused = self.release_decided(proposal_id)?;
            return Err(FoundationError::authority_scope_exceeded(
                Some(operation_id),
                refused.proposal_id,
                granted_capability,
            ));
        }

        let sequence = self
            .sequence
            .next()
            .ok_or_else(|| FoundationError::sequence_exhausted(Some(operation_id.clone())))?;
        let revision = self
            .revision
            .next()
            .ok_or_else(|| FoundationError::sequence_exhausted(Some(operation_id.clone())))?;
        let Some(admitted) = self.pending.remove(proposal_id) else {
            return Err(FoundationError::unknown_proposal(
                Some(operation_id),
                proposal_id.clone(),
            ));
        };
        self.sequence = sequence;
        self.revision = revision;

        Ok(Admitted::new(AdmissionEnvelope {
            contract_version: ContractVersion::CURRENT,
            operation_id,
            proposal_id: admitted.proposal_id,
            sequence,
            granted_capability,
            action: admitted.proposal,
        }))
    }

    /// Turns an admitted action into one effect request for an external adapter.
    ///
    /// Dispatch is an attempt. It is not execution, acknowledgement, or completion, and
    /// consuming the [`Admitted`] value means one admission dispatches at most once.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::sequence_exhausted`] at the counter ceiling.
    pub fn dispatch(
        &mut self,
        operation_id: OperationId,
        admitted: Admitted<P>,
    ) -> Result<EffectRequestEnvelope<P>, FoundationError> {
        let sequence = self.next_sequence(Some(operation_id.clone()))?;
        let envelope = admitted.into_envelope();
        self.bump_revision()?;
        Ok(EffectRequestEnvelope {
            contract_version: ContractVersion::CURRENT,
            operation_id,
            sequence,
            effect: envelope.action,
        })
    }

    /// Releases a pending proposal an authority reached a terminal decision about.
    ///
    /// The revision is reserved before the entry is removed, so a counter ceiling leaves
    /// the proposal pending rather than dropping it without an observable revision.
    fn release_decided(
        &mut self,
        proposal_id: &ProposalId,
    ) -> Result<ProposalEnvelope<P>, FoundationError> {
        let revision = self
            .revision
            .next()
            .ok_or_else(|| FoundationError::sequence_exhausted(None))?;
        let Some(envelope) = self.pending.remove(proposal_id) else {
            return Err(FoundationError::unknown_proposal(None, proposal_id.clone()));
        };
        self.revision = revision;
        Ok(envelope)
    }

    fn port_failure(operation_id: Option<OperationId>, error: PortError) -> FoundationError {
        FoundationError::missing_context(operation_id, context_port(error.port))
    }

    fn next_sequence(
        &mut self,
        operation_id: Option<OperationId>,
    ) -> Result<DecimalU64, FoundationError> {
        let next = self
            .sequence
            .next()
            .ok_or_else(|| FoundationError::sequence_exhausted(operation_id))?;
        self.sequence = next;
        Ok(next)
    }

    fn bump_revision(&mut self) -> Result<(), FoundationError> {
        self.revision = self
            .revision
            .next()
            .ok_or_else(|| FoundationError::sequence_exhausted(None))?;
        Ok(())
    }
}
