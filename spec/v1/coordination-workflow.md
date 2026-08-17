# A2A Kite Coordination Extension — Specification v1

**Status: RELEASE CANDIDATE — not yet `v1.0.0`.** The wire contract below is
settled and the schemas, vectors and examples are aligned to it. The complete
accepted outcome path has executed against a live Runtime, including the
deployed reference seller (§9.1). Full-matrix conformance is not claimed: the
conformance suite's 36 live cases have no live driver yet. That does not block
publication of the validated prototype, but it does block any claim of full
conformance. Identifiers and signed preimages are fixed; the bundle remains
unfrozen until the first `v1.0.0` release.

Extension URI: `https://a2a.gokite.ai/extensions/coordination-workflow/v1`
Command media type: `application/vnd.gokite.agreement-command+json;version=1`
Contract-message media type: `application/vnd.gokite.contract-message+json;version=1` (§6.5)
Signature profile: `secp256k1-keccak-v1`
First template: `fixed_outcome/v1`
Base A2A protocol: **1.0** (`protocolVersion: "1.0"`, `Major.Minor`)

This document is the normative wire contract. The design rationale lives in
the (internal) design record and is not required to implement the protocol:
everything an implementer needs is this spec, the schemas, and the test
vectors.

Requirement keywords (**MUST**, **MUST NOT**, **SHOULD**, **MAY**) are used as
in RFC 2119.

---

## 1. Roles

| Role | Asserts | Cannot assert |
|---|---|---|
| **Buyer agent** | Its own signatures: proposal or acceptance of a `termsHash`, funding, and the accept/reject decision on a delivery. | That delivery occurred, or that its own funding reached finality. |
| **Seller agent** | Its own signatures: acceptance of a `termsHash`, delivery submission, and the evidence commitment. | That its delivery satisfies the acceptance criteria — only the buyer, a verifier, or an arbiter concludes that. |
| **Coordination Engine** ("the Runtime") | Which transitions it accepted, in what order, at what revision — committed as a hash-chained, signed transition-proof record. | Whether a subjective delivery is good. It enforces the state machine; it does not judge. |
| **Settlement provider** | Authoritative payment facts: funding received, payout executed, refund executed. | Anything about agreement state. |
| **Audit** | That an accepted transition was durably appended to an append-only log, and the ordering of what it holds. It builds and manages the transition **receipts** (§4.3) from the Runtime's proof chain. | Any business fact. Audit registers signed claims; it does not produce them. |
| **Verifier / arbiter** | Only the decision or external fact it signs, within the authority the contract granted it. | Anything outside that grant; it never holds agreement state. |

Two consequences implementers depend on:

- A **unilateral statement is never mutual truth.** Bilateral facts require two
  signatures over the same bytes (§4.1).
- The Runtime is **on the execution path**, so audit production is a consequence
  of executing an agreement rather than a voluntary report by either party.

## 2. Extension negotiation

### 2.1 Agent Card declaration

A Runtime **MUST** declare the Extension in its Agent Card under
`capabilities.extensions`:

```json
{
  "capabilities": {
    "extensions": [{
      "uri": "https://a2a.gokite.ai/extensions/coordination-workflow/v1",
      "required": true,
      "params": {
        "commandMediaType": "application/vnd.gokite.agreement-command+json;version=1",
        "templates": ["fixed_outcome/v1"],
        "signatureProfiles": ["secp256k1-keccak-v1"],
        "chainId": 2368,
        "escrowVault": "0xecececececececececececececececececececec"
      }
    }]
  }
}
```

Schema: `schemas/v1/agent-card-extension-params.schema.json`
(`$id: https://a2a.gokite.ai/schemas/agent-card-extension-params/v1`).

`params` **MUST** enumerate the templates and signature profiles the Runtime
accepts, so a client can reject an unsupported pairing **before** any agreement
is formed rather than mid-workflow. A Runtime card's `params` **MUST** also
carry the settlement chain context — `chainId` and `escrowVault` — because
every §4.4 signature needs them and the first one (`agreementSig`) is due at
acceptance, before any funding context exists. Pinning `agentCardHash` into
the signed terms (§4.1) is what makes this trustworthy: the chain context a
party signed against cannot be swapped afterwards.

A participant agent's card **MAY** declare the same URI with
`required: false`, so it stays interoperable for unrelated A2A work.

### 2.2 Per-request opt-in

A client **MUST** opt in per request, both ways:

- the HTTP header `A2A-Extensions: <extension URI>`; and
- the URI in the A2A message's `extensions` array.

A Runtime **MUST** reject a request that does not declare the Extension. It
**MUST** echo the activated URI in the `A2A-Extensions` response header and in
the reply message's `extensions` array.

### 2.3 Negotiation is not agreement

Extension negotiation establishes only that both sides speak this contract. It
**MUST NOT** be treated as bilateral agreement to any terms. Agreement exists
only when both parties have signed the same `termsHash` and the Runtime has
verified both signatures (§4.1).

## 3. Workflow state machine

`fixed_outcome/v1`. This section — with the published schemas and vectors —
**is the normative definition of the workflow**. The Coordination Engine is an
implementation of it: where an implementation and this document diverge, the
implementation carries the defect. (The state machine and the message-type
vocabulary of §4.2 originated in the engine's code, but what is published here
is what implementers may rely on; a defect in this document is fixed by a new
release of this document, never by silently deferring to code an external
implementer cannot see.)

States are **UPPERCASE** on the wire. `PROPOSED` is entered by a proposal and
is the only state reachable without two signatures; it sits *outside* the
transition table below — the state machine proper begins at `COMMITTED`, once
the contract carries both signatures.

Edges are driven three ways, and the distinction is part of the contract:
**party commands** (a signed AgreementCommand whose `commandType` names the
edge), **runtime observations** (chain facts the Runtime watches for; no party
can command them), and **deadline expiries** (platform windows, §3.1).

```
PROPOSED   ──(acceptance: 2nd signature over the same termsHash)──▶ COMMITTED

COMMITTED  ──FUND_CONFIRMED        (runtime: chain observation)──▶ FULFILLING
           ──FUNDING_EXPIRED       (deadline)───────────────────▶ EXPIRED
FULFILLING ──kite.contract.delivered         (seller)───────────▶ DELIVERED
           ──DELIVERY_MISSED       (deadline)───────────────────▶ DEFAULTED
           ──kite.contract.refund_consented  (seller)───────────▶ CANCELLED
DELIVERED  ──kite.contract.accepted          (buyer, or
              auto-confirm at window expiry)────────────────────▶ ACCEPTED
           ──kite.contract.rejected          (buyer)────────────▶ REJECTED
           ──kite.contract.refund_consented  (seller)───────────▶ CANCELLED
REJECTED   ──kite.contract.appealed          (seller)───────────▶ DISPUTED
           ──APPEAL_RESPONSE_EXPIRED (deadline)─────────────────▶ CANCELLED
           ──kite.contract.refund_consented  (seller)───────────▶ CANCELLED
DISPUTED   ──kite.contract.arbiter_decided   (arbiter)──────────▶ RESOLVED
           ──ARBITRATION_EXPIRED   (deadline)───────────────────▶ CANCELLED
```

Terminal states — five: `ACCEPTED`, `RESOLVED`, `CANCELLED`, `DEFAULTED`,
`EXPIRED`. Each terminal state additionally accepts `SETTLEMENT_OBSERVED` as a
**self-loop**, because money settles on chain *after* the agreement state is
already final; a post-terminal settlement observation changes no state and is
recorded like any other transition.

Two properties implementers coming from earlier drafts must not assume away:

- **There is no resubmission edge.** `REJECTED` goes only to `DISPUTED` or
  `CANCELLED`; a seller who wants to deliver again after a rejection appeals
  or the parties settle. (Earlier drafts had a policy-bounded
  `rejected → submitted` loop; it was dropped when this section was aligned to
  the engine.)
- **Arbitration resolves either way.** `RESOLVED` covers a decision for the
  seller as well as for the buyer; it is not a refund path with another name.

A command whose `commandType` is not legal from the deal's current state
**MUST** be rejected as `illegal_transition`. A Runtime **MUST NOT** invent
transitions not in the pinned template.

### 3.1 Deadline windows

The five windows are **platform configuration, not contract terms** — they are
config-driven constants of the Runtime deployment, the same for every
agreement it executes, and they are not part of the signed `termsHash` (an
earlier draft made them contract members; that claim is withdrawn). Defaults:

