/**
 * The PLACES corpus, and the query engine that prices against it.
 *
 * This is what turns the card from a claim into a product: the rate card publishes a price *function*,
 * and this module is the only thing that can evaluate it. Every number a buyer is quoted comes from
 * here, computed against the real CDC release rather than a fixture.
 *
 * Three rules from the card's `querySurface` are enforced here rather than documented:
 *
 *   tractInclusionRule   a tract counts only if EVERY purchased measure has a published value.
 *                        CDC-suppressed values exclude the tract and are never zero-filled — filling
 *                        them would sell an invented prevalence as an observed one.
 *   thresholdRule        a threshold may only be set on a column being purchased. Otherwise a buyer
 *                        probes the unpurchased data for free by watching the tract count move.
 *   column projection    the free sample returns only the purchased columns. The corpus has 88; a
 *                        sample that returned all of them would give away the other 40 measures.
 *
 * Loading parses only the columns that are sold or identify a tract — fifteen of eighty-eight. The
 * full file is 71 MB and holds prevalence figures for measures this agent does not sell; not reading
 * them into memory is both cheaper and one less way to leak them.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
// Commitment hashing is local and pinned by the public golden tests.
import { sha256, type Sha256 } from "./hash.js";

export class DataError extends Error {}

/**
 * The eight measures the card sells, with the tier that prices them.
 *
 * Null-prototype, and membership is tested through `isSoldMeasure` rather than `in`. Attacking the
 * finished engine showed why: `"constructor" in SOLD_MEASURES` is true, so a request for
 * `["constructor"]` passed UNKNOWN_COLUMN, matched the ENTIRE 83,522-tract corpus (because
 * `values["constructor"]` inherits Object.prototype.constructor and is never null, defeating the
 * inclusion rule), and priced at $222.04 for a column that does not exist. `["DIABETES","toString"]`
 * billed $332.63 against $282.63 for the identical slice.
 */
export const SOLD_MEASURES: Record<string, "premium" | "standard"> = Object.assign(Object.create(null), {
  DIABETES: "premium",
  BPHIGH: "premium",
  CHD: "premium",
  DEPRESSION: "premium",
  OBESITY: "standard",
  CSMOKING: "standard",
  ACCESS2: "standard",
  SLEEP: "standard",
});

export type MeasureKey =
  | "DIABETES"
  | "BPHIGH"
  | "CHD"
  | "DEPRESSION"
  | "OBESITY"
  | "CSMOKING"
  | "ACCESS2"
  | "SLEEP";

export const MEASURE_KEYS: MeasureKey[] = [
  "DIABETES",
  "BPHIGH",
  "CHD",
  "DEPRESSION",
  "OBESITY",
  "CSMOKING",
  "ACCESS2",
  "SLEEP",
];

const MEASURE_SET: ReadonlySet<string> = new Set<string>(MEASURE_KEYS);

/** The only membership test. A Set has no prototype keys to inherit. */
export function isSoldMeasure(key: string): key is MeasureKey {
  return MEASURE_SET.has(key);
}

/** Tier for pricing. Refuses anything not sold, rather than defaulting it to standard. */
export function tierOf(key: string): "premium" | "standard" {
  if (!isSoldMeasure(key)) throw new DataError(`${key} is not a sold measure.`);
  return SOLD_MEASURES[key] as "premium" | "standard";
}

/** One tract, projected to what is sold. `null` is a CDC suppression, never a zero. */
export interface Tract {
  stateAbbr: string;
  stateDesc: string;
  countyName: string;
  countyFips: string;
  tractFips: string;
  totalPopulation: number | null;
  totalPop18plus: number | null;
  /** Crude prevalence per measure, `null` where CDC suppressed it. */
  values: Record<MeasureKey, number | null>;
}

