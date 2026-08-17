/**
 * secp256k1-keccak-v1 and the coordination-layer signing preimages (spec §4).
 *
 * Implemented from the spec and held to the published vectors
 * (`vectors/v1/signing`, `canonical`, `commands`, `receipts`) — never imported
 * from a Kite SDK, which is the point of the examples: an existing A2A stack
 * plus this bundle is sufficient to interoperate, down to the signatures.
 *
 * This file mirrors the Python examples' `signing.py` in TypeScript. The two
 * are deliberately independent implementations of the same frozen rules.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import canonicalize from "canonicalize";

/**
 * §4's domain tags. Each signed family gets its own tag so a signature over
 * one can never be replayed as another; the published cross-tag vectors are
 * what hold an implementation to that.
 */
export const DOMAIN_TAGS = {
  terms: "kite:a2a-agreement:terms:v1",
  command: "kite:a2a-agreement:command:v1",
  funding: "kite:a2a-agreement:funding:v1",
  receipt: "kite:a2a-agreement:receipt:v1",
} as const;

/** §6.3.1's transition-proof signature tag — a Runtime signature this example only verifies. */
export const PROOF_TAG = "kite:fulfill:transition-proof:v1";

export const SIGNATURE_PROFILE = "secp256k1-keccak-v1";

// ── bytes ────────────────────────────────────────────────────────────────────

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`not hex: ${s}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export const keccak256 = (b: Uint8Array): Uint8Array => keccak_256(b);

// ── canonical JSON (RFC 8785) ────────────────────────────────────────────────

/** RFC 8785 canonical bytes of a JSON value. */
export function jcs(value: unknown): Uint8Array {
  const s = canonicalize(value);
  if (s === undefined) throw new Error("value has no JCS form");
  return utf8(s);
}

/** `sha256:<hex>` content reference over raw bytes. */
export const sha256Ref = (bytes: Uint8Array): string => "sha256:" + toHex(sha256(bytes));

// ── keys ─────────────────────────────────────────────────────────────────────

/** keccak address of a secp256k1 private key (0x-prefixed, lowercase). */
export function addressOfPrivateKey(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false); // 0x04 ‖ X ‖ Y
  return "0x" + toHex(keccak_256(pub.slice(1)).slice(-20));
}

/**
 * §8 canonical key fragment — FROZEN, because it names signed receipts:
 * `jkt:` ‖ first 16 lowercase-hex chars of hex(sha256("secp256k1:" ‖ 33-byte
 * compressed pubkey)). The ASCII prefix concatenates with the RAW key bytes.
 */
export function thumbprintOfPrivateKey(privateKey: Uint8Array): string {
  const compressed = secp256k1.getPublicKey(privateKey, true);
  return "jkt:" + toHex(sha256(concatBytes(utf8("secp256k1:"), compressed))).slice(0, 16);
}

export const keyIdOf = (did: string, privateKey: Uint8Array): string =>
  `${did}#${thumbprintOfPrivateKey(privateKey)}`;

// ── secp256k1-keccak-v1 ──────────────────────────────────────────────────────

/**
 * Sign `preimage` under secp256k1-keccak-v1: recoverable ECDSA (low-S) over
 * keccak256(preimage), spelled `0x` ‖ r ‖ s ‖ v with v ∈ {27, 28}.
 */
export function sign(privateKey: Uint8Array, preimage: Uint8Array): string {
  const sig = secp256k1.sign(keccak_256(preimage), privateKey, { lowS: true });
  return "0x" + toHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16);
}

/**
 * Recover the signer address, or null for anything malformed: a missing `0x`,
 * a wrong length, a legacy recovery id outside {27, 28}, or a point that does
 * not recover. Malformed input is a verification failure, never an exception —
 * the reject-* signing vectors pin each of these cases.
 */
export function recover(signature: string, preimage: Uint8Array): string | null {
  if (!signature.startsWith("0x") || signature.length !== 132) return null;
  let raw: Uint8Array;
  try {
    raw = fromHex(signature);
  } catch {
    return null;
  }
  const v = raw[64]!;
  if (v !== 27 && v !== 28) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(v - 27);
    const pub = sig.recoverPublicKey(keccak_256(preimage)).toRawBytes(false);
    return "0x" + toHex(keccak_256(pub.slice(1)).slice(-20));
  } catch {
    return null;
  }
}

/** True exactly when `signature` over `preimage` recovers to `address`. */
export function verify(signature: string, preimage: Uint8Array, address: string): boolean {
  const recovered = recover(signature, preimage);
  return recovered !== null && recovered === address.toLowerCase();
}

// ── the signed preimages (spec §4) ───────────────────────────────────────────

/**
 * termsHash: sha256 over the JCS form of the contract without `signatures` —
 * and without any declared `termsHash`, which is derived and never trusted
 * from the wire.
 */
export function termsHashOf(contract: Record<string, unknown>): string {
  const { signatures: _sigs, termsHash: _th, ...rest } = contract;
  return sha256Ref(jcs(rest));
}

/** The bytes a formation signature (§4.1) covers: terms tag ‖ termsHash string. */
export const termsSigningBytes = (termsHash: string): Uint8Array =>
  concatBytes(utf8(DOMAIN_TAGS.terms), utf8(termsHash));

/** The bytes an AgreementCommand signature (§4.2) covers: command tag ‖ JCS(command without `signature`). */
export function commandSigningBytes(command: Record<string, unknown>): Uint8Array {
  const { signature: _sig, ...rest } = command;
  return concatBytes(utf8(DOMAIN_TAGS.command), jcs(rest));
}

/** §4.2's payloadHash: sha256 over the JCS form of the payload alone. */
export const payloadHashOf = (payload: unknown): string => sha256Ref(jcs(payload));

/** The bytes a §6.2.1 party envelope signature covers: funding tag ‖ JCS(envelope without `signature`). */
export function envelopeSigningBytes(envelope: Record<string, unknown>): Uint8Array {
  const { signature: _sig, ...rest } = envelope;
  return concatBytes(utf8(DOMAIN_TAGS.funding), jcs(rest));
}

/**
 * §4.3: ONLY these nine members are signed. The Audit-owned `auditStatus` /
 * `auditReceiptRef` are excluded so re-stamping a receipt as durably appended
 * does not invalidate a signature already handed out. Absent `commandId` /
 * `commandHash` are OMITTED from the preimage, never serialized as null.
 */
export const RECEIPT_SIGNED_FIELDS = [
  "schema",
  "receiptId",
  "dealId",
  "commandId",
  "commandHash",
  "fromState",
  "toState",
  "revision",
  "recordedAt",
] as const;

/** The JCS bytes of a receipt's nine signed members (§4.3). */
export function receiptSignedPreimage(receipt: Record<string, unknown>): Uint8Array {
  const signed: Record<string, unknown> = {};
  for (const k of RECEIPT_SIGNED_FIELDS) {
    if (receipt[k] !== undefined) signed[k] = receipt[k];
  }
  return jcs(signed);
}

/** The bytes a receipt's `runtimeSignature.sig` covers. */
export const receiptSigningBytes = (receipt: Record<string, unknown>): Uint8Array =>
  concatBytes(utf8(DOMAIN_TAGS.receipt), receiptSignedPreimage(receipt));

/** The bytes a §6.3.1 transition-proof signature covers: proof tag ‖ proofHash string. */
export const proofSigningBytes = (proofHash: string): Uint8Array =>
  concatBytes(utf8(PROOF_TAG), utf8(proofHash));
