// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_LOCAL_MODEL_ID,
  LocalInferenceError,
  type GenerationOptions,
  type LocalInferenceHost,
  type LocalInferenceState,
  type LocalMessage,
  type LocalTextEngine,
} from "./contracts.js";

const DEFAULT_GENERATION_OPTIONS: Required<GenerationOptions> = {
  maxTokens: 128,
  temperature: 0.7,
  topP: 0.8,
};
const MAX_GENERATION_TOKENS = 512;

export type StateListener = (state: LocalInferenceState) => void;

/**
 * Explicit lifecycle for one browser-local text model.
 *
 * Construction and probing never download a model. `load` is the sole operation allowed
 * to create an engine and may therefore download model artifacts into browser storage.
 */
export class LocalInferenceRuntime {
  readonly #host: LocalInferenceHost;
  readonly #modelId: string;
  readonly #listeners = new Set<StateListener>();
  #engine: LocalTextEngine | undefined;
  #loadOperation: Promise<void> | undefined;
  #state: LocalInferenceState;

  public constructor(
    host: LocalInferenceHost,
    modelId: string = DEFAULT_LOCAL_MODEL_ID,
  ) {
    this.#host = host;
    this.#modelId = modelId;
    this.#state = { kind: "idle", modelId };
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
          reason: webGpu.reason ?? "webgpu_adapter_unavailable",
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
    if (messages.length === 0 || messages.some((message) => message.content.trim() === "")) {
      throw new LocalInferenceError(
        "invalid_request",
        "at least one non-empty message is required",
      );
    }

    const resolvedOptions = {
      ...DEFAULT_GENERATION_OPTIONS,
      ...options,
    };
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
      this.#setState({
        kind: "supported",
        modelId: this.#modelId,
        cached: true,
      });
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
