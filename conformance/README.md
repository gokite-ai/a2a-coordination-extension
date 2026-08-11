# Conformance suite

Declarative cases plus a small runner, driven entirely by `../schemas/v1` and
`../vectors/v1`. Passing them requires no Kite code.

```
pip install coincurve pycryptodome rfc8785 jsonschema
python3 run.py                       # offline sets; exits 0 (document check)
python3 run.py --proofs-file FILE    # validate a captured proof response
python3 run.py --strict              # exits non-zero while anything is skipped
python3 run.py --endpoint <url>      # reserved; fails until the live driver exists
python3 run.py --list                # every case that would run
```

## Two kinds of check, and why the difference matters

**Offline** — canonical bytes, hash derivation, signatures under every domain
tag, schema validity, and receipt verification. These are properties of
documents, so they run anywhere, against nothing. (The exact count grows
with the vector set — the runner prints it; hardcoding it here went stale
once already.)

**Live** — the state machine, actor binding, and concurrency semantics in
`transitions.json`. These are properties of a *Runtime holding an agreement*,
not of a document: there is no way to ask a JSON file whether it would reject
`kite.contract.delivered` from `REJECTED`. Driving them means standing an
agreement up in each `from` state, which needs formation, funding and delivery
against a real endpoint.

**The live driver is not implemented in this release.** `run.py` reports those
36 cases as SKIPPED and prints `NOT a conformance pass` — it never counts them
as successes. A suite that quietly passes what it did not run tells you that
you conform when it has checked nothing, which is worse than having no suite.
Supplying `--endpoint` also fails explicitly today; the option reserves the
driver boundary and must not be read as implemented functionality.

The complete accepted outcome path has separately completed against a live
Runtime in both an external-participant configuration and a configuration
using the deployed reference seller. That is valuable interoperability
evidence, but it exercises one path rather than the complete transition
matrix. [`live-validation.md`](live-validation.md) records exactly what was
and was not established.

## Validating a captured proof chain

`--proofs-file` accepts the decoded JSON returned by the `proofs` interaction:

```json
{ "kind": "agreement-proofs", "proofs": [ ... ] }
```

For convenience, the vector form `{ "proofs": [ ... ] }` is also accepted. The
runner checks every link against the schema, orders the chain by `sequence`,
requires one agreement and a contiguous chain beginning at 1, verifies state
and proof-hash linkage, recomputes every present state hash and every
`proofHash`, and recovers every Runtime signature to its declared `signedBy`
address.

This validates captured evidence only. It does not execute a Runtime transition,
so the live transition cases remain skipped and the result is not a full
conformance pass.

**Use `--strict` for any release that claims full conformance.** A plain run
exits 0 even with cases skipped, which is deliberate — it is useful as an
offline document check — but it means a CI job reading only the exit status
sees green and a reader concludes the implementation conforms. `--strict`
exits non-zero until every case has actually been checked, so a full-conformance
gate cannot be passed by a run that skipped the state machine. The initial
prototype release makes the narrower claim recorded in `live-validation.md`.

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
- `fundingDealIdentity` — the Runtime must refuse to broadcast `fund()` unless
  the settlement layer derives exactly the `expectedDealId` the authorization
  named (§6.2.1). Live because it is a property of a Runtime holding a funded
  activation, not of a document; a schema cannot tell whether the two
  derivations agree.

Error codes are those of `../schemas/v1/error-catalog.json`.
