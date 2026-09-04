// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! The producing side of the shared wire corpus.
//!
//! `fixtures/contract-wire-0.2.0.json` is checked by two implementations of contract
//! `0.2.0`: these crates, and the host-side package under `packages/aiai-contracts`. A host
//! that decodes a foundation payload has to re-derive these rules in its own language, and
//! a re-derived decoder drifts silently — a mirror is only worth having if a drift fails a
//! build. This file is the half of that lock which runs here.
//!
//! The closed vocabularies are walked through exhaustive `match` arms rather than a list of
//! strings, so adding a variant stops this compiling until the corpus and the mirror carry
//! it too.

use aiai_contracts::{
    AdmissionEnvelope, CapabilityName, ContextPort, ContractVersion, ControllerId, DecimalU64,
    EffectRequestEnvelope, ErrorCode, FailureKind, FailureRecord, FoundationError, ModelId,
    OperationId, ProposalEnvelope, ProposalId, RuntimeId, SchemaViolation, SessionId, Sha256Digest,
    SubjectId, TurnOutcome, VariantKind, WakeEnvelope, canonical_json, require_compatible_contract,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../fixtures/contract-wire-0.2.0.json");

/// Stand-in for a product payload. The foundation never learns what one means.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SamplePayload {
    kind: String,
    note: String,
}

fn corpus() -> Value {
    serde_json::from_str(FIXTURE).expect("the corpus is JSON")
}

fn section<'a>(root: &'a Value, path: &str) -> &'a Value {
    let mut cursor = root;
    for name in path.split('.') {
        cursor = cursor
            .get(name)
            .unwrap_or_else(|| panic!("the corpus carries {path}"));
    }
    cursor
}

fn strings(root: &Value, path: &str) -> Vec<String> {
    section(root, path)
        .as_array()
        .unwrap_or_else(|| panic!("{path} is a list"))
        .iter()
        .map(|value| {
            value
                .as_str()
                .unwrap_or_else(|| panic!("{path} holds strings"))
                .to_owned()
        })
        .collect()
}

fn entries<'a>(root: &'a Value, path: &str) -> &'a [Value] {
    section(root, path)
        .as_array()
        .unwrap_or_else(|| panic!("{path} is a list"))
}

fn member<'a>(entry: &'a Value, name: &str) -> &'a str {
    entry
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("the entry carries a {name} string"))
}

fn text<'a>(root: &'a Value, path: &str) -> &'a str {
    section(root, path)
        .as_str()
        .unwrap_or_else(|| panic!("{path} is a string"))
}

fn flag(entry: &Value, name: &str) -> bool {
    entry
        .get(name)
        .and_then(Value::as_bool)
        .unwrap_or_else(|| panic!("the entry carries a {name} flag"))
}

#[test]
fn the_corpus_names_the_line_this_build_implements() {
    let root = corpus();
    assert_eq!(
        text(&root, "contract_version"),
        aiai_contracts::CONTRACT_VERSION
    );
}

#[test]
fn contract_versions_parse_exactly_as_the_corpus_says() {
    let root = corpus();
    for value in strings(&root, "contract_versions.accepted") {
        assert!(
            value.parse::<ContractVersion>().is_ok(),
            "must parse: {value}"
        );
    }
    for value in strings(&root, "contract_versions.rejected") {
        assert!(
            value.parse::<ContractVersion>().is_err(),
            "must be refused: {value}"
        );
    }
}

#[test]
fn compatibility_answers_match_the_corpus() {
    let root = corpus();
    for entry in entries(&root, "contract_versions.compatibility") {
        let required: ContractVersion = member(entry, "required").parse().expect("required");
        let provider: ContractVersion = member(entry, "provider").parse().expect("provider");
        assert_eq!(
            required.accepts_provider(provider),
            flag(entry, "accepted"),
            "{required} accepts {provider}"
        );
    }
}

#[test]
fn the_handshake_refuses_with_the_failure_the_corpus_records() {
    let root = corpus();
    for entry in entries(&root, "contract_versions.handshake") {
        let requested = member(entry, "requested");
        let accepted = flag(entry, "accepted");
        match require_compatible_contract(requested, None) {
            Ok(_) => assert!(accepted, "{requested} must be refused"),
            Err(error) => {
                assert!(!accepted, "{requested} must be accepted");
                let encoded = canonical_json(&error).expect("a failure is canonical");
                assert_eq!(
                    String::from_utf8(encoded).expect("UTF-8"),
                    member(entry, "error"),
                    "{requested}"
                );
            }
        }
    }
}

