// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

export {
  belowRuntimeFloor,
  DEFAULT_LOCAL_MODEL_ID,
  DEVICE_LIMITS,
  isLocalModelOperational,
  LocalInferenceError,
  missingFeatures,
  RUNTIME_DEVICE_FLOORS,

  type DeviceCapability,
  type DeviceLimit,
  type GenerationOptions,
  type LoadProgress,
  type LocalInferenceErrorCode,
  type LocalInferenceHost,
  type LocalInferenceState,
  type LocalMessage,
  type LocalTextEngine,
  type MessageRole,
  type ResolvedGenerationOptions,
  type ResponseConstraint,
  type UnavailableReason,
  type WebGpuProbe,
  type WebGpuUnavailableReason,
} from "./contracts.js";
export {
  effectiveRequiredFeatures,
  findServedModel,
  validateServedCatalog,
  validateServedModel,
  type ArtifactIntegrity,
  type CacheBackend,
  type ServedCatalog,
  type ServedModel,
} from "./catalog.js";
export {
  parseQuantization,
  requiredFeaturesFor,
  requiredFeaturesForQuantization,
  SHADER_F16,
  type ActivationDtype,
  type Quantization,
} from "./quantization.js";
export {
  selectServedModel,
  type ModelSelection,
  type RejectedModel,
} from "./selection.js";
export {
  LocalInferenceRuntime,
  type LoadOptions,
  type StateListener,
} from "./runtime.js";
export {
  completedPrebuiltAppConfig,
  toAppConfig,
  WebLlmBrowserHost,
  type WebLlmBrowserHostOptions,
  type WorkerFactory,
} from "./webllm-host.js";
