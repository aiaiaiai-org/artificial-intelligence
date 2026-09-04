// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! The shape a product runtime binds when it consumes this crate as a library.
//!
//! Everything here is reached through `aiai_runtime::prelude`, so a product needs one
//! dependency rather than one for the kernel and one for the contracts pinned to the same
//! revision. The product vocabulary in this file — a control-mode enumeration, an opaque
//! world target, a closed proposal payload — is deliberately generic: the foundation must
//! be able to carry a product's meaning without learning any of it.

use aiai_runtime::prelude::*;

/// A world target the product resolved. The foundation never mints or reads one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct TargetId(String);

/// The product's closed proposal payload.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
enum ProductProposal {
    Reply { text: String },
    MoveTo { target: TargetId },
}

/// The product's closed wake-reason enumeration.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WakeReason {
    CounterpartArrived,
}

/// A product mode enumeration, one mode per activation state.
///
/// A mode names a state, not an edge, which is why the product resolves it through
/// [`RuntimeSession::ensure_activation`] rather than by picking a transition itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlMode {
    /// The runtime may compute on the subject's behalf.
    Attending,
    /// The owner took over; in-flight work may finish, nothing new starts.
    HandingBack,
    /// No computation at all.
    Off,
}

impl ControlMode {
    const fn activation_state(self) -> ActivationState {
        match self {
            Self::Attending => ActivationState::Active,
            Self::HandingBack => ActivationState::Quiescing,
            Self::Off => ActivationState::Dormant,
        }
    }
}

struct StubClock;

impl Clock for StubClock {
    fn now_unix_ms(&self) -> Result<DecimalU64, PortError> {
        Ok(DecimalU64::new(1_700_000_000_000))
    }
}

#[derive(Default)]
struct SequentialIdentifiers(u8);

impl IdentifierGeneration for SequentialIdentifiers {
    fn next_proposal_id(&mut self) -> Result<ProposalId, PortError> {
        self.0 += 1;
        format!("prp_{:032x}", self.0)
            .parse()
            .map_err(|_| PortError {
                port: PortKind::IdentifierGeneration,
            })
    }
}

/// Stands in for whatever computation the product chose — local, remote, large, small.
struct ProductInference;

impl Inference for ProductInference {
    type Request = String;
    type Proposal = ProductProposal;

    fn propose(&mut self, request: &String) -> Result<Vec<Candidate<ProductProposal>>, PortError> {
        Ok(vec![
            Candidate {
                requested_capability: "message".parse().expect("canonical capability"),
                proposal: ProductProposal::Reply {
                    text: format!("about {request}"),
                },
            },
            Candidate {
                requested_capability: "navigate".parse().expect("canonical capability"),
                proposal: ProductProposal::MoveTo {
                    target: TargetId("target-42".to_owned()),
                },
            },
        ])
    }
}

/// The product's authority boundary. Only this decides whether an action may be attempted.
struct OwnerAuthority;

impl Authority for OwnerAuthority {
    type Proposal = ProductProposal;

    fn decide(
        &self,
        proposal: &ProposalEnvelope<ProductProposal>,
    ) -> Result<AuthorityDecision, PortError> {
        match &proposal.proposal {
            ProductProposal::Reply { .. } => Ok(AuthorityDecision::Admit {
                granted_capability: proposal.requested_capability.clone(),
            }),
            ProductProposal::MoveTo { .. } => Ok(AuthorityDecision::Withhold),
        }
    }
}

fn product_session() -> RuntimeSession<ProductProposal> {
    RuntimeSession::new(
        format!("ses_{}", "a".repeat(32))
            .parse::<SessionId>()
            .expect("canonical session id"),
        SubjectBinding::new(
            format!("sub_{}", "b".repeat(64))
                .parse::<SubjectId>()
                .expect("canonical subject id"),
            format!("ctl_{}", "c".repeat(32))
                .parse::<ControllerId>()
                .expect("canonical controller id"),
            format!("rt_{}", "d".repeat(32))
                .parse::<RuntimeId>()
                .expect("canonical runtime id"),
            Some(
                format!("mdl_{}", "e".repeat(32))
                    .parse::<ModelId>()
                    .expect("canonical model id"),
            ),
        ),
        DelegationScope::new(["message".parse().expect("canonical capability")]),
    )
}

