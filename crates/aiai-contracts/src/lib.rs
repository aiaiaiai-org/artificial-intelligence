// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! Binding-safe contract boundary for the aiaiaiai AI foundation.
//!
//! This crate represents the `0.2.0` foundation contract: canonical identifiers, integer
//! strings, closed generic envelopes, and a deterministic failure taxonomy. It defines no
//! product semantics — no participant model, no relationship type, no interaction registry
//! — so a product repository can bind its own vocabulary to these shapes without the
//! foundation acquiring knowledge of it.

mod canonical;
mod capability;
mod envelope;
mod error;
mod identifier;
mod scalar;
mod version;

pub use canonical::{CanonicalJsonError, canonical_json};
pub use capability::{CAPABILITY_NAME_MAX_LEN, CapabilityName, CapabilityNameError};
pub use envelope::{
    AdmissionEnvelope, EffectRequestEnvelope, ProposalEnvelope, TurnOk, TurnOutcome, WakeEnvelope,
};
pub use error::{ContextPort, Details, ErrorCode, FoundationError, SchemaViolation, VariantKind};
pub use identifier::{
    ControllerId, IdentifierError, ModelId, OperationId, ProposalId, RuntimeId, SessionId,
    Sha256Digest, SubjectId,
};
pub use scalar::{DecimalU64, DecimalU64Error};
pub use version::{ContractVersion, VersionError};

/// Normative foundation contract version implemented by this workspace.
pub const CONTRACT_VERSION: &str = "0.2.0";

/// Validates directional contract compatibility before a payload is decoded.
///
/// # Errors
///
/// Returns [`FoundationError::unsupported_contract_version`] when `requested` is
/// non-canonical or falls outside the compatibility line this build implements.
pub fn require_compatible_contract(
    requested: &str,
    operation_id: Option<OperationId>,
) -> Result<ContractVersion, FoundationError> {
    let Ok(required) = requested.parse::<ContractVersion>() else {
        return Err(FoundationError::unsupported_contract_version(
            operation_id,
            None,
            CONTRACT_VERSION.to_owned(),
        ));
    };

    if required.accepts_provider(ContractVersion::CURRENT) {
        Ok(required)
    } else {
        Err(FoundationError::unsupported_contract_version(
            operation_id,
            Some(required.to_string()),
            CONTRACT_VERSION.to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{CONTRACT_VERSION, ContractVersion, ErrorCode, require_compatible_contract};

    #[test]
    fn handshake_matches_the_normative_contract() {
        assert_eq!(ContractVersion::CURRENT.to_string(), CONTRACT_VERSION);
    }

    #[test]
    fn rejects_another_compatibility_line() {
        let error = require_compatible_contract("0.3.0", None).expect_err("0.3 is another line");
        assert_eq!(error.code(), ErrorCode::UnsupportedContractVersion);
    }

    #[test]
    fn rejects_a_noncanonical_version_without_echoing_it() {
        let error = require_compatible_contract("0.01.0", None).expect_err("malformed version");
        assert_eq!(error.code(), ErrorCode::UnsupportedContractVersion);
        assert_eq!(
            error
                .details()
                .and_then(|details| details.required_contract_version.as_deref()),
            None
        );
    }
}
