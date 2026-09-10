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
  public engine = new FakeEngine();

  public async probeWebGpu(): Promise<WebGpuProbe> {
    return this.probeResult;
  }

  public async hasModelInCache(_modelId: string): Promise<boolean> {
    this.cacheChecks += 1;
    return this.cached;
  }

  public async createEngine(
    _modelId: string,
    onProgress: (progress: LoadProgress) => void,
  ): Promise<LocalTextEngine> {
    this.engineCreations += 1;
    onProgress({ progress: 0.5, text: "halfway" });
    return this.engine;
  }
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

test("a bare model identifier states no feature requirement of its own", async () => {
  const host = new FakeHost();
  host.probeResult = { supported: true, capability: capableAdapter({ features: [] }) };
  const runtime = new LocalInferenceRuntime(host, DEFAULT_LOCAL_MODEL_ID);

  // This adapter takes no view on which model a product serves. An identifier from the
  // prebuilt registry declares nothing here, so nothing is refused on its behalf.
  assert.equal((await runtime.probe()).kind, "supported");
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
        state.text === "halfway",
    ),
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
