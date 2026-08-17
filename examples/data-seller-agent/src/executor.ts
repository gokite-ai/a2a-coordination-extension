/**
 * The A2A executor: transport wiring around `DataSeller`.
 *
 * Mirrors the Python seller's executor semantics: the §2.2 opt-in (header
 * AND message `extensions` array) is required on every negotiation request
 * and a request missing either is refused — the parties are negotiating an
 * agreement to be executed under the Extension, so declaring it is exactly
 * what §2.2 asks. Errors are answered as `error` kinds on the demo-private
 * media type, carrying the engine's named rejection codes where they exist.
 */
import { Role, type Message, type Part } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { randomBytes } from "node:crypto";
import { EXTENSION_URI, NEGOTIATION_MEDIA_TYPE, verifyDeliveryRequest } from "./extension.js";
import { termsHashOf } from "./signing.js";
import type { DataSeller } from "./seller.js";
import type { LiveCoordinator } from "./live.js";

type Json = Record<string, unknown>;

const rawPart = (payload: unknown): Part => ({
  content: { $case: "raw", value: Buffer.from(JSON.stringify(payload), "utf8") },
  metadata: undefined,
  filename: "",
  mediaType: NEGOTIATION_MEDIA_TYPE,
});

const reply = (context: RequestContext, payload: unknown): Message => ({
  messageId: "msg_" + randomBytes(8).toString("hex"),
  contextId: context.contextId,
  taskId: "",
  role: Role.ROLE_AGENT,
  parts: [rawPart(payload)],
  metadata: undefined,
  extensions: [EXTENSION_URI],
  referenceTaskIds: [],
});

export class DataSellerExecutor implements AgentExecutor {
  /** `live` present means live mode: the Runtime paths replace the standalone stand-ins. */
  constructor(
    private readonly seller: DataSeller,
    private readonly live?: LiveCoordinator,
  ) {}

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const send = (payload: unknown) => {
      context.context.addActivatedExtension(EXTENSION_URI);
      eventBus.publish(AgentEvent.message(reply(context, payload)));
      eventBus.finished();
    };
    const refuse = (error: string, extra?: Json) => send({ kind: "error", error, ...extra });

