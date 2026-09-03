// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{SignalValue, Token};
use aiai_contracts::ContractVersion;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Raw local activity observed before anything durable is written.
///
/// This is the only input the transform accepts, and the transform is the only way to
/// produce a [`TrainingSignal`]. The separation the boundary needs is structural rather
/// than procedural: this crate has no participant, relationship, interaction, or record
/// type, and does not depend on the crate that has sessions and admissions, so there is
/// nothing here for relationship evidence to be derived from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalObservation {
    archetype: Token,
    fields: BTreeMap<Token, SignalValue>,
}

impl LocalObservation {
    /// Records one local activity observation.
    #[must_use]
    pub fn new(archetype: Token, fields: BTreeMap<Token, SignalValue>) -> Self {
        Self { archetype, fields }
    }

    /// Returns the observed action archetype.
    #[must_use]
    pub const fn archetype(&self) -> &Token {
        &self.archetype
    }

    /// Returns the observed fields in canonical order.
    #[must_use]
    pub const fn fields(&self) -> &BTreeMap<Token, SignalValue> {
        &self.fields
    }
}

/// A lossy, schema-conformant behavioral abstraction.
///
/// A signal describes a reusable behavior. It does not name who performed it, who was
/// nearby, which interaction it belonged to, or which relationship it might imply.
///
/// Holding a well-formed signal is not authorization to collect, retain, or export one.
/// This crate deliberately contains no exporter, uploader, or transport: the consent,
/// retention, schema-governance, and cross-request privacy contracts that a collection
/// path requires do not exist yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrainingSignal {
    pub schema_version: ContractVersion,
    pub archetype: Token,
    pub fields: BTreeMap<Token, SignalValue>,
}