| Window | Default | Governs |
|---|---|---|
| funding timeout | 30 min | `COMMITTED → EXPIRED` |
| delivery deadline | 24 h | `FULFILLING → DEFAULTED` |
| delivery confirmation window | 48 h | auto-confirm: `DELIVERED → ACCEPTED` |
| appeal response window | 48 h | `REJECTED → CANCELLED` |
| arbitration window | 7 days | `DISPUTED → CANCELLED` |

A timeout **MUST NOT** silently weaken a required signature or a required Audit
record. Where the window auto-confirms a delivery, the resulting transition is
still recorded as a transition with its own proof, attributed to the timeout
rather than to a party.

## 4. Signed objects

All three objects share one canonicalization rule: **RFC 8785 (JCS)** over the
object with its signature member omitted, prefixed by a domain-separation tag.

Signature profile `secp256k1-keccak-v1` is a **recoverable secp256k1 ECDSA
signature over `keccak256(signed bytes)`**, encoded as the `0x`-prefixed
65-byte `r ‖ s ‖ v` hex string (`v` ∈ {27, 28}). This is the **same signing
primitive the EscrowVault settlement layer uses** (EIP-712 typed data is
likewise a keccak256 digest signed with recoverable secp256k1): one agent
secp256k1 key therefore serves **both** coordination-layer signing (this
profile) **and** on-chain settlement, and there is no second curve or key
type in the Kite-native path. The signer is not named by a `kid` header —
it is **recovered** from the signature and **MUST** equal the secp256k1 key
resolved for the `keyId` (§8), which is the agent's on-chain EVM address (the
vault's `buyerAgent`/`sellerAgent`). Verification thus ties an agent's
coordination consent to the exact identity that moves money on chain.

**Domain-separation tags are normative and distinct.** A signature produced
under one tag **MUST NOT** verify under another:

