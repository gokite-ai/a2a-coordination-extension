/**
 * The seller's business layer: quotes, deals, delivery, artifact access.
 *
 * Everything here is process-local and non-durable — the same demo boundary
 * `seller-agent/` documents for its executor state. What outlives the
 * process is exactly what the protocol makes outlive it: signed contracts,
 * registered evidence, and anchored hashes.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlaces, type Corpus } from "./engine/places.js";
import { deliverableSeed, generateDelivery, type DeliveryManifest } from "./engine/deliver.js";
import { MemoryArtifactStore } from "./engine/store.js";
import {
  checkCardAgainstCorpus,
  composeQuote,
  criteriaHashOf,
  readQuery,
  type DensityTerms,
  type QuoteFacts,
  type RateCardTerms,
} from "./product.js";
import {
  buildAcceptanceCriteria,
  parseAcceptanceCriteria,
  termsDocumentHashOf,
  type TermsDocument,
} from "./terms.js";
import {
  coordinationEndpoint,
  SELLER_AGENT_ID,
  SELLER_PAYOUT_ADDRESS,
  acceptTerms,
  deliveredCommand,
  demoAnchors,
  evidenceEnvelope,
  type SettlementAnchors,
} from "./extension.js";
import { addressOfPrivateKey, keyIdOf, sha256Ref, termsHashOf, utf8 } from "./signing.js";
import cardParams from "./card-params.json" with { type: "json" };

type Json = Record<string, unknown>;

const BUYER_DID_PATTERN =
  /^did:kite:[a-z0-9]([a-z0-9_-]*[a-z0-9])?:[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;

export const GENERATOR_VERSION = "stratified-marginal-bernoulli/v2 (data-seller-agent 0.0.1)";

/** The files a buyer loads to verify a delivery, hashed in this exact order (demo convention). */
const VERIFIER_BUNDLE_FILES = [
  "verifier.ts",
  "engine/deliver.ts",
  "engine/synth.ts",
  "engine/places.ts",
  "engine/hash.ts",
  "engine/store.ts",
] as const;

/**
 * The digest the terms document pins as `verifierHash`: sha256 over the
 * verifier bundle's files, each length-prefixed with its name — so the buyer
 * checks the code BEFORE executing it (DESIGN §5), and a changed generator is
 * a changed hash, hence new terms.
 */
export function verifierBundleHash(srcDir: string = new URL(".", import.meta.url).pathname): string {
  const h = createHash("sha256");
  for (const f of VERIFIER_BUNDLE_FILES) {
    const bytes = readFileSync(join(srcDir, f));
    h.update(`${f}:${bytes.length}:`);
    h.update(bytes);
  }
  return `sha256:${h.digest("hex")}`;
}

export interface QuoteRecord {
  negotiationId: string;
  buyerAgentId: string;
  termsDocument: TermsDocument;
  termsDocumentHash: string;
  /** The exact untrusted body the quote priced; delivery regenerates this slice. */
  queryBody: Json;
  facts: Extract<QuoteFacts, { accepted: true }>;
  issuedAt: string;
  /** Query/quote exchange copied into the deal that ultimately selects it. */
  history: AgreementHistoryEntry[];
}

export type NegotiationState = "QUOTED" | "REFUSED" | "AGREEMENT_STARTED";

/**
 * One pre-agreement buyer/seller exchange. The buyer DID is self-declared at
 * query time. It becomes agreement-authenticated only after a matching signed
 * contract selects this negotiation and the seller validates and countersigns
 * that contract.
 */
export interface NegotiationRecord {
  negotiationId: string;
  buyerAgentId: string;
  state: NegotiationState;
  queryBody: Json;
  createdAt: string;
  updatedAt: string;
  termsDocumentHash?: string;
  dealIds: string[];
  history: AgreementHistoryEntry[];
}

export type DealState = "PROPOSED_LOCAL" | "ACCEPTED_LOCAL" | "DELIVERED_LOCAL";

export type AgreementHistoryPhase =
  | "negotiation"
  | "formation"
  | "funding"
  | "fulfillment"
  | "settlement";

export type AgreementHistoryDirection =
  | "buyer-to-seller"
  | "seller-to-buyer"
  | "buyer-to-runtime"
  | "seller-to-runtime"
  | "runtime-to-seller"
  | "system";

/** One immutable, process-local snapshot in the buyer/seller interaction log. */
export interface AgreementHistoryEntry {
  sequence: number;
  at: string;
  phase: AgreementHistoryPhase;
  direction: AgreementHistoryDirection;
  kind: string;
  summary: string;
  state?: string;
  payload?: Json;
}

