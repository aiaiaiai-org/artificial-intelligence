# Consuming the foundation

This repository is a library. A product AI runtime — `nilx-one/ai` is the first — depends on
it, implements its ports, and binds its own vocabulary to its shapes. This page is the
contract from the consumer's side.

## One dependency

```toml
[dependencies]
aiai-runtime = { git = "https://github.com/aiaiaiai-org/artificial-intelligence.git", tag = "v0.1.0" }
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

Pin a tag. While the foundation is pre-`1.0`, a `rev` is acceptable, but pin one reachable
from `master`: a revision that only ever existed on a feature branch is orphaned when that
branch is squash-merged or deleted, and every consumer pinned to it stops resolving. For the
same reason foundation pull requests that consumers already pin are merged, not squashed.

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

### Failure semantics a product can rely on

- `propose` returning `Err` mutated nothing: no pending proposal, no sequence advance, no
  revision advance. There is no partial batch to reconcile and no hidden proposal.
- `admit` releases the pending proposal only on a terminal decision. An unavailable
  authority port leaves it pending, so the product may seek the same decision again.
- An identifier the session does not hold is `UnknownProposal`, and the authority port is
  not consulted about it.
- `ensure_activation` refuses `Quiescing -> Active`. Settling asserts that in-flight work
  reached its boundary; the product makes that assertion explicitly or not at all.

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
that: it returns text, and the product wraps it as a proposal payload.

## Related

- [Foundation architecture](architecture.md)
- [Integrating a product AI runtime](nilx-one-ai-integration.md)
- [Browser-local inference](browser-local-inference.md)
