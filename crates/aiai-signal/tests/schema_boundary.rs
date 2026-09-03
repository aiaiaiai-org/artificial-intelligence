// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! Checks on the two halves of the signal boundary: a transform that generalizes, and a
//! validator that does not.

use aiai_contracts::{ContractVersion, DecimalU64, ErrorCode};
use aiai_signal::{
    ArchetypeSchema, FieldCombination, FieldDomain, LocalObservation, SchemaRegistry, SignalValue,
    Token, TrainingSignal, transform, validate,
};
use core::num::NonZeroU64;
use std::collections::BTreeMap;

fn token(value: &str) -> Token {
    value.parse().expect("canonical token")
}

fn step(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).expect("non-zero step")
}

/// A test-only archetype. The foundation ships none of its own.
fn registry() -> SchemaRegistry {
    let mut required = BTreeMap::new();
    required.insert(
        token("movement_mode"),
        FieldDomain::enumeration([token("walk"), token("transit"), token("cycle")]),
    );
    required.insert(
        token("dwell_seconds"),
        FieldDomain::quantized(0, 600, step(60)),
    );

    let mut optional = BTreeMap::new();
    optional.insert(
        token("cell_sequence"),
        FieldDomain::sequence(FieldDomain::quantized(0, 4095, step(1)), 3),
    );
    optional.insert(
        token("place_category"),
        FieldDomain::enumeration([token("transport"), token("retail")]),
    );

    SchemaRegistry::new().with_archetype(
        ArchetypeSchema::new(token("cell_transit"), ContractVersion::CURRENT, required)
            .with_optional_fields(optional)
            .with_combinations(vec![FieldCombination::MutuallyExclusive {
                left: token("cell_sequence"),
                right: token("place_category"),
            }]),
    )
}

fn observation(fields: Vec<(&str, SignalValue)>) -> LocalObservation {
    LocalObservation::new(
        token("cell_transit"),
        fields
            .into_iter()
            .map(|(name, value)| (token(name), value))
            .collect(),
    )
}

fn measure(value: u64) -> SignalValue {
    SignalValue::Measure(DecimalU64::new(value))
}

fn well_formed() -> LocalObservation {
    observation(vec![
        ("movement_mode", SignalValue::Token(token("transit"))),
        ("dwell_seconds", measure(137)),
    ])
}

#[test]
fn an_empty_registry_admits_nothing() {
    let empty = SchemaRegistry::new();
    let rejection = transform(&empty, &well_formed()).expect_err("nothing is admitted");
    assert_eq!(
        rejection.violation,
        aiai_contracts::SchemaViolation::UnknownArchetype
    );
}

#[test]
fn the_transform_generalizes_before_the_signal_exists() {
    let signal = transform(&registry(), &well_formed()).expect("a declared archetype transforms");
    // 137 seconds of observed dwell leaves the boundary as the 120-second bucket.
    assert_eq!(signal.fields[&token("dwell_seconds")], measure(120));
}

#[test]
fn every_transform_output_validates() {
    let registry = registry();
    let cases = vec![
        well_formed(),
        observation(vec![
            ("movement_mode", SignalValue::Token(token("walk"))),
            ("dwell_seconds", measure(0)),
        ]),
        // Over-long sequences and out-of-range measures are generalized, not refused.
        observation(vec![
            ("movement_mode", SignalValue::Token(token("cycle"))),
            ("dwell_seconds", measure(99_999)),
            (
                "cell_sequence",
                SignalValue::Sequence(vec![
                    measure(1),
                    measure(2),
                    measure(3),
                    measure(4),
                    measure(5),
                ]),
            ),
        ]),
    ];

    for case in cases {
        let signal = transform(&registry, &case).expect("transformable observation");
        validate(&registry, &signal, None).expect("the transform's own output is admissible");
    }
}

#[test]
fn the_transform_is_idempotent() {
    let registry = registry();
    let once = transform(&registry, &well_formed()).expect("first pass");
    let reobserved = LocalObservation::new(once.archetype.clone(), once.fields.clone());
    let twice = transform(&registry, &reobserved).expect("second pass");
    assert_eq!(once, twice);
}

#[test]
fn the_transform_drops_fields_the_archetype_does_not_declare() {
    let registry = registry();
    let signal = transform(
        &registry,
        &observation(vec![
            ("movement_mode", SignalValue::Token(token("walk"))),
            ("dwell_seconds", measure(60)),
            ("device_battery", measure(87)),
        ]),
    )
    .expect("undeclared fields are dropped, not carried");
    assert!(!signal.fields.contains_key(&token("device_battery")));
    validate(&registry, &signal, None).expect("the result is admissible");
}

#[test]
fn the_transform_refuses_a_token_it_cannot_generalize() {
    let rejection = transform(
        &registry(),
        &observation(vec![
            ("movement_mode", SignalValue::Token(token("courier_van_7"))),
            ("dwell_seconds", measure(60)),
        ]),
    )
    .expect_err("an undeclared token is not generalizable");
    assert_eq!(
        rejection.violation,
        aiai_contracts::SchemaViolation::ValueOutOfDomain
    );
    assert_eq!(rejection.field, Some(token("movement_mode")));
}

