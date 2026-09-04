// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use crate::{CapabilityName, OperationId, ProposalId, SubjectId};
use core::fmt;
use serde::{Deserialize, Serialize};

/// Stable error-code surface for foundation contract `0.1.0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MalformedEnvelope,
    UnsupportedContractVersion,
    UnknownVariant,
    MissingContext,
    RuntimeInactive,
    InferenceUnavailable,
    SubjectContinuityViolation,
    UnknownProposal,
    DuplicateProposalId,
    AuthorityWithheld,
    AuthorityScopeExceeded,
    SequenceExhausted,
    SignalSchemaViolation,
}

impl ErrorCode {
    /// Returns the canonical wire token for this code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MalformedEnvelope => "malformed_envelope",
            Self::UnsupportedContractVersion => "unsupported_contract_version",
            Self::UnknownVariant => "unknown_variant",
            Self::MissingContext => "missing_context",
            Self::RuntimeInactive => "runtime_inactive",
            Self::InferenceUnavailable => "inference_unavailable",
            Self::SubjectContinuityViolation => "subject_continuity_violation",
            Self::UnknownProposal => "unknown_proposal",
            Self::DuplicateProposalId => "duplicate_proposal_id",
            Self::AuthorityWithheld => "authority_withheld",
            Self::AuthorityScopeExceeded => "authority_scope_exceeded",
            Self::SequenceExhausted => "sequence_exhausted",
            Self::SignalSchemaViolation => "signal_schema_violation",
        }
    }
}

/// Closed name of an explicit external port required by the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextPort {
    Clock,
    IdentifierGeneration,
    Inference,
    Authority,
}

impl ContextPort {
    /// Returns the canonical wire token for this port.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Clock => "clock",
            Self::IdentifierGeneration => "identifier_generation",
            Self::Inference => "inference",
            Self::Authority => "authority",
        }
    }
}

impl fmt::Display for ContextPort {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Closed name of the contract surface whose variant was not recognized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VariantKind {
    WakeReason,
    ProposalKind,
    ActionArchetype,
    ArchetypeField,
}

/// Closed reason a training-signal payload failed independent validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchemaViolation {
    UnknownArchetype,
    UnknownField,
    MissingField,
    ValueOutOfDomain,
    ExcessPrecision,
    ExcessCardinality,
    NonCanonicalEncoding,
    InvalidFieldCombination,
    SchemaVersionMismatch,
}

impl SchemaViolation {
    /// Returns the canonical wire token for this violation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnknownArchetype => "unknown_archetype",
            Self::UnknownField => "unknown_field",
            Self::MissingField => "missing_field",
            Self::ValueOutOfDomain => "value_out_of_domain",
            Self::ExcessPrecision => "excess_precision",
            Self::ExcessCardinality => "excess_cardinality",
            Self::NonCanonicalEncoding => "non_canonical_encoding",
            Self::InvalidFieldCombination => "invalid_field_combination",
            Self::SchemaVersionMismatch => "schema_version_mismatch",
        }
    }
}

impl fmt::Display for SchemaViolation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Closed, code-specific failure details. Absent members are omitted from the wire form.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Details {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_contract_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_contract_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<ContextPort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant_kind: Option<VariantKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_subject_id: Option<SubjectId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_subject_id: Option<SubjectId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<ProposalId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_capability: Option<CapabilityName>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_violation: Option<SchemaViolation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
}

/// Deterministic failure envelope carried across every foundation binding.
///
/// A failure is always an observable outcome. The runtime never substitutes a fabricated
/// success, acknowledgement, or completion for one of these values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FoundationError {
    code: ErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_id: Option<OperationId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    details: Option<Box<Details>>,
}

impl FoundationError {
    fn new(code: ErrorCode, operation_id: Option<OperationId>, details: Details) -> Self {
        Self {
            code,
            operation_id,
            details: if details == Details::default() {
                None
            } else {
                Some(Box::new(details))
            },
        }
    }

    /// Returns the stable error code.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    /// Returns the correlation handle supplied by the caller, when one was available.
    #[must_use]
    pub const fn operation_id(&self) -> Option<&OperationId> {
        self.operation_id.as_ref()
    }

