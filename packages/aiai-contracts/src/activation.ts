// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the runtime for a subject is currently permitted to compute.
 *
 * Existence is durable; computation is not. A subject continues to exist while its runtime
 * is `dormant` — it simply produces nothing.
 */
export const ACTIVATION_STATES = ["dormant", "active", "quiescing"] as const;

export type ActivationState = (typeof ACTIVATION_STATES)[number];

/** Transition requested by whatever owns the runtime's activation policy. */
export const ACTIVATION_TRANSITIONS = ["wake", "quiesce", "settle"] as const;

export type ActivationTransition = (typeof ACTIVATION_TRANSITIONS)[number];

/** An activation transition the state machine does not define. */
export class ActivationRefused extends Error {
  public constructor(
    public readonly state: ActivationState,
    public readonly transition: ActivationTransition,
  ) {
    super(`activation transition ${transition} is not defined from ${state}`);
    this.name = "ActivationRefused";
  }
}

/** Returns whether the runtime may start new work. */
export function mayInitiate(state: ActivationState): boolean {
  return state === "active";
}

/** Returns whether the runtime may finish work it already started. */
export function maySettleInFlight(state: ActivationState): boolean {
  return state === "active" || state === "quiescing";
}

/**
 * Applies an activation transition.
 *
 * @throws {ActivationRefused} for any pair the state machine does not define. In particular
 * a quiescing runtime cannot be woken back into activity: it settles first, so that leaving
 * activity never silently resumes mid-flight work.
 */
export function applyActivation(
  state: ActivationState,
  transition: ActivationTransition,
): ActivationState {
  if (state === "dormant" && transition === "wake") {
    return "active";
  }
  if (state === "active" && transition === "quiesce") {
    return "quiescing";
  }
  if (state === "quiescing" && transition === "settle") {
    return "dormant";
  }
  throw new ActivationRefused(state, transition);
}

/**
 * Returns the single transition that reaches `target`, or `undefined` when the runtime is
 * already there.
 *
 * A product mode names a state, not an edge, so a host renders and requests modes and lets
 * this resolve the step. Re-applying the current mode is then a no-op rather than an
 * undefined transition — which is what a client reconnect does on every reconnect.
 *
 * @throws {ActivationRefused} when no single defined transition reaches `target`. Reaching
 * activity from `quiescing` is deliberately not resolved: it would require settling first,
 * and settling is the owner's assertion that in-flight work reached its boundary. The state
 * machine will not make that assertion on the owner's behalf.
 */
export function resolveActivation(
  state: ActivationState,
  target: ActivationState,
): ActivationTransition | undefined {
  if (state === target) {
    return undefined;
  }
  if (state === "dormant" && target === "active") {
    return "wake";
  }
  if (state === "active" && target === "quiescing") {
    return "quiesce";
  }
  if (state === "quiescing" && target === "dormant") {
    return "settle";
  }
  if (state === "quiescing") {
    throw new ActivationRefused(state, "wake");
  }
  throw new ActivationRefused(state, state === "dormant" ? "quiesce" : "settle");
}
