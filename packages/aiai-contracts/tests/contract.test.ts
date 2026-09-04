// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalJsonError,
  decodeCanonicalJson,
  decodeFoundationError,
  decodeProposalEnvelope,
  decodeTurnOutcome,
  encodeCanonicalJson,
  encodeCanonicalJsonBytes,
  formatSha256Digest,
  FoundationFailure,
  malformedEnvelope,
  nextSequence,
  parseCapabilityName,
  parseIdentifier,
  DECIMAL_U64_MAX,
  type CanonicalJsonValue,
} from "../src/index.js";
import { passthroughDecoder } from "./fixture.js";

const OPERATION = parseIdentifier("operation", `op_${"0123456789abcdef".repeat(2)}`);
const PROPOSAL = parseIdentifier("proposal", `prp_${"0123456789abcdef".repeat(2)}`);

test("a numeric token is refused rather than narrowed", () => {
  // 2^53 + 1 is not representable as a double, so a host that accepted the token would
  // report a different number than the peer sent. Refusal is the only answer that cannot
  // silently disagree with the producer.
  const unrepresentable = "9007199254740993";
  assert.throws(() => decodeCanonicalJson(`{"sequence":${unrepresentable}}`), {
    reason: "number_token",
  });
  const carried = decodeCanonicalJson(`{"sequence":"${unrepresentable}"}`) as Record<
    string,
    CanonicalJsonValue
  >;
  assert.equal(carried["sequence"], unrepresentable);
});

test("a proto member stays an ordinary member of the decoded value", () => {
  const decoded = decodeCanonicalJson('{"__proto__":{"polluted":"yes"}}') as Record<
    string,
    CanonicalJsonValue
  >;
  assert.deepEqual(Object.keys(decoded), ["__proto__"]);
  assert.equal(({} as { polluted?: string }).polluted, undefined);
  assert.equal(encodeCanonicalJson(decoded), '{"__proto__":{"polluted":"yes"}}');
});

test("canonical bytes are UTF-8", () => {
  const bytes = encodeCanonicalJsonBytes({ a: "é" });
  assert.deepEqual([...bytes], [...new TextEncoder().encode('{"a":"é"}')]);
});

test("a duplicated member is not detected, and the last one is what a host sees", () => {
  // Stating the limit is part of the contract: `JSON.parse` keeps the last member and
  // reports nothing, so a host that must refuse duplicates scans the bytes itself.
  const decoded = decodeCanonicalJson('{"a":"1","a":"2"}') as Record<string, CanonicalJsonValue>;
  assert.equal(decoded["a"], "2");
});

test("encoding refuses a value with no contract form", () => {
  assert.throws(
    () => encodeCanonicalJson({ a: 1 } as unknown as CanonicalJsonValue),
    (error: unknown) => error instanceof CanonicalJsonError && error.reason === "number_token",
  );
  assert.throws(
    () => encodeCanonicalJson({ a: undefined } as unknown as CanonicalJsonValue),
    (error: unknown) => error instanceof CanonicalJsonError && error.reason === "unsupported_value",
  );
});

test("a turn carrying both members is refused rather than resolved by preferring one", () => {
  // The kernel's conversion from `Result` produces exactly one member, so a payload with
  // both did not come from a turn. Preferring `ok` would report a success for a turn that
  // also claims to have failed.
  const document = `{"error":{"code":"runtime_inactive"},"ok":{"contract_version":"0.2.0","effect_requests":[],"operation_id":"${OPERATION}","proposals":[],"session_revision":"1"}}`;
  assert.throws(
    () => decodeTurnOutcome(decodeCanonicalJson(document), passthroughDecoder, passthroughDecoder),
    (error: unknown) => error instanceof FoundationFailure && error.code === "malformed_envelope",
  );
});

test("a refusal names the operation it refused when the payload carries one", () => {
  const document = `{"code":"no_such_code","operation_id":"${OPERATION}"}`;
  assert.throws(
    () => decodeFoundationError(decodeCanonicalJson(document)),
    (error: unknown) =>
      error instanceof FoundationFailure &&
      error.code === "malformed_envelope" &&
      error.error.operation_id === OPERATION,
  );
  assert.deepEqual(malformedEnvelope(undefined), { code: "malformed_envelope" });
});

test("a product payload decoder's own failure is not flattened into malformed_envelope", () => {
  const document = `{"contract_version":"0.2.0","operation_id":"${OPERATION}","proposal":{"kind":"unrecognized"},"proposal_id":"${PROPOSAL}","requested_capability":"message","sequence":"1"}`;
  const refuseUnknownVariant = (): never => {
    throw new FoundationFailure({ code: "unknown_variant", details: { variant_kind: "proposal_kind" } });
  };
  assert.throws(
    () => decodeProposalEnvelope(decodeCanonicalJson(document), refuseUnknownVariant),
    (error: unknown) => error instanceof FoundationFailure && error.code === "unknown_variant",
  );
});

test("a sequence fails closed at the ceiling", () => {
  assert.equal(nextSequence(DECIMAL_U64_MAX), undefined);
  assert.equal(nextSequence(1n), 2n);
});

test("a digest is built from its bytes in canonical lower hex", () => {
  const digest = formatSha256Digest(new Uint8Array(32).fill(0xab));
  assert.equal(digest, `sha256_${"ab".repeat(32)}`);
  assert.throws(() => formatSha256Digest(new Uint8Array(31)), {
    reason: "non_canonical_identifier",
  });
});

test("parsing refuses a value from another kind", () => {
  assert.throws(() => parseIdentifier("session", OPERATION), {
    reason: "non_canonical_identifier",
  });
  assert.throws(() => parseCapabilityName("deliver__asset"), {
    reason: "non_canonical_capability",
  });
});
