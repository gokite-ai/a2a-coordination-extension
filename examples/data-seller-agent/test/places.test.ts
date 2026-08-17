/**
 * The data engine's tests.
 *
 * The anchor is the card's own worked example. It publishes a query, a tract count, and a price; if the
 * engine reproduces all three against the real CDC release, then the CSV parser, every filter, the
 * inclusion rule, and the rounding are all simultaneously correct. Nothing else in this file is as
 * strong a check, which is why it runs first.
 *
 * The full-corpus tests skip when the source CSV is absent, so the suite still passes on a machine
 * without a 71 MB download. They are explicitly skipped rather than silently passing — a data test
 * that vacuously succeeds is worse than one that is honestly absent.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlaces,
  isSoldMeasure,
  tierOf,
  splitCsvLine,
  validateQuery,
  evaluateQuery,
  priceQuery,
  aggregateStats,
  sampleRows,
  statsCommitment,
  assertCardMatchesCorpus,
  MEASURE_KEYS,
  DataError,
  type Corpus,
} from "../src/engine/places.js";

// Point PLACES_CSV at a local copy of "PLACES: Census Tract Data (GIS
// Friendly Format), 2025 release" (a free public CDC download) to run the
// full-release suite; without it those tests are explicitly skipped.
const CSV = process.env.PLACES_CSV ?? "";
const HAVE_CSV = CSV !== "" && existsSync(CSV);

/**
 * A tiny synthetic corpus, written once and shared.
 *
 * Fractional values are deliberate: they ensure `statsCommitment` handles the
 * shapes present in real slices instead of passing only integer-only fixtures.
 */
const MINI = (() => {
  const dir = mkdtempSync(join(tmpdir(), "places-"));
  const p = join(dir, "mini.csv");
  const header = [
    "StateAbbr",
    "StateDesc",
    "CountyName",
    "CountyFIPS",
    "TractFIPS",
    "TotalPopulation",
    "TotalPop18plus",
    "DIABETES_CrudePrev",
    "BPHIGH_CrudePrev",
    "CHD_CrudePrev",
    "DEPRESSION_CrudePrev",
    "OBESITY_CrudePrev",
    "CSMOKING_CrudePrev",
    "ACCESS2_CrudePrev",
    "SLEEP_CrudePrev",
  ];
  const row = (st: string, county: string, tract: string, pop: number, vals: Array<number | "">): string =>
    [st, `${st} state`, county, "00001", tract, String(pop), `"${pop - 100}"`, ...vals.map(String)]
      .map((c) => (c.startsWith('"') ? c : `"${c}"`))
      .join(",");
  writeFileSync(
    p,
    [
      header.map((h) => `"${h}"`).join(","),
      row("CA", "Alameda", "06001000100", 5000, [10.3, 30.1, 6.2, 20.4, 25.5, 12.6, 15.7, 35.8]),
      row("CA", "Alameda", "06001000200", 1000, [8.1, 28.2, 5.3, 18.4, 22.5, 11.6, 14.7, 33.8]),
      row("CA", "Marin", "06041000100", 9000, [12.9, 32.8, 7.7, 22.6, 27.5, 13.4, 16.3, 37.2]),
      row("XY", "Nowhere", "99001000100", 4000, ["", "", "", "", "", "", "", 40.5]),
    ].join("\n") + "\n",
  );
  return p;
})();

/** The card's rate card terms. */
const TERMS = {
  baseCents: 500,
  perTractMicroCents: 200,
  perStandardColumnCents: 5000,
  perPremiumColumnCents: 12000,
  vintageMultiplierBps: 10_000,
};

describe("CSV parsing", () => {
  it("keeps quoted commas inside one field", () => {
    // The real failure this prevents: TotalPop18plus ships as "1,370", and a naive split shifts every
    // measure value one column left from there on — producing wrong numbers that still look plausible.
    expect(splitCsvLine('"AL","Alabama","Autauga","01001","01001020100","1775","1,370","9.7"')).toEqual([
      "AL",
      "Alabama",
      "Autauga",
      "01001",
      "01001020100",
      "1775",
      "1,370",
      "9.7",
    ]);
  });

  it("handles escaped quotes and empty fields", () => {
    expect(splitCsvLine('"a""b",,"c"')).toEqual(['a"b', "", "c"]);
  });
});

