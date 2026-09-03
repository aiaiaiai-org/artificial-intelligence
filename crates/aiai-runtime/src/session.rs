// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{
    ActivationState, ActivationTransition, Admitted, Authority, AuthorityDecision, Clock,
    ContinuityRelation, DelegationScope, IdentifierGeneration, Inference, PortError, PortKind,
    SubjectBinding,
};
use aiai_contracts::{
    AdmissionEnvelope, CapabilityName, ContextPort, ContractVersion, DecimalU64,
    EffectRequestEnvelope, FoundationError, OperationId, ProposalEnvelope, ProposalId, SessionId,
    WakeEnvelope,
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
#[derive(Debug)]
pub struct RuntimeSession<P> {
    session_id: SessionId,
    binding: SubjectBinding,
    scope: DelegationScope,
    activation: ActivationState,
    sequence: DecimalU64,
    revision: DecimalU64,
    pending: BTreeMap<ProposalId, CapabilityName>,
    marker: core::marker::PhantomData<fn() -> P>,
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
            marker: core::marker::PhantomData,
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
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] unless the session is active,
    /// [`FoundationError::inference_unavailable`] when computation cannot answer,
    /// [`FoundationError::missing_context`] when identifier generation is unavailable, and
    /// [`FoundationError::sequence_exhausted`] at the counter ceiling. An unavailable
    /// runtime never yields an empty success.
    pub fn propose<I>(
        &mut self,
        operation_id: OperationId,
        request: &I::Request,
        inference: &mut I,
        identifiers: &mut impl IdentifierGeneration,
    ) -> Result<Vec<ProposalEnvelope<P>>, FoundationError>
    where
        I: Inference<Proposal = P>,
    {
        if !self.activation.may_initiate() {
            return Err(FoundationError::runtime_inactive(Some(operation_id)));
        }

        let candidates = inference
            .propose(request)
            .map_err(|_| FoundationError::inference_unavailable(Some(operation_id.clone())))?;

        let mut envelopes = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let proposal_id = identifiers
                .next_proposal_id()
                .map_err(|error| Self::port_failure(Some(operation_id.clone()), error))?;
            let sequence = self.next_sequence(Some(operation_id.clone()))?;
            self.pending
                .insert(proposal_id.clone(), candidate.requested_capability.clone());
            envelopes.push(ProposalEnvelope {
                contract_version: ContractVersion::CURRENT,
                operation_id: operation_id.clone(),
                proposal_id,
                sequence,
                requested_capability: candidate.requested_capability,
                proposal: candidate.proposal,
            });
        }
        self.bump_revision()?;
        Ok(envelopes)
    }

    /// Submits a pending proposal to an authority port.
    ///
    /// Admission is permitted while quiescing so that work already started can reach a
    /// boundary, but a quiescing session still starts nothing new.
    ///
    /// # Errors
    ///
    /// Returns [`FoundationError::runtime_inactive`] when the session cannot settle
    /// in-flight work, [`FoundationError::unknown_proposal`] when the proposal did not
    /// originate here or was already decided, [`FoundationError::missing_context`] when the
    /// authority port is unavailable, [`FoundationError::authority_withheld`] when it
    /// declines, and [`FoundationError::authority_scope_exceeded`] when it grants a
    /// capability outside this session's delegation scope.
    pub fn admit<A>(
        &mut self,
        operation_id: OperationId,
        proposal: ProposalEnvelope<P>,
        authority: &A,
    ) -> Result<Admitted<P>, FoundationError>
    where
        A: Authority<Proposal = P>,
    {
        if !self.activation.may_settle_in_flight() {
            return Err(FoundationError::runtime_inactive(Some(operation_id)));
        }

        let recorded = self.pending.get(&proposal.proposal_id);
        if recorded != Some(&proposal.requested_capability) {
            return Err(FoundationError::unknown_proposal(
                Some(operation_id),
                proposal.proposal_id,
            ));
        }

        let decision = authority
            .decide(&proposal)
            .map_err(|error| Self::port_failure(Some(operation_id.clone()), error))?;

        let AuthorityDecision::Admit { granted_capability } = decision else {
            self.pending.remove(&proposal.proposal_id);
            return Err(FoundationError::authority_withheld(
                Some(operation_id),
                proposal.proposal_id,
                proposal.requested_capability,
            ));
        };

        if !self.scope.permits(&granted_capability) {
            self.pending.remove(&proposal.proposal_id);
            return Err(FoundationError::authority_scope_exceeded(
                Some(operation_id),
                proposal.proposal_id,
                granted_capability,
            ));
        }

        let sequence = self.next_sequence(Some(operation_id.clone()))?;
        self.pending.remove(&proposal.proposal_id);
        self.bump_revision()?;
        Ok(Admitted::new(AdmissionEnvelope {
            contract_version: ContractVersion::CURRENT,
            operation_id,
            proposal_id: proposal.proposal_id,
            sequence,
            granted_capability,
            action: proposal.proposal,
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
