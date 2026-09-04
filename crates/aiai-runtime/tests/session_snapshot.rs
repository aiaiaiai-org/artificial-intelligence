// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! A subject outlives the process that served it.
//!
//! These checks cover the durable half of a session: what a snapshot carries, what it
//! refuses to seat, and what it deliberately leaves behind.

use aiai_runtime::prelude::*;
use serde::{Deserialize, Serialize};

/// The product-defined proposal payload. The foundation never inspects it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Utterance(String);

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

struct TwoUtterances;

impl Inference for TwoUtterances {
    type Request = ();
    type Proposal = Utterance;

    fn propose(&mut self, (): &()) -> Result<Vec<Candidate<Utterance>>, PortError> {
        Ok(vec![
            Candidate {
                requested_capability: capability("message"),
                proposal: Utterance("first".to_owned()),
            },
            Candidate {
                requested_capability: capability("message"),
                proposal: Utterance("second".to_owned()),
            },
        ])
    }
}

struct Admitting;

impl Authority for Admitting {
    type Proposal = Utterance;

    fn decide(&self, _: &ProposalEnvelope<Utterance>) -> Result<AuthorityDecision, PortError> {
        Ok(AuthorityDecision::Admit {
            granted_capability: capability("message"),
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

fn session() -> RuntimeSession<Utterance> {
    RuntimeSession::new(
        format!("ses_{}", "e".repeat(32))
            .parse::<SessionId>()
            .expect("canonical session id"),
        SubjectBinding::new(
            format!("sub_{}", "a".repeat(64))
                .parse::<SubjectId>()
                .expect("canonical subject id"),
            format!("ctl_{}", "b".repeat(32))
                .parse::<ControllerId>()
                .expect("canonical controller id"),
            format!("rt_{}", "c".repeat(32))
                .parse::<RuntimeId>()
                .expect("canonical runtime id"),
            Some(
                format!("mdl_{}", "d".repeat(32))
                    .parse::<ModelId>()
                    .expect("canonical model id"),
            ),
        ),
        DelegationScope::new([capability("message")]),
    )
}

/// An active session holding two undecided proposals.
fn mid_turn() -> RuntimeSession<Utterance> {
    let mut session = session();
    session
        .ensure_activation(None, ActivationState::Active)
        .expect("a dormant session wakes");
    session
        .propose(
            operation(1),
            &(),
            &mut TwoUtterances,
            &mut CountingIdentifiers::default(),
        )
        .expect("an active session proposes");
    session
}

#[test]
fn a_session_round_trips_through_its_snapshot() {
    let before = mid_turn();
    let snapshot = before.snapshot();

    let after = RuntimeSession::restore(snapshot).expect("its own snapshot seats a session");

    assert_eq!(after.session_id(), before.session_id());
    assert_eq!(after.binding(), before.binding());
    assert_eq!(after.scope(), before.scope());
    assert_eq!(after.activation(), before.activation());
    assert_eq!(after.sequence(), before.sequence());
    assert_eq!(after.revision(), before.revision());
    assert_eq!(after.pending_proposals(), before.pending_proposals());

    for proposal_id in before.pending_proposal_ids() {
        assert_eq!(
            after.pending_proposal(proposal_id),
            before.pending_proposal(proposal_id),
            "a restored proposal is the one the session produced, field for field"
        );
    }
}

#[test]
fn a_snapshot_survives_the_wire() {
    let before = mid_turn();
    let encoded = serde_json::to_string(&before.snapshot()).expect("a snapshot serializes");
    let decoded: SessionSnapshot<Utterance> =
        serde_json::from_str(&encoded).expect("and comes back");

    let after = RuntimeSession::restore(decoded).expect("a stored snapshot seats a session");
    assert_eq!(after.pending_proposals(), 2);
    assert_eq!(after.revision(), before.revision());
}

#[test]
fn a_restored_session_decides_the_proposals_it_was_seated_with() {
    let before = mid_turn();
    let first = before
        .pending_proposal_ids()
        .next()
        .expect("two are pending")
        .clone();
    let original = before.pending_proposal(&first).expect("owned").clone();

    let mut after = RuntimeSession::restore(before.into_snapshot()).expect("seated");
    let admitted = after
        .admit(operation(2), &first, &Admitting)
        .expect("a restored proposal still reaches the authority boundary");

    assert_eq!(admitted.envelope().proposal_id, original.proposal_id);
    assert_eq!(admitted.envelope().action, original.proposal);
    assert_eq!(after.pending_proposals(), 1);
}

#[test]
fn an_admission_in_flight_is_not_carried_across_a_snapshot() {
    let mut session = mid_turn();
    let first = session
        .pending_proposal_ids()
        .next()
        .expect("two are pending")
        .clone();
    let _admitted = session
        .admit(operation(2), &first, &Admitting)
        .expect("admitted");

    // The admission is a value the caller holds, not session state. A snapshot taken now
    // carries no trace of it, and the proposal it consumed is gone from pending.
    let mut after = RuntimeSession::restore(session.into_snapshot()).expect("seated");
    assert_eq!(after.pending_proposals(), 1);

    let error = after
        .admit(operation(3), &first, &Admitting)
        .expect_err("a decided proposal is not resurrected by a restart");
    assert_eq!(error.code(), ErrorCode::UnknownProposal);
}

#[test]
fn a_restored_session_keeps_the_state_it_was_stored_in() {
    let mut session = mid_turn();
    session
        .ensure_activation(None, ActivationState::Quiescing)
        .expect("an active session quiesces");

    let mut after = RuntimeSession::restore(session.into_snapshot()).expect("seated");
    assert_eq!(after.activation(), ActivationState::Quiescing);

    let error = after
        .propose(
            operation(3),
            &(),
            &mut TwoUtterances,
            &mut CountingIdentifiers::default(),
        )
        .expect_err("a restart does not reset a runtime that was winding down");
    assert_eq!(error.code(), ErrorCode::RuntimeInactive);
}

#[test]
fn a_snapshot_from_another_contract_line_is_refused() {
    let mut snapshot = mid_turn().into_snapshot();
    snapshot.contract_version = "0.3.0".parse().expect("canonical contract version");

    let error = RuntimeSession::restore(snapshot).expect_err("another line is not seated");
    assert_eq!(error.code(), ErrorCode::UnsupportedContractVersion);
}

#[test]
fn a_snapshot_repeating_a_proposal_identifier_is_refused() {
    let mut snapshot = mid_turn().into_snapshot();
    snapshot.pending[1].proposal_id = snapshot.pending[0].proposal_id.clone();

    let error = RuntimeSession::restore(snapshot).expect_err("one identifier, one proposal");
    assert_eq!(error.code(), ErrorCode::DuplicateProposalId);
}

#[test]
fn a_snapshot_whose_counter_precedes_its_own_proposal_is_refused() {
    let mut snapshot = mid_turn().into_snapshot();
    // Seating this would let the session re-issue a sequence it already emitted.
    snapshot.sequence = DecimalU64::new(0);

    let error = RuntimeSession::restore(snapshot).expect_err("a contradictory counter is refused");
    assert_eq!(error.code(), ErrorCode::MalformedEnvelope);
}

#[test]
fn a_stored_session_may_be_served_by_a_different_runtime() {
    let session = mid_turn();
    let subject_before = session.binding().subject_id().clone();

    let mut after = RuntimeSession::restore(session.into_snapshot()).expect("seated");
    let relation = after
        .rebind(
            None,
            SubjectBinding::new(
                subject_before.clone(),
                format!("ctl_{}", "f".repeat(32))
                    .parse::<ControllerId>()
                    .expect("controller"),
                format!("rt_{}", "f".repeat(32))
                    .parse::<RuntimeId>()
                    .expect("runtime"),
                None,
            ),
        )
        .expect("a restored session is still replaceable computation");

    assert!(matches!(relation, ContinuityRelation::Continuous(_)));
    assert_eq!(after.binding().subject_id(), &subject_before);
    assert_eq!(after.pending_proposals(), 2, "its work survived both moves");
}
