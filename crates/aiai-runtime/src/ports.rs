// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use aiai_contracts::{CapabilityName, DecimalU64, ProposalEnvelope, ProposalId};

/// Explicit nondeterministic or external boundary the kernel refuses to read implicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortKind {
    Clock,
    Entropy,
    IdentifierGeneration,
    Inference,
    Authority,
}

/// Observable absence or failure of an external port.
///
/// A port failure is always reported. It never degrades into a fabricated timestamp,
/// identifier, proposal, or authority decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortError {
    pub port: PortKind,
}

/// Supplies time; the kernel never reads a wall clock directly.
pub trait Clock {
    /// Returns an explicit millisecond value.
    ///
    /// # Errors
    ///
    /// Returns [`PortError`] when the caller did not supply clock context.
    fn now_unix_ms(&self) -> Result<DecimalU64, PortError>;
}

/// Supplies explicit entropy; the kernel never reads ambient randomness directly.
pub trait Entropy {
    /// Returns exactly the requested explicit entropy bytes.
    ///
    /// # Errors
    ///
    /// Returns [`PortError`] when entropy is unavailable at the boundary.
    fn bytes(&mut self, length: usize) -> Result<Vec<u8>, PortError>;
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
