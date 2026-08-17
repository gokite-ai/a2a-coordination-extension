/**
 * Kite Identity runtime binding (§8) — the same flow as `seller-agent/`'s
 * `runtime_bind.py`, in TypeScript: at boot the agent REGISTERS its durable
 * key against its own DID, then polls until an owner approves.
 *
 * Why the binding matters: §8 says the key that signs coordination commands
 * is the key Identity has bound to the agent's DID, and §4 says the
 * EscrowVault authorizes the keccak address of that same key. An unbound
 * agent can still negotiate and sign, but a counterparty resolving its DID
 * finds no key to check the signature against, and settlement has no address
 * to pay — so live mode refuses to SIGN until the binding is active.
 *
 * ## The bind is tokenless, so it always lands pending
 *
 * This path names the (public, directory-discoverable) agent id rather than
 * presenting an owner-minted bind token. Naming a public identifier proves
 * nothing about authority, so Identity records the result as a REQUEST: it
 * lands `pending` unconditionally, marked `bind_method: "direct"`. An agent
 * cannot approve itself — a human with owner rights runs
 * `POST /v1/agents/{agent}/runtimes/{runtime}:approve`.
 *
 * That is why this module polls rather than re-registers: a second POST files
 * a second pending request against the same key and buries the owner in
 * duplicates. It registers ONCE, then waits.
 *
 * ## Reading the owner's approval back without credentials
 *
 * Listing an agent's bindings is owner-authenticated, so the agent cannot ask
 * for its own. It does not need to: `GET /v1/agents:lookup?ref=secp256k1:…`
 * is public, and resolving BY KEY deliberately answers only for a live
 * binding — pending claims and revoked bindings do not resolve at all. The
 * 404→200 flip of that one public call IS the approval signal, and the 200
 * additionally carries `matched_runtime.status` to confirm what answered.
 */
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";

type Json = Record<string, any>;

export const identityBaseUrl = (): string =>
  (process.env["KITE_IDENTITY_BASE_URL"] ?? "").trim().replace(/\/$/, "");

export const bindRetrySeconds = (): number =>
  Number(process.env["SELLER_RUNTIME_BIND_RETRY_SECONDS"] ?? "300");

/**
 * `auto` (default) files the tokenless bind request when the key does not
 * resolve; `off` only polls — for a deployment that knows the request was
 * already filed. KNOWN LIMIT (review finding): the register-once guard is
 * process-local, and Identity's RegisterRuntimeDirect creates a NEW pending
 * row per request with no (agent, pub_key) dedup, while the pending list is
 * owner-authenticated — so an agent redeployed before the owner approves
 * files one more pending request per boot, and no client-side check can see
 * the earlier one. The duplicates are same-key, same-agent rows: approving
 * any one of them activates the key, and the rest stay pending clutter. The
 * durable fix is server-side idempotency in RegisterRuntimeDirect; until it
 * ships, `off` is the lever for redeploy-heavy environments.
 */
export const bindRegisterMode = (): "auto" | "off" =>
  (process.env["SELLER_RUNTIME_BIND_REGISTER"] ?? "auto") === "off" ? "off" : "auto";

/** Distinct from the token path's tag so a proof minted for one registration
 *  path can never be replayed on the other. */
export const DIRECT_BIND_DOMAIN = "kite:identity:runtime-bind:direct:v1";

/** What this runtime reports about itself at registration. Advisory only. */
const runtimeDescriptor = (): Json => ({
  software: "kite-example-data-seller-agent",
  env: process.env["SELLER_RUNTIME_ENV"] ?? "example",
});

/**
 * `secp256k1:<base64std of the 33-byte compressed point>` — the exact
 * spelling Identity parses, and the same string that goes into the signed
 * proof, so the two can never disagree.
 */
export function pubKeyRef(privateKey: Uint8Array): string {
  return "secp256k1:" + Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString("base64");
}

/**
 * base64std of the ASN.1 DER ECDSA signature over SHA-256 of
 *
 *     kite:identity:runtime-bind:direct:v1\n<nonce>\n<agent_id>\n<pub_key>
 *
 * `<agent_id>` is the STORAGE id (`agt_…`), not the DID: the handler rebuilds
 * this message from its path parameter, so signing the DID would verify
 * against a different string and fail.
 */
