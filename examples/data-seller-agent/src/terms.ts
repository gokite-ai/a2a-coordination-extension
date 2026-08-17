/**
 * The terms document and its commitment chain (DESIGN §4).
 *
 * `DealContract` v1 is `additionalProperties: false` and §4.1's termsHash
 * covers the contract object and NOTHING else — an external document is
 * outside every signature unless the contract's own text commits to it. So
 * the structured terms live in a demo-private terms document whose JCS
 * digest is embedded, verbatim, inside `acceptanceCriteria`:
 *
 *   signatures → termsHash → contract → acceptanceCriteria
 *              → termsDocumentHash → terms document
 *
 * Changing any field of the terms document changes `termsDocumentHash`,
 * which changes the contract, which is a NEW PROPOSAL under §4.1. The tamper
 * matrix in `test/terms-tamper.test.ts` pins that property field by field.
 *
 * The document format is a demo-private convention, exactly like the
 * examples' negotiation media type: nothing here amends the spec, and the
 * contract's reserved `verifier` / `disclosurePolicy` / `evidenceSchema`
 * members are NOT used (§9.2 reserves their semantics).
 */
import { jcs, sha256Ref } from "./signing.js";

/** The buyer's retention right and the other license terms — usage terms binding the buyer, not availability promises. */
export interface UsageTerms {
  /** Resale of the delivered records. Fixed false for this product. */
  resale: boolean;
  /** Days the BUYER may retain and use the data after license. A license term, not artifact availability. */
  retentionDays: number;
  prohibitedUse: string;
  limitations: string[];
}

/** The itemised rate-card computation the quote disclosed and the seller re-derives at countersign. */
export interface PriceBreakdownCents {
  base: number;
  tracts: number;
  standardColumns: number;
  premiumColumns: number;
  subtotal: number;
}

/**
 * The structured terms behind one deal. Everything a buyer needs to hold the
 * seller to the quote — and everything the seller needs to hold the buyer to
 * the query — pinned by one hash inside the signed contract.
 */
export interface TermsDocument {
  /** Demo-private document format identifier. */
  format: "kite-example-data-deal-terms/v1";
  /** Canonical hash of the buyer's query. */
  criteriaHash: string;
  /** The pre-purchase statistics commitment: sha256 over the quoted whole-slice aggregates. */
  statsHash: string;
  /** Deliverable shape disclosed before purchase. */
  rowsPerTract: number;
  totalRows: number;
  tractCount: number;
  perTractStandardErrorPp: number;
  /** How the deliverable is generated and how the buyer regenerates it. */
  method: "stratified-marginal-bernoulli/v2";
  seedDisclosure: "seed published in the delivery manifest";
  generatorVersion: string;
  /** sha256 of the corpus file the slice was evaluated against. */
  corpusHash: string;
  /** sha256 of the verifier bundle a buyer may load — pinned BEFORE signing, never fetched on trust. */
  verifierHash: string;
  usage: UsageTerms;
  /** How long the seller serves the delivered artifact. Demo-grade and said honestly. */
  artifactAvailability: string;
  priceBreakdownCents: PriceBreakdownCents;
  /** The contract price this breakdown justifies, as the contract spells it (decimal USDC). */
  priceAmount: string;
}

/** JCS digest of the terms document — the inner commitment the contract embeds. */
export function termsDocumentHashOf(doc: TermsDocument): string {
  return sha256Ref(jcs(doc));
}

const ACCEPTANCE_CRITERIA_PREFIX =
  "Delivery matches the terms document with JCS digest ";

/**
 * The `acceptanceCriteria` string carrying the inner commitment. Prose first
 * (it is a contract member humans read), then the two machine-readable facts:
 * the digest and a content-addressed locator (the digest is the path, so the
 * locator can never quietly point at different bytes).
 */
export function buildAcceptanceCriteria(termsDocumentHash: string, locatorBase: string): string {
  const base = locatorBase.endsWith("/") ? locatorBase.slice(0, -1) : locatorBase;
  return (
    `${ACCEPTANCE_CRITERIA_PREFIX}${termsDocumentHash}, ` +
    `served content-addressed at ${base}/terms/${termsDocumentHash}. ` +
    `The delivered CSV regenerates byte-for-byte from the manifest's published seed ` +
    `under the document's pinned generator version, and its manifest satisfies the ` +
    `document's criteriaHash, statsHash and row counts.`
  );
}

export interface AcceptanceCriteriaCommitment {
  termsDocumentHash: string;
  locator: string;
}

/**
 * Extract the inner commitment from a contract's `acceptanceCriteria`, or
 * null when the string carries none (which a countersigning seller treats as
 * a refusal: an unpinned terms document is outside every signature).
 */
export function parseAcceptanceCriteria(acceptanceCriteria: string): AcceptanceCriteriaCommitment | null {
  const m = /(sha256:[0-9a-f]{64}), served content-addressed at (\S+?)\.(?:\s|$)/.exec(acceptanceCriteria);
  if (!m) return null;
  return { termsDocumentHash: m[1]!, locator: m[2]! };
}

/**
 * The check both parties run before trusting a terms document handed to them
 * out-of-band: the document's recomputed digest must equal the one the SIGNED
 * contract pins. A document that fails this is not "the terms, modified" —
 * it is not the terms at all.
 */
export function termsDocumentMatchesContract(
  doc: TermsDocument,
  contract: { acceptanceCriteria: string },
): boolean {
  const commitment = parseAcceptanceCriteria(contract.acceptanceCriteria);
  return commitment !== null && termsDocumentHashOf(doc) === commitment.termsDocumentHash;
}
