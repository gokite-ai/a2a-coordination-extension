# Example data seller agent

An A2A **server** that participates in the Kite Coordination Extension with a
**real deliverable**: synthetic individual-level records over the public CDC
PLACES 2025 census-tract release. Where [`../seller-agent/`](../seller-agent/)
demonstrates the protocol with a deliberately trivial product at a fixed
quote, this example demonstrates that the same Extension carries a non-trivial
one:

- **query-derived pricing** from a published rate card — and a countersign
  check that recomputes it: the seller signs a variable amount only when its
  own arithmetic reproduces it;
- a **free pre-purchase sample** with a committed statistics hash
  (`statsHash`), re-checked at delivery against slice substitution;
- an **out-of-band CSV deliverable** whose delivery manifest is the
  registered evidence artifact — its content hash IS §4.2's `deliveryHash`;
- a delivery the buyer **regenerates byte-for-byte** from the manifest's
  published seed, through a verifier whose digest the signed terms pin.

Written in TypeScript on the official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk)
**1.x** — deliberately a second implementation language, because that is
itself evidence the Extension is implementable from the spec and this
bundle's schemas and vectors alone. **No Kite SDK.** Like the other examples,
it is documentation, not a product.

Design and plan: [`DESIGN.md`](DESIGN.md), [`PLAN.md`](PLAN.md). Deterministic
product outputs are pinned by public golden fixtures
(`fixtures/golden/`, `test/golden.test.ts`).

## The terms document

`DealContract` v1's `deliverable`/`acceptanceCriteria` are strings, and §4.1's
`termsHash` covers the contract object alone — so this example's structured
terms (query criteria hash, `statsHash`, rows per tract, usage terms, the
verifier and corpus pins, the price breakdown) live in a **terms document**
whose JCS digest is embedded verbatim inside `acceptanceCriteria`, served
content-addressed at `/terms/<hash>`:

```
signatures → termsHash → contract → acceptanceCriteria → termsDocumentHash → terms document
```

Tampering any field of the document changes the contract and voids the
signatures; `test/terms-tamper.test.ts` pins that per field. The document
format is **demo-private** — a convention pinned by hashes, not new protocol —
and the contract's reserved `verifier`/`disclosurePolicy`/`evidenceSchema`
members are not used (spec §9.2 reserves them).

## Two media types (plus one)

Same split as the other examples, and misreading it is the easiest mistake:

| Media type | Status |
|---|---|
| `application/vnd.gokite.agreement-command+json;version=1` | **Normative** (§6.2 interactions, addressed to a Runtime). Declared as the card's `commandMediaType`; live mode stamps it on the Runtime leg |
| `application/vnd.gokite.example-data-negotiation+json;version=1` | **Demo-private**: buyer-scoped `query`/`quote`, `submit-proposal`, `acceptance-request`, `request-delivery`, `error`. Replace wholesale in a real deployment |
| `application/vnd.gokite.contract-message+json;version=1` | §6.5 Runtime → party notifications (`kite.contract.fulfill_started`) |

## Run

```bash
npm install
npx tsx src/server.ts                     # terminal 1 — the seller
npx tsx scripts/buyer.ts                  # terminal 2 — the buyer driver
```

The driver walks query → quote → contract → propose → countersign →
delivery → verify, checking every hash and signature, and finishes with the
buyer's whole defence: byte-for-byte regeneration from the published seed
through the digest-checked verifier.

| Env | Default | Meaning |
|---|---|---|
| `SELLER_HOST` / `SELLER_PORT` | `0.0.0.0` / `9998` | Bind address |
| `SELLER_PUBLIC_URL` | `http://localhost:9998` | URL advertised on the card and in evidence locators |
| `SELLER_AGENT_ID` | `did:kite:corp-kite:example-data-seller-agent` | Kite Identity DID |
| `SELLER_PAYOUT_ADDRESS` | `0x3333…` | Goes into the SIGNED terms (`escrow.payoutAddress`) |
| `CORPUS_PATH` | bundled CA+NY fixture | The corpus (`.csv` or `.csv.gz`); boot refuses a card the data contradicts |
| `KITE_COORDINATION_ENDPOINT` | `https://passport.dev.gokite.ai/a2a/v1` | The Runtime pinned into signed terms |
| `KITE_COORDINATION_MODE` | `standalone` | `live` drives deals through the Runtime |
| `SELLER_RUNTIME_PRIVATE_KEY{,_FILE}` | *(unset)* | Durable secp256k1 key — required for live mode |
| `KITE_IDENTITY_BASE_URL` | *(unset — binding disabled)* | Kite Identity base URL (e.g. `https://passport.dev.gokite.ai`); set it and the agent binds its key to its DID at boot |
| `SELLER_RUNTIME_BIND_RETRY_SECONDS` | `300` | Poll interval while awaiting the owner's approval |
| `SELLER_RUNTIME_BIND_REGISTER` | `auto` | `off` polls without filing the bind request (see the redeploy caveat below) |
| `SELLER_RUNTIME_ENV` | `example` | Advisory label recorded on the binding |

