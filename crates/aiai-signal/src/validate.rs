// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{SchemaRegistry, TrainingSignal};
use aiai_contracts::{FoundationError, OperationId, SchemaViolation};

/// Validates an incoming signal against the exact schema version it claims.
///
/// This runs independently of the client transform and repairs nothing: a payload is
/// admitted as sent or refused. That gives one structural guarantee — an undeclared field
/// or an out-of-domain carrier cannot enter the corpus merely because a client sent it —
/// and it is worth stating what that guarantee does not cover. A client that stays inside
/// every declared domain can still encode information in the sequence of values it
/// chooses across many payloads. Closing that channel needs limits on request frequency,
/// aggregation, and corpus construction, which are cross-request controls that no
/// per-payload validator can supply.
///
/// # Errors
///
/// Returns [`FoundationError::signal_schema_violation`] naming the closed reason and, when
/// the failure belongs to one field, that field.
pub fn validate(
    registry: &SchemaRegistry,
    signal: &TrainingSignal,
    operation_id: Option<OperationId>,
) -> Result<(), FoundationError> {
    let Some(schema) = registry.get(&signal.archetype) else {
        return Err(FoundationError::signal_schema_violation(
            operation_id,
            SchemaViolation::UnknownArchetype,
            None,
        ));
    };

    if schema.schema_version != signal.schema_version {
        return Err(FoundationError::signal_schema_violation(
            operation_id,
            SchemaViolation::SchemaVersionMismatch,
            None,
        ));
    }

    for name in schema.required_fields.keys() {
        if !signal.fields.contains_key(name) {
            return Err(FoundationError::signal_schema_violation(
                operation_id,
                SchemaViolation::MissingField,
                Some(name.to_string()),
            ));
        }
    }

    for (name, value) in &signal.fields {
        let Some(domain) = schema.domain(name) else {
            return Err(FoundationError::signal_schema_violation(
                operation_id,
                SchemaViolation::UnknownField,
                Some(name.to_string()),
            ));
        };
        domain.check(value).map_err(|violation| {
            FoundationError::signal_schema_violation(
                operation_id.clone(),
                violation,
                Some(name.to_string()),
            )
        })?;
    }

    schema
        .check_combinations(&|field| signal.fields.contains_key(field))
        .map_err(|(violation, field)| {
            FoundationError::signal_schema_violation(
                operation_id,
                violation,
                Some(field.to_string()),
            )
        })
}
