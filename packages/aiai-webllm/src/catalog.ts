// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import { LocalInferenceError } from "./contracts.js";
import { requiredFeaturesFor } from "./quantization.js";

/**
 * Where a browser cache keeps downloaded artifacts.
 *
 * Named here rather than imported so the catalog a product writes is a value this package
 * describes, not a re-export of the pinned runtime's own configuration type.
 */
export type CacheBackend = "cache" | "indexeddb" | "cross-origin" | "opfs";

/**
 * SRI hashes for the artifacts a hash can cover.
 *
 * Weight shards are deliberately absent: they are not covered by this mechanism, and are
 * pinned by the immutable revision segment of {@link ServedModel.artifacts} instead. An
 * integrity block that appeared to cover them would be the more dangerous of the two.
 */
export interface ArtifactIntegrity {
  /** SRI hash for `mlc-chat-config.json`. */
  readonly config?: string;
  /** SRI hash for the WASM model library. */
  readonly modelLib?: string;
  /** SRI hashes for tokenizer files, keyed by filename. */
  readonly tokenizer?: Readonly<Record<string, string>>;
}

/**
 * One model a product serves from its own origin.
 *
 * This is the adapter's descriptor and deliberately not the pinned runtime's `ModelRecord`:
 * a product states where its artifacts live and what its entry requires, and the mapping
 * onto whatever the pinned runtime wants is this package's work, not the product's.
 */
export interface ServedModel {
  /** The identifier the runtime loads and every state reports. */
  readonly modelId: string;
  /**
   * Base URL of the artifact set, ending in `/`.
   *
   * Must carry a `/resolve/<revision>/` segment with an immutable revision. The pinned
   * runtime appends `resolve/main/` to any URL without one, which would silently turn a
   * mirror into a moving target — see {@link validateServedModel}.
   */
  readonly artifacts: string;
  /** URL of the WASM model library. Revision-pinned, or content-pinned by `integrity.modelLib`. */
  readonly modelLib: string;
  /** Adapter features this entry needs, such as `shader-f16`. */
  readonly requiredFeatures?: readonly string[];
  /** What the entry states it needs, in MB. A claim by whoever measured it, not a reading. */
  readonly vramRequiredMb?: number;
  /**
   * Context window to run this entry with.
   *
   * Mutually exclusive with {@link ServedModel.slidingWindowSize}: the pinned runtime
   * refuses a configuration where both are positive.
   */
  readonly contextWindowSize?: number;
  /**
   * Run this entry with a sliding-window KV cache of this many tokens instead of a fixed
   * context window.
   *
   * This is the knob that bounds what the cache costs on a device with little of it: a
   * conversation may run past the window, and what falls out of it is forgotten rather than
   * refused. Setting it makes the adapter override the entry's own context window to `-1`,
   * which is how the pinned runtime is told a window is sliding rather than fixed.
   */
  readonly slidingWindowSize?: number;
  /**
   * Tokens kept pinned at the start of a sliding window.
   *
   * Attention sinks are what keep a sliding window from degrading when the earliest tokens
   * leave it. Meaningless without {@link ServedModel.slidingWindowSize}, and refused
   * without it.
   */
  readonly attentionSinkSize?: number;
  readonly integrity?: ArtifactIntegrity;
}

/** The set of models a product serves, and how their artifacts are cached. */
export interface ServedCatalog {
  readonly models: readonly ServedModel[];
  /**
   * Which browser storage backend holds downloaded artifacts. Left unset, the pinned
   * runtime uses the Cache API.
   */
  readonly cacheBackend?: CacheBackend;
}

/**
 * Revision names that move.
 *
 * This is a heuristic and says so: no rule can prove a segment immutable, because a commit
 * hash and a branch name are the same shape of string. What it does catch is the failure
 * mode that actually happens — a mirror published from a branch, and the `resolve/main/`
 * the pinned runtime appends to a URL that carries no revision at all.
 */
const MUTABLE_REVISIONS: readonly string[] = [
  "main",
  "master",
  "head",
  "latest",
  "dev",
  "develop",
  "trunk",
  "nightly",
];

