# A2A Kite Coordination Extension — Specification v1

**Status: RELEASE CANDIDATE — not yet `v1.0.0`.** The wire contract below is
settled and the schemas, vectors and examples are aligned to it. One release
criterion remains open: §9 requires an independent implementation to execute
*every workflow step* against a Runtime, and the conformance suite's 29
state-machine cases have no live driver yet (§9.1). Until that runs, treat
this as implementable but not frozen — identifiers and signed preimages are
fixed, and any remaining change would be to prose or to an unmet criterion.

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
        "signatureProfiles": ["secp256k1-keccak-v1"]
      }
    }]
  }
}
```

`params` **MUST** enumerate the templates and signature profiles the Runtime
accepts, so a client can reject an unsupported pairing **before** any agreement
is formed rather than mid-workflow.

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

`fixed_outcome/v1`. The workflow is **defined by the Coordination Engine's own
state machine**; this section documents it, and where the two ever diverge the
engine is normative and this document carries the defect. The same rule holds
for the message-type vocabulary (§4.2): the engine's code is the source of
truth, and this catalog is its reference documentation.

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
invalidate the signature. A `commandId`/`commandHash` absent on a Runtime-driven
transition (§5) is omitted from the canonical object, not serialized as null.

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
canonical thumbprint (§8), naming the *specific* key whose recovered address the
signature must match.

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
(the `0x`-prefixed 65-byte `r ‖ s ‖ v` hex of §4), and — once the on-chain
settlement path is enabled — an optional `agreementSig`: the party's EIP-712
**Agreement** co-signature (settlement layer, verified by the engine at the
accept gate). `agreementSig` is a **different object and digest** from the
formation `sig`; the two are never interchanged, and the platform produces
neither (each party self-signs).

Any changed contract member yields a different `termsHash` and is therefore a
**new proposal**; it **MUST NOT** be treated as acceptance, and it invalidates
the previous acceptance path.

**`runtimeBinding` pins the execution context**: `runtimeAgentId`,
`agentCardHash`, `extensionUri` (fixed to this Extension's URI), `endpoint`, and
the Audit policy. Redirecting an accepted agreement to another Runtime,
Extension version, template, or Audit policy **MUST** require a new proposal and
two fresh signatures. Pinning `agentCardHash` is why a Runtime's card must be
minimal and deterministic — a card that churns per deploy breaks pinning.

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

Per-type members (camelCase on the wire; empty `{}` where a type carries no
data — the hash still binds the emptiness):

| `commandType` | `payload` members |
|---|---|
| `kite.contract.delivered` | `evidenceRef`, `sellerDeliverySig`, `expiry` |
| `kite.contract.accepted` | `buyerAcceptanceSig`, `expiry` |
| `kite.contract.rejected` | `reasonCode`, `buyerRejectionSig`, `expiry` |
| `kite.contract.appealed` | `sellerAppealSig`, `expiry` |
| `kite.contract.refund_consented` | `sellerConsentSig`, `expiry` |
| `kite.contract.arbiter_decided` | `decisionId`, `sellerBps`, `arbiterSig`, `expiry` |

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

**This vocabulary is owned by the engine, not by this document.** The
`kite.contract.*` message types are defined in the Coordination Engine's code
(`fulfill-engine` `pkg/model/model.go`) — that is their source of truth, and
this catalog documents them as a reference; where the two diverge, the code is
right and this document has the defect. Each value names exactly one
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
3. resolve `signature.keyId` **as of the command's acceptance time** (§8),
   recover the signer address from `signature.sig`, and require it to equal
   the resolved secp256k1 key;
4. verify the actor is a participant and authorized for this `commandType`;
5. check `expectedRevision` against the deal's current revision;
6. apply the transition **atomically** with its Audit outbox write.

`commandId` is the **idempotency key**. Replaying it with identical immutable
bytes **MUST** return the original result; replaying it with different bytes
**MUST** be rejected as `idempotency_conflict` and audited.

`expectedRevision` provides optimistic concurrency. A stale value **MUST** be
rejected as `revision_conflict`, which is retriable after refetching state.

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
`auditReceiptRef`, and — present exactly when a party command drove the
transition — `commandId` and `commandHash`; Runtime-driven transitions
(chain observations, deadline expiries, auto-confirm, §5) carry neither,
and their receipt-identity/idempotency contract is a draft gap (§9.1).

**Receipt lifecycle is owned by the Audit plane.** The Runtime's own artifact
is its hash-chained, signed **transition-proof record**, committed atomically
with each accepted transition; the Audit plane builds and manages transition
receipts from that proof chain. A state-changing response therefore carries
the receipt when the Audit plane has produced it, and `receipt: null` while
it has not (the status object is always present) — a client that needs the
proof of a specific transition reads it from the receipt, never by inferring
it from a later status read. Retrieving a receipt produced *after* the reply
belongs to the Audit plane's disclosure operations
(`get-agreement-proof`), which are not yet specified — a draft gap (§9.1).
Until they land, `receipt: null` is final for that reply; `auditStatus`
travels only on the receipt, so it is simply absent while no receipt exists.
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

## 5. Command-to-event binding

Every accepted transition is recorded with the engine's **event** name — the
same vocabulary the transition-proof chain and the Audit log carry, so a
receipt consumer can mechanically match a wire command to its recorded event.
This mapping is **one-to-one**; the engine's code is its source of truth (§3).

Party-driven, via a signed AgreementCommand (or the two contract-carrying
interaction kinds):

| Interaction / `commandType` | Transition | Recorded event |
|---|---|---|
| proposal | ∅ → `PROPOSED` | — (pre-FSM; the proof chain starts at `COMMITTED`) |
| acceptance | `PROPOSED` → `COMMITTED` | — (workflow start) |
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

The decoded `raw` object carries a `kind`:

| `kind` | Purpose | Payload | Who |
|---|---|---|---|
| `proposal` | Submit final terms with the first signature | `{ contract }` | buyer |
| `acceptance` | Countersign the identical `termsHash` | `{ dealId, contract }` | seller |
| `command` | Submit a signed AgreementCommand | `{ command }` | the party the command type belongs to (§5) |
| `status` | Read current state and revision | `{ dealId }` | anyone |
| `funding` | Read the Activation to sign and which artifacts have arrived | signed envelope (§6.2.1) | either party |
| `funding-signatures` | Deliver this party's funding artifacts | signed envelope + `submission` | either party, own fields only |
| `evidence` | Register a delivery artifact against the agreement | signed envelope + `submission` | **seller only** |
| `proofs` | Read the transition-proof chain | signed envelope (§6.2.1) | either party |

#### 6.2.1 Party-scoped interactions

`funding`, `funding-signatures`, `evidence` and `proofs` are **party-only**.
Each carries a signed envelope; the Runtime **MUST** reject a request whose
signature does not verify, or whose actor is not a party to the named deal.

```json
{ "kind": "funding-signatures",
  "dealId": "…",
  "actorAgentId": "did:kite:…",
  "termsHash": "sha256:…",
  "submission": { "…": "…" },
  "signature": { "profile": "secp256k1-keccak-v1", "keyId": "did:kite:…#key-1", "sig": "0x…" } }
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
  `buyerWallet`, `buyerActivationSig` and `auth3009`; the seller **MAY** set
  `sellerActivationSig`. Any other combination **MUST** be rejected. The buyer
  wallet in particular is the address the Activation both parties sign is built
  around: a counterparty able to set it can make the deal unfundable after the
  buyer's funds are already committed.
