// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::Token;
use aiai_contracts::{DecimalU64, SchemaViolation};
use core::num::NonZeroU64;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// A value carried by one field of a signal payload.
///
/// The shape is closed: a token from a declared set, a quantized measure, or a bounded
/// sequence of those. There is no string, byte array, or open metadata map, so a payload
/// cannot carry a value the schema did not anticipate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalValue {
    Token(Token),
    Measure(DecimalU64),
    Sequence(Vec<SignalValue>),
}

/// The bounded set of values one field may carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldDomain {
    /// A closed set of declared tokens.
    Enumeration { allowed: BTreeSet<Token> },
    /// A bounded, quantized measure. `min` and `max` are inclusive and on-step.
    Quantized {
        min: DecimalU64,
        max: DecimalU64,
        step: NonZeroU64,
    },
    /// A bounded-length sequence of one inner domain.
    Sequence {
        item: Box<FieldDomain>,
        max_len: DecimalU64,
    },
}

impl FieldDomain {
    /// Builds an enumeration domain.
    #[must_use]
    pub fn enumeration(allowed: impl IntoIterator<Item = Token>) -> Self {
        Self::Enumeration {
            allowed: allowed.into_iter().collect(),
        }
    }

    /// Builds a quantized measure domain.
    #[must_use]
    pub const fn quantized(min: u64, max: u64, step: NonZeroU64) -> Self {
        Self::Quantized {
            min: DecimalU64::new(min),
            max: DecimalU64::new(max),
            step,
        }
    }

    /// Builds a bounded sequence domain.
    #[must_use]
    pub fn sequence(item: Self, max_len: u64) -> Self {
        Self::Sequence {
            item: Box::new(item),
            max_len: DecimalU64::new(max_len),
        }
    }

    /// Checks a value against this domain without repairing it.
    ///
    /// Validation never rounds, clamps, or truncates. Repair belongs to the client
    /// transform, where it is visible; a validator that repaired a payload would accept
    /// exactly the values the domain exists to exclude.
    ///
    /// # Errors
    ///
    /// Returns the closed [`SchemaViolation`] describing why the value is inadmissible.
    pub fn check(&self, value: &SignalValue) -> Result<(), SchemaViolation> {
        match (self, value) {
            (Self::Enumeration { allowed }, SignalValue::Token(token)) => {
                if allowed.contains(token) {
                    Ok(())
                } else {
                    Err(SchemaViolation::ValueOutOfDomain)
                }
            }
            (Self::Quantized { min, max, step }, SignalValue::Measure(measure)) => {
                let raw = measure.get();
                if raw < min.get() || raw > max.get() {
                    return Err(SchemaViolation::ValueOutOfDomain);
                }
                if (raw - min.get()) % step.get() != 0 {
                    return Err(SchemaViolation::ExcessPrecision);
                }
                Ok(())
            }
            (Self::Sequence { item, max_len }, SignalValue::Sequence(values)) => {
                let length =
                    u64::try_from(values.len()).map_err(|_| SchemaViolation::ExcessCardinality)?;
                if length > max_len.get() {
                    return Err(SchemaViolation::ExcessCardinality);
                }
                values.iter().try_for_each(|value| item.check(value))
            }
            _ => Err(SchemaViolation::NonCanonicalEncoding),
        }
    }

