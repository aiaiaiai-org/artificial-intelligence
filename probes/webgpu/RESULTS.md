# WebGPU probe results

Measured results from [`index.html`](index.html). One row per surface actually opened.

**Nothing here is inferred.** A row reads `not measured` until someone has opened the page
on that surface and pasted what it reported. A surface nobody has measured must not be
allowed to look like a surface that answered, because the two lead to opposite decisions:
one is a fact about a device, the other is a task that has not been done.

## Surfaces

| Surface | WebGPU | `shader-f16` | `maxBufferSize` | `maxStorageBufferBindingSize` | Measured |
|---|---|---|---|---|---|
| Mobile Safari (iOS) | not measured | — | — | — | — |
| Embedded WebView — messaging mini app (iOS) | not measured | — | — | — | — |
| Embedded WebView — activity iframe (sandboxed) | not measured | — | — | — | — |
| Desktop Chrome | not measured | — | — | — | — |

The first three are the ones worth the trouble. Desktop Chrome is the control: it is
expected to clear every bar, and a desktop-only result proves nothing about whether a
model can run where the product is actually opened.

The embedded rows are separate from Mobile Safari on purpose. An embedded WebView shares an
engine with the standalone browser but not its permissions policy, its process limits, or
necessarily its GPU access — so the standalone result cannot stand in for it. When
recording one, check the page's `embedded frame` row to confirm you measured the WebView
and not the browser.

## Records

Paste the JSON block from the page under a heading naming the surface, the OS version, and
the app version where one applies. Keep the raw record: the summary table above is a
reading of it, and a limit that turns out to matter later is only recoverable if the whole
record was kept.

<!-- Example of the shape. Replace with real records; do not leave this as one.

### Desktop Chrome 141 — macOS 15.2 — 2026-09-09

```json
{
  "userAgent": "...",
  "embedded": false,
  "secureContext": true,
  "webgpu": true,
  "f16": true,
  "limits": { "maxBufferSize": 0, "maxStorageBufferBindingSize": 0 },
  "features": [],
  "info": {}
}
```
-->

## What the results decide

- **No `shader-f16` on a surface** — half-precision kernels do not run there. That surface
  needs a deterministic path as its product, not as a fallback it degrades into.
- **A low `maxBufferSize`** — weights need chunking to that ceiling. This is a constraint on
  how a model is loaded, not on whether it can be.
- **No adapter at all** — nothing local runs there, and the surface should never render a
  local model as available.

A result on one surface is a fact about that surface only. Nothing here generalizes across
surfaces, which is the entire reason the table has four rows instead of one.
