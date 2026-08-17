/**
 * The buyer driver (PLAN phase 4): a script, not a fourth agent.
 *
 * Walks the standalone flow against a RUNNING seller: query → quote →
 * contract construction → propose → countersign → delivery → verify →
 * report. Every hash and signature is checked, and "the buyer's whole
 * defence" is enforced end to end: the manifest against `deliveryHash`, the
 * CSV against the manifest's own hash, and byte-for-byte regeneration from
 * the published seed via a DIGEST-CHECKED verifier — code whose hash the
 * signed terms pinned, never an unverified download.
 *
 * The escrow `fund` step is deliberately absent (DESIGN §3): funding is an
 * external Passport MCP step performed by the buyer's owner. This driver
 * constructs and verifies the A2A-side artifacts only.
 *
 *   Terminal 1: npx tsx src/server.ts
 *   Terminal 2: npx tsx scripts/buyer.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_URI,
  NEGOTIATION_MEDIA_TYPE,
  coordinationEndpoint,
} from "../src/extension.js";
import {
  addressOfPrivateKey,
  fromHex,
  keyIdOf,
  sha256Ref,
  sign,
  termsHashOf,
  termsSigningBytes,
  verify,
} from "../src/signing.js";
import { TYPE_STRINGS, recoverStruct, signStruct } from "../src/settlement.js";
import { signDeliveryRequest } from "../src/extension.js";
import { parseAcceptanceCriteria, termsDocumentHashOf } from "../src/terms.js";
import { verifierBundleHash } from "../src/seller.js";
import { loadPlaces } from "../src/engine/places.js";
import { readQuery } from "../src/product.js";
import { DEMO_CHAIN_ID } from "../src/extension.js";

type Json = Record<string, any>;

const SELLER_URL = process.env["SELLER_URL"] ?? "http://localhost:9998";
const BUYER_DID = process.env["BUYER_AGENT_ID"] ?? "did:kite:acme:buyer-17";
const BUYER_KEY = fromHex(
  process.env["BUYER_PRIVATE_KEY"] ?? "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const QUERY = { columns: ["DIABETES", "BPHIGH"], states: ["CA"], counties: ["Alameda"] };

let step = 0;
const say = (line: string) => console.log(`  [${++step}] ${line}`);
const fail = (why: string): never => {
  console.error(`\nFAILED: ${why}`);
  process.exit(1);
};

/** One demo-private negotiation round trip over raw JSON-RPC. */
async function negotiate(payload: Json): Promise<Json> {
  const resp = await fetch(`${SELLER_URL}/a2a/v1`, {
    method: "POST",
    headers: { "content-type": "application/json", "A2A-Extensions": EXTENSION_URI, "A2A-Version": "1.0" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomBytes(6).toString("hex"),
      method: "SendMessage",
      params: {
        message: {
          messageId: randomBytes(8).toString("hex"),
          role: "ROLE_USER",
          parts: [
            { raw: Buffer.from(JSON.stringify(payload)).toString("base64"), mediaType: NEGOTIATION_MEDIA_TYPE },
          ],
          extensions: [EXTENSION_URI],
        },
      },
    }),
  });
  const body = (await resp.json()) as Json;
  if (body["error"]) fail(`seller answered a JSON-RPC error: ${JSON.stringify(body["error"])}`);
  const parts: Json[] = body["result"]?.["message"]?.["parts"] ?? [];
  const part = parts.find((p) => p["mediaType"] === NEGOTIATION_MEDIA_TYPE && p["raw"]);
  if (part === undefined) fail("seller reply carries no negotiation part");
  const reply = JSON.parse(Buffer.from(String(part!["raw"]), "base64").toString("utf8")) as Json;
  if (reply["kind"] === "error") fail(`seller refused: ${reply["error"]}`);
  return reply;
}

const buyerAddress = addressOfPrivateKey(BUYER_KEY);
console.log(`buyer ${BUYER_DID} (${buyerAddress}) → seller at ${SELLER_URL}\n`);

// ── 1. quote ────────────────────────────────────────────────────────────────
const quote = await negotiate({ kind: "query", buyerAgentId: BUYER_DID, body: QUERY });
const doc = quote["termsDocument"] as Json;
const sellerInfo = quote["seller"] as Json;
if (termsDocumentHashOf(doc as never) !== quote["termsDocumentHash"]) fail("terms document does not hash to its claim");
const commitment = parseAcceptanceCriteria(String(quote["acceptanceCriteria"]));
if (commitment?.termsDocumentHash !== quote["termsDocumentHash"]) fail("acceptanceCriteria does not pin the document");
say(
  `quoted: ${doc["totalRows"]} rows over ${doc["tractCount"]} tracts at ${doc["priceAmount"]} USDC ` +
    `(statsHash ${String(doc["statsHash"]).slice(0, 18)}…)`,
);

// The verifier the terms pin must be the verifier this checkout carries —
// checked BEFORE the contract is signed, and again before it executes.
if (verifierBundleHash() !== doc["verifierHash"]) {
  fail("the terms document pins a verifier this checkout does not carry — refusing to sign against unknown code");
}
say("verifier bundle digest matches the terms document's pin");