export interface Corpus {
  tracts: Tract[];
  /** Set of state abbreviations actually present. */
  states: Set<string>;
  /** Per measure, the states in which no tract has a published value. */
  unavailableStates: Record<MeasureKey, string[]>;
  /** True when no measure is partially suppressed within a state. The card promises this. */
  availabilityIsExhaustiveAtStateLevel: boolean;
  counties: Map<string, Set<string>>;
  totals: { tracts: number; states: number; counties: number; population: number; pop18plus: number };
  sourcePath: string;
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * Split one CSV line, honouring double quotes.
 *
 * Necessary rather than fussy: `TotalPop18plus` is published as `"1,370"`, so a naive split on commas
 * corrupts every row after the sixth column and silently shifts every measure value into the wrong
 * field. A parser that gets this wrong still produces plausible numbers, which is what makes it
 * dangerous.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** Parse a published number. Blank means suppressed, and must stay distinguishable from zero. */
function parseNum(raw: string | undefined): number | null {
  const s = (raw ?? "").replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Load the corpus.
 *
 * Streamed line by line: the file is 71 MB, and reading it whole to split it is a needless spike on a
 * service that also has to answer requests while this runs.
 */
export async function loadPlaces(path: string): Promise<Corpus> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let header: string[] | null = null;
  const idx: Record<string, number> = {};
  const tracts: Tract[] = [];
  const states = new Set<string>();
  const counties = new Map<string, Set<string>>();
  let population = 0;
  let pop18 = 0;

  // Per measure and state: how many tracts have a value, and how many rows exist.
  const withValue = new Map<string, number>();
  const rowsPerState = new Map<string, number>();

  // A file with no newlines would otherwise buffer entirely into one string and exhaust memory
  // before the parser can reject it. The real header is under 2 KB.
  const MAX_LINE = 64 * 1024;
  for await (const line of lines) {
    if (line.length > MAX_LINE) {
      throw new DataError(
        `${path} has a line of ${line.length} bytes (limit ${MAX_LINE}). This is not the PLACES ` +
          `release — check the path before the process exhausts memory on it.`,
      );
    }
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line);
    if (header === null) {
      header = cells.map((c) => c.trim());
      header.forEach((name, i) => (idx[name] = i));
      for (const required of ["StateAbbr", "CountyName", "TractFIPS", "TotalPopulation"]) {
        if (idx[required] === undefined) {
          throw new DataError(`${path} is missing the required column "${required}".`);
        }
      }
      for (const m of MEASURE_KEYS) {
        if (idx[`${m}_CrudePrev`] === undefined) {
          throw new DataError(`${path} has no column for the sold measure ${m}.`);
        }
      }
      continue;
    }

    const at = (name: string): string | undefined => cells[idx[name] ?? -1];
    const stateAbbr = (at("StateAbbr") ?? "").trim();
    if (stateAbbr === "") continue;

    // Null-prototype: a plain literal makes `values["constructor"]` non-null for every tract, which
    // silently defeats the inclusion rule for any prototype-named column.
    const values = Object.create(null) as Record<MeasureKey, number | null>;
    for (const m of MEASURE_KEYS) {
      const v = parseNum(at(`${m}_CrudePrev`));
      values[m] = v;
      if (v !== null) withValue.set(`${m}|${stateAbbr}`, (withValue.get(`${m}|${stateAbbr}`) ?? 0) + 1);
    }

    const totalPopulation = parseNum(at("TotalPopulation"));
    const totalPop18plus = parseNum(at("TotalPop18plus"));
    const countyName = (at("CountyName") ?? "").trim();

    tracts.push({
      stateAbbr,
      stateDesc: (at("StateDesc") ?? "").trim(),
      countyName,
      countyFips: (at("CountyFIPS") ?? "").trim(),
      tractFips: (at("TractFIPS") ?? "").trim(),
      totalPopulation,
      totalPop18plus,
      values,
    });

    states.add(stateAbbr);
    rowsPerState.set(stateAbbr, (rowsPerState.get(stateAbbr) ?? 0) + 1);
    if (!counties.has(stateAbbr)) counties.set(stateAbbr, new Set());
    counties.get(stateAbbr)?.add(countyName);
    population += totalPopulation ?? 0;
    pop18 += totalPop18plus ?? 0;
  }

