// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

/** Closed reason a contract value is not canonical. */
export type ContractViolationReason =
  | "non_canonical_capability"
  | "non_canonical_decimal"
  | "non_canonical_identifier"
  | "non_canonical_version";

/**
 * Refusal raised when a value does not have the canonical form the contract defines.
 *
 * The Rust side returns a distinct unit error per value kind. A host needs one `catch`, so
 * this carries the kind as a closed `reason` instead of splitting into four classes.
 */
export class ContractViolation extends Error {
  public constructor(
    public readonly reason: ContractViolationReason,
    message: string,
  ) {
    super(message);
    this.name = "ContractViolation";
  }
}
