/**
 * Extension participation: this seller's side of the agreement workflow.
 *
 * Built directly from the bundle's schemas (schemas/v1) and spec — no Kite
 * SDK. Each function cites the spec section it implements. This is the
 * TypeScript sibling of `seller-agent/`'s `extension.py`, with one
 * substantive upgrade: `validateTerms` recomputes a QUERY-DERIVED price and
 * the terms-document commitment instead of comparing against a fixed quote —
 * the seller countersigns a variable amount only when its own arithmetic
 * reproduces it (DESIGN §4).
 */
import { randomBytes } from "node:crypto";
import {
  DOMAIN_TAGS,
  concatBytes,
  jcs,
  payloadHashOf,
  recover,
  sha256Ref,
  sign,
  termsHashOf,
  termsSigningBytes,
  utf8,
  verify,
} from "./signing.js";
import {
  TYPE_STRINGS,
  digest as eip712Digest,
  signStruct,
  recoverStruct,
  type Eip712Domain,
} from "./settlement.js";
import { parseAcceptanceCriteria, termsDocumentHashOf, type TermsDocument } from "./terms.js";

export const EXTENSION_URI = "https://a2a.gokite.ai/extensions/coordination-workflow/v1";
export const COMMAND_SCHEMA = "https://a2a.gokite.ai/schemas/agreement-command/v1";

/**
 * The Extension's own media type (§6.1). It belongs on Parts carrying the
 * interactions §6.2 defines, addressed to a Coordination Runtime. It is
 * DECLARED on the Agent Card as the §2.1 commandMediaType param; standalone
 * mode never stamps it on a Part this agent sends.
 */
export const COMMAND_MEDIA_TYPE = "application/vnd.gokite.agreement-command+json;version=1";

/**
 * DEMO-PRIVATE, and not part of the Extension contract — the same split, for
 * the same reasons, as `seller-agent/`'s `example-negotiation` type (see
 * `examples/README.md`). This seller's negotiation is query-shaped, so it
 * gets its own carrier: buyer-scoped `query`/`quote`, `submit-proposal`,
 * `acceptance-request`, `request-delivery`. The quote returns a
 * `negotiationId` that the proposal path must carry until a deal exists.
 * These messages and this agent's replies are not interactions §6.2
 * defines, and an implementer should expect to replace them wholesale.
 */
export const NEGOTIATION_MEDIA_TYPE =
  "application/vnd.gokite.example-data-negotiation+json;version=1";

/** §6.5: Runtime → party notifications ride their own media type. */
export const CONTRACT_MESSAGE_MEDIA_TYPE = "application/vnd.gokite.contract-message+json;version=1";

/**
 * The Runtime's published A2A endpoint, pinned inside the signed terms
 * (§4.1). Read at call time so a test can point a booted seller at a fake
 * Runtime; a deployment sets it once at startup.
 */
export const coordinationEndpoint = (): string =>
  process.env["KITE_COORDINATION_ENDPOINT"] ?? "https://passport.dev.gokite.ai/a2a/v1";

export const SELLER_AGENT_ID = process.env["SELLER_AGENT_ID"] ?? "did:kite:corp-kite:example-data-seller-agent";

/** Where settlement lands. Inside the SIGNED terms (escrow.payoutAddress), agreed up front. */
export const SELLER_PAYOUT_ADDRESS = process.env["SELLER_PAYOUT_ADDRESS"] ?? "0x" + "33".repeat(20);

/** Demo expiry for embedded settlement signatures (§4.2 bounds the signature). */
export const DEMO_EXPIRY = 1_800_000_000;

/** Standalone-mode §4.4 domain placeholders — documented stand-ins, nothing submittable. */
export const DEMO_CHAIN_ID = 2368;
export const DEMO_VAULT_ADDRESS = "0x" + "ec".repeat(20);
export const ZERO_ANCHOR = "0x" + "00".repeat(32);

export const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

type Json = Record<string, unknown>;

// ── commands (§4.2) ─────────────────────────────────────────────────────────

