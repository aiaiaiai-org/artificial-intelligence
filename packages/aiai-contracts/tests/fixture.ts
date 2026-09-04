// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import type { CanonicalJsonValue, IdentifierKind } from "../src/index.js";

export interface WireFixture {
  readonly contract_version: string;
  readonly contract_versions: {
    readonly accepted: readonly string[];
    readonly rejected: readonly string[];
    readonly compatibility: readonly {
      readonly required: string;
      readonly provider: string;
      readonly accepted: boolean;
    }[];
    readonly handshake: readonly {
      readonly requested: string;
      readonly accepted: boolean;
      readonly error?: string;
    }[];
  };
  readonly decimal_u64: {
    readonly max: string;
    readonly accepted: readonly string[];
    readonly rejected: readonly string[];
  };
  readonly identifiers: Readonly<
    Record<
      IdentifierKind,
      {
        readonly prefix: string;
        readonly hex_length: number;
        readonly accepted: readonly string[];
        readonly rejected: readonly string[];
      }
    >
  >;
  readonly capability_names: {
    readonly max_length: number;
    readonly accepted: readonly string[];
    readonly rejected: readonly string[];
  };
  readonly error_codes: readonly string[];
  readonly failure_classification: {
    readonly kinds: readonly string[];
    readonly retryable_kinds: readonly string[];
    readonly by_code: Readonly<Record<string, string>>;
  };
  readonly context_ports: readonly string[];
  readonly variant_kinds: readonly string[];
  readonly schema_violations: readonly string[];
  readonly canonical_json: {
    readonly accepted: readonly { readonly input: string; readonly canonical: string }[];
    readonly rejected: readonly { readonly input: string; readonly reason: string }[];
  };
  readonly documents: {
    readonly foundation_errors: readonly string[];
    readonly wake_envelopes: readonly string[];
    readonly proposal_envelopes: readonly string[];
    readonly admission_envelopes: readonly string[];
    readonly effect_request_envelopes: readonly string[];
    readonly turn_outcomes: readonly string[];
    readonly failure_records: readonly string[];
  };
  readonly invalid_documents: readonly {
    readonly shape: string;
    readonly document: string;
    readonly carries: string;
  }[];
  readonly activation: {
    readonly states: readonly string[];
    readonly transitions: readonly string[];
    readonly may_initiate: readonly string[];
    readonly may_settle_in_flight: readonly string[];
    readonly apply: readonly {
      readonly state: string;
      readonly transition: string;
      readonly result: string | null;
    }[];
    readonly resolve: readonly {
      readonly state: string;
      readonly target: string;
      readonly outcome: string;
      readonly transition?: string;
    }[];
  };
}

/**
 * Reads the shared conformance corpus.
 *
 * The file itself is a test harness, not a contract payload — it carries JSON numbers for
 * lengths — so it is read with `JSON.parse` rather than through the canonical decoder the
 * corpus exists to exercise.
 */
export function readWireFixture(): WireFixture {
  const path = new URL("../../../../fixtures/contract-wire-0.2.0.json", import.meta.url);
  return JSON.parse(readFileSync(path, "utf-8")) as WireFixture;
}

/** Payload decoder that keeps a product payload exactly as it arrived. */
export const passthroughDecoder = (value: CanonicalJsonValue): CanonicalJsonValue => value;

/** Payload encoder that emits a product payload exactly as it was decoded. */
export const passthroughEncoder = (value: CanonicalJsonValue): CanonicalJsonValue => value;
