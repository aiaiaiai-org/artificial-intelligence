// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! End-to-end checks that a model proposal cannot become an effect on its own.
//!
//! Two properties are load-bearing here beyond the authority chain itself: a legitimate
//! proposal identifier is authority for exactly the proposal the session produced under it
//! and nothing else, and a failed proposal round leaves no session state behind.

use aiai_contracts::{
    CapabilityName, ContextPort, ControllerId, ErrorCode, ModelId, OperationId, ProposalEnvelope,
    ProposalId, RuntimeId, SessionId, SubjectId,
};
use aiai_runtime::{
    ActivationState, ActivationTransition, Authority, AuthorityDecision, Candidate, Clock,
    ContinuityRelation, DelegationScope, IdentifierGeneration, Inference, PortError, PortKind,
    RuntimeSession, SubjectBinding,
};

/// The product-defined proposal payload. The foundation never inspects it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Utterance(&'static str);

struct FixedClock(u64);

impl Clock for FixedClock {
    fn now_unix_ms(&self) -> Result<aiai_contracts::DecimalU64, PortError> {
        Ok(aiai_contracts::DecimalU64::new(self.0))
    }
}

struct UnavailableClock;

impl Clock for UnavailableClock {
    fn now_unix_ms(&self) -> Result<aiai_contracts::DecimalU64, PortError> {
        Err(PortError {
            port: PortKind::Clock,
        })
    }
}

#[derive(Default)]
struct CountingIdentifiers(u8);

impl IdentifierGeneration for CountingIdentifiers {
    fn next_proposal_id(&mut self) -> Result<ProposalId, PortError> {
        self.0 += 1;
        format!("prp_{:032x}", self.0)
            .parse()
            .map_err(|_| PortError {
                port: PortKind::IdentifierGeneration,
            })
    }
}

struct UnavailableIdentifiers;

impl IdentifierGeneration for UnavailableIdentifiers {
    fn next_proposal_id(&mut self) -> Result<ProposalId, PortError> {
        Err(PortError {
            port: PortKind::IdentifierGeneration,
        })
    }
}

/// Inference that always returns the same candidates.
struct ScriptedInference(Vec<Candidate<Utterance>>);

impl Inference for ScriptedInference {
    type Request = ();
    type Proposal = Utterance;

    fn propose(&mut self, (): &()) -> Result<Vec<Candidate<Utterance>>, PortError> {
        Ok(self.0.clone())
    }
}

/// Inference that cannot answer at all.
struct UnavailableInference;

impl Inference for UnavailableInference {
    type Request = ();
    type Proposal = Utterance;

    fn propose(&mut self, (): &()) -> Result<Vec<Candidate<Utterance>>, PortError> {
        Err(PortError {
            port: PortKind::Inference,
        })
    }
}

/// Authority that answers with a fixed decision.
struct FixedAuthority(AuthorityDecision);

impl Authority for FixedAuthority {
    type Proposal = Utterance;

    fn decide(&self, _: &ProposalEnvelope<Utterance>) -> Result<AuthorityDecision, PortError> {
        Ok(self.0.clone())
    }
}

/// Authority that is unreachable. Unreachable is never approval.
struct UnavailableAuthority;

impl Authority for UnavailableAuthority {
    type Proposal = Utterance;

    fn decide(&self, _: &ProposalEnvelope<Utterance>) -> Result<AuthorityDecision, PortError> {
        Err(PortError {
            port: PortKind::Authority,
        })
    }
}

fn capability(name: &str) -> CapabilityName {
    name.parse().expect("canonical capability name")
}

fn operation(seed: u8) -> OperationId {
    format!("op_{seed:032x}")
        .parse()
        .expect("canonical operation id")
}

fn binding(runtime_seed: char) -> SubjectBinding {
    SubjectBinding::new(
        format!("sub_{}", "a".repeat(64)).parse().expect("subject"),
        format!("ctl_{}", "b".repeat(32))
            .parse::<ControllerId>()
            .expect("controller"),
        format!("rt_{}", String::from(runtime_seed).repeat(32))
            .parse::<RuntimeId>()
            .expect("runtime"),
        Some(
            format!("mdl_{}", "d".repeat(32))
                .parse::<ModelId>()
                .expect("model"),
        ),
    )
}

