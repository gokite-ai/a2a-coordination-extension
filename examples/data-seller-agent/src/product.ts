/**
 * Product-level quote, disclosure, and validation logic (DESIGN §7).
 *
 * Public golden fixtures pin `composeQuote` outputs for pricing, sample
 * statistics, and delivery expectations. Other exports have narrower roles
 * and are not all part of that golden-fixture contract.
 */
import { createHash } from "node:crypto";
import {
  aggregateStats,
  assertCardMatchesCorpus as engineAssertCardMatchesCorpus,
  evaluateQuery,
  priceQuery,
  sampleRows,
  statsCommitment,
  validateQuery,
  type AggregateStats,
  type Corpus,
  type Price,
  type Query,
  type RateCardTerms,
  type Rejection,
} from "./engine/places.js";
import { perTractPrecisionPp } from "./engine/synth.js";

export type { RateCardTerms } from "./engine/places.js";

/** The card's published deliverable density and its bounds. */
export interface DensityTerms {
  rowsPerTractDefault: number;
  rowsPerTractMin: number;
  rowsPerTractMax: number;
}

/** Stable hash of the buyer's query. Pins down exactly what was ordered. */
export function criteriaHashOf(query: unknown): string {
  if (query === null || typeof query !== "object") return `sha256:${createHash("sha256").update("{}").digest("hex")}`;
  const q = query as Record<string, unknown>;
  // Canonical: sorted keys and sorted arrays, so two identical queries written differently pin the same
  // criteria. The delivery manifest computes this the same way and the two are compared.
  const canonical = {
    columns: [...((q["columns"] as string[]) ?? [])].sort(),
    states: [...((q["states"] as string[]) ?? [])].sort(),
    counties: [...((q["counties"] as string[]) ?? [])].sort(),
    minPopulation: q["minPopulation"] ?? null,
    thresholds: q["thresholds"] ?? {},
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/**
 * Coerce an untrusted request body into a Query.
 *
 * Deliberately narrow rather than forgiving: anything of the wrong type becomes absent, so a malformed filter
 * reaches `validateQuery` and earns a named rejection code instead of being silently dropped and quietly
 * widening the slice a buyer thought they had narrowed.
 */
export function readQuery(body: unknown): Query {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

  const thresholds =
    typeof b["thresholds"] === "object" && b["thresholds"] !== null
      ? (b["thresholds"] as Record<string, { min?: number; max?: number }>)
      : undefined;

  return {
    // Deduplicated at the boundary too, so the tract count, the sample projection and the price all describe
    // the same column set. `priceQuery` dedupes independently; this is not redundant, it is the difference
    // between one guard and one guard per consumer.
    columns: [...new Set(strArray(b["columns"]) ?? [])],
    // Deduped like columns. A body repeating one state 500 times produced a 500-entry rejection list — a 24x
    // amplification of the request, on an unauthenticated route.
    ...(strArray(b["states"]) !== undefined ? { states: [...new Set(strArray(b["states"]))] } : {}),
    ...(strArray(b["counties"]) !== undefined ? { counties: [...new Set(strArray(b["counties"]))] } : {}),
    // Passed through even when it is not an integer, so POPULATION_FILTER_UNSUPPORTED can fire.
    ...(b["minPopulation"] !== undefined ? { minPopulation: b["minPopulation"] as number } : {}),
    ...(thresholds !== undefined ? { thresholds } : {}),
  };
}

/**
 * The density this quote is priced and generated at.
 *
 * Clamped to the bounds the card publishes rather than rejected: a preview is free, and an out-of-range
 * number is better answered with the shape actually on offer.
 */
export function densityAsked(body: unknown, density: DensityTerms): number {
  const requested = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const asked = Number(requested["rowsPerTract"] ?? density.rowsPerTractDefault ?? 1);
  return Math.min(
    Math.max(Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1, density.rowsPerTractMin),
    density.rowsPerTractMax,
  );
}

export interface QuoteRefused {
  accepted: false;
  /** Named refusals — the card publishes all the codes, and a buyer that
   *  cannot tell "no matches" from "malformed" cannot fix their query. */
  rejections: Rejection[];
}

export interface QuoteBody {
  accepted: true;
  rejections: [];
  tractCount: number;
  /** An empty slice is refused rather than priced. Charging the base fee and
   *  column fees for zero tracts would bill for an empty deliverable. */
  priceable: boolean;
  price: Price | null;
  zeroYieldStates: string[];
  sample: Array<Record<string, unknown>>;
  stats: AggregateStats;
  deliverable: {
    unit: string;
    rowsPerTract: number;
    rowCount: number;
    tractCount: number;
    everyTractRepresented: true;
    /** The honest figure rather than an adjective: what one tract's rate is worth at this density. */
    perTractStandardErrorPp: Record<string, number>;
    perTractRatesSupported: false;
    note: string;
  } | null;
  note: string;
}

export interface QuoteAccepted {
  accepted: true;
  tractCount: number;
  rowsPerTract: number;
  deliverableRowCount: number;
  /** The commitment re-checked at delivery. Only the signed terms document carries it. */
  statsHash?: string;
  criteriaHash: string;
  /** One-line summary in this seller's own units. */
  summary: string;
  body: QuoteBody;
}

export type QuoteFacts = QuoteRefused | QuoteAccepted;

/**
 * Everything one query is worth: rejections, or the priced, sampled,
 * committed quote. ONE aggregate pass, read by the stats block, by the
 * precision figures and by the commitment, so one response cannot derive
 * inconsistent aggregates from repeated passes.
 */
export function composeQuote(input: {
  corpus: Corpus;
  /** The untrusted request body. */
  body: unknown;
  rateCard: RateCardTerms;
  density: DensityTerms;
}): QuoteFacts {
  const q = readQuery(input.body);
  const rejections = validateQuery(q, input.corpus);
  // A named refusal rather than a silent empty result.
  if (rejections.length > 0) return { accepted: false, rejections };

  const matched = evaluateQuery(q, input.corpus);
  const tractCount = matched.tracts.length;
  const rowsPerTract = densityAsked(input.body, input.density);
  const stats = aggregateStats(matched.tracts, q.columns);
  const price =
    tractCount === 0
      ? null
      : priceQuery({
          tractCount,
          columns: q.columns,
          // Read field by field rather than spread: a missing term must become an explicit zero here
          // rather than `undefined` inside an arithmetic that would quietly produce a price of `$NaN`.
          terms: {
            baseCents: Number(input.rateCard.baseCents ?? 0),
            perTractMicroCents: Number(input.rateCard.perTractMicroCents ?? 0),
            perStandardColumnCents: Number(input.rateCard.perStandardColumnCents ?? 0),
            perPremiumColumnCents: Number(input.rateCard.perPremiumColumnCents ?? 0),
            vintageMultiplierBps: Number(input.rateCard.vintageMultiplierBps ?? 10_000),
          },
        });
  // No statistics for an empty slice, so nothing to commit to. Pinning a hash of nothing would make the
  // delivery-time re-check pass by construction.
  const commitment = tractCount === 0 ? undefined : statsCommitment({ stats, query: q });

  const rowCount = rowsPerTract * tractCount;
  return {
    accepted: true,
    tractCount,
    rowsPerTract,
    deliverableRowCount: rowCount,
    ...(commitment === undefined ? {} : { statsHash: commitment.statsHash }),
    criteriaHash: criteriaHashOf(input.body),
    summary:
      `I can provide a ${rowCount.toLocaleString("en-US")}-row synthetic dataset over ` +
      `${tractCount.toLocaleString("en-US")} tracts — every tract represented. ` +
      `List price ${price?.listAmountDisplay ?? "—"}.`,
    body: {
      accepted: true,
      rejections: [],
      tractCount,
      priceable: tractCount > 0,
      price,
      zeroYieldStates: matched.zeroYieldStates,
      sample: sampleRows(matched.tracts, q.columns),
      stats,
      /**
       * The SHAPE of the file, before any money moves.
       *
       * This block exists because its absence cost a buyer a purchase: a preview priced 7,917 tracts and
       * reported aggregates over all of them, while the deliverable was a fixed 1,000-row cohort in which
       * 88% of those tracts appeared zero times — and the first place that was visible was the manifest,
       * after funding. The engine knew the number the whole time.
       */
      deliverable:
        tractCount === 0
          ? null
          : {
              unit: "synthetic person, one row each",
              rowsPerTract,
              rowCount,
              tractCount,
              everyTractRepresented: true,
              perTractStandardErrorPp: Object.fromEntries(
                q.columns.map((measure) => [
                  measure,
                  perTractPrecisionPp(stats.perMeasure[measure]?.mean ?? 0, rowsPerTract),
                ]),
              ),
              perTractRatesSupported: false,
              note:
                `Every one of the ${tractCount.toLocaleString()} matched tracts gets ${rowsPerTract} ` +
                `row(s). One tract's rate at that density carries the standard error above, so this file is for ` +
                `person-level work over the slice — not for ranking individual tracts. For a tract's own rate, ` +
                `read the published CDC PLACES value: it is this file's input and it is free.`,
            },
      // Deliberately absent from the BODY: statsHash. That is a commitment re-checked at delivery, and
      // commitments enter only the signed terms document. It is returned beside the body, where only the
      // agreement path reads it.
      note:
        tractCount === 0
          ? "No tracts match. Nothing is priced, because an empty slice is not a product."
          : "Free and non-committal. A committed quote is the one pinned into signed terms.",
    },
  };
}

/**
 * Check the card against the corpus actually loaded, at boot.
 *
 * The card makes falsifiable claims about the data — tract count, per-measure
 * unavailable states, tiers — and a service that serves a signed card whose
 * claims its own data contradicts is worse than one with no card, so this
 * refuses at startup rather than warning.
 */
export function checkCardAgainstCorpus(input: {
  corpus: Corpus;
  cardTracts: number;
  cardStates: number;
  cardUnavailable: Record<string, string[]>;
  cardTiers?: Record<string, string> | undefined;
}): void {
  engineAssertCardMatchesCorpus(input);
}
