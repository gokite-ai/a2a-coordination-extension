/**
 * The deliverable: synthetic individual records.
 *
 * This reproduces `nec-data-agent/src/domain/synth.ts` **bit for bit**, and that is a hard requirement
 * rather than a nicety. The card publishes the seed in the manifest on purpose, so a buyer can regenerate
 * the file and check it against the attested `contentHash`. If the platform's generator and the agent's
 * differ by one draw, every buyer's verification fails and the seller cannot prove delivery.
 *
 * The properties that make that possible:
 *
 *   counter-based PRNG   `uniform(seed, index, field) = sha256("seed|index|field")[0..6) / 2^48`. Every
 *                        draw is independently addressable, so adding a column or reordering fields
 *                        cannot shift every subsequent value.
 *   population weighting  tracts are drawn with probability proportional to adult population, so each
 *                        synthetic person is a draw from the slice's actual adult population and the
 *                        realized rates converge on the published marginal.
 *   age denominators      ACCESS2 is an 18–64 measure, so it is definitively 0 for a 65+ row and is
 *                        excluded from that measure's calibration.
 *
 * What it does NOT do, stated here because the card states it and a buyer must not be surprised: the
 * measure flags are drawn INDEPENDENTLY. Marginals are reproduced; the joint distribution is not. Any
 * co-morbidity or interaction estimate from this file is an artifact of independent sampling.
 */
import { createHash } from "node:crypto";
import type { Tract, MeasureKey } from "./places.js";

export class SynthError extends Error {}

/** Illustrative only — PLACES publishes no age breakdown, so nothing calibrates these weights. */
export const SYNTHETIC_AGE_BANDS = [
  { band: "18-34", weight: 0.3 },
  { band: "35-49", weight: 0.25 },
  { band: "50-64", weight: 0.25 },
  { band: "65+", weight: 0.2 },
] as const;

/**
 * Measures whose denominator is narrower than "all adults".
 *
 * ACCESS2 is uninsurance among 18–64s; 65+ is near-universally Medicare-covered. A row outside the
 * denominator is a definitive 0, not a draw — and excluding it from calibration is why the calibration
 * check does not fail on a correct file.
 */
const AGE_RESTRICTED: Readonly<Record<string, readonly string[]>> = Object.assign(Object.create(null), {
  ACCESS2: ["18-34", "35-49", "50-64"],
});

/** Column name in the deliverable for each measure. */
const SYNTHETIC_COLUMN: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  DIABETES: "has_diabetes",
  BPHIGH: "has_high_bp",
  CHD: "has_chd",
  DEPRESSION: "has_depression",
  OBESITY: "is_obese",
  CSMOKING: "is_current_smoker",
  ACCESS2: "is_uninsured_18_64",
  SLEEP: "short_sleep",
});

export interface SynthesisOptions {
  rowCount: number;
  /**
   * A guaranteed number of rows for EVERY tract in the slice.
   *
   * Absent, the generator draws each row's tract at random with probability proportional to adult population.
   * That keeps the file's overall rates right and leaves per-tract coverage to chance: at 1,000 rows over 7,917
   * tracts, 935 tracts get a row and 88% of the slice appears zero times, so a buyer who paid per tract
   * received nothing for most of them. Measured, not estimated — and it does not go away with volume: at a
   * MEAN of 30 rows per tract, 14 tracts still draw nothing.
   *
   * Set, rows are allocated per tract instead (see `allocateRows`), so every purchased tract is represented and
   * the floor is a promise rather than a probability.
   */
  rowsPerTract?: number | undefined;
  /**
   * The randomness seed. Any string; it is hashed, not used numerically.
   *
   * Published in the manifest ON PURPOSE — it is not a secret, it is what lets a buyer re-derive the file
   * and verify the delivery without trusting the seller.
   */
  seed: string;
  columns: string[];
}

export interface SyntheticPerson {
  syntheticPersonId: string;
  sourceTractFIPS: string;
  sourceCountyName: string;
  sourceStateAbbr: string;
  ageBand: string;
  flags: Record<string, 0 | 1>;
  isSynthetic: true;
}