fn scope() -> DelegationScope {
    DelegationScope::new([capability("message")])
}

fn session() -> RuntimeSession<Utterance> {
    RuntimeSession::new(
        format!("ses_{}", "e".repeat(32))
            .parse::<SessionId>()
            .expect("session"),
        binding('c'),
        scope(),
    )
}

fn awake() -> RuntimeSession<Utterance> {
    let mut session = session();
    session
        .apply_activation(None, ActivationTransition::Wake)
        .expect("a dormant session wakes");
    session
}

fn scripted() -> ScriptedInference {
    ScriptedInference(vec![Candidate {
        requested_capability: capability("message"),
        proposal: Utterance("hello"),
    }])
}

/// Inference returning two distinct candidates, so batch behaviour is observable.
fn scripted_pair() -> ScriptedInference {
    ScriptedInference(vec![
        Candidate {
            requested_capability: capability("message"),
            proposal: Utterance("first"),
        },
        Candidate {
            requested_capability: capability("message"),
            proposal: Utterance("second"),
        },
    ])
}

/// Identifier generation that answers `available` times and then fails.
struct FailingIdentifiers {
    available: u8,
    issued: u8,
}

impl IdentifierGeneration for FailingIdentifiers {
    fn next_proposal_id(&mut self) -> Result<ProposalId, PortError> {
        if self.issued >= self.available {
            return Err(PortError {
                port: PortKind::IdentifierGeneration,
            });
        }
        self.issued += 1;
        format!("prp_{:032x}", self.issued)
            .parse()
            .map_err(|_| PortError {
                port: PortKind::IdentifierGeneration,
            })
    }
}

/// Identifier generation that always answers with the same identifier.
struct RepeatingIdentifiers;

impl IdentifierGeneration for RepeatingIdentifiers {
    fn next_proposal_id(&mut self) -> Result<ProposalId, PortError> {
        "prp_00000000000000000000000000000001"
            .parse()
            .map_err(|_| PortError {
                port: PortKind::IdentifierGeneration,
            })
    }
}

/// Authority that records exactly what it was asked to decide.
struct RecordingAuthority {
    decision: AuthorityDecision,
    seen: std::cell::RefCell<Vec<ProposalEnvelope<Utterance>>>,
}

impl RecordingAuthority {
    fn admitting(capability_name: &str) -> Self {
        Self {
            decision: AuthorityDecision::Admit {
                granted_capability: capability(capability_name),
            },
            seen: std::cell::RefCell::new(Vec::new()),
        }
    }

    fn only_seen(&self) -> ProposalEnvelope<Utterance> {
        let seen = self.seen.borrow();
        assert_eq!(seen.len(), 1, "the authority decided exactly once");
        seen[0].clone()
    }
}

impl Authority for RecordingAuthority {
    type Proposal = Utterance;

    fn decide(
        &self,
        proposal: &ProposalEnvelope<Utterance>,
    ) -> Result<AuthorityDecision, PortError> {
        self.seen.borrow_mut().push(proposal.clone());
        Ok(self.decision.clone())
    }
}

/// Produces one proposal and returns the identifier the session now owns it under.
///
/// `seed` keeps identifiers distinct across several calls in one test.
fn propose_one(session: &mut RuntimeSession<Utterance>, seed: u8) -> ProposalId {
    let mut ids = session
        .propose(
            operation(1),
            &(),
            &mut scripted(),
            &mut CountingIdentifiers(seed),
        )
        .expect("an active session proposes");
    assert_eq!(ids.len(), 1, "one candidate was scripted");
    ids.pop().expect("one identifier")
}

/// Returns the sequence the session recorded for a pending proposal.
fn pending_sequence(
    session: &RuntimeSession<Utterance>,
    proposal_id: &ProposalId,
) -> aiai_contracts::DecimalU64 {
    session
        .pending_proposal(proposal_id)
        .expect("the session owns this proposal")
        .sequence
}

