# Data seller agent — design

An example seller agent for the Kite Coordination Extension whose product is a
synthetic individual-level dataset over the public CDC PLACES 2025
census-tract release. The data engine, pricing model, disclosure rules,
identity, agreement lifecycle, and settlement bindings are defined entirely
within this public example and the published Extension bundle.

Like the other examples, it is **documentation, not a product**, and it uses
**no Kite SDK**: an official A2A SDK plus this bundle's schemas and vectors is
the entire dependency surface. Unlike the other examples it is written in
TypeScript, which is deliberate — a second implementation language is itself
evidence that the Extension is implementable from the spec alone.

## 1. What it sells

Two products over the CDC PLACES 2025 release (free, public data):

- **Free, before purchase** — an unmodified real aggregate sample plus
  whole-slice statistics with a committed `statsHash`, priced at nothing.
- **Licensed, after settlement** — a synthetic individual-level CSV, one row
  per person, at a guaranteed number of rows per purchased tract. No real
  person's record is in it. Deterministic: seeded per deal, regenerable by
  the buyer from the published seed alone.

Eight health measures, tiered standard/premium, priced per query from a
published rate card (`query-derived/v1`). The card publishes named rejection
codes so a refused query is diagnosable.

## 2. Ownership and boundaries

| Concern | This example owns | This example does not own |
|---|---|---|
| Runtime shape | A self-contained A2A server with its own key, process-local state, transport, and operator pages | Coordination Runtime state or lifecycle execution |
| Lifecycle | Construction and submission of `fixed_outcome/v1` interactions | A seller-defined state machine |
| Negotiation | A demo-private query/quote protocol and published rate card | A new normative Extension surface |
| Identity | Runtime-key registration, status polling, and signing gates | Owner approval or user-session creation |
| Settlement | The §4.4 EIP-712 payloads and signatures a seller must produce | Escrow funding, transaction submission, or chain observation |
| Delivery | Deterministic CSV generation, manifest hashing, evidence registration, and capability-gated artifact serving | Long-term archival storage |
| Operator surface | `GET /`, `GET /admin`, and buyer-organized negotiation/agreement history | Product-grade authentication or durable administration |

The implementation depends only on the public npm dependencies declared in
`package.json` and this Extension bundle. It uses no Kite SDK.

## 3. Architecture

```
data-seller-agent/
  card.json.ts           the Agent Card: skills, extension declaration, disclosure params
  src/
    server.ts            A2A JSON-RPC server; §2.2 opt-in enforcement
    negotiation.ts       demo-private query/quote/sample/proposal peer protocol
    coordination.ts      live-mode Runtime client: status, acceptance, funding,
                         evidence, command (§6.2), notifications (§6.5)
    settlement.ts        §4.4 EIP-712: both domains, all eight structs (verified
                         against the full vector set; the seller *signs* only its own subset)
    signing.ts           secp256k1-keccak-v1 primitives (mirror of the Python examples')
    terms.ts             the terms document, its canonical form, and termsDocumentHash
    product.ts           quote and deliverable composition (see §7)
    engine/
      places.ts          corpus loader, query validation, pricing, sampling
      synth.ts           seeded synthetic-individual generator
      deliver.ts         delivery manifest builder + content hashing
      store.ts           local artifact-store interface and implementations
    verifier.ts          functions a buyer loads to re-derive a delivery
  fixtures/
    places-ca-ny.csv.gz  committed CA+NY corpus (324 KB)
  test/
    …                    engine goldens, vector replay, fake-Runtime live loop
```

Two execution modes, mirroring `seller-agent/`:

- **Standalone**: negotiation, countersigning, and delivery run against the
  buyer peer with real signatures and documented placeholder anchors. Nothing
  produced is submittable to a Runtime.
- **Live** (`KITE_COORDINATION_MODE=live`): the deal runs through the Runtime
  over the §6.2 interactions — verify Runtime card against the pinned
  `agentCardHash`, countersign, submit `acceptance`, co-sign funding over the
  read-back Activation, register evidence, deliver autonomously on the §6.5
  `fulfill_started` notification, retry within `delivery_deadline`. Fails
  closed without an **active** runtime binding, exactly as `seller-agent/`
  does.