/** Assemble an unsigned AgreementCommand per schemas/v1 (§4.2). */
export function buildCommand(input: {
  commandType: string;
  dealId: string;
  expectedRevision: number;
  termsHash: string;
  payload: Json;
}): Json {
  return {
    schema: COMMAND_SCHEMA,
    commandId: "cmd_" + randomBytes(13).toString("hex"),
    commandType: input.commandType,
    dealId: input.dealId,
    expectedRevision: input.expectedRevision,
    actorAgentId: SELLER_AGENT_ID,
    termsHash: input.termsHash,
    payload: input.payload,
    payloadHash: payloadHashOf(input.payload),
    occurredAt: nowIso(),
  };
}

/** Sign a command with the runtime key: command tag ‖ JCS(command minus signature). */
export function signCommand(command: Json, privateKey: Uint8Array, keyId: string): Json {
  const { signature: _s, ...rest } = command;
  const sig = sign(privateKey, concatBytes(utf8(DOMAIN_TAGS.command), jcs(rest)));
  return { ...command, signature: { profile: "secp256k1-keccak-v1", keyId, sig } };
}

/** Sign a §6.2.1 party envelope: funding tag ‖ JCS(envelope minus signature). */
export function signPartyEnvelope(envelope: Json, privateKey: Uint8Array, keyId: string): Json {
  const { signature: _s, ...rest } = envelope;
  const sig = sign(privateKey, concatBytes(utf8(DOMAIN_TAGS.funding), jcs(rest)));
  return { ...envelope, signature: { profile: "secp256k1-keccak-v1", keyId, sig } };
}

// ── terms validation (the seller's OWN check) ───────────────────────────────

/**
 * What the countersigning check needs beyond the contract: the terms document
 * the contract's acceptanceCriteria pins (the seller looks it up by hash —
 * it minted it at quote time), and the seller's own recomputation of the
 * quote it describes.
 */
export interface TermsValidationContext {
  /** The terms document this seller issued, found by the pinned hash. */
  termsDocument: TermsDocument;
  /** The seller's own fresh recomputation over the stored query. */
  recomputed: {
    priceAmount: string;
    criteriaHash: string;
    statsHash: string;
  };
}

/**
 * The seller's own check of the terms it is about to be bound by (§4.1 +
 * DESIGN §4). The Runtime validates protocol shape and signatures; it cannot
 * know what this seller quoted. Every member checked here is inside the
 * termsHash preimage — and the terms document is inside it transitively,
 * through the acceptanceCriteria commitment — so passing once means passing
 * for the life of the deal.
 */
export function validateTerms(contract: Json, ctx: TermsValidationContext): void {
  const escrow = (contract["escrow"] ?? {}) as Json;
  if (String(escrow["payoutAddress"] ?? "").toLowerCase() !== SELLER_PAYOUT_ADDRESS.toLowerCase()) {
    throw new Error("contract does not pay our payout address — refusing to countersign");
  }
  if (contract["sellerAgentId"] !== SELLER_AGENT_ID) {
    throw new Error(`contract names seller ${String(contract["sellerAgentId"])}, not ${SELLER_AGENT_ID}`);
  }

  // The inner commitment (DESIGN §4): the acceptanceCriteria must pin a terms
  // document, the pinned hash must be the document we hold, and the document
  // must be internally consistent with our own arithmetic. An unpinned or
  // foreign document is outside every signature and is refused, not repaired.
  const commitment = parseAcceptanceCriteria(String(contract["acceptanceCriteria"] ?? ""));
  if (commitment === null) {
    throw new Error("acceptanceCriteria pins no terms document — an unpinned document is outside every signature");
  }
  const docHash = termsDocumentHashOf(ctx.termsDocument);
  if (commitment.termsDocumentHash !== docHash) {
    throw new Error(
      `acceptanceCriteria pins terms document ${commitment.termsDocumentHash}; the document supplied hashes to ${docHash}`,
    );
  }

  // THE QUERY-DERIVED COUNTERSIGN CHECK: the price is not compared against a
  // configured constant but against this seller's own recomputation from its
  // rate card over the pinned query. Terms that price differently are a
  // renegotiation, not an acceptance.
  const price = (contract["price"] ?? {}) as Json;
  if (price["asset"] !== "USDC" || price["amount"] !== ctx.recomputed.priceAmount) {
    throw new Error(
      `contract prices ${String(price["amount"])} ${String(price["asset"])}; this seller's own ` +
        `arithmetic reproduces ${ctx.recomputed.priceAmount} USDC — refusing to countersign a price ` +
        `the rate card does not produce`,
    );
  }
  if (ctx.termsDocument.priceAmount !== ctx.recomputed.priceAmount) {
    throw new Error("terms document names a price the rate card does not produce");
  }
  if (ctx.termsDocument.criteriaHash !== ctx.recomputed.criteriaHash) {
    throw new Error("terms document pins a criteriaHash that does not match the stored query");
  }
  if (ctx.termsDocument.statsHash !== ctx.recomputed.statsHash) {
    throw new Error(
      "terms document pins a statsHash the current corpus does not reproduce — the slice changed " +
        "between quote and proposal, and a silently different slice is the substitution the " +
        "commitment exists to catch",
    );
  }

  if (!String(contract["deliverable"] ?? "").trim()) throw new Error("contract carries no deliverable");

  const binding = (contract["runtimeBinding"] ?? {}) as Json;
  if (binding["extensionUri"] !== EXTENSION_URI) {
    throw new Error(`runtimeBinding pins extension ${String(binding["extensionUri"])}, not this one`);
  }
  if (binding["endpoint"] !== coordinationEndpoint()) {
    throw new Error(
      `runtimeBinding pins Runtime ${String(binding["endpoint"])}; this seller executes against ` +
        `${coordinationEndpoint()} — a deal pinned elsewhere could never be funded here`,
    );
  }
  const arbiter = ((contract["disputePolicy"] ?? {}) as Json)["arbiterAgentId"];
  if (!arbiter || arbiter === contract["buyerAgentId"] || arbiter === SELLER_AGENT_ID) {
    throw new Error("disputePolicy.arbiterAgentId must name a third party (§4.1)");
  }
}

