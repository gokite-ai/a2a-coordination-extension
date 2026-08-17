/**
 * §4.4 settlement profile (`fixed_outcome/v1`): the EIP-712 constructions the
 * Coordination Engine and the EscrowVault verify.
 *
 * All eight struct type strings are implemented and verified against the full
 * `vectors/v1/settlement` set — the seller *signs* only its own subset
 * (Agreement, Activation co-sign, Delivery, Appeal, RefundConsent), but an
 * implementation that cannot reproduce every digest has diverged from the
 * vault, whatever else it passes.
 *
 * Mirrors the Python examples' `settlement.py`. Implemented from the spec
 * alone; `@noble` supplies the primitives.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, fromHex, keccak256, recover, sign, utf8 } from "./signing.js";

/** The two §4.4 domains. `KiteFulfill` (accept gate) has NO verifyingContract. */
export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract?: string;
}

/** Struct type strings — verbatim, frozen (§4.4). */
export const TYPE_STRINGS = {
  Agreement:
    "Agreement(bytes32 agreementId,bytes32 termsHash,uint256 amount,address buyerAgent,address sellerAgent)",
  Activation:
    "Activation(bytes32 termsHash,address buyer,address buyerAgent,address sellerAgent,address sellerPayout,address arbiter,uint256 amount,uint64 fundingDeadline,uint64 deliveryWindow,uint64 deliveryConfirmationWindow,uint64 appealResponseWindow,uint64 arbitrationWindow)",
  Delivery:
    "Delivery(bytes32 dealId,bytes32 termsHash,bytes32 deliveryHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)",
  Acceptance: "Acceptance(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)",
  Rejection:
    "Rejection(bytes32 dealId,bytes32 termsHash,bytes32 reasonHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)",
  Appeal: "Appeal(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)",
  RefundConsent:
    "RefundConsent(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)",
  Resolution:
    "Resolution(bytes32 dealId,bytes32 termsHash,bytes32 decisionId,uint16 sellerBps,bytes32 receiptHash,uint64 nonce,uint64 expiry)",
} as const;

export type SettlementStructName = keyof typeof TYPE_STRINGS;

// ── ABI words ────────────────────────────────────────────────────────────────

function wordUint(value: number | bigint | string): Uint8Array {
  const n = BigInt(value);
  if (n < 0n) throw new Error(`negative uint: ${value}`);
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x > 0n) throw new Error(`uint overflows 32 bytes: ${value}`);
  return out;
}

/** A bytes32 from either spelling the wire uses: `sha256:<hex>` or `0x<hex>` — 32 raw digest bytes either way. */
function wordBytes32(value: string): Uint8Array {
  const h = value.startsWith("sha256:") ? value.slice(7) : value.startsWith("0x") ? value.slice(2) : value;
  const raw = fromHex(h);
  if (raw.length !== 32) throw new Error(`not 32 bytes: ${value}`);
  return raw;
}

function wordAddress(value: string): Uint8Array {
  const raw = fromHex(value);
  if (raw.length !== 20) throw new Error(`not an address: ${value}`);
  return concatBytes(new Uint8Array(12), raw);
}

// ── §4.4 field derivations — normative ───────────────────────────────────────

/** `agreementId` (bytes32) = keccak256 of the UTF-8 bytes of the Runtime-assigned agreement id string. */
export const agreementIdWord = (agreementId: string): Uint8Array => keccak_256(utf8(agreementId));

/** Vault `reasonHash` = keccak256 of the UTF-8 bytes of the wire's `reasonCode` (§4.2). */
export const reasonHashWord = (reasonCode: string): Uint8Array => keccak_256(utf8(reasonCode));

/** Vault `decisionId` (bytes32) = keccak256 of the UTF-8 bytes of the wire's `decisionId` string (§4.2). */
export const decisionIdWord = (decisionId: string): Uint8Array => keccak_256(utf8(decisionId));

/**
 * The contract's decimal `price.amount` in USDC base units (6 decimals):
 * `"25.00"` → `25000000n`. The conversion happens ONCE, by the party signing
 * the Agreement — the Activation read back through `funding` already carries
 * base units, and converting those again produces a digest 10^6 too large.
 */
export function usdcBaseUnits(decimalAmount: string): bigint {
  const m = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(decimalAmount);
  if (!m) throw new Error(`not a USDC decimal amount: ${decimalAmount}`);
  const whole = m[1]!;
  const frac = (m[2] ?? "").padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(frac);
}

// ── EIP-712 ──────────────────────────────────────────────────────────────────