### Surface boundary: what this example does NOT do

The agent-side surface split is decided elsewhere and this example respects
it: **runtime-key registration and status polling use Identity's public HTTP
surface; owner approval, session creation, and escrow funding remain external;
the §6.2 workflow interactions go through Passport A2A; human-facing setup and
inspection are CLI/web.** Consequences:

- Runtime binding follows `seller-agent/`'s §8 flow: at boot the
  agent files a tokenless bind request for its durable key against its own
  DID and polls the public lookup-by-key until the OWNER approves — the bind
  lands pending unconditionally and cannot self-approve. The server always
  comes up; live SIGNING is gated until the binding is active, because
  Passport refuses signatures from unbound keys whoever relays them.
- The buyer driver (§8) does not fund escrow. It constructs and exchanges
  every A2A-side artifact — contract, signatures, funding submission with
  `buyerWallet` and `expectedDealId` — but the escrow `fund` itself is an
  external Passport MCP step performed by the buyer's owner. The driver
  therefore does **not** claim a self-contained live funded flow; the
  documented live run has two marked hand-off points (seller binding approval,
  buyer funding).

The Python seller's hard-won live-mode behaviours are requirements here, not
options: read-back-don't-trust on notifications, JSON-RPC error (not a polite
message) for unverifiable notifications, one-shot acknowledgement with
self-driven delivery retries, seller-clock `expiry`, no double base-unit
conversion of the read-back `amount`.

### Negotiation surface

A demo-private media type, sibling to the existing
`example-negotiation+json`:

```
application/vnd.gokite.example-data-negotiation+json;version=1
```

Kinds: `query` → `quote` (itemised price, tract count, deliverable-shape
block, free sample rows, `statsHash`) → `submit-proposal` → `proposal-ack` →
`acceptance-request` → `acceptance-result`, plus `error` carrying the
engine's named rejection codes. None of these is a §6.2 interaction and none
carries the Extension's media type — same split, same reasons, as the
existing examples' README documents.

## 4. Terms and the DealContract

`DealContract` v1 is `additionalProperties: false`; `deliverable` and
`acceptanceCriteria` are strings; and §4.1's `termsHash` covers **the
contract object and nothing else** — an external document is outside every
signature unless the contract's own text commits to it. The structured terms
therefore live in a **terms document** whose digest is
embedded *inside* the contract:

```
termsDocumentHash = "sha256:" || hex( sha256( rfc8785( terms document ) ) )
```

`DealContract.acceptanceCriteria` carries, verbatim, the
`termsDocumentHash` and an immutable locator for the document (the seller
serves it content-addressed, `/terms/<hash>`). `deliverable` stays a prose
summary. `termsHash` itself is computed **exactly as §4.1 defines it, over
the contract alone** — this design adds a second, inner commitment rather
than redefining the spec's. The chain of custody is: signatures → `termsHash`
→ contract → `acceptanceCriteria` → `termsDocumentHash` → terms document.
Changing any field of the terms document changes `termsDocumentHash`, which
changes the contract, which is a **new proposal** under §4.1. A per-field
tamper test (PLAN phase 0) pins this property.

The contract's optional `verifier`, `disclosurePolicy`, and `evidenceSchema`
members are **not used**: v1 reserves their semantics (§9.2), so nothing here
may rely on them.

The terms document's content:

```
criteriaHash        canonical hash of the buyer's query (port of criteriaHashOf)
statsHash           the pre-purchase statistics commitment
rowsPerTract, totalRows, tractCount, perTractStandardErrorPp
seed disclosure     "seed published in the delivery manifest"
method              "stratified-marginal-bernoulli/v2"
generatorVersion    exact version of the synthesis implementation
corpusHash          sha256 of the corpus file the slice was evaluated against
verifierHash        sha256 of the verifier bundle a buyer may load (§5, §8)
usage terms         resale=false, retentionDays=365 (the buyer's retention
                    right — a usage term, not an artifact-availability
                    promise), prohibitedUse, limitations[]
artifactAvailability how long the seller serves the delivered artifact (§5)
priceBreakdownCents  the rate-card computation, itemised
```