// ── 2. contract ─────────────────────────────────────────────────────────────
const contract: Json = {
  schema: "https://a2a.gokite.ai/schemas/deal-contract/v1",
  template: "fixed_outcome/v1",
  buyerAgentId: BUYER_DID,
  sellerAgentId: sellerInfo["sellerAgentId"],
  deliverable: `Synthetic individual-level CSV per the pinned terms document: ${doc["totalRows"]} rows over ${doc["tractCount"]} tracts.`,
  acceptanceCriteria: quote["acceptanceCriteria"],
  price: { amount: doc["priceAmount"], asset: "USDC" },
  escrow: { payoutAddress: sellerInfo["payoutAddress"] },
  disputePolicy: { arbiterAgentId: "did:kite:arbiterco:arbiter-01" },
  runtimeBinding: {
    runtimeAgentId: "did:kite:kite:coordination-engine",
    agentCardHash: "sha256:" + "aa".repeat(32), // standalone placeholder
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
say(`contract signed: termsHash ${termsHash.slice(0, 18)}…`);

// ── 3. propose ──────────────────────────────────────────────────────────────
const ack = await negotiate({
  kind: "submit-proposal",
  negotiationId: quote["negotiationId"],
  contract,
  buyerAddress,
});
if (ack["termsHash"] !== termsHash) fail("seller acked a different termsHash");
const dealId = String(ack["dealId"]);
say(`proposed: ${dealId}`);

// ── 4. countersign ──────────────────────────────────────────────────────────
const buyerAgreementSig = signStruct(
  BUYER_KEY,
  { name: "KiteFulfill", version: "1", chainId: DEMO_CHAIN_ID },
  TYPE_STRINGS.Agreement,
  {
    agreementId: dealId,
    termsHash,
    amount: String(doc["priceAmount"]),
    buyerAgent: buyerAddress,
    sellerAgent: sellerInfo["sellerAddress"],
  },
);
const acceptance = await negotiate({ kind: "acceptance-request", dealId, buyerAgreementSig });
const accepted = acceptance["contract"] as Json;
const signatures = accepted["signatures"] as Json[];
if (termsHashOf(accepted) !== termsHash) fail("accepted contract hashes differently");
if (!verify(String(signatures[1]!["sig"]), termsSigningBytes(termsHash), String(sellerInfo["sellerAddress"]))) {
  fail("seller's formation signature does not verify");
}
const sellerAgreementSigner = recoverStruct(
  String(signatures[1]!["agreementSig"]),
  { name: "KiteFulfill", version: "1", chainId: DEMO_CHAIN_ID },
  TYPE_STRINGS.Agreement,
  {
    agreementId: dealId,
    termsHash,
    amount: String(doc["priceAmount"]),
    buyerAgent: buyerAddress,
    sellerAgent: sellerInfo["sellerAddress"],
  },
);
if (sellerAgreementSigner !== String(sellerInfo["sellerAddress"]).toLowerCase()) {
  fail("seller's Agreement signature does not verify");
}
say("countersigned: both formation signatures and both Agreement signatures verify");
say("(external step, not this driver: the owner funds escrow via Passport MCP)");

// ── 5. delivery ─────────────────────────────────────────────────────────────
// The capability URLs go only to the buyer: prove it with a fresh signature
// over the deal id (demo-private; a deal id alone is not authorization).
const requestedAt = Math.floor(Date.now() / 1000);
const delivery = await negotiate({
  kind: "request-delivery",
  dealId,
  requestedAt,
  buyerSig: signDeliveryRequest(BUYER_KEY, dealId, requestedAt),
});
const manifestRes = await fetch(String(delivery["manifestUrl"]));
if (manifestRes.status !== 200) fail(`manifest fetch: HTTP ${manifestRes.status}`);
const manifestBytes = Buffer.from(await manifestRes.arrayBuffer());
if (sha256Ref(manifestBytes) !== String(delivery["deliveryHash"])) {
  fail("fetched manifest does not hash to deliveryHash — this is not the registered evidence");
}
const manifest = JSON.parse(manifestBytes.toString("utf8")) as Json;
say(`delivered: manifest verifies against deliveryHash ${String(delivery["deliveryHash"]).slice(0, 18)}…`);

const csvRes = await fetch(String(delivery["csvUrl"]));
const csv = Buffer.from(await csvRes.arrayBuffer());
if (`sha256:${createHash("sha256").update(csv).digest("hex")}` !== (manifest["artifact"] as Json)["contentHash"]) {
  fail("fetched CSV does not hash to the manifest's contentHash");
}
say(`CSV verifies against the manifest (${csv.length.toLocaleString()} bytes, ${manifest["rowCount"]} rows)`);

// ── 6. regenerate — the buyer's whole defence ───────────────────────────────
// Digest re-checked at the moment of execution, not only at signing.
if (verifierBundleHash() !== doc["verifierHash"]) fail("verifier bundle changed since signing");
const { verifyDelivery } = await import("../src/verifier.js");
const dir = mkdtempSync(join(tmpdir(), "buyer-"));
const csvPath = join(dir, "places.csv");
writeFileSync(
  csvPath,
  gunzipSync(readFileSync(fileURLToPath(new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url)))),
);
const corpus = await loadPlaces(csvPath);
const verdict = verifyDelivery({ manifest: manifest as never, received: csv, corpus, query: readQuery(QUERY) });
if (!verdict.ok) fail(`regeneration failed: ${verdict.problems.join("; ")}`);
say("regenerated byte-for-byte from the published seed — the delivery is what the manifest describes");

console.log(`\nOK: ${dealId} — quoted, signed, countersigned, delivered, verified.`);
console.log("Standalone boundary: the delivered command's settlement anchors are documented placeholders.");