- **Write-once.** Each funding artifact **MUST** be settable once. Re-sending
  the same value is a no-op (retries are normal); a *different* value **MUST
  NOT** replace the stored one, and the rejection **MUST** be visible to the
  parties — the `funding` read reports it.

`evidence` is the seller's alone. The Runtime **MUST** refuse a `delivered`
command whose `evidenceRef` was not registered against that same agreement, so
a buyer able to register evidence could manufacture the backing for the other
side's delivery claim.

### 6.3 Response

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

- state-changing interactions → `{ "kind": "agreement-result", "receipt": …,
  "status": … }` — receipt and status are **two distinct objects** (§4.3);
- `status` → `{ "kind": "agreement-status", "status": … }`;
- `funding` → `{ "kind": "agreement-funding", "funding": … }`;
- `funding-signatures` → `{ "kind": "agreement-funding-accepted", "status": … }`;
- `evidence` → `{ "kind": "agreement-evidence-recorded", "evidenceId": "…" }`;
- `proofs` → `{ "kind": "agreement-proofs", "proofs": [ … ] }`.

### 6.4 Synchrony

All interaction kinds are synchronous. The state-changing kinds
(`proposal`, `acceptance`, `command`) are validate → commit → reply; the read
kinds (`status`, `funding`, `proofs`) are validate → read → reply — they move
no state and produce no transition or receipt. `funding-signatures` and
`evidence` record an artifact without producing a transition of their own:
funding completes as a Runtime observation (§3) once the whole set has arrived. No
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
`kite.contract.*` message type (source of truth: the engine's
`pkg/model/model.go`, §4.2). **v1 defines exactly one notification**; other
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
request, `-32601` unknown method, `-32602` invalid params (including a missing
extension opt-in and every wire-validation failure), `-32603` internal.
`-32003` signals that the Runtime's engine is not reachable.

Domain rejections carry a code from `schemas/v1/error-catalog.json`. `retriable`
is normative: `false` means retrying the identical request cannot succeed.

