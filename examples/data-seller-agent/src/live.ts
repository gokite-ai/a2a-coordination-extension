/**
 * Live mode: the seller as a real Runtime participant (DESIGN §3, PLAN
 * phase 3). Mirrors the Python seller's live semantics, function by function:
 *
 *  - countersign against a `status` read (never a claimed deal id), under the
 *    chain context of the VERIFIED Runtime card;
 *  - co-sign funding over the READ-BACK Activation (never assembled locally;
 *    base units never converted twice);
 *  - deliver autonomously on the §6.5 work-start: read back, acknowledge
 *    once, run delivery as a background task with retries bounded by the
 *    notification's deadline;
 *  - anchors read back fresh per attempt (vault dealId, current nonce,
 *    latestProofHash), expiry from the SELLER's clock;
 *  - watch outcomes: refund outcomes revoke the artifact capability, a
 *    seller-favour settlement holds it for the declared availability window.
 */
import {
  buildCommand,
  signCommand,
  validateRuntimeCard,
  type SettlementAnchors,
} from "./extension.js";
import { CoordinationClient, DomainRejection } from "./coordination.js";
import type { RuntimeBinding } from "./binding.js";
import { TYPE_STRINGS, bytes32Equal, signStruct, usdcBaseUnits } from "./settlement.js";
import { termsHashOf } from "./signing.js";
import type { DataSeller } from "./seller.js";

type Json = Record<string, any>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TERMINAL_STATES = new Set(["ACCEPTED", "RESOLVED", "CANCELLED", "DEFAULTED", "EXPIRED"]);

export class LiveCoordinator {
  /** dealId → recomputed termsHash of the countersigned contract. */
  private readonly dealTerms = new Map<string, string>();
  private readonly delivering = new Set<string>();
  private readonly watching = new Set<string>();
  readonly deliveryRetrySeconds: number;
  readonly outcomePollSeconds: number;

  constructor(
    private readonly seller: DataSeller,
    readonly runtime: CoordinationClient,
    private readonly privateKey: Uint8Array,
    options?: {
      deliveryRetrySeconds?: number;
      outcomePollSeconds?: number;
      /** The §8 binding; live signing refuses until an owner has approved it. */
      binding?: RuntimeBinding;
    },
  ) {
    this.deliveryRetrySeconds = options?.deliveryRetrySeconds ?? 30;
    this.outcomePollSeconds = options?.outcomePollSeconds ?? 30;
    this.binding = options?.binding;
  }

  private readonly binding: RuntimeBinding | undefined;

  /** Refuse to sign until the runtime binding is ACTIVE (owner-approved). */
  private assertBindingActive(): void {
    const blocked = this.binding?.block();
    if (blocked != null) throw new Error(blocked);
  }

