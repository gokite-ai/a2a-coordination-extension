# Data seller agent — implementation plan

Companion to [`DESIGN.md`](DESIGN.md). Phases are ordered so that every phase
ends with something runnable and testable; no phase depends on a later one's
decisions.

## Phase 0 — foundations: transport, vectors, and the contract model

**Goal:** settle every assumption the rest of the plan leans on — not just
the SDK. Four tracks, each with its own exit test.

1. **A2A server library.** Stand up a hello-world A2A server in TypeScript
   with `@a2a-js/sdk` and check the exact surface this spec needs: `raw`
   Parts carrying a media type, the `A2A-Extensions` header both directions,
   message `extensions` arrays, the JSON-RPC binding. For any missing
   capability, prefer a narrow adapter over the SDK; hand-rolling the whole
   transport would forfeit the "official SDK suffices" claim (DESIGN §10.1).
2. **Vector harness.** A TypeScript test that replays the published vector
   sets — `canonical`, `signing`, `commands`, `errors`, `funding`,
   `receipts`, and all eight `settlement` structs — against fresh local
   implementations of RFC 8785 canonicalization, `secp256k1-keccak-v1`, and
   the §4.4 EIP-712 construction. This becomes `signing.ts`/`settlement.ts`
   (which verifies all eight structs; the seller signs only its subset).
3. **Terms commitment tamper matrix.** Implement the DESIGN §4 chain
   (contract-embedded `termsDocumentHash`, spec-exact `termsHash`) and a
   test that mutates **every field of the terms document, one at a time**,
   asserting each mutation yields a different `termsDocumentHash`, hence a
   different contract, hence a different `termsHash` — and that verification
   against the original signatures fails. No reliance on the reserved
   `verifier`/`disclosurePolicy`/`evidenceSchema` members anywhere.
4. **Boundary and distribution decisions, recorded.** Write down (in DESIGN)
   the MCP/A2A surface split consequences (runtime-key registration and polling
   are agent-owned; owner approval and funding are external prerequisites), the
   artifact access model (per-deal capability token,
   refund revocation), and the verifier distribution model (`verifierHash` +
   `corpusHash` + `generatorVersion` pinned in the terms document). These
   shape phases 2–4 and must not be discovered mid-implementation.

**Exit criteria:** every published vector passes; the tamper matrix is green;
transport decision recorded in DESIGN §10; DESIGN §3–§5 boundary text final.

## Phase 1 — engine and product logic

**Goal:** the deterministic engine and product logic compile and pass with no
platform or private-package dependency.

- Implement `engine/{places,synth,deliver}.ts`, `product.ts`, `terms.ts`, and
  `verifier.ts` as self-contained modules with local hashing and artifact
  storage interfaces.
- Pin query validation, pricing, sampling, synthesis, CSV serialization, and
  manifest hashing with the bundled CA+NY corpus.
- Cover the boot-time card/corpus consistency check, empty-result refusal,
  per-tract disclosure, byte stability, and regenerate-from-seed guarantees.
- Maintain public golden fixtures for a matrix of corpus/query/seed inputs:
  rejection codes, tract counts, price breakdowns, sample rows, `statsHash`,
  CSV bytes, and manifest business fields must remain stable.

**Exit criteria:** `npm test` green offline; the public golden-fixture matrix green;
a scripted end-to-end generate→manifest→verify round trip over the fixture
corpus; byte-stability test passes twice in a row on the same seed.

## Phase 2 — standalone seller

**Goal:** feature parity with `seller-agent/`'s standalone mode, over the
real engine.

- Agent Card: extension declared `required: false`, `commandMediaType`
  param, dataset/rate-card/limitations disclosure params, the four skills
  (quote, negotiate, license, verify).
- §2.2 opt-in enforcement (header **and** `extensions` array, refuse
  otherwise).
- The demo-private `example-data-negotiation` peer protocol: `query` →
  `quote` (itemised price, shape block, free sample, `statsHash`) →
  `submit-proposal` → countersign → delivery, with the engine's named
  rejection codes on the `error` kind.
- The terms document, contract-embedded `termsDocumentHash`, and spec-exact
  `termsHash` (DESIGN §4); countersigning recomputes price, `criteriaHash`,
  `statsHash`, and `termsDocumentHash` before signing — refuse any proposal
  the arithmetic does not reproduce.
- Delivery: real CSV + manifest behind a per-deal capability token
  (DESIGN §5), really-signed `evidence` party envelope and
  `kite.contract.delivered` command, documented placeholder dealId /
  evidenceId / anchors — the same standalone boundary the Python seller
  documents.

**Exit criteria:** transport round-trip test (in-process buyer driver walks
query→…→delivery, verifying every signature and hash); all emitted workflow
objects validate under `conformance/run.py`.

## Phase 3 — live mode

**Goal:** feature parity with `seller-agent/`'s live mode, inside the decided
surface boundary (DESIGN §3): the agent registers and polls its runtime key;
the owner approval and escrow-funding steps remain external.

