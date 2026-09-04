# Foundation Architecture

This repository owns the product-agnostic half of the aiaiaiai AI stack: the shapes,
boundaries, and refusals that every product's AI runtime needs and none of them should
re-derive. It owns no participants, no relationships, no interactions, and no records.

## What "product-agnostic" is enforced to mean

A foundation stays product-agnostic through structure, not discipline. Three facts do the
work here, and each is checked rather than asserted:

- **No product vocabulary exists to leak.** There is no participant type, relationship
  type, interaction type, or record type anywhere in the workspace. Product payloads pass
  through as opaque generic parameters (`P`, `R`, `F`), so the foundation cannot branch on
  what a product means by them.
- **The signal path cannot see runtime state.** `aiai-signal` does not depend on
  `aiai-runtime`. A training candidate has no session, proposal, admission, or effect type
  in scope to be derived from.
- **Nothing reaches the ambient environment.** `aiai-contracts` and `aiai-runtime` carry no
  async, platform-binding, or transport dependency. Time, identifiers, inference, and
  authority arrive only through explicit ports, each of which is a parameter of some session
  method — the kernel declares no port it does not read.

`scripts/check_architecture.py` enforces the last two as dependency facts in CI.

## Workspace

```text
crates/
├── aiai-contracts   # binding-safe versioned values, closed envelopes, typed failures
├── aiai-runtime     # replaceable-computation kernel: continuity, activation, authority
└── aiai-signal      # closed-schema behavioral signal transform and validator

packages/
└── aiai-webllm      # browser-local inference adapter; no product semantics or authority
```

Dependency direction is one-way. `aiai-runtime` depends only on `aiai-contracts`.
`aiai-signal` depends only on `aiai-contracts`. Contracts depend on neither.

`aiai-webllm` is a platform adapter rather than a Rust workspace member. It owns browser
capability probing, model cache/load lifecycle, a dedicated Web Worker, and streaming text
generation. It does not import the Rust runtime and does not reinterpret generated text as
an admitted action. A product may turn that text into its own proposal payload, but the
existing proposal → authority → dispatch boundary still governs any effect.

## The three separations

Everything in `aiai-runtime` exists to keep three separations true no matter how convincing
a model's output is.

### Identity is not computation

```text
subject != controller != runtime != model != session
```

`SubjectBinding` fixes the subject at construction. `rebind` replaces the controller,
runtime, and model; there is deliberately no counterpart that replaces the subject, so a
runtime restart, a provider migration, or a model swap cannot mint a different participant.
`classify` reports two bindings that name different subjects as `DistinctSubject` — never as
continuity of one participant.

A session that rebinds mid-flight keeps its pending proposals. The subject did not change,
so work it already started is neither completed nor cancelled by swapping the computation
behind it.

### Existence is not inference

```text
Dormant --Wake--> Active --Quiesce--> Quiescing --Settle--> Dormant
```

A subject continues to exist while its runtime is dormant; it simply produces nothing. The
gate is explicit at every step:

| State | May initiate | May settle in-flight work |
|---|---|---|
| `Dormant` | no | no |
| `Active` | yes | yes |
| `Quiescing` | no | yes |

`Quiescing -> Wake` is undefined. Activity that has begun winding down settles first, so
leaving activity never silently resumes mid-flight work. Going dormant does not manufacture
completion, cancellation, or rollback for anything still pending — a dormant session simply
decides nothing.

A product usually owns a mode enumeration rather than a set of edges — one mode per state.
`RuntimeSession::ensure_activation` takes the target state, which makes re-applying the
current mode a no-op instead of an undefined transition. It resolves only single defined
steps: reaching `Active` from `Quiescing` is refused there too, because settling is the
owner's assertion that in-flight work reached its boundary and the session will not make
that assertion on the owner's behalf.

### A proposal is not an action

```text
wake -> propose -> admit -> dispatch
```

Each arrow is gated, and the third one is a type boundary rather than a convention:

1. `propose` requires an active session. Inference output is a candidate, nothing more. The
   session keeps the canonical `ProposalEnvelope` values and returns only their
   `ProposalId`s; `pending_proposal` lends an original for rendering or serialization.
   Computation that cannot be a synchronous port — a model behind an async or
   foreign-language boundary — hands its candidates to `propose_candidates`, which mints
   and owns them identically. Neither path lets a caller supply a `proposal_id`,
   `sequence`, `operation_id`, or `contract_version`.
2. `admit` takes a `ProposalId` — not an envelope — and resolves the proposal it decides
   from session-owned state. The port must return `Admit`, and the granted capability must
   fall inside the session's `DelegationScope`. The result is an `Admitted` value whose
   constructor is crate-private, so a caller outside this crate cannot build one.
3. `dispatch` accepts `Admitted` and nothing else. There is no function anywhere that takes
   a `ProposalEnvelope` and returns an `EffectRequestEnvelope`.

Provenance follows from ownership rather than from comparing fields a caller supplied. Since
no method accepts proposal content after the proposal exists, a legitimate `ProposalId`
cannot be widened into authority for a different payload, sequence, operation, or contract
version: there is no input through which substituted content could arrive. An identifier the
session does not hold is `UnknownProposal`, and the authority port is never consulted about
it.

