// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalJsonValue } from "./canonical.js";
import {
  isCapabilityName,
  type CapabilityName,
} from "./capability.js";
import {
  isIdentifier,
  type OperationId,
  type ProposalId,
  type SubjectId,
} from "./identifier.js";

/** Stable error-code surface for foundation contract `0.2.0`. */
export const ERROR_CODES = [
  "malformed_envelope",
  "unsupported_contract_version",
  "unknown_variant",
  "missing_context",
  "runtime_inactive",
  "inference_unavailable",
  "subject_continuity_violation",
  "unknown_proposal",
  "duplicate_proposal_id",
  "authority_withheld",
  "authority_scope_exceeded",
  "sequence_exhausted",
  "signal_schema_violation",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Closed name of an explicit external port a runtime requires. */
export const CONTEXT_PORTS = [
  "clock",
  "identifier_generation",
  "inference",
  "authority",
] as const;

export type ContextPort = (typeof CONTEXT_PORTS)[number];

/** Closed name of the contract surface whose variant was not recognized. */
export const VARIANT_KINDS = [
  "wake_reason",
  "proposal_kind",
  "action_archetype",
  "archetype_field",
] as const;

export type VariantKind = (typeof VARIANT_KINDS)[number];

/** Closed reason a training-signal payload failed independent validation. */
export const SCHEMA_VIOLATIONS = [
  "unknown_archetype",
  "unknown_field",
  "missing_field",
  "value_out_of_domain",
  "excess_precision",
  "excess_cardinality",
  "non_canonical_encoding",
  "invalid_field_combination",
  "schema_version_mismatch",
] as const;

export type SchemaViolation = (typeof SCHEMA_VIOLATIONS)[number];

/**
 * Closed, code-specific failure details.
 *
 * Member names are the wire names. A host that renamed them to a local spelling would be
 * maintaining a second vocabulary for the same contract, and a log line and a payload would
 * eventually disagree about the same value.
 */
export interface FoundationErrorDetails {
  readonly required_contract_version?: string;
  readonly supported_contract_version?: string;
  readonly port?: ContextPort;
  readonly variant_kind?: VariantKind;
  readonly bound_subject_id?: SubjectId;
  readonly attempted_subject_id?: SubjectId;
  readonly proposal_id?: ProposalId;
  readonly requested_capability?: CapabilityName;
  readonly schema_violation?: SchemaViolation;
  readonly field?: string;
}

/**
 * Deterministic failure carried across every foundation binding.
 *
 * A failure is an observable outcome. Nothing on either side of this boundary substitutes a
 * fabricated success, acknowledgement, or completion for one of these values.
 */
export interface FoundationErrorValue {
  readonly code: ErrorCode;
  readonly operation_id?: OperationId;
  readonly details?: FoundationErrorDetails;
}

/** A `FoundationErrorValue` raised as a JavaScript exception. */
export class FoundationFailure extends Error {
  public constructor(
    public readonly error: FoundationErrorValue,
    options?: ErrorOptions,
  ) {
    super(error.code, options);
    this.name = "FoundationFailure";
  }

  public get code(): ErrorCode {
    return this.error.code;
  }
}

function isMember(value: CanonicalJsonValue): value is { readonly [member: string]: CanonicalJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(vocabulary: readonly T[], value: CanonicalJsonValue): T | undefined {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Reads a canonical `op_` identifier out of a payload whose shape is not otherwise trusted.
 *
 * A refusal that can still name the operation it refused is worth more to a caller than one
 * that cannot, and reading this member commits to nothing else about the payload.
 */
export function correlationOf(value: CanonicalJsonValue): OperationId | undefined {
  if (!isMember(value)) {
    return undefined;
  }
  const candidate = value["operation_id"];
  return typeof candidate === "string" && isIdentifier("operation", candidate)
    ? candidate
    : undefined;
}

/** Builds the `malformed_envelope` failure a host reports for an undecodable payload. */
export function malformedEnvelope(operation_id: OperationId | undefined): FoundationErrorValue {
  return operation_id === undefined
    ? { code: "malformed_envelope" }
    : { code: "malformed_envelope", operation_id };
}

const DETAIL_MEMBERS = [
  "required_contract_version",
  "supported_contract_version",
  "port",
  "variant_kind",
  "bound_subject_id",
  "attempted_subject_id",
  "proposal_id",
  "requested_capability",
  "schema_violation",
  "field",
] as const;

function decodeDetails(value: CanonicalJsonValue): FoundationErrorDetails | undefined {
  if (!isMember(value)) {
    return undefined;
  }
  const details: Record<string, unknown> = {};
  for (const [member, nested] of Object.entries(value)) {
    if (!(DETAIL_MEMBERS as readonly string[]).includes(member)) {
      return undefined;
    }
    switch (member) {
      case "required_contract_version":
      case "supported_contract_version":
      case "field": {
        if (typeof nested !== "string") {
          return undefined;
        }
        details[member] = nested;
        break;
      }
      case "port": {
        const port = oneOf(CONTEXT_PORTS, nested);
        if (port === undefined) {
          return undefined;
        }
        details[member] = port;
        break;
      }
      case "variant_kind": {
        const kind = oneOf(VARIANT_KINDS, nested);
        if (kind === undefined) {
          return undefined;
        }
        details[member] = kind;
        break;
      }
      case "schema_violation": {
        const violation = oneOf(SCHEMA_VIOLATIONS, nested);
        if (violation === undefined) {
          return undefined;
        }
        details[member] = violation;
        break;
      }
      case "bound_subject_id":
      case "attempted_subject_id": {
        if (typeof nested !== "string" || !isIdentifier("subject", nested)) {
          return undefined;
        }
        details[member] = nested;
        break;
      }
      case "proposal_id": {
        if (typeof nested !== "string" || !isIdentifier("proposal", nested)) {
          return undefined;
        }
        details[member] = nested;
        break;
      }
      default: {
        if (typeof nested !== "string" || !isCapabilityName(nested)) {
          return undefined;
        }
        details[member] = nested;
        break;
      }
    }
  }
  return details as FoundationErrorDetails;
}

/**
 * Decodes a foundation failure.
 *
 * The taxonomy is closed on this side too: an unrecognized code, an unrecognized detail
 * member, or a detail carrying a value outside its vocabulary is refused rather than passed
 * through as an opaque string a host would then render as if it understood it.
 *
 * @throws {FoundationFailure} carrying `malformed_envelope` when the payload is not a
 * foundation failure.
 */
export function decodeFoundationError(value: CanonicalJsonValue): FoundationErrorValue {
  const refuse = (): never => {
    throw new FoundationFailure(malformedEnvelope(correlationOf(value)));
  };
  if (!isMember(value)) {
    return refuse();
  }

  let code: ErrorCode | undefined;
  let operation_id: OperationId | undefined;
  let details: FoundationErrorDetails | undefined;
  for (const [member, nested] of Object.entries(value)) {
    switch (member) {
      case "code": {
        code = oneOf(ERROR_CODES, nested);
        if (code === undefined) {
          return refuse();
        }
        break;
      }
      case "operation_id": {
        if (typeof nested !== "string" || !isIdentifier("operation", nested)) {
          return refuse();
        }
        operation_id = nested;
        break;
      }
      case "details": {
        details = decodeDetails(nested);
        if (details === undefined) {
          return refuse();
        }
        break;
      }
      default:
        return refuse();
    }
  }
  if (code === undefined) {
    return refuse();
  }

  const decoded: { code: ErrorCode; operation_id?: OperationId; details?: FoundationErrorDetails } =
    { code };
  if (operation_id !== undefined) {
    decoded.operation_id = operation_id;
  }
  if (details !== undefined) {
    decoded.details = details;
  }
  return decoded;
}

/** Encodes a foundation failure back into its wire form, omitting absent members. */
export function encodeFoundationError(error: FoundationErrorValue): CanonicalJsonValue {
  const encoded: Record<string, CanonicalJsonValue> = { code: error.code };
  if (error.operation_id !== undefined) {
    encoded["operation_id"] = error.operation_id;
  }
  if (error.details !== undefined) {
    const details: Record<string, CanonicalJsonValue> = {};
    for (const member of DETAIL_MEMBERS) {
      const value = error.details[member];
      if (value !== undefined) {
        details[member] = value;
      }
    }
    encoded["details"] = details;
  }
  return encoded;
}