  /**
   * Live phase two: the dealId is the RUNTIME's, so the proposal never passed
   * through this seller — the contract arrives with the request, and the
   * deal's existence is verified against the Runtime before anything is
   * signed. The acceptance is then submitted by this seller itself (§6.2
   * allows either party), so the reply's status is the Runtime's own
   * COMMITTED answer, not an unverified relay promise.
   */
  async countersign(
    dealId: string,
    negotiationId: string,
    contract: Json,
    buyerAddress: string,
    buyerAgreementSig: string,
  ): Promise<Json> {
    this.assertBindingActive();
    const status = await this.runtime.status(dealId);
    const computed = termsHashOf(contract);
    // Byte equality, not string equality: both spellings of a 32-byte anchor
    // name the same value.
    if (status["termsHash"] && !bytes32Equal(String(status["termsHash"]), computed)) {
      throw new Error(
        `the Runtime holds different terms for this dealId than the contract presented — ` +
          `refusing to countersign (${status["termsHash"]} vs ${computed})`,
      );
    }
    // RETRY-SAFE: an acceptance whose HTTP response was lost still committed
    // on the Runtime. A COMMITTED holding exactly these terms is therefore
    // OUR acceptance to reconcile — re-run the local validation and
    // countersign (deterministic RFC 6979 signatures rebuild the identical
    // entries) without submitting a second acceptance. Anything else that is
    // not PROPOSED is a real refusal.
    // Reconciling requires the Runtime to NAME the terms it committed —
    // matching was already enforced above, so only presence is checked here:
    // a COMMITTED carrying no termsHash is not provably ours.
    const reconcilingCommitted = status["state"] === "COMMITTED" && Boolean(status["termsHash"]);
    if (status["state"] !== "PROPOSED" && !reconcilingCommitted) {
      throw new Error(
        `deal ${dealId} is ${status["state"]}, not PROPOSED — acceptance countersigns a proposal, nothing later`,
      );
    }
    // The Agreement domain's chainId comes from the Runtime's VERIFIED card
    // (§2.1) — pinned by the contract's own agentCardHash — never from local
    // configuration.
    const card = await this.runtime.fetchRuntimeCard();
    const { chainId } = validateRuntimeCard(card, (contract["runtimeBinding"] ?? {}) as Json);

    // Registration mirrors the standalone path: resolve the pinned terms
    // document to a quote this seller issued, then countersign with the
    // query-derived validation.
    this.seller.registerLiveDeal(dealId, negotiationId, contract, buyerAddress);
    this.seller.observeRuntimeStatus(
      dealId,
      status,
      "Seller verified the buyer's proposal against the Coordination Runtime",
    );
    const accepted = this.seller.accept(dealId, buyerAgreementSig, chainId, contract);
    // Remembered BEFORE the lossy write: if the submission's response is
    // lost after the Runtime commits, funding and notifications for this
    // deal must still resolve, and the retry path above must recognize the
    // COMMITTED as ours.
    this.dealTerms.set(dealId, computed);
    if (reconcilingCommitted) {
      return { contract: accepted, status, reconciled: true };
    }
    this.seller.recordInteraction(dealId, {
      phase: "formation",
      direction: "seller-to-runtime",
      kind: "acceptance",
      summary: "Seller submitted the countersigned agreement to the Coordination Runtime",
      state: "ACCEPTED_LOCAL",
      payload: { dealId, contract: accepted },
    });
    const result = await this.runtime.submitAcceptance(dealId, accepted);
    const acceptedStatus = (result["status"] ?? {}) as Json;
    this.seller.observeRuntimeStatus(dealId, acceptedStatus);
    return { contract: accepted, status: acceptedStatus };
  }

