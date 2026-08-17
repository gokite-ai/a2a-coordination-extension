/**
 * The delivery pipeline.
 *
 * Generation is a **deterministic reaction to a finalized funding observation**, not a request and not a
 * judgement. The brain is not consulted: the content is refused unless it equals the commitment made at
 * quote time, so there is nothing left to decide, and gating it on a subprocess would put a 3600-second
 * deadline behind a model.
 *
 * The manifest is the buyer's verification kit. It publishes the seed on purpose — the seed is not a
 * secret, it is what lets a buyer regenerate the file and check the bytes against the attested hash
 * without trusting the seller at all.
 *
 * One thing the manifest deliberately does NOT carry: any pricing block. Price is committed by the signed
 * terms and DealContract and is recomputed before countersigning; the manifest commits only to delivery.
 */
import { createHash } from "node:crypto";
import {
  evaluateQuery,
  aggregateStats,
  statsCommitment,
  type Corpus,
  type Query,
} from "./places.js";
import {
  generateSyntheticPeople,
  serializeCsv,
  calibrate,
  isCalibrated,
  deliverableHeader,
  perTractPrecisionPp,
  type MeasureCalibration,
} from "./synth.js";
import type { ArtifactStore, StoredArtifact } from "./store.js";
/**
 * §4.2 defines `deliveryHash` as the sha256 content hash of the artifact
 * registered through the `evidence` interaction. Both parties derive the
 * value from the same manifest bytes; it is protocol, not product policy.
 * Here that artifact is the delivery manifest itself — its canonical bytes
 * are what the seller registers, serves, and hashes, so the anchor is one
 * hash over one byte string, computed by `jcs` + sha256 like every other
 * commitment in this example (DESIGN §5).
 */
import { jcs } from "../signing.js";
import { sha256Bytes } from "./store.js";

export class DeliveryError extends Error {}

const GENERATOR_ALGORITHM = "stratified-marginal-bernoulli/v2";

export interface DeliveryManifest {
  dealId: string;
  productId: string;
  /** The query that produced the slice, canonicalized. */
  criteria: Record<string, unknown>;
  criteriaHash: string;
  /** Aggregates over the source slice. Re-checked against the quote-time commitment. */
  sourceStatsHash: string;
  /** Committed BEFORE payment and re-checked here. The buyer's defence against slab substitution. */
  quotedStatsHash: string | null;
  statsMatchQuote: boolean;
  rowCount: number;
  /**
   * The per-tract floor, and what it buys.
   *
   * In the manifest rather than beside it, because `manifestHash` covers the manifest and a density claim the
   * buyer cannot check is a claim. Optional at the parsing boundary; the public v2 verifier requires it.
   */
  density?:
    | {
        rowsPerTract: number;
        tractCount: number;
        tractsWithRows: number;
        minRowsPerTract: number;
        /** Standard error of ONE tract's rate at this density, per purchased measure, in percentage points. */
        perTractStandardErrorPp: Record<string, number>;
      }
    | undefined;
  columns: string[];
  header: string[];
  /** Published on purpose: this is what makes the delivery verifiable. */
  seed: string;
  generator: {
    algorithm: string;
    prng: string;
    weighting: string;
    /** Restated from the card so a buyer reading only the manifest is not misled. */
    limitations: string[];
  };
  calibration: MeasureCalibration[];
  calibrated: boolean;
  artifact: StoredArtifact;
  generatedAt: string;
}

export interface DeliveryResult {
  manifest: DeliveryManifest;
  /**
   * The manifest's canonical (RFC 8785) bytes — what the seller registers as
   * the evidence artifact and serves at the evidence URL. Serve THESE bytes,
   * never a re-serialization: a fetched copy that hashes differently is not
   * this evidence.
   */
  manifestBytes: Buffer;
  /**
   * §4.2's `deliveryHash`: the sha256 content hash of the registered
   * artifact (the manifest bytes above), `sha256:<hex>`. Its 32 raw digest
   * bytes are the `bytes32 deliveryHash` the EIP-712 Delivery struct commits
   * to and the vault's `markDelivered` receives.
   */
  deliveryHash: string;
  /** The deliverable CSV. Its own hash is inside the manifest (`artifact.contentHash`). */
  bytes: Buffer;
}

function isValidV2Density(value: unknown): value is NonNullable<DeliveryManifest["density"]> {
  if (typeof value !== "object" || value === null) return false;
  const rowsPerTract = (value as { rowsPerTract?: unknown }).rowsPerTract;
  return (
    typeof rowsPerTract === "number" &&
    Number.isFinite(rowsPerTract) &&
    Number.isInteger(rowsPerTract) &&
    rowsPerTract >= 1
  );
}

