// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use aiai_contracts::{CapabilityName, ContextPort, DecimalU64, ProposalEnvelope, ProposalId};
use core::fmt;

/// Explicit nondeterministic or external boundary the kernel refuses to read implicitly.
///
/// Every variant names a port some method of [`RuntimeSession`](crate::RuntimeSession)
/// takes as a parameter. A boundary the kernel never actually reads does not belong here:
/// a port a product can implement but never hand to anything is a claim about the kernel
/// that the kernel does not keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortKind {
    Clock,
    IdentifierGeneration,
    Inference,
    Authority,
}

impl PortKind {
    /// Returns the contract-level name of this port.
    #[must_use]
    pub const fn context_port(self) -> ContextPort {
        match self {
            Self::Clock => ContextPort::Clock,
            Self::IdentifierGeneration => ContextPort::IdentifierGeneration,
            Self::Inference => ContextPort::Inference,
            Self::Authority => ContextPort::Authority,
        }
    }
}

impl fmt::Display for PortKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.context_port().as_str())
    }
}

/// Observable absence or failure of an external port.
///
/// A port failure is always reported. It never degrades into a fabricated timestamp,
/// identifier, proposal, or authority decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortError {
    pub port: PortKind,
}

impl PortError {
    /// Reports that `port` could not answer.
    #[must_use]
    pub const fn new(port: PortKind) -> Self {
        Self { port }
    }
}

impl fmt::Display for PortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "the {} port is unavailable", self.port)
    }
}

impl std::error::Error for PortError {}

/// Supplies time; the kernel never reads a wall clock directly.
pub trait Clock {
    /// Returns an explicit millisecond value.
    ///
    /// # Errors
    ///
    /// Returns [`PortError`] when the caller did not supply clock context.
    fn now_unix_ms(&self) -> Result<DecimalU64, PortError>;
}

/// Supplies canonical proposal identifiers without granting authority.
pub trait IdentifierGeneration {
    /// Returns the next canonical proposal identifier.
    ///
    /// # Errors
    ///
    /// Returns [`PortError`] when identifier generation context is unavailable.
    fn next_proposal_id(&mut self) -> Result<ProposalId, PortError>;
}

/// One candidate action produced by inference, before any authority decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate<P> {
    /// The capability the candidate would need in order to be attempted.
    pub requested_capability: CapabilityName,
    /// The product-defined payload describing what is being proposed.
    pub proposal: P,
}

/// Replaceable computation that turns a request into candidate actions.
///
/// Whether inference is local, remote, shared, dedicated, large, or small is a runtime
/// concern. Its output is always a candidate — never a decision and never an effect.
pub trait Inference {
    /// The product-defined request the runtime hands to computation.
    type Request;
    /// The product-defined proposal payload computation returns.
    type Proposal;

    /// Produces candidate actions for one request.
    ///
    /// # Errors
    ///
    /// Returns [`PortError`] when computation is unavailable. Callers surface that as an
    /// explicit degraded outcome rather than an empty or invented result.
    fn propose(
        &mut self,
        request: &Self::Request,
    ) -> Result<Vec<Candidate<Self::Proposal>>, PortError>;
}

/// The decision an authority port reached about one proposal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorityDecision {
    /// The proposal may be attempted under exactly this capability.
    Admit { granted_capability: CapabilityName },
    /// The proposal must not be attempted.
    Withhold,
}

/// The boundary that decides whether a proposal may be attempted at all.
///
/// This is the only source of admission in the foundation. Model output, transport
/// success, credential possession, and elapsed time do not reach this trait's answer.
pub trait Authority {
    /// The product-defined proposal payload this authority evaluates.
    type Proposal;

    /// Decides one proposal.
    ///
    /// # Errors
    ///
    /// Returns [`PortError`] when the authority context is unavailable. An unavailable
    /// authority is never treated as approval.
    fn decide(
        &self,
        proposal: &ProposalEnvelope<Self::Proposal>,
    ) -> Result<AuthorityDecision, PortError>;
}

#[cfg(test)]
mod tests {
    use super::{PortError, PortKind};
    use aiai_contracts::ContextPort;

    #[test]
    fn every_port_names_its_contract_level_port() {
        assert_eq!(PortKind::Clock.context_port(), ContextPort::Clock);
        assert_eq!(
            PortKind::IdentifierGeneration.context_port(),
            ContextPort::IdentifierGeneration
        );
        assert_eq!(PortKind::Inference.context_port(), ContextPort::Inference);
        assert_eq!(PortKind::Authority.context_port(), ContextPort::Authority);
    }

    #[test]
    fn a_port_failure_is_an_error_value_a_product_can_carry() {
        let failure = PortError::new(PortKind::Inference);
        assert_eq!(failure.to_string(), "the inference port is unavailable");

        // It composes with whatever error handling the product already has.
        let boxed: Box<dyn std::error::Error> = Box::new(failure);
        assert_eq!(boxed.to_string(), "the inference port is unavailable");
    }
}
