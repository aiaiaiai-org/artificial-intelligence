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
                                                     |            |
                                         cancelLoad()-+  load() ---+  (no download)
```

A cancelled load returns to where it started — `supported` with the cache re-read, or `idle`
when it started from anywhere else — and never to `failed`. `failed` is what a product
renders as something having gone wrong, and nothing did: a person asked for this.

Only `ready` and `generating` prove that local inference is available on the current device;
`isLocalModelOperational(state)` implements exactly that check, and `stream()` permits
generation from `ready` alone. A state a product renders as unavailable is therefore never a
state that quietly still generates.

`unavailable` carries the reason it was reached. Three are facts a WebGPU probe can observe
on its own — `insecure_context`, `webgpu_missing`, `webgpu_adapter_unavailable`. Two more are
runtime verdicts over measured capability and the selected served entry:
`device_limits_insufficient` names a runtime floor the adapter reported short, while
`model_features_unavailable` names model-required features the adapter did not offer.

### The runtime floor

An adapter is not yet a runtime. `@mlc-ai/web-llm@0.2.84` asks for four limits when it
acquires a WebGPU device, and throws if any is refused:

| Limit | Required | Fallback |
|---|---|---|
| `maxBufferSize` | 1 GiB | 256 MiB, then refuse |
| `maxStorageBufferBindingSize` | 1 GiB | 128 MiB, then refuse |
| `maxComputeWorkgroupStorageSize` | 32 KiB | none |
| `maxStorageBuffersPerShaderStage` | 10 | none — the WebGPU default is 8 |

A device short of any of them starts no engine, whatever model it is asked for. `probe()`
therefore reads those limits and refuses before the cache is consulted, reporting
`unavailable(reason: "device_limits_insufficient", limit)` with the limit that was short.
That refusal is a stated fact a product can render, rather than an engine exception a
person has to interpret — and it costs nothing, because the probe already had the adapter
in hand.

The floors are exported as `RUNTIME_DEVICE_FLOORS` and applied by
`belowRuntimeFloor(capability)`, so a product that wants to say *why* a surface is refused
reads the same table the runtime does rather than keeping its own copy.
`maxStorageBuffersPerShaderStage` is the row that catches modern devices, and the only one
whose requirement sits above the WebGPU default.

A limit an adapter does not report is **not** treated as short. An absent value is unknown,
and refusing on it would turn a reporting gap into a verdict about a device — the opposite
mistake to the one this check exists to prevent, and one a person could do nothing about.
WebGPU requires an adapter to expose every limit, so this is a gap in a browser rather than
a property of a device; such a device reaches `load()` and, if the engine does refuse it,
fails observably there.

### What the identifier already says

An MLC identifier carries its quantisation: `Qwen3-0.6B-q4f16_1-MLC` is four-bit weights
computed in half precision, and half-precision kernels do not compile without the WebGPU
`shader-f16` feature. The engine knows this — `ModelRecord.required_features` is exactly
that list, and `reloadInternal()` checks it. Where it checks it matters:

```text
fetch mlc-chat-config.json -> fetch WASM lib -> instantiate -> acquire GPU device
   -> check required_features -> initWebGPU -> fetch tokenizer -> fetch weights
