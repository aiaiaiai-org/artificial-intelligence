// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalInferenceError,
  RUNTIME_DEVICE_FLOORS,
  selectServedModel,
  type DeviceCapability,
  type ServedCatalog,
  type ServedModel,
} from "../src/index.js";

const REVISION = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

function servedModel(modelId: string): ServedModel {
  return {
    modelId,
    artifacts: `https://models.example.org/${modelId}/resolve/${REVISION}/`,
    modelLib: `https://models.example.org/libs/${REVISION}/${modelId}-webgpu.wasm`,
  };
}

/** An adapter clearing every runtime floor, so a test moves only what it means to move. */
function capableAdapter(features: readonly string[] = ["shader-f16"]): DeviceCapability {
  return {
    features: [...features],
    maxBufferSize: 1 << 30,
    maxStorageBufferBindingSize: 1 << 30,
    maxComputeWorkgroupStorageSize: 32 << 10,
    maxStorageBuffersPerShaderStage: 10,
  };
}

/** Half precision first, full precision behind it — the shape this function exists for. */
const catalog: ServedCatalog = {
  models: [servedModel("Small-q4f16_1-MLC"), servedModel("Small-q4f32_1-MLC")],
};

test("the catalog's order is the preference, and the first runnable entry wins", () => {
  const selection = selectServedModel(catalog, capableAdapter());

  assert.equal(selection.selected, true);
  assert.equal(
    selection.selected ? selection.model.modelId : undefined,
    "Small-q4f16_1-MLC",
  );
});

test("a device without half precision is served the entry behind it, not refused", () => {
  // Neither entry declares `requiredFeatures`. The half-precision one is skipped because
  // its identifier implies `shader-f16`, which is the whole point: a catalog written
  // without a single feature string still serves both kinds of device.
  const selection = selectServedModel(catalog, capableAdapter([]));

  assert.equal(selection.selected, true);
  assert.equal(
    selection.selected ? selection.model.modelId : undefined,
    "Small-q4f32_1-MLC",
  );
});

test("a runtime floor refuses the whole catalog once, not each entry in turn", () => {
  // The floor is the engine's requirement, not any model's: a device short of one starts no
  // engine whatever entry it is handed, so there is nothing to report per entry.
  const selection = selectServedModel(catalog, {
    ...capableAdapter(),
    maxStorageBuffersPerShaderStage:
      RUNTIME_DEVICE_FLOORS.maxStorageBuffersPerShaderStage - 1,
  });

  assert.deepEqual(selection, {
    selected: false,
    reason: "device_limits_insufficient",
    limit: "maxStorageBuffersPerShaderStage",
  });
});

test("when every entry is refused, each refusal names the entry it belongs to", () => {
  const twoRequirements: ServedCatalog = {
    models: [
      { ...servedModel("A-q4f32_1-MLC"), requiredFeatures: ["timestamp-query"] },
      servedModel("B-q4f16_1-MLC"),
    ],
  };

  const selection = selectServedModel(twoRequirements, capableAdapter([]));

  // No aggregate is invented. "This device is missing timestamp-query and shader-f16" is
  // true of no model in this catalog, and a product showing a person what their device
  // lacks must not be handed a sentence like that.
  assert.deepEqual(selection, {
    selected: false,
    reason: "model_features_unavailable",
    rejected: [
      { modelId: "A-q4f32_1-MLC", missing: ["timestamp-query"] },
      { modelId: "B-q4f16_1-MLC", missing: ["shader-f16"] },
    ],
  });
});

test("a declared requirement is honoured alongside the implied one", () => {
  const selection = selectServedModel(
    {
      models: [
        {
          ...servedModel("A-q4f32_1-MLC"),
          requiredFeatures: ["timestamp-query"],
        },
        servedModel("B-q4f32_1-MLC"),
      ],
    },
    capableAdapter([]),
  );

  assert.equal(
    selection.selected ? selection.model.modelId : undefined,
    "B-q4f32_1-MLC",
  );
});

test("an unusable catalog is refused here too, before a device is consulted", () => {
  assert.throws(
    () =>
      selectServedModel(
        { models: [{ ...servedModel("A-q4f32_1-MLC"), artifacts: "https://x.example/a/" }] },
        capableAdapter(),
      ),
    (error: unknown) =>
      error instanceof LocalInferenceError && error.code === "invalid_catalog",
  );
});
