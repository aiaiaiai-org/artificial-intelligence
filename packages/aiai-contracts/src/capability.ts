// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import { ContractViolation } from "./violation.js";

/** Maximum length of a canonical capability name. */
export const CAPABILITY_NAME_MAX_LEN = 64;

declare const capabilityName: unique symbol;

/** A bounded lowercase capability token, e.g. `message` or `deliver_asset`. */
export type CapabilityName = string & { readonly [capabilityName]: "capability" };

const CANONICAL_CAPABILITY = /^[a-z](?:[a-z0-9]|_(?=[a-z0-9]))*$/u;

/** Returns whether `value` is a canonical capability name. */
export function isCapabilityName(value: string): value is CapabilityName {
  return value.length <= CAPABILITY_NAME_MAX_LEN && CANONICAL_CAPABILITY.test(value);
}

/**
 * Parses a capability name.
 *
 * The foundation constrains the shape of a capability name and never its vocabulary: which
 * capabilities exist, and what authority each one needs, belongs to the product contract
 * that grants them.
 *
 * @throws {ContractViolation} when the name is not canonical.
 */
export function parseCapabilityName(value: string): CapabilityName {
  if (!isCapabilityName(value)) {
    throw new ContractViolation(
      "non_canonical_capability",
      "capability name is not canonical",
    );
  }
  return value;
}
