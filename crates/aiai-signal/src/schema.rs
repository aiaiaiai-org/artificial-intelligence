// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{FieldDomain, Token};
use aiai_contracts::{ContractVersion, SchemaViolation};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A constraint that spans more than one field of an archetype.
///
/// Field-level bounds are not sufficient on their own: a set of individually coarse
/// fields can still resolve to one behavior when read together. These rules are how a
/// schema author writes that joint limit down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldCombination {
    /// At most one of the two fields may be present in a payload.
    MutuallyExclusive { left: Token, right: Token },
    /// If `present` appears, `requires` must appear too.
    RequiredWith { present: Token, requires: Token },
}

/// One admitted action archetype and the exact payload it may carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchetypeSchema {
    pub archetype: Token,
    pub schema_version: ContractVersion,
    pub required_fields: BTreeMap<Token, FieldDomain>,
    pub optional_fields: BTreeMap<Token, FieldDomain>,
    pub combinations: Vec<FieldCombination>,
}

impl ArchetypeSchema {
    /// Declares an archetype with only required fields.
    #[must_use]
    pub fn new(
        archetype: Token,
        schema_version: ContractVersion,
        required_fields: BTreeMap<Token, FieldDomain>,
    ) -> Self {
        Self {
            archetype,
            schema_version,
            required_fields,
            optional_fields: BTreeMap::new(),
            combinations: Vec::new(),
        }
    }

    /// Adds optional fields to this archetype.
    #[must_use]
    pub fn with_optional_fields(mut self, fields: BTreeMap<Token, FieldDomain>) -> Self {
        self.optional_fields = fields;
        self
    }

    /// Adds cross-field rules to this archetype.
    #[must_use]
    pub fn with_combinations(mut self, combinations: Vec<FieldCombination>) -> Self {
        self.combinations = combinations;
        self
    }

    /// Returns the domain declared for `field`, if the archetype declares one.
    #[must_use]
    pub fn domain(&self, field: &Token) -> Option<&FieldDomain> {
        self.required_fields
            .get(field)
            .or_else(|| self.optional_fields.get(field))
    }

    /// Checks the cross-field rules against the fields present in a payload.
    ///
    /// # Errors
    ///
    /// Returns [`SchemaViolation::InvalidFieldCombination`] with the offending field.
    pub fn check_combinations(
        &self,
        present: &dyn Fn(&Token) -> bool,
    ) -> Result<(), (SchemaViolation, Token)> {
        for combination in &self.combinations {
            match combination {
                FieldCombination::MutuallyExclusive { left, right } => {
                    if present(left) && present(right) {
                        return Err((SchemaViolation::InvalidFieldCombination, right.clone()));
                    }
                }
                FieldCombination::RequiredWith {
                    present: field,
                    requires,
                } => {
                    if present(field) && !present(requires) {
                        return Err((SchemaViolation::InvalidFieldCombination, requires.clone()));
                    }
                }
            }
        }
        Ok(())
    }
}

/// The public allowlist of admitted action archetypes.
///
/// The foundation ships this registry empty on purpose. Which behaviors are worth
/// abstracting, and how coarse each field must be, is a product and governance decision;
/// a foundation that shipped archetypes would be making it on the product's behalf.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SchemaRegistry {
    archetypes: BTreeMap<Token, ArchetypeSchema>,
}

impl SchemaRegistry {
    /// Returns an empty registry, which admits nothing.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers an archetype, replacing any previous declaration of the same name.
    #[must_use]
    pub fn with_archetype(mut self, schema: ArchetypeSchema) -> Self {
        self.archetypes.insert(schema.archetype.clone(), schema);
        self
    }

    /// Returns the schema for `archetype`, if it is admitted.
    #[must_use]
    pub fn get(&self, archetype: &Token) -> Option<&ArchetypeSchema> {
        self.archetypes.get(archetype)
    }

    /// Returns the admitted archetypes in canonical order.
    pub fn archetypes(&self) -> impl Iterator<Item = &ArchetypeSchema> {
        self.archetypes.values()
    }

    /// Returns whether this registry admits nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.archetypes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::SchemaRegistry;

    #[test]
    fn the_foundation_registry_admits_nothing_by_default() {
        let registry = SchemaRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.archetypes().count(), 0);
    }
}