#[test]
fn a_dormant_session_produces_nothing() {
    let mut session = session();
    let error = session
        .propose(
            operation(1),
            &(),
            &mut scripted(),
            &mut CountingIdentifiers::default(),
        )
        .expect_err("a dormant runtime proposes nothing");
    assert_eq!(error.code(), ErrorCode::RuntimeInactive);

    let error = session
        .wake(operation(2), "peer_arrived", &FixedClock(1_000))
        .expect_err("a dormant runtime does not record wakes");
    assert_eq!(error.code(), ErrorCode::RuntimeInactive);
    assert_eq!(session.pending_proposals(), 0);
}

#[test]
fn unavailable_computation_degrades_explicitly() {
    let mut session = awake();
    let error = session
        .propose(
            operation(1),
            &(),
            &mut UnavailableInference,
            &mut CountingIdentifiers::default(),
        )
        .expect_err("unavailable inference is an explicit outcome");
    assert_eq!(error.code(), ErrorCode::InferenceUnavailable);
    assert_eq!(session.pending_proposals(), 0);
}

#[test]
fn an_unavailable_clock_is_not_a_substituted_timestamp() {
    let mut session = awake();
    let error = session
        .wake(operation(1), "peer_arrived", &UnavailableClock)
        .expect_err("a missing clock is reported");
    assert_eq!(error.code(), ErrorCode::MissingContext);
}

#[test]
fn unavailable_identifier_generation_names_the_correct_port() {
    let mut session = awake();
    let error = session
        .propose(
            operation(1),
            &(),
            &mut scripted(),
            &mut UnavailableIdentifiers,
        )
        .expect_err("missing identifier generation is reported");

    assert_eq!(error.code(), ErrorCode::MissingContext);
    assert_eq!(
        error.details().and_then(|details| details.port),
        Some(ContextPort::IdentifierGeneration)
    );
    assert_eq!(session.pending_proposals(), 0);
}

#[test]
fn a_withheld_proposal_never_becomes_an_action() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let error = session
        .admit(
            operation(2),
            &proposal_id,
            &FixedAuthority(AuthorityDecision::Withhold),
        )
        .expect_err("a withheld proposal is not admitted");
    assert_eq!(error.code(), ErrorCode::AuthorityWithheld);
    assert_eq!(session.pending_proposals(), 0);
}

#[test]
fn an_unreachable_authority_is_not_approval() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let error = session
        .admit(operation(2), &proposal_id, &UnavailableAuthority)
        .expect_err("an unreachable authority is not approval");
    assert_eq!(error.code(), ErrorCode::MissingContext);

    // An unavailable port is not a decision, so the proposal is still awaiting one.
    assert_eq!(session.pending_proposals(), 1);
    assert!(session.pending_proposal(&proposal_id).is_some());
}

#[test]
fn a_grant_outside_the_delegation_scope_is_refused() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let error = session
        .admit(
            operation(2),
            &proposal_id,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("deliver_asset"),
            }),
        )
        .expect_err("an out-of-scope grant is refused");
    assert_eq!(error.code(), ErrorCode::AuthorityScopeExceeded);
    assert_eq!(session.pending_proposals(), 0);
}

#[test]
fn a_proposal_this_session_never_made_is_unknown() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let foreign: ProposalId = "prp_00000000000000000000000000000099"
        .parse()
        .expect("canonical proposal id");
    let error = session
        .admit(
            operation(2),
            &foreign,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect_err("a foreign proposal is unknown");
    assert_eq!(error.code(), ErrorCode::UnknownProposal);

    // The session's own proposal is untouched by the foreign attempt.
    assert_eq!(session.pending_proposals(), 1);
    assert!(session.pending_proposal(&proposal_id).is_some());
}

