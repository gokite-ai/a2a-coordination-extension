# A2A Kite Coordination Extension

**Status: release candidate — not yet `v1.0.0`.**

The wire contract is settled and pins against A2A **1.0**. The identifiers on
this page and every signed preimage are fixed; the schemas, vectors and example
agents are aligned to them. The complete accepted outcome path has executed
against a live Runtime, including the deployed reference seller, escrow,
autonomous delivery, settlement, and the proof-chain read. Full conformance is
still open because the suite does not yet drive every state-machine case in
`conformance/transitions.json`. See
[`spec/v1/coordination-workflow.md` §9.1–9.2](spec/v1/coordination-workflow.md)
and [`conformance/live-validation.md`](conformance/live-validation.md) for the
precise boundary.

This repository is the published normative bundle for the
**A2A Kite Coordination Extension**, identified by:

```
https://a2a.gokite.ai/extensions/coordination-workflow/v1
```

The Extension lets buyer and seller agents form and execute a binding
agreement through the Kite Coordination Engine using the standard
[A2A protocol](https://github.com/a2aproject/A2A) extension mechanism —
typed, signed workflow commands; two-signature agreement over one
`termsHash`; runtime-signed transition receipts; and party-readable
transition-proof chains. (Independently verifiable audit proof packages are
a later addition — spec §9.2.) No fork of A2A, and no Kite SDK required:
conformance is defined by wire behavior and cryptographic verification
against the schemas and test vectors in this bundle.

## Bundle layout

| Path | Contents |
|---|---|
| `spec/v1/` | The normative specification |
| `schemas/v1/` | JSON Schemas. Signed objects: `DealContract`, `AgreementCommand`, `FundingSubmission`. Runtime artifacts: `AgreementTransitionProof`, `AgreementTransitionReceipt`. Interaction surface: `InteractionRequest`, `InteractionResponse`, `PartyEnvelope`, `AgreementStatus`, `FundingContext`, `Activation`, `EvidenceSubmission`, including party-readable `evidence-list`. Errors: `AgreementDomainError` + the error catalog. Discovery: `AgentCardExtensionParams` |
| `vectors/v1/` | 95 golden vectors: canonical bytes and hashes, signatures under every domain tag (including the cross-tag rejections), per-`commandType` schema cases, role-scoped funding-submission cases (§6.2.1), the transition-proof chain the `proofs` interaction serves (§6.3), receipt signing, the domain-error payloads and their catalog retry semantics, and the §4.4 EIP-712 settlement profile |
| `conformance/` | Language-neutral conformance suite, no Kite dependency. `python3 conformance/run.py` replays the offline checks and exits 0 — a **document** check, not a conformance signal. `--strict` exits non-zero while any case is skipped. The live driver is not implemented; supplying `--endpoint` fails explicitly instead of claiming a pass. `live-validation.md` records the narrower live interoperability evidence |
| `examples/` | Three non-normative example agents with no Kite code: a Python buyer and seller on `a2a-sdk` 1.x, plus a TypeScript data seller on `@a2a-js/sdk` 1.x. They use A2A **1.0** (JSON-RPC, `raw` Parts, `A2A-Extensions`) and real §4.4 settlement signatures. Both sellers support live Runtime execution and have completed the accepted outcome path in deployment |
| `site/` | The landing page, also served at the repo root and at the extension URI itself |
| `LICENSE` | Apache License 2.0 — covers everything in this bundle |

The extension URI and each schema `$id` are live paths, not just names:
`/extensions/coordination-workflow/v1/` serves the landing page and
`/schemas/deal-contract/v1` serves that schema.

## Checking yourself against this bundle

```
pip install coincurve pycryptodome rfc8785 jsonschema
python3 conformance/run.py
```

Nothing in that command is Kite software. A passing default run proves that an
implementation reproduces the published document-level bytes and schemas; it
is not a full conformance signal while live cases are skipped. Use `--strict`
for a release gate.

## Versioning

Backward-compatible additions may land within `v1`. Published `v1` files are
append-only. Breaking changes get a new URI (`.../coordination-workflow/v2`).

## License

[Apache License 2.0](LICENSE), for everything here — the specification, the
schemas, the vectors, the conformance suite and the example agents.

The point of a permissive licence on a protocol bundle is that an independent
implementation can copy from it: vendor the schemas, embed the vectors in your
own test suite, lift the example agents' signing code. That is the intended
use, not a tolerated one. The patent grant is why Apache-2.0 rather than MIT —
implementing a protocol means implementing whatever it reads on, and a bare
copyright licence leaves that unaddressed.

## Feedback

Implementer feedback is welcome as **issues** on this repository
(ambiguities in the spec, schemas that don't validate real traffic, test
vectors that can't be reproduced). Pull requests are not merged here
directly — development happens internally, and accepted changes ship with
the next release. This repository's history is release commits only.
