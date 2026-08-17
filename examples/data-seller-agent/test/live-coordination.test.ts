/**
 * PLAN phase 3 exit criterion: a fake Coordination Runtime, in the mold of
 * `seller-agent/`'s `test_live_coordination.py`, drives the live seller
 * through the loops the design claims — the accepted path AND the dispute
 * paths — while cryptographically verifying every artifact it accepts:
 * recomputed termsHash, recovered formation and Agreement signers, payload
 * hashes, evidenceId issuance, and §4.4 vault signatures over ITS OWN
 * anchors. (The EIP-712 building blocks it verifies with are the same
 * vector-pinned functions the seller uses; the verification FLOW — what is
 * recomputed, what is refused — is the fake Runtime's own.)
 *
 * Coverage:
 *  - countersign against a status read, chain context from the VERIFIED card;
 *  - funding co-sign over the read-back Activation;
 *  - §6.5 fulfill_started → one-shot ack → autonomous background delivery
 *    (evidence first, anchors fresh, seller-clock expiry);
 *  - an unverifiable notification answered with a JSON-RPC ERROR, not a
 *    polite message;
 *  - DELIVERED → ACCEPTED: capability survives;
 *  - REJECTED → refund_consented → CANCELLED: capability revoked;
 *  - REJECTED → appealed → DISPUTED → arbiter_decided, both splits:
 *    sellerBps=0 revokes, sellerBps=10000 keeps.
 */