export function domainSeparator(domain: Eip712Domain): Uint8Array {
  const withContract = domain.verifyingContract !== undefined;
  const typeString = withContract
    ? "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    : "EIP712Domain(string name,string version,uint256 chainId)";
  const words = [
    keccak_256(utf8(domain.name)),
    keccak_256(utf8(domain.version)),
    wordUint(domain.chainId),
  ];
  if (withContract) words.push(wordAddress(domain.verifyingContract!));
  return keccak_256(concatBytes(keccak_256(utf8(typeString)), ...words));
}

interface FieldSpec {
  type: string;
  name: string;
}

function parseTypeString(typeString: string): FieldSpec[] {
  const inner = typeString.slice(typeString.indexOf("(") + 1, typeString.lastIndexOf(")"));
  return inner.split(",").map((f) => {
    const [type, name] = f.trim().split(" ");
    if (!type || !name) throw new Error(`malformed field in type string: "${f}"`);
    return { type, name };
  });
}

/**
 * One ABI word per field, INCLUDING the normative §4.4 derivations. The
 * struct carries the wire's source strings — `agreementId` as the id string,
 * `amount` as either the contract decimal (Agreement, optionally pinned by
 * `amountBaseUnits`) or the read-back base-units integer (Activation),
 * Rejection's `reasonCode`, Resolution's `decisionId` — so a signer that
 * derives differently produces a different digest.
 */
function fieldWord(field: FieldSpec, struct: Record<string, unknown>, typeString: string): Uint8Array {
  if (field.name === "agreementId") return agreementIdWord(String(struct["agreementId"]));
  if (field.name === "reasonHash") return reasonHashWord(String(struct["reasonCode"]));
  if (field.name === "decisionId") return decisionIdWord(String(struct["decisionId"]));
  if (field.name === "amount") {
    // §4.4: where the base-unit conversion happens differs BY STRUCT, never
    // by spelling. The Activation's amount is ALREADY base units (the wire's
    // read-back integer, optionally pinned as `amountBaseUnits`); the
    // Agreement's is the contract's decimal `price.amount`, which the schema
    // also permits in integer form ("25" ≡ "25.00") — a dot-based branch
    // here encoded "25" as 25 base units instead of 25,000,000.
    if (typeString.startsWith("Activation(")) {
      return wordUint(String(struct["amountBaseUnits"] ?? struct["amount"]));
    }
    if (struct["amountBaseUnits"] !== undefined) return wordUint(String(struct["amountBaseUnits"]));
    return wordUint(usdcBaseUnits(String(struct["amount"])));
  }
  const value = struct[field.name];
  if (value === undefined) throw new Error(`struct is missing "${field.name}"`);
  if (field.type === "address") return wordAddress(String(value));
  if (field.type === "bytes32") return wordBytes32(String(value));
  if (field.type.startsWith("uint")) return wordUint(value as number | string);
  throw new Error(`unsupported field type: ${field.type}`);
}

/** keccak256( typeHash ‖ one word per field ). */
export function structHash(typeString: string, struct: Record<string, unknown>): Uint8Array {
  const words = parseTypeString(typeString).map((f) => fieldWord(f, struct, typeString));
  return keccak_256(concatBytes(keccak_256(utf8(typeString)), ...words));
}

/** The EIP-712 signing preimage: 0x1901 ‖ domainSeparator ‖ structHash. keccak256 of this is the digest. */
export function signingPreimage(
  domain: Eip712Domain,
  typeString: string,
  struct: Record<string, unknown>,
): Uint8Array {
  return concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator(domain), structHash(typeString, struct));
}

export function digest(
  domain: Eip712Domain,
  typeString: string,
  struct: Record<string, unknown>,
): Uint8Array {
  return keccak256(signingPreimage(domain, typeString, struct));
}

/** Sign a §4.4 struct with the one runtime key. Same 65-byte spelling as every other signature here. */
export function signStruct(
  privateKey: Uint8Array,
  domain: Eip712Domain,
  typeString: string,
  struct: Record<string, unknown>,
): string {
  return sign(privateKey, signingPreimage(domain, typeString, struct));
}

/**
 * Byte equality for 32-byte anchors: the system mints both spellings
 * (`sha256:<hex>` on the coordination layer, `0x<hex>` on chain-adjacent
 * views), and they name the same value. A literal string comparison here
 * refused every real deal — the Python seller learned this live.
 */
export function bytes32Equal(a: string, b: string): boolean {
  const strip = (s: string) => (s.startsWith("sha256:") ? s.slice(7) : s.startsWith("0x") ? s.slice(2) : s).toLowerCase();
  const ha = strip(a);
  const hb = strip(b);
  return ha.length === 64 && ha === hb;
}

/** Recover the signer of a §4.4 signature, or null if malformed. */
export function recoverStruct(
  signature: string,
  domain: Eip712Domain,
  typeString: string,
  struct: Record<string, unknown>,
): string | null {
  return recover(signature, signingPreimage(domain, typeString, struct));
}
