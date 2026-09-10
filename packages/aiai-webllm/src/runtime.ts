// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import { validateServedModel, type ServedModel } from "./catalog.js";
import {
  belowRuntimeFloor,
  DEFAULT_LOCAL_MODEL_ID,
  LocalInferenceError,
  missingFeatures,
  type ResponseConstraint,
  type GenerationOptions,
  type LocalInferenceHost,
  type LocalInferenceState,
  type LocalMessage,
  type LocalTextEngine,
  type ResolvedGenerationOptions,
} from "./contracts.js";

const DEFAULT_GENERATION_OPTIONS = {
  maxTokens: 128,
  temperature: 0.7,
  topP: 0.8,
  responseFormat: undefined,
} satisfies ResolvedGenerationOptions;
const MAX_GENERATION_TOKENS = 512;

export type StateListener = (state: LocalInferenceState) => void;

/**
 * Refuses a constraint that would not constrain anything.
 *
 * An empty grammar or schema is worse than none: it reads as a constrained decode at every
 * call site while placing no constraint on the decoder at all, so a product would parse
 * arbitrary text believing it could not be arbitrary.
 */
function assertUsableConstraint(
  constraint: ResponseConstraint | undefined,
): void {
  if (constraint === undefined || constraint.type === "text") {
    return;
  }
  const body =
    constraint.type === "grammar" ? constraint.grammar : constraint.schema;
  if (typeof body !== "string" || body.trim() === "") {
    throw new LocalInferenceError(
      "invalid_request",
      `a ${constraint.type} response format must not be empty`,
    );
  }
}

/**
 * Explicit lifecycle for one browser-local text model.
 *
 * Construction and probing never download a model. `load` is the sole operation allowed
 * to create an engine and may therefore download model artifacts into browser storage.
 */
export class LocalInferenceRuntime {
  readonly #host: LocalInferenceHost;
  readonly #modelId: string;
  readonly #requiredFeatures: readonly string[];
  readonly #listeners = new Set<StateListener>();
  #engine: LocalTextEngine | undefined;
  #loadOperation: Promise<void> | undefined;
  #state: LocalInferenceState;

  /**
   * Takes either a bare identifier from the pinned runtime's prebuilt registry, or a
   * {@link ServedModel} a product serves from its own origin.
   *
   * A served entry is the richer of the two because it states what it requires, which is
   * what lets `probe()` refuse a surface before a download instead of after one.
   */
  public constructor(
    host: LocalInferenceHost,
    model: string | ServedModel = DEFAULT_LOCAL_MODEL_ID,
  ) {
    if (typeof model === "string") {
      this.#modelId = model;
      this.#requiredFeatures = [];
    } else {
      validateServedModel(model);
      this.#modelId = model.modelId;
      this.#requiredFeatures = [...(model.requiredFeatures ?? [])];
    }
    this.#host = host;
    this.#state = { kind: "idle", modelId: this.#modelId };
  }

  public get state(): LocalInferenceState {
    return this.#state;
  }

  public subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  /** Detects WebGPU and cache state without downloading or initializing the model. */
  public async probe(): Promise<LocalInferenceState> {
    if (this.#engine !== undefined) {
      return this.#state;
    }
    if (this.#loadOperation !== undefined || this.#state.kind === "probing") {
      throw new LocalInferenceError("busy", "a model lifecycle operation is in progress");
    }

    this.#setState({ kind: "probing", modelId: this.#modelId });
    try {
      const webGpu = await this.#host.probeWebGpu();
      if (!webGpu.supported) {
        this.#setState({
          kind: "unavailable",
          modelId: this.#modelId,
          reason: webGpu.reason,
        });
        return this.#state;
      }