/**
 * A uniform double in [0, 1) from `(seed, index, field)`.
 *
 * 48 bits, because `readUIntBE` supports at most 6 bytes and 2^48 granularity is far finer than needed
 * for Bernoulli draws at one-decimal-place probabilities. Matching the source exactly matters more than
 * any of that: a different bit width is a different file.
 */
export function uniform(seed: string, index: number, field: string): number {
  const digest = createHash("sha256").update(`${seed}|${index}|${field}`).digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

interface TractSampler {
  tracts: Tract[];
  cumulative: number[];
  totalWeight: number;
}

/**
 * Cumulative adult-population weights.
 *
 * Weighted rather than uniform because picking tracts uniformly would let a 900-adult tract contribute as
 * many people as a 9,000-adult one, dragging the file's overall rates toward the profile of small tracts —
 * away from the marginal the buyer was quoted.
 */
function buildSampler(tracts: Tract[]): TractSampler {
  const cumulative: number[] = [];
  let running = 0;
  for (const t of tracts) {
    const pop = t.totalPop18plus;
    running += pop !== null && Number.isFinite(pop) && pop > 0 ? pop : 0;
    cumulative.push(running);
  }
  return { tracts, cumulative, totalWeight: running };
}

/** Binary search over the cumulative weights: O(n log t) rather than O(n·t). */
function pickTract(sampler: TractSampler, u: number): Tract {
  if (sampler.totalWeight <= 0) {
    // Degenerate slice with no positive weights. Fall back to the first tract so the generator is total
    // rather than throwing inside a delivery.
    const first = sampler.tracts[0];
    if (first === undefined) throw new SynthError("Cannot generate from an empty slice.");
    return first;
  }
  const target = u * sampler.totalWeight;
  let lo = 0;
  let hi = sampler.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sampler.cumulative[mid] as number) <= target) lo = mid + 1;
    else hi = mid;
  }
  return sampler.tracts[lo] as Tract;
}

function pickAgeBand(u: number): string {
  let acc = 0;
  for (const b of SYNTHETIC_AGE_BANDS) {
    acc += b.weight;
    if (u < acc) return b.band;
  }
  // Float accumulation can leave `acc` a hair under 1.0; the remainder is the last band, not undefined.
  return SYNTHETIC_AGE_BANDS[SYNTHETIC_AGE_BANDS.length - 1]?.band ?? "65+";
}

function measureAppliesToAge(measureKey: string, ageBand: string): boolean {
  const applicable = Object.hasOwn(AGE_RESTRICTED, measureKey) ? AGE_RESTRICTED[measureKey] : undefined;
  return applicable === undefined || applicable.includes(ageBand);
}

/** The most rows this generator will produce. Above it the id below stops sorting as it claims to. */
export const MAX_ROWS = 999_999;

/**
 * How many rows each tract gets.
 *
 * A floor of `rowsPerTract` for every tract, so nothing a buyer paid for is missing, with any remainder given
 * to the largest tracts first — descending adult population, tract FIPS as the tiebreak so the allocation is
 * deterministic and a buyer can re-derive it.
 *
 * The floor is the whole point. `rowsPerTract * tractCount` rows drawn at random is a bigger file with the same
 * hole in it; only an allocation makes "every tract in your slice is represented" true.
 */
export function allocateRows(tracts: Tract[], rowsPerTract: number, totalRows?: number): number[] {
  if (rowsPerTract < 1) throw new SynthError(`rowsPerTract must be at least 1, got ${rowsPerTract}.`);
  const total = totalRows ?? rowsPerTract * tracts.length;
  if (total > MAX_ROWS) {
    throw new SynthError(
      `${total.toLocaleString()} rows exceeds the ${MAX_ROWS.toLocaleString()} this generator will produce. ` +
        `Lower rowsPerTract or narrow the slice.`,
    );
  }
  if (total < rowsPerTract * tracts.length) {
    throw new SynthError(
      `${total} rows cannot give ${rowsPerTract} to each of ${tracts.length} tracts. The floor is a promise.`,
    );
  }
  const alloc = tracts.map(() => rowsPerTract);
  let remainder = total - rowsPerTract * tracts.length;
  if (remainder > 0) {
    const order = tracts
      .map((t, i) => ({ i, pop: t.totalPop18plus ?? 0, fips: t.tractFips }))
      .sort((a, b) => b.pop - a.pop || a.fips.localeCompare(b.fips));
    for (let k = 0; remainder > 0; k = (k + 1) % order.length) {
      const index = (order[k] as { i: number }).i;
      alloc[index] = (alloc[index] ?? 0) + 1;
      remainder -= 1;
    }
  }
  return alloc;
}