// ── runtime card verification (§2.1/§4.1) ───────────────────────────────────

/**
 * Prove the served Runtime card IS the one the terms pin, then take the chain
 * context from it. Returns { chainId, escrowVault } — the §4.4 domain
 * parameters, which are never taken from local configuration.
 */
export function validateRuntimeCard(card: Json, binding: Json): { chainId: number; escrowVault: string } {
  const computed = sha256Ref(jcs(card));
  if (computed !== binding["agentCardHash"]) {
    throw new Error(
      `runtime card hash ${computed} is not the one the terms pin (${String(binding["agentCardHash"])}) — ` +
        "the card changed after signing, or the proposal pinned a placeholder",
    );
  }
  const registry = ((card["x-kite-registry"] ?? {}) as Json)["agentId"];
  if (registry !== binding["runtimeAgentId"]) {
    throw new Error(`runtime card belongs to ${String(registry)}, not the pinned ${String(binding["runtimeAgentId"])}`);
  }
  const declared = (((card["capabilities"] ?? {}) as Json)["extensions"] as Json[] | undefined)?.find(
    (e) => e["uri"] === EXTENSION_URI,
  );
  if (declared === undefined) throw new Error("runtime card does not declare this extension (§2.1)");
  const params = (declared["params"] ?? {}) as Json;
  if (params["chainId"] === undefined || params["escrowVault"] === undefined) {
    throw new Error("runtime card omits chainId/escrowVault (§2.1) — nothing safe to sign under");
  }
  return { chainId: Number(params["chainId"]), escrowVault: String(params["escrowVault"]) };
}

// ── acceptance (§4.1) ───────────────────────────────────────────────────────

/** The §4.4 Agreement domain (accept gate) — KiteFulfill, no verifyingContract. */
const agreementDomain = (chainId: number): Eip712Domain => ({
  name: "KiteFulfill",
  version: "1",
  chainId,
});

/** The §4.4 Agreement struct for one accepted deal. */
function agreementStruct(dealId: string, termsHash: string, amount: string, buyer: string, seller: string) {
  return {
    agreementId: dealId,
    termsHash,
    amount,
    buyerAgent: buyer,
    sellerAgent: seller,
  };
}

/**
 * Countersign a proposed DealContract (§4.1).
 *
 * Acceptance is the second signature over EXACTLY the proposal's termsHash,
 * recomputed locally — never trusted from the wire. `validateTerms` (with its
 * query-derived recomputation) runs first; then the buyer's formation
 * signature and §4.4 agreementSig are verified; then, and only then, the
 * seller binds itself next to them.
 */