  /**
   * The seller's ONE funding artifact (§6.2.1 role binding): co-sign the
   * READ-BACK Activation. Checked locally against the terms this seller
   * signed — same termsHash, same payout, same amount, our own key's address
   * as sellerAgent — because co-signing an Activation that diverges from the
   * accepted terms would authorize settlement of a different deal.
   */
  async coSignFunding(dealId: string): Promise<Json> {
    this.assertBindingActive();
    const termsRef = this.dealTerms.get(dealId);
    if (termsRef === undefined) throw new Error(`unknown dealId ${dealId} — nothing countersigned under it`);
    const accepted = this.seller.deal(dealId)!.contract as Json;
    this.seller.recordInteraction(dealId, {
      phase: "funding",
      direction: "seller-to-runtime",
      kind: "funding-context",
      summary: "Seller requested the Runtime's current funding context",
      state: this.seller.deal(dealId)?.runtimeState ?? this.seller.deal(dealId)?.state ?? "UNKNOWN",
      payload: { dealId, termsHash: termsRef },
    });
    const ctx = await this.runtime.funding(dealId, termsRef);
    const activation = (ctx["activation"] ?? {}) as Json;
    if (!activation["buyer"]) {
      // A normal stage, not an error: until the buyer's wallet lands there is
      // no digest to sign.
      this.seller.recordInteraction(dealId, {
        phase: "funding",
        direction: "runtime-to-seller",
        kind: "funding-pending",
        summary: "Runtime reported that the buyer's funding artifact is not ready",
        state: this.seller.deal(dealId)?.runtimeState ?? this.seller.deal(dealId)?.state ?? "UNKNOWN",
        payload: { funding: ctx },
      });
      return { pending: true, funding: ctx };
    }
    if (!ctx["vaultAddress"] || !ctx["chainId"]) {
      throw new Error(
        "funding context omits vaultAddress/chainId — the EIP-712 domain MUST come from this read (§6.2.1)",
      );
    }
    const problems: string[] = [];
    if (!bytes32Equal(String(activation["termsHash"] ?? ""), termsRef)) {
      problems.push(`termsHash ${activation["termsHash"]} is not the accepted ${termsRef}`);
    }
    const payout = String((accepted["escrow"] as Json)["payoutAddress"]);
    if (String(activation["sellerPayout"] ?? "").toLowerCase() !== payout.toLowerCase()) {
      problems.push(`sellerPayout ${activation["sellerPayout"]} is not the signed payout ${payout}`);
    }
    if (String(activation["sellerAgent"] ?? "").toLowerCase() !== this.seller.address) {
      problems.push(`sellerAgent ${activation["sellerAgent"]} is not this agent's key (${this.seller.address})`);
    }
    // The buyer's side of the same check: the Activation's buyerAgent must be
    // the address whose formation and Agreement signatures were verified at
    // countersign — co-signing a substituted buyerAgent would authorize
    // settlement with a party nobody's signatures vouch for.
    const boundBuyer = this.seller.deal(dealId)!.buyerAddress.toLowerCase();
    if (String(activation["buyerAgent"] ?? "").toLowerCase() !== boundBuyer) {
      problems.push(`buyerAgent ${activation["buyerAgent"]} is not the verified buyer (${boundBuyer})`);
    }
    // Two spellings of one number: the Activation's amount is ALREADY base
    // units; the contract's price is decimal. Each goes through ITS OWN
    // parser — converting the read-back value again compares 10^6 too high
    // and refuses every deal.
    if (BigInt(String(activation["amount"])) !== usdcBaseUnits(String((accepted["price"] as Json)["amount"]))) {
      problems.push(`amount ${activation["amount"]} is not the signed ${(accepted["price"] as Json)["amount"]}`);
    }
    if (problems.length > 0) {
      throw new Error(`read-back Activation diverges from the accepted terms — refusing to co-sign: ${problems.join("; ")}`);
    }
    const sellerActivationSig = signStruct(
      this.privateKey,
      {
        name: "KiteEscrowVault",
        version: "1",
        chainId: Number(ctx["chainId"]),
        verifyingContract: String(ctx["vaultAddress"]),
      },
      TYPE_STRINGS.Activation,
      {
        termsHash: String(activation["termsHash"]),
        buyer: String(activation["buyer"]),
        buyerAgent: String(activation["buyerAgent"]),
        sellerAgent: String(activation["sellerAgent"]),
        sellerPayout: String(activation["sellerPayout"]),
        arbiter: String(activation["arbiter"]),
        amountBaseUnits: String(activation["amount"]),
        amount: String(activation["amount"]),
        fundingDeadline: Number(activation["fundingDeadline"]),
        deliveryWindow: Number(activation["deliveryWindow"]),
        deliveryConfirmationWindow: Number(activation["deliveryConfirmationWindow"]),
        appealResponseWindow: Number(activation["appealResponseWindow"]),
        arbitrationWindow: Number(activation["arbitrationWindow"]),
      },
    );
    this.seller.recordInteraction(dealId, {
      phase: "funding",
      direction: "seller-to-runtime",
      kind: "funding-signatures",
      summary: "Seller co-signed the read-back escrow Activation",
      state: this.seller.deal(dealId)?.runtimeState ?? this.seller.deal(dealId)?.state ?? "UNKNOWN",
      payload: { dealId, termsHash: termsRef, activation, sellerActivationSig },
    });
    const status = await this.runtime.submitFundingSignatures(dealId, termsRef, { sellerActivationSig });
    this.seller.observeRuntimeStatus(dealId, status);
    return { pending: false, status };
  }

