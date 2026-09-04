// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVATION_STATES,
  ACTIVATION_TRANSITIONS,
  applyActivation,
  acceptsProvider,
  CanonicalJsonError,
  CAPABILITY_NAME_MAX_LEN,
  CONTEXT_PORTS,
  CONTRACT_VERSION,
  DECIMAL_U64_MAX,
  decodeAdmissionEnvelope,
  decodeCanonicalJson,
  decodeEffectRequestEnvelope,
  decodeFailureRecord,
  decodeFoundationError,
  decodeProposalEnvelope,
  decodeTurnOutcome,
  decodeWakeEnvelope,
  encodeAdmissionEnvelope,
  encodeCanonicalJson,
  encodeEffectRequestEnvelope,
  encodeFailureRecord,
  encodeFoundationError,
  encodeProposalEnvelope,
  encodeTurnOutcome,
  encodeWakeEnvelope,
  ERROR_CODES,
  FAILURE_KINDS,
  failureKind,
  formatDecimalU64,
  IDENTIFIER_SHAPES,
  isCapabilityName,
  isDecimalU64,
  isIdentifier,
  isRetryable,
  mayInitiate,
  maySettleInFlight,
  parseContractVersion,
  parseDecimalU64,
  requireCompatibleContract,
  resolveActivation,
  SCHEMA_VIOLATIONS,
  VARIANT_KINDS,
  type ActivationState,
  type ErrorCode,
  type FailureKind,
  type IdentifierKind,
} from "../src/index.js";
import { passthroughDecoder, passthroughEncoder, readWireFixture } from "./fixture.js";

const fixture = readWireFixture();

test("the corpus and the package name the same contract line", () => {
  assert.equal(fixture.contract_version, CONTRACT_VERSION);
});

test("contract versions parse exactly as the corpus says", () => {
  for (const value of fixture.contract_versions.accepted) {
    assert.doesNotThrow(() => parseContractVersion(value), value);
  }
  for (const value of fixture.contract_versions.rejected) {
    assert.throws(() => parseContractVersion(value), { reason: "non_canonical_version" }, value);
  }
});

test("compatibility answers match the corpus", () => {
  for (const entry of fixture.contract_versions.compatibility) {
    assert.equal(
      acceptsProvider(parseContractVersion(entry.required), parseContractVersion(entry.provider)),
      entry.accepted,
      `${entry.required} accepts ${entry.provider}`,
    );
  }
});

test("the handshake refuses with the failure the corpus records", () => {
  for (const entry of fixture.contract_versions.handshake) {
    if (entry.accepted) {
      assert.doesNotThrow(() => requireCompatibleContract(entry.requested), entry.requested);
      continue;
    }
    assert.notEqual(entry.error, undefined);
    try {
      requireCompatibleContract(entry.requested);
      assert.fail(`${entry.requested} must be refused`);
    } catch (failure) {
      assert.ok(failure instanceof Error && "error" in failure);
      const encoded = encodeFoundationError(
        (failure as { error: Parameters<typeof encodeFoundationError>[0] }).error,
      );
      assert.equal(encodeCanonicalJson(encoded), entry.error);
    }
  }
});

test("decimal integers parse exactly as the corpus says", () => {
  assert.equal(formatDecimalU64(DECIMAL_U64_MAX), fixture.decimal_u64.max);
  for (const value of fixture.decimal_u64.accepted) {
    assert.ok(isDecimalU64(value), value);
    assert.equal(formatDecimalU64(parseDecimalU64(value)), value);
  }
  for (const value of fixture.decimal_u64.rejected) {
    assert.ok(!isDecimalU64(value), value);
    assert.throws(() => parseDecimalU64(value), { reason: "non_canonical_decimal" }, value);
  }
});

test("identifier shapes and their corpus agree", () => {
  const kinds = Object.keys(fixture.identifiers) as IdentifierKind[];
  assert.deepEqual(kinds.sort(), Object.keys(IDENTIFIER_SHAPES).sort());
  for (const kind of kinds) {
    const entry = fixture.identifiers[kind];
    assert.equal(IDENTIFIER_SHAPES[kind].prefix, entry.prefix);
    assert.equal(IDENTIFIER_SHAPES[kind].hexLength, entry.hex_length);
    for (const value of entry.accepted) {
      assert.ok(isIdentifier(kind, value), `${kind}: ${value}`);
    }
    for (const value of entry.rejected) {
      assert.ok(!isIdentifier(kind, value), `${kind}: ${value}`);
    }
  }
});

