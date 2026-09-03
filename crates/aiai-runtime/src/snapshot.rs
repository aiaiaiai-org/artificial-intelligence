// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::ActivationState;
use aiai_contracts::{
    CapabilityName, ContractVersion, ControllerId, DecimalU64, ModelId, ProposalEnvelope,
    RuntimeId, SessionId, SubjectId,
};
use serde::{Deserialize, Serialize};

/// The durable half of a session, in a form a product can store and load.
///
/// Existence is durable and computation is replaceable, which only means something if the
/// durable half survives the process that held it. A product owns where a session lives
/// between activations; this is the shape it stores.
///
/// # What a snapshot does not carry
///
/// An [`Admitted`](crate::Admitted) value in flight is absent, and deliberately so.
/// Admission is permission to attempt, granted to a caller that then holds it; it is not
/// session state. A restart is not evidence that the attempt happened or that it did not,
/// so the product seeks the decision again rather than resuming a permission whose outcome
/// nobody observed.
///
/// The ports are absent too. A clock, an identifier source, computation, and an authority
/// are supplied per call and are not part of what a session is.
///
/// # What restoring can and cannot check
///
/// [`RuntimeSession::restore`](crate::RuntimeSession::restore) refuses a snapshot whose
/// contract line this build does not implement, one carrying the same proposal identifier
/// twice, and one whose sequence counter sits below a proposal it already emitted — each
/// of which would produce a session that contradicts itself.
///
/// It cannot tell whether the bytes it was handed are the ones this session wrote. Storage
/// is the product's trust boundary: a product that can rewrite its own snapshots can seat a
/// session with pending proposals of its choosing, exactly as it could by calling
/// [`propose`](crate::RuntimeSession::propose) with computation of its choosing. What
/// neither route reaches is the authority boundary — a restored proposal still becomes an
/// action only through an [`Authority`](crate::Authority) decision inside the restored
/// scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSnapshot<P> {
    pub contract_version: ContractVersion,
    pub session_id: SessionId,
    pub subject_id: SubjectId,
    pub controller_id: ControllerId,
    pub runtime_id: RuntimeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<ModelId>,
    /// The capabilities the session's delegation scope grants, in canonical order.
    pub delegated_capabilities: Vec<CapabilityName>,
    pub activation: ActivationState,
    /// The last emission sequence this session issued.
    pub sequence: DecimalU64,
    /// The session revision at the moment the snapshot was taken.
    pub revision: DecimalU64,
    /// Proposals still awaiting an authority decision, in canonical identifier order.
    pub pending: Vec<ProposalEnvelope<P>>,
}