The countersigning check is: recompute the query's price with the seller's
own `priceQuery()`, recompute `criteriaHash`, `statsHash`, and
`termsDocumentHash`, and compare against what the proposal's contract pins.
**The seller countersigns a variable amount only when its own arithmetic
reproduces it.** Query-derived pricing is therefore part of the signed
agreement rather than a local configuration assumption.

Dataset provenance, the rate card, deliverable limitations, and
`disclosedRisk` live in the seller card's extension `params` — allowed (the
params schema constrains Runtime cards, not participant cards) and
non-normative, exactly as informative card content should be. The vault has a
REJECTED → DISPUTED → arbiter path. This example exercises the dispute paths
against a fake Runtime (PLAN phase 3) but validates only the accepted path live
— the disclosure says exactly that, claiming protocol support, not live-proven
coverage.

## 5. Delivery and evidence

The Extension's evidence model (`hash` + `url`, hash authoritative) is
already an out-of-band model, so the multi-megabyte CSV needs no in-band
channel:

1. The engine generates the CSV and its **delivery manifest** (seed, query,
   `criteriaHash`, `statsHash`, row counts, per-file sha256, and the CSV's
   URL on the seller's own HTTP surface).
2. The seller registers the **manifest** as the evidence artifact:
   `hash = sha256(manifest bytes)`, `url = <manifest URL>`,
   `sections = [csv]`, `sizeBytes`, `format`.
3. `kite.contract.delivered` carries the Runtime-issued `evidenceId` and
   `deliveryHash = sha256(manifest)` — the value `sellerDeliverySig` commits
   to inside the §4.4 `Delivery` struct and the vault's `markDelivered`
   receives.
4. The buyer fetches the manifest by URL, checks it against `deliveryHash`,
   fetches the CSV, checks it against the manifest's embedded hash, and —
   the core defence — **regenerates the file from the published seed** and
   compares bytes.

### Access control

A paid artifact behind an open URL is a delivery to everyone, so this example
uses a demo-grade capability model:

- At delivery the seller mints a **per-deal bearer token**; the manifest and
  CSV URLs registered as evidence carry it
  (`/deliveries/{dealId}/…?cap=<token>`). Requests without the deal's token
  get 404.
- The Runtime's evidence intake and the buyer use the same URL. The token is a
  replayable bearer credential, not an audience restriction: any party that
  obtains the complete URL can fetch the artifact while the token remains
  valid.
- Query credentials can leak through evidence payloads, logs, browser history,
  referrer data, screenshots, or copied URLs. The complete URL must therefore
  be treated as secret. This demo is suitable only over loopback or TLS and
  only where `cap` is redacted from logs, diagnostics, and user-visible
  history.
- A production live delivery must not place a long-lived bearer credential in
  the evidence URL. It should register a non-secret locator and issue separate
  short-lived grants to the Runtime and buyer through a protected exchange or
  an `Authorization` header.
- The seller watches agreement state (`status`): on a refund outcome
  (CANCELLED, or RESOLVED with `sellerBps=0`) the token is **revoked**;
  on ACCEPTED/RESOLVED-for-seller it stays valid for the
  `artifactAvailability` window the terms document declares.
- Tokens and artifacts are process-local and non-durable, and
  `artifactAvailability` in the terms document says so honestly (a bounded
  demo window, not an archival promise). This is disclosed the same way the
  Python seller discloses its in-memory admin state.

Two moments are distinct and the terms document names both: **access for
acceptance** (delivery → the buyer's accept/reject window, where the buyer
inspects and verifies) and **the license** (effective at settlement in the
seller's favour). `retentionDays=365` is part of the license — how long the
buyer may retain and use the data — and implies nothing about how long the
seller keeps serving bytes.

`verifier.ts` exports three functions (regenerate, manifest-check,
stats-check), reusing the engine implementations rather than duplicating
them, and is loadable by a buyer at run time. Delivery anchoring follows the
spec directly (§4.2/§4.4): `deliveryHash` is the registered manifest's content
hash.

The verifier is itself **anchored before signing**, not fetched on trust:
the terms document pins `verifierHash` (sha256 of the verifier bundle),
`generatorVersion`, and `corpusHash` (§4), so the code the buyer will judge
the delivery with is fixed at contract time. The buyer driver loads the
verifier from a local path or an immutable copy, checks its digest against
the pinned `verifierHash`, and refuses to execute it on mismatch — it never
runs code freshly downloaded from the counterparty's URL unverified.

## 6. Identity, keys, settlement

- One secp256k1 runtime key. `SELLER_RUNTIME_PRIVATE_KEY{,_FILE}`, ephemeral
  fallback in standalone, fail-closed in live. The key is BOUND to the DID by
  the agent itself at boot (`binding.ts`: register once, poll `agents:lookup`
  by key for the owner-approval 404→200 flip); signing waits for the
  approval, and a lookup answer that does not name exactly this DID is an
  error state, never an approval.
- Every §4.4 object is signed with the bound secp256k1 runtime key; this
  example has no Ed25519 signing path or separate activation key.
- EIP-712 domains and parameters come from the Runtime card (`chainId`,
  `escrowVault`), pinned via `agentCardHash` in the signed terms — never from
  local configuration. The eight struct type strings are copied verbatim from
  §4.4; the `settlement` vector set is the arbiter of every derivation.

## 7. Engine and product logic

The engine and product modules are deterministic and self-contained:

- `places.ts` loads the corpus, validates queries, computes tract inclusion,
  prices the selected slice, and produces the free sample.
- `synth.ts` generates individual rows from the disclosed seed and query.
- `deliver.ts` serializes the byte-stable CSV and its manifest, then anchors
  the registered evidence with the spec's content-hash rule.
- `product.ts` composes pricing, sample statistics, `statsHash`, disclosure,
  and the boot-time card/corpus consistency check.
- `store.ts` defines the local artifact interface; the example provides
  memory and filesystem implementations and serves the bytes itself.

Public golden fixtures pin rejection codes, tract counts, price breakdowns,
sample rows, `statsHash`, CSV bytes, and manifest business fields. These tests
define the example's compatibility surface without depending on another
repository or implementation. Byte stability is the buyer's core defence:
the same public corpus, query, and seed must always produce identical bytes.

## 8. Buyer side

The bundled Python buyer is construction-focused and knows nothing about
queries or datasets. This example ships its own buyer driver (a script, not a
fourth agent): query → quote → build terms + contract → propose →
*(external: owner funds escrow via Passport MCP — §3 surface boundary)* →
receive → verify (manifest against `deliveryHash`, CSV against the manifest,
regeneration via a **digest-checked** `verifier.ts`, §5) → accept. The driver
constructs and exchanges every A2A-side funding artifact but never executes
`fund` itself. Whether any of it folds back into `buyer-agent/` is a later,
separate decision — the existing buyer stays untouched.

## 9. Non-goals

- Not a product; deal state is in-memory and artifacts are process-local
  (same boundary as `seller-agent/`). The terms document's
  `artifactAvailability` is scoped to match (§5) — the example never signs an
  availability promise its storage cannot keep. `retentionDays` is a buyer
  usage right and is unaffected.
- No Kite SDK, no platform-host import, no import of any buyer.
- No new normative surface: the negotiation media type is demo-private, the
  terms document is a private convention pinned by `termsHash`, and nothing
  here amends the spec.
- The proof-chain read (§6.3.1) stays out of scope on the seller side, same
  boundary as `seller-agent/`.

## 10. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| 1 | A2A server library | **DECIDED (phase 0 spike): `@a2a-js/sdk` 1.0.1, no adapter.** `test/sdk-spike.test.ts` pins the four required capabilities over a real HTTP round trip: raw Parts with media types, the `A2A-Extensions` header both directions (`requestedExtensions` / `addActivatedExtension`), Message-level `extensions` arrays, and the JSON-RPC binding (`jsonRpcHandler` + `JsonRpcTransportFactory`). One wire fact: a `raw` part's `value` deserializes as `Uint8Array`, decode via `Buffer.from()` | Resolved |
| 2 | Corpus fixture | Ship the 324 KB CA+NY gz in-repo vs. download-on-first-run | In-repo: examples must run offline |
| 3 | Where the CSV is served from | Seller's own HTTP surface vs. external store | Own surface: self-containment beats realism here |
| 4 | Admin view | Port `seller-agent/`'s `/admin` | Yes, later phase; it is cheap and consistent |