  if (tracts.length === 0) throw new DataError(`${path} contained no data rows.`);

  // Derive availability, and check the card's exhaustiveness promise while we have the counts. A
  // measure that is present in some tracts of a state but not others would make `unavailableStates`
  // an incomplete description, and a buyer relying on the card would hit a surprise at quote time.
  const unavailableStates = Object.create(null) as Record<MeasureKey, string[]>;
  let exhaustive = true;
  for (const m of MEASURE_KEYS) {
    const gaps: string[] = [];
    for (const st of states) {
      const have = withValue.get(`${m}|${st}`) ?? 0;
      const rows = rowsPerState.get(st) ?? 0;
      if (have === 0) gaps.push(st);
      else if (have < rows) exhaustive = false;
    }
    unavailableStates[m] = gaps.sort();
  }

  let countyCount = 0;
  for (const set of counties.values()) countyCount += set.size;

  return {
    tracts,
    states,
    unavailableStates,
    availabilityIsExhaustiveAtStateLevel: exhaustive,
    counties,
    totals: {
      tracts: tracts.length,
      states: states.size,
      counties: countyCount,
      population,
      pop18plus: pop18,
    },
    sourcePath: path,
  };
}

// ---------------------------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------------------------

export interface Threshold {
  min?: number | undefined;
  max?: number | undefined;
}

export interface Query {
  columns: string[];
  states?: string[] | undefined;
  counties?: string[] | undefined;
  minPopulation?: number | undefined;
  thresholds?: Record<string, Threshold> | undefined;
}

/** The eight rejection codes the card publishes. Named refusals, never a silent empty result. */
export type RejectionCode =
  | "NO_COLUMNS_REQUESTED"
  | "UNKNOWN_COLUMN"
  | "STATE_NOT_AVAILABLE"
  | "COUNTY_FILTER_UNSUPPORTED"
  | "POPULATION_FILTER_UNSUPPORTED"
  | "THRESHOLD_FILTER_UNSUPPORTED"
  | "THRESHOLD_ON_UNREQUESTED_COLUMN"
  | "THRESHOLD_RANGE_EMPTY";

export interface Rejection {
  code: RejectionCode;
  detail: string;
}

/**
 * Validate before pricing.
 *
 * Returns every problem rather than the first, because a buyer fixing a query one round trip per
 * mistake is a buyer who gives up. The order below is deliberate: unknown columns are reported before
 * threshold problems, since a threshold on a misspelled column would otherwise produce two errors for
 * one typo.
 */