/**
 * The deliverable seed.
 *
 * Derived from a per-agent secret and the deal id, so it is stable across restarts (a buyer can always
 * re-derive) but **not** guessable before the deal exists. A secret-free seed such as `${dealId}:v1`
 * would let anyone who knows the deal id generate the paid file before paying for it.
 */
export function deliverableSeed(input: { secret: string; dealId: string }): string {
  return createHash("sha256").update(`${input.secret}|${input.dealId}|v2`).digest("hex");
}

/**
 * Generate, store and describe the deliverable.
 *
 * Refuses rather than delivering something else if the slice no longer matches what was quoted. The
 * corpus can be refreshed between quote and delivery, and a silently different slice is the substitution
 * the `statsHash` commitment exists to catch — so it is caught here, on the seller's own side, before
 * anything is anchored.
 */
export async function generateDelivery(input: {
  dealId: string;
  productId: string;
  query: Query;
  corpus: Corpus;
  /**
   * Rows for every tract in the slice, guaranteed.
   *
   * The row count is DERIVED from it and the matched tract count rather than passed in, because the two must
   * agree: a free-floating 1,000 against a 7,917-tract slice is what left 88% of a buyer's purchase absent from
   * the file it paid for.
   */
  rowsPerTract: number;
  seed: string;
  storage: ArtifactStore;
  /**
   * Where the buyer will actually FETCH the deliverable. The manifest is the
   * buyer's only map to the artifact — a live seller passes its
   * capability-gated CSV URL here, because the storage backend's own locator
   * (e.g. `memory:`) resolves for nobody outside this process. Covered by
   * `manifestHash`, so it is pinned the moment the delivery is anchored.
   */
  artifactLocator?: string | undefined;
  /** The statsHash committed in the signed quote, when there is one. */
  quotedStatsHash?: string | undefined;
  now: () => string;
}): Promise<DeliveryResult> {
  const matched = evaluateQuery(input.query, input.corpus);
  if (matched.tracts.length === 0) {
    throw new DeliveryError(`Deal ${input.dealId} matches no tracts. There is nothing to deliver.`);
  }

  const stats = aggregateStats(matched.tracts, input.query.columns);
  const { statsHash, criteriaHash } = statsCommitment({ stats, query: input.query });

  const statsMatchQuote = input.quotedStatsHash === undefined || input.quotedStatsHash === statsHash;
  if (!statsMatchQuote) {
    throw new DeliveryError(
      `The slice has changed since the quote: committed ${input.quotedStatsHash}, now ${statsHash}. ` +
        `Refusing to deliver a different slice under the same agreement.`,
    );
  }

  const rowCount = input.rowsPerTract * matched.tracts.length;
  const people = generateSyntheticPeople(matched.tracts, {
    rowCount,
    rowsPerTract: input.rowsPerTract,
    seed: input.seed,
    columns: input.query.columns,
  });
  const bytes = serializeCsv(people, input.query.columns);
  const calibration = calibrate({ people, tracts: matched.tracts, columns: input.query.columns });

  // A file that misses the marginals it claims to reproduce is not the product that was quoted. The
  // seller refuses its own output here rather than letting the buyer discover it.
  if (!isCalibrated(calibration)) {
    const off = calibration.filter((c) => !c.withinTolerance);
    throw new DeliveryError(
      `Generated file is not calibrated: ${off
        .map((c) => `${c.measure} realized ${c.realizedPercent}% vs target ${c.targetPercent}% (±${c.tolerancePp}pp)`)
        .join("; ")}`,
    );
  }

  const artifact = await input.storage.put({
    bytes,
    dealId: input.dealId,
    filename: `${input.dealId}.csv`,
  });
  if (input.artifactLocator !== undefined) {
    artifact.locator = input.artifactLocator;
  }

  const manifest: DeliveryManifest = {
    dealId: input.dealId,
    productId: input.productId,
    criteria: {
      columns: [...input.query.columns].sort(),
      states: [...(input.query.states ?? [])].sort(),
      counties: [...(input.query.counties ?? [])].sort(),
      minPopulation: input.query.minPopulation ?? null,
      thresholds: input.query.thresholds ?? {},
    },
    criteriaHash,
    sourceStatsHash: statsHash,
    quotedStatsHash: input.quotedStatsHash ?? null,
    statsMatchQuote,
    rowCount,
    density: {
      rowsPerTract: input.rowsPerTract,
      tractCount: matched.tracts.length,
      tractsWithRows: new Set(people.map((person) => person.sourceTractFIPS)).size,
      minRowsPerTract: input.rowsPerTract,
      perTractStandardErrorPp: Object.fromEntries(
        input.query.columns.map((measure) => [
          measure,
          perTractPrecisionPp(stats.perMeasure[measure]?.mean ?? 0, input.rowsPerTract),
        ]),
      ),
    },
    columns: [...input.query.columns],
    header: deliverableHeader(input.query.columns),
    seed: input.seed,
    generator: {
      // The exact identifier is part of the verifier contract. A new algorithm needs a dedicated path.
      algorithm: GENERATOR_ALGORITHM,
      prng: "sha256(seed|rowIndex|field), top 48 bits / 2^48 — counter-based, every draw independently addressable",
      weighting: `every tract gets ${input.rowsPerTract} row(s); any remainder goes to the largest tracts first, by TotalPop18plus`,
      limitations: [
        "Marginal prevalences are reproduced; the JOINT distribution is not. Measure flags are drawn " +
          "independently, so co-morbidity is absent. NOT sound for co-morbidity rates, multivariate " +
          "models, or any interaction term.",
        // The card must disclose this per-tract limitation explicitly.
        `Each row's flags are Bernoulli draws from ONE tract's published prevalence, so a tract represented by ` +
          `${input.rowsPerTract} row(s) admits only ${input.rowsPerTract + 1} distinct rates for any measure. ` +
          `This file is sound for slice-level marginals and for person-level work over many tracts; it is NOT ` +
          `sound for ranking or comparing individual tracts. For a tract's own rate, read the published CDC ` +
          `PLACES value — it is this file's input, and no number of synthetic rows improves on it.`,
        "age_band is illustrative, not estimated. PLACES publishes no age breakdown.",
        "ACCESS2 has an 18-64 denominator and is therefore always 0 for 65+ rows.",
      ],
    },
    calibration,
    calibrated: true,
    artifact,
    generatedAt: input.now(),
  };

  const manifestBytes = Buffer.from(jcs(manifest));
  const deliveryHash = sha256Bytes(manifestBytes);

  return { manifest, manifestBytes, deliveryHash, bytes };
}