export interface DealRecord {
  dealId: string;
  negotiationId: string;
  state: DealState;
  /** Latest state read from the Coordination Runtime, when live mode is active. */
  runtimeState?: string;
  runtimeRevision?: number;
  termsDocumentHash: string;
  buyerAddress: string;
  contract: Json;
  createdAt: string;
  updatedAt: string;
  history: AgreementHistoryEntry[];
  capabilityToken?: string;
  capabilityRevoked?: boolean;
  manifest?: DeliveryManifest;
  manifestBytes?: Buffer;
  deliveryHash?: string;
  csvBytes?: Buffer;
}

export interface BuyerRecord {
  buyerAgentId: string;
  firstSeenAt: string;
  updatedAt: string;
  negotiations: NegotiationRecord[];
  deals: DealRecord[];
}

export interface SellerConfig {
  privateKey: Uint8Array;
  /** Where this seller serves HTTP (terms documents, delivered artifacts). */
  publicUrl: string;
  corpusPath: string;
  seedSecret: string;
}

export class DataSeller {
  readonly keyId: string;
  readonly address: string;
  readonly rateCard: RateCardTerms;
  readonly density: DensityTerms;
  readonly verifierHash: string;
  corpus!: Corpus;
  corpusHash!: string;
  private readonly negotiations = new Map<string, NegotiationRecord>();
  /** Accepted quotes keyed by negotiation id, not terms hash: two buyers may receive identical terms. */
  private readonly quotes = new Map<string, QuoteRecord>();
  private readonly deals = new Map<string, DealRecord>();
  private readonly store = new MemoryArtifactStore();
  private historySequence = 0;

  // All stores are process-local and demo-scoped, but their growth is driven
  // by the OTHER side: /query is unauthenticated (negotiations and quotes),
  // submit-proposal costs the buyer nothing until funding (deals), and a
  // chatty counterparty can keep a committed deal talking (history). The
  // negotiation cap alone is not enough — a proposal pins its quote, so
  // query+propose in a loop would grow the negotiation and deal maps past a
  // negotiation-only cap.
  // Deals still in formation are therefore reclaimable (TTL, then
  // oldest-first over the cap); negotiations evict oldest-first, skipping
  // any one a surviving deal still resolves through; history trims from the
  // front, keeping the recent tail (sequence numbers make the trim visible).
  // Deals past formation — funded or fulfilling on a Runtime — are never
  // reclaimed: the counterparty paid for those.
  private static readonly MAX_OPEN_NEGOTIATIONS = 1024;
  private static readonly MAX_RECLAIMABLE_DEALS = 1024;
  private static readonly RECLAIMABLE_DEAL_TTL_MS = 15 * 60 * 1000;
  private static readonly MAX_HISTORY_ENTRIES_PER_DEAL = 512;

  private pruneNegotiations(justIssued: string): void {
    if (this.negotiations.size <= DataSeller.MAX_OPEN_NEGOTIATIONS) return;
    const referenced = new Set<string>();
    for (const deal of this.deals.values()) referenced.add(deal.negotiationId);
    // The negotiation this very call minted is not referenced YET — its proposal
    // has not arrived — but evicting it would break the exchange in flight.
    referenced.add(justIssued);
    for (const negotiationId of this.negotiations.keys()) {
      if (this.negotiations.size <= DataSeller.MAX_OPEN_NEGOTIATIONS) return;
      if (referenced.has(negotiationId)) continue;
      this.negotiations.delete(negotiationId);
      this.quotes.delete(negotiationId);
    }
  }

  /**
   * A deal that never left formation is the counterparty's to abandon:
   * locally still PROPOSED/ACCEPTED and, when a Runtime has seen it at all,
   * not yet past PROPOSED (or already terminal without ever being funded).
   * Anything the Runtime reports as COMMITTED or later survives every prune.
   */
  private isReclaimableDeal(deal: DealRecord): boolean {
    if (
      deal.runtimeState !== undefined &&
      !["PROPOSED", "EXPIRED", "CANCELLED"].includes(deal.runtimeState)
    ) {
      return false;
    }
    return deal.state === "PROPOSED_LOCAL" || deal.state === "ACCEPTED_LOCAL";
  }

  private deleteDeal(dealId: string): void {
    const deal = this.deals.get(dealId);
    if (deal === undefined) return;
    this.deals.delete(dealId);
    const negotiation = this.negotiations.get(deal.negotiationId);
    if (negotiation === undefined) return;
    negotiation.dealIds = negotiation.dealIds.filter((id) => id !== dealId);
    if (negotiation.dealIds.length === 0) negotiation.state = "QUOTED";
  }

