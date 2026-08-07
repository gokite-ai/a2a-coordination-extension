# Example buyer agent

An A2A **client** that drives the agreement flow end to end:

1. discovers the seller and the Coordination Engine, verifying the engine
   card's Extension declaration, template, and keys before signing anything;
2. negotiates with the seller over plain A2A (off-protocol — never enters
   the workflow or the audit chain);
3. assembles final terms as a `DealContract` and signs first —
   the proposal (`extension.propose`);
4. funds under its delegated authority once the seller countersigns
   (`extension.fund`);
5. accepts or rejects delivery within the review window
   (`extension.decide` — no action auto-confirms, per the signed terms);
6. fetches and offline-verifies the proof package (`extension.fetch_proof`).

Built on the official `a2a-sdk` plus this bundle's schemas — no Kite SDK.

## Run

Start the example seller first (see `../seller-agent`), then:

```bash
pip install -e .
SELLER_AGENT_URL=http://localhost:9999 \
KITE_COORDINATION_ENDPOINT=http://localhost:8080/a2a \
python -m buyer_agent
```

| Env | Default | Meaning |
|---|---|---|
| `SELLER_AGENT_URL` | `http://localhost:9999` | Where to resolve the seller's Agent Card |
| `SELLER_AGENT_ID` | `did:kite:pubco:seller-42` | Seller's Kite Identity DID for the terms |
| `BUYER_AGENT_ID` | `did:kite:acme:buyer-17` | Buyer's Kite Identity DID |
| `KITE_COORDINATION_ENDPOINT` | `http://localhost:8080/a2a` | The Runtime's published A2A endpoint |

Status: working demo — the whole flow above runs against the example
seller, with every signature and hash computed and verified for real. The
signed funding/decision commands are printed and locally verified rather
than submitted (no live Coordination Engine yet — they are exactly what
would go to `KITE_COORDINATION_ENDPOINT` as Extension-typed Parts, spec
§6); proof-package retrieval also awaits the Runtime.
