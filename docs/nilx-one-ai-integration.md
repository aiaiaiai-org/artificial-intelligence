# Integrating a Product AI Runtime

This document works through the first consumer of the foundation, `nilx-one/ai`, and uses it
to state the general rule: what belongs here, what belongs in a product repository, and how
the two compose. Nothing in this document is normative for the 0x1 protocol — the canonical
specification is `nilx-one/0x1`, and where this document and that specification disagree,
the specification governs.

## The nil-one repositories

The `nilx-one` organization is layered by authority, and each layer already refuses to do
the layer above it:

| Repository | Owns | License |
|---|---|---|
| `nilx-one/0x1` | The protocol specification. Ten Protocol Laws, the BondChain interaction model, identity, AI Bonds. No implementation. | — |
| `nilx-one/core` | Deterministic shared product behavior in Rust: binding-safe contracts, a transition kernel with explicit ports, WASM and UniFFI bindings. | MPL-2.0 |
| `nilx-one/web` | The Web client family: one shared product app, thin host adapters for browser and messenger hosts, bounded server-side services. Consumes `core`. | MPL-2.0 |
| `nilx-one/ai` | The product-specific AI runtime for 0x1. | MPL-2.0 |

The pattern is consistent: `0x1` says what is true, `core` makes deterministic behavior
portable, `web` presents it, and each layer treats the one above it as authoritative. `ai`
is the layer that had no implementation yet.

## Where the foundation fits

```text
nilx-one/0x1                      protocol truth (specification)
        |
        | derives from
        v
aiaiaiai-org/artificial-intelligence   ← this repository
        |  shapes, ports, refusals; no product vocabulary
        v
nilx-one/ai                       0x1 AI runtime: binds Bond semantics to those shapes
        |
        +-- consumes nilx-one/core for deterministic product behavior
        +-- consumed by nilx-one/web as the AI half of a client
```

`nilx-one/ai` is where 0x1 vocabulary lives. This repository stays product-agnostic so that
a second product — Prism, or anything after it — composes the same crates without inheriting
Bond, BondChain, or spectate semantics it has no use for.

Licensing runs the compatible direction: an Apache-2.0 foundation can be consumed by an
MPL-2.0 product repository.

## The binding, concept by concept

| 0x1 concept | Foundation shape | Who owns the meaning |
|---|---|---|
| AI Bond identity | `SubjectId` inside `SubjectBinding` | `ai` mints and interprets; the foundation only carries it |
| Owner reference of an owned AI avatar | product state in `ai` | `ai` — ownership is not a foundation concept |
| Runtime, model, provider | `RuntimeId`, `ModelId`, `ControllerId` | replaceable by construction |
| `SPECTATE` / `MANUAL` / `OFFLINE` | `ActivationState` + `ActivationTransition` | `ai` maps its modes onto the gate |
| Generated dialogue, a plan, a chosen action | `Candidate` → `ProposalEnvelope` | `ai` defines the payload; it stays a proposal |
| Delegated authority from a human owner | `DelegationScope` + the `Authority` port | `ai` implements the port against 0x1 authority rules |
| An attempted action | `Admitted` → `EffectRequestEnvelope` | dispatch is an attempt, never completion |
| Reciprocal action, BondChain, `bond.chain` | **absent by design** | `0x1` and `core` — never the foundation |
| `route_traversal`, `poi_dwell`, `cell_transit` | archetypes `ai` registers in `SchemaRegistry` | `ai` and its governance process |

The last two rows carry most of the weight.

### BondChain is deliberately absent

The foundation has no completion concept at all. The furthest it goes is
`EffectRequestEnvelope` — a request handed to an external adapter. Whether an action was
executed, whether a counterpart performed the reciprocal action its contract requires, and
whether a BondChain was established are questions `core` and the protocol answer.

This is why `Admitted` stops where it does. A foundation that modeled completion would let a
runtime construct one, and Protocol Law 3 exists precisely because intent is not commitment.

### Spectate maps onto activation

The current 0x1 product constrains an owned AI avatar to living only while its owner is
spectating. That is a product policy, so it lives in `ai`:

A mode names a state, not an edge. Mapping a mode onto a transition works only for the one
edge that leaves the state the runtime happens to be in, so map modes onto states and let
`ensure_activation` resolve the step:

```text
SPECTATE -> ActivationState::Active
MANUAL   -> ActivationState::Quiescing
OFFLINE  -> ActivationState::Dormant
```

```rust
impl AvaiaControlMode {
    const fn activation_state(self) -> ActivationState {
        match self {
            Self::Spectate => ActivationState::Active,
            Self::Manual => ActivationState::Quiescing,
            Self::Offline => ActivationState::Dormant,
        }
    }
}

session.ensure_activation(operation_id, mode.activation_state())?;
```

Re-applying the mode a session is already in is then a no-op rather than an undefined
transition, which matters for a client that renders the current mode on every reconnect.

The foundation supplies what the mapping needs and refuses what it forbids. `Quiescing` may
settle in-flight work but initiates nothing, which is the "in-flight action reaches a safe
boundary" step. `Quiescing -> Active` is refused by `ensure_activation` as well as by
`apply_activation`: reaching it would mean settling first, and settling is the owner's
assertion that in-flight work reached its boundary. So a client reconnect cannot silently
resume a wound-down runtime, and a product that wants `MANUAL -> SPECTATE` says so as two
explicit steps. Going dormant leaves pending proposals pending rather than completing or
cancelling them.

