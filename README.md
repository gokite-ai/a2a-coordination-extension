# A2A Kite Coordination Extension

**Status: release candidate — not yet `v1.0.0`.**

The wire contract is settled and pins against A2A **1.0**. The identifiers on
this page and every signed preimage are fixed; the schemas, vectors and example
agents are aligned to them. One release criterion is still open: §9 requires an
independent implementation to execute *every* workflow step against a Runtime,
and the conformance suite's state-machine cases have no live driver yet. See
[`spec/v1/coordination-workflow.md` §9.1–9.2](spec/v1/coordination-workflow.md)
for the release state and the v1 limitations an implementer should design
against.

This repository is the published normative bundle for the
**A2A Kite Coordination Extension**, identified by:

```
https://a2a.gokite.ai/extensions/coordination-workflow/v1
```

The Extension lets buyer and seller agents form and execute a binding
agreement through the Kite Coordination Engine using the standard
[A2A protocol](https://github.com/a2aproject/A2A) extension mechanism —
typed, signed workflow commands; two-signature agreement over one
`termsHash`; runtime-signed transition receipts; and independently
verifiable audit proof packages. No fork of A2A, and no Kite SDK required:
conformance is defined by wire behavior and cryptographic verification
against the schemas and test vectors in this bundle.

## Bundle layout

| Path | Contents |
|---|---|
| `spec/v1/` | The normative specification |
| `schemas/v1/` | JSON Schemas: `DealContract`, `AgreementCommand`, `AgreementTransitionReceipt`, error catalog |
| `vectors/v1/` | 38 golden vectors: canonical bytes and hashes, signatures under every domain tag (including the cross-tag rejections), per-`commandType` schema cases, receipt signing |
| `conformance/` | Language-neutral conformance suite. `python3 conformance/run.py` replays 61 offline checks with no Kite dependency; the state-machine cases need a live Runtime and are reported as skipped |
| `examples/` | Non-normative example agents (buyer + seller), built on the official A2A SDK with no Kite code. They replay the vectors above, which is what makes those the protocol rather than one implementation's behaviour |
| `site/` | The landing page, also served at the repo root and at the extension URI itself |

The extension URI and each schema `$id` are live paths, not just names:
`/extensions/coordination-workflow/v1/` serves the landing page and
`/schemas/deal-contract/v1` serves that schema.

## Checking yourself against this bundle

```
pip install coincurve pycryptodome rfc8785 jsonschema
python3 conformance/run.py
```

Nothing in that command is Kite software. If it passes and your agent produces
the same bytes as `vectors/v1/`, you speak this protocol.

## Versioning

Backward-compatible additions may land within `v1`. Published `v1` files are
append-only. Breaking changes get a new URI (`.../coordination-workflow/v2`).

## Feedback

Implementer feedback is welcome as **issues** on this repository
(ambiguities in the spec, schemas that don't validate real traffic, test
vectors that can't be reproduced). Pull requests are not merged here
directly — development happens internally, and accepted changes ship with
the next release. This repository's history is release commits only.
