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
| `signing/` | `secp256k1-keccak-v1` signatures (recoverable secp256k1 ECDSA over `keccak256(tag ‖ bytes)`, 65-byte `r‖s‖v` with wire `v` ∈ {27,28}) covering **both** domain tags: `kite:a2a-agreement:terms:v1` (DealContract) and `kite:a2a-agreement:command:v1` (AgreementCommand). Fixed test keys; valid signatures with the expected recovered address; invalid cases (wrong key, wrong tag, mutated body, bare-hex, `v ∉ {27,28}`) that MUST fail; and a **cross-tag** case proving a terms signature MUST NOT verify as a command signature and vice versa |
| `commands/` | Schema-valid and schema-invalid command fixtures per `commandType`, including idempotency-conflict and revision-conflict pairs |
| `receipts/` | Transition-receipt signing + verification over the `kite:a2a-agreement:receipt:v1` preimage (§4) against a pinned test Runtime key, the canonical `keyId` (`<did>#jkt:…`) resolving to that key, and the transition-receipt vs. audit-receipt distinction. Lands now that the receipt preimage is defined (§4/§4.3) |

## Signing cases

`claimedSigner` is an **input**: verification always asks "does this signature
recover to the address the named agent is authorized under?", so the address
goes in, never comes out. `expected.recoveredAddress` records what it actually
recovers to — in `reject-wrong-key` that is a different address, and the
difference is the rejection. Rejection cases also carry a `reason` so a runner
can check an implementation failed for the right cause rather than by accident.

Test keys used here are throwaway fixtures generated for the vectors —
never real Kite, agent, or user keys. They are published deliberately.
