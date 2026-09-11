// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

/** The smallest Qwen3 model shipped in WebLLM's current prebuilt model registry. */
export const DEFAULT_LOCAL_MODEL_ID = "Qwen3-0.6B-q4f16_1-MLC";

export type MessageRole = "system" | "user" | "assistant";

/** One bounded text-only message supplied by a product runtime. */
export interface LocalMessage {
  readonly role: MessageRole;
  readonly content: string;
}

/**
 * A constraint the decoder must satisfy, so that a product parsing structured output is
 * parsing something the model could not have failed to produce.
 *
 * The constraint is the product's: this adapter neither writes grammars nor interprets what
 * a satisfying string means. Output remains computation — a constrained decode is a better
 * proposal, never an authority to act on it.
 */
export type ResponseConstraint =
  /** Impose nothing. The same as leaving the field unset, said out loud. */
  | { readonly type: "text" }
  /** An EBNF grammar the generated text must match. */
  | { readonly type: "grammar"; readonly grammar: string }
  /** A JSON schema, as a string, the generated object must satisfy. */
  | { readonly type: "json_object"; readonly schema: string };

/** Product-selected generation limits. The adapter grants no capabilities. */
export interface GenerationOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  /** Left unset, the decode is unconstrained and the model may produce any text. */
  readonly responseFormat?: ResponseConstraint;
}

/**
 * Generation limits after defaults are applied and bounds are checked.
 *
 * `responseFormat` stays explicitly `undefined` rather than being dropped, so an engine
 * cannot silently ignore a constraint by reading a field that was never there.
 */
export interface ResolvedGenerationOptions {
  readonly maxTokens: number;
  readonly temperature: number;
  readonly topP: number;
  readonly responseFormat: ResponseConstraint | undefined;
}

/**
 * One progress report from the engine while a model loads.
 *
 * There is no byte count here, and its absence is the pinned runtime's rather than a
 * choice. It computes `fetchedBytes / totalBytes` and then reports only that ratio and an
 * English sentence it renders from the same numbers, rounded to whole megabytes. Recovering
 * the bytes would mean parsing that sentence — a vendor's prose, in one language, changed
 * at its convenience — and a number obtained that way must not travel in a field whose name
 * says it was measured.
 */
export interface LoadProgress {
  /** Fraction of this phase completed, `0` to `1`. */
  readonly progress: number;
  /** Seconds the engine reports having spent so far. Measured by it, not by this package. */
  readonly timeElapsed: number;
  /**
   * The engine's own diagnostic line, such as `Fetching param cache[1/38]: 12MB fetched…`.
   *
   * It is untranslated English written for a developer watching a console, and it changes
   * with the pinned version. Render it as diagnostics if at all — the thing to show a
   * person is built from `progress`, `timeElapsed` and `cachedBeforeLoad`, in the product's
   * own words.
   */
  readonly text: string;
}

/**
 * Adapter limits `@mlc-ai/web-llm@0.2.84` requires before it will acquire a WebGPU device.
 *
 * These are the runtime's floors, not any model's. It asks for 1 GiB of buffer and
 * storage-binding headroom, falls back once to the values below, and throws if even those
 * are refused; the last two have no fallback at all. `maxStorageBuffersPerShaderStage` sits
 * above the WebGPU default of 8, so a device can be perfectly modern and still fail here.
 *
 * A device short of any of them loads nothing, whatever model it is asked for, which is why
 * the check runs at probe time rather than at the first failed `load()`.
 */
export const RUNTIME_DEVICE_FLOORS = {
  /** Smallest `maxBufferSize` the runtime will accept, in bytes (256 MiB). */
  maxBufferSize: 1 << 28,
  /** Smallest `maxStorageBufferBindingSize` the runtime will accept, in bytes (128 MiB). */
  maxStorageBufferBindingSize: 1 << 27,
  /** Required `maxComputeWorkgroupStorageSize`, in bytes (32 KiB). No fallback. */
  maxComputeWorkgroupStorageSize: 32 << 10,
  /** Required `maxStorageBuffersPerShaderStage`. No fallback; the WebGPU default is 8. */
  maxStorageBuffersPerShaderStage: 10,
} as const;

/** One adapter limit the runtime requires, named so a refusal can say which was short. */
export type DeviceLimit = keyof typeof RUNTIME_DEVICE_FLOORS;

/** Every limit in {@link RUNTIME_DEVICE_FLOORS}, in the order the floors are checked. */
export const DEVICE_LIMITS: readonly DeviceLimit[] = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxComputeWorkgroupStorageSize",
  "maxStorageBuffersPerShaderStage",
];

/**
 * What a WebGPU adapter reported about this device.
 *
 * Every field is something an adapter answers. There is no memory field, because WebGPU
 * exposes no memory budget and a value nobody can obtain must not travel in a type whose
 * name claims it was measured.
 *
 * A limit is `undefined` when the adapter did not report it, which is a different fact from
 * a low value and is treated differently — see {@link belowRuntimeFloor}. WebGPU requires an
 * adapter to expose every limit, so this is a reporting gap rather than a device trait.
 */
export interface DeviceCapability {
  /** Feature names the adapter offered, such as `shader-f16`. */
  readonly features: readonly string[];
  readonly maxBufferSize?: number;
  readonly maxStorageBufferBindingSize?: number;
  readonly maxComputeWorkgroupStorageSize?: number;
  readonly maxStorageBuffersPerShaderStage?: number;
}

/**
 * Returns the first limit reported below what the pinned runtime demands, or `undefined`
 * when nothing the adapter reported is short.
 *
 * A limit the adapter did not report is not short. An absent value is unknown, and refusing
 * on it would turn a reporting gap into a verdict about a device — the opposite mistake to
 * the one this check exists to prevent, and one a person could do nothing about. Such a
 * device reaches `load()` and, if the engine does refuse it, fails observably there.
 */
