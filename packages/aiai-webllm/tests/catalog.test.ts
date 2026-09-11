// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  completedPrebuiltAppConfig,
  effectiveRequiredFeatures,
  findServedModel,
  LocalInferenceError,
  parseQuantization,
  toAppConfig,
  WebLlmBrowserHost,
  validateServedCatalog,
  validateServedModel,
  type ServedModel,
} from "../src/index.js";
import { prebuiltAppConfig, type AppConfig } from "@mlc-ai/web-llm";

const REVISION = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const SHA256_SRI = `sha256-${"A".repeat(43)}=`;
const SHA384_SRI = `sha384-${"A".repeat(64)}`;
const SHA512_SRI = `sha512-${"A".repeat(86)}==`;

/**
 * Builds a served entry, where an override of `undefined` removes the field rather than
 * setting it.
 *
 * `exactOptionalPropertyTypes` is on, so a test meaning "this entry states no context
 * window" has to produce an entry with no such key — not one holding `undefined`.
 */
function servedModel(
  overrides: { readonly [K in keyof ServedModel]?: ServedModel[K] | undefined } = {},
): ServedModel {
  const merged: Record<string, unknown> = {
    modelId: "Small-q4f16_1-MLC",
    artifacts: `https://models.example.org/Small-q4f16_1-MLC/resolve/${REVISION}/`,
    modelLib: `https://models.example.org/libs/${REVISION}/Small-q4f16_1-webgpu.wasm`,
    requiredFeatures: ["shader-f16"],
    vramRequiredMb: 1403,
    contextWindowSize: 4096,
    ...overrides,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  return merged as unknown as ServedModel;
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

test("a window is either fixed or sliding, never both", () => {
  // The pinned runtime throws `WindowSizeConfigurationError` when both are positive. Caught
  // where the entry is written rather than inside a load that already downloaded a model.
  const error = refusal(
    servedModel({ contextWindowSize: 4096, slidingWindowSize: 1024 }),
  );
  assert.match(error.message, /either fixed or sliding/);

  validateServedModel(
    servedModel({ contextWindowSize: undefined, slidingWindowSize: 1024 }),
  );
});

test("an attention sink without a sliding window is refused", () => {
  const error = refusal(
    servedModel({ contextWindowSize: undefined, attentionSinkSize: 4 }),
  );
  assert.match(error.message, /attentionSinkSize/);

  // Zero is a real choice — a sliding window with no pinned head — so it is accepted where
  // a positive-integer check would have refused it.
  validateServedModel(
    servedModel({
      contextWindowSize: undefined,
      slidingWindowSize: 1024,
      attentionSinkSize: 0,
    }),
  );
  refusal(
    servedModel({
      contextWindowSize: undefined,
      slidingWindowSize: 1024,
      attentionSinkSize: -1,
    }),
  );
});

test("a sliding window carries the context override the runtime requires with it", () => {
  const config = toAppConfig({
    models: [
      servedModel({
        contextWindowSize: undefined,
        slidingWindowSize: 1024,
        attentionSinkSize: 4,
      }),
    ],
  });

  // A model's own `mlc-chat-config.json` normally declares a positive context window, and
  // the runtime refuses a configuration where both are positive — so an entry that set only
  // `slidingWindowSize` would fail to load, naming a field the product never wrote.
  assert.deepEqual(config.model_list[0]?.overrides, {
    sliding_window_size: 1024,
    context_window_size: -1,
    attention_sink_size: 4,
  });
});

test("an entry stating no window carries no overrides at all", () => {
  const config = toAppConfig({
    models: [servedModel({ contextWindowSize: undefined })],
  });
  assert.equal(config.model_list[0]?.overrides, undefined);
});

test("what an entry requires includes what its identifier implies", () => {
  // The identifier is `Small-q4f16_1-MLC`, so half precision is required whether or not the
  // entry remembered to say so — which, across the pinned registry, it mostly does not.
  assert.deepEqual(
    effectiveRequiredFeatures(servedModel({ requiredFeatures: undefined })),
    ["shader-f16"],
  );

  const config = toAppConfig({
    models: [servedModel({ requiredFeatures: undefined })],
  });
  assert.deepEqual(config.model_list[0]?.required_features, ["shader-f16"]);
});

test("an entry that implies and declares nothing carries no feature list", () => {
  const config = toAppConfig({
    models: [
      servedModel({
        modelId: "Small-MLC",
        artifacts: `https://models.example.org/Small-MLC/resolve/${REVISION}/`,
        requiredFeatures: undefined,
      }),
    ],
  });
  assert.equal(config.model_list[0]?.required_features, undefined);
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

test("the prebuilt registry is completed from its own identifiers, not taken as written", () => {
  const completed = completedPrebuiltAppConfig();
  const upstream = new Map(
    prebuiltAppConfig.model_list.map((record) => [record.model_id, record]),
  );

  assert.equal(completed.model_list.length, prebuiltAppConfig.model_list.length);

  let repaired = 0;
  for (const record of completed.model_list) {
    const original = upstream.get(record.model_id);
    assert.ok(original !== undefined);

    if (parseQuantization(record.model_id)?.activation === "f16") {
      // The engine's guard over this list sits between acquiring a device and fetching the
      // weights. A record that declares nothing skips it and carries on into the fetch; a
      // completed one stops there instead.
      assert.ok(record.required_features?.includes("shader-f16"));
      if (!(original.required_features ?? []).includes("shader-f16")) {
        repaired += 1;
      }
    } else {
      // Nothing is added to a record that implies nothing — not even an empty list.
      assert.deepEqual(record.required_features, original.required_features);
    }
  }

  assert.ok(repaired > 0, "the completion must be doing something on this registry");
});

test("a product's own app config is passed through exactly as given", () => {
  // `appConfig` is the documented way out of this package's opinions, and completing a
  // feature list is one of them.
  const given: AppConfig = {
    model_list: [
      {
        model: "https://models.example.org/x/resolve/abc/",
        model_id: "Mine-q4f16_1-MLC",
        model_lib: "https://models.example.org/x/abc/lib.wasm",
      },
    ],
  };
  const host = new WebLlmBrowserHost({
    workerFactory: () => assert.fail("constructing a host must not create a worker"),
    appConfig: given,
  });

  assert.ok(host instanceof WebLlmBrowserHost);
  assert.equal(given.model_list[0]?.required_features, undefined);
});
