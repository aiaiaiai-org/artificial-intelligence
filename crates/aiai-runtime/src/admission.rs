// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use aiai_contracts::AdmissionEnvelope;

/// A proposal an authority port admitted.
///
/// The inner envelope cannot be constructed outside this crate, and the only crate-internal
/// constructor runs after [`Authority::decide`](crate::Authority::decide) returns
/// [`AuthorityDecision::Admit`](crate::AuthorityDecision) and the granted capability is
/// checked against the session's delegation scope. A caller therefore cannot fabricate an
/// admitted action from a proposal, however convincing the proposal is.
///
/// The value is deliberately not [`Clone`]: one admission dispatches at most once.
///
/// Admission remains permission to attempt. It is not evidence that the action executed,
/// that a counterpart observed it, or that anything was completed.
#[derive(Debug, PartialEq, Eq)]
pub struct Admitted<A> {
    envelope: AdmissionEnvelope<A>,
}

impl<A> Admitted<A> {
    pub(crate) const fn new(envelope: AdmissionEnvelope<A>) -> Self {
        Self { envelope }
    }

    /// Returns the admitted action envelope.
    #[must_use]
    pub const fn envelope(&self) -> &AdmissionEnvelope<A> {
        &self.envelope
    }

    /// Consumes the admission and returns its envelope.
    #[must_use]
    pub fn into_envelope(self) -> AdmissionEnvelope<A> {
        self.envelope
    }
}
