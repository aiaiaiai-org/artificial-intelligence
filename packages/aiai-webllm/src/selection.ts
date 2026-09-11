// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import {
  effectiveRequiredFeatures,
  validateServedCatalog,
  type ServedCatalog,
  type ServedModel,
} from "./catalog.js";
import {
  belowRuntimeFloor,
  missingFeatures,
  type DeviceCapability,
  type DeviceLimit,
} from "./contracts.js";

/**
 * Choosing which of a product's models a given device is served.
 *
 * A catalog that serves one model refuses every device that cannot run it. A catalog that
 * serves a half-precision entry and a full-precision one can serve both kinds of device —
 * but only if something picks between them, and picking is the part a product should not
 * have to write against WebGPU feature strings.
 *
 * What "best" means is the product's, not this package's: the catalog's order **is** the
 * preference, and the first entry the device can actually run is the one selected. This
 * package has no view on which model is better, no quality metric, and no way to acquire
 * one — so it reads the order a product already had to choose rather than inventing a
 * ranking to override it.
 */

/** One entry that was passed over, and what the adapter did not offer it. */
export interface RejectedModel {
  readonly modelId: string;
  /** Features this entry requires — declared or implied — that the adapter did not offer. */
  readonly missing: readonly string[];
}

/**
 * Which entry a device is served, or why none of them.
 *
 * The refusal reasons are the same values `LocalInferenceState` carries, so a product
 * renders one vocabulary rather than translating between two.
 */
export type ModelSelection =
  | { readonly selected: true; readonly model: ServedModel }
  /** No entry can run: the device is short of a limit the runtime demands of every model. */
  | {
      readonly selected: false;
      readonly reason: "device_limits_insufficient";
      readonly limit: DeviceLimit;
    }
  /** Every entry needs something this adapter does not offer. Each says what. */
  | {
      readonly selected: false;
      readonly reason: "model_features_unavailable";
      readonly rejected: readonly RejectedModel[];
    };

/**
 * Returns the first entry in `catalog` that `capability` can run.
 *
 * The runtime floor is checked once and refuses the whole catalog, because it is the
 * engine's requirement rather than any model's: a device short of one starts no engine
 * whatever entry it is handed, so trying the next one would be trying the same thing again.
 *
 * When every entry is refused for its features, each refusal is reported with the entry it
 * belongs to. No aggregate is invented: "this device is missing A and B" would be false of
 * a catalog where one entry needs A and another needs B, and a product showing a person
 * what their device lacks should not be handed a sentence that is true of no model in it.
 *
 * The catalog is validated first, for the reason it always is — every way of getting one
 * wrong is otherwise discovered by a person waiting on a model that will not arrive.
 */
export function selectServedModel(
  catalog: ServedCatalog,
  capability: DeviceCapability,
): ModelSelection {
  validateServedCatalog(catalog);

  const short = belowRuntimeFloor(capability);
  if (short !== undefined) {
    return {
      selected: false,
      reason: "device_limits_insufficient",
      limit: short,
    };
  }

  const rejected: RejectedModel[] = [];
  for (const model of catalog.models) {
    const missing = missingFeatures(
      capability,
      effectiveRequiredFeatures(model),
    );
    if (missing.length === 0) {
      return { selected: true, model };
    }
    rejected.push({ modelId: model.modelId, missing });
  }

  return {
    selected: false,
    reason: "model_features_unavailable",
    rejected,
  };
}