describe("pricing", () => {
  it("reproduces the card's worked example exactly", () => {
    const price = priceQuery({
      tractCount: 362,
      columns: ["DIABETES", "BPHIGH", "OBESITY", "ACCESS2"],
      terms: TERMS,
    });
    expect(price.breakdownCents).toEqual({
      base: 500,
      tracts: 72,
      standardColumns: 10_000,
      premiumColumns: 24_000,
      subtotal: 34_572,
    });
    expect(price.listAmountMinor).toBe("345720000");
    expect(price.listAmountDisplay).toBe("$345.72");
  });

  it("rounds the per-tract term half-up, not toward even", () => {
    // 2500 tracts x 200 / 1000 = 500 exactly; 2502 gives 500.4 -> 500; 2503 gives 500.6 -> 501.
    expect(priceQuery({ tractCount: 2502, columns: ["SLEEP"], terms: TERMS }).breakdownCents.tracts).toBe(500);
    expect(priceQuery({ tractCount: 2503, columns: ["SLEEP"], terms: TERMS }).breakdownCents.tracts).toBe(501);
    // The half case must go up, which is where Math.round and banker's rounding disagree.
    expect(priceQuery({ tractCount: 2_500 + 2.5 * 5, columns: ["SLEEP"], terms: TERMS }).breakdownCents.tracts).toBe(
      503,
    );
  });

  it("charges a duplicated column once, not twice", () => {
    // The deliverable and sample carry one column, so duplicate input cannot increase the price.
    const once = priceQuery({ tractCount: 375, columns: ["DIABETES"], terms: TERMS });
    const twice = priceQuery({ tractCount: 375, columns: ["DIABETES", "DIABETES"], terms: TERMS });
    expect(twice.listAmountMinor).toBe(once.listAmountMinor);
    expect(twice.breakdownCents.premiumColumns).toBe(12_000);
  });

  it("charges columns independently of tract count", () => {
    const one = priceQuery({ tractCount: 1, columns: ["DIABETES"], terms: TERMS });
    const many = priceQuery({ tractCount: 10_000, columns: ["DIABETES"], terms: TERMS });
    expect(one.breakdownCents.premiumColumns).toBe(many.breakdownCents.premiumColumns);
  });

  it("prices premium above standard", () => {
    const prem = priceQuery({ tractCount: 100, columns: ["DIABETES"], terms: TERMS });
    const std = priceQuery({ tractCount: 100, columns: ["SLEEP"], terms: TERMS });
    expect(Number(prem.listAmountMinor)).toBeGreaterThan(Number(std.listAmountMinor));
  });
});

describe("prototype-key defences", () => {
  // `in` and plain-object lookups would accept Object.prototype keys as sold measures, bill phantom
  // columns, defeat tract inclusion, and fail on state-filtered queries.
  const POISON = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"];

  it("rejects every prototype key as a measure", () => {
    for (const k of POISON) expect(isSoldMeasure(k), k).toBe(false);
    expect(isSoldMeasure("DIABETES")).toBe(true);
  });

  it("refuses to price a prototype key rather than billing it as standard", () => {
    for (const k of POISON) expect(() => tierOf(k), k).toThrow(DataError);
  });

  it("reports UNKNOWN_COLUMN for a prototype key, not silent acceptance", async () => {
    const c = await loadPlaces(MINI);
    for (const k of POISON) {
      expect(validateQuery({ columns: [k] }, c).map((r) => r.code), k).toContain("UNKNOWN_COLUMN");
    }
  });

  it("does not let a prototype key match every tract via the inclusion rule", async () => {
    const c = await loadPlaces(MINI);
    // The tract values object is null-prototype, so `values["constructor"]` is undefined rather than
    // Object.prototype.constructor — which is what made the rule exclude nothing.
    for (const t of c.tracts) {
      for (const k of POISON) expect((t.values as Record<string, unknown>)[k], k).toBeUndefined();
    }
  });

  it("does not throw a TypeError on a prototype key with a state filter", async () => {
    const c = await loadPlaces(MINI);
    // This surfaced as HTTP 500 "unavailableStates[c]?.includes is not a function", where the card
    // promises a named refusal.
    expect(() => evaluateQuery({ columns: ["toString"], states: ["CA"] }, c)).not.toThrow();
  });

  it("keeps unavailableStates free of inherited keys", async () => {
    const c = await loadPlaces(MINI);
    for (const k of POISON) {
      expect((c.unavailableStates as Record<string, unknown>)[k], k).toBeUndefined();
    }
  });
});

