// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{LocalObservation, SchemaRegistry, Token, TrainingSignal};
use aiai_contracts::SchemaViolation;
use std::collections::BTreeMap;

/// Why an observation could not become a signal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformRejection {
    pub violation: SchemaViolation,
    pub field: Option<Token>,
}

impl TransformRejection {
    const fn archetype(violation: SchemaViolation) -> Self {
        Self {
            violation,
            field: None,
        }
    }

    const fn field(violation: SchemaViolation, field: Token) -> Self {
        Self {
            violation,
            field: Some(field),
        }
    }
}

/// Converts one local observation into a schema-conformant signal.
///
/// The transform is deterministic and lossy by design. It drops fields the archetype does
/// not declare, floors measures onto their declared step, clamps them to their declared
/// bounds, and truncates sequences to their declared length. Applying it twice yields the
/// same signal as applying it once.
///
/// Being open-source and deterministic makes the official client's behavior auditable. It
/// does not make the boundary self-enforcing: a forked or modified client can skip this
/// function entirely, which is why [`validate`](crate::validate) exists as an independent
/// check on whatever actually arrives.
///
/// # Errors
///
/// Returns [`TransformRejection`] when the archetype is not admitted, a required field is
/// absent, a value has the wrong shape, or a token falls outside its declared set.
pub fn transform(
    registry: &SchemaRegistry,
    observation: &LocalObservation,
) -> Result<TrainingSignal, TransformRejection> {
    let Some(schema) = registry.get(observation.archetype()) else {
        return Err(TransformRejection::archetype(
            SchemaViolation::UnknownArchetype,
        ));
    };

    let mut fields: BTreeMap<Token, crate::SignalValue> = BTreeMap::new();

    for (name, domain) in &schema.required_fields {
        let Some(observed) = observation.fields().get(name) else {
            return Err(TransformRejection::field(
                SchemaViolation::MissingField,
                name.clone(),
            ));
        };
        let value = domain
            .generalize(observed)
            .map_err(|violation| TransformRejection::field(violation, name.clone()))?;
        fields.insert(name.clone(), value);
    }

    for (name, domain) in &schema.optional_fields {
        if let Some(observed) = observation.fields().get(name) {
            let value = domain
                .generalize(observed)
                .map_err(|violation| TransformRejection::field(violation, name.clone()))?;
            fields.insert(name.clone(), value);
        }
    }

    schema
        .check_combinations(&|field| fields.contains_key(field))
        .map_err(|(violation, field)| TransformRejection::field(violation, field))?;

    Ok(TrainingSignal {
        schema_version: schema.schema_version,
        archetype: schema.archetype.clone(),
        fields,
    })
}
