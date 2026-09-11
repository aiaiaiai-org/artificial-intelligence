// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading the quantisation an MLC model identifier declares, and the adapter feature that
 * reading implies.
 *
 * This exists because of a measured gap rather than a theoretical one. In the prebuilt
 * registry of `@mlc-ai/web-llm@0.2.84`, 76 entries are `q4f16_1` and only 27 of them list
 * `shader-f16` in `required_features`; both `q3f16_1` entries list nothing.
 *
 * The engine does check that list. `reloadInternal()` fetches `mlc-chat-config.json` and
 * the WASM library, instantiates the library, acquires a GPU device, checks
 * `required_features`, and only then initialises WebGPU and fetches the weights. So an
 * entry that declares what it needs is refused before the weights — though after two
 * fetches and a device acquisition. An entry that declares nothing skips the check
 * altogether and carries on into device initialisation and the weight fetch, to fail
 * somewhere past them.
 *
 * The identifier already says which kernels the library contains. Deriving the requirement
 * from it moves the refusal ahead of every fetch rather than into the middle of them.
 */

/** Data type a model's kernels compute in, as its identifier declares it. */
export type ActivationDtype = "f16" | "f32";

/** The WebGPU feature a half-precision model cannot compile its kernels without. */
export const SHADER_F16 = "shader-f16";

/** What an MLC quantisation token states about a model. */
export interface Quantization {
  /** The token as it appears in the identifier, such as `q4f16_1`. */
  readonly token: string;
  /** Bits per stored weight. `0` means weights are not quantised below the activation type. */
  readonly weightBits: number;
  /** The type the kernels compute in. This, not `weightBits`, decides the feature. */
  readonly activation: ActivationDtype;
  /** The group/variant suffix, `"1"` in `q4f16_1`, absent in `q0f16`. */
  readonly group: string | undefined;
}

/** `q<weight bits>f<activation bits>` with an optional `_<variant>`, as a whole segment. */
const QUANTIZATION_TOKEN = /^q(\d{1,2})f(16|32)(?:_([0-9a-z]+))?$/;

/**
 * Reads the quantisation an identifier declares, or `undefined` when it declares none.
 *
 * Identifiers are read segment by segment so that a token is recognised only where MLC
 * writes one. Nothing here infers a quantisation from a model's name, size, or family: an
 * identifier that does not carry a token has not stated its quantisation, and a guess about
 * which kernels a WASM library contains is exactly the kind of claim this package refuses
 * to make on a product's behalf.
 *
 * An identifier carrying two tokens is ambiguous and reads as `undefined` for the same
 * reason — there is no rule that says which of them describes the library.
 */
export function parseQuantization(modelId: string): Quantization | undefined {
  const matches = modelId
    .split("-")
    .map((segment) => QUANTIZATION_TOKEN.exec(segment))
    .filter((match): match is RegExpExecArray => match !== null);

  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined) {
    return undefined;
  }
  return {
    token: only[0],
    weightBits: Number(only[1]),
    activation: only[2] === "16" ? "f16" : "f32",
    group: only[3],
  };
}

/**
 * The adapter features a model of this quantisation cannot run without.
 *
 * Half precision is the only requirement an identifier settles on its own. Weight bits do
 * not add one: a 4-bit weight is dequantised by the same kernels the activation type
 * already decided.
 */
export function requiredFeaturesForQuantization(
  quantization: Quantization,
): readonly string[] {
  return quantization.activation === "f16" ? [SHADER_F16] : [];
}

/**
 * Everything this model needs from an adapter: what its entry declared, plus what its
 * identifier implies.
 *
 * Declared names come first and in the order given, so a product reading a refusal sees its
 * own vocabulary before this package's addition. The derived requirement is added rather
 * than substituted, and never removed: an entry that declares a feature its identifier does
 * not imply has stated something about a library this package cannot see, and is believed.
 */
export function requiredFeaturesFor(
  modelId: string,
  declared: readonly string[] = [],
): readonly string[] {
  const quantization = parseQuantization(modelId);
  const derived =
    quantization === undefined
      ? []
      : requiredFeaturesForQuantization(quantization);
  const features = [...declared];
  for (const feature of derived) {
    if (!features.includes(feature)) {
      features.push(feature);
    }
  }
  return features;
}
