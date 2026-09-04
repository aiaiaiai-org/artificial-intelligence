# Browser-local inference

`@aiaiaiai/webllm` is the first concrete inference adapter in this repository. It runs a
small language model entirely in a browser through WebLLM and WebGPU, with generation moved
to a dedicated Web Worker so model work does not occupy the UI thread.

## Default model

The adapter pins both sides of the tested pair:

| Component | Pinned value | Reason |
|---|---|---|
| WebLLM | `0.2.84` | Reproducible API and prebuilt-model registry |
| Model | `Qwen3-0.6B-q4f16_1-MLC` | Small multilingual instruct model present in that registry |
| Context | `4096` tokens | WebLLM's low-resource prebuilt override |
| Generation | non-thinking, at most `128` new tokens by default | Bounded latency for short local dialogue |

No model weights are committed to this repository. WebLLM downloads the selected MLC
artifacts on the first explicit `load()` and stores them in browser cache. A product must
present that download honestly and must not call `load()` as a side effect of capability
probing.

## Lifecycle

```text
idle -> probing -> supported(cached: false|true) -> loading -> ready -> generating
             \-> unavailable                    \-> failed     \-> failed
                                                                  |
                                                        load() ---+  (no download)
```

Only `ready` and `generating` prove that local inference is available on the current device;
`isLocalModelOperational(state)` implements exactly that check, and `stream()` permits
generation from `ready` alone. A state a product renders as unavailable is therefore never a
state that quietly still generates.

`supported(cached: true)` means artifacts exist, not that a model engine has successfully
initialized. This distinction is deliberately suitable for a UI that must not display an AI
as locally authorized while its model is downloading, preparing, unavailable, or failed.

A generation that fails leaves the engine loaded but the lifecycle in `failed`, which is
observable to every subscriber. Calling `load()` again returns it to `ready` without
creating an engine or downloading anything, so recovery is explicit rather than implicit in
the next generation attempt.

`unload()` reports the cache state it actually observed rather than assuming that a loaded
model is still cached.

Failures are observable and there is no remote fallback. A product may add a remote model as
a separate provider, but it must report that provider transition instead of silently
substituting it for local inference.

## Minimal use

```ts
import {
  LocalInferenceRuntime,
  WebLlmBrowserHost,
} from "@aiaiaiai/webllm";

const local = new LocalInferenceRuntime(new WebLlmBrowserHost());
const availability = await local.probe(); // never downloads

if (availability.kind === "supported") {
  await local.load(); // explicit user-approved download/load boundary
}

for await (const text of local.stream([
  { role: "system", content: "Answer briefly in the user's language." },
  { role: "user", content: "Привіт" },
])) {
  renderPartialText(text);
}
```

The result is generated text, not authority, an effect, an acknowledgement, or evidence of
completion. The product owns the system prompt and conversation history. The adapter retains
neither after the call.

## Reaching the kernel

The Rust `Inference` port is synchronous and this adapter is asynchronous, so the adapter
deliberately does not implement that port — satisfying it would mean blocking a browser
thread on a model. The product awaits the text on its own side and hands the result to
`RuntimeSession::propose_candidates`, which mints and owns the resulting proposal exactly as
it would one produced through the port:

```ts
const text = await collect(local.stream(history));
```

```rust
session.propose_candidates(
    operation_id,
    vec![Candidate { requested_capability, proposal: product_payload(text) }],
    &mut identifiers,
)?;
```

The authority boundary is unchanged: the result is a pending proposal that an `Authority`
decision must admit before anything is attempted. What the product takes on is reporting its
own failures — a `failed` or `unavailable` adapter state is an explicit degraded outcome, never
an empty batch handed to the session as a successful turn.

## Deliberate first-slice limits

- Text input and streamed text output only.
- One loaded model and one generation at a time.
- No tools, effect adapters, ambient network access, durable memory, or background wakeups.
- No automatic download, retry, model fallback, or remote inference.
- `unload()` releases GPU resources but intentionally keeps downloaded browser-cache data.
- Recovery from a failed generation is an explicit `load()`, not an automatic retry.

These limits make the adapter usable without allowing a model response to bypass the
foundation's authority boundary.

## Related

- [Consuming the foundation](consuming.md) — where generated text becomes a product proposal
- [Foundation architecture](architecture.md)