export function acceptTerms(input: {
  contract: Json;
  buyerAddress: string;
  dealId: string;
  buyerAgreementSig: string;
  privateKey: Uint8Array;
  keyId: string;
  sellerAddress: string;
  chainId?: number;
  validation: TermsValidationContext;
}): Json {
  const signatures = (input.contract["signatures"] ?? []) as Json[];
  if (signatures.length !== 1) throw new Error("a proposal carries exactly one signature");
  validateTerms(input.contract, input.validation);

  const computed = termsHashOf(input.contract);
  const proposalSig = signatures[0]!;
  if (proposalSig["signerAgentId"] !== input.contract["buyerAgentId"]) {
    throw new Error("proposal signature must be the buyer's");
  }
  if (!verify(String(proposalSig["sig"]), termsSigningBytes(computed), input.buyerAddress)) {
    throw new Error("buyer terms signature does not verify against the recomputed termsHash");
  }

  // §4.1 two-phase rule: agreementSig exists only now, because its digest
  // commits to the deal id assigned at proposal. `chainId` defaults to the
  // standalone placeholder; live callers pass the VERIFIED Runtime card's.
  const chainId = input.chainId ?? DEMO_CHAIN_ID;
  const struct = agreementStruct(
    input.dealId,
    computed,
    String((input.contract["price"] as Json)["amount"]),
    input.buyerAddress,
    input.sellerAddress,
  );
  const recovered = recoverStruct(
    input.buyerAgreementSig,
    agreementDomain(chainId),
    TYPE_STRINGS.Agreement,
    struct,
  );
  if (recovered !== input.buyerAddress.toLowerCase()) {
    throw new Error("buyer agreementSig does not verify over the §4.4 Agreement digest");
  }
  const sellerAgreementSig = signStruct(
    input.privateKey,
    agreementDomain(chainId),
    TYPE_STRINGS.Agreement,
    struct,
  );
  const acceptance: Json = {
    signerAgentId: SELLER_AGENT_ID,
    profile: "secp256k1-keccak-v1",
    keyId: input.keyId,
    sig: sign(input.privateKey, termsSigningBytes(computed)),
    agreementSig: sellerAgreementSig,
  };
  return {
    ...input.contract,
    signatures: [{ ...proposalSig, agreementSig: input.buyerAgreementSig }, acceptance],
  };
}

// ── evidence and delivery ───────────────────────────────────────────────────

/**
 * A §6.2.1 party envelope registering delivery evidence — SELLER ONLY, and
 * registered BEFORE the delivered command: the Runtime refuses a `delivered`
 * whose evidenceId it never issued. For this seller the artifact is the
 * DELIVERY MANIFEST's canonical bytes (DESIGN §5): `hash` is §4.2's
 * deliveryHash, and `url` is where those exact bytes are served, capability
 * token included.
 */
export function evidenceEnvelope(input: {
  dealId: string;
  termsHash: string;
  manifestHash: string;
  manifestUrl: string;
  manifestBytes: number;
  privateKey: Uint8Array;
  keyId: string;
}): Json {
  return signPartyEnvelope(
    {
      // `kind` is part of the SIGNED object (§6.2.1): the Runtime
      // canonicalizes the whole wire payload minus "signature".
      kind: "evidence",
      dealId: input.dealId,
      actorAgentId: SELLER_AGENT_ID,
      termsHash: input.termsHash,
      submission: {
        type: "delivery-manifest",
        hash: input.manifestHash,
        url: input.manifestUrl,
        format: "application/json",
        sizeBytes: input.manifestBytes,
      },
    },
    input.privateKey,
    input.keyId,
  );
}

/** The §4.4 signing anchors for one vault call. */
export interface SettlementAnchors {
  dealId32: string;
  receiptHash: string;
  nonce: number;
  expiry: number;
  chainId: number;
  vault: string;
}

/**
 * The standalone stand-ins for the §4.4 settlement anchors. With no Runtime
 * there is no funded vault deal, no proof chain, and no nonce, so the demo
 * signs over documented placeholders — the construction and every signature
 * are real, the values are not, and nothing produced with them can be
 * submitted to a Runtime. Live mode reads every one of these back fresh.
 */
export function demoAnchors(dealId: string): SettlementAnchors {
  // A demo bytes32 derivation for the vault deal id; a real one comes from the
  // vault via the funding read-back and is never derived locally to submit.
  const dealId32 = sha256Ref(utf8(`demo-vault-deal|${dealId}`)).replace("sha256:", "0x");
  return {
    dealId32,
    receiptHash: ZERO_ANCHOR,
    nonce: 0,
    expiry: DEMO_EXPIRY,
    chainId: DEMO_CHAIN_ID,
    vault: DEMO_VAULT_ADDRESS,
  };
}

