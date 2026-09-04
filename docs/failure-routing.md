# Routing a failure

A failure has to go two ways at once: into a durable record an operator reads later, and to
the person waiting on the operation. Neither happens here. This repository writes nothing,
sends nothing, and renders nothing — there is no logger, no exporter and no transport in the
workspace, and adding one would break the port model before it broke anything else.

What the foundation owns is the part both directions need and neither product should
re-derive: **what kind of failure a code names**, and **the shape of the row**.

```text
                       FoundationError { code, operation_id?, details? }
                                        |
                      code.kind() ──────┴────── FailureRecord { .., error }
                            |                              |
                 which person-facing treatment      the row a product writes
                 this failure deserves              wherever it keeps them
                            |                              |
                    product decides copy             product owns the store
```

## The classification

Thirteen codes, five kinds. Every consumer that classified them separately would classify
them slightly differently, which is the whole reason this lives here.

| Kind | Codes | Retryable |
|---|---|---|
| `unavailable` | `missing_context`, `inference_unavailable` | **yes** |
| `withheld` | `authority_withheld` | no |
| `gated` | `runtime_inactive` | no |
| `exhausted` | `sequence_exhausted` | no |
| `rejected` | `malformed_envelope`, `unsupported_contract_version`, `unknown_variant`, `subject_continuity_violation`, `unknown_proposal`, `duplicate_proposal_id`, `authority_scope_exceeded`, `signal_schema_violation` | no |

```rust
use aiai_runtime::prelude::*;

match error.code().kind() {
    FailureKind::Unavailable => retry_later(),        // nothing was decided
    FailureKind::Withheld => show_the_decision(),     // authority answered no
    FailureKind::Gated => show_the_mode(),            // the runtime may not act now
    FailureKind::Rejected | FailureKind::Exhausted => report_to_an_operator(),
}
```

```ts
import { failureKind, isRetryable } from "@aiaiaiai/contracts";
```

Four points the table is making, because each is easy to get wrong:

- **`missing_context` is `unavailable`, not a caller mistake.** The generic external-port
  boundary uses it when the clock, identifier source, or authority cannot answer.
  `details.port` says which one failed. Inference is deliberately separate:
  `Session::propose` reports an inference port failure as `inference_unavailable`.
- **`withheld` means authority answered no.** `authority_withheld` is a decision, not a
  malfunction. A product that renders it as a fault is telling a person their owner's
  decision was a bug.
- **`authority_scope_exceeded` is `rejected`, not `withheld`.** Authority answered *admit*,
  but the grant was broader than the session's delegation scope. The session rejects that
  invalid grant; treating it as a normal refusal would hide a contract/scope violation.
- **Retryable means the same call, unchanged, may succeed.** Only an unavailable port
  qualifies. `duplicate_proposal_id` is excluded even though a fresh identifier would
  succeed: that is a different call, made after replacing an identifier source that returned
  a value the session already held.

`FailureKind` is derived from the code, never carried beside it in an envelope, so the two
can never disagree on the wire. Both implementations answer the same corpus
(`fixtures/contract-wire-0.2.0.json`), so a classification that drifts fails a build.

## The record

```rust
let record = FailureRecord::new(clock.now_unix_ms()?, Some(session_id), error);
let row = canonical_json(&record)?;   // what the product stores
```

`contract_version` is this build's, never one a caller supplies — a record claiming another
line would misdescribe the vocabulary its own code came from. The timestamp arrives from the
caller because the foundation reads no clock; a record whose time could not be obtained is
the caller's own outcome, not a substituted value.

`session_id` is the one optional member. A failure can happen before a session exists — a
refused contract handshake, for one — and a record that invented a session would point a
reader at work that never started.

**No subject identifier appears, deliberately.** `operation_id` inside the failure and
`session_id` beside it correlate a record with the work that produced it. A durable table
keyed by the person a runtime acts for is a different artifact with a different retention
contract — the one `aiai-signal` refuses to ship a transport for until consent, retention,
and cross-request privacy are defined. A failure table is not a way around that.

Because the record is canonical JSON, the row a product writes is the payload a host
decodes. There is no second encoding for a failure to disagree across.

## What each layer still owns

| Question | Answered by |
|---|---|
| What kind of failure is this, and may it be retried? | **this repository** |
| What columns does the row have? | **this repository** |
| Which store, which schema, which retention? | the product |
| Which failures a person sees at all | the product |
| The sentence, its language, its tone | the product |
| Whether a retryable failure is actually retried, and how often | the product |

The foundation stops at the value. A product that wanted it to also decide what a person
reads would be asking a library with no locale, no audience and no consent model to write
on its behalf.

## Related

- [The host side of the contract](host-contract.md)
- [Consuming the foundation](consuming.md)
- [Foundation architecture](architecture.md)