#[test]
fn an_admitted_proposal_reaches_dispatch_exactly_once() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);

    let admitted = session
        .admit(
            operation(2),
            &proposal_id,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect("an in-scope grant is admitted");
    assert_eq!(admitted.envelope().proposal_id, proposal_id);
    assert_eq!(
        admitted.envelope().granted_capability,
        capability("message")
    );
    assert_eq!(session.pending_proposals(), 0);

    let effect = session
        .dispatch(operation(3), admitted)
        .expect("an admitted action dispatches");
    assert_eq!(effect.effect, Utterance("hello"));

    // `admitted` was moved into `dispatch`, so the same admission cannot be dispatched
    // again. `Admitted` is deliberately neither `Clone` nor `Copy`.
}

#[test]
fn quiescing_settles_in_flight_work_and_starts_none() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);

    session
        .apply_activation(None, ActivationTransition::Quiesce)
        .expect("an active session quiesces");

    let error = session
        .propose(
            operation(4),
            &(),
            &mut scripted(),
            &mut CountingIdentifiers::default(),
        )
        .expect_err("a quiescing session starts nothing new");
    assert_eq!(error.code(), ErrorCode::RuntimeInactive);

    session
        .admit(
            operation(5),
            &proposal_id,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect("in-flight work still reaches its boundary");
}

#[test]
fn settling_never_completes_or_cancels_pending_work() {
    let mut session = awake();
    let _pending = propose_one(&mut session, 1);
    assert_eq!(session.pending_proposals(), 1);

    session
        .apply_activation(None, ActivationTransition::Quiesce)
        .expect("quiesce");
    session
        .apply_activation(None, ActivationTransition::Settle)
        .expect("settle");

    // The proposal is neither completed nor cancelled by going dormant: it is simply
    // still undecided, and a dormant session decides nothing.
    assert_eq!(session.pending_proposals(), 1);
    let error = session
        .apply_activation(None, ActivationTransition::Settle)
        .expect_err("settle is not defined from dormant");
    assert_eq!(error.code(), ErrorCode::RuntimeInactive);
}

#[test]
fn replacing_the_runtime_mid_flight_preserves_the_subject_and_its_work() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let subject_before = session.binding().subject_id().clone();

    let relation = session
        .rebind(None, binding('f'))
        .expect("a runtime swap preserves the subject");
    assert!(matches!(relation, ContinuityRelation::Continuous(_)));
    assert_eq!(session.binding().subject_id(), &subject_before);
    assert_eq!(session.pending_proposals(), 1);

    session
        .admit(
            operation(6),
            &proposal_id,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect("work started before the swap survives it");
}

#[test]
fn a_session_cannot_be_moved_onto_another_subject() {
    let mut session = awake();
    let other = SubjectBinding::new(
        format!("sub_{}", "b".repeat(64))
            .parse::<SubjectId>()
            .expect("subject"),
        format!("ctl_{}", "b".repeat(32))
            .parse::<ControllerId>()
            .expect("controller"),
        format!("rt_{}", "c".repeat(32))
            .parse::<RuntimeId>()
            .expect("runtime"),
        None,
    );
    let error = session
        .rebind(Some(operation(7)), other)
        .expect_err("a rebind cannot change the subject");
    assert_eq!(error.code(), ErrorCode::SubjectContinuityViolation);
}