/**
 * The buyer's verification, implemented so the e2e can actually perform it.
 *
 * Regenerates from the published seed and compares byte-for-byte. This is the whole reason the seed is in
 * the manifest: a buyer who can reproduce the file does not have to trust that they were sent the right
 * one, and a seller who substitutes data is caught by arithmetic rather than by argument.
 */
export function verifyDelivery(input: {
  manifest: DeliveryManifest;
  received: Buffer;
  corpus: Corpus;
  query: Query;
}): { ok: boolean; problems: string[]; regeneratedHash: string | null } {
  const problems: string[] = [];

  const receivedHash = `sha256:${createHash("sha256").update(input.received).digest("hex")}`;
  if (receivedHash !== input.manifest.artifact.contentHash) {
    problems.push(`received bytes hash ${receivedHash}, manifest says ${input.manifest.artifact.contentHash}`);
  }

  const matched = evaluateQuery(input.query, input.corpus);
  // Dispatch by the exact public algorithm identifier. A new version must add its own implementation;
  // it must never fall through to whichever generator happens to be current.
  const supportedAlgorithm = input.manifest.generator.algorithm === GENERATOR_ALGORITHM;
  const density: unknown = input.manifest.density;
  const validDensity = isValidV2Density(density);
  if (!supportedAlgorithm) {
    problems.push(`unsupported generator algorithm ${input.manifest.generator.algorithm}`);
  }
  if (!validDensity) {
    problems.push(`${GENERATOR_ALGORITHM} requires density.rowsPerTract to be a finite integer >= 1`);
  }
  if (!supportedAlgorithm || !validDensity) {
    return { ok: false, problems, regeneratedHash: null };
  }

  const people = generateSyntheticPeople(matched.tracts, {
    rowCount: input.manifest.rowCount,
    rowsPerTract: density.rowsPerTract,
    seed: input.manifest.seed,
    columns: input.manifest.columns,
  });
  const regenerated = serializeCsv(people, input.manifest.columns);
  const regeneratedHash = `sha256:${createHash("sha256").update(regenerated).digest("hex")}`;

  if (regeneratedHash !== input.manifest.artifact.contentHash) {
    problems.push(
      `regenerating from the published seed produced ${regeneratedHash}, not ` +
        `${input.manifest.artifact.contentHash} — the file is not what the manifest describes`,
    );
  }

  // The slab-substitution check: the aggregates the buyer was quoted must be the aggregates the delivered
  // slice actually has.
  const stats = aggregateStats(matched.tracts, input.manifest.columns);
  const { statsHash } = statsCommitment({ stats, query: input.query });
  if (statsHash !== input.manifest.sourceStatsHash) {
    problems.push(`source stats hash ${statsHash} does not match the manifest's ${input.manifest.sourceStatsHash}`);
  }
  if (input.manifest.quotedStatsHash !== null && input.manifest.quotedStatsHash !== input.manifest.sourceStatsHash) {
    problems.push("manifest admits the delivered slice differs from the quoted one");
  }

  if (!input.manifest.calibrated) problems.push("manifest reports the file is not calibrated");

  return { ok: problems.length === 0, problems, regeneratedHash };
}