  /**
   * §6.5: a notification is advisory, NEVER authoritative — the state is
   * read back from the Runtime, and only a read-back that answers FULFILLING
   * for a deal this seller countersigned is acknowledged. Every failure
   * THROWS: the relay treats any well-formed reply as delivered, so only an
   * error keeps its retry loop alive. On a verified signal the seller starts
   * the work itself; the buyer sends no follow-up.
   */
  async handleNotification(note: Json): Promise<Json> {
    const dealId = String(note["deal_id"] ?? "");
    if (note["type"] !== "kite.contract.fulfill_started") {
      throw new Error(`unknown notification type ${note["type"]} — v1 defines exactly one (§6.5)`);
    }
    const termsRef = this.dealTerms.get(dealId);
    if (termsRef === undefined) throw new Error(`unknown dealId ${dealId} — nothing countersigned under it`);
    if (note["terms_hash"] && !bytes32Equal(String(note["terms_hash"]), termsRef)) {
      throw new Error(`notification names terms ${note["terms_hash"]}, not the accepted ${termsRef}`);
    }
    const status = await this.runtime.status(dealId); // failure propagates as an error
    if (status["state"] !== "FULFILLING") {
      throw new Error(
        `read-back says ${dealId} is ${status["state"]}, not FULFILLING — not acknowledging a ` +
          "work-start the Runtime does not report",
      );
    }
    this.seller.recordInteraction(dealId, {
      phase: "funding",
      direction: "runtime-to-seller",
      kind: "kite.contract.fulfill_started",
      summary: "Runtime notified the seller to begin fulfillment",
      state: "FULFILLING",
      payload: note,
    });
    this.seller.observeRuntimeStatus(dealId, status);
    if (!this.delivering.has(dealId)) {
      this.delivering.add(dealId);
      const deadline = Number(note["delivery_deadline"] ?? 0) || undefined;
      // The acknowledgement is a one-shot: the engine's SendFulfillStart
      // completes on it and the notification is never re-sent, so retries
      // are nobody's but ours from here.
      void this.backgroundDelivery(dealId, deadline);
    }
    return { type: note["type"], dealId, acknowledged: true, verifiedState: status["state"] };
  }

  /** The autonomous half: retry until DELIVERED, non-FULFILLING, or deadline. */
  private async backgroundDelivery(dealId: string, deadline?: number): Promise<void> {
    const limit = deadline ?? Math.floor(Date.now() / 1000) + 6 * 3600;
    try {
      for (;;) {
        try {
          await this.runDelivery(dealId);
          return;
        } catch (error) {
          if (error instanceof DomainRejection && !error.retriable) {
            // §7 puts `retriable` on the wire precisely so the client decides
            // this: replaying a non-retriable rejection burns the deadline on
            // an answer that will not change.
            return;
          }
        }
        try {
          const status = await this.runtime.status(dealId);
          this.seller.observeRuntimeStatus(dealId, status);
          if (status["state"] !== "FULFILLING") return;
        } catch {
          // the probe failing is itself retriable
        }
        if (Date.now() / 1000 >= limit) return;
        await sleep(this.deliveryRetrySeconds * 1000);
      }
    } finally {
      this.delivering.delete(dealId);
    }
  }

