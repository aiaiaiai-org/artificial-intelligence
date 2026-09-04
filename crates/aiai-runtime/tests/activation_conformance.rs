// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

//! The kernel's half of the shared wire corpus.
//!
//! A host renders the activation state it was told and asks for the mode a person chose, so
//! the gate is part of the surface that crosses the boundary. `fixtures/` carries the table
//! once and both implementations answer against it — `crates/aiai-contracts/tests/` covers
//! the rest of the corpus, and `packages/aiai-contracts/tests/` is the host side of both.

use aiai_runtime::{ActivationState, ActivationTransition};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../fixtures/contract-wire-0.2.0.json");

fn corpus() -> Value {
    serde_json::from_str(FIXTURE).expect("the corpus is JSON")
}

fn entries<'a>(root: &'a Value, name: &str) -> &'a [Value] {
    root.get("activation")
        .and_then(|activation| activation.get(name))
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("the corpus carries activation.{name}"))
        .as_slice()
}

fn member<'a>(entry: &'a Value, name: &str) -> &'a str {
    entry
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("the entry carries a {name} string"))
}

/// Every state, spelled once. A new one stops this file compiling until the corpus and the
/// host-side mirror carry it too.
fn state_token(state: ActivationState) -> &'static str {
    match state {
        ActivationState::Dormant => "dormant",
        ActivationState::Active => "active",
        ActivationState::Quiescing => "quiescing",
    }
}

/// Every transition, spelled once, for the same reason.
fn transition_token(transition: ActivationTransition) -> &'static str {
    match transition {
        ActivationTransition::Wake => "wake",
        ActivationTransition::Quiesce => "quiesce",
        ActivationTransition::Settle => "settle",
    }
}

const STATES: [ActivationState; 3] = [
    ActivationState::Dormant,
    ActivationState::Active,
    ActivationState::Quiescing,
];

const TRANSITIONS: [ActivationTransition; 3] = [
    ActivationTransition::Wake,
    ActivationTransition::Quiesce,
    ActivationTransition::Settle,
];

fn state(token: &str) -> ActivationState {
    *STATES
        .iter()
        .find(|candidate| state_token(**candidate) == token)
        .unwrap_or_else(|| panic!("the corpus names an unknown state: {token}"))
}

fn transition(token: &str) -> ActivationTransition {
    *TRANSITIONS
        .iter()
        .find(|candidate| transition_token(**candidate) == token)
        .unwrap_or_else(|| panic!("the corpus names an unknown transition: {token}"))
}

#[test]
fn the_gate_vocabulary_is_spelled_the_same_on_both_sides() {
    let root = corpus();
    let states: Vec<&str> = entries(&root, "states")
        .iter()
        .map(|value| value.as_str().expect("a state token"))
        .collect();
    assert_eq!(states, STATES.map(state_token));
    for token in &states {
        // The corpus spelling is also the serde spelling, so a log line and a payload cannot
        // disagree about the state a runtime is in.
        let decoded: ActivationState =
            serde_json::from_value(Value::String((*token).to_owned())).expect("a wire state");
        assert_eq!(state_token(decoded), *token);
    }

    let transitions: Vec<&str> = entries(&root, "transitions")
        .iter()
        .map(|value| value.as_str().expect("a transition token"))
        .collect();
    assert_eq!(transitions, TRANSITIONS.map(transition_token));
}

#[test]
fn the_gate_permits_exactly_what_the_corpus_says() {
    let root = corpus();
    let initiating: Vec<&str> = entries(&root, "may_initiate")
        .iter()
        .map(|value| value.as_str().expect("a state token"))
        .collect();
    let settling: Vec<&str> = entries(&root, "may_settle_in_flight")
        .iter()
        .map(|value| value.as_str().expect("a state token"))
        .collect();
    for candidate in STATES {
        let token = state_token(candidate);
        assert_eq!(
            candidate.may_initiate(),
            initiating.contains(&token),
            "{token}"
        );
        assert_eq!(
            candidate.may_settle_in_flight(),
            settling.contains(&token),
            "{token}"
        );
    }
}

#[test]
fn every_transition_resolves_as_the_corpus_says() {
    let root = corpus();
    for entry in entries(&root, "apply") {
        let from = state(member(entry, "state"));
        let step = transition(member(entry, "transition"));
        let expected = entry.get("result").expect("the entry carries a result");
        match from.apply(step) {
            Ok(reached) => assert_eq!(
                Some(state_token(reached)),
                expected.as_str(),
                "{from:?} + {step:?}"
            ),
            Err(_) => assert!(expected.is_null(), "{from:?} + {step:?} must be defined"),
        }
    }
}

#[test]
fn every_target_resolves_as_the_corpus_says() {
    let root = corpus();
    for entry in entries(&root, "resolve") {
        let from = state(member(entry, "state"));
        let target = state(member(entry, "target"));
        let outcome = member(entry, "outcome");
        match from.transition_to(target) {
            Ok(None) => assert_eq!(outcome, "settled", "{from:?} -> {target:?}"),
            Ok(Some(step)) => {
                assert_eq!(outcome, "step", "{from:?} -> {target:?}");
                assert_eq!(transition_token(step), member(entry, "transition"));
            }
            Err(_) => assert_eq!(outcome, "refused", "{from:?} -> {target:?}"),
        }
    }
}