#[test]
fn emitted_sequence_numbers_are_strictly_monotonic() {
    let mut session = awake();
    let first = propose_one(&mut session, 10);
    let second = propose_one(&mut session, 20);
    let first_sequence = pending_sequence(&session, &first);
    assert!(pending_sequence(&session, &second) > first_sequence);

    let admitted = session
        .admit(
            operation(8),
            &second,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect("admitted");
    let admitted_sequence = admitted.envelope().sequence;
    let effect = session
        .dispatch(operation(9), admitted)
        .expect("dispatched");
    assert!(admitted_sequence > first_sequence);
    assert!(effect.sequence > admitted_sequence);
}

// ---------------------------------------------------------------------------
// Proposal provenance
//
// `admit` takes an identifier, not an envelope. These tests build the envelope a
// caller would have to substitute in order to widen a legitimate identifier into
// authority for different content, and show that the authority and the dispatched
// effect still carry the session's own proposal.
// ---------------------------------------------------------------------------

/// Returns the envelope a caller would submit if `admit` accepted proposal content.
fn tampered(original: &ProposalEnvelope<Utterance>) -> ProposalEnvelope<Utterance> {
    ProposalEnvelope {
        contract_version: "0.2.0".parse().expect("canonical contract version"),
        operation_id: operation(200),
        proposal_id: original.proposal_id.clone(),
        sequence: aiai_contracts::DecimalU64::new(9_999),
        requested_capability: original.requested_capability.clone(),
        proposal: Utterance("substituted"),
    }
}

#[test]
fn mutated_payload_cannot_reach_authority_or_dispatch() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let original = session
        .pending_proposal(&proposal_id)
        .expect("the session owns its proposal")
        .clone();
    let substituted = tampered(&original);
    assert_ne!(substituted.proposal, original.proposal);

    let authority = RecordingAuthority::admitting("message");
    let admitted = session
        .admit(operation(2), &proposal_id, &authority)
        .expect("the session's own proposal is admitted");

    assert_eq!(authority.only_seen().proposal, original.proposal);
    assert_eq!(admitted.envelope().action, original.proposal);

    let effect = session
        .dispatch(operation(3), admitted)
        .expect("dispatched");
    assert_eq!(effect.effect, original.proposal);
}

#[test]
fn mutated_sequence_cannot_alter_the_admitted_proposal() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let original = session
        .pending_proposal(&proposal_id)
        .expect("owned")
        .clone();
    assert_ne!(tampered(&original).sequence, original.sequence);

    let authority = RecordingAuthority::admitting("message");
    session
        .admit(operation(2), &proposal_id, &authority)
        .expect("admitted");

    assert_eq!(authority.only_seen().sequence, original.sequence);
}

#[test]
fn mutated_operation_id_does_not_reach_authority() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let original = session
        .pending_proposal(&proposal_id)
        .expect("owned")
        .clone();
    assert_ne!(tampered(&original).operation_id, original.operation_id);

    let authority = RecordingAuthority::admitting("message");
    session
        .admit(operation(2), &proposal_id, &authority)
        .expect("admitted");

    assert_eq!(authority.only_seen().operation_id, original.operation_id);
}

#[test]
fn mutated_contract_version_does_not_reach_authority() {
    let mut session = awake();
    let proposal_id = propose_one(&mut session, 1);
    let original = session
        .pending_proposal(&proposal_id)
        .expect("owned")
        .clone();
    assert_ne!(
        tampered(&original).contract_version,
        original.contract_version
    );

    let authority = RecordingAuthority::admitting("message");
    session
        .admit(operation(2), &proposal_id, &authority)
        .expect("admitted");

    assert_eq!(
        authority.only_seen().contract_version,
        original.contract_version
    );
}

#[test]
fn an_unknown_proposal_id_never_reaches_authority() {
    let mut session = awake();
    let _owned = propose_one(&mut session, 1);
    let foreign: ProposalId = "prp_000000000000000000000000000000ff"
        .parse()
        .expect("canonical proposal id");

    let authority = RecordingAuthority::admitting("message");
    let error = session
        .admit(operation(2), &foreign, &authority)
        .expect_err("an unknown identifier is refused");

    assert_eq!(error.code(), ErrorCode::UnknownProposal);
    assert!(
        authority.seen.borrow().is_empty(),
        "the authority is never consulted about a proposal this session does not own"
    );
}

// ---------------------------------------------------------------------------
// Transactional propose
// ---------------------------------------------------------------------------

#[test]
fn identifier_failure_after_the_first_candidate_leaves_no_pending_state() {
    let mut session = awake();
    let revision_before = session.revision();

    let error = session
        .propose(
            operation(1),
            &(),
            &mut scripted_pair(),
            &mut FailingIdentifiers {
                available: 1,
                issued: 0,
            },
        )
        .expect_err("the batch fails on the second candidate");

    assert_eq!(error.code(), ErrorCode::MissingContext);
    assert_eq!(
        error.details().and_then(|details| details.port),
        Some(ContextPort::IdentifierGeneration)
    );
    assert_eq!(
        session.pending_proposals(),
        0,
        "the first candidate must not survive as hidden pending work"
    );
    assert_eq!(
        session.revision(),
        revision_before,
        "a failed batch commits no revision"
    );

    // The sequence counter is untouched too: the next successful batch starts at 1.
    let ids = session
        .propose(
            operation(2),
            &(),
            &mut scripted_pair(),
            &mut CountingIdentifiers::default(),
        )
        .expect("a later batch succeeds");
    assert_eq!(
        pending_sequence(&session, &ids[0]),
        aiai_contracts::DecimalU64::new(1)
    );
}

