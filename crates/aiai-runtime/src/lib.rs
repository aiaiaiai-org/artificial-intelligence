// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! Deterministic replaceable-runtime kernel for the aiaiaiai AI foundation.
//!
//! The kernel exists to keep three separations true no matter what a model produces:
//!
//! ```text
//! subject   != controller != runtime != model != session
//! proposal  != admission  != dispatch != completion
//! capability != authority
//! ```
//!
//! [`SubjectBinding`] holds the first: computation is replaceable, the subject is not.
//! [`RuntimeSession`] holds the second and third: a proposal becomes an [`Admitted`]
//! value only through an [`Authority`] decision that falls inside the session's
//! [`DelegationScope`], and only an [`Admitted`] value can become an effect request.
//!
//! The kernel reads no wall clock, no ambient randomness, and no ambient configuration:
//! time, entropy, identifiers, computation, and authority all arrive through the explicit
//! ports in [`ports`]. When a port is unavailable the outcome is a typed failure — never a
//! substituted value and never an invented success.
//!
//! [`SessionSnapshot`] carries the durable half of a session across the process that
//! served it, because a subject that only exists while one process is running is not a
//! durable subject. Ports and an admission in flight are deliberately absent from it.
//!
//! Nothing here knows what a product's participants, relationships, interactions, or
//! records are. Those belong to the product contract that consumes this crate.

/// The contract crate this kernel is built on, re-exported so that a product needs one
/// dependency rather than two pinned to the same revision.
///
/// Envelope, identifier, capability, and failure types all live here. A consumer reaches
/// them as `aiai_runtime::contracts::OperationId`, or through [`prelude`].
pub use aiai_contracts as contracts;

pub mod activation;
pub mod admission;
pub mod continuity;
pub mod ports;
pub mod scope;
pub mod session;
pub mod snapshot;

pub use activation::{ActivationState, ActivationTransition, InvalidTransition};
pub use admission::Admitted;
pub use continuity::{ContinuityChange, ContinuityRelation, SubjectBinding};
pub use ports::{
    Authority, AuthorityDecision, Candidate, Clock, Entropy, IdentifierGeneration, Inference,
    PortError, PortKind,
};
pub use scope::{DelegationScope, ScopeExpansion};
pub use session::RuntimeSession;
pub use snapshot::SessionSnapshot;

/// Everything a product runtime needs in order to drive one session.
///
/// ```
/// use aiai_runtime::prelude::*;
/// ```
///
/// The prelude carries the kernel's own types plus the contract types that appear in its
/// signatures. It deliberately does not re-export the canonical-JSON helpers or the signal
/// vocabulary: a product runtime composing sessions does not need them, and a product that
/// does need them should say so explicitly.
pub mod prelude {
    pub use crate::{
        ActivationState, ActivationTransition, Admitted, Authority, AuthorityDecision, Candidate,
        Clock, ContinuityChange, ContinuityRelation, DelegationScope, Entropy,
        IdentifierGeneration, Inference, InvalidTransition, PortError, PortKind, RuntimeSession,
        ScopeExpansion, SessionSnapshot, SubjectBinding,
    };
    pub use aiai_contracts::{
        AdmissionEnvelope, CapabilityName, ContextPort, ContractVersion, ControllerId, DecimalU64,
        EffectRequestEnvelope, ErrorCode, FoundationError, ModelId, OperationId, ProposalEnvelope,
        ProposalId, RuntimeId, SessionId, SubjectId, WakeEnvelope,
    };
}
