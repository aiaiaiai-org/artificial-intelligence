# WebGPU capability probe

A single static page that reports what a browser's WebGPU adapter offers. No build step,
no dependencies, no network access, nothing to install. Open `index.html` and read it.

It exists because the question "can this device run a quantized model locally" is not
answerable from a user-agent string or from a desktop devtools session. It is answerable
only by asking the adapter on the device itself, on the surface the product actually ships
on — and on a phone, with no devtools attached, the answer has to be legible on the page.

## What it does

```text
isSecureContext -> navigator.gpu -> requestAdapter() -> features + limits + info
```

That is the whole probe. It requests an adapter and stops: no `requestDevice`, no shader
compilation, no model, no download. Probing must never be the thing that costs a user a
model download, and this page cannot become one by accident because it never has an
engine to hand the weights to.

The three ways it can come back empty are named exactly as
`@aiaiaiai/webllm` names them in `UnavailableReason` — `insecure_context`,
`webgpu_missing`, `webgpu_adapter_unavailable` — so a probe result reads directly against
the adapter's `unavailable` state instead of having to be translated into it.

`insecure_context` is separated from `webgpu_missing` for a practical reason: `navigator.gpu`
is absent on an insecure origin too, so a probe that reported only "no WebGPU" would send
you looking for a missing GPU when the actual cause is the URL you opened it from.

## The two fields that decide anything

| Field | Why it decides |
|---|---|
| `shader-f16` | Without it, half-precision kernels either fail outright or degrade past usefulness. Its absence is a stop, not a slowdown. |
| `maxBufferSize` | What forces weight chunking. Model size is not the constraint — the largest single buffer the device will grant is, and that ceiling has historically been far lower inside mobile WebViews than on desktop. |

`maxStorageBufferBindingSize` is reported next to them because a buffer that can be
allocated but not bound in one piece constrains a kernel the same way.

Everything else on the page is recorded rather than decided on. It is cheap to capture
once, on a device that may not be at hand again.

## Reading the limits correctly

The numbers are **adapter** limits: the ceiling this device is willing to grant. A device
created with a default `requestDevice()` call receives the specification's *default*
limits, which are considerably lower. A pipeline that needs more than the default must ask
for it explicitly in `requiredLimits`, and cannot ask for more than the adapter reports
here. Reading these as what a device gets for free will overestimate every surface.

## Running it

Any static server over `https` or `localhost` — WebGPU needs a secure context, and opening
the file over `file://` will report `insecure_context` rather than anything about the
device.

```sh
cd probes/webgpu && python3 -m http.server 8000
```

To probe a phone, serve it somewhere the phone can reach over https and open that URL in
the surface being tested — the embedded WebView, not the standalone browser that happens
to share its engine. The `embedded frame` row on the page records which one you got.

## Recording a result

The page renders a JSON block at the bottom, selectable and copyable, for exactly this:
a phone with no devtools can still produce a result you can paste. Add it to
[`RESULTS.md`](RESULTS.md) with the surface identified.

A surface with no recorded result is not a surface that failed. It is a surface nobody has
measured, and `RESULTS.md` distinguishes the two deliberately.

## Related

- [Browser-local inference](../../docs/browser-local-inference.md) — the adapter these
  capabilities gate, and the lifecycle a product renders