    /// Returns the closed details attached to this failure, when the code carries any.
    #[must_use]
    pub fn details(&self) -> Option<&Details> {
        self.details.as_deref()
    }

    /// The payload could not be decoded against its closed envelope shape.
    #[must_use]
    pub fn malformed_envelope(operation_id: Option<OperationId>) -> Self {
        Self::new(
            ErrorCode::MalformedEnvelope,
            operation_id,
            Details::default(),
        )
    }

    /// The caller requires a contract line this build does not implement.
    #[must_use]
    pub fn unsupported_contract_version(
        operation_id: Option<OperationId>,
        required: Option<String>,
        supported: String,
    ) -> Self {
        Self::new(
            ErrorCode::UnsupportedContractVersion,
            operation_id,
            Details {
                required_contract_version: required,
                supported_contract_version: Some(supported),
                ..Details::default()
            },
        )
    }

    /// A closed enumeration received a variant this build does not recognize.
    #[must_use]
    pub fn unknown_variant(operation_id: Option<OperationId>, kind: VariantKind) -> Self {
        Self::new(
            ErrorCode::UnknownVariant,
            operation_id,
            Details {
                variant_kind: Some(kind),
                ..Details::default()
            },
        )
    }

    /// A required external port was not supplied by the caller.
    #[must_use]
    pub fn missing_context(operation_id: Option<OperationId>, port: ContextPort) -> Self {
        Self::new(
            ErrorCode::MissingContext,
            operation_id,
            Details {
                port: Some(port),
                ..Details::default()
            },
        )
    }

    /// The activation gate is closed, so the runtime produced nothing.
    #[must_use]
    pub fn runtime_inactive(operation_id: Option<OperationId>) -> Self {
        Self::new(ErrorCode::RuntimeInactive, operation_id, Details::default())
    }

    /// The inference port could not answer. Degradation is explicit, never invented output.
    #[must_use]
    pub fn inference_unavailable(operation_id: Option<OperationId>) -> Self {
        Self::new(
            ErrorCode::InferenceUnavailable,
            operation_id,
            Details::default(),
        )
    }

    /// A rebind attempted to move a session onto a different subject.
    #[must_use]
    pub fn subject_continuity_violation(
        operation_id: Option<OperationId>,
        bound: SubjectId,
        attempted: SubjectId,
    ) -> Self {
        Self::new(
            ErrorCode::SubjectContinuityViolation,
            operation_id,
            Details {
                bound_subject_id: Some(bound),
                attempted_subject_id: Some(attempted),
                ..Details::default()
            },
        )
    }

    /// An admission referenced a proposal this session never produced.
    #[must_use]
    pub fn unknown_proposal(operation_id: Option<OperationId>, proposal_id: ProposalId) -> Self {
        Self::new(
            ErrorCode::UnknownProposal,
            operation_id,
            Details {
                proposal_id: Some(proposal_id),
                ..Details::default()
            },
        )
    }

    /// Identifier generation returned a proposal identifier the session already holds.
    ///
    /// The session refuses the whole batch rather than overwriting the proposal it already
    /// owns, because overwriting would silently replace the canonical content behind an
    /// identifier a caller may already be holding.
    #[must_use]
    pub fn duplicate_proposal_id(
        operation_id: Option<OperationId>,
        proposal_id: ProposalId,
    ) -> Self {
        Self::new(
            ErrorCode::DuplicateProposalId,
            operation_id,
            Details {
                proposal_id: Some(proposal_id),
                ..Details::default()
            },
        )
    }

    /// The authority port declined to admit the proposal.
    #[must_use]
    pub fn authority_withheld(
        operation_id: Option<OperationId>,
        proposal_id: ProposalId,
        capability: CapabilityName,
    ) -> Self {
        Self::new(
            ErrorCode::AuthorityWithheld,
            operation_id,
            Details {
                proposal_id: Some(proposal_id),
                requested_capability: Some(capability),
                ..Details::default()
            },
        )
    }

