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
//! Nothing here knows what a product's participants, relationships, interactions, or
//! records are. Those belong to the product contract that consumes this crate.

pub mod activation;
pub mod admission;
pub mod continuity;
pub mod ports;
pub mod scope;
pub mod session;

pub use activation::{ActivationState, ActivationTransition, InvalidTransition};
pub use admission::Admitted;
pub use continuity::{ContinuityChange, ContinuityRelation, SubjectBinding};
pub use ports::{
    Authority, AuthorityDecision, Candidate, Clock, Entropy, IdentifierGeneration, Inference,
    PortError, PortKind,
};
pub use scope::{DelegationScope, ScopeExpansion};
pub use session::RuntimeSession;
