// © 2026 aiaiaiai · aiaiaiai.org
// SPDX-License-Identifier: Apache-2.0

/**
 * A value in the contract's JSON profile.
 *
 * There is no `number` member on purpose. Contract `0.2.0` forbids JSON numeric tokens so
 * that a host running on IEEE-754 doubles cannot silently narrow an integer a peer sent.
 */
export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [member: string]: CanonicalJsonValue };

/** Closed reason a payload is not canonical contract JSON. */
export type CanonicalJsonRejection =
  | "malformed_json"
  | "number_token"
  | "non_nfc_string"
  | "non_ascii_object_key"
  | "unsupported_value";

/** Refusal raised by the canonical JSON boundary. It repairs nothing. */
export class CanonicalJsonError extends Error {
  public constructor(
    public readonly reason: CanonicalJsonRejection,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CanonicalJsonError";
  }
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

function accept(value: unknown, path: string): CanonicalJsonValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    // `JSON.parse` has already narrowed the token by the time it reaches here. That loss is
    // exactly what the contract forbids the token for, so the only sound answer is refusal:
    // there is no value to recover and none is substituted.
    throw new CanonicalJsonError("number_token", `JSON numeric token at ${path}`);
  }
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) {
      throw new CanonicalJsonError("non_nfc_string", `string at ${path} is not NFC`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element, index) => accept(element, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    // A null prototype keeps a `__proto__` member — which `JSON.parse` materializes as an
    // own property — an ordinary member of the decoded value rather than anything the host
    // resolves through the prototype chain.
    const decoded: Record<string, CanonicalJsonValue> = Object.create(null) as Record<
      string,
      CanonicalJsonValue
    >;
    for (const [member, nested] of Object.entries(value)) {
      if (!isAscii(member)) {
        throw new CanonicalJsonError(
          "non_ascii_object_key",
          `object member name at ${path} is not canonical ASCII`,
        );
      }
      decoded[member] = accept(nested, `${path}.${member}`);
    }
    return decoded;
  }
  throw new CanonicalJsonError("unsupported_value", `value at ${path} has no contract form`);
}

/**
 * Decodes canonical contract JSON.
 *
 * Refuses a numeric token, a string that is not NFC, and an object member name that is not
 * ASCII — the same three refusals `aiai_contracts::canonical_json` makes on the producing
 * side. It does not detect a duplicated object member: `JSON.parse` keeps the last one and
 * reports nothing, so a host that must refuse duplicates has to scan the bytes itself.
 *
 * @throws {CanonicalJsonError} when the bytes are not canonical contract JSON.
 */
export function decodeCanonicalJson(source: string | Uint8Array): CanonicalJsonValue {
  let text: string;
  if (typeof source === "string") {
    text = source;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch (cause) {
      throw new CanonicalJsonError("malformed_json", "payload is not UTF-8", { cause });
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new CanonicalJsonError("malformed_json", "payload is not JSON", { cause });
  }
  return accept(parsed, "$");
}

function write(value: CanonicalJsonValue, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  if (typeof value === "boolean") {
    out.push(value ? "true" : "false");
    return;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    // Unreachable through `CanonicalJsonValue`, and the refusal an untyped caller gets.
    throw new CanonicalJsonError("number_token", `numeric value at ${path} has no contract form`);
  }
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) {
      throw new CanonicalJsonError("non_nfc_string", `string at ${path} is not NFC`);
    }
    out.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((element, index) => {
      if (index > 0) {
        out.push(",");
      }
      write(element, `${path}[${index}]`, out);
    });
    out.push("]");
    return;
  }
  if (typeof value === "object") {
    // Member names are constrained to ASCII, where sorting by UTF-16 code unit and sorting
    // by UTF-8 byte agree. That is what makes this ordering the same one the Rust producer's
    // ordered map emits.
    const record = value as { readonly [member: string]: CanonicalJsonValue };
    const members = Object.keys(record).sort();
    out.push("{");
    members.forEach((member, index) => {
      if (!isAscii(member)) {
        throw new CanonicalJsonError(
          "non_ascii_object_key",
          `object member name at ${path} is not canonical ASCII`,
        );
      }
      if (index > 0) {
        out.push(",");
      }
      out.push(JSON.stringify(member), ":");
      write(record[member] as CanonicalJsonValue, `${path}.${member}`, out);
    });
    out.push("}");
    return;
  }
  throw new CanonicalJsonError(
    "unsupported_value",
    `value at ${path} has no contract form: ${typeof value}`,
  );
}

/**
 * Encodes a contract value as canonical JSON text with ordered ASCII member names.
 *
 * @throws {CanonicalJsonError} when a value has no contract form, a string is not NFC, or
 * an object member name is not canonical ASCII.
 */
export function encodeCanonicalJson(value: CanonicalJsonValue): string {
  const out: string[] = [];
  write(value, "$", out);
  return out.join("");
}

/** Encodes a contract value as canonical JSON bytes. */
export function encodeCanonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return new TextEncoder().encode(encodeCanonicalJson(value));
}