    /// An admission grant was broader than the authority it was derived from.
    #[must_use]
    pub fn authority_scope_exceeded(
        operation_id: Option<OperationId>,
        proposal_id: ProposalId,
        capability: CapabilityName,
    ) -> Self {
        Self::new(
            ErrorCode::AuthorityScopeExceeded,
            operation_id,
            Details {
                proposal_id: Some(proposal_id),
                requested_capability: Some(capability),
                ..Details::default()
            },
        )
    }

    /// The session emission counter reached its ceiling.
    #[must_use]
    pub fn sequence_exhausted(operation_id: Option<OperationId>) -> Self {
        Self::new(
            ErrorCode::SequenceExhausted,
            operation_id,
            Details::default(),
        )
    }

    /// A training-signal payload failed independent schema validation.
    #[must_use]
    pub fn signal_schema_violation(
        operation_id: Option<OperationId>,
        violation: SchemaViolation,
        field: Option<String>,
    ) -> Self {
        Self::new(
            ErrorCode::SignalSchemaViolation,
            operation_id,
            Details {
                schema_violation: Some(violation),
                field,
                ..Details::default()
            },
        )
    }
}

impl fmt::Display for FoundationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code.as_str())
    }
}

impl std::error::Error for FoundationError {}

#[cfg(test)]
mod tests {
    use super::{ContextPort, ErrorCode, FoundationError, SchemaViolation};
    use crate::canonical_json;

    /// `as_str` is what a reader sees; serde is what a peer reads. One spelling, or a log
    /// line and a payload disagree about the same value.
    fn wire_token<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_string(value)
            .expect("a closed token serializes")
            .trim_matches('"')
            .to_owned()
    }

    #[test]
    fn every_error_code_reads_the_same_way_it_serializes() {
        for code in [
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
        ] {
            assert_eq!(code.as_str(), wire_token(&code));
        }
    }

    #[test]
    fn every_context_port_reads_the_same_way_it_serializes() {
        for port in [
            ContextPort::Clock,
            ContextPort::IdentifierGeneration,
            ContextPort::Inference,
            ContextPort::Authority,
        ] {
            assert_eq!(port.as_str(), wire_token(&port));
            assert_eq!(port.to_string(), wire_token(&port));
        }
    }

    #[test]
    fn every_schema_violation_reads_the_same_way_it_serializes() {
        for violation in [
            SchemaViolation::UnknownArchetype,
            SchemaViolation::UnknownField,
            SchemaViolation::MissingField,
            SchemaViolation::ValueOutOfDomain,
            SchemaViolation::ExcessPrecision,
            SchemaViolation::ExcessCardinality,
            SchemaViolation::NonCanonicalEncoding,
            SchemaViolation::InvalidFieldCombination,
            SchemaViolation::SchemaVersionMismatch,
        ] {
            assert_eq!(violation.as_str(), wire_token(&violation));
            assert_eq!(violation.to_string(), wire_token(&violation));
        }
    }

    #[test]
    fn omits_empty_details_from_the_wire_form() {
        let error = FoundationError::runtime_inactive(None);
        let encoded = canonical_json(&error).expect("canonical JSON");
        assert_eq!(encoded, br#"{"code":"runtime_inactive"}"#);
    }

    #[test]
    fn carries_only_code_specific_details() {
        let error = FoundationError::missing_context(None, ContextPort::Inference);
        let encoded = canonical_json(&error).expect("canonical JSON");
        assert_eq!(
            encoded,
            br#"{"code":"missing_context","details":{"port":"inference"}}"#
        );
        assert_eq!(error.code(), ErrorCode::MissingContext);
        assert_eq!(
            error.details().and_then(|details| details.port),
            Some(ContextPort::Inference)
        );
    }

    #[test]
    fn round_trips_a_schema_violation() {
        let error = FoundationError::signal_schema_violation(
            None,
            SchemaViolation::ExcessPrecision,
            Some("dwell_seconds".to_owned()),
        );
        let encoded = serde_json::to_vec(&error).expect("serialization");
        let decoded: FoundationError = serde_json::from_slice(&encoded).expect("round trip");
        assert_eq!(decoded, error);
    }
}
