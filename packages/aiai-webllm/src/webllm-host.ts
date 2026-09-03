// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import {
  CreateWebWorkerMLCEngine,
  hasModelInCache,
  type InitProgressReport,
  type MLCEngineInterface,
} from "@mlc-ai/web-llm";
import type {
  GenerationOptions,
  LoadProgress,
  LocalInferenceHost,
  LocalMessage,
  LocalTextEngine,
  WebGpuProbe,
} from "./contracts.js";

interface GpuNavigator {
  readonly gpu?: {
    requestAdapter(): Promise<unknown | null>;
  };
}

export type WorkerFactory = () => Worker;

class WebLlmTextEngine implements LocalTextEngine {
  public constructor(
    private readonly engine: MLCEngineInterface,
    private readonly worker: Worker,
  ) {}

  public async *stream(
    messages: readonly LocalMessage[],
    options: Required<GenerationOptions>,
  ): AsyncIterable<string> {
    const chunks = await this.engine.chat.completions.create({
      messages: [...messages],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      extra_body: { enable_thinking: false },
    });
    for await (const chunk of chunks) {
      const content = chunk.choices[0]?.delta.content;
      if (typeof content === "string") {
        yield content;
      }
    }
  }

  public interrupt(): void {
    this.engine.interruptGenerate();
  }

  public async unload(): Promise<void> {
    try {
      await this.engine.unload();
    } finally {
      this.worker.terminate();
    }
  }
}

/** Production browser host for WebLLM. */
export class WebLlmBrowserHost implements LocalInferenceHost {
  readonly #workerFactory: WorkerFactory;

  public constructor(
    workerFactory: WorkerFactory = () =>
      new Worker(new URL("./webllm-worker.js", import.meta.url), { type: "module" }),
  ) {
    this.#workerFactory = workerFactory;
  }

  public async probeWebGpu(): Promise<WebGpuProbe> {
    if (globalThis.isSecureContext === false) {
      return { supported: false, reason: "insecure_context" };
    }
    if (typeof navigator === "undefined") {
      return { supported: false, reason: "webgpu_missing" };
    }
    const gpu = (navigator as Navigator & GpuNavigator).gpu;
    if (gpu === undefined) {
      return { supported: false, reason: "webgpu_missing" };
    }
    const adapter = await gpu.requestAdapter();
    return adapter === null
      ? { supported: false, reason: "webgpu_adapter_unavailable" }
      : { supported: true };
  }

  public hasModelInCache(modelId: string): Promise<boolean> {
    return hasModelInCache(modelId);
  }

  public async createEngine(
    modelId: string,
    onProgress: (progress: LoadProgress) => void,
  ): Promise<LocalTextEngine> {
    const worker = this.#workerFactory();
    try {
      const engine = await CreateWebWorkerMLCEngine(worker, modelId, {
        initProgressCallback: (report: InitProgressReport) =>
          onProgress({ progress: report.progress, text: report.text }),
      });
      return new WebLlmTextEngine(engine, worker);
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }
}