    /// Generalizes a value into this domain, or reports why it cannot be generalized.
    ///
    /// Measures are floored onto the quantization step and clamped to the bounds;
    /// sequences are truncated to the declared length. A token outside the declared set is
    /// not generalizable — inventing a nearest token would fabricate behavior — so the
    /// observation is refused instead.
    ///
    /// # Errors
    ///
    /// Returns the closed [`SchemaViolation`] describing why the value cannot be carried.
    pub fn generalize(&self, value: &SignalValue) -> Result<SignalValue, SchemaViolation> {
        match (self, value) {
            (Self::Enumeration { allowed }, SignalValue::Token(token)) => {
                if allowed.contains(token) {
                    Ok(SignalValue::Token(token.clone()))
                } else {
                    Err(SchemaViolation::ValueOutOfDomain)
                }
            }
            (Self::Quantized { min, max, step }, SignalValue::Measure(measure)) => {
                let clamped = measure.get().clamp(min.get(), max.get());
                let floored = clamped - ((clamped - min.get()) % step.get());
                Ok(SignalValue::Measure(DecimalU64::new(floored)))
            }
            (Self::Sequence { item, max_len }, SignalValue::Sequence(values)) => {
                let limit = usize::try_from(max_len.get()).unwrap_or(usize::MAX);
                values
                    .iter()
                    .take(limit)
                    .map(|value| item.generalize(value))
                    .collect::<Result<Vec<_>, _>>()
                    .map(SignalValue::Sequence)
            }
            _ => Err(SchemaViolation::NonCanonicalEncoding),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{FieldDomain, SignalValue};
    use crate::Token;
    use aiai_contracts::{DecimalU64, SchemaViolation};
    use core::num::NonZeroU64;

    fn token(value: &str) -> Token {
        value.parse().expect("canonical token")
    }

    fn step(value: u64) -> NonZeroU64 {
        NonZeroU64::new(value).expect("non-zero step")
    }

    #[test]
    fn rejects_a_value_outside_a_closed_enumeration() {
        let domain = FieldDomain::enumeration([token("transit"), token("walk")]);
        assert_eq!(
            domain.check(&SignalValue::Token(token("courier_route_7"))),
            Err(SchemaViolation::ValueOutOfDomain)
        );
    }

    #[test]
    fn rejects_precision_finer_than_the_declared_step() {
        let domain = FieldDomain::quantized(0, 600, step(60));
        assert_eq!(
            domain.check(&SignalValue::Measure(DecimalU64::new(137))),
            Err(SchemaViolation::ExcessPrecision)
        );
        assert_eq!(
            domain.check(&SignalValue::Measure(DecimalU64::new(120))),
            Ok(())
        );
    }

    #[test]
    fn rejects_a_sequence_longer_than_its_bound() {
        let domain = FieldDomain::sequence(FieldDomain::quantized(0, 10, step(1)), 2);
        let values = SignalValue::Sequence(vec![
            SignalValue::Measure(DecimalU64::new(1)),
            SignalValue::Measure(DecimalU64::new(2)),
            SignalValue::Measure(DecimalU64::new(3)),
        ]);
        assert_eq!(
            domain.check(&values),
            Err(SchemaViolation::ExcessCardinality)
        );
    }

    #[test]
    fn rejects_a_value_of_the_wrong_shape() {
        let domain = FieldDomain::quantized(0, 10, step(1));
        assert_eq!(
            domain.check(&SignalValue::Token(token("ten"))),
            Err(SchemaViolation::NonCanonicalEncoding)
        );
    }

    #[test]
    fn generalizing_floors_and_clamps_a_measure() {
        let domain = FieldDomain::quantized(0, 600, step(60));
        assert_eq!(
            domain.generalize(&SignalValue::Measure(DecimalU64::new(137))),
            Ok(SignalValue::Measure(DecimalU64::new(120)))
        );
        assert_eq!(
            domain.generalize(&SignalValue::Measure(DecimalU64::new(99_999))),
            Ok(SignalValue::Measure(DecimalU64::new(600)))
        );
    }

    #[test]
    fn generalizing_truncates_a_sequence_to_its_bound() {
        let domain = FieldDomain::sequence(FieldDomain::quantized(0, 10, step(1)), 2);
        let generalized = domain
            .generalize(&SignalValue::Sequence(vec![
                SignalValue::Measure(DecimalU64::new(1)),
                SignalValue::Measure(DecimalU64::new(2)),
                SignalValue::Measure(DecimalU64::new(3)),
            ]))
            .expect("sequences truncate");
        assert_eq!(domain.check(&generalized), Ok(()));
    }

    #[test]
    fn refuses_to_invent_a_token_it_cannot_generalize() {
        let domain = FieldDomain::enumeration([token("walk")]);
        assert_eq!(
            domain.generalize(&SignalValue::Token(token("sprint"))),
            Err(SchemaViolation::ValueOutOfDomain)
        );
    }
}
