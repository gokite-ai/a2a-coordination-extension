# Conformance suite

Declarative cases plus a small runner, driven entirely by `../schemas/v1` and
`../vectors/v1`. Passing them requires no Kite code.

```
pip install coincurve pycryptodome rfc8785 jsonschema
python3 run.py            # offline sets
python3 run.py --list     # every case that would run
```

## Two kinds of check, and why the difference matters

**Offline** — canonical bytes, hash derivation, signatures under every domain
tag, schema validity, and receipt verification. These are properties of
documents, so they run anywhere, against nothing. 61 checks.

**Live** — the state machine, actor binding, and concurrency semantics in
`transitions.json`. These are properties of a *Runtime holding an agreement*,
not of a document: there is no way to ask a JSON file whether it would reject
`kite.contract.delivered` from `REJECTED`. Driving them means standing an
agreement up in each `from` state, which needs formation, funding and delivery
against a real endpoint.

**The live driver is not implemented in this release.** `run.py` reports those
29 cases as SKIPPED and prints `NOT a conformance pass` — it never counts them
as successes. A suite that quietly passes what it did not run tells you that
you conform when it has checked nothing, which is worse than having no suite.

The cases themselves are still normative and still useful: they are the
complete edge list an implementer must satisfy, in a form a Runtime's own test
harness can consume directly. The Kite runtime does exactly that.

## What `transitions.json` carries

- `legal` — every edge in spec §3's `fixed_outcome/v1` table, tagged with its
  driver (party command / runtime observation / deadline expiry). The
  distinction is part of the contract: no party can command `FUND_CONFIRMED`.
- `selfLoops` — `SETTLEMENT_OBSERVED` on each terminal state, because money
  settles on chain *after* the agreement state is final.
- `illegal` — commands that MUST be rejected as `illegal_transition`, including
  the two an implementer coming from an earlier draft is most likely to get
  wrong: there is **no resubmission edge** from `REJECTED`, and terminal states
  accept no party command.
- `actorBinding` — which party may issue each command type. The vault enforces
  the same split on chain, but by then the transition is already committed, so
  an unauthorized command the vault will later refuse still leaves a false
  actor in the audit trail.
- `concurrency` — stale `expectedRevision`, identical replay (returns the
  original result, applies once), and divergent replay (`idempotency_conflict`).
  Both replay bodies are schema-valid, which is exactly why a schema-only
  implementation gets them wrong.

Error codes are those of `../schemas/v1/error-catalog.json`.
