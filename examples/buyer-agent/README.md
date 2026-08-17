# Example buyer agent

An A2A **client** that builds and verifies every buyer-side object of the
agreement flow, against a live example seller:

1. discovers the seller and the Coordination Engine, verifying the engine
   card's Extension declaration, template, and keys before signing anything
   (`resolve_runtime_binding`);
2. negotiates with the seller over plain A2A (off-protocol — never enters
   the workflow or the audit chain);
3. assembles final terms as a `DealContract` and signs first — the proposal
   (`extension.draft_contract`, `extension.propose`);
4. checks the seller's countersignature against the identical `termsHash`
   (`extension.verify_acceptance`);
5. builds the signed funding envelope it would submit
   (`extension.funding_envelope`);
6. verifies the seller's `delivered` command, then builds its own signed
   accept/reject command (`extension.verify_delivery`,
   `extension.accept` / `extension.reject`).

**What it does not do.** It never submits to a Coordination Runtime. Steps 5
and 6 print the signed objects and verify them locally; there is no `funding`,
`funding-signatures`, `command`, `evidence-list` or `proofs` interaction sent, and no proof
chain is fetched. Everything it exchanges over the wire goes to the example
*seller*. That boundary is deliberate — the example demonstrates that the
published schemas and signing rules are sufficient to CONSTRUCT correct
objects, which is a different claim from having executed the workflow.

**Two media types.** Because the peer is another agent and not a Runtime, none
of what this client sends is a §6.2 interaction, and none of it carries the
Extension's `application/vnd.gokite.agreement-command+json;version=1`. The
requests go out on the demo-private
`application/vnd.gokite.example-negotiation+json;version=1` —
`request-terms`, `submit-proposal`, `acceptance-request`, `request-delivery` —
while the objects inside them are built to the published schemas. The
`_send_negotiation` helper takes the media type as a parameter for exactly
this reason: point it at a Runtime and the Extension's type is what it
carries. See [`../README.md`](../README.md) for the full split. The §2.2
opt-in (header *and* `extensions` array) rides on every one of these requests.

Built on the official `a2a-sdk` plus this bundle's schemas — no Kite SDK.

## Run

Start the example seller first (see `../seller-agent`), then:

```bash
pip install -e .
SELLER_AGENT_URL=http://localhost:9999 \
python -m buyer_agent
```

| Env | Default | Meaning |
|---|---|---|
| `SELLER_AGENT_URL` | `http://localhost:9999` | Where to resolve the seller's Agent Card |
| `SELLER_AGENT_ID` | `did:kite:pubco:seller-42` | Seller's Kite Identity DID for the terms |
| `BUYER_AGENT_ID` | `did:kite:acme:buyer-17` | Buyer's Kite Identity DID |
| `KITE_COORDINATION_ENDPOINT` | `https://passport.dev.gokite.ai/a2a/v1` | The Runtime whose Agent Card is read for the `runtimeBinding` pin. Only the card is fetched; no interaction is submitted |

Status: working demo. Every signature and hash is computed and verified for
real against the example seller. The funding envelope and the accept/reject
command are constructed, printed and locally verified rather than submitted —
they are exactly the bytes that would go to `KITE_COORDINATION_ENDPOINT` as
Extension-typed Parts (spec §6), which is a construction claim, not a
submission one. This is a boundary of the bundled buyer example, not a claim
that the accepted path has never run: an external buyer participant has
completed that path against the deployed reference seller and a live Runtime.
See [`../../conformance/live-validation.md`](../../conformance/live-validation.md).
