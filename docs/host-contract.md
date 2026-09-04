# The host side of the contract

The foundation's Rust crates enforce the wire contract on the side that produces payloads.
A browser or messenger host consuming a product runtime sits on the other side of that
boundary in another language, and until now it had `JSON.parse` and nothing else.

`@aiaiaiai/contracts` is the other half: a zero-dependency TypeScript package implementing
foundation contract `0.2.0` for the host. It carries no product vocabulary, no transport,
and no session logic. It decodes what the kernel emits, refuses what the kernel would
refuse, and encodes what the kernel would accept.

```text
nilx-one/ai (Rust)                        a host client (TypeScript)
  aiai-runtime / aiai-contracts             @aiaiaiai/contracts
        |                                            |
        |  canonical JSON: decimal-string integers,  |
        +-------- closed vocabularies, envelopes ----+
                            |
              fixtures/contract-wire-0.2.0.json
              one corpus, both sides answer it
```

## Why a host needs it rather than `JSON.parse`

Contract `0.2.0` forbids JSON numeric tokens and carries integers as decimal strings,
precisely so that a JavaScript host cannot narrow one through IEEE-754 rounding. That rule
only holds if the host observes it. `JSON.parse` does the opposite: it turns
`9007199254740993` into `9007199254740992` and reports nothing.

The same is true of every other rule the contract states. A closed error taxonomy is only
closed if the host refuses a code it does not know instead of rendering the string. A closed
envelope is only closed if the host refuses an extra member. An identifier is only
binding-safe if the host declines to repair one.

A host can re-derive all of this. Every host re-deriving it separately is how two
implementations of one contract quietly stop agreeing.

## What the package is

| Module | Mirrors | What the host gets |
|---|---|---|
| `canonical` | `canonical_json` | decode and encode with no numeric tokens, NFC strings, ASCII member names, ordered members |
| `scalar` | `DecimalU64` | decimal-string integers as `bigint`, and a sequence that fails closed at the ceiling |
| `identifier` | the identifier types | shape-checked, compile-time-branded `SubjectId`, `ProposalId`, and the rest |
| `capability` | `CapabilityName` | the shape of a capability name; never its vocabulary |
| `version` | `require_compatible_contract` | the handshake, including refusing to echo a non-canonical claim |
| `error` | `FoundationError` | the closed taxonomy, decoded to a typed value or refused |
| `envelope` | the closed envelopes | wake, proposal, admission, effect request, and the turn report |
| `activation` | `ActivationState` | the gate a client renders and requests modes against |

`failureKind` and `isRetryable` classify a decoded failure the same way the kernel does, so
a client can tell a withheld decision from an unreachable port without a table of its own.
[Routing a failure](failure-routing.md) is that boundary in full.

```sh
npm install @aiaiaiai/contracts
```

Until the first release is published this resolves to nothing; see
[Releasing](releasing.md).

The package version is the contract line it implements, so `@aiaiaiai/contracts@0.2.0`
speaks `0.2.0` and nothing else. When the line moves — a closed vocabulary gains or loses a
variant — the package moves with it, and `requireCompatibleContract` refuses a peer claiming
the other line before a payload is decoded.

Decoded members keep their wire names — `operation_id`, not `operationId`. A host that
renamed them would maintain a second vocabulary for one contract, and a log line and a
payload would eventually disagree about the same value.

```ts
import {
  decodeCanonicalJson,
  decodeTurnOutcome,
  requireCompatibleContract,
} from "@aiaiaiai/contracts";

requireCompatibleContract(peerContractVersion); // before anything is decoded

const outcome = decodeTurnOutcome(
  decodeCanonicalJson(payload),
  decodeProductProposal, // the product owns what a proposal means
  decodeProductEffect,
);

if ("error" in outcome) {
  reportDegraded(outcome.error.code); // a failure is an outcome, never an empty success
} else {
  for (const proposal of outcome.ok.proposals) {
    render(proposal.proposal); // computation awaiting a decision, not an action
  }
}
```

## One corpus, two implementations

`fixtures/contract-wire-0.2.0.json` holds the contract as data: canonical and non-canonical
versions, identifiers, capability names, and decimal integers; every token of every closed
vocabulary; canonical JSON inputs with the exact bytes they encode to and the exact reason
each rejected input is refused; whole documents that must survive a decode and re-encode
unchanged; documents that must be refused; and the activation table.

Three test files read it:

- `crates/aiai-contracts/tests/wire_conformance.rs` — the producing side
- `crates/aiai-runtime/tests/activation_conformance.rs` — the gate
- `packages/aiai-contracts/tests/conformance.test.ts` — the host side

The vocabularies are walked through exhaustive `match` arms rather than lists of strings, so
adding an `ErrorCode`, a `ContextPort`, a `SchemaViolation`, or an `ActivationState` stops
the Rust conformance tests compiling until the corpus and the mirror carry it too.
`scripts/check_architecture.py` checks that the corpus and all three readers still exist,
because "a drifting mirror fails a build" is true only while every side still reads it.

## What this boundary does not guarantee

- **It is not a session.** The package decodes and encodes; it holds no proposals, takes no
  authority decision, and cannot produce an `Admitted` value. A proposal a host decoded is
  computation awaiting a decision that is taken in the kernel, not in the browser.
- **A duplicated object member is not detected.** `JSON.parse` keeps the last one and
  reports nothing. A host that must refuse duplicates scans the bytes itself.
- **It does not authenticate anything.** Decoding proves a payload is well-formed for this
  contract line, never that it came from the runtime a host believes it is talking to.
- **A product payload stays opaque.** `P`, `R`, and `F` are decoded by functions the product
  supplies. When one of those refuses a variant, that failure reaches the caller as it was
  raised rather than flattened into `malformed_envelope`.

## Where it deliberately answers more strictly

`TurnOutcome` is an untagged union, and a payload carrying both an `ok` and an `error`
member is one the Rust decoder resolves by preferring `ok`. This package refuses it: the
kernel's conversion from `Result` produces exactly one member, so a payload with both did
not come from a turn, and reporting a success for a turn that also claims to have failed is
worse than reporting nothing.

## Verification

```sh
npm ci
npm run typecheck:web
npm run test:web
npm run build:web
cargo test --locked --workspace --all-features
python3 scripts/check_architecture.py
```

## Related

- [Foundation architecture](architecture.md)
- [Consuming the foundation](consuming.md) — the Rust side of the same contract
- [Releasing, and what a consumer pins](releasing.md)
- [Browser-local inference](browser-local-inference.md) — the other host-side package
- [Integrating a product AI runtime](nilx-one-ai-integration.md)