#[test]
fn decimal_integers_parse_exactly_as_the_corpus_says() {
    let root = corpus();
    assert_eq!(
        DecimalU64::new(u64::MAX).to_string(),
        text(&root, "decimal_u64.max")
    );
    for value in strings(&root, "decimal_u64.accepted") {
        let parsed: DecimalU64 = value
            .parse()
            .unwrap_or_else(|_| panic!("must parse: {value}"));
        assert_eq!(parsed.to_string(), value);
    }
    for value in strings(&root, "decimal_u64.rejected") {
        assert!(
            value.parse::<DecimalU64>().is_err(),
            "must be refused: {value}"
        );
    }
}

fn identifier_parses(kind: &str, value: &str) -> bool {
    match kind {
        "subject" => value.parse::<SubjectId>().is_ok(),
        "controller" => value.parse::<ControllerId>().is_ok(),
        "runtime" => value.parse::<RuntimeId>().is_ok(),
        "model" => value.parse::<ModelId>().is_ok(),
        "session" => value.parse::<SessionId>().is_ok(),
        "proposal" => value.parse::<ProposalId>().is_ok(),
        "operation" => value.parse::<OperationId>().is_ok(),
        "sha256" => value.parse::<Sha256Digest>().is_ok(),
        other => panic!("the corpus names an unknown identifier kind: {other}"),
    }
}

#[test]
fn identifiers_parse_exactly_as_the_corpus_says() {
    let root = corpus();
    let kinds = section(&root, "identifiers")
        .as_object()
        .expect("the corpus lists identifier kinds");
    for (kind, entry) in kinds {
        let prefix = member(entry, "prefix");
        let declared = entry
            .get("hex_length")
            .and_then(Value::as_u64)
            .expect("the entry declares a body length");
        let body = "a".repeat(usize::try_from(declared).expect("a body length fits in usize"));
        assert!(
            identifier_parses(kind, &format!("{prefix}{body}")),
            "{kind}: the declared shape must parse"
        );
        assert!(
            !identifier_parses(kind, &format!("{prefix}{}", &body[1..])),
            "{kind}: a shorter body must be refused"
        );
        for value in strings(entry, "accepted") {
            assert!(
                identifier_parses(kind, &value),
                "{kind}: must parse {value}"
            );
        }
        for value in strings(entry, "rejected") {
            assert!(
                !identifier_parses(kind, &value),
                "{kind}: must refuse {value}"
            );
        }
    }
}

#[test]
fn capability_names_parse_exactly_as_the_corpus_says() {
    let root = corpus();
    assert_eq!(
        section(&root, "capability_names.max_length")
            .as_u64()
            .expect("a declared maximum"),
        aiai_contracts::CAPABILITY_NAME_MAX_LEN as u64
    );
    for value in strings(&root, "capability_names.accepted") {
        assert!(
            value.parse::<CapabilityName>().is_ok(),
            "must parse: {value}"
        );
    }
    for value in strings(&root, "capability_names.rejected") {
        assert!(
            value.parse::<CapabilityName>().is_err(),
            "must be refused: {value}"
        );
    }
}

/// Every code, spelled once here so that a new variant stops this file compiling.
fn code_token(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::MalformedEnvelope => "malformed_envelope",
        ErrorCode::UnsupportedContractVersion => "unsupported_contract_version",
        ErrorCode::UnknownVariant => "unknown_variant",
        ErrorCode::MissingContext => "missing_context",
        ErrorCode::RuntimeInactive => "runtime_inactive",
        ErrorCode::InferenceUnavailable => "inference_unavailable",
        ErrorCode::SubjectContinuityViolation => "subject_continuity_violation",
        ErrorCode::UnknownProposal => "unknown_proposal",
        ErrorCode::DuplicateProposalId => "duplicate_proposal_id",
        ErrorCode::AuthorityWithheld => "authority_withheld",
        ErrorCode::AuthorityScopeExceeded => "authority_scope_exceeded",
        ErrorCode::SequenceExhausted => "sequence_exhausted",
        ErrorCode::SignalSchemaViolation => "signal_schema_violation",
    }
}

fn port_token(port: ContextPort) -> &'static str {
    match port {
        ContextPort::Clock => "clock",
        ContextPort::IdentifierGeneration => "identifier_generation",
        ContextPort::Inference => "inference",
        ContextPort::Authority => "authority",
    }
}

fn variant_token(kind: VariantKind) -> &'static str {
    match kind {
        VariantKind::WakeReason => "wake_reason",
        VariantKind::ProposalKind => "proposal_kind",
        VariantKind::ActionArchetype => "action_archetype",
        VariantKind::ArchetypeField => "archetype_field",
    }
}

