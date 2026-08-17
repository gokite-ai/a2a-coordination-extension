/**
 * The seller's Agent Card: a PARTICIPANT card (§2.1) — the Extension is
 * declared `required: false`, so the seller stays usable for unrelated A2A
 * work, and `commandMediaType` names the type a Coordination Runtime speaks.
 *
 * The product disclosure (dataset provenance, rate card, deliverable
 * limitations, disclosed risk) rides in the extension `params`: non-normative,
 * but it is what makes the card a
 * falsifiable claim about the product rather than an advertisement — the
 * boot-time corpus check (`DataSeller.boot`) refuses to serve a card the
 * loaded data contradicts.
 */
import type { AgentCard } from "@a2a-js/sdk";
import { COMMAND_MEDIA_TYPE, EXTENSION_URI, NEGOTIATION_MEDIA_TYPE, SELLER_AGENT_ID } from "./extension.js";
import cardParams from "./card-params.json" with { type: "json" };

export function buildAgentCard(publicUrl: string): AgentCard {
  const url = publicUrl.replace(/\/$/, "") + "/a2a/v1";
  return {
    // A Kite extension field, outside the SDK's AgentCard type (a proto parse
    // would drop it, which is why counterparties read this card as raw JSON):
    // the registry identity a counterparty resolves through Kite Identity.
    ...({ "x-kite-registry": { agentId: SELLER_AGENT_ID } } as object),
    name: "Example data seller (CDC PLACES 2025)",
    description:
      "Non-normative example seller for the Kite Coordination Extension with a real deliverable: " +
      "synthetic individual-level records over the public CDC PLACES 2025 census-tract release. " +
      "Query-derived pricing from a published rate card, a free pre-purchase sample with a committed " +
      "statistics hash, and a delivery the buyer regenerates byte-for-byte from a published seed.",
    version: "0.0.1",
    provider: undefined,
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: EXTENSION_URI,
          description:
            "Kite Coordination Extension participant. Negotiation itself is off-protocol " +
            "(§2.3) on the demo-private media type below; the workflow objects it produces are " +
            "built to the published schemas.",
          required: false,
          params: {
            commandMediaType: COMMAND_MEDIA_TYPE,
            negotiationMediaType: NEGOTIATION_MEDIA_TYPE,
            ...(cardParams as Record<string, unknown>),
          },
        },
      ],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: [NEGOTIATION_MEDIA_TYPE],
    defaultOutputModes: [NEGOTIATION_MEDIA_TYPE, "text/csv", "application/json"],
    skills: [
      {
        id: "quote-dataset-slice",
        name: "Quote a dataset slice",
        description:
          "Free, before purchase: an unmodified real aggregate sample plus whole-slice statistics " +
          "with a committed statsHash, the itemised list price from the published rate card, and " +
          "the deliverable's shape (rows per tract, per-tract standard error) before any money moves.",
        tags: ["data", "census", "health", "quote", "sample"],
        inputModes: [NEGOTIATION_MEDIA_TYPE],
        outputModes: [NEGOTIATION_MEDIA_TYPE],
        examples: [],
        securityRequirements: [],
      },
      {
        id: "license-synthetic-individuals",
        name: "License synthetic individual records",
        description:
          "Licensed, after settlement: a synthetic individual-level CSV, one row per person, at a " +
          "guaranteed number of rows per purchased tract. No real person's record is in it; none " +
          "was ever read. Deterministic and buyer-regenerable from the manifest's published seed.",
        tags: ["data", "license", "synthetic", "delivery"],
        inputModes: [NEGOTIATION_MEDIA_TYPE],
        outputModes: ["text/csv", "application/json"],
        examples: [],
        securityRequirements: [],
      },
      {
        id: "verify-delivery-manifest",
        name: "Resolve a delivery manifest for verification",
        description:
          "The delivery manifest is the registered evidence artifact: its content hash is the " +
          "deliveryHash the settlement layer anchors, and it publishes the seed, the criteria hash " +
          "and the CSV's own hash — everything a buyer needs to regenerate and compare bytes.",
        tags: ["data", "verification", "audit"],
        inputModes: [NEGOTIATION_MEDIA_TYPE],
        outputModes: ["application/json"],
        examples: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}

export { SELLER_AGENT_ID };
