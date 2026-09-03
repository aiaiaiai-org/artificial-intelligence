# Consuming the foundation

This repository is a library. A product AI runtime — `nilx-one/ai` is the first — depends on
it, implements its ports, and binds its own vocabulary to its shapes. This page is the
contract from the consumer's side.

## One dependency

```toml
[dependencies]
# No release is tagged yet, so pin a revision reachable from master.
aiai-runtime = { git = "https://github.com/aiaiaiai-org/artificial-intelligence.git", rev = "<commit>" }

# From the first tagged release onward:
# aiai-runtime = { git = "https://github.com/aiaiaiai-org/artificial-intelligence.git", tag = "v0.1.0" }
```

`aiai-runtime` re-exports the contract crate, so a product does not add a second dependency
pinned to the same revision:

```rust
use aiai_runtime::prelude::*;            // kernel + the contract types in its signatures
use aiai_runtime::contracts::canonical_json; // the rest of aiai-contracts, when needed
```

Depend on `aiai-contracts` directly only when a crate needs the contract shapes without the
kernel — a transport, a serializer, or a schema tool. `aiai-signal` is a separate concern
and is never required in order to run a session.

### Pinning

Pin a tag once one exists. No release is tagged yet, so pin a `rev` — and pin one reachable
from `master`: a revision that only ever existed on a feature branch is orphaned when that
branch is squash-merged or deleted, and every consumer pinned to it stops resolving. For the
same reason foundation pull requests that consumers already pin are merged, not squashed.

Pinning a branch instead of a tag or revision is not a substitute. A branch moves, so the
build that passed yesterday is not the build that runs today.

`Cargo.lock` is committed. CI runs `--locked`, so the checked-in resolution is the one that
is verified; a consumer resolving this workspace as a git dependency still does its own
resolution and is unaffected by it.

`0.1.0` is a compatibility line, not a stability promise. `aiai_contracts::CONTRACT_VERSION`
is the normative wire version, and `require_compatible_contract` checks a peer's claim
before a payload is decoded.

### Licensing

The foundation is Apache-2.0. A product under a different license — `nilx-one/ai` is
MPL-2.0 — may depend on it; keep the Apache-2.0 attribution and `NOTICE` obligations intact
in whatever the product distributes.

## What the product implements

The kernel reads no wall clock, no ambient randomness, and no ambient configuration.
Everything nondeterministic or external arrives through a port the product supplies:

| Port | The product provides | Returning `Err` means |
|---|---|---|
| `Clock` | the time source of record | no timestamp is substituted |
| `Entropy` | explicit random bytes | no ambient randomness is read |
| `IdentifierGeneration` | canonical `ProposalId`s | no identifier is invented |
| `Inference` | computation, local or remote | no empty or invented success |
| `Authority` | the boundary that permits an attempt | unavailable is never approval |

Two generic parameters carry the product's meaning through the foundation without the
foundation learning it: `Inference::Request` and `Inference::Proposal`. Wake reasons are
generic on `WakeEnvelope<R>` in the same way.

## One turn

```rust
use aiai_runtime::prelude::*;

// 1. Mode. A product mode names a state, so target the state; re-applying is a no-op.
session.ensure_activation(None, ActivationState::Active)?;

// 2. Wake. Records the external occurrence that started the turn.
let wake = session.wake(operation_id.clone(), reason, &clock)?;

// 3. Propose. Returns identifiers; the session keeps the canonical envelopes.
let proposal_ids = session.propose(operation_id.clone(), &request, &mut inference, &mut ids)?;

// 4. Render what the session owns — never rebuild a proposal in order to submit it.
for proposal_id in &proposal_ids {
    let envelope = session.pending_proposal(proposal_id).expect("session-owned");
    show(&envelope.proposal);
}

// 5. Admit. Takes an identifier. The authority decides the session's own proposal.
let admitted = session.admit(operation_id.clone(), &proposal_ids[0], &authority)?;

// 6. Dispatch. Consumes the admission, so it happens at most once.
let effect = session.dispatch(operation_id, admitted)?;
```

`crates/aiai-runtime/tests/product_binding.rs` is this whole turn as an executable test,
written against the prelude alone.

### Computation that cannot be a synchronous port

