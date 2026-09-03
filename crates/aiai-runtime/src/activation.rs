// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use core::fmt;
use serde::{Deserialize, Serialize};

/// Whether the runtime for a subject is currently permitted to compute.
///
/// Existence is durable; computation is not. A subject continues to exist while its
/// runtime is [`Dormant`](ActivationState::Dormant) — it simply produces nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationState {
    /// No computation. The runtime initiates nothing and finishes nothing.
    Dormant,
    /// Computation permitted. The runtime may initiate new work.
    Active,
    /// In-flight work may reach a safe boundary; no new work may be initiated.
    Quiescing,
}

impl ActivationState {
    /// Returns whether the runtime may start new work.
    #[must_use]
    pub const fn may_initiate(self) -> bool {
        matches!(self, Self::Active)
    }

    /// Returns whether the runtime may finish work it already started.
    #[must_use]
    pub const fn may_settle_in_flight(self) -> bool {
        matches!(self, Self::Active | Self::Quiescing)
    }

    /// Applies an activation transition.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidTransition`] for any pair this state machine does not define.
    /// In particular a quiescing runtime cannot be woken back into activity: it must
    /// settle first, so that leaving activity never silently resumes mid-flight work.
    pub const fn apply(self, transition: ActivationTransition) -> Result<Self, InvalidTransition> {
        match (self, transition) {
            (Self::Dormant, ActivationTransition::Wake) => Ok(Self::Active),
            (Self::Active, ActivationTransition::Quiesce) => Ok(Self::Quiescing),
            (Self::Quiescing, ActivationTransition::Settle) => Ok(Self::Dormant),
            (state, transition) => Err(InvalidTransition { state, transition }),
        }
    }

    /// Returns the single transition that reaches `target` from this state.
    ///
    /// Returns `Ok(None)` when this state already is `target`, which makes a product's
    /// "set the runtime to this mode" operation idempotent: applying the same mode twice
    /// is a no-op rather than an undefined transition.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidTransition`] when no single defined transition reaches `target`.
    /// Reaching activity from [`Quiescing`](Self::Quiescing) is deliberately not resolved
    /// here: it would require settling first, and settling is the owner's assertion that
    /// in-flight work reached its boundary. The state machine will not make that assertion
    /// on the owner's behalf, so a product that wants it must say so with two explicit
    /// steps.
    pub const fn transition_to(
        self,
        target: Self,
    ) -> Result<Option<ActivationTransition>, InvalidTransition> {
        match (self, target) {
            (Self::Dormant, Self::Dormant)
            | (Self::Active, Self::Active)
            | (Self::Quiescing, Self::Quiescing) => Ok(None),
            (Self::Dormant, Self::Active) => Ok(Some(ActivationTransition::Wake)),
            (Self::Active, Self::Quiescing) => Ok(Some(ActivationTransition::Quiesce)),
            (Self::Quiescing, Self::Dormant) => Ok(Some(ActivationTransition::Settle)),
            (Self::Quiescing, Self::Active) => Err(InvalidTransition {
                state: self,
                transition: ActivationTransition::Wake,
            }),
            (Self::Dormant, Self::Quiescing) => Err(InvalidTransition {
                state: self,
                transition: ActivationTransition::Quiesce,
            }),
            (Self::Active, Self::Dormant) => Err(InvalidTransition {
                state: self,
                transition: ActivationTransition::Settle,
            }),
        }
    }
}

/// Transition requested by whatever owns the runtime's activation policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationTransition {
    /// Begin computing for this subject.
    Wake,
    /// Stop initiating new work and let in-flight work reach a safe boundary.
    Quiesce,
    /// In-flight work has reached its boundary; stop computing.
    Settle,
}

/// An activation transition this state machine does not define.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidTransition {
    pub state: ActivationState,
    pub transition: ActivationTransition,
}

impl fmt::Display for InvalidTransition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "activation transition {:?} is not defined from {:?}",
            self.transition, self.state
        )
    }
}

impl std::error::Error for InvalidTransition {}

#[cfg(test)]
mod tests {
    use super::{ActivationState, ActivationTransition};

    #[test]
    fn walks_the_full_activation_cycle() {
        let state = ActivationState::Dormant
            .apply(ActivationTransition::Wake)
            .expect("dormant runtimes wake");
        assert_eq!(state, ActivationState::Active);
        let state = state
            .apply(ActivationTransition::Quiesce)
            .expect("active runtimes quiesce");
        assert_eq!(state, ActivationState::Quiescing);
        let state = state
            .apply(ActivationTransition::Settle)
            .expect("quiescing runtimes settle");
        assert_eq!(state, ActivationState::Dormant);
    }

    #[test]
    fn quiescing_cannot_be_woken_without_settling() {
        assert!(
            ActivationState::Quiescing
                .apply(ActivationTransition::Wake)
                .is_err()
        );
    }

    #[test]
    fn dormant_runtimes_neither_initiate_nor_settle() {
        assert!(!ActivationState::Dormant.may_initiate());
        assert!(!ActivationState::Dormant.may_settle_in_flight());
    }

    #[test]
    fn resolving_the_current_state_is_a_no_op() {
        for state in [
            ActivationState::Dormant,
            ActivationState::Active,
            ActivationState::Quiescing,
        ] {
            assert_eq!(state.transition_to(state), Ok(None));
        }
    }

    #[test]
    fn resolves_each_single_step_target() {
        assert_eq!(
            ActivationState::Dormant.transition_to(ActivationState::Active),
            Ok(Some(ActivationTransition::Wake))
        );
        assert_eq!(
            ActivationState::Active.transition_to(ActivationState::Quiescing),
            Ok(Some(ActivationTransition::Quiesce))
        );
        assert_eq!(
            ActivationState::Quiescing.transition_to(ActivationState::Dormant),
            Ok(Some(ActivationTransition::Settle))
        );
    }

    #[test]
    fn refuses_to_assert_an_intermediate_step_on_the_owners_behalf() {
        assert!(
            ActivationState::Quiescing
                .transition_to(ActivationState::Active)
                .is_err()
        );
        assert!(
            ActivationState::Active
                .transition_to(ActivationState::Dormant)
                .is_err()
        );
        assert!(
            ActivationState::Dormant
                .transition_to(ActivationState::Quiescing)
                .is_err()
        );
    }

    #[test]
    fn quiescing_settles_in_flight_work_but_starts_none() {
        assert!(!ActivationState::Quiescing.may_initiate());
        assert!(ActivationState::Quiescing.may_settle_in_flight());
    }
}
