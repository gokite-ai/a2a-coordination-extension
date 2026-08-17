/**
 * The seller's HTTP surface: one express app carrying
 *
 *   /.well-known/agent-card.json   the Agent Card
 *   /a2a/v1                        the A2A JSON-RPC binding
 *   /terms/:hash                   content-addressed terms documents (public:
 *                                  pre-signing negotiation content)
 *   /deliveries/:dealId/:file      the delivered artifacts, capability-gated
 *                                  (DESIGN §5): right deal + right token or a
 *                                  404 that reveals nothing
 *   /admin                         buyer-organized negotiation + agreement
 *                                  history (process-local demo state)
 *   /                              home page: mode + what this example is
 *
 * `main()` boots standalone mode. Live mode (PLAN phase 3) adds the binding
 * check and the Runtime client on the same surface.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { buildAgentCard } from "./card.js";
import { DataSellerExecutor } from "./executor.js";
import { DataSeller, ephemeralKey } from "./seller.js";
import { fromHex, jcs, sha256Ref } from "./signing.js";
import {
  CONTRACT_MESSAGE_MEDIA_TYPE,
  EXTENSION_URI,
  NEGOTIATION_MEDIA_TYPE,
  SELLER_AGENT_ID,
  coordinationEndpoint,
} from "./extension.js";
import { CoordinationClient } from "./coordination.js";
import { LiveCoordinator } from "./live.js";
import { RuntimeBinding } from "./binding.js";
import {
  renderAdminDetail,
  renderAdminIndex,
  renderAdminNotFound,
  renderBuyerDetail,
  renderHome,
} from "./home.js";

export interface BootResult {
  app: Express;
  seller: DataSeller;
  live?: LiveCoordinator;
  binding: RuntimeBinding;
  card: ReturnType<typeof buildAgentCard>;
  cardHash: string;
}

/**
 * §6.5 notifications need a JSON-RPC ERROR on failure — the relay treats any
 * well-formed A2A reply as delivered and never retries, and the SDK converts
 * an executor throw into a failed Task (a well-formed reply). So this narrow
 * adapter sits in FRONT of the SDK handler (the DESIGN §10.1 pattern for a
 * capability gap): it intercepts exactly the messages whose Part carries the
 * §6.5 contract-message media type, verifies by read-back, and answers with a
 * JSON-RPC result on success or a JSON-RPC error on anything unverifiable.
 * Every other request passes through untouched.
 */
function notificationGate(live: LiveCoordinator) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, any> | undefined;
    const message = body?.["params"]?.["message"];
    const parts: Record<string, any>[] = message?.["parts"] ?? [];
    const notePart = parts.find((p) => p["mediaType"] === CONTRACT_MESSAGE_MEDIA_TYPE && p["raw"]);
    if (body?.["method"] !== "SendMessage" || notePart === undefined) {
      next();
      return;
    }
    const jsonRpcError = (message_: string) =>
      res.json({
        jsonrpc: "2.0",
        id: body["id"],
        error: { code: -32000, message: message_ },
      });
    void (async () => {
      try {
        // §2.2 applies to notifications like every other Extension request:
        // BOTH halves of the opt-in, refused independently — and the refusal
        // is a JSON-RPC error so the relay's retry loop stays alive.
        const headerValue = String(req.headers["a2a-extensions"] ?? "");
        const requested = headerValue.split(",").map((v) => v.trim());
        if (!requested.includes(EXTENSION_URI)) {
          jsonRpcError(
            "notification does not activate the coordination extension via the A2A-Extensions header (§2.2)",
          );
          return;
        }
        if (!((message?.["extensions"] ?? []) as string[]).includes(EXTENSION_URI)) {
          jsonRpcError(
            "notification message does not declare the coordination extension in its extensions array (§2.2)",
          );
          return;
        }
        const note = JSON.parse(Buffer.from(String(notePart["raw"]), "base64").toString("utf8"));
        const ack = await live.handleNotification(note);
        // §2.2, server half: echo the activated Extension on the response
        // header AND the reply message.
        res.setHeader("A2A-Extensions", EXTENSION_URI);
        res.json({
          jsonrpc: "2.0",
          id: body["id"],
          result: {
            message: {
              messageId: "ack_" + Math.random().toString(36).slice(2),
              role: "ROLE_AGENT",
              parts: [
                {
                  raw: Buffer.from(JSON.stringify(ack)).toString("base64"),
                  mediaType: CONTRACT_MESSAGE_MEDIA_TYPE,
                },
              ],
              extensions: [EXTENSION_URI],
            },
          },
        });
      } catch (error) {
        jsonRpcError(error instanceof Error ? error.message : String(error));
      }
    })();
  };
}

