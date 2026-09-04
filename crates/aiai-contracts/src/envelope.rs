// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{
    CapabilityName, ContractVersion, DecimalU64, FoundationError, OperationId, ProposalId,
    SessionId,
};
use serde::{Deserialize, Serialize};

/// Closed envelope carrying the external occurrence that woke a runtime.
///
/// `R` is the product's closed wake-reason enumeration. The foundation schedules and
/// correlates wakes; it never interprets why the product considers one meaningful.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeEnvelope<R> {
    pub contract_version: ContractVersion,
    pub operation_id: OperationId,
    pub session_id: SessionId,
    pub observed_at_unix_ms: DecimalU64,
    pub reason: R,
}

/// Closed envelope carrying one candidate action produced by inference.
///
/// A proposal is the runtime's output, not a decision and not an action. Nothing in this
/// crate converts a `ProposalEnvelope` into an effect; only an authority decision can.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalEnvelope<P> {
    pub contract_version: ContractVersion,
    pub operation_id: OperationId,
    pub proposal_id: ProposalId,
    pub sequence: DecimalU64,
    pub requested_capability: CapabilityName,
    pub proposal: P,
}

/// Closed envelope carrying a proposal that an authority port admitted.
///
/// Admission is permission to attempt, never evidence that the action occurred or that a
/// counterpart accepted it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionEnvelope<A> {
    pub contract_version: ContractVersion,
    pub operation_id: OperationId,
    pub proposal_id: ProposalId,
    pub sequence: DecimalU64,
    pub granted_capability: CapabilityName,
    pub action: A,
}

/// Closed effect-request envelope. Dispatch is not completion evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectRequestEnvelope<F> {
    pub contract_version: ContractVersion,
    pub operation_id: OperationId,
    pub sequence: DecimalU64,
    pub effect: F,
}

/// Successful result of one runtime turn, before the outer `ok` member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnOk<P, F> {
    pub contract_version: ContractVersion,
    pub operation_id: OperationId,
    pub session_revision: DecimalU64,
    pub proposals: Vec<ProposalEnvelope<P>>,
    pub effect_requests: Vec<EffectRequestEnvelope<F>>,
}

/// One failure, in the shape a consumer keeps.
///
/// A failure normally has to go two ways at once: into a durable record, and to whoever is
/// waiting on the operation. This is the first of those — the row. It carries the failure
/// unchanged, the moment it was recorded, and the correlation handles needed to find it
/// again, so that every product's failure table has the same columns and a reader moving
/// between two of them is reading the same thing.
///
/// The timestamp arrives from the caller because the foundation reads no clock: whatever
/// serves the [`Clock`] port supplies it, and a record whose time could not be obtained is
/// the caller's own outcome to handle rather than a substituted value.
///
/// No subject identifier appears here on purpose. `operation_id` inside the failure and
/// `session_id` beside it are enough to correlate a record with the work that produced it,
/// and a durable table keyed by the person a runtime acts for is a different artifact with
/// a different retention contract — one the signal boundary in `aiai-signal` deliberately
/// refuses to ship a transport for.
///
/// [`Clock`]: https://docs.rs/aiai-runtime
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FailureRecord {
    pub contract_version: ContractVersion,
    pub recorded_at_unix_ms: DecimalU64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    pub error: FoundationError,
}

impl FailureRecord {
    /// Builds a record for `error` observed at `recorded_at_unix_ms`.
    ///
    /// The contract version is this build's, never one a caller supplies: a record that
    /// claimed another line would misdescribe the vocabulary its own error code came from.
    #[must_use]
    pub fn new(
        recorded_at_unix_ms: DecimalU64,
        session_id: Option<SessionId>,
        error: FoundationError,
    ) -> Self {
        Self {
            contract_version: ContractVersion::CURRENT,
            recorded_at_unix_ms,
            session_id,
            error,
        }
    }
}

/// Closed turn result: exactly one `ok` or `error` member.
///
/// A runtime works in `Result`, and a turn is reported in this shape. The conversion
/// between them is total, so a failure cannot be dropped on the way out: every `Err`
/// becomes an `error` member carrying the same typed failure, and no code path produces a
/// turn that is neither.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TurnOutcome<P, F> {
    Ok { ok: TurnOk<P, F> },
    Error { error: FoundationError },
}

impl<P, F> From<Result<TurnOk<P, F>, FoundationError>> for TurnOutcome<P, F> {
    fn from(result: Result<TurnOk<P, F>, FoundationError>) -> Self {
        match result {
            Ok(ok) => Self::Ok { ok },
            Err(error) => Self::Error { error },
        }
    }
}