#[test]
fn a_product_drives_one_whole_turn_through_the_prelude_alone() {
    let mut session = product_session();

    // Entering a mode is state-targeted, so it is safe to apply the product's current mode
    // on every render without tracking which edge that implies.
    session
        .ensure_activation(None, ControlMode::Attending.activation_state())
        .expect("attending is reachable from a dormant session");
    session
        .ensure_activation(None, ControlMode::Attending.activation_state())
        .expect("re-applying the current mode is a no-op");

    let wake = session
        .wake(
            "op_00000000000000000000000000000001"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            WakeReason::CounterpartArrived,
            &StubClock,
        )
        .expect("an attending session records its wake");
    assert_eq!(wake.reason, WakeReason::CounterpartArrived);
    assert_eq!(wake.contract_version, ContractVersion::CURRENT);

    let proposal_ids = session
        .propose(
            "op_00000000000000000000000000000002"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &"the counterpart".to_owned(),
            &mut ProductInference,
            &mut SequentialIdentifiers::default(),
        )
        .expect("an attending session proposes");
    assert_eq!(proposal_ids.len(), 2);

    // The product renders what the session owns. It never rebuilds a proposal to submit.
    let rendered: Vec<&ProductProposal> = proposal_ids
        .iter()
        .map(|proposal_id| {
            &session
                .pending_proposal(proposal_id)
                .expect("the session owns every proposal it produced")
                .proposal
        })
        .collect();
    assert!(matches!(rendered[0], ProductProposal::Reply { .. }));

    // The owner withholds the movement proposal; it never becomes an effect.
    let withheld = session
        .admit(
            "op_00000000000000000000000000000003"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &proposal_ids[1],
            &OwnerAuthority,
        )
        .expect_err("a withheld proposal is not admitted");
    assert_eq!(withheld.code(), ErrorCode::AuthorityWithheld);

    let admitted = session
        .admit(
            "op_00000000000000000000000000000004"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &proposal_ids[0],
            &OwnerAuthority,
        )
        .expect("an in-scope grant is admitted");

    let effect = session
        .dispatch(
            "op_00000000000000000000000000000005"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            admitted,
        )
        .expect("an admitted action dispatches");
    assert_eq!(
        effect.effect,
        ProductProposal::Reply {
            text: "about the counterpart".to_owned(),
        }
    );
    assert_eq!(session.pending_proposals(), 0);
}

#[test]
fn handing_control_back_stops_new_work_without_discarding_started_work() {
    let mut session = product_session();
    session
        .ensure_activation(None, ControlMode::Attending.activation_state())
        .expect("attending");
    let proposal_ids = session
        .propose(
            "op_00000000000000000000000000000001"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &"the counterpart".to_owned(),
            &mut ProductInference,
            &mut SequentialIdentifiers::default(),
        )
        .expect("proposed");

    session
        .ensure_activation(None, ControlMode::HandingBack.activation_state())
        .expect("handing back");

    let refused = session
        .propose(
            "op_00000000000000000000000000000002"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &"again".to_owned(),
            &mut ProductInference,
            &mut SequentialIdentifiers::default(),
        )
        .expect_err("nothing new starts while handing back");
    assert_eq!(refused.code(), ErrorCode::RuntimeInactive);

    session
        .admit(
            "op_00000000000000000000000000000003"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &proposal_ids[0],
            &OwnerAuthority,
        )
        .expect("work already started still reaches its boundary");

    // Returning to attending requires the product to say that in-flight work settled.
    // The session will not assert that on the owner's behalf.
    let error = session
        .ensure_activation(None, ControlMode::Attending.activation_state())
        .expect_err("attending is not reachable directly from handing back");
    assert_eq!(error.code(), ErrorCode::RuntimeInactive);

    session
        .ensure_activation(None, ControlMode::Off.activation_state())
        .expect("the product settles explicitly");
    session
        .ensure_activation(None, ControlMode::Attending.activation_state())
        .expect("and then attends again");
    assert_eq!(session.activation(), ActivationState::Active);
}

/// The product's closed effect payload, for the turn a host receives.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
enum ProductEffect {
    SendReply { text: String },
}

#[test]
fn a_turn_is_reported_from_session_state_rather_than_assembled_by_hand() {
    let mut session = product_session();
    session
        .ensure_activation(None, ControlMode::Attending.activation_state())
        .expect("attending");
    let proposal_ids = session
        .propose(
            "op_00000000000000000000000000000001"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &"the counterpart".to_owned(),
            &mut ProductInference,
            &mut SequentialIdentifiers::default(),
        )
        .expect("proposed");

    let admitted = session
        .admit(
            "op_00000000000000000000000000000002"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &proposal_ids[0],
            &OwnerAuthority,
        )
        .expect("admitted");
    let dispatched = session
        .dispatch(
            "op_00000000000000000000000000000003"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            admitted,
        )
        .expect("dispatched");
    let effect_request = EffectRequestEnvelope {
        contract_version: dispatched.contract_version,
        operation_id: dispatched.operation_id,
        sequence: dispatched.sequence,
        effect: match dispatched.effect {
            ProductProposal::Reply { text } => ProductEffect::SendReply { text },
            ProductProposal::MoveTo { .. } => unreachable!("the reply was admitted"),
        },
    };

    let turn_operation = "op_00000000000000000000000000000004"
        .parse::<OperationId>()
        .expect("canonical operation id");
    let turn = session
        .turn_ok(
            turn_operation.clone(),
            &proposal_ids[1..],
            vec![effect_request],
        )
        .expect("the session reports its own turn");

    // The revision comes from the session, not from the caller's bookkeeping.
    assert_eq!(turn.session_revision, session.revision());
    assert_eq!(turn.contract_version, ContractVersion::CURRENT);
    assert_eq!(turn.operation_id, turn_operation);
    assert_eq!(
        turn.proposals.len(),
        1,
        "one proposal still awaits a decision"
    );
    assert_eq!(turn.proposals[0].proposal_id, proposal_ids[1]);
    assert_eq!(turn.effect_requests.len(), 1);

    let outcome: TurnOutcome<ProductProposal, ProductEffect> = Ok(turn).into();
    let encoded = serde_json::to_string(&outcome).expect("a turn crosses a process boundary");
    assert!(encoded.contains("\"session_revision\""));
}