test("capability names parse exactly as the corpus says", () => {
  assert.equal(CAPABILITY_NAME_MAX_LEN, fixture.capability_names.max_length);
  for (const value of fixture.capability_names.accepted) {
    assert.ok(isCapabilityName(value), value);
  }
  for (const value of fixture.capability_names.rejected) {
    assert.ok(!isCapabilityName(value), value);
  }
});

test("the closed vocabularies are spelled the same on both sides", () => {
  assert.deepEqual([...ERROR_CODES], fixture.error_codes);
  assert.deepEqual([...CONTEXT_PORTS], fixture.context_ports);
  assert.deepEqual([...VARIANT_KINDS], fixture.variant_kinds);
  assert.deepEqual([...SCHEMA_VIOLATIONS], fixture.schema_violations);
});

test("every code is classified exactly as the corpus says", () => {
  assert.deepEqual([...FAILURE_KINDS], fixture.failure_classification.kinds);
  const byCode = fixture.failure_classification.by_code;
  assert.deepEqual(Object.keys(byCode).sort(), [...ERROR_CODES].sort());
  for (const code of ERROR_CODES) {
    const expected = byCode[code as ErrorCode];
    assert.equal(failureKind(code), expected, code);
    // Retryability is derived from the kind rather than listed per code, so the corpus
    // cannot record a code that is retryable while its kind is not.
    assert.equal(
      isRetryable(code),
      fixture.failure_classification.retryable_kinds.includes(expected as FailureKind),
      code,
    );
  }
});

test("failure records survive a decode and re-encode unchanged", () => {
  for (const document of fixture.documents.failure_records) {
    const decoded = decodeFailureRecord(decodeCanonicalJson(document));
    assert.equal(typeof decoded.recorded_at_unix_ms, "bigint");
    assert.ok((ERROR_CODES as readonly string[]).includes(decoded.error.code));
    assert.equal(encodeCanonicalJson(encodeFailureRecord(decoded)), document);
  }
});

test("canonical JSON encodes to the bytes the corpus records", () => {
  for (const entry of fixture.canonical_json.accepted) {
    assert.equal(encodeCanonicalJson(decodeCanonicalJson(entry.input)), entry.canonical, entry.input);
    // Canonicalization is idempotent: encoding an already-canonical payload changes nothing.
    assert.equal(
      encodeCanonicalJson(decodeCanonicalJson(entry.canonical)),
      entry.canonical,
      entry.canonical,
    );
  }
});

test("canonical JSON refuses the corpus with the reason it records", () => {
  for (const entry of fixture.canonical_json.rejected) {
    try {
      decodeCanonicalJson(entry.input);
      assert.fail(`must be refused: ${entry.input}`);
    } catch (error) {
      assert.ok(error instanceof CanonicalJsonError, entry.input);
      assert.equal(error.reason, entry.reason, entry.input);
    }
  }
});

test("foundation failures survive a decode and re-encode unchanged", () => {
  for (const document of fixture.documents.foundation_errors) {
    const decoded = decodeFoundationError(decodeCanonicalJson(document));
    assert.ok((ERROR_CODES as readonly string[]).includes(decoded.code), document);
    assert.equal(encodeCanonicalJson(encodeFoundationError(decoded)), document);
  }
});

