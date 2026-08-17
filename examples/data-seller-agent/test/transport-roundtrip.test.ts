/**
 * PLAN phase 2 exit criterion: an in-process buyer driver walks the whole
 * standalone flow over real HTTP + JSON-RPC — query → quote → proposal →
 * countersign → delivery — verifying every hash and signature it is handed,
 * exactly as a real counterparty would. Negative paths (missing opt-in, a
 * tampered price, a wrong capability token) are refused, not repaired.
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Role, type Message } from "@a2a-js/sdk";
import { Client, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions } from "@a2a-js/sdk/client";
import { buildApp } from "../src/server.js";
import {
  coordinationEndpoint,
  DEMO_CHAIN_ID,
  EXTENSION_URI,
  NEGOTIATION_MEDIA_TYPE,
  demoAnchors,
  signDeliveryRequest,
  vaultDomain,
} from "../src/extension.js";
import {
  addressOfPrivateKey,
  commandSigningBytes,
  envelopeSigningBytes,
  fromHex,
  keyIdOf,
  recover,
  sha256Ref,
  sign,
  termsHashOf,
  termsSigningBytes,
  verify,
} from "../src/signing.js";
import { TYPE_STRINGS, recoverStruct, signStruct } from "../src/settlement.js";
import { parseAcceptanceCriteria, termsDocumentHashOf } from "../src/terms.js";
import { verifierBundleHash } from "../src/seller.js";
import { loadPlaces } from "../src/engine/places.js";
import { readQuery } from "../src/product.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";

type Json = Record<string, any>;

const BUYER_KEY = fromHex("0x1111111111111111111111111111111111111111111111111111111111111111");
const SELLER_KEY = fromHex("0x2222222222222222222222222222222222222222222222222222222222222222");
const BUYER_DID = "did:kite:acme:buyer-17";

const SCHEMAS = fileURLToPath(new URL("../../../schemas/v1/", import.meta.url));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const commandSchema = ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, "agreement-command.schema.json"), "utf8")));
const contractSchema = ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, "deal-contract.schema.json"), "utf8")));

const QUERY = { columns: ["DIABETES", "BPHIGH"], states: ["CA"], counties: ["Alameda"] };

describe("standalone transport round trip", () => {
  let server: Server;
  let base: string;
  let client: Client;
  let sellerInfo: Json;

  const optIn = { serviceParameters: ServiceParameters.create(withA2AExtensions(EXTENSION_URI)) };

  const negotiate = async (payload: Json, options: Json = optIn): Promise<Json> => {
    const result = await client.sendMessage(
      {
        tenant: "",
        message: {
          messageId: "m_" + Math.random().toString(36).slice(2),
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
          extensions: (options["extensions"] as string[] | undefined) ?? [EXTENSION_URI],
          referenceTaskIds: [],
        },
        configuration: undefined,
        metadata: undefined,
      },
      (options["serviceParameters"] !== undefined ? { serviceParameters: options["serviceParameters"] } : {}) as never,
    );
    const message = result as Message;
    const part = message.parts[0]!;
    if (part.content?.$case !== "raw") throw new Error("reply is not a raw part");
    return JSON.parse(Buffer.from(part.content.value).toString("utf8")) as Json;
  };

  let sellerRef: Awaited<ReturnType<typeof buildApp>>["seller"];

  beforeAll(async () => {
    const corpusPath = fileURLToPath(new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url));
    // Grab a free port first so the advertised public URL is real.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const a = probe.address();
        probe.close(() => resolve((a as { port: number }).port));
      });
    });
    base = `http://127.0.0.1:${port}`;
    const boot = await buildApp({
      publicUrl: base,
      corpusPath,
      privateKey: SELLER_KEY,
      seedSecret: "roundtrip-secret",
    });
    sellerRef = boot.seller;
    await new Promise<void>((resolve) => {
      server = boot.app.listen(port, "127.0.0.1", () => resolve());
    });
    const transport = await new JsonRpcTransportFactory().create(`${base}/a2a/v1`, boot.card);
    client = new Client(transport, boot.card);
  }, 30_000);

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("refuses a request missing the A2A-Extensions header, and one missing the extensions array", async () => {
    const noHeader = await negotiate({ kind: "query", buyerAgentId: BUYER_DID, body: QUERY }, {});
    expect(noHeader["kind"]).toBe("error");
    expect(String(noHeader["error"])).toContain("A2A-Extensions");

    const noArray = await negotiate(
      { kind: "query", buyerAgentId: BUYER_DID, body: QUERY },
      { serviceParameters: optIn.serviceParameters, extensions: [] },
    );
    expect(noArray["kind"]).toBe("error");
    expect(String(noArray["error"])).toContain("extensions array");
  });

  it("requires a buyer identity before recording a negotiation", async () => {
    const refused = await negotiate({ kind: "query", body: QUERY });
    expect(refused["kind"]).toBe("error");
    expect(String(refused["error"])).toContain("buyerAgentId");
  });

  it("answers a malformed query with the engine's named rejection codes", async () => {
    const refused = await negotiate({
      kind: "query",
      buyerAgentId: BUYER_DID,
      body: { columns: ["DIABETES", "toString"] },
    });
    expect(refused["kind"]).toBe("quote");
    expect(refused["negotiationId"]).toMatch(/^neg_/);
    expect(refused["accepted"]).toBe(false);
    expect((refused["rejections"] as Json[]).map((r) => r["code"])).toContain("UNKNOWN_COLUMN");
  });

  let quote: Json;
  let contract: Json;
  let dealId: string;
  let acceptedContract: Json;
  let delivery: Json;

  it("quotes: committed statsHash, terms document, and an acceptanceCriteria that pins it", async () => {
    quote = await negotiate({ kind: "query", buyerAgentId: BUYER_DID, body: QUERY });
    expect(quote["kind"]).toBe("quote");
    expect(quote["negotiationId"]).toMatch(/^neg_/);
    expect(quote["accepted"]).toBe(true);
    const doc = quote["termsDocument"] as Json;
    // The buyer's own checks, not trust: the document hashes to the claimed
    // hash, the acceptanceCriteria pins exactly that hash, and the price the
    // document names is the quote's.
    expect(termsDocumentHashOf(doc as never)).toBe(quote["termsDocumentHash"]);
    const commitment = parseAcceptanceCriteria(String(quote["acceptanceCriteria"]));
    expect(commitment?.termsDocumentHash).toBe(quote["termsDocumentHash"]);
    expect(commitment?.locator).toContain(String(quote["termsDocumentHash"]));
    expect(doc["priceAmount"]).toBe(
      ((quote["body"] as Json)["price"]["listCents"] / 100).toFixed(2),
    );
    expect(doc["priceBreakdownCents"]).toMatchObject({
      base: 100,
      tracts: 0,
      standardColumns: 0,
      premiumColumns: 1000,
      subtotal: 1100,
    });
    expect(doc["priceAmount"]).toBe("11.00");
    expect(doc["verifierHash"]).toBe(verifierBundleHash());
    sellerInfo = quote["seller"] as Json;
    expect(String(sellerInfo["sellerAddress"]).toLowerCase()).toBe(addressOfPrivateKey(SELLER_KEY));
  });

  it("shows negotiations under the buyer before an agreement exists", async () => {
    const index = await fetch(`${base}/admin`);
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).toContain("Buyers");
    expect(indexHtml).toContain(BUYER_DID);
    expect(indexHtml).toContain("pre-agreement only");

    const detail = await fetch(`${base}/admin/buyers/${encodeURIComponent(BUYER_DID)}`);
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("Negotiation identity");
    expect(detailHtml).toContain("Query and quote exchanges");
    expect(detailHtml).toContain("Seller refused the query");
    expect(detailHtml).toContain("Seller quoted 11.00 USDC");
    expect(detailHtml).toContain("No agreements for this buyer");
    expect(detailHtml).not.toContain("?cap=");
  });

  it("the terms document is served content-addressed", async () => {
    const res = await fetch(`${base}/terms/${quote["termsDocumentHash"]}`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(sha256Ref(bytes)).toBe(quote["termsDocumentHash"]);
  });

  it("proposes: the buyer builds and signs the contract, the seller acks with a deal id", async () => {
    const doc = quote["termsDocument"] as Json;
    contract = {
      schema: "https://a2a.gokite.ai/schemas/deal-contract/v1",
      template: "fixed_outcome/v1",
      buyerAgentId: BUYER_DID,
      sellerAgentId: sellerInfo["sellerAgentId"],
      deliverable:
        "Synthetic individual-level CSV over CDC PLACES 2025 per the pinned terms document: " +
        `${doc["totalRows"]} rows over ${doc["tractCount"]} tracts, ${doc["rowsPerTract"]} per tract.`,
      acceptanceCriteria: quote["acceptanceCriteria"],
      price: { amount: doc["priceAmount"], asset: "USDC" },
      escrow: { payoutAddress: sellerInfo["payoutAddress"] },
      disputePolicy: { arbiterAgentId: "did:kite:arbiterco:arbiter-01" },
      runtimeBinding: {
        runtimeAgentId: "did:kite:kite:coordination-engine",
        agentCardHash: "sha256:" + "aa".repeat(32), // standalone placeholder, same as seller-agent/
        extensionUri: EXTENSION_URI,
        endpoint: coordinationEndpoint(),
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
    expect(contractSchema(contract), JSON.stringify(contractSchema.errors)).toBe(true);

    const ack = await negotiate({
      kind: "submit-proposal",
      negotiationId: quote["negotiationId"],
      contract,
      buyerAddress: addressOfPrivateKey(BUYER_KEY),
    });
    expect(ack["kind"]).toBe("proposal-ack");
    expect(ack["termsHash"]).toBe(termsHash);
    dealId = String(ack["dealId"]);
    expect(dealId).toMatch(/^deal_/);
  });

  it("refuses to countersign a tampered price", async () => {
    const doc = quote["termsDocument"] as Json;
    const cheaper = {
      ...contract,
      price: { amount: "1.00", asset: "USDC" },
    } as Json;
    const termsHash = termsHashOf(cheaper);
    cheaper["signatures"] = [
      {
        signerAgentId: BUYER_DID,
        profile: "secp256k1-keccak-v1",
        keyId: keyIdOf(BUYER_DID, BUYER_KEY),
        sig: sign(BUYER_KEY, termsSigningBytes(termsHash)),
      },
    ];
    const ack = await negotiate({
      kind: "submit-proposal",
      negotiationId: quote["negotiationId"],
      contract: cheaper,
      buyerAddress: addressOfPrivateKey(BUYER_KEY),
    });
    const cheapDealId = String(ack["dealId"]);
    const digestSig = buyerAgreementSigFor(cheapDealId, termsHash, "1.00");
    const refusal = await negotiate({
      kind: "acceptance-request",
      dealId: cheapDealId,
      buyerAgreementSig: digestSig,
    });
    expect(refusal["kind"]).toBe("error");
    expect(String(refusal["error"])).toContain("rate card does not produce");
    void doc;
  });

  const buyerAgreementSigFor = (deal: string, termsHash: string, amount: string): string =>
    signStruct(
      BUYER_KEY,
      { name: "KiteFulfill", version: "1", chainId: DEMO_CHAIN_ID },
      TYPE_STRINGS.Agreement,
      {
        agreementId: deal,
        termsHash,
        amount,
        buyerAgent: addressOfPrivateKey(BUYER_KEY),
        sellerAgent: addressOfPrivateKey(SELLER_KEY),
      },
    );

  it("countersigns: acceptance is the second signature over the identical termsHash", async () => {
    const termsHash = termsHashOf(contract);
    const result = await negotiate({
      kind: "acceptance-request",
      dealId,
      buyerAgreementSig: buyerAgreementSigFor(dealId, termsHash, String((contract["price"] as Json)["amount"])),
    });
    expect(result["kind"], JSON.stringify(result)).toBe("acceptance-result");
    acceptedContract = result["contract"] as Json;

    const signatures = acceptedContract["signatures"] as Json[];
    expect(signatures).toHaveLength(2);
    expect(contractSchema(acceptedContract), JSON.stringify(contractSchema.errors)).toBe(true);

    // The buyer verifies the seller's two signatures against ITS OWN
    // recomputed termsHash — never a claimed one.
    const recomputed = termsHashOf(acceptedContract);
    expect(recomputed).toBe(termsHash);
    const acceptance = signatures[1]!;
    expect(acceptance["signerAgentId"]).toBe(sellerInfo["sellerAgentId"]);
    expect(
      verify(String(acceptance["sig"]), termsSigningBytes(recomputed), String(sellerInfo["sellerAddress"])),
    ).toBe(true);
    const recoveredAgreement = recoverStruct(
      String(acceptance["agreementSig"]),
      { name: "KiteFulfill", version: "1", chainId: DEMO_CHAIN_ID },
      TYPE_STRINGS.Agreement,
      {
        agreementId: dealId,
        termsHash: recomputed,
        amount: String((acceptedContract["price"] as Json)["amount"]),
        buyerAgent: addressOfPrivateKey(BUYER_KEY),
        sellerAgent: addressOfPrivateKey(SELLER_KEY),
      },
    );
    expect(recoveredAgreement).toBe(addressOfPrivateKey(SELLER_KEY));
  });

  it("an unauthorized caller cannot obtain the artifact URLs", async () => {
    // No proof at all: refused, and the reply carries no capability URL.
    const bare = await negotiate({ kind: "request-delivery", dealId });
    expect(bare["kind"]).toBe("error");
    expect(JSON.stringify(bare)).not.toContain("cap=");

    // A signature by SOMEONE ELSE'S key over the right deal id: refused too —
    // knowing a deal id (they are visible on /admin) is not authorization.
    const strangerKey = fromHex("0x4444444444444444444444444444444444444444444444444444444444444444");
    const requestedAt = Math.floor(Date.now() / 1000);
    const forged = await negotiate({
      kind: "request-delivery",
      dealId,
      requestedAt,
      buyerSig: signDeliveryRequest(strangerKey, dealId, requestedAt),
    });
    expect(forged["kind"]).toBe("error");
    expect(String(forged["error"])).toContain("not signed by the buyer");
    expect(JSON.stringify(forged)).not.toContain("cap=");

    // A STALE buyer signature: refused — the proof has a freshness window.
    const stale = await negotiate({
      kind: "request-delivery",
      dealId,
      requestedAt: requestedAt - 3600,
      buyerSig: signDeliveryRequest(BUYER_KEY, dealId, requestedAt - 3600),
    });
    expect(stale["kind"]).toBe("error");
    expect(String(stale["error"])).toContain("freshness window");
  });

  it("delivers: schema-valid signed command, verified evidence envelope, capability-gated bytes", async () => {
    const requestedAt = Math.floor(Date.now() / 1000);
    delivery = await negotiate({
      kind: "request-delivery",
      dealId,
      requestedAt,
      buyerSig: signDeliveryRequest(BUYER_KEY, dealId, requestedAt),
    });
    expect(delivery["kind"], JSON.stringify(delivery["error"] ?? "")).toBe("delivery");

    // The signed delivered command validates against the published schema and
    // recovers to the seller's address over the command tag.
    const command = delivery["command"] as Json;
    expect(commandSchema(command), JSON.stringify(commandSchema.errors)).toBe(true);
    const commandSigner = recover(
      String((command["signature"] as Json)["sig"]),
      commandSigningBytes(command),
    );
    expect(commandSigner).toBe(addressOfPrivateKey(SELLER_KEY));
    expect(command["termsHash"]).toBe(termsHashOf(acceptedContract));

    // §4.4: sellerDeliverySig verifies over the Delivery struct under the
    // (standalone placeholder) anchors.
    const payload = command["payload"] as Json;
    const anchors = demoAnchors(dealId);
    const recovered = recoverStruct(
      String(payload["sellerDeliverySig"]),
      vaultDomain(anchors),
      TYPE_STRINGS.Delivery,
      {
        dealId: anchors.dealId32,
        termsHash: String(command["termsHash"]),
        deliveryHash: String(payload["deliveryHash"]),
        receiptHash: anchors.receiptHash,
        nonce: anchors.nonce,
        expiry: anchors.expiry,
      },
    );
    expect(recovered).toBe(addressOfPrivateKey(SELLER_KEY));

    // The evidence envelope is signed over the funding tag and its submission
    // pins the same hash the command anchors.
    const envelope = delivery["evidenceEnvelope"] as Json;
    const envelopeSigner = recover(
      String((envelope["signature"] as Json)["sig"]),
      envelopeSigningBytes(envelope),
    );
    expect(envelopeSigner).toBe(addressOfPrivateKey(SELLER_KEY));
    expect((envelope["submission"] as Json)["hash"]).toBe(payload["deliveryHash"]);
  });

  it("the fetched manifest hashes to deliveryHash; the fetched CSV hashes to the manifest's own claim", async () => {
    const manifestRes = await fetch(String(delivery["manifestUrl"]));
    expect(manifestRes.status).toBe(200);
    const manifestBytes = Buffer.from(await manifestRes.arrayBuffer());
    expect(sha256Ref(manifestBytes)).toBe(String(delivery["deliveryHash"]));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Json;

    const csvRes = await fetch(String(delivery["csvUrl"]));
    expect(csvRes.status).toBe(200);
    const csv = Buffer.from(await csvRes.arrayBuffer());
    expect(`sha256:${createHash("sha256").update(csv).digest("hex")}`).toBe(
      (manifest["artifact"] as Json)["contentHash"],
    );

    // The live-mode buyer holds ONLY the manifest (resolved through the
    // Runtime's evidence record), so the manifest's own artifact.locator must
    // be the fetchable capability URL — a process-internal handle here means
    // a paid-for file no live buyer can locate.
    const locator = String((manifest["artifact"] as Json)["locator"]);
    expect(locator).toBe(String(delivery["csvUrl"]));
    const viaLocator = Buffer.from(await (await fetch(locator)).arrayBuffer());
    expect(viaLocator.equals(csv)).toBe(true);

    // The delivery defence: check the verifier bundle's digest against the
    // SIGNED terms document, then load it and regenerate byte-for-byte.
    const doc = quote["termsDocument"] as Json;
    expect(verifierBundleHash()).toBe(doc["verifierHash"]);
    const { verifyDelivery } = await import("../src/verifier.js");
    const dir = mkdtempSync(join(tmpdir(), "buyer-corpus-"));
    const csvPath = join(dir, "places.csv");
    writeFileSync(
      csvPath,
      gunzipSync(readFileSync(fileURLToPath(new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url)))),
    );
    const corpus = await loadPlaces(csvPath);
    const verdict = verifyDelivery({
      manifest: manifest as never,
      received: csv,
      corpus,
      query: readQuery(QUERY),
    });
    expect(verdict.ok, verdict.problems.join("; ")).toBe(true);
  }, 60_000);

  it("a wrong or missing capability token gets a 404 that reveals nothing", async () => {
    const url = new URL(String(delivery["manifestUrl"]));
    url.searchParams.set("cap", "0".repeat(32));
    expect((await fetch(url)).status).toBe(404);
    url.searchParams.delete("cap");
    expect((await fetch(url)).status).toBe(404);
  });

  it("shows the buyer, negotiation, and lifecycle history without leaking artifact capabilities", async () => {
    const buyerResponse = await fetch(`${base}/admin/buyers/${encodeURIComponent(BUYER_DID)}`);
    expect(buyerResponse.status).toBe(200);
    const buyerHtml = await buyerResponse.text();
    expect(buyerHtml).toContain(dealId);
    expect(buyerHtml).toContain("AGREEMENT_STARTED");

    const response = await fetch(`${base}/admin/agreements/${dealId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(BUYER_DID);
    expect(html).toContain("Negotiation and quote");
    expect(html).toContain("Agreement lifecycle");
    expect(html).toContain("Buyer → Seller");
    expect(html).toContain("Seller → Buyer");
    expect(html).toContain("submit-proposal");
    expect(html).toContain("acceptance-result");
    expect(html).toContain("DELIVERED_LOCAL");
    expect(html).not.toContain("?cap=");
  });

  it("revocation closes the gate: a refunded buyer's token stops working", async () => {
    const url = String(delivery["manifestUrl"]);
    expect((await fetch(url)).status).toBe(200);
    // Phase 3 drives this from an OBSERVED refund outcome; the gate itself is
    // the same call.
    sellerRef.revokeCapability(dealId);
    expect((await fetch(url)).status).toBe(404);
  });
});
