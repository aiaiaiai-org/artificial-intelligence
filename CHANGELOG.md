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
- `RUNTIME_DEVICE_FLOORS` and `belowRuntimeFloor`, the four adapter limits the pinned
  runtime requests before it will acquire a device. `probe()` applies them and refuses with
  `unavailable(reason: "device_limits_insufficient", limit)` rather than reporting a device
  supported that the engine would throw on — `maxStorageBuffersPerShaderStage` needs 10
  against a WebGPU default of 8, so this is reachable on a current device. A limit the
  adapter did not report is unknown rather than short, and does not refuse.
- `ServedCatalog`, so a product loads artifacts it hosts itself instead of a third party's
  mirror on a revision it does not control. It is validated when handed over rather than
  when a download fails: artifact URLs must carry an immutable `/resolve/<revision>/`
  segment, which is what stops the pinned runtime appending `resolve/main/` and turning a
  mirror into a moving target. `appConfig` passes the runtime's own configuration through
  unchecked for a product that needs a shape the catalog does not describe. Both reach
  engine creation and the cache lookup, which have to agree or a mirrored model reads as
  uncached forever.
- `GenerationOptions.responseFormat`, carrying `text`, an EBNF `grammar`, or a
  `json_object` schema through to the decoder, so a product parsing structured output
  parses something the model could not have failed to produce. A `grammar` or `json_object`
  with an empty body is refused as `invalid_request` rather than silently decoding open. A
  constrained parse is still a proposal an authority decision must admit.
- **`@aiaiaiai/contracts`** — the host side of the same wire contract, with no runtime
  dependencies, so a client observes the rules the producer keeps rather than re-deriving
  them.
- **`probes/webgpu`** — a dependency-free static page that reports a device's WebGPU
  adapter features and limits, naming its unavailable reasons exactly as
  `@aiaiaiai/webllm` does. It requests an adapter and stops: no device, no shader, no
  model, no download. All four runtime floors are marked decisive, each reported as
  `clears`, `SHORT` or `not reported` against the value the runtime demands, and the page
  records its own verdict as `belowRuntimeFloor`. Results are recorded per surface in
  `probes/webgpu/RESULTS.md`, where an unmeasured surface stays visibly unmeasured.
- **`fixtures/contract-wire-0.2.0.json`** — one corpus answered by both implementations, so
  a drifting mirror fails a build rather than a payload.
- `RuntimeSession::snapshot` and `restore`, so a subject outlives the process serving it,
  and `turn_ok` / `TurnOutcome`, so a turn is reported from session state rather than
  reconstructed by a caller.
- `propose_candidates`, for computation that cannot be a synchronous port.
- `ErrorCode::kind` and `is_retryable`, classifying all thirteen codes into five
  `FailureKind`s, plus `FailureRecord` — the row a product stores. Both are mirrored in
  `@aiaiaiai/contracts` and locked by the shared corpus. The kind is derived from the code
  rather than carried beside it, so the contract line does not move.

### Notes for consumers

- Pin the tag. Until this release is tagged, pin a revision reachable from `master`.
- `0.1.0` and `0.2.0` are mutually incompatible by construction, and a test asserts it.

[0.2.0]: https://github.com/aiaiaiai-org/artificial-intelligence/releases/tag/v0.2.0
