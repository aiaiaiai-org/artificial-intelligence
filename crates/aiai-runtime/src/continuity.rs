// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

use aiai_contracts::{ControllerId, ModelId, RuntimeId, SubjectId};

/// What changed between two bindings of the same subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ContinuityChange {
    pub controller: bool,
    pub runtime: bool,
    pub model: bool,
}

impl ContinuityChange {
    /// Returns whether any replaceable component changed.
    #[must_use]
    pub const fn any(self) -> bool {
        self.controller || self.runtime || self.model
    }
}

/// Exact relationship between two bindings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuityRelation {
    /// Same subject and the same replaceable components.
    Identical,
    /// Same subject with at least one replaceable component swapped.
    Continuous(ContinuityChange),
    /// Different subjects. This is never continuity of one participant.
    DistinctSubject,
}

/// Binding of a durable subject to the replaceable components currently serving it.
///
/// The separation this type enforces is:
///
/// ```text
/// subject != controller != runtime != model
/// ```
///
/// The subject is fixed at construction and no method changes it. A controller, runtime,
/// or model may be replaced any number of times without producing a different subject,
/// and two bindings that name different subjects are never reported as continuous.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubjectBinding {
    subject: SubjectId,
    controller: ControllerId,
    runtime: RuntimeId,
    model: Option<ModelId>,
}

impl SubjectBinding {
    /// Binds a subject to the components currently serving it.
    #[must_use]
    pub const fn new(
        subject_id: SubjectId,
        controller_id: ControllerId,
        runtime_id: RuntimeId,
        model_id: Option<ModelId>,
    ) -> Self {
        Self {
            subject: subject_id,
            controller: controller_id,
            runtime: runtime_id,
            model: model_id,
        }
    }

    /// Returns the durable subject this binding serves.
    #[must_use]
    pub const fn subject_id(&self) -> &SubjectId {
        &self.subject
    }

    /// Returns the controller currently operating the subject.
    #[must_use]
    pub const fn controller_id(&self) -> &ControllerId {
        &self.controller
    }

    /// Returns the runtime currently hosting computation for the subject.
    #[must_use]
    pub const fn runtime_id(&self) -> &RuntimeId {
        &self.runtime
    }

    /// Returns the model currently assisting the subject, when one is assigned.
    #[must_use]
    pub const fn model_id(&self) -> Option<&ModelId> {
        self.model.as_ref()
    }

    /// Replaces the computation serving this subject while preserving the subject.
    ///
    /// There is deliberately no counterpart that replaces the subject: a runtime,
    /// controller, or model swap cannot mint a different participant.
    #[must_use]
    pub fn rebind(
        &self,
        controller_id: ControllerId,
        runtime_id: RuntimeId,
        model_id: Option<ModelId>,
    ) -> Self {
        Self {
            subject: self.subject.clone(),
            controller: controller_id,
            runtime: runtime_id,
            model: model_id,
        }
    }

    /// Classifies this binding against `other`.
    #[must_use]
    pub fn classify(&self, other: &Self) -> ContinuityRelation {
        if self.subject != other.subject {
            return ContinuityRelation::DistinctSubject;
        }
        let change = ContinuityChange {
            controller: self.controller != other.controller,
            runtime: self.runtime != other.runtime,
            model: self.model != other.model,
        };
        if change.any() {
            ContinuityRelation::Continuous(change)
        } else {
            ContinuityRelation::Identical
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ContinuityChange, ContinuityRelation, SubjectBinding};
    use aiai_contracts::{ControllerId, ModelId, RuntimeId, SubjectId};

    fn subject(seed: char) -> SubjectId {
        format!("sub_{}", String::from(seed).repeat(64))
            .parse()
            .expect("canonical subject id")
    }

    fn controller(seed: char) -> ControllerId {
        format!("ctl_{}", String::from(seed).repeat(32))
            .parse()
            .expect("canonical controller id")
    }

    fn runtime(seed: char) -> RuntimeId {
        format!("rt_{}", String::from(seed).repeat(32))
            .parse()
            .expect("canonical runtime id")
    }

    fn model(seed: char) -> ModelId {
        format!("mdl_{}", String::from(seed).repeat(32))
            .parse()
            .expect("canonical model id")
    }

    fn binding() -> SubjectBinding {
        SubjectBinding::new(
            subject('a'),
            controller('b'),
            runtime('c'),
            Some(model('d')),
        )
    }

    #[test]
    fn replacing_every_component_preserves_the_subject() {
        let original = binding();
        let replaced = original.rebind(controller('e'), runtime('f'), Some(model('0')));
        assert_eq!(replaced.subject_id(), original.subject_id());
        assert_eq!(
            original.classify(&replaced),
            ContinuityRelation::Continuous(ContinuityChange {
                controller: true,
                runtime: true,
                model: true,
            })
        );
    }

    #[test]
    fn losing_a_model_is_still_the_same_subject() {
        let original = binding();
        let degraded = original.rebind(controller('b'), runtime('c'), None);
        assert_eq!(
            original.classify(&degraded),
            ContinuityRelation::Continuous(ContinuityChange {
                model: true,
                ..ContinuityChange::default()
            })
        );
    }

    #[test]
    fn a_different_subject_is_never_continuous() {
        let original = binding();
        let other = SubjectBinding::new(
            subject('b'),
            controller('b'),
            runtime('c'),
            Some(model('d')),
        );
        assert_eq!(
            original.classify(&other),
            ContinuityRelation::DistinctSubject
        );
    }

    #[test]
    fn an_unchanged_binding_is_identical() {
        assert_eq!(
            binding().classify(&binding()),
            ContinuityRelation::Identical
        );
    }
}
