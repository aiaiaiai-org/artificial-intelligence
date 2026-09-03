// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalInferenceError,
  LocalInferenceRuntime,
  DEFAULT_LOCAL_MODEL_ID,
  isLocalModelOperational,
  type GenerationOptions,
  type LoadProgress,
  type LocalInferenceHost,
  type LocalInferenceState,
  type LocalMessage,
  type LocalTextEngine,
  type WebGpuProbe,
} from "../src/index.js";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

class FakeEngine implements LocalTextEngine {
  public interrupted = false;
  public unloaded = false;
  public chunks = ["ві", "таю"];

  public async *stream(
    _messages: readonly LocalMessage[],
    _options: Required<GenerationOptions>,
  ): AsyncIterable<string> {
    for (const chunk of this.chunks) {
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

class FakeHost implements LocalInferenceHost {
  public probeResult: WebGpuProbe = { supported: true };
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

test("unload releases GPU resources but keeps cache availability", async () => {
  const host = new FakeHost();
  const runtime = new LocalInferenceRuntime(host);
  await runtime.load();

  await runtime.unload();

  assert.equal(host.engine.unloaded, true);
  assert.deepEqual(runtime.state, {
    kind: "supported",
    modelId: "Qwen3-0.6B-q4f16_1-MLC",
    cached: true,
  });
});
