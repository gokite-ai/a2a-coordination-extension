# Example seller agent

An A2A **server** that participates in the Kite Coordination Extension:

- publishes an Agent Card declaring the Extension with `required: false`
  (a participant card — the seller stays usable for unrelated A2A work);
- serves a `quote-service` skill for off-protocol negotiation (plain A2A
  chat that never enters the workflow or the audit chain);
- countersigns final terms — acceptance is the second signature over
  exactly the proposal's `termsHash` (`extension.accept_terms`);
- submits signed `kite.contract.delivered` commands to the Coordination Engine's
  published endpoint and verifies the returned transition receipts
  (`extension.submit_delivery`).

Built on the official `a2a-sdk` plus this bundle's schemas — no Kite SDK.

## Run

```bash
pip install -e .
SELLER_PORT=9999 KITE_COORDINATION_ENDPOINT=http://localhost:8080/a2a python -m seller_agent
```

| Env | Default | Meaning |
|---|---|---|
| `SELLER_HOST` / `SELLER_PORT` | `0.0.0.0` / `9999` | Bind address |
| `SELLER_PUBLIC_URL` | `http://localhost:9999/` | URL advertised in the Agent Card |
| `SELLER_AGENT_ID` | `did:kite:pubco:seller-42` | Kite Identity DID |
| `KITE_COORDINATION_ENDPOINT` | `http://localhost:8080/a2a` | The Runtime's published A2A endpoint |

Status: working demo. Negotiation answers with a fixed quote;
countersigning verifies the buyer's signature against the seller's OWN
recomputed `termsHash` before signing; delivery produces real content, a
a really-signed `evidence` party envelope (§6.2.1), and a really-signed
`kite.contract.delivered` command citing the id that envelope registers.
Runtime submission and receipt verification await a live Coordination
Engine (marked in code, spec §6); the in-band public-key exchange is a
demo-only stand-in for Identity DID resolution (spec §8).
