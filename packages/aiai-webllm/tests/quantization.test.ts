// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseQuantization,
  requiredFeaturesFor,
  requiredFeaturesForQuantization,
  SHADER_F16,
} from "../src/index.js";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

test("every quantisation the pinned registry ships is read", () => {
  // Read from `@mlc-ai/web-llm@0.2.84`'s prebuilt registry rather than invented: these are
  // the five tokens it actually uses. A version bump introducing a sixth fails here rather
  // than silently deriving nothing from it.
  const tokens = new Set(
    prebuiltAppConfig.model_list.map(
      (record) => parseQuantization(record.model_id)?.token ?? "unread",
    ),
  );

  assert.deepEqual(
    [...tokens].sort(),
    ["q0f16", "q0f32", "q3f16_1", "q4f16_1", "q4f32_1"],
  );
});

test("a token is read into its parts", () => {
  assert.deepEqual(parseQuantization("Qwen3-0.6B-q4f16_1-MLC"), {
    token: "q4f16_1",
    weightBits: 4,
    activation: "f16",
    group: "1",
  });
  assert.deepEqual(parseQuantization("Llama-3.2-1B-Instruct-q0f32-MLC"), {
    token: "q0f32",
    weightBits: 0,
    activation: "f32",
    group: undefined,
  });
});

test("a token is recognised only as a whole segment", () => {
  // `BF16` appears in real identifiers and is not a quantisation token; neither is a token
  // glued to a neighbouring word.
  assert.equal(
    parseQuantization("Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC")?.token,
    "q4f16_1",
  );
  assert.equal(parseQuantization("Modelq4f16_1MLC"), undefined);
  assert.equal(parseQuantization("Small-Model-MLC"), undefined);
});

test("an identifier carrying two tokens is ambiguous, not resolved by position", () => {
  // There is no rule that says which of them describes the library, so nothing is read.
  assert.equal(parseQuantization("Thing-q4f16_1-q4f32_1-MLC"), undefined);
});

test("half precision is what requires the feature, not the weight width", () => {
  const halfPrecision = parseQuantization("Small-q0f16-MLC");
  assert.ok(halfPrecision !== undefined);
  assert.deepEqual(requiredFeaturesForQuantization(halfPrecision), [SHADER_F16]);

  // A 4-bit weight is dequantised by the same kernels the activation type already decided,
  // so it adds no requirement of its own.
  const quantisedWeights = parseQuantization("Small-q4f32_1-MLC");
  assert.ok(quantisedWeights !== undefined);
  assert.deepEqual(requiredFeaturesForQuantization(quantisedWeights), []);
});

test("the derived requirement is added to what was declared, never substituted", () => {
  assert.deepEqual(
    requiredFeaturesFor("Small-q4f16_1-MLC", ["timestamp-query"]),
    ["timestamp-query", SHADER_F16],
  );
  // An entry that declares a feature its identifier does not imply has stated something
  // about a library this package cannot see, and is believed.
  assert.deepEqual(requiredFeaturesFor("Small-q4f32_1-MLC", [SHADER_F16]), [
    SHADER_F16,
  ]);
});

test("a declared requirement is not duplicated by the derived one", () => {
  assert.deepEqual(requiredFeaturesFor("Small-q4f16_1-MLC", [SHADER_F16]), [
    SHADER_F16,
  ]);
});

test("the registry leaves the requirement off most of its half-precision entries", () => {
  // This is the measurement the derivation exists for, kept as a test so that a version
  // bump which fixes the registry is noticed rather than assumed. The engine checks
  // `required_features` in `reload()`, after the download and after acquiring a device, so
  // an entry that declares nothing costs a person the whole download before failing.
  const silent = prebuiltAppConfig.model_list.filter(
    (record) =>
      parseQuantization(record.model_id)?.activation === "f16" &&
      !(record.required_features ?? []).includes(SHADER_F16),
  );

  assert.ok(
    silent.length > 0,
    "if the pinned registry now declares shader-f16 everywhere, this derivation is " +
      "belt-and-braces rather than load-bearing, and this test should say so instead",
  );
  for (const record of silent) {
    assert.ok(
      requiredFeaturesFor(record.model_id, record.required_features).includes(
        SHADER_F16,
      ),
      `${record.model_id} must require shader-f16 whatever its entry declared`,
    );
  }
});
