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

/** Product-selected generation limits. The adapter grants no capabilities. */
export interface GenerationOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
}

export interface LoadProgress {
  readonly progress: number;
  readonly text: string;
}

export type UnavailableReason =
  | "insecure_context"
  | "webgpu_missing"
  | "webgpu_adapter_unavailable";

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
      readonly cachedBeforeLoad: boolean;
      readonly progress: number;
      readonly text: string;
    }
  | { readonly kind: "ready"; readonly modelId: string }
  | { readonly kind: "generating"; readonly modelId: string }
  | {
      readonly kind: "unavailable";
      readonly modelId: string;
      readonly reason: UnavailableReason;
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
  | "generation_failed"
  | "invalid_request"
  | "load_failed"
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

export interface WebGpuProbe {
  readonly supported: boolean;
  readonly reason?: UnavailableReason;
}

/** Minimal engine surface kept behind the Web Worker boundary. */
export interface LocalTextEngine {
  stream(
    messages: readonly LocalMessage[],
    options: Required<GenerationOptions>,
  ): AsyncIterable<string>;
  interrupt(): void;
  unload(): Promise<void>;
}

/** Injectable host boundary; tests never need a GPU or a model download. */
export interface LocalInferenceHost {
  probeWebGpu(): Promise<WebGpuProbe>;
  hasModelInCache(modelId: string): Promise<boolean>;
  createEngine(
    modelId: string,
    onProgress: (progress: LoadProgress) => void,
  ): Promise<LocalTextEngine>;
}