  private pruneDeals(): void {
    const now = Date.now();
    const reclaimable: string[] = [];
    for (const [dealId, deal] of this.deals) {
      if (!this.isReclaimableDeal(deal)) continue;
      if (now - Date.parse(deal.updatedAt) > DataSeller.RECLAIMABLE_DEAL_TTL_MS) {
        this.deleteDeal(dealId);
        continue;
      }
      reclaimable.push(dealId);
    }
    // Runs BEFORE the caller inserts its new deal, so prune to cap-1: after
    // the insert, reclaimable deals number at most MAX_RECLAIMABLE_DEALS.
    const excess = reclaimable.length - (DataSeller.MAX_RECLAIMABLE_DEALS - 1);
    for (const dealId of reclaimable.slice(0, Math.max(0, excess))) {
      this.deleteDeal(dealId);
    }
  }

  /** Store occupancy, for tests and the admin surface. */
  storeSizes(): { negotiations: number; quotes: number; deals: number } {
    return {
      negotiations: this.negotiations.size,
      quotes: this.quotes.size,
      deals: this.deals.size,
    };
  }

  constructor(private readonly config: SellerConfig) {
    this.keyId = keyIdOf(SELLER_AGENT_ID, config.privateKey);
    this.address = addressOfPrivateKey(config.privateKey);
    const rc = (cardParams as Json)["rateCard"] as Json;
    this.rateCard = {
      baseCents: Number(rc["baseCents"]),
      perTractMicroCents: Number(rc["perTractMicroCents"]),
      perStandardColumnCents: Number(rc["perStandardColumnCents"]),
      perPremiumColumnCents: Number(rc["perPremiumColumnCents"]),
      vintageMultiplierBps: Number(rc["vintageMultiplierBps"]),
    };
    const d = (cardParams as Json)["deliverable"] as Json;
    this.density = {
      rowsPerTractDefault: Number(d["rowsPerTractDefault"]),
      rowsPerTractMin: Number(d["rowsPerTractMin"]),
      rowsPerTractMax: Number(d["rowsPerTractMax"]),
    };
    this.verifierHash = verifierBundleHash();
  }

  /**
   * Load the corpus and refuse to serve a card the data contradicts. A signed
   * card whose claims its own data contradicts is worse than no card. The
   * fixture corpus is a CA+NY subset, so the check runs against the CORPUS's
   * own totals here and the full-release figures stay in the card's dataset
   * disclosure as claims about the upstream release, not about this demo
   * subset.
   */
  async boot(): Promise<void> {
    const raw = readFileSync(this.config.corpusPath);
    this.corpusHash = sha256Ref(raw);
    let csvPath = this.config.corpusPath;
    if (csvPath.endsWith(".gz")) {
      const dir = mkdtempSync(join(tmpdir(), "corpus-"));
      csvPath = join(dir, "places.csv");
      writeFileSync(csvPath, gunzipSync(raw));
    }
    this.corpus = await loadPlaces(csvPath);
    const dataset = (cardParams as Json)["dataset"] as Json;
    const measures = (dataset["measures"] as Json[]) ?? [];
    checkCardAgainstCorpus({
      corpus: this.corpus,
      cardTracts: this.corpus.totals.tracts,
      cardStates: this.corpus.totals.states,
      cardUnavailable: Object.fromEntries(
        measures.map((m) => [String(m["key"]), this.corpus.unavailableStates[String(m["key"]) as never] ?? []]),
      ),
      cardTiers: Object.fromEntries(measures.map((m) => [String(m["key"]), String(m["tier"])])),
    });
  }

  /** The demo caveat, verbatim from the examples' README: in-band identity
   *  exchange stands in for Kite Identity DID resolution (§8). */
  identityBlock(): Json {
    return {
      sellerAgentId: SELLER_AGENT_ID,
      sellerAddress: this.address,
      sellerKeyId: this.keyId,
      payoutAddress: SELLER_PAYOUT_ADDRESS,
      coordinationEndpoint: coordinationEndpoint(),
      note: "in-band identity exchange is a demo stand-in for Kite Identity DID resolution (§8)",
    };
  }

