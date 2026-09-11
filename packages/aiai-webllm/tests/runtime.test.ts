// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalInferenceError,
  LocalInferenceRuntime,
  DEFAULT_LOCAL_MODEL_ID,
  DEVICE_LIMITS,
  RUNTIME_DEVICE_FLOORS,
  isLocalModelOperational,
  type DeviceCapability,
  type DeviceLimit,
  type GenerationOptions,
  type LoadProgress,
  type LocalInferenceHost,
  type LocalInferenceState,
  type LocalMessage,
  type LocalTextEngine,
  type ResolvedGenerationOptions,
  type ServedModel,
  type WebGpuProbe,
} from "../src/index.js";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

class FakeEngine implements LocalTextEngine {
  public interrupted = false;
  public unloaded = false;
  public chunks = ["ві", "таю"];
  public failAfter: number | undefined;

  public lastOptions: ResolvedGenerationOptions | undefined;

  public async *stream(
    _messages: readonly LocalMessage[],
    options: ResolvedGenerationOptions,
  ): AsyncIterable<string> {
    this.lastOptions = options;
    let emitted = 0;
    for (const chunk of this.chunks) {
      if (this.failAfter !== undefined && emitted >= this.failAfter) {
        throw new Error("engine lost the device");
      }
      emitted += 1;
      yield chunk;
    }
  }

  public interrupt(): void {
    this.interrupted = true;
  }

  public async unload(): Promise<void> {
    this.unloaded = true;
  }
}

/**
 * An adapter that clears every runtime floor with room to spare, so a test that means to
 * exercise one floor sets that one field and nothing else drifts with it.
 */
function capableAdapter(
  overrides: Partial<DeviceCapability> = {},
): DeviceCapability {
  return {
    features: ["shader-f16"],
    maxBufferSize: 1 << 30,
    maxStorageBufferBindingSize: 1 << 30,
    maxComputeWorkgroupStorageSize: 32 << 10,
    maxStorageBuffersPerShaderStage: 10,
    ...overrides,
  };
}

class FakeHost implements LocalInferenceHost {
  public probeResult: WebGpuProbe = {
    supported: true,
    capability: capableAdapter(),
  };
  public cached = false;
  public cacheChecks = 0;
  public engineCreations = 0;
  public evictions: string[] = [];
  public evictionFails = false;
  public engine = new FakeEngine();

  /** When set, `createEngine` hangs the way a real download does until something ends it. */
  public stall = false;
  /** Finishes a stalled creation successfully, standing in for a download that completed. */
  public finishLoad: (() => void) | undefined;
  /** The signal the last `createEngine` was given, so a test can read what reached it. */
  public lastSignal: AbortSignal | undefined;
  /**
   * When set, a stalled creation ignores the signal and only ever succeeds.
   *
   * Honouring the signal is optional for a host, and even one that honours it can have the
   * engine finish in the instant before the worker is terminated. The runtime cannot rely
   * on a host to turn an abort into a rejection.
   */
  public ignoresSignal = false;

  public async probeWebGpu(): Promise<WebGpuProbe> {
    return this.probeResult;
  }

  public async hasModelInCache(_modelId: string): Promise<boolean> {
    this.cacheChecks += 1;
    return this.cached;
  }

  /** What the engine reports on its way up. One halfway report unless a test says otherwise. */
  public progressReports: readonly LoadProgress[] = [
    { progress: 0.5, timeElapsed: 7, text: "halfway" },
  ];

