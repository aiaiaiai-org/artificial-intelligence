// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import {
  CreateWebWorkerMLCEngine,
  deleteModelAllInfoInCache,
  hasModelInCache,
  prebuiltAppConfig,
  type AppConfig,
  type ChatOptions,
  type InitProgressReport,
  type MLCEngineInterface,
  type ModelRecord,
  type ResponseFormat,
} from "@mlc-ai/web-llm";
import {
  effectiveRequiredFeatures,
  validateServedCatalog,
  type ServedCatalog,
  type ServedModel,
} from "./catalog.js";
import { LocalInferenceError } from "./contracts.js";
import { requiredFeaturesFor } from "./quantization.js";
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

/**
 * Builds the KV-cache overrides one served entry asks for, or `undefined` when it asks for
 * none.
 *
 * A sliding window carries `context_window_size: -1` with it. That is not a default this
 * package prefers: the pinned runtime refuses a configuration where both windows are
 * positive, and a model's own `mlc-chat-config.json` normally declares a positive context
 * window — so an entry that set only `slidingWindowSize` would fail to load, naming a field
 * the product never wrote.
 */
function toChatOverrides(model: ServedModel): ChatOptions | undefined {
  const overrides: ChatOptions = {};
  if (model.contextWindowSize !== undefined) {
    overrides.context_window_size = model.contextWindowSize;
  }
  if (model.slidingWindowSize !== undefined) {
    overrides.sliding_window_size = model.slidingWindowSize;
    overrides.context_window_size = -1;
    if (model.attentionSinkSize !== undefined) {
      overrides.attention_sink_size = model.attentionSinkSize;
    }
  }
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

/** Maps one served entry onto the record the pinned runtime consumes. */
function toModelRecord(model: ServedModel): ModelRecord {
  const record: ModelRecord = {
    model: model.artifacts,
    model_id: model.modelId,
    model_lib: model.modelLib,
  };
  // What the entry declared, plus what its quantisation token implies. The engine reads
  // this list too, between acquiring a device and fetching the weights, so carrying the
  // derived requirement here makes that guard fire for an entry that declared nothing —
  // behind `probe()`, which has already refused before any of it.
  const features = effectiveRequiredFeatures(model);
  if (features.length > 0) {
    record.required_features = [...features];
  }
  if (model.vramRequiredMb !== undefined) {
    record.vram_required_MB = model.vramRequiredMb;
  }
  const overrides = toChatOverrides(model);
  if (overrides !== undefined) {
    record.overrides = overrides;
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

/**
 * The pinned runtime's prebuilt registry, with each record's `required_features` completed
 * from its own identifier.
 *
 * The engine's guard over that list sits between acquiring a GPU device and fetching the
 * weights, so a record that declares what it needs fails there — before the download. A
 * record that declares nothing skips the guard entirely and carries on into device
 * initialisation and the weight fetch, to fail somewhere past them. Most of the registry's
 * half-precision records declare nothing.
 *
 * Completing the list here is what makes that guard fire for them. It is a second line
 * behind `probe()`, which refuses before any fetch at all; this one covers a product using
 * the host without the runtime, and costs a copy of a list this package already loads.
 *
 * A product's own `appConfig` is left exactly as given — it is the documented way out of
 * this package's opinions, and this is one of them.
 */
export function completedPrebuiltAppConfig(): AppConfig {
  return {
    ...prebuiltAppConfig,
    model_list: prebuiltAppConfig.model_list.map((record) => {
      const declared = record.required_features ?? [];
      const features = requiredFeaturesFor(record.model_id, declared);
      // The derivation only ever adds, so an unchanged length means an unchanged record —
      // and a record that declared nothing and implies nothing keeps no list at all rather
      // than gaining an empty one.
      return features.length === declared.length
        ? record
        : { ...record, required_features: [...features] };
    }),
  };
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
   * this product does not control — and whose feature requirements are completed from its
   * own identifiers on the way through.
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
  readonly #appConfig: AppConfig;

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
    // arrives. With neither given, the prebuilt registry stands in — with the feature list
    // its own identifiers imply, which it does not reliably carry.
    this.#appConfig =
      options.catalog !== undefined
        ? toAppConfig(options.catalog)
        : (options.appConfig ?? completedPrebuiltAppConfig());
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
    signal?: AbortSignal,
  ): Promise<LocalTextEngine> {
    signal?.throwIfAborted();
    const worker = this.#workerFactory();
    let onAbort: (() => void) | undefined;
    try {
      const creation = CreateWebWorkerMLCEngine(worker, modelId, {
        initProgressCallback: (report: InitProgressReport) =>
          onProgress({
            progress: report.progress,
            timeElapsed: report.timeElapsed,
            text: report.text,
          }),
        appConfig: this.#appConfig,
      });
      if (signal === undefined) {
        return new WebLlmTextEngine(await creation, worker);
      }

      // Terminating the worker is what actually stops the download — the fetches belong to
      // it. The engine's own creation call takes no signal and, once its worker is gone,
      // its promise never settles at all, so it is raced rather than awaited and its
      // outcome is absorbed here so a cancelled load cannot surface later as an unhandled
      // rejection.
      void creation.catch(() => undefined);
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return new WebLlmTextEngine(await Promise.race([creation, cancelled]), worker);
    } catch (error) {
      worker.terminate();
      throw error;
    } finally {
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  public evictModel(modelId: string): Promise<void> {
    // Reads the same catalog the download did, for the same reason the cache check does:
    // deleting through the prebuilt registry would look through the wrong artifact URLs and
    // report a self-served model deleted while its weights stayed on the device.
    return deleteModelAllInfoInCache(modelId, this.#appConfig);
  }
}
