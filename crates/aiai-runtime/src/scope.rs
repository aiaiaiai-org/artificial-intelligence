// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use aiai_contracts::CapabilityName;
use core::fmt;
use std::collections::BTreeSet;

/// A requested delegation was not contained in the authority it was derived from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeExpansion {
    /// Capabilities the request asked for that its source does not hold.
    pub excess: BTreeSet<CapabilityName>,
}

impl fmt::Display for ScopeExpansion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("delegated scope is broader than its source")
    }
}

impl std::error::Error for ScopeExpansion {}

/// The set of capabilities a runtime is permitted to request on a subject's behalf.
///
/// The foundation constrains how a scope may change, never which capabilities exist. It
/// enforces one rule: a derived scope is always a subset of the scope it came from, so
/// delegation cannot widen through repeated use, inference, or convenience.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DelegationScope {
    capabilities: BTreeSet<CapabilityName>,
}

impl DelegationScope {
    /// Builds a scope from the capabilities it grants.
    #[must_use]
    pub fn new(capabilities: impl IntoIterator<Item = CapabilityName>) -> Self {
        Self {
            capabilities: capabilities.into_iter().collect(),
        }
    }

    /// Returns an empty scope, which permits nothing.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    /// Returns whether this scope grants `capability`.
    #[must_use]
    pub fn permits(&self, capability: &CapabilityName) -> bool {
        self.capabilities.contains(capability)
    }

    /// Returns whether this scope grants nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.capabilities.is_empty()
    }

    /// Returns the granted capabilities in canonical order.
    pub fn capabilities(&self) -> impl Iterator<Item = &CapabilityName> {
        self.capabilities.iter()
    }

    /// Derives a narrower scope from this one.
    ///
    /// # Errors
    ///
    /// Returns [`ScopeExpansion`] when `requested` contains any capability this scope
    /// does not hold. A delegate never receives authority its source lacks.
    pub fn narrow(&self, requested: &Self) -> Result<Self, ScopeExpansion> {
        let excess: BTreeSet<CapabilityName> = requested
            .capabilities
            .difference(&self.capabilities)
            .cloned()
            .collect();
        if excess.is_empty() {
            Ok(requested.clone())
        } else {
            Err(ScopeExpansion { excess })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DelegationScope;
    use aiai_contracts::CapabilityName;

    fn capability(name: &str) -> CapabilityName {
        name.parse().expect("canonical capability name")
    }

    fn scope(names: &[&str]) -> DelegationScope {
        DelegationScope::new(names.iter().copied().map(capability))
    }

    #[test]
    fn permits_only_granted_capabilities() {
        let granted = scope(&["message", "guide"]);
        assert!(granted.permits(&capability("message")));
        assert!(!granted.permits(&capability("deliver_asset")));
    }

    #[test]
    fn narrows_to_a_subset() {
        let narrowed = scope(&["message", "guide"])
            .narrow(&scope(&["message"]))
            .expect("a subset is a valid delegation");
        assert_eq!(narrowed, scope(&["message"]));
    }

    #[test]
    fn refuses_to_widen() {
        let expansion = scope(&["message"])
            .narrow(&scope(&["message", "deliver_asset"]))
            .expect_err("delegation must not widen");
        assert_eq!(
            expansion.excess.into_iter().collect::<Vec<_>>(),
            vec![capability("deliver_asset")]
        );
    }

    #[test]
    fn repeated_narrowing_never_recovers_lost_authority() {
        let root = scope(&["message", "guide", "deliver_asset"]);
        let once = root.narrow(&scope(&["message", "guide"])).expect("subset");
        let twice = once.narrow(&scope(&["message"])).expect("subset");
        assert!(twice.narrow(&scope(&["guide"])).is_err());
    }

    #[test]
    fn an_empty_scope_permits_nothing() {
        let empty = DelegationScope::empty();
        assert!(empty.is_empty());
        assert!(!empty.permits(&capability("message")));
    }
}
