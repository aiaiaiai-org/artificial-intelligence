// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import { ContractViolation } from "./violation.js";

/** Largest value a contract `DecimalU64` carries. */
export const DECIMAL_U64_MAX = 18446744073709551615n;

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

/** Returns whether `value` is a canonical decimal `u64` string. */
export function isDecimalU64(value: string): boolean {
  return CANONICAL_DECIMAL.test(value) && BigInt(value) <= DECIMAL_U64_MAX;
}

/**
 * Parses a cross-runtime unsigned integer carried as a canonical decimal JSON string.
 *
 * The result is a `bigint`, never a `number`: a sequence counter near the `u64` ceiling is
 * outside the range JavaScript integers represent exactly, and the contract carries these
 * as strings precisely so a host does not have to round one.
 *
 * @throws {ContractViolation} for a leading zero, a sign, any non-digit, or a value above
 * the `u64` ceiling.
 */
export function parseDecimalU64(value: string): bigint {
  if (!CANONICAL_DECIMAL.test(value)) {
    throw new ContractViolation(
      "non_canonical_decimal",
      "unsigned integer string is not canonical u64",
    );
  }
  const parsed = BigInt(value);
  if (parsed > DECIMAL_U64_MAX) {
    throw new ContractViolation(
      "non_canonical_decimal",
      "unsigned integer string is not canonical u64",
    );
  }
  return parsed;
}

/**
 * Formats an unsigned integer as its canonical decimal contract string.
 *
 * @throws {ContractViolation} when the value is negative or above the `u64` ceiling.
 */
export function formatDecimalU64(value: bigint): string {
  if (value < 0n || value > DECIMAL_U64_MAX) {
    throw new ContractViolation(
      "non_canonical_decimal",
      "unsigned integer is outside the contract u64 range",
    );
  }
  return value.toString(10);
}

/**
 * Returns the next counter value, or `undefined` at the ceiling.
 *
 * A wrapping sequence would silently reorder emitted history, so it fails closed here for
 * the same reason it does in the kernel.
 */
export function nextSequence(value: bigint): bigint | undefined {
  return value >= DECIMAL_U64_MAX ? undefined : value + 1n;
}