#[test]
fn a_successful_batch_commits_every_proposal_and_no_others() {
    let mut session = awake();
    let ids = session
        .propose(
            operation(1),
            &(),
            &mut scripted_pair(),
            &mut CountingIdentifiers::default(),
        )
        .expect("an active session proposes");

    assert_eq!(ids.len(), 2);
    assert_eq!(session.pending_proposals(), 2);
    for proposal_id in &ids {
        assert!(session.pending_proposal(proposal_id).is_some());
    }
    let owned: Vec<&ProposalId> = session.pending_proposal_ids().collect();
    assert_eq!(owned.len(), 2, "no hidden proposals exist");
    assert_eq!(
        session
            .pending_proposal(&ids[0])
            .expect("owned")
            .requested_capability,
        capability("message")
    );
}

#[test]
fn a_repeated_identifier_is_refused_rather_than_overwriting_a_proposal() {
    let mut session = awake();
    let error = session
        .propose(
            operation(1),
            &(),
            &mut scripted_pair(),
            &mut RepeatingIdentifiers,
        )
        .expect_err("a repeated identifier is refused");

    assert_eq!(error.code(), ErrorCode::DuplicateProposalId);
    assert_eq!(session.pending_proposals(), 0);

    // The same holds against proposals from an earlier, committed batch: seed 0 makes the
    // committed identifier exactly the one `RepeatingIdentifiers` keeps returning.
    let owned = propose_one(&mut session, 0);
    let original = session
        .pending_proposal(&owned)
        .expect("owned")
        .proposal
        .clone();
    let error = session
        .propose(
            operation(2),
            &(),
            &mut scripted(),
            &mut RepeatingIdentifiers,
        )
        .expect_err("the committed proposal is not overwritten");
    assert_eq!(error.code(), ErrorCode::DuplicateProposalId);
    assert_eq!(session.pending_proposals(), 1);
    assert_eq!(
        session.pending_proposal(&owned).expect("owned").proposal,
        original
    );
}

// ---------------------------------------------------------------------------
// State-targeted activation, for a product that owns a mode enumeration
// ---------------------------------------------------------------------------

#[test]
fn setting_the_state_a_session_already_holds_is_a_no_op() {
    let mut session = awake();
    let revision_before = session.revision();

    let state = session
        .ensure_activation(None, ActivationState::Active)
        .expect("an active session is already active");

    assert_eq!(state, ActivationState::Active);
    assert_eq!(
        session.revision(),
        revision_before,
        "a no-op activation commits no revision"
    );
}

#[test]
fn state_targeted_activation_walks_each_defined_step() {
    let mut session = session();
    assert_eq!(
        session
            .ensure_activation(None, ActivationState::Active)
            .expect("dormant sessions wake"),
        ActivationState::Active
    );
    assert_eq!(
        session
            .ensure_activation(None, ActivationState::Quiescing)
            .expect("active sessions quiesce"),
        ActivationState::Quiescing
    );
    assert_eq!(
        session
            .ensure_activation(None, ActivationState::Dormant)
            .expect("quiescing sessions settle"),
        ActivationState::Dormant
    );
}

#[test]
fn state_targeted_activation_never_settles_on_the_owners_behalf() {
    let mut session = awake();
    session
        .apply_activation(None, ActivationTransition::Quiesce)
        .expect("quiesce");

    let error = session
        .ensure_activation(Some(operation(1)), ActivationState::Active)
        .expect_err("reaching activity would require asserting that work settled");

    assert_eq!(error.code(), ErrorCode::RuntimeInactive);
    assert_eq!(session.activation(), ActivationState::Quiescing);
}