`Inference` is synchronous. A model reached across an async or foreign-language boundary — a
browser worker, a separate process, a remote service — cannot satisfy it without blocking, so
the product runs that computation on its own side and hands the result in:

```rust
// The product awaited its own model, wherever it runs.
let text = local_adapter.generate(&history).await?;

let proposal_ids = session.propose_candidates(
    operation_id,
    vec![Candidate {
        requested_capability: "message".parse()?,
        proposal: ProductProposal::Reply { text },
    }],
    &mut identifiers,
)?;
```

This grants the caller nothing the port does not. A candidate is pre-proposal input on both
paths: the session mints the `proposal_id`, `sequence`, `operation_id`, and
`contract_version`, owns the resulting envelopes, and still requires an `Authority` decision
before any of them becomes an action. `Candidate` carries a capability name and a payload and
has no field through which ordering or provenance could be supplied.

One thing does move to the caller. There is no port here to return `PortError`, so **an
unreachable model is the product's own explicit outcome to report** — never an empty batch
passed off as a successful turn. The foundation cannot make that distinction for computation
it did not run.

### Failure semantics a product can rely on

- `propose` and `propose_candidates` returning `Err` mutated nothing: no pending proposal, no
  sequence advance, no revision advance. There is no partial batch to reconcile and no
  hidden proposal.
- A dormant session refuses before it reaches the inference port, so computation does not
  run for a runtime that may not initiate work.
- `admit` releases the pending proposal only on a terminal decision. An unavailable
  authority port leaves it pending, so the product may seek the same decision again.
- An identifier the session does not hold is `UnknownProposal`, and the authority port is
  not consulted about it.
- `ensure_activation` refuses `Quiescing -> Active`. Settling asserts that in-flight work
  reached its boundary; the product makes that assertion explicitly or not at all.

## Sessions between activations

A session is a live value, not a database row. The product decides where one lives between
activations; the foundation supplies the shape it stores.

```rust
// Going quiet: keep the durable half.
let snapshot = session.snapshot();               // or into_snapshot() for a payload
store.put(session_id, serde_json::to_vec(&snapshot)?)?;  // that cannot be cloned

// Coming back, possibly in another process, on another host, behind other ports.
let snapshot: SessionSnapshot<ProductProposal> = serde_json::from_slice(&bytes)?;
let mut session = RuntimeSession::restore(snapshot)?;
```

`SessionSnapshot` is `Serialize` and `Deserialize`, so any serde format works; the payload
type `P` must be too. Restoring refuses a snapshot from an incompatible contract line, one
repeating a proposal identifier, and one whose counter sits below a proposal it already
emitted.

Three things do not travel:

- **An `Admitted` value in flight.** It is permission the caller was holding, not session
  state. A restart is evidence neither that the attempt happened nor that it did not, so
  seek the decision again — never treat a lost admission as a completed action.
- **The ports.** A clock, identifier source, computation, and authority are supplied per
  call. A restored session may be served by entirely different ones.
- **Any guarantee about the bytes.** Storage is your trust boundary. Restoring does not
  verify that a snapshot is one this session wrote, and a product able to rewrite its own
  snapshots can seat pending proposals of its choosing — exactly as it could by calling
  `propose` with computation of its choosing. Neither reaches the authority boundary.

## What the product owns, and must not delegate here

- **Completion.** The foundation has no completion concept. `dispatch` is an attempt.
  Whether anything was delivered, observed, accepted, or recorded belongs to the product's
  own contracts, and no foundation value may be read as evidence of it.
- **Participants, relationships, interactions, records.** None of these types exist here.
  Product identity semantics stay in the product.
- **The meaning of a capability.** `DelegationScope` bounds capability *names*. What a name
  permits in the world is the product's decision.
- **What computation may run.** The activation state machine gates when a runtime may
  compute. Which model, where it runs, and who paid for it are product concerns.

Text a model produced is computation. It becomes an attempt only by passing through
`Authority`, and a browser-local adapter such as `@aiaiaiai/webllm` changes nothing about
that: it returns text, the product wraps it as a proposal payload, and
`propose_candidates` is where that payload enters a session.

## Related

- [Foundation architecture](architecture.md)
- [Integrating a product AI runtime](nilx-one-ai-integration.md)
- [Browser-local inference](browser-local-inference.md)