| Code | Retriable |
|---|---|
| `invalid_command_schema`, `unsupported_extension_version`, `invalid_signature`, `unknown_key`, `unauthorized_actor`, `unknown_deal`, `terms_hash_mismatch`, `payload_hash_mismatch`, `idempotency_conflict`, `illegal_transition`, `deadline_exceeded`, `evidence_not_validated` | no |
| `revision_conflict`, `funding_not_final`, `rate_limited`, `internal_error` | yes |

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
exactly one key without a lookup. Resolving a `keyId` through Identity's public
resolve surface yields that specific secp256k1 key's on-chain EVM address (the
keccak256-derived address); verification recovers the signer from the
`secp256k1-keccak-v1` signature and **MUST** require the recovered address to
equal the address of the key the fragment names — not merely some active key of
the agent. The derivation is **frozen**: it names signed receipts, so changing
it would invalidate every stored reference. (The receipt schema constrains
`keyId` to this shape.)

**One secp256k1 key per agent, for everything Kite-native.** An agent's
runtime key — established when the agent runtime is bound — is the single key
that signs its L4 bind proof, its A2A formation and command signatures (this
profile), and its EscrowVault EIP-712 settlement signatures. (Session
proof-of-possession reuses it once the client stops minting a per-session key —
a planned, not-yet-shipped change; today the session key is separate.) There
is **no Ed25519 key** in the Kite-native path. Because both buyer and seller
pass through runtime binding, both always hold a signable secp256k1 key, and
the address it resolves to is exactly the party address the vault authorizes —
so formation identity and settlement identity are provably the same key.

> UCP (Unified Commerce Protocol) is **out of scope** for v1 and may never be
> offered. If a UCP Platform Profile is ever provided it requires EC **P-256**
> (a different curve), which would be a separate key decided at that time — not
> designed for here.

**Verification is against key validity AT COMMAND TIME**, not at verification
time. A later key rotation, revocation, or controller-epoch change **MUST NOT**
invalidate a receipt that was valid when accepted. Revocation status and
validity windows remain visible so a consumer can distinguish "was valid then"
from "is valid now".

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
6. **Error mappings** — each catalog code with its `retriable` value.
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

**Vectors — published.** `vectors/v1` carries 38 cases across four sets:
canonical bytes and hash derivation, signatures under every domain tag
(including the cross-tag rejections), per-`commandType` schema conformance with
both conflict shapes, and receipt signing. Fixture keys and the derived
thumbprints are in `vectors/v1/index.json`.

**Examples — the independent implementation.** `examples/` is written from this
document and the schemas, imports no Kite code, and replays every published
vector against its own signing module. It signs `secp256k1-keccak-v1`, speaks
§3's states and the `kite.contract.*` commands, and implements the §6.2.1 party
envelopes.

**Conformance suite — partially runnable.** `conformance/run.py` executes the
61 offline checks (bytes, hashes, signatures, schemas, receipts) with no Kite
dependency. The 29 state-machine, actor-binding and concurrency cases in
`conformance/transitions.json` are normative and complete, but they are
properties of a Runtime holding an agreement and cannot be checked against a
document; the live driver is not implemented in this release, and the runner
reports them as skipped rather than as passes.

### 9.2 v1 limitations

These are **not** work-in-progress notes: they are the boundaries of what v1
guarantees, and an implementer should design against them.

- **`keyId` fragment resolution is not enforced by the reference
  implementation.** §8 defines the canonical `<did>#jkt:<thumbprint>` form and
  the receipt schema constrains it, but the Kite runtime resolves only the DID
  and accepts a signature recovering to ANY active key of that agent. An agent
  with two active runtimes can therefore sign with either. The narrower
  guarantee v1 actually provides is: *the signer is an authorized key of the
  named agent.* Do not build a policy that depends on WHICH key signed.

- **Verification is against current key validity, not validity at command
  time.** §8 states the historical rule; implementations resolve the keys
  active now, so a signature made under a key that has since been revoked will
  not verify. Closing this needs per-key validity windows the identity model
  does not carry. Practical consequence: revoking a key invalidates the
  verifiability of that key's past signatures, so archive the receipts.

- **`auditStatus` is not signed evidence.** It sits outside the receipt
  preimage (§4.3) so a re-stamp does not invalidate a signature already handed
  out — which means anyone relaying a receipt can change `pending` to
  `recorded` and it still verifies. Durability is proven by the referenced
  Audit receipt, and v1 has no way to fetch one (below), so treat `recorded` as
  a hint.

- **Audit proof packages and `get-agreement-proof` are out of v1.** The Audit
  plane's disclosure model lands separately. This is also the only way to
  retrieve a receipt produced after a reply carried `receipt: null` (§4.3);
  until it lands, that null is final for that reply.

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
