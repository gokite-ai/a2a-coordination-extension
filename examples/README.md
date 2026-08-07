# Example agents (non-normative)

Two self-contained Python agents demonstrating the Extension end to end.
They are documentation, not products — and deliberately **do not use any
Kite SDK**: both are built on the official
[`a2a-sdk`](https://pypi.org/project/a2a-sdk/) (a2a-python) plus the
schemas and test vectors in this bundle. That is the point: an existing A2A
stack plus this bundle is sufficient to interoperate.

| Agent | Role |
|---|---|
| [`buyer-agent/`](buyer-agent/) | A2A **client**: negotiates with the seller over plain A2A, then drives the agreement — proposes terms (first signature over `termsHash`), funds, decides on delivery, fetches the proof package |
| [`seller-agent/`](seller-agent/) | A2A **server + extension participant**: publishes an Agent Card declaring the Extension (`required: false`), serves a quoting skill for negotiation, countersigns accepted terms, submits signed `delivery.submit` commands, and verifies transition receipts |

Each agent duplicates its small `signing.py` on purpose — self-containment
beats sharing here, so either directory can be read (or copied) alone.

## Running locally

Both agents talk to the Coordination Engine's published A2A endpoint,
configured via environment:

```
KITE_COORDINATION_ENDPOINT   # the Runtime's A2A endpoint (from its Agent Card)
SELLER_AGENT_URL             # where buyer finds the seller (default http://localhost:9999)
```

```bash
# terminal 1 — seller (A2A server)
cd seller-agent && pip install -e . && python -m seller_agent

# terminal 2 — buyer (drives the flow)
cd buyer-agent && pip install -e . && python -m buyer_agent
```

The buyer drives the full flow end to end: negotiate (plain A2A) →
propose (first signature over `termsHash`) → acceptance (seller's second
signature over the identical hash) → fund → delivery (signed
`delivery.submit` + evidence commitment) → decide. Every signature and
hash is computed and verified for real against the DRAFT schemas. The one
demo simplification: no live Coordination Engine exists yet, so the signed
commands are printed and locally verified instead of submitted — they are
exactly what would be sent to `KITE_COORDINATION_ENDPOINT` as
Extension-typed Parts once a Runtime is running (spec §6). Demo-only
shortcuts (in-band public-key exchange instead of Identity DID resolution,
buyer-triggered delivery instead of the funding-finality work-start
signal) are marked in the code where they occur.
