// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import { FoundationFailure, type FoundationErrorValue } from "./error.js";
import type { OperationId } from "./identifier.js";
import { ContractViolation } from "./violation.js";

/** Normative foundation contract version this package mirrors. */
export const CONTRACT_VERSION = "0.2.0";

/** Canonical `MAJOR.MINOR.PATCH` contract version without suffixes. */
export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const CANONICAL_COMPONENT = /^(?:0|[1-9][0-9]*)$/u;

/**
 * Parses a canonical contract version.
 *
 * Suffixes, leading zeroes, and a missing component are refused. A version that parsed
 * loosely would let a peer claim a line it does not implement.
 *
 * @throws {ContractViolation} when the version is not canonical.
 */
export function parseContractVersion(value: string): ContractVersion {
  const components = value.split(".");
  if (components.length !== 3 || !components.every((part) => CANONICAL_COMPONENT.test(part))) {
    throw new ContractViolation("non_canonical_version", "contract version is not canonical");
  }
  const [major, minor, patch] = components.map((part) => Number(part));
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new ContractViolation("non_canonical_version", "contract version is not canonical");
  }
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    throw new ContractViolation("non_canonical_version", "contract version is not canonical");
  }
  return { major, minor, patch };
}

/** Formats a contract version in its canonical wire spelling. */
export function formatContractVersion(version: ContractVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** The version constant, parsed. */
export const CURRENT_CONTRACT_VERSION: ContractVersion = parseContractVersion(CONTRACT_VERSION);

/**
 * Returns whether `provider` satisfies the version a consumer requires.
 *
 * Pre-`1.0` lines are exact on `minor`; a released line accepts a forward-compatible
 * `minor`. A provider is never assumed compatible merely because its version parsed.
 */
export function acceptsProvider(required: ContractVersion, provider: ContractVersion): boolean {
  if (required.major === 0) {
    return (
      provider.major === 0 && provider.minor === required.minor && provider.patch >= required.patch
    );
  }
  return provider.major === required.major && provider.minor >= required.minor;
}

/**
 * Validates a peer's contract claim before its payload is decoded.
 *
 * A non-canonical claim is not echoed back in the failure: repeating it as if it were a
 * version would hand a reader a value the contract does not define.
 *
 * @throws {FoundationFailure} carrying `unsupported_contract_version` when the claim is
 * non-canonical or names another compatibility line.
 */
export function requireCompatibleContract(
  requested: string,
  operation_id?: OperationId,
): ContractVersion {
  const refuse = (required: string | undefined): never => {
    const details =
      required === undefined
        ? { supported_contract_version: CONTRACT_VERSION }
        : { required_contract_version: required, supported_contract_version: CONTRACT_VERSION };
    const error: FoundationErrorValue =
      operation_id === undefined
        ? { code: "unsupported_contract_version", details }
        : { code: "unsupported_contract_version", operation_id, details };
    throw new FoundationFailure(error);
  };

  let required: ContractVersion;
  try {
    required = parseContractVersion(requested);
  } catch {
    return refuse(undefined);
  }
  if (!acceptsProvider(required, CURRENT_CONTRACT_VERSION)) {
    return refuse(formatContractVersion(required));
  }
  return required;
}