fn violation_token(violation: SchemaViolation) -> &'static str {
    match violation {
        SchemaViolation::UnknownArchetype => "unknown_archetype",
        SchemaViolation::UnknownField => "unknown_field",
        SchemaViolation::MissingField => "missing_field",
        SchemaViolation::ValueOutOfDomain => "value_out_of_domain",
        SchemaViolation::ExcessPrecision => "excess_precision",
        SchemaViolation::ExcessCardinality => "excess_cardinality",
        SchemaViolation::NonCanonicalEncoding => "non_canonical_encoding",
        SchemaViolation::InvalidFieldCombination => "invalid_field_combination",
        SchemaViolation::SchemaVersionMismatch => "schema_version_mismatch",
    }
}

/// Every kind, spelled once, for the same reason as every other closed vocabulary here.
fn failure_kind_token(kind: FailureKind) -> &'static str {
    match kind {
        FailureKind::Unavailable => "unavailable",
        FailureKind::Withheld => "withheld",
        FailureKind::Gated => "gated",
        FailureKind::Rejected => "rejected",
        FailureKind::Exhausted => "exhausted",
    }
}

fn wire_token<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .expect("a closed vocabulary serializes")
        .as_str()
        .expect("a closed vocabulary is a string")
        .to_owned()
}

const fn all_codes() -> [ErrorCode; 13] {
    [
        ErrorCode::MalformedEnvelope,
        ErrorCode::UnsupportedContractVersion,
        ErrorCode::UnknownVariant,
        ErrorCode::MissingContext,
        ErrorCode::RuntimeInactive,
        ErrorCode::InferenceUnavailable,
        ErrorCode::SubjectContinuityViolation,
        ErrorCode::UnknownProposal,
        ErrorCode::DuplicateProposalId,
        ErrorCode::AuthorityWithheld,
        ErrorCode::AuthorityScopeExceeded,
        ErrorCode::SequenceExhausted,
        ErrorCode::SignalSchemaViolation,
    ]
}

#[test]
fn error_codes_are_spelled_the_same_on_both_sides() {
    let root = corpus();
    let codes = all_codes();
    let expected = strings(&root, "error_codes");
    assert_eq!(codes.len(), expected.len());
    for (code, token) in codes.into_iter().zip(expected) {
        assert_eq!(code_token(code), token);
        assert_eq!(code.as_str(), token);
        assert_eq!(wire_token(&code), token);
    }
}

#[test]
fn port_variant_and_violation_vocabularies_are_spelled_the_same_on_both_sides() {
    let root = corpus();
    let ports = [
        ContextPort::Clock,
        ContextPort::IdentifierGeneration,
        ContextPort::Inference,
        ContextPort::Authority,
    ];
    let expected = strings(&root, "context_ports");
    assert_eq!(ports.len(), expected.len());
    for (port, token) in ports.into_iter().zip(expected) {
        assert_eq!(port_token(port), token);
        assert_eq!(port.as_str(), token);
        assert_eq!(wire_token(&port), token);
    }

    let kinds = [
        VariantKind::WakeReason,
        VariantKind::ProposalKind,
        VariantKind::ActionArchetype,
        VariantKind::ArchetypeField,
    ];
    let expected = strings(&root, "variant_kinds");
    assert_eq!(kinds.len(), expected.len());
    for (kind, token) in kinds.into_iter().zip(expected) {
        assert_eq!(variant_token(kind), token);
        assert_eq!(wire_token(&kind), token);
    }

    let violations = [
        SchemaViolation::UnknownArchetype,
        SchemaViolation::UnknownField,
        SchemaViolation::MissingField,
        SchemaViolation::ValueOutOfDomain,
        SchemaViolation::ExcessPrecision,
        SchemaViolation::ExcessCardinality,
        SchemaViolation::NonCanonicalEncoding,
        SchemaViolation::InvalidFieldCombination,
        SchemaViolation::SchemaVersionMismatch,
    ];
    let expected = strings(&root, "schema_violations");
    assert_eq!(violations.len(), expected.len());
    for (violation, token) in violations.into_iter().zip(expected) {
        assert_eq!(violation_token(violation), token);
        assert_eq!(violation.as_str(), token);
        assert_eq!(wire_token(&violation), token);
    }
}

#[test]
fn every_code_is_classified_exactly_as_the_corpus_says() {
    let root = corpus();
    let kinds = [
        FailureKind::Unavailable,
        FailureKind::Withheld,
        FailureKind::Gated,
        FailureKind::Rejected,
        FailureKind::Exhausted,
    ];
    let declared = strings(&root, "failure_classification.kinds");
    assert_eq!(kinds.len(), declared.len());
    for (kind, token) in kinds.into_iter().zip(declared) {
        assert_eq!(failure_kind_token(kind), token);
        assert_eq!(kind.as_str(), token);
        assert_eq!(wire_token(&kind), token);
    }

    let retryable = strings(&root, "failure_classification.retryable_kinds");
    let by_code = section(&root, "failure_classification.by_code")
        .as_object()
        .expect("the corpus classifies every code");
    let codes = strings(&root, "error_codes");
    assert_eq!(by_code.len(), codes.len(), "every code is classified");

    for code in all_codes() {
        let token = code.as_str();
        let expected = by_code
            .get(token)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("the corpus classifies {token}"));
        assert_eq!(failure_kind_token(code.kind()), expected, "{token}");
        // Retryability is derived from the kind rather than listed per code, so the corpus
        // cannot record a code that is retryable while its kind is not.
        assert_eq!(
            code.is_retryable(),
            retryable.iter().any(|kind| kind == expected),
            "{token}"
        );
    }
}