export function bindProof(
  privateKey: Uint8Array,
  nonce: string,
  agentStorageId: string,
  pubKey: string,
): string {
  const message = [DIRECT_BIND_DOMAIN, nonce, agentStorageId, pubKey].join("\n");
  const digest = createHash("sha256").update(message, "utf8").digest();
  const sig = secp256k1.sign(digest, privateKey, { lowS: true });
  return Buffer.from(sig.toDERRawBytes()).toString("base64");
}

export type BindState = "disabled" | "no-key" | "pending" | "active" | "error";

/** What the home page, the logs and the live signing gate read. */
export interface BindStatus {
  state: BindState;
  detail: string;
  runtimeId: string;
  pubKey: string;
  agentStorageId: string;
  checkedAt: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unwrap Identity's `{data, error, details}` envelope. */
const dataOf = async (resp: Response): Promise<Json> => (((await resp.json()) as Json)["data"] ?? {}) as Json;

export class RuntimeBinding {
  readonly status: BindStatus = {
    state: "disabled",
    detail: "runtime binding not configured",
    runtimeId: "",
    pubKey: "",
    agentStorageId: "",
    checkedAt: "",
  };

  constructor(
    private readonly agentDid: string,
    private readonly privateKey: Uint8Array | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retrySecondsOverride?: number,
  ) {}

  private touch(state: BindState, detail: string): void {
    this.status.state = state;
    this.status.detail = detail;
    this.status.checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /**
   * The live signing gate: a human-readable reason to refuse, or null when
   * signing is safe. Passport verifies every signature against the DID's
   * ACTIVE binding, so a signature from an unbound key is refused whoever
   * relays it — refusing here just moves the failure to where it is legible.
   */
  block(): string | null {
    if (this.status.state === "active") return null;
    return `runtime binding is ${this.status.state} (${this.status.detail}) — a signature from an unbound key is refused by Passport whoever relays it`;
  }

  /**
   * Kick off the bind task, or record why there is nothing to do. Never
   * throws and never blocks startup: an example whose HTTP server refuses to
   * come up because an unrelated identity service is unreachable would be a
   * worse example.
   */
  start(): void {
    if (identityBaseUrl() === "") {
      this.touch("disabled", "KITE_IDENTITY_BASE_URL unset — running with an ephemeral demo key");
      return;
    }
    if (this.privateKey === undefined) {
      this.touch("no-key", "KITE_IDENTITY_BASE_URL is set but no durable runtime key was readable");
      return;
    }
    this.touch("pending", "resolving agent and filing bind request");
    void this.maintain(this.privateKey);
  }

  /** DID → `agt_…`. Public, unauthenticated. */
  private async resolveAgentStorageId(): Promise<string> {
    const resp = await this.fetchImpl(
      `${identityBaseUrl()}/v1/agents:lookup?ref=${encodeURIComponent(this.agentDid)}`,
    );
    if (!resp.ok) throw new Error(`agent lookup answered HTTP ${resp.status}`);
    const storageId = String((await dataOf(resp))["id"] ?? "");
    if (storageId === "") throw new Error(`lookup of ${this.agentDid} returned no agent id`);
    return storageId;
  }

  /**
   * The approval probe: resolve the agent BY KEY. 404 is the expected answer
   * while the binding is pending — not an error. Returns the whole directory
   * ENTRY: resolving by key answers with whatever agent the key is bound
   * under, and the caller must check that agent is OURS.
   */
  private async lookupLiveBinding(pubKey: string): Promise<Json | null> {
    const resp = await this.fetchImpl(
      `${identityBaseUrl()}/v1/agents:lookup?ref=${encodeURIComponent(pubKey)}`,
    );
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`key lookup answered HTTP ${resp.status}`);
    return dataOf(resp);
  }