import express from "express";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Role, type Message } from "@a2a-js/sdk";
import { Client, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from "@a2a-js/sdk/client";
import {
  COMMAND_MEDIA_TYPE,
  CONTRACT_MESSAGE_MEDIA_TYPE,
  EXTENSION_URI,
  NEGOTIATION_MEDIA_TYPE,
  SELLER_PAYOUT_ADDRESS,
} from "../src/extension.js";
import {
  addressOfPrivateKey,
  commandSigningBytes,
  envelopeSigningBytes,
  fromHex,
  jcs,
  keyIdOf,
  payloadHashOf,
  recover,
  sha256Ref,
  sign,
  termsHashOf,
  termsSigningBytes,
  utf8,
} from "../src/signing.js";
import { TYPE_STRINGS, bytes32Equal, recoverStruct, signStruct, usdcBaseUnits } from "../src/settlement.js";

type Json = Record<string, any>;

const BUYER_KEY = fromHex("0x1111111111111111111111111111111111111111111111111111111111111111");
const SELLER_KEY = fromHex("0x2222222222222222222222222222222222222222222222222222222222222222");
const BUYER_DID = "did:kite:acme:buyer-17";
const SELLER_DID = "did:kite:corp-kite:example-data-seller-agent";
const RUNTIME_DID = "did:kite:kite:coordination-engine";
const ARBITER_ADDRESS = "0x" + "55".repeat(20);
const BUYER_WALLET = "0x" + "19".repeat(20);
const CHAIN_ID = 31337;
const VAULT = "0x" + "ec".repeat(20);

const buyerAddress = addressOfPrivateKey(BUYER_KEY);
const sellerAddress = addressOfPrivateKey(SELLER_KEY);

// ── the fake Runtime ────────────────────────────────────────────────────────

interface FakeDeal {
  dealId: string;
  state: string;
  revision: number;
  termsHash: string;
  contract?: Json;
  vaultDealId: string;
  nonce: number;
  latestProofHash: string;
  activationComplete: boolean;
  sellerActivationSigned: boolean;
  /** Fault injection: substitute the Activation's buyerAgent (P1 regression). */
  activationBuyerAgent?: string;
  evidence: Map<string, { hash: string; url: string }>;
  resolution?: { sellerBps: number };
  refusals: string[];
}

class FakeRuntime {
  readonly deals = new Map<string, FakeDeal>();
  readonly card: Json;
  server!: Server;
  url!: string;
  private evidenceCounter = 0;
  /** Fault injection: COMMIT the next acceptance/delivered, then LOSE the response (once). */
  dropNextAcceptanceResponse = false;
  dropNextDeliveredResponse = false;

  constructor() {
    this.card = {
      name: "fake coordination runtime",
      description: "test double",
      version: "0",
      "x-kite-registry": { agentId: RUNTIME_DID },
      capabilities: {
        extensions: [
          {
            uri: EXTENSION_URI,
            required: true,
            params: {
              commandMediaType: COMMAND_MEDIA_TYPE,
              templates: ["fixed_outcome/v1"],
              signatureProfiles: ["secp256k1-keccak-v1"],
              chainId: CHAIN_ID,
              escrowVault: VAULT,
            },
          },
        ],
      },
    };
  }

  cardHash(): string {
    return sha256Ref(jcs(this.card));
  }

  /** The buyer submitted the proposal directly (out of the seller's sight). */
  createProposal(contract: Json): string {
    const termsHash = termsHashOf(contract);
    const signatures = (contract["signatures"] ?? []) as Json[];
    if (signatures.length !== 1) throw new Error("fake runtime: proposal carries one signature");
    const signer = recover(String(signatures[0]!["sig"]), termsSigningBytes(termsHash));
    if (signer !== buyerAddress) throw new Error("fake runtime: proposal signature is not the buyer's");
    const dealId = "deal_" + randomBytes(6).toString("hex");
    this.deals.set(dealId, {
      dealId,
      state: "PROPOSED",
      revision: 1,
      termsHash,
      contract,
      vaultDealId: "0x" + randomBytes(32).toString("hex"),
      nonce: 0,
      latestProofHash: "sha256:" + randomBytes(32).toString("hex"),
      activationComplete: false,
      sellerActivationSigned: false,
      evidence: new Map(),
      refusals: [],
    });
    return dealId;
  }

  /** The chain observation nobody can command (§3): FUND_CONFIRMED → FULFILLING. */
  confirmFund(dealId: string): void {
    const deal = this.deals.get(dealId)!;
    if (deal.state !== "COMMITTED") throw new Error(`cannot fund from ${deal.state}`);
    this.transition(deal, "FULFILLING");
  }

  /** The buyer's commands, driven by the test (the buyer is not under test here). */
  buyerAccept(dealId: string): void {
    const deal = this.deals.get(dealId)!;
    if (deal.state !== "DELIVERED") throw new Error(`cannot accept from ${deal.state}`);
    this.transition(deal, "ACCEPTED");
  }

  buyerReject(dealId: string): void {
    const deal = this.deals.get(dealId)!;
    if (deal.state !== "DELIVERED") throw new Error(`cannot reject from ${deal.state}`);
    this.transition(deal, "REJECTED");
  }

  arbiterDecide(dealId: string, sellerBps: number): void {
    const deal = this.deals.get(dealId)!;
    if (deal.state !== "DISPUTED") throw new Error(`cannot resolve from ${deal.state}`);
    deal.resolution = { sellerBps };
    this.transition(deal, "RESOLVED");
  }

  private transition(deal: FakeDeal, to: string): void {
    deal.state = to;
    deal.revision += 1;
    deal.latestProofHash = "sha256:" + randomBytes(32).toString("hex");
  }

  private activation(deal: FakeDeal): Json {
    const amount = usdcBaseUnits(String((deal.contract!["price"] as Json)["amount"])).toString();
    return {
      termsHash: deal.termsHash,
      ...(deal.activationComplete ? { buyer: BUYER_WALLET } : {}),
      buyerAgent: deal.activationBuyerAgent ?? buyerAddress,
      sellerAgent: sellerAddress,
      sellerPayout: String((deal.contract!["escrow"] as Json)["payoutAddress"]),
      arbiter: ARBITER_ADDRESS,
      amount,
      fundingDeadline: 1_900_000_000,
      deliveryWindow: 3600,
      deliveryConfirmationWindow: 3600,
      appealResponseWindow: 3600,
      arbitrationWindow: 3600,
    };
  }

  async start(): Promise<void> {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.get("/.well-known/agent-card.json", (_req, res) => {
      // The exact bytes the card hash covers: canonical form, like the pin.
      res.type("application/json").send(Buffer.from(jcs(this.card)));
    });
    app.post("/a2a/v1", (req, res) => {
      const body = req.body as Json;
      const reply = (payload: Json) =>
        res.json({
          jsonrpc: "2.0",
          id: body["id"],
          result: {
            message: {
              messageId: randomBytes(8).toString("hex"),
              role: "ROLE_AGENT",
              parts: [
                { raw: Buffer.from(JSON.stringify(payload)).toString("base64"), mediaType: COMMAND_MEDIA_TYPE },
              ],
              extensions: [EXTENSION_URI],
            },
          },
        });
      const domainError = (code: string, message: string, retriable = false) =>
        res.json({
          jsonrpc: "2.0",
          id: body["id"],
          error: { code: -32010, message, data: { code, retriable } },
        });
      try {
        const parts: Json[] = body["params"]?.["message"]?.["parts"] ?? [];
        const part = parts.find((p) => p["mediaType"] === COMMAND_MEDIA_TYPE && p["raw"]);
        if (part === undefined) throw new Error("no extension part");
        const payload = JSON.parse(Buffer.from(String(part["raw"]), "base64").toString("utf8")) as Json;
        const outcome = this.handle(payload);
        if ("errorCode" in outcome) {
          domainError(String(outcome["errorCode"]), String(outcome["message"]), Boolean(outcome["retriable"]));
          return;
        }
        reply(outcome);
      } catch (error) {
        res.json({
          jsonrpc: "2.0",
          id: body["id"],
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      }
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}/a2a/v1`;
  }

  private statusOf(deal: FakeDeal): Json {
    return {
      dealId: deal.dealId,
      state: deal.state,
      revision: deal.revision,
      termsHash: deal.termsHash,
      latestProofHash: deal.latestProofHash,
      ...(deal.resolution !== undefined ? { resolution: deal.resolution } : {}),
      vault: {
        dealId: deal.vaultDealId,
        nonce: deal.nonce,
        chainId: CHAIN_ID,
        vaultAddress: VAULT,
      },
    };
  }

  private vaultDomain() {
    return { name: "KiteEscrowVault", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT };
  }

  /** One §6.2 interaction. Every acceptance path verifies before it trusts. */
  private handle(payload: Json): Json {
    const kind = String(payload["kind"] ?? "");
    if (kind === "status") {
      const deal = this.deals.get(String(payload["dealId"]));
      if (deal === undefined) return { errorCode: "unknown_deal", message: "no such deal" };
      return { kind: "agreement-status", status: this.statusOf(deal) };
    }

    if (kind === "funding" || kind === "funding-signatures" || kind === "evidence") {
      // Party envelopes: the signature covers the whole payload minus itself.
      const signer = recover(String((payload["signature"] as Json)?.["sig"] ?? ""), envelopeSigningBytes(payload));
      if (signer !== sellerAddress && signer !== buyerAddress) {
        return { errorCode: "invalid_signature", message: "envelope signer is not a party" };
      }
      const deal = this.deals.get(String(payload["dealId"]));
      if (deal === undefined) return { errorCode: "unknown_deal", message: "no such deal" };
      if (!bytes32Equal(String(payload["termsHash"]), deal.termsHash)) {
        return { errorCode: "terms_hash_mismatch", message: "envelope names other terms" };
      }

      if (kind === "funding") {
        return {
          kind: "agreement-funding",
          funding: {
            phase: "FUNDING",
            activation: this.activation(deal),
            chainId: CHAIN_ID,
            vaultAddress: VAULT,
          },
        };
      }
      if (kind === "funding-signatures") {
        const submission = (payload["submission"] ?? {}) as Json;
        const sig = String(submission["sellerActivationSig"] ?? "");
        if (signer !== sellerAddress) return { errorCode: "unauthorized_actor", message: "seller-only here" };
        // Independently derive the Activation digest and recover — a co-sign
        // that does not verify never reaches the vault.
        const recovered = recoverStruct(sig, this.vaultDomain(), TYPE_STRINGS.Activation, {
          ...this.activation(deal),
          amountBaseUnits: String(this.activation(deal)["amount"]),
        });
        if (recovered !== sellerAddress) {
          return { errorCode: "invalid_signature", message: "sellerActivationSig does not verify" };
        }
        deal.sellerActivationSigned = true;
        return { kind: "agreement-funding-accepted", status: this.statusOf(deal) };
      }
      // evidence
      const submission = (payload["submission"] ?? {}) as Json;
      if (signer !== sellerAddress) return { errorCode: "unauthorized_actor", message: "evidence is seller-only" };
      const evidenceId = `ev_${++this.evidenceCounter}_${deal.dealId}`;
      deal.evidence.set(evidenceId, { hash: String(submission["hash"]), url: String(submission["url"]) });
      return { kind: "agreement-evidence-recorded", evidenceId };
    }

    if (kind === "acceptance") {
      const deal = this.deals.get(String(payload["dealId"]));
      if (deal === undefined) return { errorCode: "unknown_deal", message: "no such deal" };
      const contract = payload["contract"] as Json;
      const termsHash = termsHashOf(contract);
      if (!bytes32Equal(termsHash, deal.termsHash)) {
        return { errorCode: "terms_hash_mismatch", message: "acceptance names other terms" };
      }
      const signatures = (contract["signatures"] ?? []) as Json[];
      if (signatures.length !== 2) return { errorCode: "invalid_command_schema", message: "need two signatures" };
      const [buyerEntry, sellerEntry] = signatures as [Json, Json];
      const agreementStruct = {
        agreementId: deal.dealId,
        termsHash,
        amount: String((contract["price"] as Json)["amount"]),
        buyerAgent: buyerAddress,
        sellerAgent: sellerAddress,
      };
      const agreementDomain = { name: "KiteFulfill", version: "1", chainId: CHAIN_ID };
      for (const [entry, expected] of [
        [buyerEntry, buyerAddress],
        [sellerEntry, sellerAddress],
      ] as const) {
        if (recover(String(entry["sig"]), termsSigningBytes(termsHash)) !== expected) {
          return { errorCode: "invalid_signature", message: "formation signature does not verify" };
        }
        if (
          recoverStruct(String(entry["agreementSig"]), agreementDomain, TYPE_STRINGS.Agreement, agreementStruct) !==
          expected
        ) {
          return { errorCode: "runtime_signature_mismatch", message: "agreementSig does not verify" };
        }
      }
      deal.contract = contract;
      this.transition(deal, "COMMITTED");
      if (this.dropNextAcceptanceResponse) {
        // The commit happened; the answer never arrives (relay loss).
        this.dropNextAcceptanceResponse = false;
        return { errorCode: "internal_error", message: "response lost after commit", retriable: true };
      }
      return { kind: "agreement-result", status: this.statusOf(deal), receipt: null };
    }

    if (kind === "command") {
      const command = payload["command"] as Json;
      const deal = this.deals.get(String(command["dealId"]));
      if (deal === undefined) return { errorCode: "unknown_deal", message: "no such deal" };
      if (payloadHashOf(command["payload"]) !== command["payloadHash"]) {
        return { errorCode: "payload_hash_mismatch", message: "recomputed payload hash differs" };
      }
      if (recover(String((command["signature"] as Json)["sig"]), commandSigningBytes(command)) !== sellerAddress) {
        return { errorCode: "invalid_signature", message: "command signer is not the seller" };
      }
      if (!bytes32Equal(String(command["termsHash"]), deal.termsHash)) {
        return { errorCode: "terms_hash_mismatch", message: "command names other terms" };
      }
      if (Number(command["expectedRevision"]) !== deal.revision) {
        return { errorCode: "revision_conflict", message: "stale revision", retriable: true };
      }
      const cmdPayload = command["payload"] as Json;
      const type = String(command["commandType"]);

      if (type === "kite.contract.delivered") {
        if (deal.state !== "FULFILLING") return { errorCode: "illegal_transition", message: `from ${deal.state}` };
        const evidence = deal.evidence.get(String(cmdPayload["evidenceId"]));
        if (evidence === undefined) {
          return { errorCode: "evidence_not_validated", message: "evidenceId was never issued for this agreement" };
        }
        if (!bytes32Equal(evidence.hash, String(cmdPayload["deliveryHash"]))) {
          return { errorCode: "evidence_not_validated", message: "deliveryHash is not the registered content hash" };
        }
        const recovered = recoverStruct(
          String(cmdPayload["sellerDeliverySig"]),
          this.vaultDomain(),
          TYPE_STRINGS.Delivery,
          {
            dealId: deal.vaultDealId,
            termsHash: deal.termsHash,
            deliveryHash: String(cmdPayload["deliveryHash"]),
            receiptHash: deal.latestProofHash,
            nonce: deal.nonce,
            expiry: Number(cmdPayload["expiry"]),
          },
        );
        if (recovered !== sellerAddress) {
          return { errorCode: "invalid_signature", message: "sellerDeliverySig does not verify over OUR anchors" };
        }
        deal.nonce += 1;
        this.transition(deal, "DELIVERED");
        if (this.dropNextDeliveredResponse) {
          this.dropNextDeliveredResponse = false;
          return { errorCode: "internal_error", message: "response lost after commit", retriable: true };
        }
        return { kind: "agreement-result", status: this.statusOf(deal), receipt: null };
      }

      const structOf: Record<string, { struct: "Appeal" | "RefundConsent"; member: string; from: string; to: string }> = {
        "kite.contract.appealed": { struct: "Appeal", member: "sellerAppealSig", from: "REJECTED", to: "DISPUTED" },
        "kite.contract.refund_consented": {
          struct: "RefundConsent",
          member: "sellerConsentSig",
          from: "REJECTED",
          to: "CANCELLED",
        },
      };
      const move = structOf[type];
      if (move === undefined) return { errorCode: "invalid_command_schema", message: `unknown type ${type}` };
      if (deal.state !== move.from) return { errorCode: "illegal_transition", message: `from ${deal.state}` };
      const recovered = recoverStruct(String(cmdPayload[move.member]), this.vaultDomain(), TYPE_STRINGS[move.struct], {
        dealId: deal.vaultDealId,
        termsHash: deal.termsHash,
        receiptHash: deal.latestProofHash,
        nonce: deal.nonce,
        expiry: Number(cmdPayload["expiry"]),
      });
      if (recovered !== sellerAddress) {
        return { errorCode: "invalid_signature", message: `${move.member} does not verify over OUR anchors` };
      }
      deal.nonce += 1;
      this.transition(deal, move.to);
      return { kind: "agreement-result", status: this.statusOf(deal), receipt: null };
    }

    return { errorCode: "invalid_command_schema", message: `unknown kind ${kind}` };
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

const QUERY = { columns: ["DIABETES", "BPHIGH"], states: ["CA"], counties: ["Alameda"] };

describe("live coordination against a fake Runtime", () => {
  const fake = new FakeRuntime();
  let sellerServer: Server;
  let sellerBase: string;
  let client: Client;
  let boot: Awaited<ReturnType<typeof import("../src/server.js").buildApp>>;

  const optIn = { serviceParameters: ServiceParameters.create(withA2AExtensions(EXTENSION_URI)) };

  const negotiate = async (payload: Json): Promise<Json> => {
    const result = await client.sendMessage(
      {
        tenant: "",
        message: {
          messageId: "m_" + randomBytes(6).toString("hex"),
          contextId: "",
          taskId: "",
          role: Role.ROLE_USER,
          parts: [
            {
              content: { $case: "raw", value: Buffer.from(JSON.stringify(payload)) },
              metadata: undefined,
              filename: "",
              mediaType: NEGOTIATION_MEDIA_TYPE,
            },
          ],
          metadata: undefined,
          extensions: [EXTENSION_URI],
          referenceTaskIds: [],
        },
        configuration: undefined,
        metadata: undefined,
      },
      optIn,
    );
    const part = (result as Message).parts[0]!;
    if (part.content?.$case !== "raw") throw new Error("reply is not a raw part");
    return JSON.parse(Buffer.from(part.content.value).toString("utf8")) as Json;
  };

  /** Raw JSON-RPC to the seller, the shape the Passport relay sends. */
  const notifySeller = async (
    note: Json,
    optInOverride?: { header?: boolean; messageExtensions?: string[] },
  ): Promise<{ body: Json; responseHeader: string | null }> => {
    const resp = await fetch(`${sellerBase}/a2a/v1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(optInOverride?.header === false ? {} : { "A2A-Extensions": EXTENSION_URI }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "note_" + randomBytes(4).toString("hex"),
        method: "SendMessage",
        params: {
          message: {
            messageId: randomBytes(8).toString("hex"),
            role: "ROLE_USER",
            parts: [
              { raw: Buffer.from(JSON.stringify(note)).toString("base64"), mediaType: CONTRACT_MESSAGE_MEDIA_TYPE },
            ],
            extensions: optInOverride?.messageExtensions ?? [EXTENSION_URI],
          },
        },
      }),
    });
    return { body: (await resp.json()) as Json, responseHeader: resp.headers.get("A2A-Extensions") };
  };

  beforeAll(async () => {
    await fake.start();
    process.env["KITE_COORDINATION_ENDPOINT"] = fake.url;

    const { buildApp } = await import("../src/server.js");
    const corpusPath = fileURLToPath(new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url));
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const a = probe.address() as { port: number };
        probe.close(() => resolve(a.port));
      });
    });
    sellerBase = `http://127.0.0.1:${port}`;
    boot = await buildApp({
      publicUrl: sellerBase,
      corpusPath,
      privateKey: SELLER_KEY,
      seedSecret: "live-secret",
      mode: "live",
      skipBindingCheck: true, // the binding is an external MCP prerequisite; its CHECK is covered below
      deliveryRetrySeconds: 1,
      outcomePollSeconds: 0.2,
    });
    await new Promise<void>((resolve) => {
      sellerServer = boot.app.listen(port, "127.0.0.1", () => resolve());
    });
    const transport = await new JsonRpcTransportFactory().create(`${sellerBase}/a2a/v1`, boot.card);
    client = new Client(transport, boot.card);
  }, 30_000);

  afterAll(() => new Promise<void>((resolve) => sellerServer.close(() => resolve())));

  it("live mode without a durable key fails closed", async () => {
    const { buildApp } = await import("../src/server.js");
    delete process.env["SELLER_RUNTIME_PRIVATE_KEY"];
    await expect(
      buildApp({
        publicUrl: "http://x",
        corpusPath: fileURLToPath(new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url)),
        mode: "live",
      }),
    ).rejects.toThrow(/durable runtime key/);
  });

  /** Walk one deal to the given stage; returns ids and artifacts. */
  const runDeal = async (options: {
    through: "DELIVERED" | "COMMITTED";
    substituteBuyerAgent?: boolean;
    dropDeliveredResponse?: boolean;
  }): Promise<Json> => {
    const quote = await negotiate({ kind: "query", buyerAgentId: BUYER_DID, body: QUERY });
    expect(quote["kind"]).toBe("quote");
    const doc = quote["termsDocument"] as Json;

    const contract: Json = {
      schema: "https://a2a.gokite.ai/schemas/deal-contract/v1",
      template: "fixed_outcome/v1",
      buyerAgentId: BUYER_DID,
      sellerAgentId: SELLER_DID,
      deliverable: `Synthetic CSV per pinned terms: ${doc["totalRows"]} rows over ${doc["tractCount"]} tracts.`,
      acceptanceCriteria: quote["acceptanceCriteria"],
      price: { amount: doc["priceAmount"], asset: "USDC" },
      escrow: { payoutAddress: SELLER_PAYOUT_ADDRESS },
      disputePolicy: { arbiterAgentId: "did:kite:arbiterco:arbiter-01" },
      runtimeBinding: {
        runtimeAgentId: RUNTIME_DID,
        agentCardHash: fake.cardHash(), // the REAL hash of the fake card — countersigning verifies it
        extensionUri: EXTENSION_URI,
        endpoint: fake.url,
      },
    };
    const termsHash = termsHashOf(contract);
    contract["signatures"] = [
      {
        signerAgentId: BUYER_DID,
        profile: "secp256k1-keccak-v1",
        keyId: keyIdOf(BUYER_DID, BUYER_KEY),
        sig: sign(BUYER_KEY, termsSigningBytes(termsHash)),
      },
    ];

    // The buyer proposes to the RUNTIME; the seller never sees it.
    const dealId = fake.createProposal(contract);

    // Buyer's §4.4 Agreement signature under the fake card's chain context.
    const buyerAgreementSig = signStruct(
      BUYER_KEY,
      { name: "KiteFulfill", version: "1", chainId: CHAIN_ID },
      TYPE_STRINGS.Agreement,
      { agreementId: dealId, termsHash, amount: String(doc["priceAmount"]), buyerAgent: buyerAddress, sellerAgent: sellerAddress },
    );

    const acceptance = await negotiate({
      kind: "acceptance-request",
      dealId,
      negotiationId: quote["negotiationId"],
      contract,
      buyerAddress,
      buyerAgreementSig,
    });
    expect(acceptance["kind"], JSON.stringify(acceptance["error"] ?? "")).toBe("acceptance-result");
    expect(fake.deals.get(dealId)!.state).toBe("COMMITTED");
    expect((acceptance["status"] as Json)["state"]).toBe("COMMITTED");

    // Funding: first read finds no buyer wallet → a state, not an error.
    const pending = await negotiate({ kind: "funding-request", dealId });
    expect(pending["kind"]).toBe("funding-state");
    // The buyer's wallet lands (buyer-side artifacts are the buyer's to produce).
    fake.deals.get(dealId)!.activationComplete = true;
    if (options.substituteBuyerAgent === true) {
      // P1 regression: a Runtime answering the funding read with a DIFFERENT
      // buyerAgent than the one whose signatures were verified at countersign.
      fake.deals.get(dealId)!.activationBuyerAgent = "0x" + "44".repeat(20);
      const refused = await negotiate({ kind: "funding-request", dealId });
      return { dealId, termsHash, refused };
    }
    const funded = await negotiate({ kind: "funding-request", dealId });
    expect(funded["kind"], JSON.stringify(funded["error"] ?? "")).toBe("funding-result");
    expect(fake.deals.get(dealId)!.sellerActivationSigned).toBe(true);

    if (options.through === "COMMITTED") return { dealId, termsHash };

    // The chain observation → FULFILLING → §6.5 work-start notification.
    fake.confirmFund(dealId);
    if (options.dropDeliveredResponse === true) fake.dropNextDeliveredResponse = true;
    const { body: ack, responseHeader } = await notifySeller({
      type: "kite.contract.fulfill_started",
      deal_id: dealId,
      terms_hash: termsHash,
      delivery_deadline: Math.floor(Date.now() / 1000) + 120,
    });
    expect(ack["error"]).toBeUndefined();
    // §2.2, server half: the activation is echoed on BOTH channels.
    expect(responseHeader).toContain(EXTENSION_URI);
    const ackMessage = (ack["result"] as Json)["message"] as Json;
    expect(ackMessage["extensions"]).toContain(EXTENSION_URI);
    const ackPart = (ackMessage["parts"] as Json[])[0]!;
    const ackPayload = JSON.parse(Buffer.from(String(ackPart["raw"]), "base64").toString("utf8")) as Json;
    expect(ackPayload["acknowledged"]).toBe(true);
    expect(ackPayload["verifiedState"]).toBe("FULFILLING");

    // The background task delivers autonomously — no buyer follow-up.
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (fake.deals.get(dealId)!.state === "DELIVERED") break;
      if (Date.now() > deadline) throw new Error("background delivery did not land");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const deal = fake.deals.get(dealId)!;
    expect(deal.evidence.size).toBe(1);
    const [evidenceId, evidence] = [...deal.evidence.entries()][0]!;
    return { dealId, termsHash, evidenceId, evidenceUrl: evidence.url, evidenceHash: evidence.hash };
  };

  it(
    "accepted path: countersign → funding co-sign → notification → autonomous delivery → ACCEPTED keeps the capability",
    async () => {
      const { dealId, evidenceUrl, evidenceHash } = await runDeal({ through: "DELIVERED" });

      // The registered evidence URL serves bytes hashing to the registered hash.
      const res = await fetch(String(evidenceUrl));
      expect(res.status).toBe(200);
      const manifestBytes = Buffer.from(await res.arrayBuffer());
      expect(sha256Ref(manifestBytes)).toBe(evidenceHash);

      fake.buyerAccept(dealId);
      const state = await boot.live!.refreshOutcome(dealId);
      expect(state).toBe("ACCEPTED");
      // Seller-favour settlement: the capability survives for the declared window.
      expect((await fetch(String(evidenceUrl))).status).toBe(200);
    },
    60_000,
  );

  it("an unverifiable notification is answered with a JSON-RPC ERROR, keeping the relay's retry alive", async () => {
    const { body: reply } = await notifySeller({
      type: "kite.contract.fulfill_started",
      deal_id: "deal_nobody_knows",
      terms_hash: "sha256:" + "ab".repeat(32),
    });
    expect(reply["error"]).toBeDefined();
    expect((reply["error"] as Json)["message"]).toContain("unknown dealId");
    expect(reply["result"]).toBeUndefined();

    const { body: wrongType } = await notifySeller({ type: "kite.contract.someday_maybe", deal_id: "x" });
    expect((wrongType["error"] as Json)["message"]).toContain("v1 defines exactly one");
  });

  it("a notification missing either half of the §2.2 opt-in is refused with a JSON-RPC error", async () => {
    const note = { type: "kite.contract.fulfill_started", deal_id: "irrelevant" };

    const { body: noHeader } = await notifySeller(note, { header: false });
    expect(noHeader["result"]).toBeUndefined();
    expect((noHeader["error"] as Json)["message"]).toContain("A2A-Extensions header");

    const { body: noArray } = await notifySeller(note, { messageExtensions: [] });
    expect(noArray["result"]).toBeUndefined();
    expect((noArray["error"] as Json)["message"]).toContain("extensions array");
  });

  it("the manual request-delivery path does not exist in live mode", async () => {
    const { dealId } = await runDeal({ through: "COMMITTED" });
    const refusal = await negotiate({ kind: "request-delivery", dealId });
    expect(refusal["kind"]).toBe("error");
    expect(String(refusal["error"])).toContain("notification-driven");
    expect(JSON.stringify(refusal)).not.toContain("cap=");
  });

  it(
    "refund outcomes revoke access AUTONOMOUSLY — no /admin visit, no manual refresh",
    async () => {
      const { dealId, evidenceUrl } = await runDeal({ through: "DELIVERED" });
      expect((await fetch(String(evidenceUrl))).status).toBe(200);

      // The buyer rejects; the seller (its own move) consents to the refund.
      fake.buyerReject(dealId);
      const result = await boot.live!.consentRefund(dealId);
      expect(((result["status"] ?? {}) as Json)["state"]).toBe("CANCELLED");

      // NOTHING ELSE: the watcher started at delivery must observe the
      // refund outcome and close the gate on its own.
      const deadline = Date.now() + 10_000;
      for (;;) {
        if ((await fetch(String(evidenceUrl))).status === 404) break;
        if (Date.now() > deadline) throw new Error("the watcher never revoked the capability");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await fetch(String(evidenceUrl))).status).toBe(404);
    },
    60_000,
  );

  it(
    "dispute path: REJECTED → refund_consented → CANCELLED revokes the capability",
    async () => {
      const { dealId, evidenceUrl } = await runDeal({ through: "DELIVERED" });
      fake.buyerReject(dealId);

      const result = await boot.live!.consentRefund(dealId);
      expect(((result["status"] ?? {}) as Json)["state"]).toBe("CANCELLED");

      const state = await boot.live!.refreshOutcome(dealId);
      expect(state).toBe("CANCELLED");
      // A refunded buyer must not keep the paid product behind a live URL.
      expect((await fetch(String(evidenceUrl))).status).toBe(404);
    },
    60_000,
  );

  it(
    "dispute path: REJECTED → appealed → DISPUTED → arbiter for the BUYER (sellerBps=0) revokes",
    async () => {
      const { dealId, evidenceUrl } = await runDeal({ through: "DELIVERED" });
      fake.buyerReject(dealId);

      const result = await boot.live!.appeal(dealId);
      expect(((result["status"] ?? {}) as Json)["state"]).toBe("DISPUTED");

      fake.arbiterDecide(dealId, 0);
      const state = await boot.live!.refreshOutcome(dealId);
      expect(state).toBe("RESOLVED");
      expect((await fetch(String(evidenceUrl))).status).toBe(404);
    },
    60_000,
  );

  it(
    "dispute path: arbiter for the SELLER (sellerBps=10000) keeps the capability",
    async () => {
      const { dealId, evidenceUrl } = await runDeal({ through: "DELIVERED" });
      fake.buyerReject(dealId);
      await boot.live!.appeal(dealId);
      fake.arbiterDecide(dealId, 10_000);
      const state = await boot.live!.refreshOutcome(dealId);
      expect(state).toBe("RESOLVED");
      expect((await fetch(String(evidenceUrl))).status).toBe(200);
    },
    60_000,
  );

  it("a substituted buyerAgent in the read-back Activation is refused before co-signing", async () => {
    const { refused } = await runDeal({ through: "COMMITTED", substituteBuyerAgent: true });
    expect((refused as Json)["kind"]).toBe("error");
    expect(String((refused as Json)["error"])).toContain("not the verified buyer");
  }, 60_000);

  it(
    "a delivered command whose response was LOST still gets an outcome watcher: a later refund revokes",
    async () => {
      // The Runtime commits DELIVERED but the reply never arrives; the retry
      // observes non-FULFILLING and stops. The watcher must exist anyway —
      // it starts when the capability starts existing, not on a successful
      // submitCommand return.
      const { dealId, evidenceUrl } = await runDeal({ through: "DELIVERED", dropDeliveredResponse: true });
      expect((await fetch(String(evidenceUrl))).status).toBe(200);

      fake.buyerReject(dealId);
      const result = await boot.live!.consentRefund(dealId);
      expect(((result["status"] ?? {}) as Json)["state"]).toBe("CANCELLED");

      const deadline = Date.now() + 10_000;
      for (;;) {
        if ((await fetch(String(evidenceUrl))).status === 404) break;
        if (Date.now() > deadline) throw new Error("no watcher revoked the capability after the lost response");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    60_000,
  );

  it("an acceptance whose response was LOST reconciles on retry instead of reporting unknown-deal", async () => {
    const quote = await negotiate({ kind: "query", buyerAgentId: BUYER_DID, body: QUERY });
    const doc = quote["termsDocument"] as Json;
    const contract: Json = {
      schema: "https://a2a.gokite.ai/schemas/deal-contract/v1",
      template: "fixed_outcome/v1",
      buyerAgentId: BUYER_DID,
      sellerAgentId: SELLER_DID,
      deliverable: `Synthetic CSV per pinned terms: ${doc["totalRows"]} rows.`,
      acceptanceCriteria: quote["acceptanceCriteria"],
      price: { amount: doc["priceAmount"], asset: "USDC" },
      escrow: { payoutAddress: SELLER_PAYOUT_ADDRESS },
      disputePolicy: { arbiterAgentId: "did:kite:arbiterco:arbiter-01" },
      runtimeBinding: {
        runtimeAgentId: RUNTIME_DID,
        agentCardHash: fake.cardHash(),
        extensionUri: EXTENSION_URI,
        endpoint: fake.url,
      },
    };
    const termsHash = termsHashOf(contract);
    contract["signatures"] = [
      {
        signerAgentId: BUYER_DID,
        profile: "secp256k1-keccak-v1",
        keyId: keyIdOf(BUYER_DID, BUYER_KEY),
        sig: sign(BUYER_KEY, termsSigningBytes(termsHash)),
      },
    ];
    const dealId = fake.createProposal(contract);
    const buyerAgreementSig = signStruct(
      BUYER_KEY,
      { name: "KiteFulfill", version: "1", chainId: CHAIN_ID },
      TYPE_STRINGS.Agreement,
      { agreementId: dealId, termsHash, amount: String(doc["priceAmount"]), buyerAgent: buyerAddress, sellerAgent: sellerAddress },
    );
    const request = {
      kind: "acceptance-request",
      dealId,
      negotiationId: quote["negotiationId"],
      contract,
      buyerAddress,
      buyerAgreementSig,
    };

    // First attempt: the Runtime COMMITS, then the response is lost.
    fake.dropNextAcceptanceResponse = true;
    const lost = await negotiate(request);
    expect(lost["kind"]).toBe("error");
    expect(fake.deals.get(dealId)!.state).toBe("COMMITTED");

    // Retry: the seller recognizes the COMMITTED holding exactly these terms
    // as its own acceptance and reconciles instead of refusing.
    const retried = await negotiate(request);
    expect(retried["kind"], JSON.stringify(retried["error"] ?? "")).toBe("acceptance-result");
    expect((retried["status"] as Json)["state"]).toBe("COMMITTED");
    expect(retried["reconciled"]).toBe(true);

    // And the deal is REMEMBERED: funding proceeds instead of unknown-deal.
    fake.deals.get(dealId)!.activationComplete = true;
    const funded = await negotiate({ kind: "funding-request", dealId });
    expect(funded["kind"], JSON.stringify(funded["error"] ?? "")).toBe("funding-result");
  }, 60_000);

  it("a tampered Runtime card is refused at countersign (agentCardHash pin)", async () => {
    const { dealId, termsHash } = await runDeal({ through: "COMMITTED" });
    void dealId;
    void termsHash;
    // Mutate the served card AFTER a pin exists: the NEXT deal's countersign
    // must refuse it.
    (fake.card as Json)["description"] = "tampered";
    try {
      const quote = await negotiate({ kind: "query", buyerAgentId: BUYER_DID, body: QUERY });
      const doc = quote["termsDocument"] as Json;
      const contract: Json = {
        schema: "https://a2a.gokite.ai/schemas/deal-contract/v1",
        template: "fixed_outcome/v1",
        buyerAgentId: BUYER_DID,
        sellerAgentId: SELLER_DID,
        deliverable: "x",
        acceptanceCriteria: quote["acceptanceCriteria"],
        price: { amount: doc["priceAmount"], asset: "USDC" },
        escrow: { payoutAddress: SELLER_PAYOUT_ADDRESS },
        disputePolicy: { arbiterAgentId: "did:kite:arbiterco:arbiter-01" },
        runtimeBinding: {
          runtimeAgentId: RUNTIME_DID,
          // The OLD (pre-tamper) pin: countersigning re-fetches the card and
          // must see the mismatch.
          agentCardHash: sha256Ref(utf8("something the card no longer is")),
          extensionUri: EXTENSION_URI,
          endpoint: fake.url,
        },
      };
      const th = termsHashOf(contract);
      contract["signatures"] = [
        {
          signerAgentId: BUYER_DID,
          profile: "secp256k1-keccak-v1",
          keyId: keyIdOf(BUYER_DID, BUYER_KEY),
          sig: sign(BUYER_KEY, termsSigningBytes(th)),
        },
      ];
      const newDealId = fake.createProposal(contract);
      const refusal = await negotiate({
        kind: "acceptance-request",
        dealId: newDealId,
        negotiationId: quote["negotiationId"],
        contract,
        buyerAddress,
        buyerAgreementSig: "0x" + "ab".repeat(65),
      });
      expect(refusal["kind"]).toBe("error");
      expect(String(refusal["error"])).toContain("not the one the terms pin");
    } finally {
      (fake.card as Json)["description"] = "test double";
    }
  }, 60_000);
});