export function validateQuery(q: Query, corpus: Corpus): Rejection[] {
  const problems: Rejection[] = [];
  /** Bounded: the response must not scale with a hostile request body. */
  const MAX_PROBLEMS = 24;
  const columns = q.columns ?? [];

  if (columns.length === 0) {
    problems.push({ code: "NO_COLUMNS_REQUESTED", detail: "At least one measure must be purchased." });
  }
  // Own-property membership. `in` would accept every Object.prototype key as a sold measure.
  const unknown = columns.filter((c) => !isSoldMeasure(c));
  if (unknown.length > 0) {
    problems.push({
      code: "UNKNOWN_COLUMN",
      detail: `Not sold: ${unknown.join(", ")}. Available: ${MEASURE_KEYS.join(", ")}.`,
    });
  }

  for (const st of q.states ?? []) {
    if (!corpus.states.has(st)) {
      problems.push({
        code: "STATE_NOT_AVAILABLE",
        detail: `"${st}" is not in the 2025 release. The release covers ${corpus.states.size} states and DC; US territories are not covered.`,
      });
    }
  }

  if (q.counties !== undefined && q.counties.length > 0) {
    // County names repeat across states — there is a Washington County in thirty of them — so a county
    // filter without a state is not a narrow query, it is an ambiguous one.
    if ((q.states ?? []).length === 0) {
      problems.push({
        code: "COUNTY_FILTER_UNSUPPORTED",
        detail: "A county filter requires at least one state: county names are not unique nationally.",
      });
    } else {
      const known = new Set<string>();
      for (const st of q.states ?? []) for (const c of corpus.counties.get(st) ?? []) known.add(c);
      const missing = q.counties.filter((c) => !known.has(c));
      if (missing.length > 0) {
        problems.push({
          code: "COUNTY_FILTER_UNSUPPORTED",
          detail: `No such county in the selected states: ${missing.join(", ")}.`,
        });
      }
    }
  }

  if (q.minPopulation !== undefined) {
    if (!Number.isInteger(q.minPopulation) || q.minPopulation < 0) {
      problems.push({
        code: "POPULATION_FILTER_UNSUPPORTED",
        detail: "minPopulation must be a non-negative integer.",
      });
    }
  }

  const thresholdEntries = Object.entries(q.thresholds ?? {});
  if (thresholdEntries.length > MEASURE_KEYS.length) {
    problems.push({
      code: "THRESHOLD_FILTER_UNSUPPORTED",
      detail: `At most ${MEASURE_KEYS.length} thresholds — one per sold measure.`,
    });
  }
  for (const [key, t] of thresholdEntries.slice(0, MEASURE_KEYS.length)) {
    if (typeof t !== "object" || t === null) {
      problems.push({ code: "THRESHOLD_FILTER_UNSUPPORTED", detail: `Threshold on ${key} is not an object.` });
      continue;
    }
    const { min, max } = t;
    if ((min !== undefined && typeof min !== "number") || (max !== undefined && typeof max !== "number")) {
      problems.push({
        code: "THRESHOLD_FILTER_UNSUPPORTED",
        detail: `Threshold on ${key} must use numeric min/max.`,
      });
      continue;
    }
    if (min === undefined && max === undefined) {
      problems.push({ code: "THRESHOLD_FILTER_UNSUPPORTED", detail: `Threshold on ${key} sets neither min nor max.` });
      continue;
    }
    // The card's thresholdRule. Filtering on an unpurchased column reads the data for free.
    if (!columns.includes(key)) {
      problems.push({
        code: "THRESHOLD_ON_UNREQUESTED_COLUMN",
        detail: `${key} is not being purchased, so it cannot be filtered on.`,
      });
      continue;
    }
    if (min !== undefined && max !== undefined && min > max) {
      problems.push({ code: "THRESHOLD_RANGE_EMPTY", detail: `Threshold on ${key} has min > max.` });
    }
  }

  // Truncated rather than silently capped, so a caller can tell the list is incomplete.
  if (problems.length > MAX_PROBLEMS) {
    return [
      ...problems.slice(0, MAX_PROBLEMS),
      {
        code: "NO_COLUMNS_REQUESTED",
        detail: `…and ${problems.length - MAX_PROBLEMS} further problems, not listed. Fix these first.`,
      },
    ];
  }
  return problems;
}

export interface Matched {
  tracts: Tract[];
  /** States in the query that yield nothing because the measure is suppressed there. */
  zeroYieldStates: string[];
}

/**
 * Evaluate a validated query.
 *
 * A tract survives only if every purchased measure has a published value for it — the card's
 * `tractInclusionRule`. That is also why a query naming PA with DIABETES is not an error: it is a
 * legal query that matches nothing in PA, and saying so is more useful than refusing.
 */