- Runtime binding at startup: register the durable key once against the agent
  DID, poll the public lookup-by-key surface until the owner approves it,
  render the state on the home page, and refuse live signing without an active
  binding. Continue polling after activation so revocation closes the gate;
  support a poll-only mode to avoid another registration after redeploy.
- The §6.2 client: `status`, `acceptance`, `funding` read-back and co-sign,
  `evidence` registration (manifest as artifact, hash + capability URL),
  `command` submission with anchors read back fresh (vault dealId,
  `latestProofHash`, nonce).
- §6.5 `fulfill_started`: verify by read-back, acknowledge once, deliver as
  a background task with retries bounded by `delivery_deadline`; JSON-RPC
  error for anything unverifiable; seller-clock `expiry`.
- Fail-closed rules: no live start without a durable key; no signing until
  the binding is active; no double base-unit conversion.
- Outcome watching: on refund outcomes revoke the artifact capability token;
  on seller-favour outcomes hold it for the declared availability window
  (DESIGN §5).

**Exit criteria:** a fake-Runtime test in the mold of
`test_live_coordination.py` — it cryptographically verifies every artifact it
accepts and derives its digests independently of this example's helpers —
drives the loops green: the accepted path **and the dispute paths** the
design claims (`rejected → refund_consented → buyer refunded`;
`rejected → appealed → arbiter_decided`, both split outcomes), asserting for
each terminal state both the settlement direction and whether the capability
token survives.

## Phase 4 — buyer driver and verification

**Goal:** enforce the buyer's complete delivery-verification path.

- A buyer driver script: query → quote → terms + contract construction →
  propose → *(external: escrow funded via Passport MCP by the buyer's
  owner — the driver constructs and exchanges the A2A funding artifacts but
  never executes `fund`)* → receive → verify → accept.
- Verification = manifest against `deliveryHash`, CSV against the manifest's
  hash, and byte-for-byte regeneration from the published seed via a
  runtime-loaded `verifier.ts` (`SELLER_VERIFIER`-style, not an import) —
  loaded only after its digest matches the `verifierHash` the terms document
  pinned, alongside `corpusHash` and `generatorVersion` (DESIGN §5).

**Exit criteria:** the driver completes against the standalone seller with
every check enforced — a mutated byte anywhere (deliverable, manifest, or
verifier bundle) fails the run.

## Phase 5 — conformance, live validation, docs

- Full `conformance/run.py` pass over every object the example emits.
- One accepted path against the deployed dev Runtime and a funded buyer,
  extending `conformance/live-validation.md` with this seller's coverage —
  same evidentiary standard as the existing seller's entry. **Live coverage
  is the accepted path only**; the dispute paths are validated against the
  phase-3 fake Runtime, and every claim about them (README, card
  `disclosedRisk`) says exactly that.
- Final `README.md` for the example (mode boundaries, env table, run
  instructions), replacing the design-phase stub; a "what differs from
  seller-agent/ and why" section; update `examples/README.md` to introduce
  the third example and its media type.
- Port the `/admin` view (DESIGN §10.4), organized by buyer so pre-agreement
  query/quote exchanges and later agreements share one operator timeline.

**Exit criteria:** live-validation entry recorded; examples README table
lists three agents; CI covers the new tests.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Terms document escapes the signature chain | Counterparty swaps criteria/price basis after signing | Contract-embedded `termsDocumentHash` (DESIGN §4); phase-0 per-field tamper matrix is the gate for all later phases |
| `@a2a-js/sdk` lacks part of the A2A 1.0 surface | Blocks phase 2 transport | Phase 0 spike; narrow adapter over the SDK for gaps, never a wholesale replacement |
| Engine changes bytes (line endings, float formatting, gzip) | Breaks the regeneration defence | Phase 1 pins byte stability with fixture hashes and public golden outputs before protocol integration |
| Surface boundary drifts (example quietly grows MCP-shaped code) | Example contradicts the decided MCP/A2A split | DESIGN §3 boundary section; key registration and polling stay on the public Identity surface, while owner approval and funding remain explicit external steps |
| Terms-document convention drifts into looking normative | Readers mistake demo convention for spec | Same treatment as `example-negotiation+json`: explicit "demo-private" labelling in README and code |
| Variable-amount countersigning masks a pricing bug | Seller signs a wrong amount for real spend in live mode | Countersign path recomputes from the card's own rate card and refuses on any mismatch; worked-example test pinned to the card's published numbers |
| Example grows past "documentation" size | Examples stop being readable | Engine stays in `engine/` with its own tests; protocol files mirror the Python seller's file-per-concern layout |

## Explicitly deferred

- Folding query/quote awareness into the Python `buyer-agent/`.
- Embedding a Passport MCP client (session / fund) into either agent, or
  automating the owner's binding approval — those stay external prerequisites
  per the decided surface split.
- Live (deployed-Runtime) validation of the dispute paths.
- Any negotiation of terms dimensions beyond geography, measures, thresholds,
  and price.
- Proof-chain verification on the seller side (§6.3.1) — same boundary as
  `seller-agent/`.