export function belowRuntimeFloor(
  capability: DeviceCapability,
): DeviceLimit | undefined {
  return DEVICE_LIMITS.find((limit) => {
    const reported = capability[limit];
    return (
      typeof reported === "number" &&
      Number.isFinite(reported) &&
      reported < RUNTIME_DEVICE_FLOORS[limit]
    );
  });
}

/**
 * Returns the requested features this adapter did not offer, in the order requested.
 *
 * A model's requirements are the model's, not the runtime's: this adapter takes no view on
 * which model a product serves and checks only what that entry declared it needs.
 */
export function missingFeatures(
  capability: DeviceCapability,
  required: readonly string[],
): readonly string[] {
  return required.filter((feature) => !capability.features.includes(feature));
}

/** Why a device offers no local model. */
export type UnavailableReason =
  | "insecure_context"
  | "webgpu_missing"
  | "webgpu_adapter_unavailable"
  | "device_limits_insufficient"
  | "model_features_unavailable";

/**
 * The three causes a WebGPU probe can observe on its own, before any limit is read.
 *
 * The remaining reasons are verdicts the runtime reaches from a capability, so a host
 * cannot report them and cannot skip them either.
 */
export type WebGpuUnavailableReason = Extract<
  UnavailableReason,
  "insecure_context" | "webgpu_missing" | "webgpu_adapter_unavailable"
>;

/**
 * Observable local-model lifecycle.
 *
 * Only `ready` and `generating` mean that computation is available on this device.
 * A cached model is not treated as available until its engine finishes loading.
 */
export type LocalInferenceState =
  | { readonly kind: "idle"; readonly modelId: string }
  | { readonly kind: "probing"; readonly modelId: string }
  | {
      readonly kind: "supported";
      readonly modelId: string;
      readonly cached: boolean;
    }
  | {
      readonly kind: "loading";
      readonly modelId: string;
      /**
       * Whether the artifacts were already in browser storage when the load began.
       *
       * This is what a product renders the difference from: preparing something already
       * downloaded is not the same event as downloading it, and only one of them is worth
       * warning somebody about on a metered connection.
       */
      readonly cachedBeforeLoad: boolean;
      readonly progress: number;
      readonly timeElapsed: number;
      /**
       * The engine's own diagnostic line — see {@link LoadProgress.text}.
       *
       * Absent until the engine has reported one, which is why this field is optional: a
       * load that has started but not yet been described is a real state, and filling it
       * with a sentence this package wrote would make an invented label indistinguishable
       * from a measured one.
       */
      readonly text?: string;
    }
  | { readonly kind: "ready"; readonly modelId: string }
  | { readonly kind: "generating"; readonly modelId: string }
  | {
      readonly kind: "unavailable";
      readonly modelId: string;
      readonly reason: UnavailableReason;
      /** Set only for `device_limits_insufficient`: the limit that was short. */
      readonly limit?: DeviceLimit;
      /** Set only for `model_features_unavailable`: features this entry needs and the adapter lacks. */
      readonly missing?: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly modelId: string;
      readonly operation: "probe" | "load" | "generate" | "unload";
      readonly modelLoaded: boolean;
      readonly message: string;
    };

/** True only after the model engine has initialized successfully on this device. */
export function isLocalModelOperational(state: LocalInferenceState): boolean {
  return state.kind === "ready" || state.kind === "generating";
}

export type LocalInferenceErrorCode =
  | "busy"
  | "evict_failed"
  | "generation_failed"
  | "invalid_request"
  | "load_cancelled"
  | "load_failed"
  | "invalid_catalog"
  | "not_ready"
  | "unavailable"
  | "unload_failed";

/** Stable error surface for the browser-local adapter. */
export class LocalInferenceError extends Error {
  public constructor(
    public readonly code: LocalInferenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalInferenceError";
  }
}

/**
 * What a host observed of this device's WebGPU support.
 *
 * A supported probe carries the capability it measured rather than a bare `true`, so the
 * runtime can refuse a device the engine would fail to start on without asking the host to
 * hold an opinion about floors.
 */
export type WebGpuProbe =
  | { readonly supported: true; readonly capability: DeviceCapability }
  | {
      readonly supported: false;
      readonly reason: WebGpuUnavailableReason;
    };

/** Minimal engine surface kept behind the Web Worker boundary. */
export interface LocalTextEngine {
  stream(
    messages: readonly LocalMessage[],
    options: ResolvedGenerationOptions,
  ): AsyncIterable<string>;
  interrupt(): void;
  unload(): Promise<void>;
}

/** Injectable host boundary; tests never need a GPU or a model download. */
export interface LocalInferenceHost {
  probeWebGpu(): Promise<WebGpuProbe>;
  hasModelInCache(modelId: string): Promise<boolean>;
  /**
   * Creates the engine, downloading artifacts that are not cached.
   *
   * `signal` aborts that download. This is the only operation in the adapter worth
   * abandoning midway: it is the one that can run for minutes over a connection somebody
   * is paying for, and a person who changes their mind about a download has no other way
   * to say so.
   */
  createEngine(
    modelId: string,
    onProgress: (progress: LoadProgress) => void,
    signal?: AbortSignal,
  ): Promise<LocalTextEngine>;
  /**
   * Deletes this model's downloaded artifacts from browser storage.
   *
   * `unload()` releases the GPU and keeps the download; this is the other half, and the
   * only way a product can offer to give the storage back. A model that was never
   * downloaded is not an error to evict.
   */
  evictModel(modelId: string): Promise<void>;
}