/** Matches the `…/resolve/<revision>/` shape the pinned runtime's URL normalizer expects. */
const RESOLVE_SEGMENT = /\/resolve\/([^/]+)\/$/;

/** SRI: an accepted algorithm, a base64 payload, and optional canonical padding. */
const SRI = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+)(={0,2})$/;
const SRI_DIGEST_BYTES = {
  sha256: 32,
  sha384: 48,
  sha512: 64,
} as const;

function invalid(message: string): LocalInferenceError {
  return new LocalInferenceError("invalid_catalog", message);
}

function parseHttpsUrl(raw: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(`${field} must be an absolute URL, got ${JSON.stringify(raw)}`);
  }
  // Model artifacts are fetched by a page that already had to be a secure context to
  // obtain a WebGPU adapter at all, so a plaintext artifact URL cannot load anyway; saying
  // so here makes it a stated refusal rather than a mixed-content failure at download time.
  if (url.protocol !== "https:") {
    throw invalid(`${field} must be served over https, got ${url.protocol}`);
  }
  return url;
}

function assertNoMutableSegment(url: URL, field: string): void {
  const moving = url.pathname
    .split("/")
    .find((segment) => MUTABLE_REVISIONS.includes(segment.toLowerCase()));
  if (moving !== undefined) {
    throw invalid(
      `${field} resolves through the moving revision ${JSON.stringify(moving)}; ` +
        "serve artifacts from an immutable revision so a cached download stays the " +
        "download that was verified",
    );
  }
}

function hasPathSegment(url: URL, segment: string): boolean {
  return url.pathname.split("/").some((candidate) => candidate === segment);
}

function assertSri(value: string, field: string): void {
  const match = SRI.exec(value);
  if (match === null) {
    throw invalid(
      `${field} must be an SRI hash of the form sha256-…, sha384-… or sha512-…, ` +
        `got ${JSON.stringify(value)}`,
    );
  }

  const algorithm = match[1] as keyof typeof SRI_DIGEST_BYTES;
  const payload = match[2] ?? "";
  const padding = (match[3] ?? "").length;
  const digestBytes = SRI_DIGEST_BYTES[algorithm];
  const expectedPayloadCharacters = Math.ceil((digestBytes * 8) / 6);
  const expectedPadding = (3 - (digestBytes % 3)) % 3;

  if (
    payload.length !== expectedPayloadCharacters ||
    (padding !== 0 && padding !== expectedPadding)
  ) {
    throw invalid(
      `${field} must contain a ${digestBytes}-byte ${algorithm} digest encoded as base64, ` +
        `got ${JSON.stringify(value)}`,
    );
  }
}

function assertPositiveInteger(
  value: number | undefined,
  field: string,
): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw invalid(`${field} must be a positive integer, got ${value}`);
  }
}

function assertNonNegativeInteger(
  value: number | undefined,
  field: string,
): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Checks the two KV-cache shapes against each other.
 *
 * The pinned runtime throws `WindowSizeConfigurationError` when both windows are positive
 * and reads an attention sink only against a sliding window. Both are caught here instead,
 * where the entry is written, rather than inside a load that has already downloaded a model.
 */
function assertWindowConfiguration(model: ServedModel, where: string): void {
  assertPositiveInteger(model.contextWindowSize, `${where}: contextWindowSize`);
  assertPositiveInteger(model.slidingWindowSize, `${where}: slidingWindowSize`);
  assertNonNegativeInteger(model.attentionSinkSize, `${where}: attentionSinkSize`);

  if (
    model.contextWindowSize !== undefined &&
    model.slidingWindowSize !== undefined
  ) {
    throw invalid(
      `${where}: contextWindowSize and slidingWindowSize cannot both be set; a window is ` +
        "either fixed or sliding, and the pinned runtime refuses a configuration where " +
        "both are positive",
    );
  }
  if (
    model.attentionSinkSize !== undefined &&
    model.slidingWindowSize === undefined
  ) {
    throw invalid(
      `${where}: attentionSinkSize has no meaning without slidingWindowSize; an ` +
        "attention sink is the head of a sliding window",
    );
  }
}