  private historyEntry(
    input: Omit<AgreementHistoryEntry, "sequence" | "at"> & { at?: string },
  ): AgreementHistoryEntry {
    const payload =
      input.payload === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(input.payload)) as Json);
    return {
      sequence: ++this.historySequence,
      at: input.at ?? new Date().toISOString(),
      phase: input.phase,
      direction: input.direction,
      kind: input.kind,
      summary: input.summary,
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(payload !== undefined ? { payload } : {}),
    };
  }

  /** Append one immutable event to a known deal's process-local history. */
  recordInteraction(
    dealId: string,
    input: Omit<AgreementHistoryEntry, "sequence" | "at"> & { at?: string },
  ): AgreementHistoryEntry {
    const deal = this.deals.get(dealId);
    if (deal === undefined) throw new Error(`unknown deal ${dealId}`);
    const entry = this.historyEntry(input);
    deal.history.push(entry);
    if (deal.history.length > DataSeller.MAX_HISTORY_ENTRIES_PER_DEAL) {
      deal.history.splice(0, deal.history.length - DataSeller.MAX_HISTORY_ENTRIES_PER_DEAL);
    }
    deal.updatedAt = entry.at;
    return entry;
  }

  /** Record only real Runtime state changes, not every background poll. */
  observeRuntimeStatus(dealId: string, status: Json, summary?: string): void {
    const deal = this.deals.get(dealId);
    if (deal === undefined) throw new Error(`unknown deal ${dealId}`);
    const state = String(status["state"] ?? "");
    if (!state) return;
    const revision = Number(status["revision"]);
    const changed = deal.runtimeState !== state;
    deal.runtimeState = state;
    if (Number.isFinite(revision)) deal.runtimeRevision = revision;
    if (!changed) return;
    this.recordInteraction(dealId, {
      phase: runtimeStatePhase(state),
      direction: "runtime-to-seller",
      kind: "runtime-state",
      summary: summary ?? `Coordination Runtime reported ${state}`,
      state,
      payload: status,
    });
  }

  /**
   * Price a query and mint the terms document the contract will pin. Free,
   * and non-committal until the document's hash lands inside signed terms.
   */
  quote(
    buyerAgentId: string,
    body: unknown,
  ): { facts: QuoteFacts; negotiation: NegotiationRecord; record?: QuoteRecord } {
    if (!BUYER_DID_PATTERN.test(buyerAgentId)) {
      throw new Error("query carries a valid `buyerAgentId` Kite DID");
    }
    const negotiationId = "neg_" + randomBytes(8).toString("hex");
    const issuedAt = new Date().toISOString();
    const queryBody = JSON.parse(
      JSON.stringify(typeof body === "object" && body !== null ? body : {}),
    ) as Json;
    const queryEntry = this.historyEntry({
      at: issuedAt,
      phase: "negotiation",
      direction: "buyer-to-seller",
      kind: "query",
      summary: "Buyer requested a priced data slice",
      payload: { buyerAgentId, body: queryBody },
    });
    const negotiation: NegotiationRecord = {
      negotiationId,
      buyerAgentId,
      state: "REFUSED",
      queryBody,
      createdAt: issuedAt,
      updatedAt: issuedAt,
      dealIds: [],
      history: [queryEntry],
    };
    const facts = composeQuote({
      corpus: this.corpus,
      body: queryBody,
      rateCard: this.rateCard,
      density: this.density,
    });
    if (!facts.accepted) {
      const refusal = this.historyEntry({
        phase: "negotiation",
        direction: "seller-to-buyer",
        kind: "quote",
        summary: "Seller refused the query with named rejection codes",
        payload: { accepted: false, rejections: facts.rejections },
      });
      negotiation.updatedAt = refusal.at;
      negotiation.history.push(refusal);
      this.negotiations.set(negotiationId, negotiation);
      this.pruneNegotiations(negotiationId);
      return { facts, negotiation };
    }
    if (facts.tractCount === 0 || facts.statsHash === undefined) {
      const unpriceable = this.historyEntry({
        phase: "negotiation",
        direction: "seller-to-buyer",
        kind: "quote",
        summary: "Seller returned an empty, unpriceable result without issuing a quote",
        payload: { accepted: true, body: facts.body },
      });
      negotiation.updatedAt = unpriceable.at;
      negotiation.history.push(unpriceable);
      this.negotiations.set(negotiationId, negotiation);
      this.pruneNegotiations(negotiationId);
      return { facts, negotiation };
    }

    const price = facts.body.price!;
    const termsDocument: TermsDocument = {
      format: "kite-example-data-deal-terms/v1",
      criteriaHash: facts.criteriaHash,
      statsHash: facts.statsHash,
      rowsPerTract: facts.rowsPerTract,
      totalRows: facts.deliverableRowCount,
      tractCount: facts.tractCount,
      perTractStandardErrorPp: Math.max(
        ...Object.values(facts.body.deliverable!.perTractStandardErrorPp),
      ),
      method: "stratified-marginal-bernoulli/v2",
      seedDisclosure: "seed published in the delivery manifest",
      generatorVersion: GENERATOR_VERSION,
      corpusHash: this.corpusHash,
      verifierHash: this.verifierHash,
      usage: {
        resale: false,
        retentionDays: 365,
        prohibitedUse:
          "not for clinical, epidemiological, eligibility, or policy decisions about any real person",
        limitations: facts.body.deliverable!.note
          ? [
              "marginal prevalences are reproduced; the joint distribution is not",
              facts.body.deliverable!.note,
            ]
          : ["marginal prevalences are reproduced; the joint distribution is not"],
      },
      artifactAvailability:
        "served until 14 days after a seller-favour settlement; revoked on refund outcomes; demo-grade process-local storage",
      priceBreakdownCents: {
        base: price.breakdownCents.base,
        tracts: price.breakdownCents.tracts,
        standardColumns: price.breakdownCents.standardColumns,
        premiumColumns: price.breakdownCents.premiumColumns,
        subtotal: price.breakdownCents.subtotal,
      },
      priceAmount: (price.listCents / 100).toFixed(2),
    };
    const termsDocumentHash = termsDocumentHashOf(termsDocument);
    const record: QuoteRecord = {
      negotiationId,
      buyerAgentId,
      termsDocument,
      termsDocumentHash,
      queryBody,
      facts,
      issuedAt,
      history: negotiation.history,
    };
    const response = this.historyEntry({
      phase: "negotiation",
      direction: "seller-to-buyer",
      kind: "quote",
      summary: `Seller quoted ${record.termsDocument.priceAmount} USDC for ${record.termsDocument.totalRows} rows`,
      payload: {
        accepted: true,
        summary: record.facts.summary,
        body: record.facts.body,
        termsDocumentHash,
        termsDocument,
      },
    });
    negotiation.state = "QUOTED";
    negotiation.termsDocumentHash = termsDocumentHash;
    negotiation.updatedAt = response.at;
    negotiation.history.push(response);
    this.negotiations.set(negotiationId, negotiation);
    this.quotes.set(negotiationId, record);
    this.pruneNegotiations(negotiationId);
    return { facts, negotiation, record };
  }

  termsDocumentByHash(hash: string): TermsDocument | undefined {
    for (const record of this.quotes.values()) {
      if (record.termsDocumentHash === hash) return record.termsDocument;
    }
    return undefined;
  }

  /** The acceptanceCriteria string a buyer should embed for a given quote. */
  acceptanceCriteriaFor(record: QuoteRecord): string {
    return buildAcceptanceCriteria(record.termsDocumentHash, this.config.publicUrl);
  }

  private selectedQuote(negotiationId: string, contract: Json): QuoteRecord {
    const record = this.quotes.get(negotiationId);
    if (record === undefined) {
      throw new Error(
        `negotiation ${negotiationId} has no accepted quote (or the process restarted — demo state is not durable)`,
      );
    }
    const commitment = parseAcceptanceCriteria(String(contract["acceptanceCriteria"] ?? ""));
    if (commitment === null) throw new Error("acceptanceCriteria pins no terms document");
    if (commitment.termsDocumentHash !== record.termsDocumentHash) {
      throw new Error(`proposal does not select the quote issued by negotiation ${negotiationId}`);
    }
    if (contract["buyerAgentId"] !== record.buyerAgentId) {
      throw new Error(
        `proposal buyerAgentId does not match negotiation ${negotiationId} (${record.buyerAgentId})`,
      );
    }
    return record;
  }

  private linkNegotiation(negotiationId: string, dealId: string, at: string): void {
    const negotiation = this.negotiations.get(negotiationId);
    if (negotiation === undefined) throw new Error(`unknown negotiation ${negotiationId}`);
    negotiation.state = "AGREEMENT_STARTED";
    negotiation.updatedAt = at;
    if (!negotiation.dealIds.includes(dealId)) negotiation.dealIds.push(dealId);
  }

  /**
   * Take a proposed contract: resolve its pinned terms document to a quote we
   * issued, recompute the arithmetic, and — if it holds — assign a demo deal
   * id. Live mode replaces the id with the Runtime's.
   */
  propose(negotiationId: string, contract: Json, buyerAddress: string): DealRecord {
    this.pruneDeals();
    const record = this.selectedQuote(negotiationId, contract);
    const dealId = "deal_" + randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    const deal: DealRecord = {
      dealId,
      negotiationId,
      state: "PROPOSED_LOCAL",
      termsDocumentHash: record.termsDocumentHash,
      buyerAddress,
      contract,
      createdAt: now,
      updatedAt: now,
      history: record.history.map((entry) => ({
        ...entry,
        ...(entry.payload !== undefined
          ? { payload: JSON.parse(JSON.stringify(entry.payload)) as Json }
          : {}),
      })),
    };
    this.deals.set(dealId, deal);
    this.linkNegotiation(negotiationId, dealId, now);
    this.recordInteraction(dealId, {
      phase: "formation",
      direction: "buyer-to-seller",
      kind: "submit-proposal",
      summary: "Buyer submitted a signed proposal based on the selected quote",
      state: "PROPOSED_LOCAL",
      payload: { buyerAddress, contract },
    });
    this.recordInteraction(dealId, {
      phase: "formation",
      direction: "seller-to-buyer",
      kind: "proposal-ack",
      summary: "Seller validated the quote reference and acknowledged the proposal",
      state: "PROPOSED_LOCAL",
      payload: { dealId, termsHash: termsHashOf(contract) },
    });
    return deal;
  }

  deal(dealId: string): DealRecord | undefined {
    return this.deals.get(dealId);
  }

  /**
   * Live mode: the proposal went to the Runtime, so the deal arrives here
   * already carrying the RUNTIME's deal id. Same resolution as `propose` —
   * the pinned terms document must be a quote this seller issued.
   */
  registerLiveDeal(
    dealId: string,
    negotiationId: string,
    contract: Json,
    buyerAddress: string,
  ): DealRecord {
    this.pruneDeals();
    const record = this.selectedQuote(negotiationId, contract);
    const existing = this.deals.get(dealId);
    if (existing !== undefined) {
      if (
        existing.negotiationId !== negotiationId ||
        existing.termsDocumentHash !== record.termsDocumentHash ||
        existing.buyerAddress.toLowerCase() !== buyerAddress.toLowerCase()
      ) {
        throw new Error(`deal ${dealId} retry does not match the proposal already observed`);
      }
      // A lost acceptance response may retry after the Runtime already
      // committed. The record is NOT rebuilt here: the incoming contract
      // becomes the deal's contract only when accept() validates and
      // countersigns it, so a retry that fails validation cannot overwrite
      // the contract already recorded or reset a deal that has advanced
      // past formation.
      return existing;
    }
    const now = new Date().toISOString();
    const deal: DealRecord = {
      dealId,
      negotiationId,
      state: "PROPOSED_LOCAL",
      termsDocumentHash: record.termsDocumentHash,
      buyerAddress,
      contract,
      createdAt: now,
      updatedAt: now,
      history: record.history.map((entry) => ({
        ...entry,
        ...(entry.payload !== undefined
          ? { payload: JSON.parse(JSON.stringify(entry.payload)) as Json }
          : {}),
      })),
    };
    this.deals.set(dealId, deal);
    this.linkNegotiation(negotiationId, dealId, now);
    this.recordInteraction(dealId, {
      phase: "formation",
      direction: "buyer-to-runtime",
      kind: "proposal",
      summary: "Buyer submitted the signed proposal to the Coordination Runtime",
      state: "PROPOSED",
      payload: { buyerAddress, contract },
    });
    return deal;
  }

  /** Recompute the countersign arithmetic for a stored quote, fresh. */
  private recomputeFor(record: QuoteRecord): { priceAmount: string; criteriaHash: string; statsHash: string } {
    const facts = composeQuote({
      corpus: this.corpus,
      body: record.queryBody,
      rateCard: this.rateCard,
      density: this.density,
    });
    if (!facts.accepted || facts.statsHash === undefined || facts.body.price === null) {
      throw new Error("the quoted slice no longer prices — refusing to countersign");
    }
    return {
      priceAmount: (facts.body.price.listCents / 100).toFixed(2),
      criteriaHash: criteriaHashOf(record.queryBody),
      statsHash: facts.statsHash,
    };
  }

  /** Countersign: §4.1 acceptance with the query-derived validation (DESIGN §4). */
  accept(dealId: string, buyerAgreementSig: string, chainId?: number, proposedContract?: Json): Json {
    const deal = this.deals.get(dealId);
    if (deal === undefined) throw new Error(`unknown deal ${dealId}`);
    // A retry presents its contract HERE, not at registration: it is adopted
    // into the record only below, after acceptTerms validated it, so a
    // malformed retry leaves the stored deal untouched.
    const proposal = proposedContract ?? deal.contract;
    const record = this.quotes.get(deal.negotiationId);
    if (record === undefined) throw new Error(`quote for negotiation ${deal.negotiationId} is unavailable`);
    this.recordInteraction(dealId, {
      phase: "formation",
      direction: "buyer-to-seller",
      kind: "acceptance-request",
      summary: "Buyer requested the seller's countersignature",
      state: deal.runtimeState ?? deal.state,
      payload: { dealId, buyerAgreementSig },
    });
    let accepted: Json;
    try {
      accepted = acceptTerms({
        contract: proposal,
        buyerAddress: deal.buyerAddress,
        dealId,
        buyerAgreementSig,
        privateKey: this.config.privateKey,
        keyId: this.keyId,
        sellerAddress: this.address,
        ...(chainId !== undefined ? { chainId } : {}),
        validation: {
          termsDocument: record.termsDocument,
          recomputed: this.recomputeFor(record),
        },
      });
    } catch (error) {
      this.recordInteraction(dealId, {
        phase: "formation",
        direction: "seller-to-buyer",
        kind: "acceptance-refused",
        summary: error instanceof Error ? error.message : String(error),
        state: deal.runtimeState ?? deal.state,
      });
      throw error;
    }
    deal.contract = accepted;
    deal.state = "ACCEPTED_LOCAL";
    this.recordInteraction(dealId, {
      phase: "formation",
      direction: "seller-to-buyer",
      kind: "acceptance-result",
      summary: "Seller countersigned the agreement",
      state: "ACCEPTED_LOCAL",
      payload: { contract: accepted },
    });
    return accepted;
  }

  /**
   * Generate the deliverable, mint the capability, and build the evidence
   * envelope. Live mode calls this FIRST, registers the envelope for a
   * Runtime-issued evidenceId, and only then asks for the signed command —
   * the Runtime refuses a `delivered` citing an id it never issued.
   */
  async prepareDelivery(dealId: string): Promise<{
    deal: DealRecord;
    termsHash: string;
    manifestUrl: string;
    csvUrl: string;
    envelope: Json;
    deliveryHash: string;
  }> {
    const deal = this.deals.get(dealId);
    if (deal === undefined) throw new Error(`unknown deal ${dealId}`);
    if (deal.state === "PROPOSED_LOCAL") throw new Error(`deal ${dealId} is not accepted yet`);
    const record = this.quotes.get(deal.negotiationId);
    if (record === undefined) throw new Error(`quote for negotiation ${deal.negotiationId} is unavailable`);

    // The capability: minted BEFORE generation so the manifest can name the
    // gated CSV URL as its artifact locator — the evidence record resolves to
    // the manifest and the manifest resolves to the deliverable, both behind
    // the same token, which refund outcomes revoke (DESIGN §5). A `memory:`
    // locator here would leave the buyer holding a manifest that maps to
    // nothing outside this process.
    const cap = randomBytes(16).toString("hex");
    const base = this.config.publicUrl.replace(/\/$/, "");
    const manifestUrl = `${base}/deliveries/${dealId}/manifest.json?cap=${cap}`;
    const csvUrl = `${base}/deliveries/${dealId}/data.csv?cap=${cap}`;

    const out = await generateDelivery({
      dealId,
      productId: String(((cardParams as Json)["deliverable"] as Json)["productId"]),
      query: readQuery(record.queryBody),
      corpus: this.corpus,
      rowsPerTract: record.termsDocument.rowsPerTract,
      seed: deliverableSeed({ secret: this.config.seedSecret, dealId }),
      storage: this.store,
      artifactLocator: csvUrl,
      quotedStatsHash: record.termsDocument.statsHash,
      now: () => new Date().toISOString(),
    });

    deal.capabilityToken = cap;
    deal.manifest = out.manifest;
    deal.manifestBytes = out.manifestBytes;
    deal.deliveryHash = out.deliveryHash;
    deal.csvBytes = out.bytes;
    deal.state = "DELIVERED_LOCAL";
    this.recordInteraction(dealId, {
      phase: "fulfillment",
      direction: "system",
      kind: "delivery-prepared",
      summary: `Seller generated ${out.manifest.rowCount} rows and committed the delivery hash`,
      state: "DELIVERED_LOCAL",
      payload: {
        deliveryHash: out.deliveryHash,
        rowCount: out.manifest.rowCount,
        contentHash: out.manifest.artifact.contentHash,
      },
    });

    const termsHash = termsHashOf(deal.contract);
    const envelope = evidenceEnvelope({
      dealId,
      termsHash,
      manifestHash: out.deliveryHash,
      manifestUrl,
      manifestBytes: out.manifestBytes.length,
      privateKey: this.config.privateKey,
      keyId: this.keyId,
    });
    return { deal, termsHash, manifestUrl, csvUrl, envelope, deliveryHash: out.deliveryHash };
  }

  /** The signed kite.contract.delivered for an already-prepared delivery. */
  commandFor(
    dealId: string,
    input: { anchors: SettlementAnchors; evidenceId: string; expectedRevision: number },
  ): Json {
    const deal = this.deals.get(dealId);
    if (deal?.deliveryHash === undefined) throw new Error(`no prepared delivery for ${dealId}`);
    return deliveredCommand({
      dealId,
      expectedRevision: input.expectedRevision,
      termsHash: termsHashOf(deal.contract),
      evidenceId: input.evidenceId,
      deliveryHash: deal.deliveryHash,
      anchors: input.anchors,
      privateKey: this.config.privateKey,
      keyId: this.keyId,
    });
  }

  /** Standalone delivery: prepare + command over documented placeholder anchors. */
  async deliver(
    dealId: string,
    options?: { anchors?: SettlementAnchors; evidenceId?: string },
  ): Promise<{
    deal: DealRecord;
    manifestUrl: string;
    csvUrl: string;
    envelope: Json;
    command: Json;
  }> {
    const prepared = await this.prepareDelivery(dealId);
    const command = this.commandFor(dealId, {
      anchors: options?.anchors ?? demoAnchors(dealId),
      evidenceId: options?.evidenceId ?? `ev_demo_${dealId}`,
      expectedRevision: 2,
    });
    this.recordInteraction(dealId, {
      phase: "fulfillment",
      direction: "seller-to-buyer",
      kind: "delivery",
      summary: "Seller returned the signed delivery and evidence artifacts",
      state: "DELIVERED_LOCAL",
      payload: {
        dealId,
        deliveryHash: prepared.deliveryHash,
        evidenceId: options?.evidenceId ?? `ev_demo_${dealId}`,
      },
    });
    return {
      deal: prepared.deal,
      manifestUrl: prepared.manifestUrl,
      csvUrl: prepared.csvUrl,
      envelope: prepared.envelope,
      command,
    };
  }

  /**
   * The download gate: right deal, right token, not revoked. 404-shaped on
   * every failure — an unauthorized caller learns nothing about what exists.
   */
  artifactFor(dealId: string, file: string, cap: string | undefined): Buffer | undefined {
    const deal = this.deals.get(dealId);
    if (
      deal === undefined ||
      deal.capabilityToken === undefined ||
      deal.capabilityRevoked === true ||
      cap === undefined ||
      cap !== deal.capabilityToken
    ) {
      return undefined;
    }
    if (file === "manifest.json") return deal.manifestBytes;
    if (file === "data.csv") return deal.csvBytes;
    return undefined;
  }

  /** Refund outcome observed → the buyer must not keep the paid product. */
  revokeCapability(dealId: string): void {
    const deal = this.deals.get(dealId);
    if (deal !== undefined && deal.capabilityRevoked !== true) {
      deal.capabilityRevoked = true;
      this.recordInteraction(dealId, {
        phase: "settlement",
        direction: "system",
        kind: "capability-revoked",
        summary: "Artifact access was revoked after a refund outcome",
        state: deal.runtimeState ?? deal.state,
      });
    }
  }

  buyerRecords(): BuyerRecord[] {
    const buyers = new Map<string, BuyerRecord>();
    const ensure = (buyerAgentId: string, at: string): BuyerRecord => {
      const existing = buyers.get(buyerAgentId);
      if (existing !== undefined) {
        if (at < existing.firstSeenAt) existing.firstSeenAt = at;
        if (at > existing.updatedAt) existing.updatedAt = at;
        return existing;
      }
      const created: BuyerRecord = {
        buyerAgentId,
        firstSeenAt: at,
        updatedAt: at,
        negotiations: [],
        deals: [],
      };
      buyers.set(buyerAgentId, created);
      return created;
    };
    for (const negotiation of this.negotiations.values()) {
      const buyer = ensure(negotiation.buyerAgentId, negotiation.createdAt);
      buyer.negotiations.push(negotiation);
      if (negotiation.updatedAt > buyer.updatedAt) buyer.updatedAt = negotiation.updatedAt;
    }
    for (const deal of this.deals.values()) {
      const buyerAgentId = String(deal.contract["buyerAgentId"] ?? "");
      const buyer = ensure(buyerAgentId, deal.createdAt);
      buyer.deals.push(deal);
      if (deal.updatedAt > buyer.updatedAt) buyer.updatedAt = deal.updatedAt;
    }
    for (const buyer of buyers.values()) {
      buyer.negotiations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      buyer.deals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return [...buyers.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  buyerRecord(buyerAgentId: string): BuyerRecord | undefined {
    return this.buyerRecords().find((buyer) => buyer.buyerAgentId === buyerAgentId);
  }

  dealRecords(): DealRecord[] {
    return [...this.deals.values()];
  }
}

export const ephemeralKey = (): Uint8Array => {
  // Ephemeral secp256k1 key for the demo. A real agent binds ONE durable
  // runtime key through Passport MCP and reuses it everywhere (§8, DESIGN §3).
  return Uint8Array.from(randomBytes(32));
};

function runtimeStatePhase(state: string): AgreementHistoryPhase {
  if (["PROPOSED", "COMMITTED"].includes(state)) return "formation";
  if (["FUNDING", "FUNDED", "FULFILLING"].includes(state)) return "funding";
  if (["DELIVERED"].includes(state)) return "fulfillment";
  return "settlement";
}

export { utf8 };