test("envelopes survive a decode and re-encode unchanged", () => {
  for (const document of fixture.documents.wake_envelopes) {
    const decoded = decodeWakeEnvelope(decodeCanonicalJson(document), passthroughDecoder);
    assert.equal(
      encodeCanonicalJson(encodeWakeEnvelope(decoded, passthroughEncoder)),
      document,
    );
  }
  for (const document of fixture.documents.proposal_envelopes) {
    const decoded = decodeProposalEnvelope(decodeCanonicalJson(document), passthroughDecoder);
    assert.equal(
      encodeCanonicalJson(encodeProposalEnvelope(decoded, passthroughEncoder)),
      document,
    );
  }
  for (const document of fixture.documents.admission_envelopes) {
    const decoded = decodeAdmissionEnvelope(decodeCanonicalJson(document), passthroughDecoder);
    assert.equal(
      encodeCanonicalJson(encodeAdmissionEnvelope(decoded, passthroughEncoder)),
      document,
    );
  }
  for (const document of fixture.documents.effect_request_envelopes) {
    const decoded = decodeEffectRequestEnvelope(decodeCanonicalJson(document), passthroughDecoder);
    assert.equal(
      encodeCanonicalJson(encodeEffectRequestEnvelope(decoded, passthroughEncoder)),
      document,
    );
  }
  for (const document of fixture.documents.turn_outcomes) {
    const decoded = decodeTurnOutcome(
      decodeCanonicalJson(document),
      passthroughDecoder,
      passthroughDecoder,
    );
    assert.equal(
      encodeCanonicalJson(encodeTurnOutcome(decoded, passthroughEncoder, passthroughEncoder)),
      document,
    );
  }
});

test("a sequence near the ceiling survives the round trip exactly", () => {
  const document = fixture.documents.proposal_envelopes.find((entry) =>
    entry.includes(fixture.decimal_u64.max),
  );
  assert.ok(document !== undefined, "the corpus carries a ceiling sequence");
  const decoded = decodeProposalEnvelope(decodeCanonicalJson(document), passthroughDecoder);
  assert.equal(decoded.sequence, DECIMAL_U64_MAX);
  assert.equal(typeof decoded.sequence, "bigint");
});

test("every invalid document in the corpus is refused", () => {
  for (const entry of fixture.invalid_documents) {
    assert.throws(
      () => {
        const value = decodeCanonicalJson(entry.document);
        switch (entry.shape) {
          case "foundation_error":
            return decodeFoundationError(value);
          case "wake_envelope":
            return decodeWakeEnvelope(value, passthroughDecoder);
          case "proposal_envelope":
            return decodeProposalEnvelope(value, passthroughDecoder);
          case "admission_envelope":
            return decodeAdmissionEnvelope(value, passthroughDecoder);
          case "effect_request_envelope":
            return decodeEffectRequestEnvelope(value, passthroughDecoder);
          case "turn_outcome":
            return decodeTurnOutcome(value, passthroughDecoder, passthroughDecoder);
          case "failure_record":
            return decodeFailureRecord(value);
          default:
            throw new Error(`the corpus names an unknown shape: ${entry.shape}`);
        }
      },
      // Refusal may come from either boundary — the wire layer for a numeric token, the
      // typed layer for a shape — and which one answered first is not the contract. That
      // the payload never becomes a value a host would act on is.
      (error: unknown) => error instanceof Error,
      `${entry.shape} carrying ${entry.carries}`,
    );
  }
});

test("the activation gate answers exactly as the corpus says", () => {
  assert.deepEqual([...ACTIVATION_STATES], fixture.activation.states);
  assert.deepEqual([...ACTIVATION_TRANSITIONS], fixture.activation.transitions);
  for (const state of ACTIVATION_STATES) {
    assert.equal(mayInitiate(state), fixture.activation.may_initiate.includes(state), state);
    assert.equal(
      maySettleInFlight(state),
      fixture.activation.may_settle_in_flight.includes(state),
      state,
    );
  }
  for (const entry of fixture.activation.apply) {
    const state = entry.state as ActivationState;
    const transition = entry.transition as (typeof ACTIVATION_TRANSITIONS)[number];
    if (entry.result === null) {
      assert.throws(() => applyActivation(state, transition), `${entry.state}+${entry.transition}`);
    } else {
      assert.equal(applyActivation(state, transition), entry.result);
    }
  }
  for (const entry of fixture.activation.resolve) {
    const state = entry.state as ActivationState;
    const target = entry.target as ActivationState;
    switch (entry.outcome) {
      case "settled":
        assert.equal(resolveActivation(state, target), undefined, `${entry.state}->${entry.target}`);
        break;
      case "step":
        assert.equal(resolveActivation(state, target), entry.transition);
        break;
      default:
        assert.throws(() => resolveActivation(state, target), `${entry.state}->${entry.target}`);
    }
  }
});