      // An adapter is not yet a runtime. The engine acquires a device with required limits
      // and throws if any is refused, so a device short of one starts nothing whatever
      // model it is asked for — refusing it here makes that a stated reason a product can
      // render, rather than a load failure a person has to interpret.
      const short = belowRuntimeFloor(webGpu.capability);
      if (short !== undefined) {
        this.#setState({
          kind: "unavailable",
          modelId: this.#modelId,
          reason: "device_limits_insufficient",
          limit: short,
        });
        return this.#state;
      }

      // Model-level requirements are the model's, not the runtime's. A device can clear
      // every floor and still be unable to run this entry.
      const missing = missingFeatures(webGpu.capability, this.#requiredFeatures);
      if (missing.length > 0) {
        this.#setState({
          kind: "unavailable",
          modelId: this.#modelId,
          reason: "model_features_unavailable",
          missing,
        });
        return this.#state;
      }

      const cached = await this.#host.hasModelInCache(this.#modelId);
      this.#setState({ kind: "supported", modelId: this.#modelId, cached });
    } catch (cause) {
      this.#setFailure("probe", false, cause);
    }
    return this.#state;
  }

  /**
   * Initializes the local engine, downloading the selected model when it is not cached.
   * Concurrent callers share the same load operation.
   */
  public load(): Promise<void> {
    if (this.#engine !== undefined) {
      // The engine is already initialized. Calling `load` again is how a product returns
      // an engine that failed one generation to `ready`; it never re-downloads.
      if (this.#state.kind !== "ready" && this.#state.kind !== "generating") {
        this.#setState({ kind: "ready", modelId: this.#modelId });
      }
      return Promise.resolve();
    }
    if (this.#state.kind === "unavailable") {
      return Promise.reject(
        new LocalInferenceError(
          "unavailable",
          `local inference is unavailable: ${this.#state.reason}`,
        ),
      );
    }
    if (this.#loadOperation !== undefined) {
      return this.#loadOperation;
    }

    const cachedBeforeLoad =
      this.#state.kind === "supported" ? this.#state.cached : false;
    const operation = this.#performLoad(cachedBeforeLoad);
    this.#loadOperation = operation;
    const clearOperation = () => {
      if (this.#loadOperation === operation) {
        this.#loadOperation = undefined;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  async #performLoad(cachedBeforeLoad: boolean): Promise<void> {
    this.#setState({
      kind: "loading",
      modelId: this.#modelId,
      cachedBeforeLoad,
      progress: 0,
      text: cachedBeforeLoad ? "preparing cached model" : "downloading model",
    });
    try {
      const engine = await this.#host.createEngine(this.#modelId, (report) => {
        this.#setState({
          kind: "loading",
          modelId: this.#modelId,
          cachedBeforeLoad,
          progress: Math.min(1, Math.max(0, report.progress)),
          text: report.text,
        });
      });
      this.#engine = engine;
      this.#setState({ kind: "ready", modelId: this.#modelId });
    } catch (cause) {
      this.#setFailure("load", false, cause);
      throw new LocalInferenceError("load_failed", "local model failed to load", {
        cause,
      });
    }
  }

  /** Streams text produced locally. Output is computation, never authority or an action. */
  public async *stream(
    messages: readonly LocalMessage[],
    options: GenerationOptions = {},
  ): AsyncGenerator<string, void, void> {
    const engine = this.#engine;
    if (engine === undefined) {
      throw new LocalInferenceError("not_ready", "local model is not ready");
    }
    if (this.#state.kind === "generating") {
      throw new LocalInferenceError("busy", "generation is already in progress");
    }
    // Only `ready` permits generation, so a state a product renders as unavailable is
    // never a state that quietly still generates. After a failed generation the engine is
    // still loaded; `load()` returns it to `ready` without downloading anything.
    if (this.#state.kind !== "ready") {
      throw new LocalInferenceError(
        "not_ready",
        `local model is not ready: ${this.#state.kind}`,
      );
    }
    if (messages.length === 0 || messages.some((message) => message.content.trim() === "")) {
      throw new LocalInferenceError(
        "invalid_request",
        "at least one non-empty message is required",
      );
    }

    const resolvedOptions: ResolvedGenerationOptions = {
      ...DEFAULT_GENERATION_OPTIONS,
      ...options,
    };
    assertUsableConstraint(resolvedOptions.responseFormat);
    if (
      !Number.isInteger(resolvedOptions.maxTokens) ||
      resolvedOptions.maxTokens < 1 ||
      resolvedOptions.maxTokens > MAX_GENERATION_TOKENS ||
      !Number.isFinite(resolvedOptions.temperature) ||
      resolvedOptions.temperature < 0 ||
      resolvedOptions.temperature > 2 ||
      !Number.isFinite(resolvedOptions.topP) ||
      resolvedOptions.topP <= 0 ||
      resolvedOptions.topP > 1
    ) {
      throw new LocalInferenceError(
        "invalid_request",
        "generation options are outside the supported bounds",
      );
    }
    this.#setState({ kind: "generating", modelId: this.#modelId });
    let completed = false;
    let failed = false;
    try {
      for await (const chunk of engine.stream(messages, resolvedOptions)) {
        if (chunk !== "") {
          yield chunk;
        }
      }
      completed = true;
    } catch (cause) {
      failed = true;
      this.#setFailure("generate", true, cause);
      throw new LocalInferenceError(
        "generation_failed",
        "local generation failed",
        { cause },
      );
    } finally {
      if (!failed) {
        if (!completed) {
          engine.interrupt();
        }
        this.#setState({ kind: "ready", modelId: this.#modelId });
      }
    }
  }

  public interrupt(): void {
    if (this.#state.kind === "generating") {
      this.#engine?.interrupt();
    }
  }

  /** Releases GPU resources but leaves downloaded artifacts in browser cache. */
  public async unload(): Promise<void> {
    if (this.#loadOperation !== undefined) {
      throw new LocalInferenceError("busy", "model loading is in progress");
    }
    const engine = this.#engine;
    if (engine === undefined) {
      return;
    }
    if (this.#state.kind === "generating") {
      throw new LocalInferenceError(
        "busy",
        "interrupt generation and wait for it to settle before unloading",
      );
    }
    try {
      await engine.unload();
      this.#engine = undefined;
      const cached = await this.#host.hasModelInCache(this.#modelId);
      this.#setState({ kind: "supported", modelId: this.#modelId, cached });
    } catch (cause) {
      this.#setFailure("unload", true, cause);
      throw new LocalInferenceError("unload_failed", "local model failed to unload", {
        cause,
      });
    }
  }

  #setFailure(
    operation: "probe" | "load" | "generate" | "unload",
    modelLoaded: boolean,
    cause: unknown,
  ): void {
    this.#setState({
      kind: "failed",
      modelId: this.#modelId,
      operation,
      modelLoaded,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }

  #setState(state: LocalInferenceState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch (error) {
        const reportError = (globalThis as { reportError?: (cause: unknown) => void })
          .reportError;
        reportError?.(error);
      }
    }
  }
}