describe("query validation", () => {
  const path = MINI;

  let corpus: Corpus;
  it("loads the synthetic corpus", async () => {
    corpus = await loadPlaces(path);
    expect(corpus.totals.tracts).toBe(4);
    expect(corpus.unavailableStates.DIABETES).toEqual(["XY"]);
    expect(corpus.unavailableStates.SLEEP).toEqual([]);
    expect(corpus.availabilityIsExhaustiveAtStateLevel).toBe(true);
  });

  it("emits each of the eight rejection codes for the right mistake", async () => {
    corpus ??= await loadPlaces(path);
    const codes = (q: Parameters<typeof validateQuery>[0]) => validateQuery(q, corpus).map((r) => r.code);

    expect(codes({ columns: [] })).toContain("NO_COLUMNS_REQUESTED");
    expect(codes({ columns: ["NOPE"] })).toContain("UNKNOWN_COLUMN");
    expect(codes({ columns: ["SLEEP"], states: ["ZZ"] })).toContain("STATE_NOT_AVAILABLE");
    // A county filter with no state is ambiguous, not narrow.
    expect(codes({ columns: ["SLEEP"], counties: ["Alameda"] })).toContain("COUNTY_FILTER_UNSUPPORTED");
    expect(codes({ columns: ["SLEEP"], states: ["CA"], counties: ["Atlantis"] })).toContain(
      "COUNTY_FILTER_UNSUPPORTED",
    );
    expect(codes({ columns: ["SLEEP"], minPopulation: -5 })).toContain("POPULATION_FILTER_UNSUPPORTED");
    expect(codes({ columns: ["SLEEP"], minPopulation: 1.5 })).toContain("POPULATION_FILTER_UNSUPPORTED");
    expect(codes({ columns: ["SLEEP"], thresholds: { SLEEP: {} } })).toContain("THRESHOLD_FILTER_UNSUPPORTED");
    expect(codes({ columns: ["SLEEP"], thresholds: { DIABETES: { min: 5 } } })).toContain(
      "THRESHOLD_ON_UNREQUESTED_COLUMN",
    );
    expect(codes({ columns: ["SLEEP"], thresholds: { SLEEP: { min: 10, max: 5 } } })).toContain(
      "THRESHOLD_RANGE_EMPTY",
    );
  });

  it("refuses a threshold on an unpurchased column — the free-probe guard", async () => {
    corpus ??= await loadPlaces(path);
    // This is the card's thresholdRule. Without it, a buyer purchases SLEEP, filters on DIABETES, and
    // reads the diabetes distribution for free by watching the tract count move.
    const problems = validateQuery({ columns: ["SLEEP"], thresholds: { DIABETES: { min: 9 } } }, corpus);
    expect(problems.map((p) => p.code)).toEqual(["THRESHOLD_ON_UNREQUESTED_COLUMN"]);
  });

  it("reports every problem at once rather than the first", async () => {
    corpus ??= await loadPlaces(path);
    const problems = validateQuery({ columns: [], states: ["ZZ"], minPopulation: -1 }, corpus);
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes a tract when any purchased measure is suppressed, and never zero-fills", async () => {
    corpus ??= await loadPlaces(path);
    // XY has SLEEP but no DIABETES. Purchasing both must exclude XY entirely rather than treat the
    // missing prevalence as 0, which would sell an invented figure as an observed one.
    const both = evaluateQuery({ columns: ["DIABETES", "SLEEP"], states: ["XY"] }, corpus);
    expect(both.tracts).toHaveLength(0);
    expect(both.zeroYieldStates).toEqual(["XY"]);

    const sleepOnly = evaluateQuery({ columns: ["SLEEP"], states: ["XY"] }, corpus);
    expect(sleepOnly.tracts).toHaveLength(1);
    expect(sleepOnly.zeroYieldStates).toEqual([]);
  });

  it("applies minPopulation and thresholds inclusively", async () => {
    corpus ??= await loadPlaces(path);
    expect(evaluateQuery({ columns: ["SLEEP"], states: ["CA"], minPopulation: 5000 }, corpus).tracts).toHaveLength(2);
    expect(
      evaluateQuery({ columns: ["DIABETES"], states: ["CA"], thresholds: { DIABETES: { min: 10 } } }, corpus).tracts,
    ).toHaveLength(2);
  });

  it("projects the sample to purchased columns only", async () => {
    corpus ??= await loadPlaces(path);
    const matched = evaluateQuery({ columns: ["SLEEP"], states: ["CA"] }, corpus);
    const rows = sampleRows(matched.tracts, ["SLEEP"], 5);
    expect(rows).toHaveLength(3);
    // The unpurchased seven must not appear: the sample is free, and the corpus holds more than is sold.
    expect(Object.keys(rows[0] ?? {})).toContain("SLEEP_CrudePrev");
    expect(Object.keys(rows[0] ?? {})).not.toContain("DIABETES_CrudePrev");
  });

  it("aggregates over the whole slice, not the sample", async () => {
    corpus ??= await loadPlaces(path);
    const matched = evaluateQuery({ columns: ["DIABETES"], states: ["CA"] }, corpus);
    const stats = aggregateStats(matched.tracts, ["DIABETES"]);
    expect(stats.tractCount).toBe(3);
    expect(stats.perMeasure.DIABETES?.n).toBe(3);
    expect(stats.perMeasure.DIABETES?.min).toBe(8.1);
    expect(stats.perMeasure.DIABETES?.max).toBe(12.9);
    expect(stats.perMeasure.DIABETES?.median).toBe(10.3);
  });

  it("hashes fractional prevalence without throwing — the real-slice case", async () => {
    corpus ??= await loadPlaces(path);
    // Commitment mode accepts integers only, while real prevalence is published to one decimal place.
    // `statsCommitment` must scale those values before hashing.
    const stats = aggregateStats(evaluateQuery({ columns: ["DIABETES"], states: ["CA"] }, corpus).tracts, [
      "DIABETES",
    ]);
    expect(stats.perMeasure.DIABETES?.max).toBe(12.9);
    const c = statsCommitment({ stats, query: { columns: ["DIABETES"] } });
    expect(c.statsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("commits a different hash when a stat changes in the fourth decimal", async () => {
    corpus ??= await loadPlaces(path);
    const base = aggregateStats(evaluateQuery({ columns: ["DIABETES"], states: ["CA"] }, corpus).tracts, [
      "DIABETES",
    ]);
    const nudged = { ...base, perMeasure: { DIABETES: { ...base.perMeasure.DIABETES!, mean: (base.perMeasure.DIABETES!.mean + 0.0001) } } };
    const a = statsCommitment({ stats: base, query: { columns: ["DIABETES"] } });
    const b = statsCommitment({ stats: nudged, query: { columns: ["DIABETES"] } });
    // The 10^4 scale must be fine enough that a 4-dp change is still a different commitment.
    expect(a.statsHash).not.toBe(b.statsHash);
  });

  it("commits the same hash for the same query written differently", async () => {
    corpus ??= await loadPlaces(path);
    const stats = aggregateStats(evaluateQuery({ columns: ["DIABETES"], states: ["CA"] }, corpus).tracts, [
      "DIABETES",
    ]);
    const a = statsCommitment({ stats, query: { columns: ["DIABETES", "SLEEP"], states: ["CA", "XY"] } });
    const b = statsCommitment({ stats, query: { columns: ["SLEEP", "DIABETES"], states: ["XY", "CA"] } });
    expect(a.criteriaHash).toBe(b.criteriaHash);
    // A different query must not collide.
    const c = statsCommitment({ stats, query: { columns: ["DIABETES"], states: ["CA"] } });
    expect(c.criteriaHash).not.toBe(a.criteriaHash);
  });

  it("refuses a file missing a sold measure", async () => {
    const bad = join(mkdtempSync(join(tmpdir(), "places-bad-")), "bad.csv");
    writeFileSync(bad, '"StateAbbr","CountyName","TractFIPS","TotalPopulation"\n"CA","X","1","100"\n');
    await expect(loadPlaces(bad)).rejects.toThrow(DataError);
  });
});

describe("card-versus-corpus check", () => {
  const corpus = {
    totals: { tracts: 100, states: 2, counties: 5, population: 0, pop18plus: 0 },
    unavailableStates: Object.fromEntries(MEASURE_KEYS.map((m) => [m, m === "SLEEP" ? [] : ["PA"]])),
    availabilityIsExhaustiveAtStateLevel: true,
  } as unknown as Corpus;

  const cardUnavailable = Object.fromEntries(MEASURE_KEYS.map((m) => [m, m === "SLEEP" ? [] : ["PA"]]));

  it("passes when the card describes the corpus", () => {
    expect(() =>
      assertCardMatchesCorpus({ corpus, cardTracts: 100, cardStates: 2, cardUnavailable }),
    ).not.toThrow();
  });

  it("refuses a card that overstates the tract count", () => {
    expect(() => assertCardMatchesCorpus({ corpus, cardTracts: 83_522, cardStates: 2, cardUnavailable })).toThrow(
      /card claims 83522 tracts, corpus has 100/,
    );
  });

  it("refuses a card whose availability claim is wrong", () => {
    const wrong = { ...cardUnavailable, DIABETES: [] };
    expect(() => assertCardMatchesCorpus({ corpus, cardTracts: 100, cardStates: 2, cardUnavailable: wrong })).toThrow(
      /DIABETES: card says unavailable in \[\], corpus says \[PA\]/,
    );
  });

  it("refuses when suppression is not state-level, because unavailableStates is then incomplete", () => {
    const partial = { ...corpus, availabilityIsExhaustiveAtStateLevel: false } as unknown as Corpus;
    expect(() =>
      assertCardMatchesCorpus({ corpus: partial, cardTracts: 100, cardStates: 2, cardUnavailable }),
    ).toThrow(/partially\s+suppressed/);
  });
});

describe.skipIf(!HAVE_CSV)("against the real 2025 release", () => {
  let corpus: Corpus;

  it("loads 83,522 tracts across 51 states", async () => {
    corpus = await loadPlaces(CSV);
    expect(corpus.totals.tracts).toBe(83_522);
    expect(corpus.totals.states).toBe(51);
  });

  it("reproduces the card's worked example end to end", async () => {
    corpus ??= await loadPlaces(CSV);
    // The whole engine in one assertion: parser, state filter, county filter, population filter,
    // threshold, inclusion rule, and rounding all have to be right to land on 362 and $345.72.
    const query = {
      columns: ["DIABETES", "BPHIGH", "OBESITY", "ACCESS2"],
      states: ["CA"],
      counties: ["Alameda", "San Francisco"],
      minPopulation: 2000,
      thresholds: { DIABETES: { min: 9 } },
    };
    expect(validateQuery(query, corpus)).toEqual([]);
    const matched = evaluateQuery(query, corpus);
    expect(matched.tracts).toHaveLength(362);
    expect(priceQuery({ tractCount: 362, columns: query.columns, terms: TERMS }).listAmountDisplay).toBe("$345.72");
  });

  it("confirms the card's availability claims: 7 measures zero in exactly KY and PA", async () => {
    corpus ??= await loadPlaces(CSV);
    for (const m of MEASURE_KEYS) {
      expect(corpus.unavailableStates[m], m).toEqual(m === "SLEEP" ? [] : ["KY", "PA"]);
    }
  });

  it("confirms availabilityIsExhaustive: no measure is partially suppressed within a state", async () => {
    corpus ??= await loadPlaces(CSV);
    // The card tells buyers they can decide buyability from `unavailableStates` alone with no residual
    // per-tract surprise. That is only true if suppression never splits a state, so it is checked
    // rather than trusted.
    expect(corpus.availabilityIsExhaustiveAtStateLevel).toBe(true);
  });

  it("returns nothing for a suppressed measure in PA, and says why", async () => {
    corpus ??= await loadPlaces(CSV);
    const matched = evaluateQuery({ columns: ["DIABETES"], states: ["PA"] }, corpus);
    expect(matched.tracts).toHaveLength(0);
    expect(matched.zeroYieldStates).toEqual(["PA"]);
  });

  it("does not silently drop PA tracts from a mixed query — it excludes them and flags the state", async () => {
    corpus ??= await loadPlaces(CSV);
    const mixed = evaluateQuery({ columns: ["DIABETES"], states: ["CA", "PA"] }, corpus);
    const caOnly = evaluateQuery({ columns: ["DIABETES"], states: ["CA"] }, corpus);
    expect(mixed.tracts.length).toBe(caOnly.tracts.length);
    // The flag lets the negotiating agent disclose that the requested state contributes no rows.
    expect(mixed.zeroYieldStates).toEqual(["PA"]);
  });
});
