// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import type { CanonicalJsonValue } from "./canonical.js";
import { isCapabilityName, type CapabilityName } from "./capability.js";
import {
  correlationOf,
  decodeFoundationError,
  encodeFoundationError,
  FoundationFailure,
  malformedEnvelope,
  type FoundationErrorValue,
} from "./error.js";
import {
  isIdentifier,
  type IdentifierKind,
  type Identifier,
  type OperationId,
  type ProposalId,
  type SessionId,
} from "./identifier.js";
import { formatDecimalU64, isDecimalU64, parseDecimalU64 } from "./scalar.js";
import {
  formatContractVersion,
  parseContractVersion,
  type ContractVersion,
} from "./version.js";

/**
 * Turns one product payload into the host's own value.
 *
 * The foundation never learns what a wake reason, a proposal, or an effect means. A decoder
 * that refuses an unrecognized variant should raise its own failure — this module lets that
 * failure through rather than flattening it into `malformed_envelope`, because "the payload
 * was not a shape I know" and "this product enumeration has no such variant" are different
 * facts for a caller.
 */
export type PayloadDecoder<T> = (value: CanonicalJsonValue) => T;

/** Turns one product payload back into its wire form. */
export type PayloadEncoder<T> = (value: T) => CanonicalJsonValue;

/** Closed envelope carrying the external occurrence that woke a runtime. */
export interface WakeEnvelope<R> {
  readonly contract_version: ContractVersion;
  readonly operation_id: OperationId;
  readonly session_id: SessionId;
  readonly observed_at_unix_ms: bigint;
  readonly reason: R;
}

/** Closed envelope carrying one candidate action produced by computation. */
export interface ProposalEnvelope<P> {
  readonly contract_version: ContractVersion;
  readonly operation_id: OperationId;
  readonly proposal_id: ProposalId;
  readonly sequence: bigint;
  readonly requested_capability: CapabilityName;
  readonly proposal: P;
}

/** Closed envelope carrying a proposal an authority port admitted. */
export interface AdmissionEnvelope<A> {
  readonly contract_version: ContractVersion;
  readonly operation_id: OperationId;
  readonly proposal_id: ProposalId;
  readonly sequence: bigint;
  readonly granted_capability: CapabilityName;
  readonly action: A;
}

/** Closed effect-request envelope. Dispatch is a request, never completion evidence. */
export interface EffectRequestEnvelope<F> {
  readonly contract_version: ContractVersion;
  readonly operation_id: OperationId;
  readonly sequence: bigint;
  readonly effect: F;
}

/** Successful result of one runtime turn, before the outer `ok` member. */
export interface TurnOk<P, F> {
  readonly contract_version: ContractVersion;
  readonly operation_id: OperationId;
  readonly session_revision: bigint;
  readonly proposals: readonly ProposalEnvelope<P>[];
  readonly effect_requests: readonly EffectRequestEnvelope<F>[];
}

/** Closed turn result: exactly one `ok` or `error` member. */
export type TurnOutcome<P, F> =
  | { readonly ok: TurnOk<P, F> }
  | { readonly error: FoundationErrorValue };

function refuse(source: CanonicalJsonValue): never {
  throw new FoundationFailure(malformedEnvelope(correlationOf(source)));
}

function members(
  source: CanonicalJsonValue,
  expected: readonly string[],
): Record<string, CanonicalJsonValue> {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    refuse(source);
  }
  const present = Object.keys(source);
  if (present.length !== expected.length || !expected.every((name) => name in source)) {
    // Every member of a closed envelope is required and no other member is defined, so a
    // payload that is missing one or carries an extra is not this envelope.
    refuse(source);
  }
  return source as Record<string, CanonicalJsonValue>;
}

function readIdentifier<K extends IdentifierKind>(
  source: CanonicalJsonValue,
  value: CanonicalJsonValue | undefined,
  kind: K,
): Identifier<K> {
  if (typeof value !== "string" || !isIdentifier(kind, value)) {
    refuse(source);
  }
  return value;
}

function readDecimal(source: CanonicalJsonValue, value: CanonicalJsonValue | undefined): bigint {
  if (typeof value !== "string" || !isDecimalU64(value)) {
    refuse(source);
  }
  return parseDecimalU64(value);
}

function readCapability(
  source: CanonicalJsonValue,
  value: CanonicalJsonValue | undefined,
): CapabilityName {
  if (typeof value !== "string" || !isCapabilityName(value)) {
    refuse(source);
  }
  return value;
}

function readVersion(
  source: CanonicalJsonValue,
  value: CanonicalJsonValue | undefined,
): ContractVersion {
  if (typeof value !== "string") {
    refuse(source);
  }
  try {
    return parseContractVersion(value);
  } catch {
    refuse(source);
  }
}

