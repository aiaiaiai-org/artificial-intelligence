# Changelog

This file records what changed in each released line of the aiaiaiai AI foundation.

Two version numbers appear here and they mean different things. The **release tag**
(`v0.2.0`) names a state of this repository and equals the Cargo workspace version. The
**contract line** (`0.2.0`) is the wire vocabulary that `aiai_contracts::CONTRACT_VERSION`
declares and that `@aiaiaiai/contracts` mirrors. The line moves whenever a closed wire
vocabulary changes — an `ErrorCode`, `ContextPort`, `SchemaViolation`, or `ActivationState`
variant added or removed — which is a breaking change for every peer, and it moves
independently of the npm package versions, which each state their own.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Until `1.0.0`
a minor bump is a breaking change: `accepts_provider` treats a pre-`1.0` line as compatible
only across patches of the same minor.

## [0.2.0] — unreleased

The first line. It is a compatibility line, not a stability promise. This heading takes a
date when `v0.2.0` is tagged, and an `Unreleased` section opens above it.

### Added

- **`aiai-contracts`** — binding-safe versioned values: canonical `MAJOR.MINOR.PATCH`
  contract versions, decimal-string `u64`s that forbid JSON numeric tokens, prefixed
  lower-hex identifiers, bounded capability names, closed generic envelopes, and a closed
  `FoundationError` taxonomy with code-specific details.
- **`aiai-runtime`** — the replaceable-computation kernel: `SubjectBinding` continuity,
  the activation gate, and the `propose → admit → dispatch` chain, where an `Admitted`
  value has a crate-private constructor and is consumed by `dispatch` so one admission
  dispatches at most once. Re-exports the contract crate and ships a prelude, so a product
  adds one dependency rather than two pinned to the same revision.
- **`aiai-signal`** — the closed-schema behavioral signal transform and an independent
  validator that repairs nothing. `SchemaRegistry` ships empty, and no transport exists.
- **`@aiaiaiai/webllm`** — a browser-local WebGPU/WebLLM inference lifecycle that probes
  without downloading, loads only on an explicit call, and reports `ready` separately from
  cached, loading, unavailable and failed.
- **`@aiaiaiai/contracts`** — the host side of the same wire contract, with no runtime
  dependencies, so a client observes the rules the producer keeps rather than re-deriving
  them.
- **`fixtures/contract-wire-0.2.0.json`** — one corpus answered by both implementations, so
  a drifting mirror fails a build rather than a payload.
- `RuntimeSession::snapshot` and `restore`, so a subject outlives the process serving it,
  and `turn_ok` / `TurnOutcome`, so a turn is reported from session state rather than
  reconstructed by a caller.
- `propose_candidates`, for computation that cannot be a synchronous port.

### Notes for consumers

- Pin the tag. Until this release is tagged, pin a revision reachable from `master`.
- `0.1.0` and `0.2.0` are mutually incompatible by construction, and a test asserts it.

[0.2.0]: https://github.com/aiaiaiai-org/artificial-intelligence/releases/tag/v0.2.0