  public createEngine(
    _modelId: string,
    onProgress: (progress: LoadProgress) => void,
    signal?: AbortSignal,
  ): Promise<LocalTextEngine> {
    this.engineCreations += 1;
    this.lastSignal = signal;
    for (const report of this.progressReports) {
      onProgress(report);
    }
    if (!this.stall) {
      return Promise.resolve(this.engine);
    }
    return new Promise<LocalTextEngine>((resolve, reject) => {
      this.finishLoad = () => resolve(this.engine);
      if (this.ignoresSignal) {
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }

  public async evictModel(modelId: string): Promise<void> {
    if (this.evictionFails) {
      throw new Error("the cache would not release it");
    }
    this.evictions.push(modelId);
    this.cached = false;
  }
}

/** Resolves once every already-queued microtask has run. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof LocalInferenceError && error.code === code;
}

test("probe reports unsupported WebGPU without touching model cache", async () => {
  const host = new FakeHost();
  host.probeResult = { supported: false, reason: "webgpu_missing" };
  const runtime = new LocalInferenceRuntime(host);

  assert.deepEqual(await runtime.probe(), {
    kind: "unavailable",
    modelId: "Qwen3-0.6B-q4f16_1-MLC",
    reason: "webgpu_missing",
  });
  assert.equal(host.cacheChecks, 0);
  assert.equal(host.engineCreations, 0);
});

test("pins a model present in the installed WebLLM registry", () => {
  assert.ok(
    prebuiltAppConfig.model_list.some(
      (record) => record.model_id === DEFAULT_LOCAL_MODEL_ID,
    ),
  );
});

test("each runtime floor refuses on its own, before the cache is consulted", async () => {
  for (const limit of DEVICE_LIMITS) {
    const host = new FakeHost();
    host.probeResult = {
      supported: true,
      capability: capableAdapter({ [limit]: RUNTIME_DEVICE_FLOORS[limit] - 1 }),
    };
    const runtime = new LocalInferenceRuntime(host);

    assert.deepEqual(
      await runtime.probe(),
      {
        kind: "unavailable",
        modelId: DEFAULT_LOCAL_MODEL_ID,
        reason: "device_limits_insufficient",
        limit,
      },
      `${limit} below its floor must refuse on its own`,
    );
    // Nothing is downloaded, and nothing is even asked of browser storage, for a device
    // that would never have started an engine.
    assert.equal(host.cacheChecks, 0);
    assert.equal(host.engineCreations, 0);

    // A device refused for the runtime's own floor is refused for loading too, with the
    // reason it was refused for rather than an engine exception.
    await assert.rejects(
      () => runtime.load(),
      (error: unknown) =>
        error instanceof LocalInferenceError && error.code === "unavailable",
    );
    assert.equal(host.engineCreations, 0);
  }
});

test("a limit the adapter did not report is unknown, not short", async () => {
  const host = new FakeHost();
  // WebGPU requires an adapter to expose every limit, so an absent one is a reporting gap
  // rather than a device trait. Refusing on it would turn that gap into a verdict about a
  // device a person could do nothing about — the opposite mistake to the one the floors
  // exist to prevent. Such a device is left to fail observably at load, if it fails at all.
  host.probeResult = { supported: true, capability: { features: ["shader-f16"] } };
  const runtime = new LocalInferenceRuntime(host);

  assert.deepEqual(await runtime.probe(), {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: false,
  });
});

test("a reported limit still refuses when another is merely unreported", async () => {
  const host = new FakeHost();
  host.probeResult = {
    supported: true,
    capability: {
      features: ["shader-f16"],
      maxStorageBuffersPerShaderStage:
        RUNTIME_DEVICE_FLOORS.maxStorageBuffersPerShaderStage - 1,
    },
  };
  const runtime = new LocalInferenceRuntime(host);

  assert.deepEqual(await runtime.probe(), {
    kind: "unavailable",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    reason: "device_limits_insufficient",
    limit: "maxStorageBuffersPerShaderStage",
  });
});

test("the floor quotes the limits the pinned runtime actually requests", () => {
  // These are read from `@mlc-ai/web-llm@0.2.84`'s `detectGPUDevice`: 1 GiB requested for
  // both buffer limits with a single fallback each, and no fallback at all for the last
  // two. A version bump that moves them must move this table with it.
  assert.deepEqual(RUNTIME_DEVICE_FLOORS, {
    maxBufferSize: 268435456,
    maxStorageBufferBindingSize: 134217728,
    maxComputeWorkgroupStorageSize: 32768,
    maxStorageBuffersPerShaderStage: 10,
  });
  assert.deepEqual([...DEVICE_LIMITS].sort(), Object.keys(RUNTIME_DEVICE_FLOORS).sort());
});

test("a device clearing every floor is supported", async () => {
  const host = new FakeHost();
  host.probeResult = {
    supported: true,
    capability: capableAdapter(
      Object.fromEntries(
        DEVICE_LIMITS.map((limit: DeviceLimit) => [limit, RUNTIME_DEVICE_FLOORS[limit]]),
      ),
    ),
  };
  const runtime = new LocalInferenceRuntime(host);

  assert.deepEqual(await runtime.probe(), {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: false,
  });
});

test("probe distinguishes cached artifacts from a ready engine", async () => {
  const host = new FakeHost();
  host.cached = true;
  const runtime = new LocalInferenceRuntime(host);

  assert.deepEqual(await runtime.probe(), {
    kind: "supported",
    modelId: "Qwen3-0.6B-q4f16_1-MLC",
    cached: true,
  });
  assert.equal(host.engineCreations, 0);
});

const REVISION = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

function servedModel(overrides: Partial<ServedModel> = {}): ServedModel {
  return {
    modelId: "Small-q4f16_1-MLC",
    artifacts: `https://models.example.org/Small-q4f16_1-MLC/resolve/${REVISION}/`,
    modelLib: `https://models.example.org/libs/${REVISION}/Small-q4f16_1-webgpu.wasm`,
    requiredFeatures: ["shader-f16"],
    ...overrides,
  };
}

test("a served entry is loaded under its own identifier", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host, servedModel());

  assert.deepEqual(await runtime.probe(), {
    kind: "supported",
    modelId: "Small-q4f16_1-MLC",
    cached: false,
  });
});

test("a served entry with a moving revision is refused at construction", () => {
  assert.throws(
    () =>
      new LocalInferenceRuntime(
        new FakeHost(),
        servedModel({
          artifacts: "https://models.example.org/Small-q4f16_1-MLC/resolve/main/",
        }),
      ),
    (error: unknown) =>
      error instanceof LocalInferenceError && error.code === "invalid_catalog",
  );
});

test("a device clearing every floor is still refused the features its entry needs", async () => {
  const host = new FakeHost();
  host.probeResult = {
    supported: true,
    capability: capableAdapter({ features: ["timestamp-query"] }),
  };
  const runtime = new LocalInferenceRuntime(host, servedModel());

  assert.deepEqual(await runtime.probe(), {
    kind: "unavailable",
    modelId: "Small-q4f16_1-MLC",
    reason: "model_features_unavailable",
    missing: ["shader-f16"],
  });
  // The refusal is the model's, so it is reached without asking browser storage about a
  // download this surface would never use.
  assert.equal(host.cacheChecks, 0);
  assert.equal(host.engineCreations, 0);
});

test("a bare identifier still requires what its quantisation token implies", async () => {
  const host = new FakeHost();
  host.probeResult = { supported: true, capability: capableAdapter({ features: [] }) };
  const runtime = new LocalInferenceRuntime(host, DEFAULT_LOCAL_MODEL_ID);

  // The default identifier is `…-q4f16_1-…`, so its kernels are half precision. The
  // engine's own guard over `required_features` comes after two fetches and a device
  // acquisition, and this entry is one of the many the registry leaves it off — so an
  // adapter without `shader-f16` would otherwise reach the weight fetch before failing.
  assert.deepEqual(await runtime.probe(), {
    kind: "unavailable",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    reason: "model_features_unavailable",
    missing: ["shader-f16"],
  });
  assert.equal(host.cacheChecks, 0);
  assert.equal(host.engineCreations, 0);
});

test("an identifier declaring no quantisation has nothing derived from it", async () => {
  const host = new FakeHost();
  host.probeResult = { supported: true, capability: capableAdapter({ features: [] }) };
  const runtime = new LocalInferenceRuntime(host, "some-product-model");

  // Nothing is inferred from a name. An identifier that carries no token has not stated its
  // quantisation, and guessing at which kernels a WASM library contains is not this
  // package's to do on a product's behalf.
  assert.equal((await runtime.probe()).kind, "supported");
});

test("a full-precision identifier requires nothing extra", async () => {
  const host = new FakeHost();
  host.probeResult = { supported: true, capability: capableAdapter({ features: [] }) };
  const runtime = new LocalInferenceRuntime(host, "Llama-3.2-1B-Instruct-q4f32_1-MLC");

  assert.equal((await runtime.probe()).kind, "supported");
});

test("a download is cancelled without being reported as a failure", async () => {
  const host = new FakeHost();
  host.stall = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const seen: LocalInferenceState[] = [];
  runtime.subscribe((state) => seen.push(state));

  const loading = runtime.load();
  await settled();
  assert.equal(runtime.state.kind, "loading");

  runtime.cancelLoad();
  await assert.rejects(() => loading, isCode("load_cancelled"));

  // A cancelled load is not a failed one. `failed` is what a product renders as something
  // having gone wrong, and nothing did — a person asked for this.
  assert.ok(!seen.some((state) => state.kind === "failed"));
  assert.deepEqual(runtime.state, {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: false,
  });
});

test("a cancelled load re-reads the cache rather than restoring the old flag", async () => {
  const host = new FakeHost();
  host.stall = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const loading = runtime.load();
  await settled();
  // A partial download leaves whatever it completed in browser storage, so what the cache
  // holds after a cancellation is a fact to re-read, not the flag the load started from.
  host.cached = true;
  runtime.cancelLoad();
  await assert.rejects(() => loading, isCode("load_cancelled"));

  assert.deepEqual(runtime.state, {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: true,
  });
});

test("a caller's abort signal cancels the download it joined", async () => {
  const host = new FakeHost();
  host.stall = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const controller = new AbortController();
  const loading = runtime.load({ signal: controller.signal });
  await settled();
  assert.ok(host.lastSignal !== undefined, "the host is given a signal to abort on");

  controller.abort();
  await assert.rejects(() => loading, isCode("load_cancelled"));
});

test("a signal passed by a joining caller cancels the one shared download", async () => {
  const host = new FakeHost();
  host.stall = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const first = runtime.load();
  const controller = new AbortController();
  const second = runtime.load({ signal: controller.signal });
  await settled();
  assert.equal(host.engineCreations, 1, "one download, however many callers asked for it");

  controller.abort();
  // There is one download. It cannot be abandoned by one holder and continued for another,
  // so both callers are told the same thing.
  await assert.rejects(() => first, isCode("load_cancelled"));
  await assert.rejects(() => second, isCode("load_cancelled"));
});

test("a load asked for with an already-aborted signal starts nothing", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  await assert.rejects(
    () => runtime.load({ signal: AbortSignal.abort() }),
    isCode("load_cancelled"),
  );
  assert.equal(host.engineCreations, 0);
  assert.equal(runtime.state.kind, "supported");
});

test("an engine that finished building after the abort is released, not stranded", async () => {
  const host = new FakeHost();
  host.stall = true;
  host.ignoresSignal = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const checksBefore = host.cacheChecks;
  const loading = runtime.load();
  await settled();
  runtime.cancelLoad();
  // The abort landed first, but the engine was already on its way. Leaving it loaded while
  // reporting a cancelled load would strand a GPU allocation nothing holds a reference to.
  host.finishLoad?.();

  await assert.rejects(() => loading, isCode("load_cancelled"));
  assert.equal(host.engine.unloaded, true);
  assert.notEqual(runtime.state.kind, "ready");
  // The lifecycle settles once, not once per path the cancellation travelled through.
  assert.equal(host.cacheChecks - checksBefore, 1);
});

test("cancelling when no load is running does nothing", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  // A load that has already finished is not undone by cancelling it.
  runtime.cancelLoad();
  assert.equal(runtime.state.kind, "ready");
});

test("a load that finishes normally is unaffected by the cancellation machinery", async () => {
  const host = new FakeHost();
  host.stall = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const controller = new AbortController();
  const loading = runtime.load({ signal: controller.signal });
  await settled();
  host.finishLoad?.();
  await loading;

  assert.equal(runtime.state.kind, "ready");
  // The signal is spent: a load that already succeeded cannot be aborted out of `ready`.
  controller.abort();
  assert.equal(runtime.state.kind, "ready");
});

test("evict deletes the artifacts and re-reads what the cache holds", async () => {
  const host = new FakeHost();
  host.cached = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();
  assert.deepEqual(runtime.state, {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: true,
  });

  await runtime.evict();

  assert.deepEqual(host.evictions, [DEFAULT_LOCAL_MODEL_ID]);
  assert.deepEqual(runtime.state, {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: false,
  });
});

test("evict refuses while an engine is loaded from the artifacts it would delete", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  await assert.rejects(() => runtime.evict(), isCode("busy"));
  assert.deepEqual(host.evictions, []);

  await runtime.unload();
  await runtime.evict();
  assert.deepEqual(host.evictions, [DEFAULT_LOCAL_MODEL_ID]);
});

test("evict refuses while a download is in progress", async () => {
  const host = new FakeHost();
  host.stall = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const loading = runtime.load();
  await settled();
  await assert.rejects(() => runtime.evict(), isCode("busy"));

  runtime.cancelLoad();
  await assert.rejects(() => loading, isCode("load_cancelled"));
});

test("a device that can no longer run a model can still give its storage back", async () => {
  const host = new FakeHost();
  host.probeResult = { supported: false, reason: "webgpu_adapter_unavailable" };
  host.cached = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  await runtime.evict();

  assert.deepEqual(host.evictions, [DEFAULT_LOCAL_MODEL_ID]);
  // The verdict about the device is untouched: evicting a download says nothing about
  // whether this surface could run the model.
  assert.deepEqual(runtime.state, {
    kind: "unavailable",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    reason: "webgpu_adapter_unavailable",
  });
});

test("a failed eviction is raised without reporting the model as broken", async () => {
  const host = new FakeHost();
  host.evictionFails = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  await assert.rejects(() => runtime.evict(), isCode("evict_failed"));
  // A cache entry that would not go away changes nothing about what this device can run.
  assert.deepEqual(runtime.state, {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: false,
  });
});

test("a decode constraint reaches the engine unchanged", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  const grammar = 'root ::= "north" | "south"';
  for await (const _chunk of runtime.stream(
    [{ role: "user", content: "куди" }],
    { responseFormat: { type: "grammar", grammar } },
  )) {
    // draining the stream is what invokes the engine
  }

  assert.deepEqual(host.engine.lastOptions?.responseFormat, {
    type: "grammar",
    grammar,
  });
});

test("an unconstrained decode says so explicitly rather than omitting the field", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  for await (const _chunk of runtime.stream([{ role: "user", content: "привіт" }])) {
    // draining the stream is what invokes the engine
  }

  // An engine cannot ignore a constraint by reading a field that was never there.
  assert.ok(host.engine.lastOptions !== undefined);
  assert.ok("responseFormat" in host.engine.lastOptions);
  assert.equal(host.engine.lastOptions.responseFormat, undefined);
});

test("an explicitly unconstrained format is carried, not treated as empty", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  // `text` imposes nothing, which is the same as leaving the field unset — but a product
  // that says so out loud must not be refused for it the way an empty grammar is.
  for await (const _chunk of runtime.stream([{ role: "user", content: "привіт" }], {
    responseFormat: { type: "text" },
  })) {
    // draining the stream is what invokes the engine
  }

  assert.deepEqual(host.engine.lastOptions?.responseFormat, { type: "text" });
  assert.equal(runtime.state.kind, "ready");
});

test("an empty constraint is refused before the engine is invoked", async () => {
  for (const responseFormat of [
    { type: "grammar", grammar: "   " } as const,
    { type: "json_object", schema: "" } as const,
  ]) {
    const host = new FakeHost();
    const runtime = new LocalInferenceRuntime(host);
    await runtime.load();

    await assert.rejects(
      async () => {
        for await (const _chunk of runtime.stream(
          [{ role: "user", content: "привіт" }],
          { responseFormat },
        )) {
          // The iterator must fail before yielding.
        }
      },
      (error: unknown) =>
        error instanceof LocalInferenceError && error.code === "invalid_request",
    );
    // A constraint that constrains nothing would read as a constrained decode at every
    // call site while letting the model produce anything at all.
    assert.equal(host.engine.lastOptions, undefined);
    assert.equal(runtime.state.kind, "ready");
  }
});

test("only explicit load creates an engine and reaches ready", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  const states: LocalInferenceState[] = [];
  runtime.subscribe((state) => states.push(state));

  await runtime.probe();
  assert.equal(host.engineCreations, 0);
  await runtime.load();

  assert.equal(host.engineCreations, 1);
  assert.equal(runtime.state.kind, "ready");
  assert.equal(isLocalModelOperational(runtime.state), true);
  assert.ok(
    states.some(
      (state) =>
        state.kind === "loading" &&
        state.progress === 0.5 &&
        state.timeElapsed === 7 &&
        state.text === "halfway",
    ),
  );
});

test("a load that has started but not been described carries no text of ours", async () => {
  const host = new FakeHost();
  host.stall = true;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.probe();

  const states: LocalInferenceState[] = [];
  runtime.subscribe((state) => states.push(state));
  const loading = runtime.load();
  await settled();

  const first = states.find((state) => state.kind === "loading");
  assert.ok(first !== undefined && first.kind === "loading");
  // This package used to write "downloading model" here: an English UI label encoding what
  // `cachedBeforeLoad` already says, indistinguishable from the engine's own reports.
  assert.equal(first.text, undefined);
  assert.equal(first.cachedBeforeLoad, false);
  assert.equal(first.timeElapsed, 0);

  runtime.cancelLoad();
  await assert.rejects(() => loading, isCode("load_cancelled"));
});

test("an engine reporting a negative elapsed time is not believed", async () => {
  const host = new FakeHost();
  host.progressReports = [{ progress: 0.25, timeElapsed: -3, text: "odd" }];
  const runtime = new LocalInferenceRuntime(host);

  const states: LocalInferenceState[] = [];
  runtime.subscribe((state) => states.push(state));
  await runtime.load();

  // A negative elapsed time is not a duration. It is clamped for the same reason `progress`
  // is: the value is the engine's reading, and this package does not pass on a reading that
  // cannot be true.
  assert.ok(
    states.some((state) => state.kind === "loading" && state.timeElapsed === 0),
  );
});

test("rejects unbounded generation options before invoking the engine", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  await assert.rejects(
    async () => {
      for await (const _chunk of runtime.stream(
        [{ role: "user", content: "Привіт" }],
        { maxTokens: 513 },
      )) {
        // The iterator must fail before yielding.
      }
    },
    (error: unknown) =>
      error instanceof LocalInferenceError && error.code === "invalid_request",
  );
  assert.equal(runtime.state.kind, "ready");
});

test("streams local text and returns to ready", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();
  const output: string[] = [];

  for await (const chunk of runtime.stream([
    { role: "user", content: "Привіт" },
  ])) {
    output.push(chunk);
  }

  assert.equal(output.join(""), "вітаю");
  assert.equal(runtime.state.kind, "ready");
});

test("cancelling a stream interrupts generation and restores ready", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  for await (const _chunk of runtime.stream([
    { role: "user", content: "Привіт" },
  ])) {
    break;
  }

  assert.equal(host.engine.interrupted, true);
  assert.equal(runtime.state.kind, "ready");
});

test("refuses generation before the model is ready", async () => {
  const runtime = new LocalInferenceRuntime(new FakeHost());

  await assert.rejects(
    async () => {
      for await (const _chunk of runtime.stream([
        { role: "user", content: "Привіт" },
      ])) {
        // The iterator must fail before yielding.
      }
    },
    (error: unknown) =>
      error instanceof LocalInferenceError && error.code === "not_ready",
  );
});

test("unload releases GPU resources and reports observed cache state", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();
  // A completed load left artifacts in browser cache.
  host.cached = true;

  await runtime.unload();

  assert.equal(host.engine.unloaded, true);
  assert.deepEqual(runtime.state, {
    kind: "supported",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    cached: true,
  });
});

test("a failed generation is observable and blocks further generation", async () => {
  const host = new FakeHost();
  host.engine.failAfter = 1;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  await assert.rejects(
    async () => {
      for await (const _chunk of runtime.stream([
        { role: "user", content: "привіт" },
      ])) {
        // draining the stream is what surfaces the engine failure
      }
    },
    (error: unknown) =>
      error instanceof LocalInferenceError &&
      error.code === "generation_failed",
  );

  assert.equal(runtime.state.kind, "failed");
  assert.equal(isLocalModelOperational(runtime.state), false);

  // The state a product renders as unavailable is not a state that still generates.
  await assert.rejects(
    async () => {
      for await (const _chunk of runtime.stream([
        { role: "user", content: "знову" },
      ])) {
        // unreachable
      }
    },
    (error: unknown) =>
      error instanceof LocalInferenceError && error.code === "not_ready",
  );
});

test("loading again recovers a failed generation without downloading", async () => {
  const host = new FakeHost();
  host.engine.failAfter = 0;
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();
  assert.equal(host.engineCreations, 1);

  await assert.rejects(async () => {
    for await (const _chunk of runtime.stream([
      { role: "user", content: "привіт" },
    ])) {
      // unreachable
    }
  });
  assert.equal(runtime.state.kind, "failed");

  host.engine.failAfter = undefined;
  await runtime.load();

  assert.deepEqual(runtime.state, {
    kind: "ready",
    modelId: DEFAULT_LOCAL_MODEL_ID,
  });
  assert.equal(host.engineCreations, 1, "recovery creates no new engine");

  const received: string[] = [];
  for await (const chunk of runtime.stream([
    { role: "user", content: "привіт" },
  ])) {
    received.push(chunk);
  }
  assert.deepEqual(received, ["ві", "таю"]);
  assert.equal(isLocalModelOperational(runtime.state), true);
});

test("a load with no preceding probe still refuses a device the model needs more than", async () => {
  const host = new FakeHost();
  host.probeResult = { supported: true, capability: capableAdapter({ features: [] }) };
  // `load()` is a supported entry point on its own — nothing requires a `probe()` first —
  // so a requirement checked only inside `probe()` is not a requirement at all.
  const runtime = new LocalInferenceRuntime(host, DEFAULT_LOCAL_MODEL_ID);

  await assert.rejects(() => runtime.load(), isCode("unavailable"));
  assert.equal(host.engineCreations, 0);
  assert.deepEqual(runtime.state, {
    kind: "unavailable",
    modelId: DEFAULT_LOCAL_MODEL_ID,
    reason: "model_features_unavailable",
    missing: ["shader-f16"],
  });
});
