// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import { ContractViolation } from "./violation.js";

/** Shape of one binding-safe identifier kind: an ASCII prefix and a lowercase-hex body. */
export interface IdentifierShape {
  readonly prefix: string;
  readonly hexLength: number;
}

/**
 * Every identifier the foundation contract defines.
 *
 * The foundation mints none of these and interprets none of them. It constrains their
 * shape so that a host can tell one kind from another without asking a product what a
 * given string means.
 */
export const IDENTIFIER_SHAPES = {
  subject: { prefix: "sub_", hexLength: 64 },
  controller: { prefix: "ctl_", hexLength: 32 },
  runtime: { prefix: "rt_", hexLength: 32 },
  model: { prefix: "mdl_", hexLength: 32 },
  session: { prefix: "ses_", hexLength: 32 },
  proposal: { prefix: "prp_", hexLength: 32 },
  operation: { prefix: "op_", hexLength: 32 },
  sha256: { prefix: "sha256_", hexLength: 64 },
} as const satisfies Record<string, IdentifierShape>;

export type IdentifierKind = keyof typeof IDENTIFIER_SHAPES;

declare const identifierKind: unique symbol;

/**
 * A string already checked against one identifier kind.
 *
 * The brand is compile-time only — it exists so a host cannot pass a session identifier
 * where a proposal identifier belongs, which is a mistake no amount of shape checking at
 * the wire boundary would catch.
 */
export type Identifier<K extends IdentifierKind> = string & {
  readonly [identifierKind]: K;
};

export type SubjectId = Identifier<"subject">;
export type ControllerId = Identifier<"controller">;
export type RuntimeId = Identifier<"runtime">;
export type ModelId = Identifier<"model">;
export type SessionId = Identifier<"session">;
export type ProposalId = Identifier<"proposal">;
export type OperationId = Identifier<"operation">;
export type Sha256Digest = Identifier<"sha256">;

function isLowerHex(value: string, length: number): boolean {
  if (value.length !== length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code >= 0x30 && code <= 0x39;
    const lowerHex = code >= 0x61 && code <= 0x66;
    if (!digit && !lowerHex) {
      return false;
    }
  }
  return true;
}

/** Returns whether `value` is a canonical identifier of `kind`. */
export function isIdentifier<K extends IdentifierKind>(
  kind: K,
  value: string,
): value is Identifier<K> {
  const shape = IDENTIFIER_SHAPES[kind];
  return (
    value.startsWith(shape.prefix) &&
    isLowerHex(value.slice(shape.prefix.length), shape.hexLength)
  );
}

/**
 * Parses a canonical identifier of `kind`.
 *
 * Uppercase hex, a wrong body length, and another kind's prefix are all refused: an
 * identifier that a host repaired would no longer be the one its peer holds.
 *
 * @throws {ContractViolation} when the value is not canonical for `kind`.
 */
export function parseIdentifier<K extends IdentifierKind>(
  kind: K,
  value: string,
): Identifier<K> {
  if (!isIdentifier(kind, value)) {
    throw new ContractViolation(
      "non_canonical_identifier",
      `identifier is not a canonical ${kind} identifier`,
    );
  }
  return value;
}

/** Builds the canonical digest identifier from raw SHA-256 bytes. */
export function formatSha256Digest(bytes: Uint8Array): Sha256Digest {
  if (bytes.length !== 32) {
    throw new ContractViolation(
      "non_canonical_identifier",
      "a SHA-256 digest is exactly 32 bytes",
    );
  }
  let body = "";
  for (const byte of bytes) {
    body += byte.toString(16).padStart(2, "0");
  }
  return parseIdentifier("sha256", `sha256_${body}`);
}