#[test]
fn canonical_json_produces_the_bytes_the_corpus_records() {
    let root = corpus();
    for entry in entries(&root, "canonical_json.accepted") {
        let input = member(entry, "input");
        let expected = member(entry, "canonical");
        let value: Value = serde_json::from_str(input).expect("the corpus input is JSON");
        let encoded = canonical_json(&value).unwrap_or_else(|_| panic!("must encode: {input}"));
        assert_eq!(
            String::from_utf8(encoded).expect("UTF-8"),
            expected,
            "{input}"
        );
    }
}

#[test]
fn canonical_json_refuses_what_the_corpus_records_as_refused() {
    let root = corpus();
    for entry in entries(&root, "canonical_json.rejected") {
        let input = member(entry, "input");
        let reason = member(entry, "reason");
        let parsed: Result<Value, _> = serde_json::from_str(input);
        if reason == "malformed_json" {
            assert!(parsed.is_err(), "must not parse: {input}");
            continue;
        }
        let value = parsed.unwrap_or_else(|_| panic!("the corpus input is JSON: {input}"));
        assert!(
            canonical_json(&value).is_err(),
            "must be refused: {input} ({reason})"
        );
    }
}

fn round_trips<T>(document: &str) -> bool
where
    T: Serialize + for<'de> Deserialize<'de>,
{
    let Ok(value) = serde_json::from_str::<T>(document) else {
        return false;
    };
    canonical_json(&value).is_ok_and(|encoded| encoded == document.as_bytes())
}

#[test]
fn every_document_in_the_corpus_survives_a_decode_and_re_encode_unchanged() {
    let root = corpus();
    for document in strings(&root, "documents.foundation_errors") {
        assert!(round_trips::<FoundationError>(&document), "{document}");
    }
    for document in strings(&root, "documents.wake_envelopes") {
        assert!(
            round_trips::<WakeEnvelope<SamplePayload>>(&document),
            "{document}"
        );
    }
    for document in strings(&root, "documents.proposal_envelopes") {
        assert!(
            round_trips::<ProposalEnvelope<SamplePayload>>(&document),
            "{document}"
        );
    }
    for document in strings(&root, "documents.admission_envelopes") {
        assert!(
            round_trips::<AdmissionEnvelope<SamplePayload>>(&document),
            "{document}"
        );
    }
    for document in strings(&root, "documents.effect_request_envelopes") {
        assert!(
            round_trips::<EffectRequestEnvelope<SamplePayload>>(&document),
            "{document}"
        );
    }
    for document in strings(&root, "documents.turn_outcomes") {
        assert!(
            round_trips::<TurnOutcome<SamplePayload, SamplePayload>>(&document),
            "{document}"
        );
    }
    for document in strings(&root, "documents.failure_records") {
        assert!(round_trips::<FailureRecord>(&document), "{document}");
    }
}

fn decodes(shape: &str, document: &str) -> bool {
    match shape {
        "foundation_error" => serde_json::from_str::<FoundationError>(document).is_ok(),
        "wake_envelope" => serde_json::from_str::<WakeEnvelope<SamplePayload>>(document).is_ok(),
        "proposal_envelope" => {
            serde_json::from_str::<ProposalEnvelope<SamplePayload>>(document).is_ok()
        }
        "admission_envelope" => {
            serde_json::from_str::<AdmissionEnvelope<SamplePayload>>(document).is_ok()
        }
        "effect_request_envelope" => {
            serde_json::from_str::<EffectRequestEnvelope<SamplePayload>>(document).is_ok()
        }
        "turn_outcome" => {
            serde_json::from_str::<TurnOutcome<SamplePayload, SamplePayload>>(document).is_ok()
        }
        "failure_record" => serde_json::from_str::<FailureRecord>(document).is_ok(),
        other => panic!("the corpus names an unknown shape: {other}"),
    }
}

#[test]
fn every_invalid_document_in_the_corpus_is_refused() {
    let root = corpus();
    for entry in entries(&root, "invalid_documents") {
        let shape = member(entry, "shape");
        let document = member(entry, "document");
        assert!(
            !decodes(shape, document),
            "{shape} carrying {} must be refused: {document}",
            member(entry, "carries")
        );
    }
}