| Object | Tag | Signed bytes (keccak256'd, then secp256k1-signed) |
|---|---|---|
| DealContract | `kite:a2a-agreement:terms:v1` | tag ‖ `termsHash` (the ASCII `sha256:<hex>` string) |
| AgreementCommand | `kite:a2a-agreement:command:v1` | tag ‖ `rfc8785(command without "signature")` |
| AgreementTransitionReceipt | `kite:a2a-agreement:receipt:v1` | tag ‖ `rfc8785(receipt with ONLY the immutable transition fields)` |

The receipt's signed fields are exactly `schema`, `receiptId`, `dealId`,
`commandId`, `commandHash`, `fromState`, `toState`, `revision`, `recordedAt`
(§4.3): `runtimeSignature` is omitted (it is the signature) and the Audit-owned
`auditStatus` / `auditReceiptRef` are excluded, so their later mutation cannot
invalidate the signature. A `commandId`/`commandHash` absent because no
AgreementCommand drove the transition (§4.3) is omitted from the canonical
object, not serialized as null.

Hash references throughout are the string form `sha256:<64 lowercase hex>`.
`termsHash` remains a **sha256** digest (the agreement content hash); the
**keccak256** above is only the signing digest applied to `tag ‖ signed
bytes`, exactly as the settlement layer hashes its typed data.

**`keyId` binds to its asserting identity.** The DID prefix of `keyId` (the part
before `#`) **MUST** equal the object's asserting identity — `signerAgentId` for
a DealContract entry, `actorAgentId` for an AgreementCommand, the Runtime's DID
for a receipt — and that identity **MUST** be an authorized participant for the
action (buyer/seller/arbiter as the state permits). A `keyId` naming a different
DID is rejected before key resolution. The fragment after `#` is the key's
canonical thumbprint (§8), naming the specific key the signature **MUST**
recover to. Agent-level membership is insufficient when one Agent DID has
multiple active runtimes.

### 4.1 DealContract and termsHash

Schema: `schemas/v1/deal-contract.schema.json`
(`$id: https://a2a.gokite.ai/schemas/deal-contract/v1`).

Required members: `schema`, `template`, `buyerAgentId`, `sellerAgentId`,
`deliverable`, `acceptanceCriteria`, `price`, `disputePolicy`,
`runtimeBinding`, `escrow` (with `payoutAddress` — `fixed_outcome/v1` cannot
settle without a payout destination, so a contract omitting it is refused),
`signatures`. Optional: `buyerAuthorityRef`, `evidenceSchema`,
`disclosurePolicy`, `verifier`. There is no `deadlines`
member: the workflow windows are platform configuration (§3.1), not terms the
parties sign.

```
termsHash = "sha256:" || hex( sha256( rfc8785( contract without "signatures" ) ) )
```

Both parties compute this independently. The Runtime **MUST** recompute it and
**MUST NOT** trust a client-supplied value.

**Two-signature acceptance.** `signatures` holds exactly one entry while
`PROPOSED` and exactly two once `COMMITTED`. The first entry is the **proposal**;
the second is the **acceptance** and **MUST** be over the *identical*
`termsHash`. Each entry carries `signerAgentId`, `profile`, `keyId`, `sig`
(the `0x`-prefixed 65-byte `r ‖ s ‖ v` hex of §4), and — once the contract is
accepted — `agreementSig`: the party's EIP-712 **Agreement** co-signature
(settlement layer, §4.4).

**`agreementSig` is two-phase, by construction.** The Agreement struct commits
to the `dealId` the Runtime assigns when it accepts the proposal, so no
Agreement signature can exist before the proposal reply returns that id:

- the **proposal** entry carries the formation `sig` only — `agreementSig`
  **MUST** be absent (there is nothing it could validly commit to);
- the **acceptance** submission carries the full two-entry `signatures` array
  and **MUST** include `agreementSig` on **both** entries. The buyer produces
  its Agreement signature after the proposal reply returns the deal id and
  hands it to the seller **off-protocol** — v1 defines no in-protocol channel
  for it (`status` returns agreement state, never contract signatures); the
  Runtime verifies **both** at the accept gate before starting the workflow.
  `fixed_outcome/v1` settles on chain and v1 defines no mode with settlement
  disabled.

`agreementSig` is a **different object and digest** from the formation `sig`
(§4.4 defines it exactly); the two are never interchanged, and the platform
produces neither (each party self-signs). The schema enforces the phase rule:
a one-entry (proposed) contract validates without `agreementSig`, a two-entry
(accepted) contract does not.

Any changed contract member yields a different `termsHash` and is therefore a
**new proposal**; it **MUST NOT** be treated as acceptance, and it invalidates
the previous acceptance path.

**Acceptance pins party runtime authorities.** A buyer or seller Agent DID may
have multiple active runtimes, each independently executing a different
agreement. The final two-signature contract selects the buyer and seller
runtime keys through each party's `signatures[].keyId`. Before committing acceptance, the Runtime
**MUST** resolve each exact key, verify that it is active and belongs to the
declared party DID, and verify that party's `agreementSig` under the resolved
EVM address. The accepted agreement persists both key IDs and addresses.
Subsequent commands and settlement signatures **MUST** use the authority pinned
for that party and agreement; a Runtime **MUST NOT** repeat a DID-to-single-key
lookup or silently rotate an agreement when another runtime becomes active.

**`runtimeBinding` pins the execution context**: `runtimeAgentId`,
`agentCardHash`, `extensionUri` (fixed to this Extension's URI), `endpoint`, and
the Audit policy. Redirecting an accepted agreement to another Runtime,
Extension version, template, or Audit policy **MUST** require a new proposal and
two fresh signatures. Pinning `agentCardHash` is why a Runtime's card must be
minimal and deterministic — a card that churns per deploy breaks pinning.

**The arbiter is a third party, structurally.** A Runtime **MUST** refuse a
proposal whose `disputePolicy.arbiterAgentId` equals `buyerAgentId` or
`sellerAgentId` — a party able to name itself arbiter would resolve its own
dispute, which is the exact capture `disputePolicy` exists to prevent.

**The arbiter must resolve at proposal time.** `arbiterAgentId` is an
Activation address field (§4.4, `address arbiter`) and therefore one of the
inputs the settlement layer hashes into the deal id — so the arbiter is not a
name held in reserve until a dispute. A Runtime **MUST** resolve the named
arbiter to its settlement address when the proposal is made and **MUST** refuse
a proposal whose arbiter has no single resolvable on-chain address (an
unregistered agent, no active settlement key, or more than one active runtime).
The Runtime **MUST** persist that resolved address as part of the proposed
agreement, use it when constructing `Activation.arbiter`, and **MUST NOT**
repeat the DID-to-address lookup after proposal. An `arbiter_decided` command's
exact `keyId` **MUST** resolve to that pinned address; a later runtime under the
same Agent DID does not inherit authority over an agreement it was not formed
under.
Unlike buyer and seller authorities, v1 does not carry an
`arbiterRuntimeKeyId`; multi-runtime selection is therefore deliberately scoped
to agreement parties. An arbiter operator that needs several runtimes MUST use
distinct Agent DIDs, one per settlement authority. Deferring the check to
dispute time is too late: an unresolvable arbiter cannot be placed in the
Activation, so no deal id can be formed and the agreement could never have
been funded.

**On the Kite deployment, the arbiter is the Coordination Engine.** Parties
transacting on Kite's own Runtime name

```
did:kite:corp-kite:kite-coordination-engine
```

as `disputePolicy.arbiterAgentId`. This is a property of that deployment, not
of the Extension: `arbiterAgentId` stays a per-agreement field that any
deployment fills with whatever third party its parties agree on, and an
implementation that pins a different arbiter is fully conformant. It is stated
here because the value is otherwise undiscoverable — parties have to agree on
the same arbiter *before* the proposal is signed, since it is hashed into the
deal id, and there is no negotiation step in which to discover it.

Naming the Runtime satisfies both rules above: the Coordination Engine is
neither `buyerAgentId` nor `sellerAgentId`, and it is a registered agent with
an active settlement key, so it resolves to a single on-chain address at
proposal time. What it does **not** do is make the arbiter independent of the
Runtime — the same operator holds agreement state and decides disputes over it.
A deployment that needs those separated names a different agent here; nothing
in this section stops it.

Negotiation itself is **off-protocol**: drafts, chat, and rejected offers never
enter the workflow or the audit log.

### 4.2 AgreementCommand

Schema: `schemas/v1/agreement-command.schema.json`
(`$id: https://a2a.gokite.ai/schemas/agreement-command/v1`).

Required: `schema`, `commandId`, `commandType`, `dealId`, `expectedRevision`,
`actorAgentId`, `termsHash`, `payload`, `payloadHash`, `occurredAt`,
`signature`. Optional: `evidenceRefs`.

**The payload channel.** `payload` is the command-type-specific object —
the data the state machine needs to execute the command, carried inside the
signed command so it shares the command's integrity:

```
payloadHash = "sha256:" || hex( sha256( rfc8785( payload ) ) )
```

Per-type members (camelCase on the wire). **Every member of every type is
required, and no payload is ever the empty object**: `fixed_outcome/v1`
settles on chain, so each payload carries the settlement signature that
authorizes its vault call and the `expiry` (a unix timestamp ≥ 1) bounding it.
The schema enforces this table with per-`commandType` conditionals — a missing
member or an unknown one is rejected at the schema, the same as on the
command itself.

| `commandType` | `payload` members (all required) |
|---|---|
| `kite.contract.delivered` | `evidenceId`, `deliveryHash`, `sellerDeliverySig`, `expiry` |
| `kite.contract.accepted` | `buyerAcceptanceSig`, `expiry` |
| `kite.contract.rejected` | `reasonCode`, `buyerRejectionSig`, `expiry` |
| `kite.contract.appealed` | `sellerAppealSig`, `expiry` |
| `kite.contract.refund_consented` | `sellerConsentSig`, `expiry` |
| `kite.contract.arbiter_decided` | `decisionId`, `sellerBps`, `arbiterSig`, `expiry` |

**Settlement anchors are derived, and the derivation is normative.** Two
string-valued members reach the chain as `bytes32`:

```
vault reasonHash          = keccak256( UTF-8 bytes of reasonCode )
vault decisionId (bytes32) = keccak256( UTF-8 bytes of decisionId )
```

The wire keeps the human-meaningful string (it is what the agreement log
records); the embedded settlement signature (`buyerRejectionSig`,
`arbiterSig`) commits to the **derived** value inside its EscrowVault struct,
and the Runtime **MUST** apply the same derivation when it relays the vault
call. keccak256 is the settlement layer's own hash — the same function every
EIP-712 digest here already uses. The `valid-rejected` and
`valid-arbiter-decided` vectors pin both derivations under
`expected.settlement`.

**The delivery payload names two different things, and conflating them breaks
settlement.** `evidenceId` is the opaque identifier the Runtime returned when
the seller registered the artifact through the `evidence` interaction
(§6.2.1, §6.3) — an id, not a hash; the Runtime **MUST** refuse a `delivered`
command citing an id it never issued for this agreement. `deliveryHash` is the
**sha256 content hash of that registered artifact**, in the `sha256:<hex>`
spelling: its 32 raw digest bytes are the settlement layer's `bytes32
deliveryHash` — the member of the EIP-712 `Delivery` struct that
`sellerDeliverySig` commits to, and the value the vault's `markDelivered`
receives. The Runtime **MUST** verify that `deliveryHash` equals the content
hash registered under `evidenceId` before accepting the command, so the value
that reaches the chain is the one the evidence intake validated. (An earlier
draft carried a single `evidenceRef` doing both jobs; an opaque id cannot be a
`bytes32`, so the two are now distinct members.)

The `*Sig` members are **settlement-layer signatures** — EIP-712 over the
EscrowVault settlement structs — opaque strings to this extension. They share
the command signature's *primitive* (recoverable secp256k1, and under
unification the *same agent key*), but they are a **different layer**: they are
over the settlement typed data, not over the command bytes, so they never
substitute for the command's own `signature` (§4 layering). `expiry` is a unix
timestamp bounding the embedded signature.

`commandType` ∈ { `kite.contract.delivered`, `kite.contract.accepted`,
`kite.contract.rejected`, `kite.contract.appealed`,
`kite.contract.refund_consented`, `kite.contract.arbiter_decided` }.

**This vocabulary is normative as published.** The `kite.contract.*` message
types originated in the Coordination Engine's code (`fulfill-engine`
`pkg/model/model.go`), but the closed enum above is what implementers may rely
on: an implementation emitting or accepting a type outside it is
non-conforming, and the vocabulary grows only through a new release of this
document (§3). Each value names exactly one
**recorded event** (§5) — a transition kind, not a single edge: which edge it
takes is resolved against the deal's current state
(`kite.contract.refund_consented` is legal from three states, for instance),
and a command not legal from the current state is rejected as
`illegal_transition`. There is still no translation layer between the wire
and the state machine to get wrong: the command IS the event.

Two lifecycle steps are deliberately **not** command types. Proposal and
acceptance arrive as their own interaction kinds (`proposal` / `acceptance`,
§6.2), because those payloads carry a whole `DealContract` rather than a
command against an existing deal; a client **MUST NOT** submit them through
the `command` kind, and a Runtime **MUST** reject them there. And there is no
funding command at all: funding is a chain fact the Runtime observes
(`FUND_CONFIRMED`, §3), not something a party asserts. The seventh engine
message type, `kite.contract.fulfill_started`, is a Runtime→seller
notification (§6.5), never a command.

The signed body is `rfc8785(command)` with `signature` omitted, under the command
tag. On receipt a Runtime **MUST**:

1. validate against the schema for the declared `schema` version;
2. independently recompute every claimed hash: `termsHash` from the stored
   contract, `payloadHash` from `rfc8785(payload)` (rejecting a mismatch as
   `payload_hash_mismatch`), evidence refs from validated intake;
3. resolve the exact `signature.keyId` per §8, recover the signer address from
   `signature.sig`, require it to equal that active key's address, and, for a
   buyer or seller, require the key to equal the authority pinned for that
   party at agreement acceptance;
4. verify the actor is a participant and authorized for this `commandType`;
5. check `expectedRevision` against the deal's current revision;
6. apply the transition **atomically** with its Audit outbox write.

`commandId` is the **idempotency key**. Replaying it with identical immutable
bytes **MUST** return the original result; replaying it with different bytes
**MUST** be rejected as `idempotency_conflict` and audited.

`expectedRevision` provides optimistic concurrency. A stale value **MUST** be
rejected as `revision_conflict`, which is retriable after refetching state.

**There is no opt-out.** `expectedRevision` is required and **MUST** be at
least `1`; a Runtime **MUST** reject `0` as `invalid_command_schema` and
**MUST NOT** interpret it as "skip the concurrency check". Revision `0` is the
pre-transition state of a freshly created agreement, so no command can legally
target it — which is exactly why treating it as a sentinel is dangerous: a
caller that omits the value by accident, or an attacker that sets it
deliberately, would otherwise have every concurrency guarantee in this section
silently disabled for that command.

A transport credential — API key, OAuth token, JWT — authenticates the *caller*
and **MUST NOT** substitute for the actor's command signature. Either party
**MAY** relay the other's signed object; relaying **MUST NOT** let the relayer
alter or impersonate it. Consequently transport identity is **not** required to
equal `actorAgentId`.

### 4.3 AgreementTransitionReceipt

Schema: `schemas/v1/transition-receipt.schema.json`
(`$id: https://a2a.gokite.ai/schemas/agreement-transition-receipt/v1`).

Required: `schema`, `receiptId`, `dealId`, `fromState`, `toState`,
`revision`, `recordedAt`, `auditStatus`, `runtimeSignature`. Optional:
`auditReceiptRef`, and — present exactly when an **AgreementCommand** drove the
transition — `commandId` and `commandHash`; Runtime-driven transitions
(chain observations, deadline expiries, auto-confirm, §5) carry neither,
and their receipt-identity/idempotency contract is a draft gap (§9.1).

The split is by **command**, not by actor. A transition can be party-driven and
still carry no command identity: `CONTRACT_SIGNED` is driven by a party, but it
arrives through the `acceptance` interaction (§6.2), and acceptance is **not**
an AgreementCommand — a `command` interaction bearing it **MUST** be rejected on
the command kind (§5). Its receipt therefore omits `commandId`/`commandHash` for
the same reason a Runtime-driven one does: there are no command bytes to name.
A consumer **MUST NOT** read the absence as evidence that the Runtime drove the
transition — `actorId` on the corresponding proof link (§6.3) is what says who
did.

**Receipt lifecycle is owned by the Audit plane.** The Runtime's own artifact
is its hash-chained, signed **transition-proof record**, committed atomically
with each accepted transition; the Audit plane builds and manages transition
receipts from that proof chain.

**v1 returns no receipt synchronously.** A state-changing reply carries
`receipt: null` — always, not merely while an Audit write is in flight. The
receipt is produced on the Audit plane after the reply, and the disclosure
operations that would hand it back (`get-agreement-proof`) are not specified
in v1 (§9.1). A client **MUST** therefore treat `receipt` as absent and
**MUST NOT** block on it: the transition evidence a v1 client can actually
obtain is the **proof chain**, read with the `proofs` interaction (§6.2), and
`status` is what tells it the transition landed. `auditStatus` travels only
on the receipt, so it is absent for the same reason.

The member is retained in the response shape — rather than removed — because
the receipt is a real artifact of the model and a later minor version will
populate it; a client written against v1 must already tolerate both. The
`AgreementTransitionReceipt` schema (this section) stays normative for that
artifact wherever it *is* produced and for the Audit plane that produces it.

Replaying the `commandId` returns the **original** stored result (§4.2) — a
replay is an idempotency guarantee, not a receipt-refresh channel.

**What the runtime signature covers.** `runtimeSignature` signs ONLY the
immutable transition fields (`schema`, `receiptId`, `dealId`, `commandId`,
`commandHash`, `fromState`, `toState`, `revision`, `recordedAt`).
`auditStatus` and `auditReceiptRef` are Audit-owned lifecycle metadata
**outside the signed bytes**: they may change (`pending` → `recorded`)
without touching, or invalidating, the Runtime's signature.

**The transition receipt and the Audit receipt are different guarantees and
MUST NOT be presented as one.** The transition receipt proves what the Runtime
*accepted*. The referenced Audit receipt proves that the corresponding event
reached the append-only log. Audit ingestion may still be pending when a
receipt is first presented, which `auditStatus` reports (`pending` until the
matching event is durably appended). Clients **MUST** treat
`auditStatus: "pending"` as "not yet proven durable", not as failure.

`runtimeSignature` is `{ keyId, sig }` — a `secp256k1-keccak-v1` signature by
the Runtime's own key over

```
keccak256( "kite:a2a-agreement:receipt:v1" ‖ rfc8785(<the §4 signed-field set>) )
```

where the signed field set is exactly the nine members §4 lists, and the
Audit-owned `auditStatus` / `auditReceiptRef` are **outside** it so that
re-stamping a receipt as durably appended does not invalidate a signature
already handed out.

That exclusion has a consequence clients **MUST** respect: `auditStatus` is
**not** signed evidence. Anyone relaying a receipt can change `pending` to
`recorded` and the signature still verifies. Durability is proven by the
referenced Audit receipt, never by this field — which is why a v1 client, with
no way to fetch that receipt yet (§9.1), can treat `recorded` as a hint at
most.

An **unsigned** receipt (`runtimeSignature: null` — a valid value per the
schema, distinct from `receipt: null` which means no receipt at all) is
visibly a non-guarantee: implementations **MUST NOT** present one as proof
of anything.

### 4.4 Settlement profile (`fixed_outcome/v1`)

The `agreementSig` entry member (§4.1) and the payload `*Sig` members (§4.2)
are **EIP-712 signatures** the Coordination Engine and the EscrowVault verify.
They are opaque to the coordination layer's own canonicalization and
signature rules — but an independent agent must *produce* them, so their
construction is normative here. All are signed with the agent's one secp256k1
runtime key (§8).

**Two domains.** Digest = `keccak256( 0x1901 ‖ domainSeparator ‖ structHash )`,
per EIP-712, with structs ABI-encoded as 32-byte words:

| Domain | Type string | name / version | Used by |
|---|---|---|---|
| Agreement (accept gate, off-chain) | `EIP712Domain(string name,string version,uint256 chainId)` — **no verifyingContract** | `KiteFulfill` / `1` | `agreementSig` |
| Vault (on-chain calls) | `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` | `KiteEscrowVault` / `1`, verifyingContract = the EscrowVault address | every payload `*Sig` |

**Struct type strings — verbatim, frozen:**

```
Agreement(bytes32 agreementId,bytes32 termsHash,uint256 amount,address buyerAgent,address sellerAgent)
Activation(bytes32 termsHash,address buyer,address buyerAgent,address sellerAgent,address sellerPayout,address arbiter,uint256 amount,uint64 fundingDeadline,uint64 deliveryWindow,uint64 deliveryConfirmationWindow,uint64 appealResponseWindow,uint64 arbitrationWindow)
Delivery(bytes32 dealId,bytes32 termsHash,bytes32 deliveryHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)
Acceptance(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)
Rejection(bytes32 dealId,bytes32 termsHash,bytes32 reasonHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)
Appeal(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)
RefundConsent(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,uint64 nonce,uint64 expiry)
Resolution(bytes32 dealId,bytes32 termsHash,bytes32 decisionId,uint16 sellerBps,bytes32 receiptHash,uint64 nonce,uint64 expiry)
```

The payload-to-struct mapping is one-to-one: `sellerDeliverySig` → Delivery,
`buyerAcceptanceSig` → Acceptance, `buyerRejectionSig` → Rejection,
`sellerAppealSig` → Appeal, `sellerConsentSig` → RefundConsent,
`arbiterSig` → Resolution. The §6.2.1 funding artifacts map to Activation:
`buyerActivationSig` and `sellerActivationSig` are both signatures over the
**same** Activation digest — the vault's `fund()` verifies the pair.

**Where the domain parameters come from.** `chainId` and the vault address
are published in the Runtime's Agent Card extension `params` (§2.1) and are
pinned — via `agentCardHash` — inside the signed terms. They are known at
discovery time, which is what makes the acceptance-time `agreementSig`
producible at all. The Activation's five §3.1 platform windows are read back
through the `funding` interaction (§6.2), which returns the Activation the
parties sign — a party never invents them. The one member the buyer
contributes is its own **buyer wallet**: the Runtime does not know it until
the buyer declares it, so the buyer supplies it through `funding-signatures`
(`buyerWallet`, §6.2.1) and the Runtime completes the Activation with it
before deriving the deal id. Both agents sign that completed Activation.

**Field derivations — normative:**

- `agreementId` (bytes32) = `keccak256( UTF-8 bytes of the Runtime-assigned
  agreement id string )` — the id the proposal reply returned (§4.1).
- `termsHash` (bytes32) = the 32 raw digest bytes of §4.1's
  `sha256:<hex>` termsHash.
- `amount` (uint256) = the contract's `price.amount` in **USDC base units**
  (6 decimals; `"25.00"` → `25000000`). The conversion happens **once**, and
  where it happens differs by struct: a party signing the *Agreement* converts
  the contract's decimal itself, while the *Activation* read back through the
  `funding` interaction already carries base units
  (`activation.schema.json` pins `^[0-9]+$`) — a signer that converts the
  read-back value again produces a digest 10^6 too large, refused only at the
  vault.
- `dealId` (bytes32) = `EscrowVault.dealIdFor(Activation)` — keccak256 of the
  ABI-encoded Activation struct. A party **MUST NOT invent** it: the value
  **read back** through the `funding` and `status` interactions (§6.2) is
  authoritative. A party MAY re-derive it locally from the completed
  Activation, but only to **cross-check** the read-back value — the Runtime
  itself does exactly this to enforce `expectedDealId` before broadcasting
  `fund()` (§6.2.1). A local derivation that disagrees with the read-back is a
  hard error, never a value to submit.
- `deliveryHash`, `reasonHash`, `decisionId` — the §4.2 derivations.
- `receiptHash` (bytes32) = the **prior** transition-proof hash: the proof of
  the transition the actor observed (via `status`, pinned by
  `expectedRevision`) before signing. Never the proof minted *for* this
  command — that proof does not exist when the actor signs, so a digest over
  it could never verify.
- `nonce` (uint64) = the vault deal's current nonce, read via `status`.
- `expiry` (uint64) = the payload's `expiry` member (§4.2).

The `settlement` vector set pins every derivation for **all eight structs** —
Agreement, Activation, and the six vault-call structs — as struct hashes,
digests and recoverable signatures under both domains, from the published
fixture keys.
An implementation that reproduces them can settle; one that cannot has
diverged from the vault, whatever else it passes.

## 5. Command-to-event binding

Every accepted transition is recorded with the engine's **event** name — the
same vocabulary the transition-proof chain and the Audit log carry, so a
receipt consumer can mechanically match a wire command to its recorded event.
This mapping is **one-to-one** and normative as published (§3).

Party-driven, via a signed AgreementCommand (or the two contract-carrying
interaction kinds):

| Interaction / `commandType` | Transition | Recorded event |
|---|---|---|
| proposal | ∅ → `PROPOSED` | — (pre-FSM; the proof chain starts at `COMMITTED`) |
| acceptance | `PROPOSED` → `COMMITTED` | `CONTRACT_SIGNED` (workflow start: both parties' signatures are recorded with it; the proof's actor is the **buyer** — the proposer, whose signature the AuthorityRef carries — with the seller's co-signature in the proof metadata) |
| `kite.contract.delivered` | `FULFILLING` → `DELIVERED` | `DELIVERED` |
| `kite.contract.accepted` | `DELIVERED` → `ACCEPTED` | `ACCEPTED` |
| `kite.contract.rejected` | `DELIVERED` → `REJECTED` | `REJECTED` |
| `kite.contract.appealed` | `REJECTED` → `DISPUTED` | `APPEALED` |
| `kite.contract.refund_consented` | `FULFILLING`\|`DELIVERED`\|`REJECTED` → `CANCELLED` | `CONSENTED_REFUND` |
| `kite.contract.arbiter_decided` | `DISPUTED` → `RESOLVED` | `RESOLVED` |

Runtime-driven — no `commandType` produces these; they are observations and
deadline expiries the Runtime records on its own authority:

| Recorded event | Transition | Driven by |
|---|---|---|
| `FUND_CONFIRMED` | `COMMITTED` → `FULFILLING` | chain observation |
| `FUNDING_EXPIRED` | `COMMITTED` → `EXPIRED` | funding timeout |
| `DELIVERY_MISSED` | `FULFILLING` → `DEFAULTED` | delivery deadline |
| `ACCEPTED` | `DELIVERED` → `ACCEPTED` | confirmation-window auto-confirm |
| `APPEAL_RESPONSE_EXPIRED` | `REJECTED` → `CANCELLED` | appeal response window |
| `ARBITRATION_EXPIRED` | `DISPUTED` → `CANCELLED` | arbitration window |
| `SETTLEMENT_OBSERVED` | terminal → same terminal (self-loop) | chain observation |

Runtime-driven transitions have no `commandId`: their receipts identify the
transition by (`dealId`, `revision`, event) and omit `commandId`/`commandHash`
(§4.3). A collision-safe observation-identity and idempotency contract for
them is a **draft gap** (§9.1).

Evidence intake is recorded from the Audit plane's own evidence endpoint, not
from a workflow command — it is absent from both tables because no
`commandType` produces it and it moves no state.

A Runtime **MUST NOT** record an event outside this mapping for an accepted
workflow transition.

## 6. A2A operation mapping

The Extension rides on standard A2A 1.0. Only one method is used:

```
POST <endpoint>      JSON-RPC 2.0, method "SendMessage"
```

### 6.1 Request

The Extension payload travels in a Part's **`raw`** member with the Extension
media type:

```json
{
  "jsonrpc": "2.0", "id": "…", "method": "SendMessage",
  "params": { "message": {
    "messageId": "…",
    "role": "ROLE_USER",
    "extensions": ["https://a2a.gokite.ai/extensions/coordination-workflow/v1"],
    "parts": [{
      "raw": "<base64 of the canonical JSON>",
      "mediaType": "application/vnd.gokite.agreement-command+json;version=1"
    }]
  }}
}
```

**`raw`, never `data` — this is a correctness requirement.** A2A 1.0's
`Part.data` is a `google.protobuf.Value`, whose only numeric type is a double,
so an integer member such as `expectedRevision: 6` round-trips as `6.0`. The
canonical bytes then differ from what was signed and **every signature fails**.
`raw` is proto `bytes` — base64 on the wire, byte-identical end to end.

A Runtime **MUST** prefer the Part declaring the Extension media type when
several `raw` Parts are present. Plain-text Parts are not Extension
interactions: private negotiation happens between the agents, not with the
Runtime.

`role` values are ProtoJSON enum names (`ROLE_USER`, `ROLE_AGENT`), not 0.x's
lowercase spellings.

### 6.2 Interactions

Schema: `schemas/v1/interaction-request.schema.json`
(`$id: https://a2a.gokite.ai/schemas/agreement-interaction-request/v1`), a
`oneOf` dispatched on `kind`. The table below is the summary; the schema is
normative, and the party-scoped kinds are defined by
`schemas/v1/party-envelope.schema.json` (§6.2.1).

The decoded `raw` object carries a `kind`:

| `kind` | Purpose | Payload | Who |
|---|---|---|---|
| `proposal` | Submit final terms with the first signature | `{ contract }` | buyer |
| `acceptance` | Countersign the identical `termsHash` | `{ dealId, contract }` | either party (or a relay acting for them): the countersignature is the seller's, but the sender is not authenticated — authority derives from the contract's two signatures, not from who delivers them |
| `command` | Submit a signed AgreementCommand | `{ command }` | the party the command type belongs to (§5) |
| `status` | Read current state and revision | `{ dealId }` | anyone |
| `funding` | Read the Activation to sign and which artifacts have arrived | signed envelope (§6.2.1) | either party |
| `funding-signatures` | Deliver this party's funding artifacts | signed envelope + `submission` | either party, own fields only |
| `evidence` | Register a delivery artifact against the agreement | signed envelope + `submission` | **seller only** |
| `evidence-list` | Resolve proof evidence ids to artifact URLs and verification metadata | signed envelope (§6.2.1) | either party |
| `proofs` | Read the transition-proof chain | signed envelope (§6.2.1) | either party |

#### 6.2.1 Party-scoped interactions

Schema: `schemas/v1/party-envelope.schema.json`
(`$id: https://a2a.gokite.ai/schemas/agreement-party-envelope/v1`). The
`submission` payloads are `schemas/v1/funding-submission.schema.json` and
`schemas/v1/evidence-submission.schema.json`.

`funding`, `funding-signatures`, `evidence`, `evidence-list` and `proofs` are
**party-only**. Each carries a signed envelope; the Runtime **MUST** reject a
request whose signature does not verify, or whose actor is not a party to the
named deal. `evidence` remains seller-only for writes; `evidence-list` is a
read available to either party, so a buyer can resolve a proof's `evidenceId`
to the registered `url`, `hash`, and verification metadata before accepting.

```json
{ "kind": "funding-signatures",
  "dealId": "…",
  "actorAgentId": "did:kite:…",
  "termsHash": "sha256:…",
  "submission": { "…": "…" },
  "signature": { "profile": "secp256k1-keccak-v1", "keyId": "did:kite:…#jkt:776efa727ed8ff52", "sig": "0x…" } }
```

`sig` is a `secp256k1-keccak-v1` signature over

```
keccak256( "kite:a2a-agreement:funding:v1" ‖ rfc8785(envelope without "signature") )
```

— a distinct domain tag from §4.1's terms tag and §4.2's command tag, so no
signature made for one can be replayed as another. When present, `termsHash`
**MUST** equal the agreement's; the Runtime rejects a mismatch.

Two rules beyond the signature, because a valid signature says only *who sent
this*:

- **Role binding.** On `funding-signatures` the buyer **MAY** set
  `buyerWallet`, `buyerActivationSig`, `auth3009` and `expectedDealId`; the
  seller **MAY** set `sellerActivationSig`. Any other combination **MUST** be
  rejected. The buyer wallet in particular is the address the Activation both
  parties sign is built around: a counterparty able to set it can make the
  deal unfundable after the buyer's funds are already committed.
- **Deal-identity binding.** `expectedDealId` is the EscrowVault **deal id**
  — the settlement layer's `dealIdFor(Activation)` (§4.4) — that the
  `auth3009` authorization's EIP-3009 nonce is bound to. Its wire form is a
  `0x`-prefixed lowercase-hex string of **exactly 32 bytes** (a `bytes32`).
  It is NOT the Runtime agreement id the interactions carry as `dealId`: those
  are different identifiers (the agreement id is the Runtime's; the vault deal
  id is derived from the funded Activation), and conflating them is a bug.
  A submission carrying `auth3009` **MUST** carry `expectedDealId`, and a
  submission from the **seller MUST NOT** carry it (it is a buyer-only field
  per the role binding above).

  The buyer does **not** obtain `expectedDealId` by reading it back through
  `funding`/`status` — those expose the vault deal id only AFTER funding, which
  is too late to bind the authorization. Instead the **funding-authorization
  issuer** — the party that produces `auth3009`, e.g. the buyer's session
  custodian — **MUST** return `expectedDealId` together with `auth3009`,
  derived over the same Activation the EIP-3009 nonce commits to; the buyer
  forwards the pair unchanged.

  Before broadcasting `fund()` the Runtime **MUST** derive the deal id from the
  completed Activation via the settlement layer's own `dealIdFor` and **MUST**
  refuse to broadcast unless it equals `expectedDealId`. Without this check, a
  derivation that drifted between the authorization's issuer and the settlement
  layer (a stale contract build, a diverged Activation view) surfaces only as
  the settlement token's opaque signature failure, after both parties have
  signed.
- **Write-once.** Each funding artifact **MUST** be settable once. Re-sending
  the same value is a no-op (retries are normal); a *different* value **MUST
  NOT** replace the stored one, and the rejection **MUST** be visible to the
  parties — the `funding` read reports it.

`evidence` is the seller's alone. The Runtime **MUST** refuse a `delivered`
command whose `evidenceId` was not issued for that same agreement, so
a buyer able to register evidence could manufacture the backing for the other
side's delivery claim.

### 6.3 Response

Schema: `schemas/v1/interaction-response.schema.json`
(`$id: https://a2a.gokite.ai/schemas/agreement-interaction-response/v1`), a
`oneOf` dispatched on `kind`. It pins the objects the branches carry:
`AgreementStatus` (`schemas/v1/agreement-status.schema.json`), `FundingContext`
(`schemas/v1/funding-context.schema.json`) and the `Activation` inside it
(`schemas/v1/activation.schema.json`).

The JSON-RPC `result` is A2A 1.0's `SendMessageResponse`, a **oneof** of
`task` | `message` — the reply message is **wrapped** in a member named for the
event type. 0.x inlined it with a `kind` discriminator; a 1.0 client fed that
shape rejects it as an unknown event type and cannot read any success.

```json
{ "jsonrpc": "2.0", "id": "…",
  "result": { "message": {
    "role": "ROLE_AGENT", "messageId": "…",
    "extensions": ["…/coordination-workflow/v1"],
    "parts": [{ "raw": "<base64>", "mediaType": "…agreement-command+json;version=1" }]
  }}}
```

The decoded reply payload is:

- state-changing interactions → `{ "kind": "agreement-result", "receipt": null,
  "status": … }` — receipt and status are **two distinct objects** (§4.3), and
  in v1 `receipt` is **always `null`**: the transition evidence a client can
  obtain is the proof chain (`proofs`), not a synchronous receipt. A client
  **MUST NOT** treat the null as a failure or wait for it to become populated;
- `status` → `{ "kind": "agreement-status", "status": … }`;
- `funding` → `{ "kind": "agreement-funding", "funding": … }`;
- `funding-signatures` → `{ "kind": "agreement-funding-accepted", "status": … }`;
- `evidence` → `{ "kind": "agreement-evidence-recorded", "evidenceId": "…" }`;
- `evidence-list` → `{ "kind": "agreement-evidence", "evidence": [ … ] }`;
- `proofs` → `{ "kind": "agreement-proofs", "proofs": [ … ] }`, whose elements
  are `AgreementTransitionProof` objects
  (`schemas/v1/transition-proof.schema.json`).

**The proofs payload is normative, not informational.** Its members are
`agreementId`, `sequence`, `event`, `fromState`, `toState`,
`previousStateHash`, `nextStateHash`, `proofHash`, `previousProofHash`,
`actorId`, `commandId`, `commandHash`, `evidenceRefs`, `metadata`,
`signedBy`, `signature` and `createdAt` — camelCase, like every other object
in this contract. A Runtime whose internal store spells them otherwise
**MUST** map them at the edge; leaking a storage or language-native spelling
onto the wire is a defect, because this is the payload a party reads to build
every settlement signature: `receiptHash` (§4.4) is the **prior** link's
`proofHash`. A consumer that silently reads absent members signs nothing at
all and only discovers it at the vault.

Consumers **MUST** order by `sequence`, not by array position or `createdAt`,
and **MUST** verify the chain — each link's `previousProofHash` equals the
`proofHash` at `sequence - 1`, absent exactly on the first link — rather than
trusting the order it was served in.

#### 6.3.1 Proof verification profile

Chain linkage alone proves only that the links were served consistently with
each other. To check that a link's *content* is the content the Runtime
attested, a consumer recomputes `proofHash` and verifies `signature`. Both
derivations are published here and are **frozen**: they name signed records,
so changing either would invalidate every stored proof.

**`proofHash`.** `sha256` over the fields below, each written **length-
prefixed** — the byte length as a decimal string, a `:` separator, then the
UTF-8 bytes — and concatenated in exactly this order. Length prefixing is what
stops two different field sets from producing one preimage; a plain
concatenation would let content bleed between adjacent fields.

```
agreementId
sequence                     decimal, no padding
fromState                    empty string when the link records no prior state
toState
event
previousStateHash
nextStateHash
previousProofHash            empty string on the first link (no earlier proof)
actorId
authorityRef
commandId                    empty string when no AgreementCommand drove it
commandHash                  empty string when no AgreementCommand drove it
<metadata key count>         decimal
  key, value                 repeated, keys sorted BYTEWISE ASCENDING
<evidenceRefs count>         decimal
  ref                        repeated, in array order
createdAt                    RFC 3339 with nanoseconds, UTC
```

The result is rendered `sha256:<64 lowercase hex>`.

`commandHash` is what binds the transition to the command's CONTENT rather
than to the id a caller happened to choose. Without it the chain attests that
*some* command bearing this `commandId` drove the transition, but not which
bytes — so a proof could not distinguish the command that was committed from a
different one replayed under the same id, and the Audit plane could not build
the `commandHash` its receipt carries (§4.3) from the chain at all.

The two are empty on **every** link no AgreementCommand drove — the
Runtime-driven transitions of §5 *and* `CONTRACT_SIGNED`, which is party-driven
but arrives through the `acceptance` interaction rather than as a command
(§4.3). They travel as a **pair**: a link carrying one without the other is
invalid, because an id with no hash is exactly the unanchored identity this
member exists to remove.

Two further details are load-
bearing: metadata is hashed over **sorted** keys, because a hash that varied
with map iteration order would make the chain unverifiable rather than merely
awkward; and `createdAt` is serialized as **RFC3339Nano in UTC**, so a
consumer that re-renders it in local time or drops trailing zeros computes a
different digest over identical content.

**`signature`.** A `secp256k1-keccak-v1` signature by the Runtime's own key
over

```
keccak256( "kite:fulfill:transition-proof:v1" ‖ proofHash )
```

where `proofHash` is the **rendered string**, `sha256:`-prefix included — not
the raw digest bytes. The wire form is a `0x`-prefixed 65-byte `r‖s‖v` with
`v ∈ {27, 28}`. `signedBy` is the signing key's **EVM address**, so a verifier
recovers the signer from the signature and compares it to `signedBy` directly;
it is not a DID and not a `keyId`, which is the one place this profile differs
from the party signatures in §4 and §8.

**Where the chain starts, precisely.** The Kite Runtime's first committed
transition is `PROPOSED → COMMITTED` (§3), so its **first link carries
`fromState: PROPOSED` and a `previousStateHash`** over the `PROPOSED` state at
sequence 0. Only `previousProofHash` is absent there, because no earlier
*proof* exists — a prior *state* does. A verifier **MUST** read these members
from the proof rather than assume the first link has none: they are inside the
preimage, so assuming them empty computes a different digest for a link that is
perfectly valid.

**`previousStateHash` / `nextStateHash`.** Both are `sha256` over the same
length-prefixed encoding, of exactly three fields in this order:

```
agreementId
state                        the state being hashed
sequence                     decimal
```

rendered `sha256:<64 lowercase hex>`. `nextStateHash` hashes the link's
`toState` at the link's own `sequence`; `previousStateHash` hashes the
`fromState` at `sequence - 1`. A consumer that recomputes them checks the
Runtime's state accounting, not merely its hash arithmetic.

The domain tag is distinct from every party tag (§4.1, §4.2, §6.2.1), so a
Runtime attestation can never be replayed as a party signature or the reverse.

An **unsigned** link — `signedBy` and `signature` both absent, which a
deployment with no proof-signer key produces — is a record, not a proof. A
consumer that verifies attestation **MUST** treat it as unattested rather than
as valid, and **MUST NOT** infer attestation for it from a signed neighbour.

### 6.4 Synchrony

**What "commit → reply" obliges, precisely.** The `status` in a state-changing
reply is the state THAT command's commit produced — not a later read's. A
Runtime **MUST NOT** answer before the transition is applied, and **MUST NOT**
satisfy this by replying and then reading its own state back: a second read is
not atomic with the transition, so under concurrent commands it can report a
different one, or a state that has already moved on again.

The same obligation covers refusals, and it is the half implementers miss. A
rejection the commit raises — `illegal_transition`, `idempotency_conflict`,
`revision_conflict` — **MUST** reach the caller as a domain error (§7). A
Runtime that acknowledges receipt and decides afterwards tells a client its
command succeeded and leaves it watching a state that never changes; the client
cannot distinguish that from a slow commit, so it has no correct behaviour
available.

Consequently `expectedRevision` **MUST** be checked as part of the commit, not
before it. A Runtime **MAY** also reject an already-stale value early as a fast
path, but an early check alone leaves a window in which another command commits
between the check and this one.

All interaction kinds are synchronous. The state-changing kinds
(`proposal`, `acceptance`, `command`) are validate → commit → reply; the read
kinds (`status`, `funding`, `proofs`) are validate → read → reply — they move
no state and produce no transition or receipt.

`evidence` records an artifact synchronously and returns its id.
`funding-signatures` is the one interaction that is **accepted, not applied**:
the reply means the submission was taken, and the artifacts are merged
afterwards. Its reply kind is named `agreement-funding-accepted` for exactly
that reason — it is not `…-recorded`, and a Runtime **MUST NOT** present it as
though the artifact is stored.

The consequence a client has to design around: a write-once refusal
(§6.2.1) is decided AFTER this reply, so a submission that overwrites a
settled artifact still gets a success. `rejectedFields` on the `funding` read
is where that refusal becomes visible, and a party that resubmits a corrected
value **MUST** check it rather than trusting the acceptance. Funding then
completes as a Runtime observation (§3) once the whole set has arrived. No
current `commandType` waits on external finality — funding, the one step that
does, is a Runtime observation rather than a command (§3), and its outcome
reaches the parties as a notification (§6.5). A future `commandType` whose
effect waits on external finality **MAY** return an A2A **Task**, polled with
`GetTask`, instead of an immediate reply; clients **MUST** handle both shapes
for such command types. Streaming and push notification are later,
backward-compatible additions.

### 6.5 Runtime → party notifications

The Runtime also **initiates** messages, notifying the affected party at that
party's own A2A endpoint, resolved from the party's agent identity **at send
time** (an endpoint captured at proposal can be stale by delivery —
agreements run for days). The notification is a standard `SendMessage` whose
single Part is the bare engine message in `raw`, tagged with the
**contract-message media type**:

```
application/vnd.gokite.contract-message+json;version=1
```

— deliberately distinct from the command media type, so a receiver can tell a
notification *from* the state machine apart from a signed instruction *into*
it by media type alone. The payload's `type` member carries the
`kite.contract.*` message type (the §4.2 vocabulary). **v1 defines exactly one notification**; other
runtime-driven edges (§5) produce no notification in this version, and new
notification types arrive by extending the engine's vocabulary, not this
table:

| Message type | Direction | Payload (per the engine's model) |
|---|---|---|
| `kite.contract.fulfill_started` | Runtime → seller | `type`, `deal_id`, `terms_hash`, `delivery_deadline` |

**Notifications are advisory, never authoritative.** A notification carries
no party signature, and v1 defines no mechanism for the receiver to
authenticate the Runtime as its origin — transport-level Runtime
authentication is a draft gap (§9.1). A receiver therefore **MUST NOT**
treat a notification as proof of anything or act on its content directly: any
state it cares about **MUST** be read back from the Runtime itself (a
`status` interaction against the pinned `runtimeBinding.endpoint`, correlated
by the notification's `deal_id`). That read-back rule is what makes a forged
or replayed notification harmless — it can prompt a query, never a decision.

## 7. Errors

Transport-level failures use JSON-RPC codes: `-32700` parse, `-32600` invalid
request, `-32601` unknown method, `-32602` invalid params, `-32603` internal.
Two implementation-defined codes complete the set: `-32003` signals that the
Runtime's engine is not reachable, and `-32010` carries a **domain rejection**
(below).

The line between `-32602` and `-32010` is **whether an Extension interaction
was decoded at all**. `-32602` covers the failures that stop the Runtime from
getting that far: unparseable `params`, a missing extension opt-in on either
the header or the message, no `raw` Part carrying the command media type, a
payload that is not a JSON object with a `kind`. Everything after that — the
object decoded, and then refused — is `-32010` with a catalog code, *including*
schema validation of the decoded object, which reports `invalid_command_schema`.
Drawing the line anywhere else forces a client to parse prose to learn whether
its request was malformed or merely refused.

**Domain rejections use `-32010`, not `-32602`.** A domain rejection is one
where the request was *well-formed* and the Runtime refused it on the deal's
state, the actor's authority, a stale revision or a reused `commandId`. It
**MUST** be returned as:

```json
{ "jsonrpc": "2.0", "id": "…",
  "error": {
    "code": -32010,
    "message": "expectedRevision 5 is stale; the agreement is at 7",
    "data": {
      "code": "revision_conflict", "retriable": true,
      "dealId": "deal_0123456789ab", "commandId": "cmd_01",
      "expectedRevision": 5, "currentRevision": 7
    }}}
```

`error.data` is an **AgreementDomainError**
(`schemas/v1/domain-error.schema.json`). `code` and `retriable` are
**REQUIRED**; the context members are optional but a Runtime **SHOULD** send
the ones its code makes actionable — `currentRevision` on
`revision_conflict`, `commandId` on `idempotency_conflict`, `currentState` on
`illegal_transition` — since without them the client's only recovery is to
refetch and guess.

Keeping this off `-32602` is the point of the split: `-32602` means *fix the
bytes you sent*, `-32010` means *the bytes were fine and the answer is no*. A
Runtime that collapses both onto `-32602` leaves a client unable to decide
between correcting the request, minting a new `commandId`, refetching the
revision, and retrying unchanged — four different actions behind one code.
Clients **MUST NOT** parse `message` to recover the distinction; it is
human-facing prose and not stable.

`retriable` **MUST** match the catalog entry for `code`. It travels on the
wire, rather than being looked up client-side, so a client that has not
vendored the catalog still retries correctly.

| Code | Retriable |
|---|---|
| `invalid_command_schema`, `unsupported_extension_version`, `invalid_signature`, `unknown_key`, `runtime_key_required`, `runtime_not_found`, `runtime_revoked`, `runtime_agent_mismatch`, `runtime_signature_mismatch`, `agreement_runtime_mismatch`, `unauthorized_actor`, `unknown_deal`, `terms_hash_mismatch`, `payload_hash_mismatch`, `idempotency_conflict`, `illegal_transition`, `deadline_exceeded`, `evidence_not_validated` | no |
| `runtime_pending`, `revision_conflict`, `funding_not_final`, `rate_limited`, `internal_error` | yes |

`revision_conflict` is the retriable case implementers most often get wrong:
refetch state, rebuild the command with the current revision, and use a **new**
`commandId` only if the immutable bytes changed. `internal_error` is safe to
retry with the **same** `commandId` precisely because replay is idempotent.

When the Runtime cannot determine a legal transition it **MUST** fail closed.

## 8. Key resolution and historical verification

Agent identifiers are Kite Identity DIDs, `did:kite:<identifier>:<agent_id>`.
A `keyId` is that DID plus the key's **canonical thumbprint fragment**:

```
keyId = <did> "#" jkt
jkt   = "jkt:" || first 16 lowercase-hex chars of
        hex( sha256( "secp256k1:" || <33-byte compressed public key> ) )
```

e.g. `did:kite:pubco:seller-42#jkt:776efa727ed8ff52`. The fragment is
**self-verifying** (derived from the key bytes) and non-positional, so it names
exactly one key without a lookup. The derivation is **frozen**: it names signed
receipts, so changing it would invalidate every stored reference. (The receipt
schema constrains `keyId` to this shape.)

**What v1 verification guarantees — precisely.** Resolving a `keyId` through
Identity's public resolve surface yields the named secp256k1 key as its
keccak256-derived on-chain EVM address. Verification **MUST** recover the signer
from the `secp256k1-keccak-v1` signature and require that address to equal the
active key named by the `jkt` fragment. A verifier that accepts any other
active key of the DID has authenticated the agent but not the authority the
signed object selected.

**One secp256k1 key per runtime, for everything Kite-native.** A buyer or seller
Agent DID may have several active runtimes. Each runtime's bound key signs that
runtime's L4 proof, A2A formation and command signatures, and EscrowVault
EIP-712 settlement signatures. There is **no Ed25519 key** in the Kite-native
path. Agreement acceptance pins one runtime key per party for that agreement,
so formation identity and settlement identity remain the same key without
imposing a one-runtime-per-party-Agent restriction. The arbiter restriction is
defined separately in §4.1 because v1 does not carry an arbiter runtime key.

> UCP (Unified Commerce Protocol) is **out of scope** for v1 and may never be
> offered. If a UCP Platform Profile is ever provided it requires EC **P-256**
> (a different curve), which would be a separate key decided at that time — not
> designed for here.

**Validity is checked at verification time in v1.** The identity model does
not yet carry per-key validity windows, so a verifier resolves the keys active
*now*: a signature made under a key that has since been revoked or rotated
away will no longer verify. The consequence is normative for consumers —
**archive receipts while their keys are verifiable**; a stored receipt is the
durable artifact, not the ability to re-verify it later. Once per-key validity
windows exist, verification **SHOULD** move to key validity *at command time*,
so that a later rotation, revocation, or controller-epoch change cannot
invalidate a receipt that was valid when accepted; v1 does not provide that
historical guarantee.

Runtime, agent, controller, delegated-authority, transport, and custody keys
remain **distinct roles**; unification is about the *curve and the per-agent
signing key*, not about collapsing these roles. A user's interactive session
token is **never** a durable agreement signature.

## 9. Conformance

A conforming implementation **MUST** pass `vectors/v1` and the suite in
`conformance/`. The vectors cover:

1. **Canonical bytes and hashes** — RFC 8785 output, `termsHash` derivation, and
   the `sha256:<hex>` spelling, including an integer-valued member that
   distinguishes byte-exact transport from a lossy one (§6.1).
2. **Signatures** — valid and invalid cases per profile, and cross-tag rejection:
   a terms signature **MUST NOT** verify as a command signature.
3. **Two-signature acceptance** — one entry while `PROPOSED`, two once
   `COMMITTED`, both over the identical hash; a changed member is a new
   proposal.
4. **State and revision** — every legal edge in §3, every illegal edge rejected,
   and a stale `expectedRevision`.
5. **Idempotency** — identical replay returns the original result; divergent
   replay is `idempotency_conflict`.
6. **Error mappings** — each catalog code with its `retriable` value, and the
   rejections: an uncatalogued code, a missing `retriable`, and a `retriable`
   that contradicts the catalog.
7. **Receipts** — the transition/Audit receipt distinction, `auditStatus`
   transitions, and offline verification from pinned keys and card snapshots.

A release of this Extension is complete only when an **independent
implementation**, built from this document plus the schemas and vectors and
using an existing A2A SDK, executes every workflow step without importing Kite
code. `examples/` holds that implementation. No protocol rule may exist only in
SDK code.

### 9.1 Release state

Two of the three release inputs are now met, and this section says exactly
where each stands rather than leaving an implementer to find out.

**Vectors — published.** `vectors/v1` carries 95 cases across eight sets:
canonical bytes and hash derivation, signatures under every domain tag
(including the cross-tag rejections), per-`commandType` schema conformance with
both conflict shapes, the §6.2.1 funding-submission role-binding cases, the §6.3
transition-proof chain, receipt signing, the §4.4 settlement profile
(EIP-712 struct hashes, digests and signatures under both domains), and the §7
domain-error payloads. Fixture keys and the derived thumbprints are in
`vectors/v1/index.json`.

**Examples — independent participant implementations.** `examples/` is
written from this document and the schemas and imports no Kite code. Both
agents replay the `canonical`, `signing`, `commands`, `receipts` and
`settlement` sets against their own signing and settlement modules. Their
`agreementSig` and payload `*Sig` members are real §4.4 EIP-712 signatures,
constructed two-phase exactly as §4.1 requires.

The local buyer-to-seller demo exercises the official A2A SDK's **1.x** (A2A
1.0) transport over the JSON-RPC binding: `raw` Parts selected by media type
(§6.1), the `A2A-Extensions` opt-in and echo (§2.2), and the oneof reply wrapper
(§6.3). Its peer negotiation uses the example-private media type and documented
settlement stand-ins; the buyer example does not submit Runtime interactions.

The seller also has a distinct **live mode**. It verifies a Runtime-assigned
proposal, submits `acceptance`, reads and co-signs `funding`, registers
`evidence`, and submits `kite.contract.delivered` using Runtime-issued ids and
fresh settlement anchors. A deployed instance has completed the accepted
outcome path against a live Runtime: two-signature formation, escrow funding,
the `fulfill_started` notification, autonomous delivery, buyer acceptance,
on-chain settlement, and the transition-proof read. The validation used an
external buyer participant, so the seller was exercised as a counterparty
rather than against its own in-process test double. The exact scope and the
uncovered branches are recorded in `conformance/live-validation.md`. The
`evidence-list` read (§6.2) postdates that run: its response shape is
schema-bound (`agreement-evidence` in the interaction-response schema) but no
recorded live validation exercises it yet, and it carries no vector set —
a Runtime implementer should treat it as schema-conformant, not
interop-proven.

**Conformance suite — partially runnable.** `conformance/run.py` executes the
offline checks (bytes, hashes, signatures, schemas, receipts, settlement
derivations) with no Kite
dependency. The 36 state-machine, settlement self-loop, actor-binding,
concurrency and funding deal-identity cases in
`conformance/transitions.json` are normative and complete, but they are
properties of a Runtime holding an agreement and cannot be checked against a
document; the live driver is not implemented in this release, and the runner
reports them as skipped rather than as passes. The recorded accepted-path and
seller-consented-refund interoperability runs are evidence that those paths
work; they are not substituted for the branches they did not execute and are
not reported as conformance passes.

### 9.2 v1 limitations

These are **not** work-in-progress notes: they are the boundaries of what v1
guarantees, and an implementer should design against them.

- **Verification is against current key validity, not validity at command
  time** (§8). A signature made under a key that has since been revoked will
  not verify; closing this needs per-key validity windows the identity model
  does not carry. Practical consequence: revoking a key invalidates the
  verifiability of that key's past signatures, so archive the receipts.

- **`auditStatus` is not signed evidence.** It sits outside the receipt
  preimage (§4.3) so a re-stamp does not invalidate a signature already handed
  out — which means anyone relaying a receipt can change `pending` to
  `recorded` and it still verifies. Durability is proven by the referenced
  Audit receipt, and v1 has no way to fetch one (below), so treat `recorded` as
  a hint.

- **No receipt is returned synchronously; `receipt` is always `null`** (§4.3,
  §6.3). This is the shape of every v1 state-changing reply, not a transient
  condition, so design against it: read transition evidence from the `proofs`
  chain and confirm the transition landed with `status`. The member stays in
  the response so a later minor version can populate it without a shape change.

- **Audit proof packages and `get-agreement-proof` are out of v1.** The Audit
  plane's disclosure model lands separately. It is also what would eventually
  hand back a receipt produced after the reply (§4.3).

- **Arbitration payloads are not schema'd.** `disputePolicy` references them
  and `kite.contract.arbiter_decided` carries them, but `DisputeCase` in and a
  signed `ArbitrationDecision` out have no published schema; their shape is
  deployment agreement in v1.

- **Receipt identity for Runtime-driven transitions is unspecified.** Chain
  observations, deadline expiries and auto-confirm produce receipts with no
  `commandId`, and v1 defines no collision-safe observation identity or
  idempotency contract for them (§5). Correlate them by `dealId` + `revision`.

- **Runtime origin authentication for notifications is unspecified** (§6.5).
  v1 compensates by making notifications advisory-only with a mandatory
  read-back, so a forged or replayed notification prompts a query rather than a
  decision. Never act on a notification's content directly.

- **`verifier`, `disclosurePolicy` and `evidenceSchema`** appear in the contract
  schema but their semantics are not pinned here. Treat them as reserved; do
  not rely on any behaviour from them in v1.