#[test]
fn reporting_a_proposal_the_session_no_longer_holds_is_refused() {
    let mut session = product_session();
    session
        .ensure_activation(None, ControlMode::Attending.activation_state())
        .expect("attending");
    let proposal_ids = session
        .propose(
            "op_00000000000000000000000000000001"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &"the counterpart".to_owned(),
            &mut ProductInference,
            &mut SequentialIdentifiers::default(),
        )
        .expect("proposed");
    session
        .admit(
            "op_00000000000000000000000000000002"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &proposal_ids[0],
            &OwnerAuthority,
        )
        .expect("admitted");

    let error = session
        .turn_ok::<ProductEffect>(
            "op_00000000000000000000000000000003"
                .parse::<OperationId>()
                .expect("canonical operation id"),
            &proposal_ids,
            Vec::new(),
        )
        .expect_err("a decided proposal is not still awaiting a decision");
    assert_eq!(error.code(), ErrorCode::UnknownProposal);

    // A failed turn is reported, not lost.
    let outcome: TurnOutcome<ProductProposal, ProductEffect> = Err(error).into();
    assert!(matches!(outcome, TurnOutcome::Error { .. }));
}

/// Computation that cannot answer, so a real `FoundationError` reaches the product.
struct UnreachableInference;

impl Inference for UnreachableInference {
    type Request = String;
    type Proposal = ProductProposal;

    fn propose(&mut self, _request: &String) -> Result<Vec<Candidate<ProductProposal>>, PortError> {
        Err(PortError::new(PortKind::Inference))
    }
}

#[test]
fn a_failure_reaches_a_durable_record_and_a_person_from_one_value() {
    let mut session = product_session();
    let operation = format!("op_{}", "1".repeat(32))
        .parse::<OperationId>()
        .expect("canonical operation id");
    session
        .ensure_activation(Some(operation.clone()), ActivationState::Active)
        .expect("waking is defined from dormant");

    let failure = session
        .propose(
            operation,
            &"anything".to_owned(),
            &mut UnreachableInference,
            &mut SequentialIdentifiers(0),
        )
        .expect_err("unreachable computation is a failure, never an empty batch");

    // One value answers both questions a product asks of a failure. Which sink it reaches,
    // and what a person is told, stay the product's decisions — the foundation supplies
    // neither a transport nor a sentence.
    assert_eq!(failure.code(), ErrorCode::InferenceUnavailable);
    assert_eq!(failure.code().kind(), FailureKind::Unavailable);
    assert!(
        failure.code().is_retryable(),
        "an unreachable port may answer on a later attempt"
    );

    let record = FailureRecord::new(
        StubClock.now_unix_ms().expect("the product's clock"),
        Some(
            format!("ses_{}", "a".repeat(32))
                .parse::<SessionId>()
                .expect("canonical session id"),
        ),
        failure,
    );
    assert_eq!(record.contract_version, ContractVersion::CURRENT);

    // The record is canonical JSON, so the row a product writes is the payload a host
    // decodes — there is no second encoding for a failure to disagree across.
    let encoded = aiai_runtime::contracts::canonical_json(&record).expect("a record is canonical");
    let decoded: FailureRecord =
        serde_json::from_slice(&encoded).expect("a record decodes into itself");
    assert_eq!(decoded, record);
}

#[test]
fn a_failure_the_activation_gate_produced_is_not_retryable() {
    let mut session = product_session();
    let operation = format!("op_{}", "2".repeat(32))
        .parse::<OperationId>()
        .expect("canonical operation id");

    // Dormant: the session refuses before computation runs, so this is not a port problem
    // and repeating the same call unchanged answers the same way.
    let failure = session
        .propose(
            operation,
            &"anything".to_owned(),
            &mut UnreachableInference,
            &mut SequentialIdentifiers(0),
        )
        .expect_err("a dormant runtime initiates nothing");

    assert_eq!(failure.code(), ErrorCode::RuntimeInactive);
    assert_eq!(failure.code().kind(), FailureKind::Gated);
    assert!(!failure.code().is_retryable());
}