If a future 0x1 revision permits persistent autonomous life, the mapping changes in `ai`.
The gate does not: the foundation never encoded spectate in the first place.

### Proposals stay session-owned

`propose` hands back `ProposalId`s and keeps the canonical envelopes. `ai` renders a pending
proposal through `session.pending_proposal(&id)` and admits it by identifier, so an owner's
decision applies to the proposal the session actually produced. There is no code path in
which a transport round trip, a client re-render, or a replayed payload could substitute
different content behind a legitimate identifier — `admit` accepts no proposal content at
all. See [Consuming the foundation](consuming.md) for the failure semantics `ai` can rely
on.

## What `nilx-one/ai` implements on top

Everything below is product work, out of scope for this repository, and stated here so the
boundary is unambiguous:

1. **Wake reasons and proposal payloads.** The closed `R`, `P`, and `F` types — what
   occurrences are worth waking for, what a proposal says, what an effect requests.
2. **The `Authority` port against 0x1 rules.** The foundation guarantees only that an
   admission is bounded by the session's delegation scope. Which capability a human owner
   actually delegated, whether the delegation is still live, and what revokes it are 0x1
   authority questions.
3. **The `Inference` port.** Provider selection, local versus remote computation, shared
   infrastructure, model fallback. All replaceable; none of it identity.
4. **Persistence and scheduling.** Which subjects exist, when they wake, and where their
   state lives. The foundation supplies the shape — `RuntimeSession::snapshot` and
   `restore`, with `SessionSnapshot` as the stored value — and refuses to seat a snapshot
   that contradicts itself. Where those bytes are kept, how they are authenticated, and
   what schedules a wake are `ai`'s decisions, and storage is `ai`'s trust boundary.
5. **Effect adapters.** Turning an effect request into an actual attempt against `core` and
   the network, and reporting the real outcome rather than an assumed one.
6. **Signal archetypes, if and when they are activated.** Concrete archetypes registered in
   `SchemaRegistry`, with the governance process that reviews joint resolution across
   fields — not only field names.

## First Avaia vertical slice

The foundation now supplies `@aiaiaiai/webllm`, a concrete browser-local inference adapter.
It is enough for the first Avaia slice without moving Avaia semantics into this repository:

1. `nilx-one/web` probes local WebGPU support. Probing never downloads a model.
2. The person explicitly starts the model download/load. The adapter reports supported,
   cached, loading, ready, unavailable, and failed as distinct facts.
3. `nilx-one/ai` supplies the Avaia system prompt and a bounded text history, then receives a
   streamed text result from `Qwen3-0.6B-q4f16_1-MLC`.
4. `ai` wraps that text as its own proposal payload and hands it to
   `RuntimeSession::propose_candidates`. The adapter is asynchronous and the `Inference`
   port is not, so the model runs on the product's side of that boundary and only its
   result crosses — the session still mints the proposal identifier, sequence, operation,
   and contract version, and still owns the envelope.
5. That result is a dialogue proposal. It is not an authorized message and cannot create a
   BondChain record. Any later delivery still passes through the product authority and
   effect boundaries.

   A `failed` or `unavailable` adapter state is `ai`'s own outcome to report. There is no
   inference port on this path to raise it, so an unreachable model must surface as an
   explicit degraded turn rather than as an empty batch.
6. Leaving `SPECTATE` quiesces the product runtime. The browser adapter interrupts an active
   generation and may unload GPU resources; neither operation changes the AI Bond's identity.

For this slice, Avaia can respond locally in the current conversation and expose truthful
runtime state. It has no tools, durable memory, autonomous background life, remote fallback,
or ability to claim that another Bond acted. Those are separate product capabilities with
separate authority and completion contracts.

## Two things `nilx-one/ai` must not do

**Do not model completion in the AI layer.** If `ai` grows a type meaning "this interaction
completed", it has taken ownership of something `0x1` and `core` own, and the foundation's
proposal-admission-dispatch chain stops being load-bearing.

**Do not activate signal collection ahead of its contracts.** `SchemaRegistry` exists and
archetypes can be registered, but the training-signal path stays inert until authorization,
retention, schema governance, corpus provenance, and cross-request privacy budgets are
defined. This repository ships no transport for that reason.

## Verification

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
python3 scripts/check_architecture.py
python scripts/check_repository_policy.py Apache-2.0
npm ci
npm run typecheck:web
npm run test:web
npm run build:web
```

The boundary claims above are the ones under test. `crates/aiai-runtime/tests/` covers the
authority chain, activation gating, continuity under runtime replacement, and explicit
degradation on every port failure. `crates/aiai-signal/tests/` covers the transform, its
idempotence, and a forked client's payloads meeting the validator.

## Related

- [Foundation Architecture](architecture.md)
- [Consuming the foundation](consuming.md) — the dependency, port, and pinning contract
- [Browser-local inference](browser-local-inference.md)
- [`nilx-one/0x1`](https://github.com/nilx-one/0x1) — protocol specification
- [`nilx-one/core`](https://github.com/nilx-one/core) — deterministic shared product behavior
- [`nilx-one/ai`](https://github.com/nilx-one/ai) — the 0x1 AI runtime
