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

/// Closed turn result: exactly one `ok` or `error` member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TurnOutcome<P, F> {
    Ok { ok: TurnOk<P, F> },
    Error { error: FoundationError },
}