  /** Fetch a single-use nonce, then file the tokenless bind request. */
  private async registerDirect(agentStorageId: string, privateKey: Uint8Array, pubKey: string): Promise<Json> {
    const nonceResp = await this.fetchImpl(`${identityBaseUrl()}/v1/runtimes:issueBindNonce`, {
      method: "POST",
    });
    if (!nonceResp.ok) throw new Error(`issueBindNonce answered HTTP ${nonceResp.status}`);
    const nonce = String((await dataOf(nonceResp))["nonce"] ?? "");
    if (nonce === "") throw new Error("issueBindNonce returned no nonce");

    const resp = await this.fetchImpl(
      `${identityBaseUrl()}/v1/agents/${agentStorageId}/runtimes:registerDirect`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nonce,
          pub_key: pubKey,
          proof: bindProof(privateKey, nonce, agentStorageId, pubKey),
          ...runtimeDescriptor(),
        }),
      },
    );
    if (!resp.ok) throw new Error(`registerDirect answered HTTP ${resp.status}`);
    return dataOf(resp);
  }

  /**
   * Bind once, then poll until an owner approves. Returns — ending the task —
   * as soon as the binding is live. Everything else loops on the retry
   * interval, including failures: an Identity that is down at boot must not
   * leave the agent permanently unbound.
   */
  private async maintain(privateKey: Uint8Array): Promise<void> {
    const pubKey = pubKeyRef(privateKey);
    this.status.pubKey = pubKey;
    const retryMs = (this.retrySecondsOverride ?? bindRetrySeconds()) * 1000;
    let registered = false;
    // Latched forever once the owner has approved: a key that stops
    // resolving AFTER an approval was revoked or superseded, and filing a
    // fresh pending request would undo the owner's decision.
    let everActive = false;

    for (;;) {
      try {
        const entry = await this.lookupLiveBinding(pubKey);
        if (entry !== null) {
          // FAIL CLOSED on anything but an exact match. A key resolving to
          // some OTHER agent would let this agent sign under an identity a
          // counterparty resolves to a different DID — and a 200 whose entry
          // carries NO did at all is a malformed answer, not an approval:
          // "active" here is what unlocks live signing, so it is granted only
          // for a response that names exactly this agent. Both cases stay on
          // the retry loop so a fixed registry is picked up without a restart.
          const resolvedDid = String(entry["did"] ?? "");
          if (resolvedDid !== this.agentDid) {
            this.touch(
              "error",
              resolvedDid === ""
                ? "key lookup answered 200 with no DID — refusing to treat a malformed entry as an approval"
                : `runtime key is bound to ${resolvedDid}, not ${this.agentDid} — refusing to report the binding as ours`,
            );
            await sleep(retryMs);
            continue;
          }
          const matched = (entry["matched_runtime"] ?? {}) as Json;
          this.status.runtimeId = String(matched["id"] ?? "");
          everActive = true;
          if (this.status.state !== "active") {
            this.touch(
              "active",
              `runtime ${this.status.runtimeId || "(id withheld)"} is active (${matched["bind_method"] ?? "direct"} bind) — owner approval confirmed`,
            );
          } else {
            this.status.checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
          }
          // Deliberately NOT a return (review finding): an approval is not
          // forever — an owner can revoke the runtime, and a revoked key
          // stops resolving. Keep revalidating so the signing gate closes
          // when that happens, instead of signing until the next restart.
          await sleep(retryMs);
          continue;
        }

        if (everActive) {
          // Previously active, now unresolvable: the owner revoked (or
          // superseded) the binding. Close the gate and keep polling — a
          // re-approval reopens it without a restart. No re-registration,
          // ever again in this process: filing a fresh pending request
          // against a revocation would undo the owner's decision.
          if (this.status.state !== "error") {
            this.touch(
              "error",
              "binding no longer resolves — revoked or superseded; signing is closed until an owner re-approves",
            );
          } else {
            this.status.checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
          }
          await sleep(retryMs);
          continue;
        }

        if (!registered && bindRegisterMode() === "auto") {
          // Resolved per attempt rather than cached: a DID that does not
          // exist yet is a normal boot-order race.
          if (this.status.agentStorageId === "") {
            this.status.agentStorageId = await this.resolveAgentStorageId();
          }
          const view = await this.registerDirect(this.status.agentStorageId, privateKey, pubKey);
          registered = true;
          this.status.runtimeId = String(view["id"] ?? "");
          this.touch(
            "pending",
            `runtime ${this.status.runtimeId || "(id withheld)"} filed a tokenless bind request; ` +
              `awaiting owner approval (POST /v1/agents/${this.status.agentStorageId}/runtimes/${this.status.runtimeId}:approve)`,
          );
        } else if (registered) {
          // Deliberately does NOT re-register: a second POST files a second
          // pending request against the same key.
          this.touch("pending", this.status.detail.split(";")[0] + "; awaiting owner approval");
        } else {
          // SELLER_RUNTIME_BIND_REGISTER=off: poll-only.
          this.touch("pending", "registration disabled (SELLER_RUNTIME_BIND_REGISTER=off); polling for an existing binding");
        }
      } catch (error) {
        this.touch("error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
      await sleep(retryMs);
    }
  }
}
