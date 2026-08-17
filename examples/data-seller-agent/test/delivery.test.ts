/**
 * Delivery correctness.
 *
 * The load-bearing properties are reproducibility and refusal. A buyer must be
 * able to regenerate the file from the published seed and obtain identical
 * bytes, so determinism is a correctness property. Every path that could
 * deliver content different from the signed terms must refuse instead.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  uniform,
  generateSyntheticPeople,
  serializeCsv,
  calibrate,
  isCalibrated,
  deliverableHeader,
  calibrationTolerancePp,
  allocateRows,
  perTractPrecisionPp,
} from "../src/engine/synth.js";
import {
  generateDelivery,
  verifyDelivery,
  deliverableSeed,
  type DeliveryManifest,
} from "../src/engine/deliver.js";
import { MemoryArtifactStore } from "../src/engine/store.js";
import { composeQuote } from "../src/product.js";
import { loadPlaces, type Corpus, MEASURE_KEYS } from "../src/engine/places.js";

// A small corpus with fractional prevalences and varied populations, so weighting and calibration are
// both exercised.
const MINI = (() => {
  const dir = mkdtempSync(join(tmpdir(), "deliv-"));
  const p = join(dir, "mini.csv");
  const header = [
    "StateAbbr", "StateDesc", "CountyName", "CountyFIPS", "TractFIPS", "TotalPopulation", "TotalPop18plus",
    ...MEASURE_KEYS.map((m) => `${m}_CrudePrev`),
  ];
  const row = (t: string, pop: number, adults: number, vals: number[]): string =>
    ["CA", "California", "Alameda", "06001", t, String(pop), String(adults), ...vals.map(String)]
      .map((c) => `"${c}"`)
      .join(",");
  writeFileSync(
    p,
    [
      header.map((h) => `"${h}"`).join(","),
      row("06001000100", 5000, 3800, [11.2, 30.1, 6.2, 20.4, 25.5, 12.6, 15.7, 35.8]),
      row("06001000200", 9000, 7100, [9.4, 28.2, 5.3, 18.4, 22.5, 11.6, 14.7, 33.8]),
      row("06001000300", 2500, 1900, [13.8, 32.8, 7.7, 22.6, 27.5, 13.4, 16.3, 37.2]),
    ].join("\n") + "\n",
  );
  return p;
})();

const QUERY = { columns: ["DIABETES", "BPHIGH"], states: ["CA"] };
const memoryStorage = () => new MemoryArtifactStore();

describe("the generator is reproducible", () => {
  it("uses the published counter-based PRNG exactly", () => {
    // Recomputed independently. If this drifts, every buyer's regeneration fails and the seller cannot
    // prove delivery — so it is pinned rather than trusted.
    const expected = createHash("sha256").update("s|500|DIABETES").digest().readUIntBE(0, 6) / 2 ** 48;
    expect(uniform("s", 500, "DIABETES")).toBe(expected);
  });

  it("is addressable per draw: one row's flag does not depend on how many drew before it", () => {
    // The property that lets a column be added without shifting every later value.
    const a = uniform("seed", 7, "DIABETES");
    const b = uniform("seed", 7, "DIABETES");
    expect(a).toBe(b);
    expect(uniform("seed", 7, "BPHIGH")).not.toBe(a);
  });

  it("produces byte-identical output for the same seed", async () => {
    const corpus = await loadPlaces(MINI);
    const opts = { rowCount: 200, seed: "abc", columns: QUERY.columns };
    const one = serializeCsv(generateSyntheticPeople(corpus.tracts, opts), QUERY.columns);
    const two = serializeCsv(generateSyntheticPeople(corpus.tracts, opts), QUERY.columns);
    expect(one.equals(two)).toBe(true);
  });

  it("produces different output for a different seed", async () => {
    const corpus = await loadPlaces(MINI);
    const a = serializeCsv(generateSyntheticPeople(corpus.tracts, { rowCount: 200, seed: "a", columns: QUERY.columns }), QUERY.columns);
    const b = serializeCsv(generateSyntheticPeople(corpus.tracts, { rowCount: 200, seed: "b", columns: QUERY.columns }), QUERY.columns);
    expect(a.equals(b)).toBe(false);
  });

  it("labels every row synthetic and emits only purchased columns", async () => {
    const corpus = await loadPlaces(MINI);
    const csv = serializeCsv(
      generateSyntheticPeople(corpus.tracts, { rowCount: 20, seed: "s", columns: ["DIABETES"] }),
      ["DIABETES"],
    ).toString("utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(deliverableHeader(["DIABETES"]).join(","));
    expect(lines[0]).toContain("has_diabetes");
    expect(lines[0]).not.toContain("has_high_bp");
    for (const l of lines.slice(1)) expect(l.endsWith(",true")).toBe(true);
  });

  it("keeps ACCESS2 at zero for 65+ rows, because its denominator is 18-64", async () => {
    const corpus = await loadPlaces(MINI);
    const people = generateSyntheticPeople(corpus.tracts, { rowCount: 500, seed: "s", columns: ["ACCESS2"] });
    const olds = people.filter((p) => p.ageBand === "65+");
    expect(olds.length).toBeGreaterThan(0);
    // Definitively 0, not a draw: 65+ are near-universally Medicare-covered and outside the measure.
    for (const p of olds) expect(p.flags.ACCESS2).toBe(0);
  });

  it("reproduces the marginals it claims to, within sampling tolerance", async () => {
    const corpus = await loadPlaces(MINI);
    const people = generateSyntheticPeople(corpus.tracts, { rowCount: 4000, seed: "cal", columns: QUERY.columns });
    const cal = calibrate({ people, tracts: corpus.tracts, columns: QUERY.columns });
    expect(isCalibrated(cal)).toBe(true);
    for (const c of cal) {
      expect(Math.abs(c.realizedPercent - c.targetPercent), c.measure).toBeLessThanOrEqual(c.tolerancePp);
    }
  });

  it("scales the tolerance with row count rather than fixing it", () => {
    // A fixed tolerance would either fail correct files at low N or pass broken ones at high N.
    expect(calibrationTolerancePp(10, 100)).toBeGreaterThan(calibrationTolerancePp(10, 10_000));
  });

  it("derives a seed that is not computable from the deal id alone", () => {
    // A secret-free derivation such as `${dealId}:v1` would let anyone holding the deal id generate the
    // paid file before paying for it. The property that matters is that the secret is load-bearing.
    const a = deliverableSeed({ secret: "s1", dealId: "deal_1" });
    const b = deliverableSeed({ secret: "s2", dealId: "deal_1" });
    expect(a).not.toBe(b);
    // And it is not any of the obvious secret-free constructions.
    expect(a).not.toBe("deal_1");
    expect(a).not.toBe(createHash("sha256").update("deal_1:v1").digest("hex"));
    expect(a).not.toBe(createHash("sha256").update("deal_1").digest("hex"));
    // Stable for the same inputs, or a buyer could never re-derive.
    expect(a).toBe(deliverableSeed({ secret: "s1", dealId: "deal_1" }));
  });
});

describe("delivery refuses rather than substituting", () => {
  const now = () => "2026-08-05T12:00:00.000Z";

  it("generates, stores and describes a delivery a buyer can verify", async () => {
    const corpus = await loadPlaces(MINI);
    const out = await generateDelivery({
      dealId: "d1",
      productId: "p",
      query: QUERY,
      corpus,
      rowsPerTract: 2,
      seed: "seed-1",
      storage: memoryStorage(),
      now,
    });
    // Derived, not passed: the density times the matched tract count. That coupling is the fix — a free-floating
    // row count is how a 7,917-tract purchase came to be delivered as 1,000 rows.
    expect(out.manifest.rowCount).toBe(2 * corpus.tracts.length);
    expect(out.manifest.density?.rowsPerTract).toBe(2);
    expect(out.manifest.density?.tractsWithRows).toBe(corpus.tracts.length);
    expect(out.manifest.artifact.contentHash).toBe(`sha256:${createHash("sha256").update(out.bytes).digest("hex")}`);
    expect(out.manifest.calibrated).toBe(true);
    // The manifest must carry the seed — that is what makes the delivery checkable.
    expect(out.manifest.seed).toBe("seed-1");

    const verdict = verifyDelivery({ manifest: out.manifest, received: out.bytes, corpus, query: QUERY });
    expect(verdict.ok, verdict.problems.join("; ")).toBe(true);
    expect(verdict.regeneratedHash).toBe(out.manifest.artifact.contentHash);
  });

  it("carries no pricing block because signed terms own pricing", async () => {
    const corpus = await loadPlaces(MINI);
    const out = await generateDelivery({
      dealId: "d1", productId: "p", query: QUERY, corpus, rowsPerTract: 2, seed: "s", storage: memoryStorage(), now,
    });
    expect(out.manifest).not.toHaveProperty("price");
    expect(out.manifest).not.toHaveProperty("pricing");
  });

  it("refuses when the slice no longer matches the quoted statsHash", async () => {
    const corpus = await loadPlaces(MINI);
    await expect(
      generateDelivery({
        dealId: "d1", productId: "p", query: QUERY, corpus, rowsPerTract: 2, seed: "s",
        storage: memoryStorage(), quotedStatsHash: "sha256:something-else", now,
      }),
    ).rejects.toThrow(/slice has changed since the quote/);
  });

  it("refuses an empty slice — there is nothing to deliver", async () => {
    const corpus = await loadPlaces(MINI);
    await expect(
      generateDelivery({
        dealId: "d1", productId: "p", query: { columns: ["DIABETES"], states: ["XX"] }, corpus,
        rowsPerTract: 2, seed: "s", storage: memoryStorage(), now,
      }),
    ).rejects.toThrow(/matches no tracts/);
  });

  it("fails verification when the bytes do not match the manifest", async () => {
    const corpus = await loadPlaces(MINI);
    const out = await generateDelivery({
      dealId: "d1", productId: "p", query: QUERY, corpus, rowsPerTract: 2, seed: "s", storage: memoryStorage(), now,
    });
    const tampered = Buffer.concat([out.bytes, Buffer.from("syn_000101,extra\n")]);
    const verdict = verifyDelivery({ manifest: out.manifest, received: tampered, corpus, query: QUERY });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/received bytes hash/);
  });

  it("rejects an unsupported generator version before regeneration", async () => {
    const corpus = await loadPlaces(MINI);
    const out = await generateDelivery({
      dealId: "d1", productId: "p", query: QUERY, corpus, rowsPerTract: 2, seed: "s", storage: memoryStorage(), now,
    });
    const unsupported = {
      ...out.manifest,
      rowCount: 1_000_000,
      generator: { ...out.manifest.generator, algorithm: "stratified-marginal-bernoulli/v3" },
    };
    const verdict = verifyDelivery({ manifest: unsupported, received: out.bytes, corpus, query: QUERY });
    expect(verdict.ok).toBe(false);
    expect(verdict.regeneratedHash).toBeNull();
    expect(verdict.problems.join(" ")).toMatch(/unsupported generator algorithm/);
  });

  it("rejects malformed v2 density before regeneration", async () => {
    const corpus = await loadPlaces(MINI);
    const out = await generateDelivery({
      dealId: "d1", productId: "p", query: QUERY, corpus, rowsPerTract: 2, seed: "s", storage: memoryStorage(), now,
    });
    const invalidDensities: unknown[] = [
      null,
      { ...out.manifest.density, rowsPerTract: 0 },
      { ...out.manifest.density, rowsPerTract: 1.5 },
      { ...out.manifest.density, rowsPerTract: Number.POSITIVE_INFINITY },
    ];
    for (const density of invalidDensities) {
      const malformed = { ...out.manifest, density } as unknown as DeliveryManifest;
      const verdict = verifyDelivery({ manifest: malformed, received: out.bytes, corpus, query: QUERY });
      expect(verdict.ok).toBe(false);
      expect(verdict.regeneratedHash).toBeNull();
      expect(verdict.problems.join(" ")).toMatch(/density\.rowsPerTract/);
    }
  });

  it("catches a manifest whose seed does not produce the attested file", async () => {
    const corpus = await loadPlaces(MINI);
    const out = await generateDelivery({
      dealId: "d1", productId: "p", query: QUERY, corpus, rowsPerTract: 2, seed: "s", storage: memoryStorage(), now,
    });
    // The substitution a dishonest seller would attempt: real bytes, a seed that does not generate them.
    const lying = { ...out.manifest, seed: "not-the-seed" };
    const verdict = verifyDelivery({ manifest: lying, received: out.bytes, corpus, query: QUERY });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/regenerating from the published seed/);
  });
});

/**
 * This round trip verifies the seller-side engine directly. Runtime lifecycle,
 * escrow execution, and capability revocation are covered by the live-mode
 * suite; this block owns the buyer-visible artifact and manifest guarantees.
 */