/**
 * The standard error, in percentage points, of one tract's rate at a given row count.
 *
 * ONE definition, read by the preview, the manifest and the card, so the number a buyer is shown before paying
 * cannot drift from the number the file actually supports. Each row's flag is a Bernoulli draw from that
 * tract's published prevalence, so r rows admit only r+1 distinct rates: at r=1 every tract reads exactly 0% or
 * 100%.
 */
export function perTractPrecisionPp(prevalencePercent: number, rowsPerTract: number): number {
  if (rowsPerTract <= 0) return 100;
  const p = Math.min(Math.max(prevalencePercent / 100, 0), 1);
  return Number((Math.sqrt((p * (1 - p)) / rowsPerTract) * 100).toFixed(2));
}

/** Generate the population. The tracts are a source of probabilities and geography labels only. */
export function generateSyntheticPeople(tracts: Tract[], options: SynthesisOptions): SyntheticPerson[] {
  if (tracts.length === 0) throw new SynthError("Cannot generate from an empty slice.");
  if (options.rowCount > MAX_ROWS) {
    throw new SynthError(
      `${options.rowCount.toLocaleString()} rows exceeds the ${MAX_ROWS.toLocaleString()} this generator will ` +
        `produce: the row id is zero-padded to six digits and would stop sorting as it claims.`,
    );
  }
  const sampler = buildSampler(tracts);
  const people: SyntheticPerson[] = [];
  /**
   * Which tract each row belongs to, when a floor was promised.
   *
   * Precomputed as a flat row→tract index. The `uniform(seed, i, field)` streams remain keyed on the same
   * global row index, so tract allocation does not alter how ages and flags are drawn.
   */
  const assigned: Tract[] | null =
    options.rowsPerTract === undefined
      ? null
      : allocateRows(tracts, options.rowsPerTract, options.rowCount).flatMap((n, t) =>
          Array.from({ length: n }, () => tracts[t] as Tract),
        );

  for (let i = 0; i < options.rowCount; i += 1) {
    // A distinct FIELD name per draw, so tract choice, age choice and every flag are independent streams
    // off the same seed.
    const tract = assigned === null ? pickTract(sampler, uniform(options.seed, i, "tract")) : (assigned[i] as Tract);
    const ageBand = pickAgeBand(uniform(options.seed, i, "age"));

    const flags: Record<string, 0 | 1> = {};
    for (const key of options.columns) {
      if (!measureAppliesToAge(key, ageBand)) {
        flags[key] = 0;
        continue;
      }
      const prevalencePercent = tract.values[key as MeasureKey];
      const p = prevalencePercent !== null && Number.isFinite(prevalencePercent) ? prevalencePercent / 100 : 0;
      flags[key] = uniform(options.seed, i, key) < p ? 1 : 0;
    }

    people.push({
      // Zero-padded so ids sort lexicographically the way they sort numerically.
      syntheticPersonId: `syn_${String(i + 1).padStart(6, "0")}`,
      sourceTractFIPS: tract.tractFips,
      sourceCountyName: tract.countyName,
      sourceStateAbbr: tract.stateAbbr,
      ageBand,
      flags,
      isSynthetic: true,
    });
  }

  return people;
}

export function deliverableHeader(columns: string[]): string[] {
  return [
    "synthetic_person_id",
    "source_tract_fips",
    "source_county_name",
    "source_state_abbr",
    "age_band",
    ...columns.map((c) => SYNTHETIC_COLUMN[c] ?? c.toLowerCase()),
    "is_synthetic",
  ];
}

/**
 * Serialize to CSV.
 *
 * `\n` and no BOM, deliberately: the bytes are hashed and the hash is anchored on chain, so anything that
 * varies by platform — line endings, a byte-order mark, trailing whitespace — would make a correct
 * regeneration fail verification.
 */