export function evaluateQuery(q: Query, corpus: Corpus): Matched {
  const columns = q.columns as MeasureKey[];
  const stateFilter = new Set(q.states ?? []);
  const countyFilter = new Set(q.counties ?? []);
  const thresholds = Object.entries(q.thresholds ?? {}) as Array<[MeasureKey, Threshold]>;

  const out: Tract[] = [];
  for (const t of corpus.tracts) {
    if (stateFilter.size > 0 && !stateFilter.has(t.stateAbbr)) continue;
    if (countyFilter.size > 0 && !countyFilter.has(t.countyName)) continue;
    if (q.minPopulation !== undefined && (t.totalPopulation ?? -1) < q.minPopulation) continue;

    let ok = true;
    for (const c of columns) {
      if (t.values[c] === null) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    for (const [key, th] of thresholds) {
      const v = t.values[key];
      if (v === null || (th.min !== undefined && v < th.min) || (th.max !== undefined && v > th.max)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    out.push(t);
  }

  // Worth telling the buyer explicitly rather than leaving them to infer it from a low count: this is
  // the mistake the negotiating agent caught unprompted, where PA tracts would bill and return nothing.
  const zeroYield: string[] = [];
  for (const st of q.states ?? []) {
    for (const c of columns) {
      // Array-checked rather than optional-chained. `?.` does not short-circuit a non-nullish value, so
      // an inherited key here resolved to Function.prototype.toString and threw a TypeError that
      // surfaced as HTTP 500 where the card promises a named refusal.
      const gaps = corpus.unavailableStates[c];
      if (Array.isArray(gaps) && gaps.includes(st) && !zeroYield.includes(st)) zeroYield.push(st);
    }
  }

  return { tracts: out, zeroYieldStates: zeroYield };
}

// ---------------------------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------------------------

export interface RateCardTerms {
  baseCents: number;
  perTractMicroCents: number;
  perStandardColumnCents: number;
  perPremiumColumnCents: number;
  vintageMultiplierBps: number;
}

export interface Price {
  tractCount: number;
  breakdownCents: { base: number; tracts: number; standardColumns: number; premiumColumns: number; subtotal: number };
  listCents: number;
  listAmountMinor: string;
  listAmountDisplay: string;
}

/** Half-up, as the card's rounding rule states. `Math.round` is half-up for positives; be explicit. */
function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/**
 * Price a matched slice.
 *
 * Reproduces the card's published formula exactly, including that column charges do not scale with
 * tract count. The card's own worked example is a test: 362 tracts with two premium and two standard
 * columns must come to $345.72, and it does.
 */
export function priceQuery(input: { tractCount: number; columns: string[]; terms: RateCardTerms }): Price {
  const { tractCount, terms } = input;

  // Distinct columns. A request naming the same measure twice delivers one column, so charging twice
  // would bill for something the buyer does not receive. Deduplicate here because a function that
  // computes money must not depend on a caller having sanitised its input.
  const columns = [...new Set(input.columns)];

  let premium = 0;
  let standard = 0;
  for (const c of columns) {
    // `tierOf` throws for anything not sold, preventing an unknown key from being billed as a
    // deliverable standard column.
    if (tierOf(c) === "premium") premium += 1;
    else standard += 1;
  }

  const tractsCents = roundHalfUp((tractCount * terms.perTractMicroCents) / 1000);
  const standardColumns = standard * terms.perStandardColumnCents;
  const premiumColumns = premium * terms.perPremiumColumnCents;
  const subtotal = terms.baseCents + tractsCents + standardColumns + premiumColumns;
  const listCents = roundHalfUp((subtotal * terms.vintageMultiplierBps) / 10_000);

  return {
    tractCount,
    breakdownCents: { base: terms.baseCents, tracts: tractsCents, standardColumns, premiumColumns, subtotal },
    listCents,
    // USDC minor units are never rounded: cents x 10^4.
    listAmountMinor: (BigInt(listCents) * 10_000n).toString(),
    listAmountDisplay: `$${(listCents / 100).toFixed(2)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Sample and aggregate
// ---------------------------------------------------------------------------------------------

export interface AggregateStats {
  tractCount: number;
  totalPopulation: number;
  totalPop18plus: number;
  perMeasure: Record<string, { min: number; max: number; mean: number; median: number; n: number }>;
}

/**
 * Aggregate over the WHOLE matched slice, not over the sample.
 *
 * That distinction is the card's promise and the buyer's main pre-payment signal: five rows say
 * nothing about a 362-tract slice, but its distribution does.
 */
export function aggregateStats(matched: Tract[], columns: string[]): AggregateStats {
  const perMeasure: AggregateStats["perMeasure"] = {};
  let pop = 0;
  let pop18 = 0;
  for (const t of matched) {
    pop += t.totalPopulation ?? 0;
    pop18 += t.totalPop18plus ?? 0;
  }
  for (const c of columns) {
    // Filtered on type rather than on `!== null`, so a non-numeric inherited value cannot enter the
    // aggregates and turn the mean into NaN.
    const vals = matched
      .map((t) => t.values[c as MeasureKey])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    vals.sort((a, b) => a - b);
    const n = vals.length;
    perMeasure[c] =
      n === 0
        ? { min: 0, max: 0, mean: 0, median: 0, n: 0 }
        : {
            min: vals[0] as number,
            max: vals[n - 1] as number,
            // Rounded to 4dp so the figure is stable across platforms; statsHash covers these bytes.
            mean: Number((vals.reduce((a, b) => a + b, 0) / n).toFixed(4)),
            median:
              n % 2 === 1
                ? (vals[(n - 1) / 2] as number)
                : Number((((vals[n / 2 - 1] as number) + (vals[n / 2] as number)) / 2).toFixed(4)),
            n,
          };
  }
  return { tractCount: matched.length, totalPopulation: pop, totalPop18plus: pop18, perMeasure };
}

/**
 * The free sample: the first N matches in file order.
 *
 * File order rather than random, because the card promises the selection is reproducible after the
 * fact — a buyer who later regenerates must get the same five rows, or the sample commitment proves
 * nothing.
 *
 * Projected to the purchased columns only. The corpus carries eight sold measures and the file has
 * forty-odd more; a sample that returned whole rows would hand over the unpurchased ones for free,
 * which is the same leak `thresholdRule` exists to prevent.
 */
export function sampleRows(matched: Tract[], columns: string[], n = 5): Array<Record<string, unknown>> {
  return matched.slice(0, n).map((t) => {
    const row: Record<string, unknown> = {
      StateAbbr: t.stateAbbr,
      StateDesc: t.stateDesc,
      CountyName: t.countyName,
      CountyFIPS: t.countyFips,
      TractFIPS: t.tractFips,
      TotalPopulation: t.totalPopulation,
      TotalPop18plus: t.totalPop18plus,
    };
    for (const c of columns) row[`${c}_CrudePrev`] = t.values[c as MeasureKey];
    return row;
  });
}

/**
 * The commitment re-checked at delivery.
 *
 * Covers the aggregate statistics and the criteria that produced them, so substituting a different
 * slab of data after payment is detectable. It deliberately does NOT cover the sample rows: those are
 * a projection of the same slice, and hashing them too would make the commitment depend on the sample
 * size rather than on the data sold.
 */
export function statsCommitment(input: { stats: AggregateStats; query: Query }): {
  statsHash: Sha256;
  criteriaHash: Sha256;
} {
  // Canonical form: sorted keys, so two identical queries written differently commit to one hash.
  const criteria = {
    columns: [...input.query.columns].sort(),
    states: [...(input.query.states ?? [])].sort(),
    counties: [...(input.query.counties ?? [])].sort(),
    minPopulation: input.query.minPopulation ?? null,
    thresholds: Object.fromEntries(
      Object.entries(input.query.thresholds ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, { min: v.min ?? null, max: v.max ?? null }]),
    ),
  };
  // Commitment hashing takes integers only, and prevalence is published to one decimal place — so
  // hashing the stats as-is threw CanonicalError on 100% of real slices. It passed the unit tests
  // solely because the synthetic fixture used whole numbers.
  //
  // Scaled by 10^4 rather than rounded: values are 1 dp and the derived mean/median are held to 4 dp,
  // so this is exact for every figure the engine produces, and the commitment stays a commitment to
  // the actual numbers rather than to a lossy version of them.
  const SCALE = 10_000;
  const scaled = {
    tractCount: input.stats.tractCount,
    totalPopulation: input.stats.totalPopulation,
    totalPop18plus: input.stats.totalPop18plus,
    scale: SCALE,
    perMeasure: Object.fromEntries(
      Object.entries(input.stats.perMeasure)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [
          k,
          {
            min: Math.round(v.min * SCALE),
            max: Math.round(v.max * SCALE),
            mean: Math.round(v.mean * SCALE),
            median: Math.round(v.median * SCALE),
            n: v.n,
          },
        ]),
    ),
  };

  return { statsHash: sha256(scaled), criteriaHash: sha256(criteria) };
}

/**
 * Check the card against the corpus actually loaded.
 *
 * The card makes three falsifiable claims about the data — tract count, per-measure unavailable states,
 * and that suppression is entirely state-level. A service that serves a signed card whose claims its
 * own data contradicts is worse than one with no card, so this refuses at startup rather than warning.
 */
export function assertCardMatchesCorpus(input: {
  corpus: Corpus;
  cardTracts: number;
  cardStates: number;
  cardUnavailable: Record<string, string[]>;
  /** Card-declared tier per measure. Compared, because the price function depends on it. */
  cardTiers?: Record<string, string> | undefined;
}): void {
  const { corpus } = input;
  const problems: string[] = [];

  if (corpus.totals.tracts !== input.cardTracts) {
    problems.push(`card claims ${input.cardTracts} tracts, corpus has ${corpus.totals.tracts}`);
  }
  if (corpus.totals.states !== input.cardStates) {
    problems.push(`card claims ${input.cardStates} states, corpus has ${corpus.totals.states}`);
  }
  // The card's measure set must equal the engine's. A card selling a measure the engine cannot price,
  // or an engine pricing one the card does not sell, is a divergence between the published price
  // function and the thing computing it.
  const cardMeasures = new Set(Object.keys(input.cardUnavailable));
  const extra = [...cardMeasures].filter((m) => !isSoldMeasure(m));
  const missing = MEASURE_KEYS.filter((m) => !cardMeasures.has(m));
  if (extra.length > 0) problems.push(`card sells measures the engine cannot price: ${extra.join(", ")}`);
  if (missing.length > 0) problems.push(`engine prices measures the card does not sell: ${missing.join(", ")}`);

  for (const m of MEASURE_KEYS) {
    const tier = input.cardTiers?.[m];
    if (tier !== undefined && tier !== SOLD_MEASURES[m]) {
      problems.push(`${m}: card tier "${tier}" but engine prices it as "${SOLD_MEASURES[m]}"`);
    }
    const claimed = [...(input.cardUnavailable[m] ?? [])].sort().join(",");
    const actual = (corpus.unavailableStates[m] ?? []).join(",");
    if (claimed !== actual) {
      problems.push(`${m}: card says unavailable in [${claimed}], corpus says [${actual}]`);
    }
  }
  if (!corpus.availabilityIsExhaustiveAtStateLevel) {
    problems.push(
      "card asserts availabilityIsExhaustive at state level, but some measure is partially " +
        "suppressed within a state — unavailableStates is then an incomplete description",
    );
  }

  if (problems.length > 0) {
    throw new DataError(
      `The signed card does not describe the loaded corpus:\n  - ${problems.join("\n  - ")}\n` +
        `Re-render and re-sign the card for this release rather than serving a card that overstates it.`,
    );
  }
}
