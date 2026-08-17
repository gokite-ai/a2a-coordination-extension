/**
 * The tamper matrix (DESIGN §4, PLAN phase 0.3).
 *
 * The review finding this answers: §4.1's termsHash covers the CONTRACT and
 * nothing else, so an external terms document is outside every signature
 * unless the contract's own text commits to it. The chain under test:
 *
 *   signatures → termsHash → contract → acceptanceCriteria
 *              → termsDocumentHash → terms document
 *
 * Every leaf field of the terms document is mutated, one at a time, and each
 * mutation must (a) change termsDocumentHash, (b) therefore change the
 * contract and its termsHash, and (c) therefore make verification against
 * the original formation signatures fail. Separately, a mutated document
 * handed out-of-band against the ORIGINAL signed contract must fail the
 * commitment check — swapping the document without re-signing is detectable,
 * which is the whole point.
 */
import { describe, expect, it } from "vitest";
import { fromHex, termsHashOf, termsSigningBytes, sign, verify, addressOfPrivateKey } from "../src/signing.js";
import {
  buildAcceptanceCriteria,
  parseAcceptanceCriteria,
  termsDocumentHashOf,
  termsDocumentMatchesContract,
  type TermsDocument,
} from "../src/terms.js";

// Throwaway test keys, same convention as the published fixture keys.
const BUYER_KEY = fromHex("0x1111111111111111111111111111111111111111111111111111111111111111");
const SELLER_KEY = fromHex("0x2222222222222222222222222222222222222222222222222222222222222222");

const doc: TermsDocument = {
  format: "kite-example-data-deal-terms/v1",
  criteriaHash: "sha256:4d0e4d24e5e3b8bfe4f0e0a7f9a8c1d2e3f405162738495a6b7c8d9eaf01b2c3",
  statsHash: "sha256:9a8b7c6d5e4f30211203f4e5d6c7b8a99887766554433221100ffeeddccbbaa0",
  rowsPerTract: 2,
  totalRows: 1000,
  tractCount: 362,
  perTractStandardErrorPp: 23.0,
  method: "stratified-marginal-bernoulli/v2",
  seedDisclosure: "seed published in the delivery manifest",
  generatorVersion: "synth-2.0.0",
  corpusHash: "sha256:aabbccddeeff00112233445566778899aabbccddeeff001122334455667788aa",
  verifierHash: "sha256:1122334455667788991122334455667788991122334455667788991122334455",
  usage: {
    resale: false,
    retentionDays: 365,
    prohibitedUse:
      "not for clinical, epidemiological, eligibility, or policy decisions about any real person",
    limitations: [
      "marginal prevalences are reproduced; the joint distribution is not",
      "per-tract resolution is a function of rows per tract",
    ],
  },
  artifactAvailability: "served until 14 days after settlement; demo-grade, process-local storage",
  priceBreakdownCents: { base: 500, tracts: 72, standardColumns: 10000, premiumColumns: 24000, subtotal: 34572 },
  priceAmount: "345.72",
};

/** A contract in the published fixture shape, carrying the inner commitment. */
function contractFor(d: TermsDocument): Record<string, unknown> {
  return {
    schema: "https://a2a.gokite.ai/schemas/deal-contract/v1",
    template: "fixed_outcome/v1",
    buyerAgentId: "did:kite:acme:buyer-17",
    sellerAgentId: "did:kite:corp-kite:example-data-seller-agent",
    deliverable:
      "Synthetic individual-level CSV over CDC PLACES 2025: one row per synthetic person, per-measure flags, guaranteed rows per purchased tract.",
    acceptanceCriteria: buildAcceptanceCriteria(termsDocumentHashOf(d), "http://localhost:9998"),
    price: { amount: d.priceAmount, asset: "USDC" },
    escrow: { payoutAddress: "0x3333333333333333333333333333333333333333" },
    disputePolicy: { arbiterAgentId: "did:kite:arbiterco:arbiter-01" },
    runtimeBinding: {
      runtimeAgentId: "did:kite:kite:coordination-engine",
      agentCardHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      extensionUri: "https://a2a.gokite.ai/extensions/coordination-workflow/v1",
      endpoint: "https://passport.dev.gokite.ai/a2a/v1",
    },
  };
}