  /**
   * Live delivery — the order is forced by what refuses what (§6.2.1, §4.4):
   * 1. `status`: FULFILLING is the authority, and it carries the anchors —
   *    the VAULT deal id (not the Runtime agreement id), the CURRENT nonce,
   *    and `latestProofHash`. A cached anchor signs a transition the chain
   *    has already moved past.
   * 2. `evidence`: registered FIRST, because the Runtime refuses a
   *    `delivered` citing an evidenceId it never issued.
   * 3. `command`: the signed kite.contract.delivered, expectedRevision from
   *    the same status read.
   */
  async runDelivery(dealId: string): Promise<Json> {
    this.assertBindingActive();
    const termsRef = this.dealTerms.get(dealId);
    if (termsRef === undefined) throw new Error(`unknown dealId ${dealId} — nothing countersigned under it`);
    const status = await this.runtime.status(dealId);
    this.seller.observeRuntimeStatus(dealId, status);
    if (status["state"] !== "FULFILLING") {
      throw new Error(
        `deal ${dealId} is ${status["state"]}, not FULFILLING — delivery starts on the Runtime's work-start`,
      );
    }
    const vault = (status["vault"] ?? {}) as Json;
    const receiptHash = status["latestProofHash"];
    if (!vault["dealId"] || vault["nonce"] === undefined || !receiptHash) {
      throw new Error(
        "status carries no vault block or proof anchor — a Delivery signature needs the vault " +
          "dealId, the current nonce and latestProofHash (§4.4), and signing over invented ones " +
          "fails only at broadcast",
      );
    }
    let chainId = vault["chainId"];
    let vaultAddr = vault["vaultAddress"];
    if (!chainId || !vaultAddr) {
      // The vault block's domain members are optional; the funding context's
      // are not (§6.2.1 — the domain MUST come from a read).
      const ctx = await this.runtime.funding(dealId, termsRef);
      chainId = ctx["chainId"];
      vaultAddr = ctx["vaultAddress"];
    }

    const prepared = await this.seller.prepareDelivery(dealId);
    // The capability token exists FROM HERE, so its lifecycle watch starts
    // here too — not after submitCommand returns. A delivered command whose
    // HTTP response is lost still commits DELIVERED on the Runtime; the retry
    // then observes non-FULFILLING and exits, and without this ordering no
    // watcher would exist to revoke the capability on a later refund.
    this.watchOutcome(dealId);
    const evidenceId = await this.runtime.submitEvidenceEnvelope(prepared.envelope);
    this.seller.recordInteraction(dealId, {
      phase: "fulfillment",
      direction: "seller-to-runtime",
      kind: "evidence",
      summary: "Seller registered the delivery manifest as evidence",
      state: "DELIVERED_LOCAL",
      payload: { dealId, evidenceId, deliveryHash: prepared.deliveryHash },
    });
    const anchors: SettlementAnchors = {
      dealId32: String(vault["dealId"]),
      receiptHash: String(receiptHash),
      nonce: Number(vault["nonce"]),
      // The SELLER's clock, never the requester's: a peer able to name the
      // expiry could ask for one already in the past — an agreement that
      // reads DELIVERED while the on-chain markDelivered can never land.
      expiry: Math.floor(Date.now() / 1000) + 3600,
      chainId: Number(chainId),
      vault: String(vaultAddr),
    };
    const command = this.seller.commandFor(dealId, {
      anchors,
      evidenceId,
      expectedRevision: Number(status["revision"]),
    });
    this.seller.recordInteraction(dealId, {
      phase: "fulfillment",
      direction: "seller-to-runtime",
      kind: "kite.contract.delivered",
      summary: "Seller submitted the signed delivery command",
      state: "DELIVERED_LOCAL",
      payload: { command },
    });
    const result = await this.runtime.submitCommand(command);
    this.seller.observeRuntimeStatus(dealId, (result["status"] ?? {}) as Json);
    return {
      kind: "delivery",
      dealId,
      command,
      evidenceEnvelope: prepared.envelope,
      evidenceId,
      manifestUrl: prepared.manifestUrl,
      csvUrl: prepared.csvUrl,
      status: result["status"] ?? {},
    };
  }

  /**
   * Autonomous outcome monitoring (DESIGN §5): poll the agreement until it
   * reaches a terminal state, applying refund revocation the moment it is
   * observed — never contingent on an admin page being opened. One watcher
   * per deal; a status-read failure is retried on the next tick.
   */
  watchOutcome(dealId: string): void {
    if (this.watching.has(dealId)) return;
    this.watching.add(dealId);
    void (async () => {
      try {
        for (;;) {
          try {
            const state = await this.refreshOutcome(dealId);
            if (TERMINAL_STATES.has(state)) return;
          } catch {
            // transient — the next tick probes again
          }
          await sleep(this.outcomePollSeconds * 1000);
        }
      } finally {
        this.watching.delete(dealId);
      }
    })();
  }