#[test]
fn the_transform_refuses_an_observation_missing_a_required_field() {
    let rejection = transform(
        &registry(),
        &observation(vec![("movement_mode", SignalValue::Token(token("walk")))]),
    )
    .expect_err("a required field cannot be invented");
    assert_eq!(
        rejection.violation,
        aiai_contracts::SchemaViolation::MissingField
    );
}

#[test]
fn the_transform_enforces_cross_field_rules() {
    let rejection = transform(
        &registry(),
        &observation(vec![
            ("movement_mode", SignalValue::Token(token("walk"))),
            ("dwell_seconds", measure(60)),
            ("cell_sequence", SignalValue::Sequence(vec![measure(1)])),
            ("place_category", SignalValue::Token(token("retail"))),
        ]),
    )
    .expect_err("fields that resolve jointly cannot both appear");
    assert_eq!(
        rejection.violation,
        aiai_contracts::SchemaViolation::InvalidFieldCombination
    );
}

/// A client that skips the transform gets no leniency from the validator.
mod forked_client {
    use super::{ErrorCode, SignalValue, TrainingSignal, measure, registry, token, validate};
    use aiai_contracts::ContractVersion;

    fn payload(fields: Vec<(&str, SignalValue)>) -> TrainingSignal {
        TrainingSignal {
            schema_version: ContractVersion::CURRENT,
            archetype: token("cell_transit"),
            fields: fields
                .into_iter()
                .map(|(name, value)| (token(name), value))
                .collect(),
        }
    }

    fn base() -> Vec<(&'static str, SignalValue)> {
        vec![
            ("movement_mode", SignalValue::Token(token("walk"))),
            ("dwell_seconds", measure(60)),
        ]
    }

    #[test]
    fn excess_precision_is_refused_rather_than_rounded() {
        let mut fields = base();
        fields[1] = ("dwell_seconds", measure(137));
        let error = validate(&registry(), &payload(fields), None)
            .expect_err("the validator does not repair a payload");
        assert_eq!(error.code(), ErrorCode::SignalSchemaViolation);
        assert_eq!(
            error.details().and_then(|d| d.schema_violation),
            Some(aiai_contracts::SchemaViolation::ExcessPrecision)
        );
    }

    #[test]
    fn an_undeclared_field_is_refused_rather_than_dropped() {
        let mut fields = base();
        fields.push(("device_battery", measure(87)));
        let error = validate(&registry(), &payload(fields), None)
            .expect_err("an undeclared carrier is refused");
        assert_eq!(
            error.details().and_then(|d| d.schema_violation),
            Some(aiai_contracts::SchemaViolation::UnknownField)
        );
    }

    #[test]
    fn an_over_long_sequence_is_refused_rather_than_truncated() {
        let mut fields = base();
        fields.push((
            "cell_sequence",
            SignalValue::Sequence(vec![measure(1), measure(2), measure(3), measure(4)]),
        ));
        let error = validate(&registry(), &payload(fields), None)
            .expect_err("excess cardinality is refused");
        assert_eq!(
            error.details().and_then(|d| d.schema_violation),
            Some(aiai_contracts::SchemaViolation::ExcessCardinality)
        );
    }

    #[test]
    fn a_value_of_the_wrong_shape_is_refused() {
        let mut fields = base();
        fields[1] = ("dwell_seconds", SignalValue::Token(token("sixty")));
        let error =
            validate(&registry(), &payload(fields), None).expect_err("shape is part of the domain");
        assert_eq!(
            error.details().and_then(|d| d.schema_violation),
            Some(aiai_contracts::SchemaViolation::NonCanonicalEncoding)
        );
    }

    #[test]
    fn a_payload_claiming_another_schema_version_is_refused() {
        let signal = TrainingSignal {
            schema_version: "0.1.9"
                .parse::<ContractVersion>()
                .expect("canonical version"),
            archetype: token("cell_transit"),
            fields: base()
                .into_iter()
                .map(|(name, value)| (token(name), value))
                .collect(),
        };
        let error = validate(&registry(), &signal, None).expect_err("versions must match exactly");
        assert_eq!(
            error.details().and_then(|d| d.schema_violation),
            Some(aiai_contracts::SchemaViolation::SchemaVersionMismatch)
        );
    }

    #[test]
    fn a_schema_declaring_no_carrier_leaves_an_identifier_nowhere_to_travel() {
        // Every value in a payload is a declared token, a bounded measure, or a bounded
        // sequence of those. A client wanting to smuggle an identifier has to put it in a
        // field, and every field is checked against a closed domain.
        for smuggled in [
            SignalValue::Token(token("sub_a1b2c3")),
            measure(1_763_000_000),
            SignalValue::Sequence(vec![measure(4_095), measure(4_094)]),
        ] {
            let mut fields = base();
            fields[1] = ("dwell_seconds", smuggled);
            validate(&registry(), &payload(fields), None)
                .expect_err("no field accepts a value its domain does not declare");
        }
    }
}
