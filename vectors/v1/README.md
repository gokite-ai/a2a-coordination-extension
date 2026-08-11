# Golden test vectors — v1

Each case is a directory holding `input.json` and `expected.json`;
`index.json` enumerates them and carries the fixture keys and domain tags.

These are the protocol's shared truth, not one implementation's output: the
Kite reference runtime (Go) and this bundle's `examples/` (Python) both
replay them, so a disagreement surfaces as a failing case rather than as an
interop bug found by a partner. A rule that lived only in SDK code would not
be checkable this way — which is why §9 makes passing them a release
criterion.

**Reproducing the bytes matters as much as the hashes.** `canonical/` asserts
the exact RFC 8785 output, because an implementation that matches only the
digest may be canonicalizing differently and colliding on that one input.

Sets:

| Set | Proves |
|---|---|
| `canonical/` | RFC 8785 canonical bytes for `DealContract` and `AgreementCommand` fixtures — byte-exact output, plus the derived `termsHash` / `payloadHash` |
| `signing/` | `secp256k1-keccak-v1` signatures (recoverable secp256k1 ECDSA over `keccak256(tag ‖ bytes)`, 65-byte `r‖s‖v` with wire `v` ∈ {27,28}) covering the domain tags `kite:a2a-agreement:terms:v1` (DealContract), `kite:a2a-agreement:command:v1` (AgreementCommand) and `kite:a2a-agreement:funding:v1` (the §6.2.1 party envelope). Fixed test keys; valid signatures with the expected recovered address; invalid cases (wrong key, wrong tag, mutated body, bare-hex, `v ∉ {27,28}`) that MUST fail; and a **cross-tag** case proving a signature under one tag MUST NOT verify under another |
| `commands/` | Schema-valid and schema-invalid command fixtures per `commandType`, including idempotency-conflict and revision-conflict pairs |
| `funding/` | The §6.2.1 funding-signatures `submission` object, validated per the **resolved role**: `valid` buyer/seller submissions, and `reject` cases for cross-role artifacts (a buyer carrying a seller sig, a seller carrying `expectedDealId`/`buyerWallet`), a malformed (camelCase) `auth3009`, `auth3009` without its `expectedDealId`, and a malformed `expectedDealId`. Each carries `role`; a runner validates against `$defs/buyerSubmission` or `$defs/sellerSubmission` |
| `proofs/` | The `proofs` interaction's array elements (§6.3): a three-link chain whose first link has no `fromState`/`previousProofHash`, each later link quotes its predecessor, and the newest `proofHash` is the `receiptHash` the next settlement signature must quote. Rejects for a Runtime leaking a snake_case spelling (the regression that broke every consumer silently), a missing or malformed `proofHash`, and `sequence` 0 |
| `settlement/` | §4.4 EIP-712 settlement profile: struct hashes, digests and signatures for the vault structs (Activation/Delivery/Acceptance) under the `KiteFulfill` / `KiteEscrowVault` domains |
| `receipts/` | Transition-receipt signing + verification over the `kite:a2a-agreement:receipt:v1` preimage (§4) against a pinned test Runtime key, the canonical `keyId` (`<did>#jkt:…`) resolving to that key, and the transition-receipt vs. audit-receipt distinction. Lands now that the receipt preimage is defined (§4/§4.3) |
| `errors/` | The §7 `AgreementDomainError` payload a Runtime puts in JSON-RPC `error.data` under `-32010`. One `valid-<code>` case for **every** code in `error-catalog.json`, each carrying that code's catalog `retriable` value and the context members it is actionable with (`currentRevision`, `currentState`, `retryAfterSeconds`, …). Rejects for an uncatalogued code and a missing `retriable`, plus the case no schema can catch: a structurally perfect payload whose `retriable` **contradicts** the catalog, which a runner must fail on the catalog cross-check |

## Signing cases

`claimedSigner` is an **input**: verification always asks "does this signature
recover to the address the named agent is authorized under?", so the address
goes in, never comes out. `expected.recoveredAddress` records what it actually
recovers to — in `reject-wrong-key` that is a different address, and the
difference is the rejection. Rejection cases also carry a `reason` so a runner
can check an implementation failed for the right cause rather than by accident.

Test keys used here are throwaway fixtures generated for the vectors —
never real Kite, agent, or user keys. They are published deliberately.