function readArray(
  source: CanonicalJsonValue,
  value: CanonicalJsonValue | undefined,
): readonly CanonicalJsonValue[] {
  if (!Array.isArray(value)) {
    refuse(source);
  }
  return value;
}

const WAKE_MEMBERS = [
  "contract_version",
  "operation_id",
  "session_id",
  "observed_at_unix_ms",
  "reason",
] as const;

/**
 * Decodes a wake envelope.
 *
 * Decoding checks shape, not compatibility: run `requireCompatibleContract` on the peer's
 * claim first if the line it names has not already been agreed.
 *
 * @throws {FoundationFailure} carrying `malformed_envelope` when the payload is not one.
 */
export function decodeWakeEnvelope<R>(
  source: CanonicalJsonValue,
  decodeReason: PayloadDecoder<R>,
): WakeEnvelope<R> {
  const fields = members(source, WAKE_MEMBERS);
  return {
    contract_version: readVersion(source, fields["contract_version"]),
    operation_id: readIdentifier(source, fields["operation_id"], "operation"),
    session_id: readIdentifier(source, fields["session_id"], "session"),
    observed_at_unix_ms: readDecimal(source, fields["observed_at_unix_ms"]),
    reason: decodeReason(fields["reason"] as CanonicalJsonValue),
  };
}

const PROPOSAL_MEMBERS = [
  "contract_version",
  "operation_id",
  "proposal_id",
  "sequence",
  "requested_capability",
  "proposal",
] as const;

/**
 * Decodes a proposal envelope.
 *
 * A decoded proposal is computation a runtime produced. It is not a decision and not an
 * action: only an authority decision inside the session's delegation scope makes one an
 * attempt, and that decision is not taken on this side of the boundary.
 *
 * @throws {FoundationFailure} carrying `malformed_envelope` when the payload is not one.
 */
export function decodeProposalEnvelope<P>(
  source: CanonicalJsonValue,
  decodeProposal: PayloadDecoder<P>,
): ProposalEnvelope<P> {
  const fields = members(source, PROPOSAL_MEMBERS);
  return {
    contract_version: readVersion(source, fields["contract_version"]),
    operation_id: readIdentifier(source, fields["operation_id"], "operation"),
    proposal_id: readIdentifier(source, fields["proposal_id"], "proposal"),
    sequence: readDecimal(source, fields["sequence"]),
    requested_capability: readCapability(source, fields["requested_capability"]),
    proposal: decodeProposal(fields["proposal"] as CanonicalJsonValue),
  };
}

const ADMISSION_MEMBERS = [
  "contract_version",
  "operation_id",
  "proposal_id",
  "sequence",
  "granted_capability",
  "action",
] as const;

/**
 * Decodes an admission envelope.
 *
 * Admission is permission to attempt, never evidence that the action occurred or that a
 * counterpart accepted it.
 *
 * @throws {FoundationFailure} carrying `malformed_envelope` when the payload is not one.
 */
export function decodeAdmissionEnvelope<A>(
  source: CanonicalJsonValue,
  decodeAction: PayloadDecoder<A>,
): AdmissionEnvelope<A> {
  const fields = members(source, ADMISSION_MEMBERS);
  return {
    contract_version: readVersion(source, fields["contract_version"]),
    operation_id: readIdentifier(source, fields["operation_id"], "operation"),
    proposal_id: readIdentifier(source, fields["proposal_id"], "proposal"),
    sequence: readDecimal(source, fields["sequence"]),
    granted_capability: readCapability(source, fields["granted_capability"]),
    action: decodeAction(fields["action"] as CanonicalJsonValue),
  };
}

const EFFECT_MEMBERS = ["contract_version", "operation_id", "sequence", "effect"] as const;

/**
 * Decodes an effect-request envelope.
 *
 * @throws {FoundationFailure} carrying `malformed_envelope` when the payload is not one.
 */
export function decodeEffectRequestEnvelope<F>(
  source: CanonicalJsonValue,
  decodeEffect: PayloadDecoder<F>,
): EffectRequestEnvelope<F> {
  const fields = members(source, EFFECT_MEMBERS);
  return {
    contract_version: readVersion(source, fields["contract_version"]),
    operation_id: readIdentifier(source, fields["operation_id"], "operation"),
    sequence: readDecimal(source, fields["sequence"]),
    effect: decodeEffect(fields["effect"] as CanonicalJsonValue),
  };
}

const TURN_OK_MEMBERS = [
  "contract_version",
  "operation_id",
  "session_revision",
  "proposals",
  "effect_requests",
] as const;

/**
 * Decodes the successful half of a turn report.
 *
 * @throws {FoundationFailure} carrying `malformed_envelope` when the payload is not one.
 */