/** The §4.4 vault domain for a given anchor set. */
export const vaultDomain = (anchors: SettlementAnchors): Eip712Domain => ({
  name: "KiteEscrowVault",
  version: "1",
  chainId: anchors.chainId,
  verifyingContract: anchors.vault,
});

/**
 * The signed `kite.contract.delivered` command (§4.2). The payload names two
 * different things: `evidenceId` — the id the Runtime returned at evidence
 * registration — and `deliveryHash`, the sha256 of the registered artifact
 * itself (here: the manifest bytes), whose 32 raw digest bytes become the
 * settlement layer's bytes32.
 */
export function deliveredCommand(input: {
  dealId: string;
  expectedRevision: number;
  termsHash: string;
  evidenceId: string;
  deliveryHash: string;
  anchors: SettlementAnchors;
  privateKey: Uint8Array;
  keyId: string;
}): Json {
  const sellerDeliverySig = signStruct(
    input.privateKey,
    vaultDomain(input.anchors),
    TYPE_STRINGS.Delivery,
    {
      dealId: input.anchors.dealId32,
      termsHash: input.termsHash,
      deliveryHash: input.deliveryHash,
      receiptHash: input.anchors.receiptHash,
      nonce: input.anchors.nonce,
      expiry: input.anchors.expiry,
    },
  );
  const command = buildCommand({
    commandType: "kite.contract.delivered",
    dealId: input.dealId,
    expectedRevision: input.expectedRevision,
    termsHash: input.termsHash,
    payload: {
      evidenceId: input.evidenceId,
      deliveryHash: input.deliveryHash,
      sellerDeliverySig,
      expiry: input.anchors.expiry,
    },
  });
  return signCommand(command, input.privateKey, input.keyId);
}

// ── delivery-request proof (demo-private) ──────────────────────────────────

/**
 * DEMO-PRIVATE, like the negotiation media type it rides on. `request-delivery`
 * hands out the capability URLs, so an unauthenticated A2A caller who merely
 * learned a deal id (they are visible on /admin) must not be able to trigger
 * it: the request carries the BUYER's signature over the deal id and a fresh
 * timestamp, verified against the address that signed the terms. A real
 * deployment replaces this with its own authentication; live mode does not
 * have the path at all — delivery is notification-driven (§6.5) and the buyer
 * receives the artifact location through the Runtime's evidence record.
 */
export const DELIVERY_REQUEST_TAG = "kite:example:delivery-request:v1";

/** Freshness window for a delivery-request proof, seconds. */
export const DELIVERY_REQUEST_MAX_AGE_SECONDS = 300;

export const deliveryRequestSigningBytes = (dealId: string, requestedAt: number): Uint8Array =>
  concatBytes(utf8(DELIVERY_REQUEST_TAG), jcs({ dealId, requestedAt }));

export function signDeliveryRequest(privateKey: Uint8Array, dealId: string, requestedAt: number): string {
  return sign(privateKey, deliveryRequestSigningBytes(dealId, requestedAt));
}

/** Throws unless the proof is fresh and recovers to the buyer who signed the terms. */
export function verifyDeliveryRequest(input: {
  dealId: string;
  requestedAt: number;
  buyerSig: string;
  buyerAddress: string;
  nowSeconds?: number;
}): void {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(input.requestedAt) || Math.abs(now - input.requestedAt) > DELIVERY_REQUEST_MAX_AGE_SECONDS) {
    throw new Error(
      `delivery request timestamp is outside the ${DELIVERY_REQUEST_MAX_AGE_SECONDS}s freshness window`,
    );
  }
  const recovered = recover(input.buyerSig, deliveryRequestSigningBytes(input.dealId, input.requestedAt));
  if (recovered === null || recovered !== input.buyerAddress.toLowerCase()) {
    throw new Error(
      "delivery request is not signed by the buyer who signed the terms — refusing to hand out the artifact capability",
    );
  }
}

/** Recover a formation-signature signer for diagnostics; null when malformed. */
export function recoverTermsSigner(termsHash: string, sig: string): string | null {
  return recover(sig, termsSigningBytes(termsHash));
}

export { eip712Digest };
