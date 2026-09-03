// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! Closed-schema behavioral signal boundary for the aiaiaiai AI foundation.
//!
//! A learning system may benefit from recurring task-level behavior — how a route was
//! traversed, how long a category of place held attention — without any of that becoming a
//! record of who did it with whom. This crate is the shape of that separation:
//!
//! ```text
//! local observation
//!       |
//!       v
//! deterministic transform   (lossy: generalize, quantize, clamp)
//!       |
//!       v
//! schema-conformant signal
//!       |
//!       v
//! independent validation    (repairs nothing; admits or refuses)
//! ```
//!
//! [`SchemaRegistry`] ships empty. Which behaviors deserve an archetype, and how coarse
//! each field must be, is a governance decision the product owns.
//!
//! Two limits are worth stating plainly. First, this crate contains no exporter, uploader,
//! or transport, and holding a valid signal is not authorization to collect or retain one:
//! the consent, retention, provenance, and cross-request privacy contracts a collection
//! path needs do not exist yet. Second, per-payload validation cannot rule out covert
//! encoding across many valid payloads, re-identification against auxiliary data, or model
//! memorization. Those need controls this crate is not the place for.

mod domain;
mod schema;
mod signal;
mod token;
mod transform;
mod validate;

pub use domain::{FieldDomain, SignalValue};
pub use schema::{ArchetypeSchema, FieldCombination, SchemaRegistry};
pub use signal::{LocalObservation, TrainingSignal};
pub use token::{TOKEN_MAX_LEN, Token, TokenError};
pub use transform::{TransformRejection, transform};
pub use validate::validate;
