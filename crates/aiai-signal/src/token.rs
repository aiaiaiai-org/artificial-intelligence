// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use core::{fmt, str::FromStr};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

/// Maximum length of a canonical schema token.
pub const TOKEN_MAX_LEN: usize = 48;

/// Failure returned when a schema token is not canonical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenError;

impl fmt::Display for TokenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("schema token is not canonical")
    }
}

impl std::error::Error for TokenError {}

/// Bounded lowercase token naming an archetype, a field, or an enumerated value.
///
/// Tokens are the only string-shaped thing a signal may carry, and every token that
/// appears in a payload must have been declared by the schema first. There is no
/// free-text field anywhere in this crate: an unrestricted string is a carrier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Token(String);

impl Token {
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
    value.len() <= TOKEN_MAX_LEN
        && first.is_ascii_lowercase()
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        && !value.ends_with('_')
        && !value.contains("__")
}

impl TryFrom<String> for Token {
    type Error = TokenError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if is_canonical(&value) {
            Ok(Self(value))
        } else {
            Err(TokenError)
        }
    }
}

impl FromStr for Token {
    type Err = TokenError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        value.to_owned().try_into()
    }
}

impl fmt::Display for Token {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for Token {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Token {
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
    use super::{TOKEN_MAX_LEN, Token, TokenError};

    #[test]
    fn accepts_canonical_tokens() {
        assert_eq!(
            "route_traversal"
                .parse::<Token>()
                .map(|t| t.as_str().to_owned()),
            Ok("route_traversal".to_owned())
        );
    }

    #[test]
    fn rejects_carriers_disguised_as_tokens() {
        for value in ["", "A", "_a", "a__b", "a b", "a-b", "0a", "ключ"] {
            assert_eq!(value.parse::<Token>(), Err(TokenError), "{value}");
        }
        assert_eq!(
            "a".repeat(TOKEN_MAX_LEN + 1).parse::<Token>(),
            Err(TokenError)
        );
    }
}