  isWatching(dealId: string): boolean {
    return this.watching.has(dealId);
  }

  /**
   * Outcome watching (DESIGN §5): on a refund outcome — CANCELLED, or
   * RESOLVED with the split against the seller — the artifact capability is
   * revoked; a seller-favour terminal state leaves it valid for the declared
   * availability window. Returns the observed state.
   */
  async refreshOutcome(dealId: string): Promise<string> {
    const status = await this.runtime.status(dealId);
    const state = String(status["state"] ?? "");
    this.seller.observeRuntimeStatus(dealId, status);
    const refunded =
      state === "CANCELLED" ||
      (state === "RESOLVED" && Number(((status["resolution"] ?? {}) as Json)["sellerBps"] ?? 10_000) === 0);
    if (refunded) this.seller.revokeCapability(dealId);
    return state;
  }

  isDelivering(dealId: string): boolean {
    return this.delivering.has(dealId);
  }

  /**
   * The seller's two REJECTED-state moves (fixed_outcome/v1 §3): consent to
   * the refund (REJECTED → CANCELLED, buyer refunded) or appeal
   * (REJECTED → DISPUTED, a third-party arbiter decides the split). Both are
   * ordinary §4.2 commands whose payload carries a §4.4 vault signature over
   * anchors read back fresh — never cached, never invented.
   */
  async consentRefund(dealId: string): Promise<Json> {
    return this.rejectionResponse(dealId, "kite.contract.refund_consented", "RefundConsent", "sellerConsentSig");
  }

  async appeal(dealId: string): Promise<Json> {
    return this.rejectionResponse(dealId, "kite.contract.appealed", "Appeal", "sellerAppealSig");
  }

  private async rejectionResponse(
    dealId: string,
    commandType: string,
    structName: "Appeal" | "RefundConsent",
    sigMember: string,
  ): Promise<Json> {
    this.assertBindingActive();
    const termsRef = this.dealTerms.get(dealId);
    if (termsRef === undefined) throw new Error(`unknown dealId ${dealId} — nothing countersigned under it`);
    const status = await this.runtime.status(dealId);
    this.seller.observeRuntimeStatus(dealId, status);
    if (status["state"] !== "REJECTED") {
      throw new Error(`deal ${dealId} is ${status["state"]}, not REJECTED — nothing to answer`);
    }
    const vault = (status["vault"] ?? {}) as Json;
    const receiptHash = status["latestProofHash"];
    if (!vault["dealId"] || vault["nonce"] === undefined || !receiptHash || !vault["chainId"] || !vault["vaultAddress"]) {
      throw new Error("status carries no complete vault block — nothing safe to sign over (§4.4)");
    }
    const expiry = Math.floor(Date.now() / 1000) + 3600; // the seller's own clock
    const sig = signStruct(
      this.privateKey,
      {
        name: "KiteEscrowVault",
        version: "1",
        chainId: Number(vault["chainId"]),
        verifyingContract: String(vault["vaultAddress"]),
      },
      TYPE_STRINGS[structName],
      {
        dealId: String(vault["dealId"]),
        termsHash: termsRef,
        receiptHash: String(receiptHash),
        nonce: Number(vault["nonce"]),
        expiry,
      },
    );
    const command = signCommand(
      buildCommand({
        commandType,
        dealId,
        expectedRevision: Number(status["revision"]),
        termsHash: termsRef,
        payload: { [sigMember]: sig, expiry },
      }),
      this.privateKey,
      this.seller.keyId,
    );
    this.seller.recordInteraction(dealId, {
      phase: "settlement",
      direction: "seller-to-runtime",
      kind: commandType,
      summary:
        commandType === "kite.contract.appealed"
          ? "Seller appealed the buyer's rejection"
          : "Seller consented to refund the buyer",
      state: "REJECTED",
      payload: { command },
    });
    const result = await this.runtime.submitCommand(command);
    this.seller.observeRuntimeStatus(dealId, (result["status"] ?? {}) as Json);
    return result;
  }
}