```

So a record that declares what it needs is refused before the weights — though only after
two fetches, a WASM instantiation and a device acquisition. That much would be tolerable.
The problem is the records that declare nothing: they skip the check altogether and carry
on into device initialisation and the weight fetch, failing somewhere past them. And the
list is not reliably written. In the prebuilt registry of `@mlc-ai/web-llm@0.2.84`:

| Quantisation | Entries | Declaring `shader-f16` |
|---|---|---|
| `q4f16_1` | 76 | 27 |
| `q0f16` | 8 | 2 |
| `q3f16_1` | 2 | 0 |

So the adapter derives the requirement from the identifier instead of trusting the entry to
state it. `parseQuantization(modelId)` reads the token and `requiredFeaturesFor(modelId,
declared)` returns what the entry declared plus what the token implies. That union is
applied in two places, in this order:

1. **Before any fetch.** The runtime refuses on it —
   `unavailable(reason: "model_features_unavailable", missing: ["shader-f16"])`. This is
   the refusal that costs nothing, because the probe already had the adapter in hand.
2. **In the record the engine consumes.** A served catalog carries the union into
   `required_features`, and where no catalog is given, `completedPrebuiltAppConfig()`
   completes the prebuilt registry's own records the same way. That makes the engine's
   guard fire for a record that would have skipped it — later than the first check, but
   still ahead of the weights.

The first is the invariant; the second is what still holds when a product uses
`WebLlmBrowserHost` without `LocalInferenceRuntime`. A product's own `appConfig` is left
exactly as given: it is the documented way out of this package's opinions, and this is one
of them.

The refusal is not conditional on having probed. `load()` is a supported entry point on its
own, so a load that was not preceded by a successful `probe()` reads the device first and
refuses on the same verdict — a requirement enforced only on the probed path would not be a
requirement at all.

Three things it deliberately does not do:

- **It never removes a declared requirement.** An entry asking for a feature its identifier
  does not imply has stated something about a WASM library this package cannot see, and is
  believed.
- **It never guesses.** An identifier with no token — `Small-MLC` — declares no
  quantisation, and nothing is derived from a model's name, size, or family.
- **It derives nothing from weight width.** A four-bit weight is dequantised by the kernels
  the activation type already decided. `q4f32_1` requires nothing `q0f32` does not.

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

if (availability.kind === "unavailable") {
  // Includes `device_limits_insufficient`, where `availability.limit` names the limit that
  // was short. There is no remote fallback: this surface runs no local model.
  return renderUnavailable(availability);
}
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

## The download a person can change their mind about

`load()` is the one operation here that runs for minutes over a connection somebody is
paying for. Two things follow from that, and both are part of the adapter rather than
something a product is left to build.

**It can be stopped.** `cancelLoad()` aborts a download in progress; so does an
`AbortSignal` passed as `load({ signal })`. Either terminates the worker, which is what
actually ends the fetches — the engine's own creation call takes no signal, and once its
worker is gone its promise never settles at all, so it is raced rather than awaited.

```ts
const loading = local.load({ signal: controller.signal });
cancelButton.onclick = () => local.cancelLoad();
try {
  await loading;
} catch (error) {
  if (error instanceof LocalInferenceError && error.code === "load_cancelled") {
    // Not a failure. The lifecycle is already back where the load found it.
  }
}
```

There is one download however many callers asked for it, so any joined caller's signal
cancels it for all of them and every joined caller is rejected with `load_cancelled`; a
shared operation cannot be abandoned by one holder and continued for another. A load
cancelled after the engine had already finished building releases that engine rather than
stranding a GPU allocation nothing holds a reference to. And because a partial download
leaves whatever it completed in browser storage, the `cached` flag is re-read on the way
back rather than restored from what the load started with.

**It can be deleted.** `unload()` gives back the GPU and keeps the download; `evict()` gives
back the storage. A product that offers a local model has to offer this too — a few hundred
megabytes a person cannot delete from inside the product is a few hundred megabytes they did
not really consent to.

```ts
await local.unload();  // release the GPU
await local.evict();   // and the artifacts it was loaded from
```

`evict()` refuses with `busy` while a load is running or an engine is loaded from the
artifacts it would delete, and is deliberately available from `unavailable`: a device that
can no longer run a model it once downloaded is precisely the device whose storage is worth
giving back. Eviction reads the same catalog the download did, so a self-served model is
deleted through its own artifact URLs rather than the prebuilt registry's. A failure to
delete raises `evict_failed` and leaves the lifecycle untouched — a cache entry that will
not go away changes nothing about what the device can run, and reporting the model as
`failed` over it would say otherwise.

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

## Serving your own artifacts

Left alone, the adapter loads from the pinned runtime's prebuilt registry: a third party's
mirror, on a revision this repository does not control, over a network path a product cannot
account for. A product that intends to ship gives the host its own catalog instead.

```ts
const catalog = {
  models: [
    {
      modelId: "Small-q4f16_1-MLC",
      artifacts: `https://models.example.org/Small-q4f16_1-MLC/resolve/${revision}/`,
      modelLib: `https://models.example.org/libs/${revision}/Small-q4f16_1-webgpu.wasm`,
      requiredFeatures: ["shader-f16"],
      vramRequiredMb: 1403,
      contextWindowSize: 4096,
      integrity: { config: "sha256-…", modelLib: "sha384-…" },
    },
  ],
  cacheBackend: "cache",
} as const;

