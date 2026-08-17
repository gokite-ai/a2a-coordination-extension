# Example agents (non-normative)

Three self-contained agents demonstrating the Extension's objects and
signing profiles — two in Python, one in TypeScript. Together they provide
local peer demos; both sellers also have a live mode that participates in a
real agreement through a Coordination Runtime. See "Mode boundaries" below
before reading either mode as a full conformance claim. They are documentation,
not products — and deliberately **do not use any Kite SDK**. The Python agents
use the official [`a2a-sdk`](https://pypi.org/project/a2a-sdk/) **1.x**; the
TypeScript data seller uses the official
[`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) **1.x**. Both are
from the A2A **1.0** generation (`raw` Parts with the Extension media type,
the `A2A-Extensions` header both ways, the corresponding role constants, and
the JSON-RPC binding). Every settlement signature is a real §4.4 EIP-712
construction. The buyer's `settlement.py` and the TypeScript seller's
`settlement.ts` implement the profile from the spec alone, and their tests
replay the published `settlement` vectors. The Python seller's implementation
is exercised by its transport and live-coordination tests but does not replay
the full vector set separately. That is the point: an existing A2A stack plus
this bundle is sufficient to interoperate, down to the signatures the vault
verifies.

| Agent | Role |
|---|---|
| [`buyer-agent/`](buyer-agent/) | Construction-focused A2A **client**: negotiates with the seller, signs terms and the §4.4 Agreement, builds funding artifacts, verifies delivery, and builds a buyer decision. It does not submit Runtime interactions |
| [`seller-agent/`](seller-agent/) | A2A **server + extension participant**: publishes an Agent Card declaring the Extension (`required: false`), countersigns accepted terms, and, in live mode, co-signs funding, registers evidence, and autonomously submits delivery through the Runtime |
| [`data-seller-agent/`](data-seller-agent/) | TypeScript seller (on the official `@a2a-js/sdk` 1.x) with a **real deliverable**: synthetic records over the public CDC PLACES release. Query-derived pricing recomputed at countersign, a terms document pinned through `acceptanceCriteria`, the delivery manifest as the registered evidence artifact, capability-gated artifacts, and a buyer that regenerates the file byte-for-byte from the published seed. Its negotiation rides its own demo-private media type (`example-data-negotiation+json`) |

The examples keep their signing implementations local on purpose: the two
Python agents each carry `signing.py`, and the TypeScript agent carries
`signing.ts`. Self-containment beats sharing, so every directory can be read
or copied alone.

## Two media types, and why

The agents put two different media types in play, and confusing them is the
single easiest way to misread this example.

| Media type | What it carries | Status |
|---|---|---|
| `application/vnd.gokite.agreement-command+json;version=1` | The interactions §6.2 defines — `proposal`, `acceptance`, `command`, `status`, and the §6.2.1 party-scoped kinds — addressed to a **Coordination Runtime** | **Normative.** Declared on the seller's Agent Card as the §2.1 `commandMediaType` param and transmitted by the seller in live mode |
| `application/vnd.gokite.example-negotiation+json;version=1` | The demo's own peer protocol: `request-terms`/`terms`, `submit-proposal`/`proposal-ack`, `acceptance-request`/`acceptance-result`, `request-delivery`/`delivery`, `error` | **Demo-private.** Not part of the Extension, not defined anywhere in the spec, and an implementer should expect to replace it wholesale |

The split matters because buyer and seller negotiate with **each other**, and
none of those peer messages is an interaction the Extension defines. Stamping
them with the Extension's media type would advertise a private arrangement as
protocol. In standalone mode the workflow objects carried by that negotiation
are built, signed, and verified locally. In live mode the seller keeps the same
private peer surface and separately addresses the Runtime with the normative
media type for `status`, `acceptance`, `funding`, `funding-signatures`,
`evidence`, and `command`.

What is normative in both modes is the `DealContract`, its two signatures, the
`AgreementCommand`s, the §6.2.1 party envelopes, and every §4.4 settlement
signature. Those are built to the published schemas and replayed against the
published vectors. Validating every published object against JSON Schema is
`conformance/run.py`'s job; the agents additionally check the hashes and
signatures they consume.

Each buyer/seller negotiation pair opts in to the Extension both ways on every
negotiation or contract-message request (the `A2A-Extensions` header and the
message's `extensions` array, §2.2), and each seller refuses such a request
when either declaration is missing. They are negotiating an agreement to be
executed under the Extension, so declaring it follows §2.2 and keeps the
handshake a Runtime performs under test.

Signing addresses are exchanged in the demo's own `request-terms`/`terms`
pair rather than inside any workflow object, since the §6.2 `proposal` branch
is `additionalProperties: false` and carries the contract alone. A real
deployment drops that exchange and resolves both addresses from their DIDs
through Kite Identity (§8).

## Running locally

The local pair runs in standalone mode by default. A Runtime card can be
configured so the buyer pins real discovery data into the contract, but the
bundled buyer still does not submit Runtime interactions:

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

The buyer walks the whole buyer-side sequence: negotiate (plain A2A) →
propose (first signature over `termsHash`) → acceptance (seller's second
signature over the identical hash) → funding envelope → delivery (verify the
seller's signed `delivered` command and its evidence commitment) → decide.
Every signature and hash is computed and verified for real against the
published schemas.

**Mode boundaries.** The bundled buyer is deliberately construction-focused:
its funding and decision objects are printed and locally verified rather than
submitted, and it does not read the proof chain. The seller's standalone mode
uses documented deal, evidence, and settlement-anchor stand-ins and is subject
to the same boundary.

The seller's live mode removes those stand-ins on the seller side. It verifies
the Runtime card and proposal, submits acceptance and funding artifacts,
registers evidence, and delivers autonomously after the Runtime's work-start
notification. A deployed seller has completed that accepted path against an
external buyer participant and a live Runtime; see
[`../conformance/live-validation.md`](../conformance/live-validation.md).
This is real interoperability evidence, not a substitute for the unexecuted
branches in `conformance/transitions.json`.

Demo-only peer shortcuts, such as in-band public-key exchange instead of
Identity DID resolution, are marked in the code where they occur.