`Admitted` is neither `Clone` nor `Copy`, and `dispatch` consumes it, so one admission
dispatches at most once.

`propose` is transactional. It stages the whole batch — identifiers, sequences, envelopes —
and commits only once every fallible step has succeeded. An `Err` from `propose` therefore
leaves no pending entry, no sequence advance, and no revision advance, so a failed round
cannot leave a proposal the caller never received. A repeated identifier from the
identifier-generation port is refused as `DuplicateProposalId` rather than overwriting a
proposal the session already owns.

A pending proposal is released only on a terminal authority decision — admitted, withheld,
or granted outside scope. An unavailable authority port is not a decision: the proposal
stays pending so the same decision can be sought again.

`DelegationScope::narrow` returns a subset or an error. Authority cannot widen through
repeated delegation, and no sequence of narrowing calls recovers a capability that an
earlier step dropped.

### A subject outlives the process serving it

`SubjectBinding` makes computation replaceable within one run. `SessionSnapshot` makes it
replaceable across runs: `snapshot` captures the durable half of a session — identity,
binding, scope, activation, counters, and the proposals still awaiting a decision — and
`restore` seats a session on it. A restored session may be served by a different clock,
identifier source, computation, or authority, because ports are supplied per call and are
not part of what a session is.

Two things are deliberately absent. An `Admitted` value in flight is not session state: it
is permission a caller was granted and then held, and a restart is evidence neither that the
attempt happened nor that it did not, so the product seeks the decision again rather than
resuming a permission whose outcome nobody observed. The ports themselves are absent for the
same reason they are parameters everywhere else.

`restore` refuses a snapshot from a compatibility line this build does not implement, one
carrying the same proposal identifier twice, and one whose sequence counter sits below a
proposal it already emitted — each would seat a session that contradicts itself. It cannot
verify that the bytes are the ones this session wrote. Storage is the product's trust
boundary, and the honest statement is that a product able to rewrite its own snapshots can
seat pending proposals of its choosing, exactly as it could by calling `propose` with
computation of its choosing. Neither route reaches the authority boundary: a restored
proposal becomes an action only through an `Authority` decision inside the restored scope.

## Failure is an outcome, not a gap

Every port returns `Result`. An unavailable clock is not a substituted timestamp; an
unreachable authority is not approval; unavailable inference is not an empty success. Each
becomes a typed `FoundationError` with a closed code and code-specific details, and the
whole taxonomy is a closed enum rather than a string.

## The signal boundary

```text
local observation
      |
      v
deterministic transform   (generalize, quantize, clamp, drop undeclared)
      |
      v
schema-conformant signal
      |
      v
independent validation    (repairs nothing; admits or refuses)
```

The transform is lossy on purpose and idempotent: applying it twice yields the same signal
as applying it once. The validator repairs nothing, because a validator that rounded a
too-precise value would accept exactly what the domain exists to exclude.

`SchemaRegistry` ships **empty**. Which behaviors deserve an archetype, and how coarse each
field must be, is a governance decision the product owns.

A payload's every value is a declared token, a bounded quantized measure, or a bounded
sequence of those. There is no string, byte array, or open metadata map, so an identifier
has nowhere to travel even if a client tries to attach one.

### What this boundary does not guarantee

Stating the limits is part of the contract:

- Per-payload validation cannot detect information encoded across a *sequence* of
  individually valid payloads. Closing that channel needs request-frequency limits,
  aggregation policy, and corpus-construction controls, which are cross-request concerns no
  per-payload validator can supply.
- It says nothing about re-identification against auxiliary datasets, rare-pattern
  singling-out across a large corpus, or model memorization.
- An open-source deterministic transform makes the official client auditable. It does not
  make a forked client follow it — which is why the validator exists independently.

### Collection is not activated

This crate contains no exporter, uploader, or transport, and holding a well-formed signal
is not authorization to collect or retain one. The consent, retention, schema-governance,
provenance, and cross-request privacy contracts a collection path requires do not exist
yet. Adding a transport before they do would make this boundary decorative.

## Contract versioning

`ContractVersion` is canonical `MAJOR.MINOR.PATCH` with no suffixes and no leading zeroes.
Pre-`1.0` lines are exact on `minor`; a released line accepts a forward-compatible `minor`.
`require_compatible_contract` refuses a non-canonical version without echoing it back as if
it were canonical.

Cross-runtime payloads carry integers as decimal strings and forbid JSON numeric tokens, so
a JavaScript host cannot silently narrow a value through IEEE-754 rounding. `canonical_json`
enforces that, plus NFC strings and ASCII object member names.

## Related

- [Consuming the foundation](consuming.md) — how a product repository depends on these crates
- [Browser-local inference](browser-local-inference.md) — concrete WebGPU/WebLLM adapter
- [Integrating a product AI runtime](nilx-one-ai-integration.md) — how a product repository
  composes these crates, worked through `nilx-one/ai`.
