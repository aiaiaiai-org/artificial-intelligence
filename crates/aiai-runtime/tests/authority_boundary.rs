// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! End-to-end checks that a model proposal cannot become an effect on its own.

use aiai_contracts::{
    CapabilityName, ContextPort, ControllerId, ErrorCode, ModelId, OperationId, ProposalEnvelope,
    ProposalId, RuntimeId, SessionId, SubjectId,
};
use aiai_runtime::{
    ActivationTransition, Authority, AuthorityDecision, Candidate, Clock, ContinuityRelation,
    DelegationScope, IdentifierGeneration, Inference, PortError, PortKind, RuntimeSession,
    SubjectBinding,
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

fn propose_one(session: &mut RuntimeSession<Utterance>) -> ProposalEnvelope<Utterance> {
    session
        .propose(
            operation(1),
            &(),
            &mut scripted(),
            &mut CountingIdentifiers::default(),
        )
        .expect("an active session proposes")
        .pop()
        .expect("one candidate was scripted")
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
    let proposal = propose_one(&mut session);
    let error = session
        .admit(
            operation(2),
            proposal,
            &FixedAuthority(AuthorityDecision::Withhold),
        )
        .expect_err("a withheld proposal is not admitted");
    assert_eq!(error.code(), ErrorCode::AuthorityWithheld);
    assert_eq!(session.pending_proposals(), 0);
}

#[test]
fn an_unreachable_authority_is_not_approval() {
    let mut session = awake();
    let proposal = propose_one(&mut session);
    let error = session
        .admit(operation(2), proposal, &UnavailableAuthority)
        .expect_err("an unreachable authority is not approval");
    assert_eq!(error.code(), ErrorCode::MissingContext);
}

#[test]
fn a_grant_outside_the_delegation_scope_is_refused() {
    let mut session = awake();
    let proposal = propose_one(&mut session);
    let error = session
        .admit(
            operation(2),
            proposal,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("deliver_asset"),
            }),
        )
        .expect_err("an out-of-scope grant is refused");
    assert_eq!(error.code(), ErrorCode::AuthorityScopeExceeded);
}

#[test]
fn a_proposal_this_session_never_made_is_unknown() {
    let mut session = awake();
    let proposal = propose_one(&mut session);
    let replayed = ProposalEnvelope {
        proposal_id: "prp_00000000000000000000000000000099"
            .parse()
            .expect("canonical proposal id"),
        ..proposal
    };
    let error = session
        .admit(
            operation(2),
            replayed,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect_err("a foreign proposal is unknown");
    assert_eq!(error.code(), ErrorCode::UnknownProposal);
}

#[test]
fn an_admitted_proposal_reaches_dispatch_exactly_once() {
    let mut session = awake();
    let proposal = propose_one(&mut session);
    let proposal_id = proposal.proposal_id.clone();

    let admitted = session
        .admit(
            operation(2),
            proposal,
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
    let proposal = propose_one(&mut session);

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
            proposal,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect("in-flight work still reaches its boundary");
}

#[test]
fn settling_never_completes_or_cancels_pending_work() {
    let mut session = awake();
    let _pending = propose_one(&mut session);
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
    let proposal = propose_one(&mut session);
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
            proposal,
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
    let first = propose_one(&mut session);
    let second = propose_one(&mut session);
    assert!(second.sequence > first.sequence);

    let admitted = session
        .admit(
            operation(8),
            second,
            &FixedAuthority(AuthorityDecision::Admit {
                granted_capability: capability("message"),
            }),
        )
        .expect("admitted");
    let admitted_sequence = admitted.envelope().sequence;
    let effect = session
        .dispatch(operation(9), admitted)
        .expect("dispatched");
    assert!(admitted_sequence > first.sequence);
    assert!(effect.sequence > admitted_sequence);
}
