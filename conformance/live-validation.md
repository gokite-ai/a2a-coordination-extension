# Live validation coverage

This document records the live interoperability evidence available for the
release candidate. It separates a successfully executed workflow from a full
conformance claim.

## Validated configurations

The accepted outcome path and one seller-consented refund path have completed
against a deployed Coordination Runtime:

| Configuration | Buyer | Seller | Purpose |
|---|---|---|---|
| Runtime interoperability | External test participant | External test participant | Exercises the accepted and seller-consented refund paths independently of the examples |
| Reference seller interoperability | External test participant | Deployed `examples/seller-agent` in live mode | Exercises the published seller implementation over the real A2A and Runtime boundaries |
| Data seller interoperability | Kite-managed test participant (`did:kite:corp-kite`; unique DID redacted) | Deployed `examples/data-seller-agent` | Exercises negotiation, query-derived terms, autonomous data delivery, evidence, acceptance, and settlement |

The external buyer participants in the first two configurations hold only an
agent runtime key and the credentials a real buyer is expected to hold. The
data-seller buyer was managed under Kite's own `did:kite:corp-kite` namespace;
its unique DID is redacted because it contains a tooling-specific label. That
run validates the published implementation across the A2A and Runtime
boundaries, but it is not evidence of organizationally independent
interoperability. The reference seller imports no Kite package; it uses the
official A2A SDK and the protocol definitions in this bundle.

The pre-publication E2E harness recorded the first two configurations as
successful on 2026-08-11 UTC: `a2a-e2e` run `31459150642` and
`a2a-example-seller-e2e` run `31458720296`.

A later `a2a-e2e` run, `31579604177`, recorded the seller-consented refund
path on 2026-08-12 UTC against Arc testnet (chain id `5042002`). Agreement
`04e22987-a64b-4de5-a45a-c1652d3d9308` progressed
`PROPOSED → COMMITTED → FULFILLING → DELIVERED → REJECTED → CANCELLED`.
The Runtime accepted the buyer's rejection and the seller's
`kite.contract.refund_consented` command, then appended
`SETTLEMENT_OBSERVED` for transaction
`0xbe0ceacd2146feda7d4ac2f3fcb5ad237ce61e8808b36c1dae7279beec21de51`.
The buyer wallet returned from 36,800,000 base units after funding to its
36,900,000 starting balance, and both buying and selling views rendered the
agreement as Cancelled / Refunded with a continuous proof chain.

The data-seller run completed on 2026-08-13 against Arc testnet (chain id
`5042002`). Agreement `732145b9-3abe-4e23-b8f5-bd4487e6a9f1` progressed
`PROPOSED → COMMITTED → FULFILLING → DELIVERED → ACCEPTED`; the buyer and
seller signed identical query-derived terms for four tracts, 100 rows, and
55.01 USDC. The Runtime recorded `FUND_CONFIRMED` proof 2 (transaction
`0xf890ec99…`, log 45), delivery evidence
`a9d80a99-9582-4745-868b-6179df27ad90`, and settlement to seller payout
`0xf47c…9389`.

## Observed workflow

| Step | Extension surface | Observed result |
|---|---|---|
| Discovery and identity | Agent Card, Extension activation, runtime-key binding | Runtime and seller cards were resolved; the seller's signing key matched its active DID binding |
| Formation | `proposal`, `acceptance`, `DealContract`, Agreement signatures | Both formation and Agreement signatures were accepted and the agreement reached `COMMITTED` |
| Funding | `funding`, `funding-signatures`, `expectedDealId` | Buyer and seller funding artifacts were accepted; escrow funding was observed and the agreement reached `FULFILLING` |
| Delivery | `evidence`, `kite.contract.delivered` | A Runtime-issued evidence id and current settlement anchors produced a committed delivery and `DELIVERED` |
| Autonomous seller work | `kite.contract.fulfill_started` notification | The deployed reference seller read state back, registered evidence, and delivered without a buyer follow-up request |
| Buyer acceptance | `kite.contract.accepted` | The buyer accepted delivery and the agreement reached `ACCEPTED` |
| Buyer rejection | `kite.contract.rejected`, `Rejection` settlement signature | The buyer rejected delivery and the agreement reached `REJECTED` |
| Seller refund consent | `kite.contract.refund_consented`, `RefundConsent` settlement signature | The seller consented to the refund and the agreement reached `CANCELLED` |
| Accepted settlement | Runtime chain observation | Seller payout was observed on chain and the proof chain appended `SETTLEMENT_OBSERVED` |
| Refund settlement | Runtime chain observation | Buyer balance restoration was observed on chain and the proof chain appended `SETTLEMENT_OBSERVED` |
| Replay behavior | stale revision, identical replay, divergent replay | The stale command was refused as `revision_conflict`; an identical replay returned the original result; a divergent replay was refused as `idempotency_conflict` |
| Audit read | `proofs` | Required events, actors, sequence order, and `previousProofHash` links were present through settlement |

This establishes that the published wire shapes and signing rules are
sufficient for the complete accepted outcome path and the seller-consented
refund path. The evidence includes real escrow, seller payout, buyer refund,
the deployed reference seller, and the data seller's negotiated artifact
flow.

## Not established by this validation

The live runs are not a replacement for `transitions.json`. They do not execute
every legal and illegal branch, and they do not by themselves constitute a
`CONFORMANCE PASS`. In particular, the following remain outside the observed
path:

- appeal, arbiter resolution, default, and expiry;
- every illegal transition and every unauthorized-actor rejection;
- `SETTLEMENT_OBSERVED` on terminal outcomes other than accepted payout and
  seller-consented refund;
- the mismatched `expectedDealId` refusal-before-broadcast case;
- recomputation and cryptographic verification of every live proof returned by
  the Runtime during those recorded runs.

The offline suite verifies the published proof-hash and signature profile
against golden vectors. New E2E runs can pass their decoded `agreement-proofs`
response to `run.py --proofs-file FILE` to verify the captured chain. A future
live driver must still stand up the required source state for every case in
`transitions.json`, execute the case against the target Runtime, and run with
`--strict` before the implementation can report full conformance.