export async function buildApp(config: {
  publicUrl: string;
  corpusPath: string;
  privateKey?: Uint8Array;
  seedSecret?: string;
  /** `live` requires a durable key and an ACTIVE runtime binding (fail-closed). */
  mode?: "standalone" | "live";
  /** Injectable for the fake-Runtime tests. */
  deliveryRetrySeconds?: number;
  outcomePollSeconds?: number;
  skipBindingCheck?: boolean;
}): Promise<BootResult> {
  const mode = config.mode ?? "standalone";
  const privateKey = config.privateKey ?? readDurableKey() ?? (mode === "live" ? undefined : ephemeralKey());
  if (privateKey === undefined) {
    // Fail closed: an unbound agent signs things nobody can verify and gets
    // paid to an address nobody can derive.
    throw new Error(
      "live mode refuses to start without a durable runtime key (SELLER_RUNTIME_PRIVATE_KEY or _FILE)",
    );
  }
  const seller = new DataSeller({
    privateKey,
    publicUrl: config.publicUrl,
    corpusPath: config.corpusPath,
    seedSecret: config.seedSecret ?? "demo-" + Math.random().toString(36).slice(2),
  });
  await seller.boot();

  // §8 runtime binding, same flow as seller-agent/: register the durable key
  // against this agent's DID at boot, then poll until an owner APPROVES —
  // the bind is tokenless, lands pending, and cannot self-approve. Signing
  // in live mode is gated on the approval; the server itself always comes up.
  const binding = new RuntimeBinding(SELLER_AGENT_ID, privateKey);
  if (config.skipBindingCheck === true) {
    // Test configuration: report as approved without an Identity round trip.
    binding.status.state = "active";
    binding.status.detail = "binding stubbed active (test configuration)";
  } else {
    binding.start();
  }

  let live: LiveCoordinator | undefined;
  if (mode === "live") {
    const runtime = new CoordinationClient(coordinationEndpoint(), SELLER_AGENT_ID, privateKey, seller.keyId);
    live = new LiveCoordinator(seller, runtime, privateKey, {
      binding,
      ...(config.deliveryRetrySeconds !== undefined
        ? { deliveryRetrySeconds: config.deliveryRetrySeconds }
        : {}),
      ...(config.outcomePollSeconds !== undefined ? { outcomePollSeconds: config.outcomePollSeconds } : {}),
    });
  }

  const card = buildAgentCard(config.publicUrl);
  const cardHash = sha256Ref(jcs(JSON.parse(JSON.stringify(card))));

  const app = express();
  app.get("/.well-known/agent-card.json", (_req, res) => {
    res.type("application/json").send(JSON.stringify(card, null, 2));
  });
  if (live !== undefined) {
    // Parse JSON only on the A2A route so the gate can inspect it; the SDK
    // handler reads the parsed body when present.
    app.use("/a2a/v1", express.json({ limit: "5mb" }));
    app.use("/a2a/v1", notificationGate(live));
  }
  app.use(
    "/a2a/v1",
    jsonRpcHandler({
      requestHandler: new DefaultRequestHandler(card, new InMemoryTaskStore(), new DataSellerExecutor(seller, live)),
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.get("/terms/:hash", (req, res) => {
    const doc = seller.termsDocumentByHash(String(req.params["hash"]));
    if (doc === undefined) {
      res.status(404).json({ error: "no such terms document (demo state is process-local)" });
      return;
    }
    // Canonical bytes, so what is fetched hashes to the path it was fetched by.
    res.type("application/json").send(Buffer.from(jcs(doc)));
  });
  app.get("/deliveries/:dealId/:file", (req, res) => {
    const bytes = seller.artifactFor(
      String(req.params["dealId"]),
      String(req.params["file"]),
      typeof req.query["cap"] === "string" ? req.query["cap"] : undefined,
    );
    if (bytes === undefined) {
      // 404, not 403: an unauthorized caller learns nothing about what exists.
      res.status(404).json({ error: "not found" });
      return;
    }
    res
      .type(String(req.params["file"]).endsWith(".csv") ? "text/csv" : "application/json")
      .send(bytes);
  });
  // The public pages (home.ts): the seller-agent/ presentation with the data
  // seller's own rows. The buyer-organized negotiation/agreement inventory is
  // process-local, non-durable, and intentionally unauthenticated — the pages
  // say so rather than pretend otherwise.
  app.get("/admin", async (_req, res) => {
    if (live !== undefined) {
      // Live: refresh observed outcomes so a later buyer-side release or
      // completion is reflected (and refund revocations applied).
      for (const deal of seller.dealRecords()) {
        try {
          await live.refreshOutcome(deal.dealId);
        } catch {
          // a deal the Runtime does not know stays at its local state
        }
      }
    }
    res.send(renderAdminIndex(seller.buyerRecords()));
  });

  app.get("/admin/buyers/:buyerAgentId", async (req, res) => {
    let buyer = seller.buyerRecord(String(req.params["buyerAgentId"]));
    if (buyer === undefined) {
      res.status(404).send(renderAdminNotFound("buyer"));
      return;
    }
    if (live !== undefined) {
      for (const deal of buyer.deals) {
        try {
          await live.refreshOutcome(deal.dealId);
        } catch {
          // Preserve the buyer's local negotiation and agreement history when
          // the Runtime is temporarily unavailable.
        }
      }
      buyer = seller.buyerRecord(buyer.buyerAgentId)!;
    }
    res.send(renderBuyerDetail(buyer));
  });

  app.get("/admin/agreements/:dealId", async (req, res) => {
    const deal = seller.deal(String(req.params["dealId"]));
    if (deal === undefined) {
      res.status(404).send(renderAdminNotFound("agreement"));
      return;
    }
    if (live !== undefined) {
      try {
        await live.refreshOutcome(deal.dealId);
      } catch {
        // Keep rendering the complete locally observed history when the
        // Runtime is temporarily unavailable.
      }
    }
    res.send(renderAdminDetail(deal));
  });

  app.get("/", (_req, res) => {
    res.send(renderHome({ card, cardHash, seller, binding: binding.status, mode }));
  });

  return { app, seller, ...(live !== undefined ? { live } : {}), binding, card, cardHash };
}

/** SELLER_RUNTIME_PRIVATE_KEY / _FILE — ordinary env/file indirection on purpose. */
function readDurableKey(): Uint8Array | undefined {
  const hexKey = process.env["SELLER_RUNTIME_PRIVATE_KEY"];
  if (hexKey) return fromHex(hexKey);
  const file = process.env["SELLER_RUNTIME_PRIVATE_KEY_FILE"];
  if (file) return fromHex(readFileSync(file, "utf8").trim());
  return undefined;
}

export async function main(): Promise<Server> {
  const host = process.env["SELLER_HOST"] ?? "0.0.0.0";
  const port = Number(process.env["SELLER_PORT"] ?? "9998");
  const publicUrl = process.env["SELLER_PUBLIC_URL"] ?? `http://localhost:${port}`;
  const corpusPath =
    process.env["CORPUS_PATH"] ?? new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url).pathname;
  const mode = (process.env["KITE_COORDINATION_MODE"] ?? "standalone") as "standalone" | "live";
  const { app, seller } = await buildApp({ publicUrl, corpusPath, mode });
  return app.listen(port, host, () => {
    console.log(`data-seller-agent listening on ${host}:${port} (public URL ${publicUrl})`);
    console.log(`corpus loaded: ${seller.corpus.totals.tracts} tracts; card/corpus consistency check passed`);
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  void main();
}
