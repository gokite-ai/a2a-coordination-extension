/**
 * The §8 runtime-bind flow against a fake Kite Identity, in the mold of
 * `seller-agent/`'s `test_runtime_bind.py`:
 *
 *  - registration files ONE tokenless bind request, with a DER proof the
 *    fake Identity verifies against the message it rebuilds server-side;
 *  - the request lands `pending` and the agent does NOT re-register while it
 *    waits (a second POST would bury the owner in duplicate requests);
 *  - the OWNER's approval is read back through the public lookup-by-key
 *    404→200 flip — the approval check the deployment relies on;
 *  - live signing is gated: a LiveCoordinator refuses to countersign while
 *    the binding is pending and stops refusing the moment it is active;
 *  - a key that resolves to some OTHER agent's DID is an error state, never
 *    reported as ours.
 */
import express from "express";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { RuntimeBinding, bindProof, pubKeyRef, DIRECT_BIND_DOMAIN } from "../src/binding.js";
import { LiveCoordinator } from "../src/live.js";
import { CoordinationClient } from "../src/coordination.js";
import { fromHex } from "../src/signing.js";
import { DataSeller } from "../src/seller.js";
import { fileURLToPath } from "node:url";

const SELLER_KEY = fromHex("0x2222222222222222222222222222222222222222222222222222222222222222");
const DID = "did:kite:corp-kite:example-data-seller-agent";
const AGENT_STORAGE_ID = "agt_0123456789";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeIdentity {
  registrations = 0;
  approved = false;
  boundDid = DID;
  /** Fault injection: answer the key lookup 200 with an EMPTY entry. */
  emptyEntry = false;
  lastProofValid: boolean | undefined;
  server!: Server;
  url!: string;

  async start(): Promise<void> {
    const app = express();
    app.use(express.json());
    app.get("/v1/agents:lookup", (req, res) => {
      const ref = String(req.query["ref"] ?? "");
      if (ref === DID) {
        res.json({ data: { id: AGENT_STORAGE_ID, did: DID } });
        return;
      }
      if (ref.startsWith("secp256k1:")) {
        // Resolving BY KEY answers only for a live (approved) binding —
        // pending claims do not resolve at all. This 404→200 flip IS the
        // owner-approval signal the agent watches.
        if (!this.approved) {
          res.status(404).json({ error: "no live binding" });
          return;
        }
        if (this.emptyEntry) {
          res.json({ data: {} });
          return;
        }
        res.json({
          data: {
            id: AGENT_STORAGE_ID,
            did: this.boundDid,
            matched_runtime: { id: "rt_test_1", status: "active", bind_method: "direct" },
          },
        });
        return;
      }
      res.status(404).json({ error: "unknown ref" });
    });
    app.post("/v1/runtimes:issueBindNonce", (_req, res) => {
      res.json({ data: { nonce: "nonce_" + Math.random().toString(36).slice(2) } });
    });
    app.post("/v1/agents/:agentId/runtimes:registerDirect", (req, res) => {
      this.registrations += 1;
      const body = req.body as Record<string, string>;
      // Verify the proof against the message rebuilt SERVER-side, from the
      // path parameter — exactly what real Identity does, so a proof signed
      // over the DID instead of the storage id fails here.
      const message = [DIRECT_BIND_DOMAIN, body["nonce"], String(req.params["agentId"]), body["pub_key"]].join("\n");
      const digest = createHash("sha256").update(message, "utf8").digest();
      const compressed = Buffer.from(String(body["pub_key"]).replace("secp256k1:", ""), "base64");
      const der = Buffer.from(String(body["proof"]), "base64");
      try {
        this.lastProofValid = secp256k1.verify(secp256k1.Signature.fromDER(der).toCompactRawBytes(), digest, compressed);
      } catch {
        this.lastProofValid = false;
      }
      if (this.lastProofValid !== true) {
        res.status(400).json({ error: "bad proof" });
        return;
      }
      res.json({ data: { id: "rt_test_1", status: "pending", bind_method: "direct" } });
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}`;
  }
}

describe("runtime binding against a fake Identity", () => {
  const fake = new FakeIdentity();
  const savedEnv = process.env["KITE_IDENTITY_BASE_URL"];

  beforeAll(async () => {
    await fake.start();
    process.env["KITE_IDENTITY_BASE_URL"] = fake.url;
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env["KITE_IDENTITY_BASE_URL"];
    else process.env["KITE_IDENTITY_BASE_URL"] = savedEnv;
    fake.server.close();
  });

  afterEach(() => {
    fake.registrations = 0;
    fake.approved = false;
    fake.boundDid = DID;
    fake.emptyEntry = false;
  });

  it("registers once with a verifiable DER proof, stays pending, and flips active on owner approval", async () => {
    const binding = new RuntimeBinding(DID, SELLER_KEY, fetch, 0.05);
    binding.start();

    // One registration, proof verified server-side, state pending.
    await sleep(200);
    expect(fake.registrations).toBe(1);
    expect(fake.lastProofValid).toBe(true);
    expect(binding.status.state).toBe("pending");
    expect(binding.status.detail).toContain("awaiting owner approval");
    expect(binding.status.runtimeId).toBe("rt_test_1");

    // Several more polls: still exactly ONE registration filed.
    await sleep(300);
    expect(fake.registrations).toBe(1);
    expect(binding.status.state).toBe("pending");

    // The owner approves (out of band); the public lookup starts resolving,
    // and the agent reports the binding active.
    fake.approved = true;
    await sleep(300);
    expect(binding.status.state).toBe("active");
    expect(binding.status.detail).toContain("owner approval confirmed");
    expect(binding.block()).toBeNull();
  });

  it("live signing is gated on the approval", async () => {
    const binding = new RuntimeBinding(DID, SELLER_KEY, fetch, 0.05);
    binding.start();
    await sleep(150); // registered, pending

    const seller = new DataSeller({
      privateKey: SELLER_KEY,
      publicUrl: "http://127.0.0.1:0",
      corpusPath: fileURLToPath(new URL("../fixtures/places-ca-ny.csv.gz", import.meta.url)),
      seedSecret: "bind-test",
    });
    // No boot needed: the gate refuses before anything touches the corpus.
    const live = new LiveCoordinator(
      seller,
      new CoordinationClient("http://127.0.0.1:1/a2a/v1", DID, SELLER_KEY, "kid"),
      SELLER_KEY,
      { binding },
    );
    await expect(
      live.countersign("deal_x", "neg_x", {}, "0x" + "11".repeat(20), "0x"),
    ).rejects.toThrow(
      /runtime binding is pending/,
    );

    fake.approved = true;
    await sleep(200);
    expect(binding.status.state).toBe("active");
    // Past the gate now: the next refusal is the (unreachable) Runtime, not the binding.
    await expect(
      live.countersign("deal_x", "neg_x", {}, "0x" + "11".repeat(20), "0x"),
    ).rejects.toThrow(
      /fetch failed|ECONNREFUSED|runtime answered/,
    );
  });

  it("a key bound to some OTHER agent is an error state, never reported as ours", async () => {
    fake.approved = true;
    fake.boundDid = "did:kite:somebody:else";
    const binding = new RuntimeBinding(DID, SELLER_KEY, fetch, 0.05);
    binding.start();
    await sleep(200);
    expect(binding.status.state).toBe("error");
    expect(binding.status.detail).toContain("not " + DID);
    expect(binding.block()).not.toBeNull();
  });

  it("an approval is not forever: revocation closes the signing gate without a restart", async () => {
    fake.approved = true;
    const binding = new RuntimeBinding(DID, SELLER_KEY, fetch, 0.05);
    binding.start();
    await sleep(200);
    expect(binding.status.state).toBe("active");
    expect(binding.block()).toBeNull();

    // The owner revokes: the key stops resolving. The gate must close on the
    // next revalidation tick, not on the next Pod restart.
    fake.approved = false;
    await sleep(300);
    expect(binding.status.state).toBe("error");
    expect(binding.status.detail).toContain("revoked or superseded");
    expect(binding.block()).not.toBeNull();
    // No fresh pending request was filed against the owner's decision.
    expect(fake.registrations).toBe(0);

    // A re-approval reopens the gate, still without a restart.
    fake.approved = true;
    await sleep(300);
    expect(binding.status.state).toBe("active");
    expect(binding.block()).toBeNull();
  });

  it("SELLER_RUNTIME_BIND_REGISTER=off polls without ever filing a request", async () => {
    process.env["SELLER_RUNTIME_BIND_REGISTER"] = "off";
    try {
      const binding = new RuntimeBinding(DID, SELLER_KEY, fetch, 0.05);
      binding.start();
      await sleep(200);
      expect(fake.registrations).toBe(0);
      expect(binding.status.state).toBe("pending");
      expect(binding.status.detail).toContain("registration disabled");

      fake.approved = true;
      await sleep(300);
      expect(binding.status.state).toBe("active");
    } finally {
      delete process.env["SELLER_RUNTIME_BIND_REGISTER"];
    }
  });

  it("a 200 with an empty entry is a malformed answer, never an approval", async () => {
    fake.approved = true;
    fake.emptyEntry = true;
    const binding = new RuntimeBinding(DID, SELLER_KEY, fetch, 0.05);
    binding.start();
    await sleep(200);
    expect(binding.status.state).toBe("error");
    expect(binding.status.detail).toContain("no DID");
    expect(binding.block()).not.toBeNull();
  });

  it("the proof construction matches what Identity verifies", () => {
    const pubKey = pubKeyRef(SELLER_KEY);
    const proof = bindProof(SELLER_KEY, "nonce_1", AGENT_STORAGE_ID, pubKey);
    const message = [DIRECT_BIND_DOMAIN, "nonce_1", AGENT_STORAGE_ID, pubKey].join("\n");
    const digest = createHash("sha256").update(message, "utf8").digest();
    const compressed = Buffer.from(pubKey.replace("secp256k1:", ""), "base64");
    expect(
      secp256k1.verify(secp256k1.Signature.fromDER(Buffer.from(proof, "base64")).toCompactRawBytes(), digest, compressed),
    ).toBe(true);
  });
});