const local = new LocalInferenceRuntime(
  new WebLlmBrowserHost({ catalog }),
  catalog.models[0],
);
```

A product that already builds the pinned runtime's own `AppConfig`, or needs a shape
`ServedCatalog` does not describe, passes `{ appConfig }` instead and it is used unchecked.
That is the whole difference between the two options: the catalog is this package's opinion
about what a mirror must get right, and `appConfig` is the way out of that opinion rather
than a reason to fork the host. They are mutually exclusive.

The catalog is checked when it is handed over, not when a download fails — every way of
getting one wrong is otherwise discovered by a person on a phone waiting for a model that
will never arrive. `validateServedCatalog` throws
`LocalInferenceError("invalid_catalog")` on the first thing wrong, and the host runs it for
you.

What it refuses, and why:

| Refusal | Why |
|---|---|
| `artifacts` without a trailing `/resolve/<revision>/` | The pinned runtime appends `resolve/main/` to any URL without one. A mirror would silently become a moving target. |
| a revision named `main`, `master`, `HEAD`, `latest`, `dev`, … anywhere in either URL | The same failure by hand. This is a heuristic and cannot prove a segment immutable — a commit hash and a branch name are the same shape of string — but it catches known moving revisions. |
| `modelLib` that is not a `.wasm` URL, resolves through a moving revision, or is neither revision-pinned nor protected by `integrity.modelLib` | The WASM executable must stay tied to stable bytes rather than silently move behind a stable-looking URL. |
| a plaintext `http:` URL | A page that could not have obtained a WebGPU adapter without a secure context cannot fetch these either. Better said here than as a mixed-content failure at download time. |
| a malformed or wrong-length SRI hash | A hash whose algorithm, base64 form, or digest length is wrong verifies nothing while appearing to. |

Weight shards are deliberately outside `integrity`: SRI does not cover them, and an
integrity block that appeared to would be the more dangerous of the two. They are pinned by
the immutable revision segment instead. Where a hash *is* given, a mismatch is an error
rather than a warning — a failed verification is the one case where continuing is worse
than stopping.

A served entry states what it requires, which is what lets `probe()` refuse a surface
before a download rather than after one: a device that clears every runtime floor but lacks
a feature the entry declared reaches
`unavailable(reason: "model_features_unavailable", missing)`. This stays the model's
refusal, not the runtime's — the adapter takes no view on which model a product should
serve, only on whether this device can run the one it was given.

### Bounding what the cache costs

An entry may state the shape of its KV cache, which is the part of a local model's memory a
product actually controls:

```ts
{
  modelId: "Small-q4f16_1-MLC",
  // …
  slidingWindowSize: 1024,
  attentionSinkSize: 4,
}
```

`contextWindowSize` is a fixed window: the conversation may not exceed it, and a prompt that
does is refused. `slidingWindowSize` is the other shape — the conversation may run past the
window, and what falls out of it is forgotten rather than refused — which is what bounds the
cache on a device with little of it. `attentionSinkSize` pins that many tokens at the head
of a sliding window, which is what keeps it from degrading once the earliest tokens leave.

The two windows are mutually exclusive and an entry setting both is refused when it is
handed over. A sliding window carries `context_window_size: -1` into the record with it,
because the pinned runtime refuses a configuration where both are positive and a model's own
`mlc-chat-config.json` normally declares a positive context window — an entry that set only
`slidingWindowSize` would otherwise fail to load, naming a field the product never wrote.
`attentionSinkSize` without `slidingWindowSize` is refused rather than ignored; `0` is a real
choice and is accepted.

Nothing else about generation is tuned here. There is no place to state a prefill chunk size,
because `ChatConfig` in the pinned runtime has no such field and an option this package
accepted and then dropped would be worse than one it never offered.

## Constrained decode

A product that parses structured output should be parsing something the model could not
have failed to produce:

```ts
for await (const text of local.stream(history, {
  responseFormat: { type: "grammar", grammar: menu.grammar() },
})) {
  render(text);
}
```

`{ type: "json_object", schema }` is the other constraining form, and `{ type: "text" }`
imposes nothing — the same as leaving the field unset, said out loud. Both constraints are
the product's: this adapter neither writes grammars nor interprets what a satisfying string
means. A `grammar` or `json_object` format carrying an empty body is refused with
`invalid_request` rather than passed along, because it would read as a constrained decode at
every call site while placing no constraint on the decoder at all.

Constraining the decode does not change what the output *is*. A parse that succeeds is
still a proposal an `Authority` decision must admit, and the grammar makes it a better
proposal, never a permitted action.

## Deliberate first-slice limits

- Text input and streamed text output only.
- One loaded model and one generation at a time.
- No tools, effect adapters, ambient network access, durable memory, or background wakeups.
- No automatic download, retry, model fallback, or remote inference.
- The adapter serves the catalog it is handed and mirrors nothing itself. Hosting weights is
  redistribution, and whether a licence permits it is the deployment's question to answer
  before the URLs in a catalog exist.
- `unload()` releases GPU resources but intentionally keeps downloaded browser-cache data;
  `evict()` is the separate, explicit operation that deletes them.
- Recovery from a failed generation is an explicit `load()`, not an automatic retry.
- A cancelled load is not resumed automatically. Whatever it completed stays in browser
  storage and a later `load()` reuses it, but nothing restarts on its own.
- No storage budget is reported. `navigator.storage.estimate()` is deliberately quantised by
  browsers to resist fingerprinting, so a number read from it is not the number of bytes a
  download has available, and this package does not present one as though it were.

These limits make the adapter usable without allowing a model response to bypass the
foundation's authority boundary.

## Related

- [Consuming the foundation](consuming.md) — where generated text becomes a product proposal
- [The host side of the contract](host-contract.md) — the other host-side package
- [Foundation architecture](architecture.md)
