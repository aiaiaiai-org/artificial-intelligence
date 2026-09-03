// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use core::{fmt, str::FromStr};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

/// Maximum length of a canonical capability name.
pub const CAPABILITY_NAME_MAX_LEN: usize = 64;

/// Failure returned when a capability name is not canonical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityNameError;

impl fmt::Display for CapabilityNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("capability name is not canonical")
    }
}

impl std::error::Error for CapabilityNameError {}

/// Bounded lowercase capability token, e.g. `message` or `deliver_asset`.
///
/// The foundation constrains the shape of a capability name but never its vocabulary:
/// which capabilities exist, and what authority each one needs, is owned by the product
/// contract that grants them.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapabilityName(String);

impl CapabilityName {
    /// Returns the canonical ASCII representation.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_canonical(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= CAPABILITY_NAME_MAX_LEN
        && first.is_ascii_lowercase()
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && !value.ends_with('_')
        && !value.contains("__")
}

impl TryFrom<String> for CapabilityName {
    type Error = CapabilityNameError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if is_canonical(&value) {
            Ok(Self(value))
        } else {
            Err(CapabilityNameError)
        }
    }
}

impl FromStr for CapabilityName {
    type Err = CapabilityNameError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        value.to_owned().try_into()
    }
}

impl fmt::Display for CapabilityName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for CapabilityName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CapabilityName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.try_into().map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::{CAPABILITY_NAME_MAX_LEN, CapabilityName, CapabilityNameError};

    #[test]
    fn accepts_canonical_names() {
        assert_eq!(
            "deliver_asset"
                .parse::<CapabilityName>()
                .map(|n| n.as_str().to_owned()),
            Ok("deliver_asset".to_owned())
        );
    }

    #[test]
    fn rejects_non_canonical_shapes() {
        for value in ["", "_x", "X", "a__b", "a_", "a-b", "тест"] {
            assert_eq!(
                value.parse::<CapabilityName>(),
                Err(CapabilityNameError),
                "{value}"
            );
        }
        let overlong = "a".repeat(CAPABILITY_NAME_MAX_LEN + 1);
        assert_eq!(overlong.parse::<CapabilityName>(), Err(CapabilityNameError));
    }
}