/** Every leaf path of a JSON object, as ["usage","limitations",0]-style arrays. */
function leafPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leafPaths(v, [...prefix, i]));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
  return [prefix];
}

/** Structured clone with one leaf mutated to a same-type different value. */
function mutateAt(docIn: TermsDocument, path: (string | number)[]): TermsDocument {
  const copy = structuredClone(docIn) as any;
  let node = copy;
  for (const step of path.slice(0, -1)) node = node[step];
  const leaf = path[path.length - 1]!;
  const value = node[leaf];
  if (typeof value === "string") node[leaf] = value + " (tampered)";
  else if (typeof value === "number") node[leaf] = value + 1;
  else if (typeof value === "boolean") node[leaf] = !value;
  else throw new Error(`unmutatable leaf at ${path.join(".")}`);
  return copy as TermsDocument;
}

describe("terms-document commitment chain", () => {
  const contract = contractFor(doc);
  const termsHash = termsHashOf(contract);
  const buyerSig = sign(BUYER_KEY, termsSigningBytes(termsHash));
  const sellerSig = sign(SELLER_KEY, termsSigningBytes(termsHash));
  const buyerAddress = addressOfPrivateKey(BUYER_KEY);
  const sellerAddress = addressOfPrivateKey(SELLER_KEY);

  it("the untampered chain verifies end to end", () => {
    expect(termsDocumentMatchesContract(doc, contract as any)).toBe(true);
    expect(verify(buyerSig, termsSigningBytes(termsHash), buyerAddress)).toBe(true);
    expect(verify(sellerSig, termsSigningBytes(termsHash), sellerAddress)).toBe(true);
  });

  it("acceptanceCriteria round-trips the commitment", () => {
    const parsed = parseAcceptanceCriteria(contract["acceptanceCriteria"] as string);
    expect(parsed).not.toBeNull();
    expect(parsed!.termsDocumentHash).toEqual(termsDocumentHashOf(doc));
    expect(parsed!.locator).toContain(parsed!.termsDocumentHash);
  });

  it("an acceptanceCriteria with no commitment parses to null", () => {
    expect(parseAcceptanceCriteria("it is a haiku")).toBeNull();
  });

  const paths = leafPaths(doc);

  it("the matrix actually covers the document", () => {
    // Every declared member reaches the matrix — a field added to
    // TermsDocument without a mutable leaf would silently escape it.
    expect(paths.length).toBeGreaterThanOrEqual(20);
  });

  for (const path of paths) {
    const label = path.join(".");
    it(`tampering "${label}" breaks the chain`, () => {
      const tampered = mutateAt(doc, path);

      // (a) the inner commitment moves…
      const tamperedDocHash = termsDocumentHashOf(tampered);
      expect(tamperedDocHash).not.toEqual(termsDocumentHashOf(doc));

      // …so a swapped document fails against the ORIGINAL signed contract.
      expect(termsDocumentMatchesContract(tampered, contract as any)).toBe(false);

      // (b) re-embedding honestly yields a DIFFERENT contract and termsHash —
      // a new proposal under §4.1, never a silent amendment…
      const tamperedContract = contractFor(tampered);
      const tamperedTermsHash = termsHashOf(tamperedContract);
      expect(tamperedTermsHash).not.toEqual(termsHash);

      // …(c) against which the original formation signatures no longer verify.
      expect(verify(buyerSig, termsSigningBytes(tamperedTermsHash), buyerAddress)).toBe(false);
      expect(verify(sellerSig, termsSigningBytes(tamperedTermsHash), sellerAddress)).toBe(false);
    });
  }
});