export function serializeCsv(people: SyntheticPerson[], columns: string[]): Buffer {
  const rows: string[] = [deliverableHeader(columns).join(",")];
  for (const p of people) {
    rows.push(
      [
        p.syntheticPersonId,
        p.sourceTractFIPS,
        // Quoted: county names contain commas ("Miami-Dade", but also "Doña Ana, City of" in some vintages).
        `"${p.sourceCountyName.replace(/"/g, '""')}"`,
        p.sourceStateAbbr,
        p.ageBand,
        ...columns.map((c) => String(p.flags[c] ?? 0)),
        "true",
      ].join(","),
    );
  }
  return Buffer.from(`${rows.join("\n")}\n`, "utf8");
}

export interface MeasureCalibration {
  measure: string;
  /** Population-weighted mean prevalence of the source slice, in percent. */
  targetPercent: number;
  /** Realized rate in the generated file, over the rows in the measure's denominator. */
  realizedPercent: number;
  denominatorRows: number;
  tolerancePp: number;
  withinTolerance: boolean;
}

/**
 * Sampling tolerance for a Bernoulli mean.
 *
 * Three standard errors, floored at 1 percentage point. Derived rather than picked so the check scales
 * with row count: at 1,000 rows a correct generator still misses the target by a percentage point or two,
 * and a fixed tolerance would either fail correct files or pass broken ones.
 */
export function calibrationTolerancePp(targetPercent: number, denominatorRows: number): number {
  if (denominatorRows <= 0) return 100;
  const p = Math.min(Math.max(targetPercent / 100, 0), 1);
  const se = Math.sqrt((p * (1 - p)) / denominatorRows) * 100;
  return Math.max(1, 3 * se);
}

/**
 * Check the generated file against the marginals it claims to reproduce.
 *
 * This is the seller's own pre-delivery check. A file that fails it is a file the seller should not
 * attest to — the buyer was quoted a slice with a published distribution, and delivering one that misses
 * it is delivering something else.
 */
export function calibrate(input: {
  people: SyntheticPerson[];
  tracts: Tract[];
  columns: string[];
}): MeasureCalibration[] {
  const out: MeasureCalibration[] = [];

  /**
   * Rows per tract in the file as generated.
   *
   * The target has to be weighted the way the ROWS were allocated, not the way the population falls. Under the
   * random sampler the two are the same thing, so this is a no-op there. Under a per-tract floor they differ —
   * on the demo slice by 0.14pp for DIABETES — and weighting by population would eventually make the seller's
   * own pre-delivery check reject a correct file.
   */
  const rowsByTract = new Map<string, number>();
  for (const person of input.people) {
    rowsByTract.set(person.sourceTractFIPS, (rowsByTract.get(person.sourceTractFIPS) ?? 0) + 1);
  }

  for (const measure of input.columns) {
    let weighted = 0;
    let weight = 0;
    for (const t of input.tracts) {
      const v = t.values[measure as MeasureKey];
      const rows = rowsByTract.get(t.tractFips) ?? 0;
      if (v !== null && rows > 0) {
        weighted += v * rows;
        weight += rows;
      }
    }
    const targetPercent = weight > 0 ? weighted / weight : 0;

    const denominator = input.people.filter((p) => measureAppliesToAge(measure, p.ageBand));
    const hits = denominator.filter((p) => p.flags[measure] === 1).length;
    const realizedPercent = denominator.length > 0 ? (hits / denominator.length) * 100 : 0;
    const tolerancePp = calibrationTolerancePp(targetPercent, denominator.length);

    out.push({
      measure,
      targetPercent: Number(targetPercent.toFixed(4)),
      realizedPercent: Number(realizedPercent.toFixed(4)),
      denominatorRows: denominator.length,
      tolerancePp: Number(tolerancePp.toFixed(4)),
      withinTolerance: Math.abs(realizedPercent - targetPercent) <= tolerancePp,
    });
  }

  return out;
}

export function isCalibrated(calibrations: MeasureCalibration[]): boolean {
  return calibrations.every((c) => c.withinTolerance);
}
