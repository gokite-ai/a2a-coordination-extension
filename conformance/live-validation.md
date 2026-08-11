# Live validation coverage

This document records the live interoperability evidence available for the
release candidate. It separates a successfully executed workflow from a full
conformance claim.

## Validated configurations

The accepted outcome path has completed against a deployed Coordination
Runtime in two configurations:

| Configuration | Buyer | Seller | Purpose |
|---|---|---|---|
| Runtime interoperability | External test participant | External test participant | Exercises the Runtime boundary independently of the examples |
| Reference seller interoperability | External test participant | Deployed `examples/seller-agent` in live mode | Exercises the published seller implementation over the real A2A and Runtime boundaries |

The external participant holds only an agent runtime key and the credentials a
real buyer is expected to hold. The reference seller imports no Kite package;
it uses the official A2A SDK and the protocol definitions in this bundle.

The pre-publication E2E harness recorded both configurations as successful on
2026-08-11 UTC: `a2a-e2e` run `31459150642` and
`a2a-example-seller-e2e` run `31458720296`.

## Observed workflow

| Step | Extension surface | Observed result |
|---|---|---|
| Discovery and identity | Agent Card, Extension activation, runtime-key binding | Runtime and seller cards were resolved; the seller's signing key matched its active DID binding |
| Formation | `proposal`, `acceptance`, `DealContract`, Agreement signatures | Both formation and Agreement signatures were accepted and the agreement reached `COMMITTED` |
| Funding | `funding`, `funding-signatures`, `expectedDealId` | Buyer and seller funding artifacts were accepted; escrow funding was observed and the agreement reached `FULFILLING` |
| Delivery | `evidence`, `kite.contract.delivered` | A Runtime-issued evidence id and current settlement anchors produced a committed delivery and `DELIVERED` |
| Autonomous seller work | `kite.contract.fulfill_started` notification | The deployed reference seller read state back, registered evidence, and delivered without a buyer follow-up request |
| Buyer decision | `kite.contract.accepted` | The buyer accepted delivery and the agreement reached `ACCEPTED` |
| Settlement | Runtime chain observation | Seller payout was observed on chain and the proof chain appended `SETTLEMENT_OBSERVED` |
| Replay behavior | stale revision, identical replay, divergent replay | The stale command was refused as `revision_conflict`; an identical replay returned the original result; a divergent replay was refused as `idempotency_conflict` |
| Audit read | `proofs` | Required events, actors, sequence order, and `previousProofHash` links were present through settlement |

This establishes that the published wire shapes and signing rules are
sufficient for the complete accepted outcome path, including real escrow and
the deployed reference seller.

## Not established by this validation

The live runs are not a replacement for `transitions.json`. They do not execute
every legal and illegal branch, and they do not by themselves constitute a
`CONFORMANCE PASS`. In particular, the following remain outside the observed
path:

- rejection, appeal, arbiter resolution, refund consent, default, and expiry;
- every illegal transition and every unauthorized-actor rejection;
- `SETTLEMENT_OBSERVED` on every terminal state;
- the mismatched `expectedDealId` refusal-before-broadcast case;
- recomputation and cryptographic verification of every live proof returned by
  the Runtime during those recorded runs.

The offline suite verifies the published proof-hash and signature profile
against golden vectors. New E2E runs can pass their decoded `agreement-proofs`
response to `run.py --proofs-file FILE` to verify the captured chain. A future
live driver must still stand up the required source state for every case in
`transitions.json`, execute the case against the target Runtime, and run with
`--strict` before the implementation can report full conformance.
