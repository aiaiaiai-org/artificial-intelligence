// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import {
  CreateWebWorkerMLCEngine,
  hasModelInCache,
  type AppConfig,
  type InitProgressReport,
  type MLCEngineInterface,
  type ModelRecord,
  type ResponseFormat,
} from "@mlc-ai/web-llm";
import {
  validateServedCatalog,
  type ServedCatalog,
  type ServedModel,
} from "./catalog.js";
import { LocalInferenceError } from "./contracts.js";
import {
  DEVICE_LIMITS,
  type ResponseConstraint,
  type DeviceCapability,
  type DeviceLimit,
  type LoadProgress,
  type LocalInferenceHost,
  type LocalMessage,
  type LocalTextEngine,
  type ResolvedGenerationOptions,
  type WebGpuProbe,
} from "./contracts.js";

/**
 * The part of `GPUAdapter` this host reads, described structurally so the package needs no
 * ambient WebGPU type definitions to compile.
 */
interface GpuAdapter {
  readonly features: Iterable<string>;
  readonly limits?: Partial<Record<DeviceLimit, number>>;
}

interface GpuNavigator {
  readonly gpu?: {
    requestAdapter(): Promise<GpuAdapter | null>;
  };
}

/**
 * Reads an adapter into a capability.
 *
 * A limit the adapter does not report is left absent rather than defaulted, so that "this
 * device grants very little" and "this adapter did not say" stay two different facts. Only
 * the first of them refuses.
 */
function readCapability(adapter: GpuAdapter): DeviceCapability {
  const limits = adapter.limits ?? {};
  const measured: Partial<Record<DeviceLimit, number>> = {};
  for (const limit of DEVICE_LIMITS) {
    const reported = limits[limit];
    if (typeof reported === "number") {
      measured[limit] = reported;
    }
  }
  return { features: [...adapter.features], ...measured };
}

export type WorkerFactory = () => Worker;

/** Maps one served entry onto the record the pinned runtime consumes. */
function toModelRecord(model: ServedModel): ModelRecord {
  const record: ModelRecord = {
    model: model.artifacts,
    model_id: model.modelId,
    model_lib: model.modelLib,
  };
  if (model.requiredFeatures !== undefined) {
    record.required_features = [...model.requiredFeatures];
  }
  if (model.vramRequiredMb !== undefined) {
    record.vram_required_MB = model.vramRequiredMb;
  }
  if (model.contextWindowSize !== undefined) {
    record.overrides = { context_window_size: model.contextWindowSize };
  }
  if (model.integrity !== undefined) {
    record.integrity = {
      ...(model.integrity.config !== undefined
        ? { config: model.integrity.config }
        : {}),
      ...(model.integrity.modelLib !== undefined
        ? { model_lib: model.integrity.modelLib }
        : {}),
      ...(model.integrity.tokenizer !== undefined
        ? { tokenizer: { ...model.integrity.tokenizer } }
        : {}),
      // A hash that is present and does not match is a fact, not a warning. An artifact
      // that fails verification is the one case where continuing is worse than stopping.
      onFailure: "error",
    };
  }
  return record;
}

/** Builds the app config a served catalog describes. */
export function toAppConfig(catalog: ServedCatalog): AppConfig {
  validateServedCatalog(catalog);
  const config: AppConfig = { model_list: catalog.models.map(toModelRecord) };
  return catalog.cacheBackend === undefined
    ? config
    : { ...config, cacheBackend: catalog.cacheBackend };
}

/** Maps a product's constraint onto the pinned runtime's response format. */
function toResponseFormat(
  constraint: ResponseConstraint | undefined,
): ResponseFormat | undefined {
  if (constraint === undefined) {
    return undefined;
  }
  switch (constraint.type) {
    case "text":
      return { type: "text" };
    case "grammar":
      return { type: "grammar", grammar: constraint.grammar };
    case "json_object":
      return { type: "json_object", schema: constraint.schema };
  }
}

/** Options for the production browser host. */
export interface WebLlmBrowserHostOptions {
  readonly workerFactory?: WorkerFactory;
  /**
   * The models this product serves from its own origin. Left unset, the host falls back to
   * the pinned runtime's prebuilt registry, which is a third party's mirror on a revision
   * this product does not control.
   */
  readonly catalog?: ServedCatalog;
  /**
   * The pinned runtime's own configuration, for a product that already builds one or needs
   * a shape {@link ServedCatalog} does not describe. It is passed through unchecked, which
   * is the whole difference between the two: `catalog` is this package's opinion about what
   * a mirror must get right, and this is the way out of that opinion.
   *
   * Mutually exclusive with `catalog`.
   */
  readonly appConfig?: AppConfig;
}

class WebLlmTextEngine implements LocalTextEngine {
  public constructor(
    private readonly engine: MLCEngineInterface,
    private readonly worker: Worker,
  ) {}

  public async *stream(
    messages: readonly LocalMessage[],
    options: ResolvedGenerationOptions,
  ): AsyncIterable<string> {
    const responseFormat = toResponseFormat(options.responseFormat);
    const chunks = await this.engine.chat.completions.create({
      messages: [...messages],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      extra_body: { enable_thinking: false },
      ...(responseFormat === undefined
        ? {}
        : { response_format: responseFormat }),
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
  readonly #appConfig: AppConfig | undefined;

  public constructor(options: WebLlmBrowserHostOptions = {}) {
    this.#workerFactory =
      options.workerFactory ??
      (() =>
        new Worker(new URL("./webllm-worker.js", import.meta.url), {
          type: "module",
        }));
    if (options.catalog !== undefined && options.appConfig !== undefined) {
      throw new LocalInferenceError(
        "invalid_catalog",
        "pass either a served catalog or an app config, not both",
      );
    }
    // A catalog is checked when it is handed over, not when a download fails: every way of
    // getting one wrong is otherwise found by a person waiting for a model that never
    // arrives.
    this.#appConfig =
      options.catalog === undefined
        ? options.appConfig
        : toAppConfig(options.catalog);
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
      : { supported: true, capability: readCapability(adapter) };
  }

  public hasModelInCache(modelId: string): Promise<boolean> {
    // Cache lookup resolves artifact URLs, so it has to read the same catalog the load
    // will: asking the prebuilt registry about a self-served model reports the wrong cache.
    return hasModelInCache(modelId, this.#appConfig);
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
        ...(this.#appConfig === undefined
          ? {}
          : { appConfig: this.#appConfig }),
      });
      return new WebLlmTextEngine(engine, worker);
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }
}