/**
 * Everything this entry needs from an adapter: what it declared, plus what its identifier's
 * quantisation token implies.
 *
 * The addition is not a convenience. The pinned runtime's own registry leaves `shader-f16`
 * off most of its half-precision entries, and its check over that list is skipped entirely
 * by an entry that carries none — so an entry stating nothing is the common case, not the
 * careless one.
 */
export function effectiveRequiredFeatures(
  model: ServedModel,
): readonly string[] {
  return requiredFeaturesFor(model.modelId, model.requiredFeatures ?? []);
}

/**
 * Checks one served entry, throwing `LocalInferenceError("invalid_catalog")` on the first
 * thing wrong with it.
 *
 * This runs when a catalog is handed over rather than when a download fails, because every
 * one of these mistakes is otherwise discovered by a person on a phone waiting for a model
 * that will not arrive.
 */
export function validateServedModel(model: ServedModel): void {
  if (model.modelId.trim() === "") {
    throw invalid("modelId must not be empty");
  }
  const where = `model ${JSON.stringify(model.modelId)}`;

  const artifacts = parseHttpsUrl(model.artifacts, `${where}: artifacts`);
  if (!artifacts.pathname.endsWith("/")) {
    throw invalid(
      `${where}: artifacts must end in "/" so filenames resolve against it as a directory`,
    );
  }
  const revision = RESOLVE_SEGMENT.exec(artifacts.pathname)?.[1];
  if (revision === undefined) {
    throw invalid(
      `${where}: artifacts must end in a "/resolve/<revision>/" segment. The pinned ` +
        'runtime appends "resolve/main/" to a URL without one, which would pin the ' +
        "mirror to a branch instead of a revision",
    );
  }
  assertNoMutableSegment(artifacts, `${where}: artifacts`);

  const modelLib = parseHttpsUrl(model.modelLib, `${where}: modelLib`);
  if (!modelLib.pathname.endsWith(".wasm")) {
    throw invalid(`${where}: modelLib must be a .wasm URL, got ${modelLib.pathname}`);
  }
  // The prebuilt registry serves model libraries from a branch of a repository, so this is
  // the one that is wrong by default rather than by mistake.
  assertNoMutableSegment(modelLib, `${where}: modelLib`);
  if (
    !hasPathSegment(modelLib, revision) &&
    model.integrity?.modelLib === undefined
  ) {
    throw invalid(
      `${where}: modelLib must include the artifact revision ${JSON.stringify(revision)} ` +
        "as a path segment or provide integrity.modelLib so the WASM bytes are content-pinned",
    );
  }

  for (const feature of model.requiredFeatures ?? []) {
    if (feature.trim() === "") {
      throw invalid(`${where}: requiredFeatures must not contain an empty name`);
    }
  }
  assertPositiveInteger(model.vramRequiredMb, `${where}: vramRequiredMb`);
  assertWindowConfiguration(model, where);

  const integrity = model.integrity;
  if (integrity !== undefined) {
    if (integrity.config !== undefined) {
      assertSri(integrity.config, `${where}: integrity.config`);
    }
    if (integrity.modelLib !== undefined) {
      assertSri(integrity.modelLib, `${where}: integrity.modelLib`);
    }
    for (const [file, hash] of Object.entries(integrity.tokenizer ?? {})) {
      assertSri(hash, `${where}: integrity.tokenizer[${JSON.stringify(file)}]`);
    }
  }
}

/** Checks a whole catalog, including that no identifier is served twice. */
export function validateServedCatalog(catalog: ServedCatalog): void {
  if (catalog.models.length === 0) {
    throw invalid("a served catalog must describe at least one model");
  }
  const seen = new Set<string>();
  for (const model of catalog.models) {
    validateServedModel(model);
    if (seen.has(model.modelId)) {
      throw invalid(`modelId ${JSON.stringify(model.modelId)} is served twice`);
    }
    seen.add(model.modelId);
  }
}

/** Returns the entry serving `modelId`, or `undefined` when the catalog does not. */
export function findServedModel(
  catalog: ServedCatalog,
  modelId: string,
): ServedModel | undefined {
  return catalog.models.find((model) => model.modelId === modelId);
}
