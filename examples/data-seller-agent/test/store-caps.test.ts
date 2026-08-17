/**
 * The in-memory stores must stay bounded against traffic that costs the
 * counterparty nothing: /query mints quotes, submit-proposal mints deals, and
 * a proposal PINS its quote — so a query+propose loop must not grow either
 * map without bound (the quote-only cap alone was bypassable exactly that
 * way). Deals a Runtime reports as COMMITTED or later are the ones the buyer
 * paid for; they and the quotes they resolve through survive every prune.
 */
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { DataSeller } from "../src/seller.js";
import { fromHex } from "../src/signing.js";

type Json = Record<string, unknown>;

const SELLER_KEY = fromHex("0x" + "5a".repeat(32));
const BUYER = "0x" + "22".repeat(20);
const BUYER_DID = "did:kite:acme:buyer-17";

function newSeller(): DataSeller {
  return new DataSeller({
    privateKey: SELLER_KEY,
    publicUrl: "http://127.0.0.1:0",
    corpusPath: fileURLToPath(new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url)),
    seedSecret: "store-caps-test",
  });
}

function proposalFor(
  seller: DataSeller,
  body: Json,
): { contract: Json; negotiationId: string; termsDocumentHash: string } {
  const { facts, record } = seller.quote(BUYER_DID, body);
  if (record === undefined) throw new Error(`quote refused: ${JSON.stringify(facts)}`);
  return {
    contract: {
      buyerAgentId: BUYER_DID,
      acceptanceCriteria: seller.acceptanceCriteriaFor(record),
    },
    negotiationId: record.negotiationId,
    termsDocumentHash: record.termsDocumentHash,
  };
}

describe("store caps under uncommitted traffic", () => {
  let seller: DataSeller;

  beforeAll(async () => {
    seller = newSeller();
    await seller.boot();
  });

  it("bounds deals when one quote is proposed past the cap, keeping committed deals", () => {
    const { contract, negotiationId } = proposalFor(seller, {
      columns: ["DIABETES"],
      states: ["CA"],
      counties: ["Alameda"],
    });

    // The buyer pays for this one: a Runtime confirmed the commitment.
    const committed = seller.propose(negotiationId, contract, BUYER);
    seller.observeRuntimeStatus(committed.dealId, { state: "COMMITTED", revision: 1 });

    let last = "";
    for (let i = 0; i < 1200; i++) last = seller.propose(negotiationId, contract, BUYER).dealId;

    // 1024 reclaimable plus the one COMMITTED survivor.
    expect(seller.storeSizes().deals).toBeLessThanOrEqual(1024 + 1);
    expect(seller.deal(committed.dealId)).toBeDefined();
    expect(seller.deal(last)).toBeDefined();
  });

  it("reclaims formation deals past their TTL", () => {
    const { contract, negotiationId } = proposalFor(seller, {
      columns: ["BPHIGH"],
      states: ["CA"],
      counties: ["Alameda"],
    });
    const stale = seller.propose(negotiationId, contract, BUYER);
    stale.updatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    seller.propose(negotiationId, contract, BUYER); // any proposal sweeps
    expect(seller.deal(stale.dealId)).toBeUndefined();
  });

  it("bounds negotiation, quote, and deal stores when every quote is pinned", () => {
    const fresh = newSeller();
    // boot() already ran on the shared instance; this one needs its own corpus.
    return fresh.boot().then(() => {
      // County PAIRS give >1600 distinct criteria hashes from the fixture
      // corpus — enough to push the negotiation, quote, and deal stores past
      // their 1024 caps with every quote pinned by its own proposal.
      const counties = [...(fresh.corpus.counties.get("CA") ?? [])];
      let minted = 0;
      outer: for (let i = 0; i < counties.length; i++) {
        for (let j = i + 1; j < counties.length; j++) {
          const body = {
            columns: ["DIABETES"],
            states: ["CA"],
            counties: [counties[i], counties[j]],
          };
          const { record } = fresh.quote(BUYER_DID, body);
          if (record === undefined) continue; // slice too small for this pair
          fresh.propose(
            record.negotiationId,
            {
              buyerAgentId: BUYER_DID,
              acceptanceCriteria: fresh.acceptanceCriteriaFor(record),
            },
            BUYER,
          );
          minted++;
          if (minted >= 1100) break outer;
        }
      }
      expect(minted).toBeGreaterThan(1024);
      const sizes = fresh.storeSizes();
      expect(sizes.deals).toBeLessThanOrEqual(1024);
      expect(sizes.negotiations).toBeLessThanOrEqual(1024 + 8);
      // Negotiations and accepted quotes pinned by live deals survive the
      // negotiation cap, and the freshest negotiation is protected until its
      // proposal arrives — so the bound includes a small in-flight margin.
      expect(sizes.quotes).toBeLessThanOrEqual(1024 + 8);
    });
  });

  it("keeps identical quotes buyer-scoped and refuses cross-buyer proposal linkage", () => {
    const body = { columns: ["DIABETES"], states: ["CA"], counties: ["Alameda"] };
    const first = seller.quote(BUYER_DID, body).record!;
    const otherDid = "did:kite:other:buyer-18";
    const second = seller.quote(otherDid, body).record!;

    expect(first.termsDocumentHash).toBe(second.termsDocumentHash);
    expect(first.negotiationId).not.toBe(second.negotiationId);
    expect(() =>
      seller.propose(
        first.negotiationId,
        { buyerAgentId: otherDid, acceptanceCriteria: seller.acceptanceCriteriaFor(first) },
        BUYER,
      ),
    ).toThrow(/buyerAgentId does not match negotiation/);

    const linked = seller.propose(
      second.negotiationId,
      { buyerAgentId: otherDid, acceptanceCriteria: seller.acceptanceCriteriaFor(second) },
      BUYER,
    );
    expect(linked.negotiationId).toBe(second.negotiationId);
  });
});