    try {
      const message = context.userMessage;

      // §2.2: BOTH halves of the opt-in, refused independently so the caller
      // can tell which one it forgot.
      const requested = context.context.requestedExtensions ?? [];
      if (!requested.includes(EXTENSION_URI)) {
        return refuse(
          "request does not activate the coordination extension via the A2A-Extensions header (§2.2)",
        );
      }
      if (!message.extensions.includes(EXTENSION_URI)) {
        return refuse("message does not declare the coordination extension in its extensions array (§2.2)");
      }

      const part = message.parts.find(
        (p) => p.content?.$case === "raw" && p.mediaType === NEGOTIATION_MEDIA_TYPE,
      );
      if (part === undefined || part.content?.$case !== "raw") {
        return refuse(`no raw part with media type ${NEGOTIATION_MEDIA_TYPE}`);
      }
      let data: Json;
      try {
        data = JSON.parse(Buffer.from(part.content.value).toString("utf8")) as Json;
      } catch {
        return refuse("negotiation part is not JSON");
      }

      switch (data["kind"]) {
        case "query": {
          const buyerAgentId = data["buyerAgentId"];
          if (typeof buyerAgentId !== "string" || buyerAgentId.length === 0) {
            return refuse("query carries `buyerAgentId` and `body`");
          }
          const { facts, negotiation, record } = this.seller.quote(buyerAgentId, data["body"]);
          if (!facts.accepted) {
            return send({
              kind: "quote",
              negotiationId: negotiation.negotiationId,
              accepted: false,
              rejections: facts.rejections,
            });
          }
          if (record === undefined) {
            return send({
              kind: "quote",
              negotiationId: negotiation.negotiationId,
              accepted: true,
              body: facts.body,
            });
          }
          return send({
            kind: "quote",
            negotiationId: negotiation.negotiationId,
            accepted: true,
            summary: facts.summary,
            body: facts.body,
            // The signed path's inputs: the terms document, its hash, and the
            // exact acceptanceCriteria string that pins it (DESIGN §4).
            termsDocument: record.termsDocument,
            termsDocumentHash: record.termsDocumentHash,
            acceptanceCriteria: this.seller.acceptanceCriteriaFor(record),
            seller: this.seller.identityBlock(),
          });
        }

        case "submit-proposal": {
          const negotiationId = data["negotiationId"];
          const contract = data["contract"] as Json | undefined;
          const buyerAddress = data["buyerAddress"];
          if (
            typeof negotiationId !== "string" ||
            negotiationId.length === 0 ||
            contract === undefined ||
            typeof buyerAddress !== "string" ||
            buyerAddress.length === 0
          ) {
            return refuse("submit-proposal carries `negotiationId`, `contract`, and `buyerAddress`");
          }
          const deal = this.seller.propose(negotiationId, contract, buyerAddress);
          return send({
            kind: "proposal-ack",
            dealId: deal.dealId,
            termsHash: termsHashOf(contract),
            note: "demo-assigned deal id; a live Runtime assigns the real one at proposal (§4.1)",
          });
        }

        case "acceptance-request": {
          const dealId = String(data["dealId"] ?? "");
          const negotiationId = String(data["negotiationId"] ?? "");
          const buyerAgreementSig = String(data["buyerAgreementSig"] ?? "");
          if (this.live !== undefined) {
            // Live: the proposal went to the Runtime, so the contract must
            // arrive here, and the deal is verified against the Runtime
            // before anything is signed.
            const contract = data["contract"] as Json | undefined;
            const buyerAddress = data["buyerAddress"] as string | undefined;
            if (!negotiationId || contract === undefined || buyerAddress === undefined) {
              return refuse(
                "live acceptance-request must carry the Runtime-assigned dealId, negotiationId, " +
                  "and proposed contract — the proposal went to the Runtime, so this seller has never seen it",
              );
            }
            const result = await this.live.countersign(
              dealId,
              negotiationId,
              contract,
              buyerAddress,
              buyerAgreementSig,
            );
            return send({ kind: "acceptance-result", dealId, ...result });
          }
          const accepted = this.seller.accept(dealId, buyerAgreementSig);
          return send({ kind: "acceptance-result", dealId, contract: accepted });
        }

        case "funding-request": {
          if (this.live === undefined) {
            return refuse(
              "standalone mode has no Runtime to read the Activation from — funding needs " +
                "KITE_COORDINATION_MODE=live",
            );
          }
          const dealId = String(data["dealId"] ?? "");
          this.seller.recordInteraction(dealId, {
            phase: "funding",
            direction: "buyer-to-seller",
            kind: "funding-request",
            summary: "Buyer asked the seller to co-sign the escrow funding context",
            state: this.seller.deal(dealId)?.runtimeState ?? this.seller.deal(dealId)?.state ?? "UNKNOWN",
            payload: { dealId },
          });
          const result = await this.live.coSignFunding(dealId);
          const response =
            result["pending"] === true
              ? {
                  kind: "funding-state",
                  dealId,
                  funding: result["funding"],
                  note: "activation is not yet signable (buyer wallet missing) — ask again once the buyer's funding submission lands",
                }
              : { kind: "funding-result", dealId, status: result["status"] };
          this.seller.recordInteraction(dealId, {
            phase: "funding",
            direction: "seller-to-buyer",
            kind: response.kind,
            summary:
              response.kind === "funding-state"
                ? "Seller reported that funding is not ready for co-signing"
                : "Seller returned the Runtime's funding result",
            state: this.seller.deal(dealId)?.runtimeState ?? this.seller.deal(dealId)?.state ?? "UNKNOWN",
            payload: response,
          });
          return send(response);
        }

        case "request-delivery": {
          const dealId = String(data["dealId"] ?? "");
          if (this.live !== undefined) {
            // No manual delivery path in live mode: delivery is
            // notification-driven (§6.5), and the buyer receives the artifact
            // location through the Runtime's evidence record. A peer-invokable
            // path here would hand the capability URLs to any opted-in caller.
            return refuse(
              "live delivery is notification-driven (§6.5) — the manual request-delivery path does not exist in live mode",
            );
          }
          // The capability URLs go only to the BUYER: prove it (demo-private
          // proof; see extension.ts). A deal id alone — visible on /admin — is
          // not authorization.
          const deal = this.seller.deal(dealId);
          if (deal === undefined) return refuse(`unknown deal ${dealId}`);
          verifyDeliveryRequest({
            dealId,
            requestedAt: Number(data["requestedAt"]),
            buyerSig: String(data["buyerSig"] ?? ""),
            buyerAddress: deal.buyerAddress,
          });
          this.seller.recordInteraction(dealId, {
            phase: "fulfillment",
            direction: "buyer-to-seller",
            kind: "request-delivery",
            summary: "Buyer requested delivery with a verified freshness proof",
            state: deal.runtimeState ?? deal.state,
            payload: { dealId, requestedAt: Number(data["requestedAt"]) },
          });
          const out = await this.seller.deliver(dealId);
          return send({
            kind: "delivery",
            dealId,
            manifestUrl: out.manifestUrl,
            csvUrl: out.csvUrl,
            deliveryHash: out.deal.deliveryHash,
            evidenceEnvelope: out.envelope,
            command: out.command,
            note:
              "standalone mode: the command's settlement anchors are documented placeholders; " +
              "the construction and every signature are real, the values are not, and nothing " +
              "here can be submitted to a Runtime",
          });
        }

        default:
          return refuse(`unknown negotiation kind ${JSON.stringify(data["kind"])}`);
      }
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  }

  async cancelTask(): Promise<void> {}
}