Surfaces: `/.well-known/agent-card.json`, `/a2a/v1` (JSON-RPC), `/terms/:hash`
(content-addressed), `/deliveries/:dealId/:file` (capability-gated; wrong or
missing token is a 404 that reveals nothing), `/admin` (process-local,
buyer-organized negotiation and agreement inventory, intentionally
unauthenticated), `/`.

## Negotiation identity and admin

Negotiation exists before an agreement. A demo-private `query` therefore
carries a self-declared `buyerAgentId`, and its `quote` returns a unique
`negotiationId`. A later standalone `submit-proposal` or live
`acceptance-request` must return that id. The seller requires the selected
quote, the pinned terms-document hash, and the proposed contract's
`buyerAgentId` to agree before it creates a deal. The contract signature is
what authenticates the buyer after the seller validates and countersigns the
agreement; the earlier query field only organizes the pre-agreement exchange
and is labelled accordingly in the UI.

`/admin` lists buyers rather than deals. Each `/admin/buyers/:buyerAgentId`
page shows accepted and refused query/quote timelines even when no agreement
exists, followed by any agreements that selected those negotiations. The
agreement detail remains at `/admin/agreements/:dealId`.

## Mode boundaries

**Standalone** (default): negotiation, the query-derived countersign, and
delivery run for real — real signatures, real CSV, real manifest — but the
delivered command's settlement anchors (vault dealId, receiptHash, nonce) are
DOCUMENTED PLACEHOLDERS. Nothing produced in this mode can be submitted to a
Runtime.

**Live** (`KITE_COORDINATION_MODE=live`): the deal runs through the Runtime
over the §6.2 interactions — countersign against a `status` read under the
VERIFIED Runtime card's chain context, funding co-signed over the read-back
Activation (base units never converted twice), evidence registered for a
Runtime-issued `evidenceId`, and delivery signed over anchors read back fresh
with the seller's own clock as `expiry`. A §6.5 `fulfill_started`
notification is verified by read-back, acknowledged once, and answered by an
autonomous background delivery with retries bounded by the notification's
deadline; anything unverifiable gets a JSON-RPC **error** (a polite reply
would kill the relay's retry loop — the SDK turns executor throws into
well-formed failed Tasks, so a narrow express adapter answers notifications
before the SDK sees them). Live mode fails closed on the key: no durable key,
no start.

**Runtime binding (§8)** — the same flow as `seller-agent/`: at boot the
agent files a tokenless bind request for its key against its own DID and
polls until an owner approves (`POST /v1/agents/{agent}/runtimes/{runtime}:approve`
— the bind lands pending and CANNOT self-approve). The approval is read back
through the public lookup-by-key 404→200 flip. The server always comes up and
reports the state on `GET /`; live SIGNING refuses until the binding is
active, because Passport refuses signatures from unbound keys whoever relays
them — and the poll KEEPS running after activation, so a later revocation
closes the gate without a restart. One known limit: the register-once guard
is process-local and Identity files a new pending row per request, so an
agent redeployed before the owner approves files one more (same-key,
same-agent) pending request per boot; approve any one of them —
`SELLER_RUNTIME_BIND_REGISTER=off` is the poll-only lever until Identity
dedups server-side. Escrow **funding** stays an external Passport MCP step:
the buyer driver constructs funding artifacts but never executes `fund`.

**Dispute paths**: under `fixed_outcome/v1` a rejection is answerable —
`REJECTED → refund_consented → CANCELLED` or `REJECTED → appealed → DISPUTED →
arbiter_decided` — and the artifact capability is revoked on refund outcomes,
held on seller-favour ones. These paths are exercised against the
cryptographically verifying fake Runtime in `test/live-coordination.test.ts`;
live validation covers the accepted path only, and every claim about them
says exactly that.

## Tests

`npm run verify` — `tsc --noEmit` plus the suite: replay of the published
vector sets (including all eight §4.4 settlement structs), the per-field
terms-document tamper matrix, deterministic engine golden fixtures, the
standalone transport round trip, and the fake-Runtime live suite including all
three dispute outcomes. Offline; the corpus fixture is bundled.
