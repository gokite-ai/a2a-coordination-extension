/**
 * The engine's commitment hash.
 *
 * sha256 over a canonical JSON form with sorted keys and an
 * INTEGERS-ONLY rule. The rule is the point — a commitment to a fraction is a
 * commitment to a float formatter, so every figure is scaled to minor units
 * or basis points before it is hashed (see `statsCommitment` in places.ts).
 *
 * For the integer-only, plain-ASCII-keyed objects the engine hashes, this
 * canonical form is byte-identical to RFC 8785. The same supported object
 * therefore produces the same bytes and digest under either encoding, and
 * `test/golden.test.ts` pins the engine digests used by the public fixtures.
 */
import { createHash } from "node:crypto";

export class CanonicalError extends Error {}

export type Sha256 = `sha256:${string}`;

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalError(`Non-finite number at ${path}: canonical form must be reproducible.`);
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalError(
          `Non-integer or unsafe number at ${path} (${value}). Commitment hashing takes integers ` +
            `only — scale to minor units or basis points before hashing.`,
        );
      }
      return JSON.stringify(value);
    }
    case "undefined":
      throw new CanonicalError(`Cannot canonicalize undefined at ${path}.`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(",")}]`;
  }

  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalError(
        `Non-plain object at ${path} (${(value as object).constructor?.name ?? "unknown"}). ` +
          `Convert to a plain object before hashing.`,
      );
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v, `${path}.${k}`)}`).join(",")}}`;
  }

  throw new CanonicalError(`Unsupported type ${typeof value} at ${path}.`);
}

/**
 * Commitment hash. Canonicalizes its argument — pass the object, never a
 * pre-stringified JSON string, or you will hash the quoting rather than the
 * content.
 */
export function sha256(value: unknown): Sha256 {
  return `sha256:${createHash("sha256").update(encode(value, "$"), "utf8").digest("hex")}`;
}
