/**
 * Public golden product fixtures (DESIGN §7, PLAN phase 1).
 *
 * `fixtures/golden/*.json` pins query rejection details, tract counts, price
 * breakdowns, sample rows, statsHash, and delivery-manifest business fields
 * for the bundled corpus, queries, and seeds. Any intentional compatibility
 * change must update these fixtures visibly.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaces, type Corpus } from "../src/engine/places.js";
import { generateDelivery } from "../src/engine/deliver.js";
import { MemoryArtifactStore } from "../src/engine/store.js";
import { composeQuote, type QuoteFacts } from "../src/product.js";

const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;

// The demo card's published figures.
const RATE_CARD = {
  baseCents: 500,
  perTractMicroCents: 200,
  perStandardColumnCents: 5000,
  perPremiumColumnCents: 12000,
  vintageMultiplierBps: 10000,
};
const DENSITY = { rowsPerTractDefault: 25, rowsPerTractMin: 1, rowsPerTractMax: 100 };

let corpusPromise: Promise<{ corpus: Corpus; cleanup: () => void }> | undefined;
const fixtureCorpus = () =>
  (corpusPromise ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    const csv = join(dir, "places.csv");
    writeFileSync(csv, gunzipSync(readFileSync(join(FIXTURES, "places-ca-ny.csv.gz"))));
    return { corpus: await loadPlaces(csv), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  })());

interface GoldenQuotes {
  fixtureVersion: string;
  quotes: Record<string, { query: unknown; facts: Record<string, any> }>;
}

describe("golden product fixtures: quotes", () => {
  const golden = JSON.parse(readFileSync(join(FIXTURES, "golden", "quotes.json"), "utf8")) as GoldenQuotes;

  it("goldens carry the public fixture version", () => {
    expect(golden.fixtureVersion).toBe("v1");
  });

  for (const [name, entry] of Object.entries(golden.quotes)) {
    it(name, async () => {
      const { corpus } = await fixtureCorpus();
      const facts: QuoteFacts = composeQuote({
        corpus,
        body: entry.query,
        rateCard: RATE_CARD,
        density: DENSITY,
      });
      const want = entry.facts;

      expect(facts.accepted).toBe(want["accepted"]);
      if (!facts.accepted) {
        // Codes AND messages: a buyer branches on the code but reads the message.
        expect(facts.rejections).toEqual(want["rejections"]);
        return;
      }

      expect(facts.tractCount).toBe(want["units"]);
      expect(facts.deliverableRowCount).toBe(want["deliverableRowCount"]);
      if (want["statsHash"] !== undefined) expect(facts.statsHash).toBe(want["statsHash"]);
      expect(facts.summary).toBe(want["summary"]);

      // The whole body, field for field, excluding non-contractual prose.
      const { note: _ours, ...body } = facts.body as unknown as Record<string, unknown>;
      const { note: _theirs, ...wantBody } = want["body"] as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(body))).toEqual(wantBody);
    });
  }
});

describe("golden product fixtures: delivery manifest", () => {
  const golden = JSON.parse(readFileSync(join(FIXTURES, "golden", "manifest.json"), "utf8")) as Record<
    string,
    any
  >;

  it("reproduces every pinned business field of the manifest", async () => {
    const { corpus } = await fixtureCorpus();
    const out = await generateDelivery({
      dealId: "deal_golden",
      productId: "cdc-places-2025-synthetic-individuals",
      query: golden["query"],
      corpus,
      rowsPerTract: golden["rowsPerTract"],
      seed: golden["seed"],
      storage: new MemoryArtifactStore(),
      quotedStatsHash: golden["quotedStatsHash"],
      now: () => "2026-08-12T00:00:00.000Z",
    });

    const m = out.manifest;
    const want = golden["manifest"];
    expect({
      dealId: m.dealId,
      productId: m.productId,
      criteria: m.criteria,
      criteriaHash: m.criteriaHash,
      sourceStatsHash: m.sourceStatsHash,
      quotedStatsHash: m.quotedStatsHash,
      statsMatchQuote: m.statsMatchQuote,
      rowCount: m.rowCount,
      density: JSON.parse(JSON.stringify(m.density)),
      columns: m.columns,
      header: m.header,
      seed: m.seed,
      generator: m.generator,
      calibration: JSON.parse(JSON.stringify(m.calibration)),
      calibrated: m.calibrated,
      artifactContentHash: m.artifact.contentHash,
      artifactBytes: m.artifact.bytes,
      generatedAt: m.generatedAt,
    }).toEqual(want);
  }, 60_000);
});