describe("delivery round trip", () => {
  it("produces a delivery the buyer can verify end to end", async () => {
    const corpus = await loadPlaces(MINI);
    const out = await generateDelivery({
      dealId: "d1",
      productId: "p",
      query: QUERY,
      corpus,
      rowsPerTract: 2,
      seed: deliverableSeed({ secret: "secret", dealId: "d1" }),
      storage: memoryStorage(),
      now: () => new Date().toISOString(),
    });
    const manifest = out.manifest;
    // Regenerate from the manifest alone — the buyer's actual check.
    const verdict = verifyDelivery({
      manifest,
      received: serializeCsv(
        generateSyntheticPeople(
          (await import("../src/engine/places.js")).evaluateQuery(QUERY, corpus).tracts,
          {
            rowCount: manifest.rowCount,
            // The buyer must regenerate at the density the manifest publishes; without it the rows land in
            // different tracts and the file will not reproduce. That is the check working, not failing.
            rowsPerTract: manifest.density?.rowsPerTract,
            seed: manifest.seed,
            columns: manifest.columns,
          },
        ),
        manifest.columns,
      ),
      corpus,
      query: QUERY,
    });
    expect(verdict.ok, verdict.problems.join("; ")).toBe(true);
  });
});

describe("density is a promise, not a probability", () => {
  it("gives every tract its floor, and sums to the derived row count", async () => {
    const corpus = await loadPlaces(MINI);
    const alloc = allocateRows(corpus.tracts, 4);
    expect(alloc.length).toBe(corpus.tracts.length);
    expect(Math.min(...alloc)).toBeGreaterThanOrEqual(4);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(4 * corpus.tracts.length);
  });

  it("puts a remainder on the largest tracts, deterministically", async () => {
    const corpus = await loadPlaces(MINI);
    const a = allocateRows(corpus.tracts, 2, 2 * corpus.tracts.length + 1);
    const b = allocateRows(corpus.tracts, 2, 2 * corpus.tracts.length + 1);
    expect(a).toEqual(b);
    expect(a.reduce((x, y) => x + y, 0)).toBe(2 * corpus.tracts.length + 1);
  });

  it("refuses a total that cannot honour the floor, rather than quietly thinning it", async () => {
    const corpus = await loadPlaces(MINI);
    expect(() => allocateRows(corpus.tracts, 5, 4)).toThrow(/floor is a promise/);
    expect(() => allocateRows(corpus.tracts, 0)).toThrow(/at least 1/);
  });

  it("caps the row count where the id would stop sorting as it claims", async () => {
    const corpus = await loadPlaces(MINI);
    expect(() => allocateRows(corpus.tracts, 1, 1_000_000)).toThrow(/exceeds the 999,999/);
  });

  it("represents every purchased tract", async () => {
    const corpus = await loadPlaces(MINI);
    // With a per-tract floor, "every tract you paid for is in the file" is checkable.
    const people = generateSyntheticPeople(corpus.tracts, {
      rowCount: 3 * corpus.tracts.length,
      rowsPerTract: 3,
      seed: "s",
      columns: ["DIABETES"],
    });
    const counts = new Map<string, number>();
    for (const person of people) counts.set(person.sourceTractFIPS, (counts.get(person.sourceTractFIPS) ?? 0) + 1);
    expect(counts.size).toBe(corpus.tracts.length);
    expect(Math.min(...counts.values())).toBe(3);
  });

  it("states the per-tract precision rather than an adjective", () => {
    // The card publishes a numeric precision bound rather than a qualitative claim.
    expect(perTractPrecisionPp(12, 1)).toBeCloseTo(32.5, 1);
    expect(perTractPrecisionPp(12, 25)).toBeCloseTo(6.5, 1);
    // Nothing this product offers makes a single tract's rate precise, which is why the card says so.
    expect(perTractPrecisionPp(12, 100)).toBeGreaterThan(3);
  });

  it("targets the marginal the allocation implies, not the population-weighted one", async () => {
    const corpus = await loadPlaces(MINI);
    const people = generateSyntheticPeople(corpus.tracts, {
      rowCount: 50 * corpus.tracts.length,
      rowsPerTract: 50,
      seed: "s",
      columns: ["DIABETES"],
    });
    const cal = calibrate({ people, tracts: corpus.tracts, columns: ["DIABETES"] });
    // Equal rows per tract means an unweighted mean of the tract prevalences.
    const unweighted =
      corpus.tracts.reduce((sum, t) => sum + (t.values.DIABETES ?? 0), 0) / corpus.tracts.length;
    expect(cal[0]?.targetPercent).toBeCloseTo(unweighted, 2);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * THE DELIVERABLE IS BYTE-STABLE — golden values, pinned inputs
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE DEMO CANNOT DO THIS JOB. Its `contentHash` looks like a golden value and is not:
 * `seed = sha256(seller-seed-secret | dealId | v2)`, the secret is 32 random bytes minted per keystore,
 * `--fresh` wipes the keystore, and the deal id is derived from the wall clock. Two identical runs deliver
 * different bytes. So every input is pinned here, the seed included.
 *
 * WHY THE STORAGE IS PINNED TOO: `manifestHash` covers `manifest.artifact`, and that includes the `locator`.
 * A test using a temp directory would hash the temp directory's name and pass only until it changed.
 *
 * If you changed the engine on purpose, these values move — and the diff on this file is then the record of
 * what every already-anchored delivery would no longer verify against.
 */
describe("the deliverable is byte-stable", () => {
  /** A stable public fixture slice: real CA tracts, two measures, a threshold. */
  const E2E_QUERY = {
    columns: ["DIABETES", "BPHIGH"],
    states: ["CA"],
    minPopulation: 2000,
    thresholds: { DIABETES: { min: 8 } },
  };
  /** Fixed, unlike a real deal's. This is the whole point. */
  const SEED = createHash("sha256").update("equivalence-fixture|deal_fixed|v2").digest("hex");
  const FIXTURE = new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url).pathname;
  /** The demo card's published figures, inlined until this example's own card exists (phase 2). */
  const RATE_CARD = {
    baseCents: 500,
    perTractMicroCents: 200,
    perStandardColumnCents: 5000,
    perPremiumColumnCents: 12000,
    vintageMultiplierBps: 10000,
  };
  const DENSITY = { rowsPerTractDefault: 25, rowsPerTractMin: 1, rowsPerTractMax: 100 };

  const loadFixtureCorpus = async () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    const csv = join(dir, "places.csv");
    writeFileSync(csv, gunzipSync(readFileSync(FIXTURE)));
    const corpus = await loadPlaces(csv);
    return { corpus, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it("reproduces the golden artifact for the fixture corpus, query and fixed seed", async () => {
    const { corpus, cleanup } = await loadFixtureCorpus();

    // The inputs, asserted BEFORE the hashes. A figure that changed fails on the figure rather than on
    // an opaque hash mismatch, which is the difference between a test that reports a bug and one that
    // reports a puzzle.
    expect(corpus.totals.tracts, "fixture corpus size").toBe(14359);
    const facts = composeQuote({ corpus, body: E2E_QUERY, rateCard: RATE_CARD, density: DENSITY });
    expect(facts.accepted).toBe(true);
    if (!facts.accepted) return;
    expect(facts.tractCount, "matched tracts in the e2e slice").toBe(7917);
    expect(facts.deliverableRowCount, "25 rows for each of them").toBe(197925);

    const out = await generateDelivery({
      dealId: "deal_fixed",
      productId: "cdc-places-2025-synthetic-individuals",
      query: E2E_QUERY,
      corpus,
      rowsPerTract: 25,
      seed: SEED,
      storage: memoryStorage(),
      quotedStatsHash: facts.statsHash,
      now: () => "2026-08-12T00:00:00.000Z",
    });

    expect(out.manifest.rowCount).toBe(197925);
    // sha256 of the CSV itself: the public golden value for this
    // corpus/query/seed and the value a buyer must reproduce.
    expect(out.manifest.artifact.contentHash).toBe(
      "sha256:ff9ed6732a435eb5fb8d11e031abf22ec7790db46472a98cb9260701bdf6904c",
    );
    // §4.2 requires deliveryHash to be the content hash of the registered
    // evidence artifact: the manifest's canonical bytes.
    expect(out.deliveryHash).toBe(
      `sha256:${createHash("sha256").update(out.manifestBytes).digest("hex")}`,
    );
    expect(JSON.parse(out.manifestBytes.toString("utf8"))).toEqual(JSON.parse(JSON.stringify(out.manifest)));
    expect(facts.statsHash, "the quote-time commitment the delivery was checked against").toBe(
      out.manifest.sourceStatsHash,
    );
    cleanup();
  }, 60_000);

  it("regenerates that artifact from the published seed alone, which is the buyer's whole defence", async () => {
    const { corpus, cleanup } = await loadFixtureCorpus();
    const storage = memoryStorage();
    const out = await generateDelivery({
      dealId: "deal_fixed",
      productId: "cdc-places-2025-synthetic-individuals",
      query: E2E_QUERY,
      corpus,
      rowsPerTract: 25,
      seed: SEED,
      storage,
      now: () => "2026-08-12T00:00:00.000Z",
    });

    const verdict = verifyDelivery({
      manifest: out.manifest,
      received: out.bytes,
      corpus,
      query: E2E_QUERY,
    });
    expect(verdict.ok, verdict.problems.join("; ")).toBe(true);
    cleanup();
  }, 60_000);
});
