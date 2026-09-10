// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  findServedModel,
  LocalInferenceError,
  toAppConfig,
  WebLlmBrowserHost,
  validateServedCatalog,
  validateServedModel,
  type ServedModel,
} from "../src/index.js";

const REVISION = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const SHA256_SRI = `sha256-${"A".repeat(43)}=`;
const SHA384_SRI = `sha384-${"A".repeat(64)}`;
const SHA512_SRI = `sha512-${"A".repeat(86)}==`;

function servedModel(overrides: Partial<ServedModel> = {}): ServedModel {
  return {
    modelId: "Small-q4f16_1-MLC",
    artifacts: `https://models.example.org/Small-q4f16_1-MLC/resolve/${REVISION}/`,
    modelLib: `https://models.example.org/libs/${REVISION}/Small-q4f16_1-webgpu.wasm`,
    requiredFeatures: ["shader-f16"],
    vramRequiredMb: 1403,
    contextWindowSize: 4096,
    ...overrides,
  };
}

/** `assert.throws` reports nothing back, so the error is captured to be read here. */
function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  return assert.fail("expected the catalog to be refused");
}

function refusal(model: ServedModel): LocalInferenceError {
  const error = caught(() => validateServedModel(model));
  assert.ok(error instanceof LocalInferenceError);
  assert.equal(error.code, "invalid_catalog");
  return error;
}

test("a revision-pinned entry served over https is accepted", () => {
  validateServedModel(servedModel());
  validateServedCatalog({ models: [servedModel()] });
});

test("artifacts without a resolve segment are refused, not silently pinned to a branch", () => {
  // The pinned runtime appends "resolve/main/" to a URL that carries no revision, which
  // turns a mirror into a moving target without anything appearing to go wrong.
  const error = refusal(
    servedModel({ artifacts: "https://models.example.org/Small-q4f16_1-MLC/" }),
  );
  assert.match(error.message, /resolve\/<revision>\//);
});

test("a moving revision is refused wherever it appears in a URL", () => {
  for (const revision of ["main", "master", "HEAD", "latest", "dev"]) {
    refusal(
      servedModel({
        artifacts: `https://models.example.org/Small-q4f16_1-MLC/resolve/${revision}/`,
      }),
    );
  }
  // A model library served from a branch is the case that is wrong by default: the
  // prebuilt registry points its own WASM at one.
  refusal(
    servedModel({
      modelLib: "https://raw.example.org/binary-libs/main/Small-q4f16_1-webgpu.wasm",
    }),
  );
});

test("artifacts must be an https directory URL", () => {
  refusal(servedModel({ artifacts: `http://models.example.org/m/resolve/${REVISION}/` }));
  refusal(servedModel({ artifacts: "/models/m/resolve/abc/" }));
  refusal(
    servedModel({
      artifacts: `https://models.example.org/m/resolve/${REVISION}`,
    }),
  );
});

test("a model library must be a .wasm URL", () => {
  refusal(servedModel({ modelLib: `https://models.example.org/libs/${REVISION}/lib.js` }));
});

test("a model library is revision-pinned or content-pinned", () => {
  const unpinned = "https://models.example.org/libs/Small-q4f16_1-webgpu.wasm";
  const error = refusal(servedModel({ modelLib: unpinned }));
  assert.match(error.message, /artifact revision/);

  validateServedModel(
    servedModel({
      modelLib: unpinned,
      integrity: { modelLib: SHA256_SRI },
    }),
  );
});

test("integrity hashes must be well-formed and match their digest length", () => {
  refusal(servedModel({ integrity: { config: "md5-abc" } }));
  refusal(servedModel({ integrity: { modelLib: "sha256-not base64!" } }));
  refusal(servedModel({ integrity: { tokenizer: { "tokenizer.json": "sha1-abc" } } }));
  refusal(
    servedModel({
      integrity: { modelLib: `sha384-${"A".repeat(43)}=` },
    }),
  );

  validateServedModel(
    servedModel({
      integrity: {
        config: SHA256_SRI,
        modelLib: SHA384_SRI,
        tokenizer: {
          "tokenizer.json": SHA512_SRI,
        },
      },
    }),
  );
});

test("stated requirements must be positive whole numbers", () => {
  refusal(servedModel({ vramRequiredMb: 0 }));
  refusal(servedModel({ contextWindowSize: -4096 }));
  refusal(servedModel({ vramRequiredMb: 1403.5 }));
});

test("a catalog refuses to be empty or to serve one identifier twice", () => {
  const empty = caught(() => validateServedCatalog({ models: [] }));
  assert.ok(empty instanceof LocalInferenceError);
  assert.equal(empty.code, "invalid_catalog");

  const twice = caught(() =>
    validateServedCatalog({ models: [servedModel(), servedModel()] }),
  );
  assert.ok(twice instanceof LocalInferenceError);
  assert.match(twice.message, /served twice/);
});

test("a served catalog maps onto the record the pinned runtime consumes", () => {
  const config = toAppConfig({
    models: [
      servedModel({
        integrity: {
          config: SHA256_SRI,
        },
      }),
    ],
    cacheBackend: "indexeddb",
  });

  assert.equal(config.cacheBackend, "indexeddb");
  assert.deepEqual(config.model_list, [
    {
      model: `https://models.example.org/Small-q4f16_1-MLC/resolve/${REVISION}/`,
      model_id: "Small-q4f16_1-MLC",
      model_lib: `https://models.example.org/libs/${REVISION}/Small-q4f16_1-webgpu.wasm`,
      required_features: ["shader-f16"],
      vram_required_MB: 1403,
      overrides: { context_window_size: 4096 },
      integrity: {
        config: SHA256_SRI,
        // A hash that is present and does not match is a fact, not a warning.
        onFailure: "error",
      },
    },
  ]);
});

test("building an app config refuses an invalid catalog before any download", () => {
  const error = caught(() =>
    toAppConfig({ models: [servedModel({ artifacts: "https://models.example.org/m/" })] }),
  );
  assert.ok(error instanceof LocalInferenceError);
  assert.equal(error.code, "invalid_catalog");
});

test("a catalog answers which entry serves an identifier", () => {
  const catalog = { models: [servedModel()] };
  assert.equal(findServedModel(catalog, "Small-q4f16_1-MLC")?.modelId, "Small-q4f16_1-MLC");
  assert.equal(findServedModel(catalog, "Absent-MLC"), undefined);
});

test("a raw app config is accepted as the way out of this package's opinions", () => {
  // `catalog` is this package's view of what a mirror must get right. A product that
  // already builds an app config, or needs a shape the catalog does not describe, passes
  // one through unchecked rather than forking the host.
  const host = new WebLlmBrowserHost({
    workerFactory: () => assert.fail("constructing a host must not create a worker"),
    appConfig: { model_list: [] },
  });
  assert.ok(host instanceof WebLlmBrowserHost);

  assert.throws(
    () =>
      new WebLlmBrowserHost({
        catalog: { models: [servedModel()] },
        appConfig: { model_list: [] },
      }),
    (error: unknown) =>
      error instanceof LocalInferenceError && error.code === "invalid_catalog",
  );
});
