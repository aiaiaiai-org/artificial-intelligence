# @aiaiaiai/webllm

An explicit browser-local WebGPU/WebLLM inference lifecycle for aiaiaiai runtimes.

```sh
npm install @aiaiaiai/webllm
```

It probes WebGPU without downloading anything, loads a model only after an explicit call,
runs generation in a dedicated Web Worker, and reports `ready` separately from cached,
loading, unavailable and failed — so a state a product renders as unavailable is never a
state that quietly still generates.

```ts
import { LocalInferenceRuntime, WebLlmBrowserHost } from "@aiaiaiai/webllm";

const runtime = new LocalInferenceRuntime(new WebLlmBrowserHost());
await runtime.probe();   // never downloads
await runtime.load();    // the only call allowed to fetch model artifacts

for await (const chunk of runtime.stream(messages)) {
  append(chunk);
}
```

It returns text and nothing else. Text a model produced is computation: the consuming
product wraps it as its own proposal payload, and the proposal → authority → dispatch
boundary still governs any effect.

- [Browser-local inference](https://github.com/aiaiaiai-org/artificial-intelligence/blob/master/docs/browser-local-inference.md)
- [Consuming the foundation](https://github.com/aiaiaiai-org/artificial-intelligence/blob/master/docs/consuming.md)

Licensed under Apache-2.0. See `LICENSE` and `NOTICE`.
