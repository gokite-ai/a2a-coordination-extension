/**
 * §6 client for a Coordination Runtime (e.g. the Kite Passport persona).
 *
 * The seller's *outbound* leg — the TypeScript sibling of `seller-agent/`'s
 * `coordination.py`, same rules: fetch plus this bundle's own signing
 * helpers, no Kite SDK.
 *
 * Wire shape (§6.1/§6.3): a JSON-RPC 2.0 `SendMessage` whose single Part is
 * the interaction payload in `raw` (base64), tagged with the command media
 * type, opted in BOTH ways (§2.2). Payloads travel in `raw`, never in a
 * `data` Part: a proto Struct holds only doubles, so integer members like
 * `expectedRevision` would round-trip as 6.0 and break every signature over
 * the canonical bytes.
 *
 * Domain rejections (§7): `-32010` carries a catalog code plus `retriable`
 * and surfaces as DomainRejection so callers can branch on the Runtime's own
 * verdict; `-32003` (engine unreachable) is EngineUnreachable — a deployment
 * state, not a caller error.
 */
import { randomUUID } from "node:crypto";
import { COMMAND_MEDIA_TYPE, EXTENSION_URI, signPartyEnvelope } from "./extension.js";

type Json = Record<string, any>;

export class DomainRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable: boolean,
    readonly data: Json,
  ) {
    super(`${code}: ${message}`);
  }
}

export class EngineUnreachable extends Error {}

export class CoordinationClient {
  constructor(
    private readonly endpoint: string,
    private readonly agentId: string,
    private readonly privateKey: Uint8Array,
    private readonly keyId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(payload: Json): Promise<Json> {
    const requestId = randomUUID();
    const request = {
      jsonrpc: "2.0",
      id: requestId,
      method: "SendMessage",
      params: {
        message: {
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [
            {
              raw: Buffer.from(JSON.stringify(payload)).toString("base64"),
              mediaType: COMMAND_MEDIA_TYPE,
            },
          ],
          extensions: [EXTENSION_URI],
        },
      },
    };
    const resp = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "A2A-Extensions": EXTENSION_URI, "A2A-Version": "1.0" },
      body: JSON.stringify(request),
    });
    if (!resp.ok) throw new Error(`runtime answered HTTP ${resp.status}`);
    const body = (await resp.json()) as Json;
    // JSON-RPC discipline before reading anything out of the reply: the
    // version marker, and the id echo — a response to someone else's call
    // must never be read as the answer to ours.
    if (body["jsonrpc"] !== "2.0") throw new Error(`reply is not JSON-RPC 2.0: ${body["jsonrpc"]}`);
    if (body["id"] !== requestId) throw new Error(`reply id ${body["id"]} does not match request ${requestId}`);
    if (body["error"]) {
      const err = body["error"] as Json;
      const data = (err["data"] ?? {}) as Json;
      if (err["code"] === -32010) {
        throw new DomainRejection(
          String(data["code"] ?? "domain_error"),
          String(err["message"] ?? ""),
          Boolean(data["retriable"]),
          data,
        );
      }
      if (err["code"] === -32003) throw new EngineUnreachable(String(err["message"] ?? "engine not reachable"));
      throw new Error(`runtime rejected the call (${err["code"]}): ${err["message"]}`);
    }
    const message = ((body["result"] ?? {}) as Json)["message"] ?? {};
    // §2.2 both ways: the reply must echo the activated extension and speak
    // as the agent — a reply missing either is not a §6.3 answer.
    if (!((message["extensions"] ?? []) as string[]).includes(EXTENSION_URI)) {
      throw new Error("runtime reply does not echo the activated extension (§2.2)");
    }
    if (message["role"] !== "ROLE_AGENT") {
      throw new Error(`runtime reply role is ${message["role"]}, not ROLE_AGENT`);
    }
    for (const part of (message["parts"] ?? []) as Json[]) {
      if (part["mediaType"] === COMMAND_MEDIA_TYPE && part["raw"]) {
        return JSON.parse(Buffer.from(String(part["raw"]), "base64").toString("utf8")) as Json;
      }
    }
    throw new Error("runtime reply carries no extension raw Part (§6.3)");
  }

  private expect(reply: Json, kind: string): Json {
    if (reply["kind"] !== kind) throw new Error(`expected a ${kind} reply, got ${reply["kind"]}`);
    return reply;
  }

  /** A §6.2.1 party envelope, `kind` inside the signed bytes. */
  private envelope(kind: string, dealId: string, termsHash: string, extra?: Json): Json {
    return signPartyEnvelope(
      { kind, dealId, actorAgentId: this.agentId, termsHash, ...(extra ?? {}) },
      this.privateKey,
      this.keyId,
    );
  }

  // ── reads ──────────────────────────────────────────────────────────────

  /**
   * The Runtime's Agent Card, from the endpoint's origin (§2). Raw JSON
   * rather than the SDK parser: `x-kite-registry` is a Kite extension field a
   * proto parse would drop, and `agentCardHash` must cover the exact bytes
   * the Runtime serves.
   */
  async fetchRuntimeCard(): Promise<Json> {
    const url = new URL(this.endpoint);
    url.pathname = "/.well-known/agent-card.json";
    url.search = "";
    const resp = await this.fetchImpl(url.toString());
    if (!resp.ok) throw new Error(`runtime card fetch answered HTTP ${resp.status}`);
    return (await resp.json()) as Json;
  }

  /** The AgreementStatus — state, revision, latestProofHash, and the vault block (§4.4 anchors). */
  async status(dealId: string): Promise<Json> {
    const reply = await this.call({ kind: "status", dealId });
    return this.expect(reply, "agreement-status")["status"] as Json;
  }

  /**
   * The FundingContext: the Activation to sign, which artifacts have arrived,
   * and the EIP-712 domain (vaultAddress/chainId) — a party MUST take the
   * domain from here rather than from its own configuration.
   */
  async funding(dealId: string, termsHash: string): Promise<Json> {
    const reply = await this.call(this.envelope("funding", dealId, termsHash));
    return this.expect(reply, "agreement-funding")["funding"] as Json;
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /**
   * §6.2 `acceptance`: the countersigned contract. Authority is the
   * contract's two signatures, not the sender, so either party may deliver it.
   */
  async submitAcceptance(dealId: string, contract: Json): Promise<Json> {
    const reply = await this.call({ kind: "acceptance", dealId, contract });
    return this.expect(reply, "agreement-result");
  }

  /** Deliver this party's funding artifacts (§6.2.1). Returns the AgreementStatus. */
  async submitFundingSignatures(dealId: string, termsHash: string, submission: Json): Promise<Json> {
    const reply = await this.call(this.envelope("funding-signatures", dealId, termsHash, { submission }));
    return this.expect(reply, "agreement-funding-accepted")["status"] as Json;
  }

  /**
   * Register a delivery artifact; returns the Runtime-issued evidenceId — the
   * ONLY id a `delivered` command may cite (§6.2.1). Takes the pre-signed
   * envelope so the bytes submitted are exactly the bytes the executor also
   * hands the buyer.
   */
  async submitEvidenceEnvelope(envelope: Json): Promise<string> {
    const reply = await this.call(envelope);
    return String(this.expect(reply, "agreement-evidence-recorded")["evidenceId"]);
  }

  /** Submit a signed AgreementCommand (§6.2 `command`). */
  async submitCommand(command: Json): Promise<Json> {
    const reply = await this.call({ kind: "command", command });
    return this.expect(reply, "agreement-result");
  }
}