export function decodeTurnOk<P, F>(
  source: CanonicalJsonValue,
  decodeProposal: PayloadDecoder<P>,
  decodeEffect: PayloadDecoder<F>,
): TurnOk<P, F> {
  const fields = members(source, TURN_OK_MEMBERS);
  return {
    contract_version: readVersion(source, fields["contract_version"]),
    operation_id: readIdentifier(source, fields["operation_id"], "operation"),
    session_revision: readDecimal(source, fields["session_revision"]),
    proposals: readArray(source, fields["proposals"]).map((entry) =>
      decodeProposalEnvelope(entry, decodeProposal),
    ),
    effect_requests: readArray(source, fields["effect_requests"]).map((entry) =>
      decodeEffectRequestEnvelope(entry, decodeEffect),
    ),
  };
}

/**
 * Decodes a turn result.
 *
 * The conversion the kernel makes from `Result` is total, so a turn is either an `ok` or an
 * `error` member and a failed turn is never reported as an empty success. This decoder
 * requires exactly one of the two: a payload carrying both, neither, or an extra member is
 * refused rather than resolved by preferring one.
 *
 * @throws {FoundationFailure} carrying `malformed_envelope` when the payload is not one.
 */
export function decodeTurnOutcome<P, F>(
  source: CanonicalJsonValue,
  decodeProposal: PayloadDecoder<P>,
  decodeEffect: PayloadDecoder<F>,
): TurnOutcome<P, F> {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    refuse(source);
  }
  const present = Object.keys(source);
  if (present.length !== 1) {
    refuse(source);
  }
  if (present[0] === "ok") {
    return {
      ok: decodeTurnOk(
        (source as Record<string, CanonicalJsonValue>)["ok"] as CanonicalJsonValue,
        decodeProposal,
        decodeEffect,
      ),
    };
  }
  if (present[0] === "error") {
    return {
      error: decodeFoundationError(
        (source as Record<string, CanonicalJsonValue>)["error"] as CanonicalJsonValue,
      ),
    };
  }
  return refuse(source);
}

/** Encodes a wake envelope back into its wire form. */
export function encodeWakeEnvelope<R>(
  envelope: WakeEnvelope<R>,
  encodeReason: PayloadEncoder<R>,
): CanonicalJsonValue {
  return {
    contract_version: formatContractVersion(envelope.contract_version),
    operation_id: envelope.operation_id,
    session_id: envelope.session_id,
    observed_at_unix_ms: formatDecimalU64(envelope.observed_at_unix_ms),
    reason: encodeReason(envelope.reason),
  };
}

/** Encodes an admission envelope back into its wire form. */
export function encodeAdmissionEnvelope<A>(
  envelope: AdmissionEnvelope<A>,
  encodeAction: PayloadEncoder<A>,
): CanonicalJsonValue {
  return {
    contract_version: formatContractVersion(envelope.contract_version),
    operation_id: envelope.operation_id,
    proposal_id: envelope.proposal_id,
    sequence: formatDecimalU64(envelope.sequence),
    granted_capability: envelope.granted_capability,
    action: encodeAction(envelope.action),
  };
}

/** Encodes a proposal envelope back into its wire form. */
export function encodeProposalEnvelope<P>(
  envelope: ProposalEnvelope<P>,
  encodeProposal: PayloadEncoder<P>,
): CanonicalJsonValue {
  return {
    contract_version: formatContractVersion(envelope.contract_version),
    operation_id: envelope.operation_id,
    proposal_id: envelope.proposal_id,
    sequence: formatDecimalU64(envelope.sequence),
    requested_capability: envelope.requested_capability,
    proposal: encodeProposal(envelope.proposal),
  };
}

/** Encodes an effect-request envelope back into its wire form. */
export function encodeEffectRequestEnvelope<F>(
  envelope: EffectRequestEnvelope<F>,
  encodeEffect: PayloadEncoder<F>,
): CanonicalJsonValue {
  return {
    contract_version: formatContractVersion(envelope.contract_version),
    operation_id: envelope.operation_id,
    sequence: formatDecimalU64(envelope.sequence),
    effect: encodeEffect(envelope.effect),
  };
}

/** Encodes a turn result back into its wire form. */
export function encodeTurnOutcome<P, F>(
  outcome: TurnOutcome<P, F>,
  encodeProposal: PayloadEncoder<P>,
  encodeEffect: PayloadEncoder<F>,
): CanonicalJsonValue {
  if ("error" in outcome) {
    return { error: encodeFoundationError(outcome.error) };
  }
  const turn = outcome.ok;
  return {
    ok: {
      contract_version: formatContractVersion(turn.contract_version),
      operation_id: turn.operation_id,
      session_revision: formatDecimalU64(turn.session_revision),
      proposals: turn.proposals.map((entry) => encodeProposalEnvelope(entry, encodeProposal)),
      effect_requests: turn.effect_requests.map((entry) =>
        encodeEffectRequestEnvelope(entry, encodeEffect),
      ),
    },
  };
}
