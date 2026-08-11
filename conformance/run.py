#!/usr/bin/env python3
"""Conformance runner for the A2A Kite Coordination Extension.

Replays the published cases against an implementation. Two kinds of check:

  OFFLINE  — canonical bytes, hashes, signatures, receipts, and schema
             validity, driven entirely by ../vectors/v1 and ../schemas/v1.
             These need no endpoint and no Kite code, so anyone can run them.

  LIVE     — the state machine, actor binding, and concurrency semantics from
             transitions.json. These cannot be checked offline: they are
             properties of a Runtime holding an agreement, not of a document.
             Without --endpoint they are REPORTED AS SKIPPED, never as passed.

That last point is the design. A suite that quietly counts unrunnable cases as
successes tells you that you conform when it has checked nothing.

    python3 run.py                        # offline sets
    python3 run.py --proofs-file FILE     # validate a captured proof response
    python3 run.py --endpoint URL         # reserved; fails until live driver exists
    python3 run.py --list                 # what would run

Dependencies: `pip install coincurve pycryptodome rfc8785 jsonschema` — the
same ordinary libraries the examples use. No Kite package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VECTORS = HERE.parent / "vectors" / "v1"
SCHEMAS = HERE.parent / "schemas" / "v1"

try:
    import rfc8785
    from Crypto.Hash import keccak
    from coincurve import PublicKey
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError as exc:  # pragma: no cover - environment guidance
    sys.exit(
        f"missing dependency: {exc.name}\n"
        "install: pip install coincurve pycryptodome rfc8785 jsonschema"
    )


# ── primitives under test ────────────────────────────────────────────────────

def keccak256(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def sha256_ref(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def recover(signature: str, preimage: bytes) -> str:
    """The profile admits exactly ONE spelling: 0x-prefixed, 65 bytes,
    v ∈ {27,28}. Anything else raises — a runner that repaired these would
    pass implementations that disagree about which signatures are valid."""
    if not signature.startswith("0x"):
        raise ValueError("sig must be 0x-prefixed")
    body = bytes.fromhex(signature[2:])
    if len(body) != 65:
        raise ValueError(f"sig must be 65 bytes, got {len(body)}")
    if body[64] not in (27, 28):
        raise ValueError(f"wire recovery id must be 27 or 28, got {body[64]}")
    pub = PublicKey.from_signature_and_message(
        body[:64] + bytes([body[64] - 27]), keccak256(preimage), hasher=None
    )
    return "0x" + keccak256(pub.format(compressed=False)[1:]).hex()[-40:]


def verifies(signature: str, preimage: bytes, address: str) -> bool:
    try:
        return recover(signature, preimage).lower() == address.lower()
    except (ValueError, Exception):  # noqa: B014 - any decode failure is a rejection
        return False


# ── results ──────────────────────────────────────────────────────────────────

class Report:
    def __init__(self) -> None:
        self.passed: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self.skipped: list[tuple[str, str]] = []

    def ok(self, name: str) -> None:
        self.passed.append(name)

    def fail(self, name: str, why: str) -> None:
        self.failed.append((name, why))

    def skip(self, name: str, why: str) -> None:
        self.skipped.append((name, why))

    def check(self, name: str, condition: bool, why: str = "") -> None:
        self.ok(name) if condition else self.fail(name, why)

    def summary(self, strict: bool = False) -> int:
        for name, why in self.failed:
            print(f"  FAIL  {name}\n        {why}")
        for name, why in self.skipped:
            print(f"  SKIP  {name} — {why}")
        print(
            f"\n{len(self.passed)} passed, {len(self.failed)} failed, "
            f"{len(self.skipped)} skipped"
        )
        if self.failed:
            return 1
        if not self.skipped:
            print("CONFORMANCE PASS: every case was checked.")
            return 0
        # Exit code, not just a printed sentence. A run with skipped cases used
        # to exit 0, so a CI job that only reads the status saw "green" and a
        # reader concluded the implementation was conformant — the exact
        # misreading §9 exists to prevent. --strict makes the release gate
        # honest; without it the run stays usable as an offline document check.
        print("NOT a conformance pass: skipped cases were not checked.")
        if strict:
            print(
                "--strict: exiting non-zero. The live driver is not implemented; "
                "--endpoint currently fails explicitly rather than skipping."
            )
            return 2
        print(
            "(exit 0 because --strict was not set: this run validated documents "
            "only. Do NOT read it as a conformance signal.)"
        )
        return 0


# The Runtime's proof-attestation domain tag (§6.3.1). Distinct from every
# party tag, so an attestation can never be replayed as a party signature.
PROOF_TAG = b"kite:fulfill:transition-proof:v1"


def _wf(s: str) -> bytes:
    """One length-prefixed field of the §6.3.1 preimage: byte length as a
    decimal string, ':', then the UTF-8 bytes. The prefix is what stops two
    different field sets from colliding on one preimage."""
    b = s.encode("utf-8")
    return f"{len(b)}:".encode("ascii") + b


def state_hash(agreement_id: str, state: str, sequence: int) -> str:
    h = hashlib.sha256()
    for f in (agreement_id, state, str(sequence)):
        h.update(_wf(f))
    return "sha256:" + h.hexdigest()


def proof_hash(p: dict) -> str:
    """The §6.3.1 proofHash preimage. Field ORDER is frozen, metadata keys are
    sorted bytewise, and createdAt is RFC3339Nano in UTC — a consumer that
    re-renders the timestamp or iterates the map in its own order computes a
    different digest over identical content."""
    h = hashlib.sha256()
    for f in (p["agreementId"], str(p["sequence"]), p.get("fromState", ""),
              p["toState"], p["event"], p.get("previousStateHash", ""),
              p.get("nextStateHash", ""), p.get("previousProofHash", ""),
              p.get("actorId", ""), p.get("authorityRef", ""),
              p.get("commandId", ""), p.get("commandHash", "")):
        h.update(_wf(f))
    meta = p.get("metadata") or {}
    keys = sorted(meta, key=lambda k: k.encode("utf-8"))
    h.update(_wf(str(len(keys))))
    for k in keys:
        h.update(_wf(k))
        h.update(_wf(meta[k]))
    refs = p.get("evidenceRefs") or []
    h.update(_wf(str(len(refs))))
    for r in refs:
        h.update(_wf(r))
    h.update(_wf(p["createdAt"]))
    return "sha256:" + h.hexdigest()


def _cases(set_name: str) -> list[Path]:
    # Dot-directories are never vector cases. Editors, tooling and virtualenvs
    # drop them next to real ones, and treating such a directory as a case made
    # the runner die on a missing input.json — a crash that reads like a broken
    # vector set rather than unrelated litter in the tree.
    d = VECTORS / set_name
    if not d.is_dir():
        return []
    return sorted(p for p in d.iterdir() if p.is_dir() and not p.name.startswith("."))


def _load(case: Path) -> tuple[dict, dict]:
    return (
        json.loads((case / "input.json").read_text()),
        json.loads((case / "expected.json").read_text()),
    )


# ── offline sets ─────────────────────────────────────────────────────────────

def run_canonical(rep: Report) -> None:
    for case in _cases("canonical"):
        obj, exp = _load(case)
        drop = ("signatures", "termsHash") if exp["member"] == "termsHash" else ("signature",)
        stripped = {k: v for k, v in obj.items() if k not in drop}
        canonical = rfc8785.dumps(stripped)
        name = f"canonical/{case.name}"
        # Both, deliberately: matching only the hash would let a
        # differently-behaving canonicalizer pass by colliding on this input.
        rep.check(f"{name} [bytes]", canonical.decode() == exp["canonical"],
                  f"got {canonical.decode()[:120]}…")
        rep.check(f"{name} [{exp['member']}]", sha256_ref(canonical) == exp["hash"],
                  f"got {sha256_ref(canonical)}")


def run_signing(rep: Report) -> None:
    for case in _cases("signing"):
        inp, exp = _load(case)
        tag = inp["domainTag"].encode()
        if "signedValue" in inp:
            body = inp["signedValue"].encode()
        else:
            unsigned = {k: v for k, v in inp["signedObject"].items() if k != "signature"}
            body = rfc8785.dumps(unsigned)
        got = verifies(inp["signature"], tag + body, inp["claimedSigner"])
        rep.check(
            f"signing/{case.name}", got == exp["valid"],
            f"expected valid={exp['valid']}"
            + (f" (reason: {exp['reason']})" if not exp["valid"] else ""),
        )


def run_commands(rep: Report) -> None:
    validator = Draft202012Validator(
        json.loads((SCHEMAS / "agreement-command.schema.json").read_text())
    )
    index = json.loads((VECTORS / "index.json").read_text())
    for case in _cases("commands"):
        inp, exp = _load(case)
        name = f"commands/{case.name}"
        bodies = [inp["first"], inp["second"]] if "first" in inp else [inp]

        for body in bodies:
            valid = validator.is_valid(body)
            rep.check(f"{name} [schema]", valid == exp["schemaValid"],
                      f"schema said valid={valid}, expected {exp['schemaValid']}")
            if not exp["schemaValid"]:
                continue
            rep.check(
                f"{name} [payloadHash]",
                body["payloadHash"] == sha256_ref(rfc8785.dumps(body["payload"])),
                "payloadHash must commit to the canonical payload",
            )
            if exp.get("signatureValid"):
                addr = index["keys"][exp["actorRole"]]["address"]
                unsigned = {k: v for k, v in body.items() if k != "signature"}
                preimage = b"kite:a2a-agreement:command:v1" + rfc8785.dumps(unsigned)
                rep.check(f"{name} [signature]",
                          verifies(body["signature"]["sig"], preimage, addr),
                          "command signature did not recover to the actor's key")
            # §4.2 settlement-anchor derivations: the two string-valued payload
            # members that reach the chain do so as keccak256 of their UTF-8
            # bytes. An implementation deriving differently signs (or relays)
            # vault calls that never verify.
            for member, anchor in (("reasonCode", "reasonHash"),
                                   ("decisionId", "decisionId32")):
                if anchor in exp.get("settlement", {}):
                    got = "0x" + keccak256(body["payload"][member].encode()).hex()
                    rep.check(f"{name} [settlement.{anchor}]",
                              got == exp["settlement"][anchor],
                              f"keccak256({member}) = {got}, vector expects "
                              f"{exp['settlement'][anchor]}")


def run_receipts(rep: Report) -> None:
    validator = Draft202012Validator(
        json.loads((SCHEMAS / "transition-receipt.schema.json").read_text())
    )
    index = json.loads((VECTORS / "index.json").read_text())
    signed_fields = index["receiptSignedFields"]
    runtime_addr = index["keys"]["runtime"]["address"]

    for case in _cases("receipts"):
        inp, exp = _load(case)
        name = f"receipts/{case.name}"
        # The preimage is built from an ALLOWLIST, not by deleting the
        # signature: a member added to the schema later must not silently
        # enter what was signed.
        signed = {f: inp[f] for f in signed_fields if inp.get(f) is not None}
        preimage = b"kite:a2a-agreement:receipt:v1" + rfc8785.dumps(signed)
        if "signedPreimage" in exp:
            rep.check(f"{name} [preimage]",
                      rfc8785.dumps(signed).decode() == exp["signedPreimage"],
                      "receipt preimage differs")
        if exp.get("signatureValid") is not None and validator.is_valid(inp):
            sig = inp.get("runtimeSignature")
            got = bool(sig) and verifies(sig["sig"], preimage, runtime_addr)
            rep.check(f"{name} [signature]", got == exp["signatureValid"],
                      f"expected signatureValid={exp['signatureValid']}"
                      + (f" ({exp['reason']})" if exp.get("reason") else ""))


def _w_int(n: int) -> bytes:
    return int(n).to_bytes(32, "big")


def _w_b32(s: str) -> bytes:
    h = s.removeprefix("sha256:").removeprefix("0x")
    if len(h) != 64:
        raise ValueError(f"not 32 bytes: {s}")
    return bytes.fromhex(h)


def _w_addr(a: str) -> bytes:
    return b"\x00" * 12 + bytes.fromhex(a.removeprefix("0x"))


def _settlement_field(name: str, struct: dict) -> bytes:
    """One ABI word per §4.4, INCLUDING the normative derivations — the vector
    carries the source strings, so a runner that derives differently fails."""
    if name == "agreementId":
        return keccak256(struct["agreementId"].encode())
    if name == "amount":
        # Two sources for one word (§4.4): the Agreement's amount derives from
        # the contract's decimal price — its vector carries the decimal plus
        # the derived base units to pin that derivation — while the
        # Activation's amount IS the wire's base-units integer, spelled in the
        # struct exactly as the funding read returns it.
        if "amountBaseUnits" in struct:
            return _w_int(int(struct["amountBaseUnits"]))
        return _w_int(int(struct["amount"]))
    if name == "reasonHash":
        return keccak256(struct["reasonCode"].encode())
    if name == "decisionId":
        return keccak256(struct["decisionId"].encode())
    v = struct[name]
    if isinstance(v, int):
        return _w_int(v)
    if isinstance(v, str) and v.startswith("0x") and len(v) == 42:
        return _w_addr(v)
    return _w_b32(v)


def run_settlement(rep: Report) -> None:
    for case in _cases("settlement"):
        inp, exp = _load(case)
        name = f"settlement/{case.name}"
        dom = inp["domain"]
        if "verifyingContract" in dom:
            domain = keccak256(
                keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
                + keccak256(dom["name"].encode()) + keccak256(dom["version"].encode())
                + _w_int(dom["chainId"]) + _w_addr(dom["verifyingContract"]))
        else:
            domain = keccak256(
                keccak256(b"EIP712Domain(string name,string version,uint256 chainId)")
                + keccak256(dom["name"].encode()) + keccak256(dom["version"].encode())
                + _w_int(dom["chainId"]))
        type_string = inp["typeString"]
        fields = [f.split(" ")[1] for f in
                  type_string[type_string.index("(") + 1:-1].split(",")]
        struct_hash = keccak256(keccak256(type_string.encode())
                                + b"".join(_settlement_field(f, inp["struct"]) for f in fields))
        rep.check(f"{name} [structHash]", "0x" + struct_hash.hex() == exp["structHash"],
                  f"got 0x{struct_hash.hex()}")
        preimage = b"\x19\x01" + domain + struct_hash
        rep.check(f"{name} [digest]", "0x" + keccak256(preimage).hex() == exp["digest"],
                  f"got 0x{keccak256(preimage).hex()}")
        rep.check(f"{name} [signature]",
                  verifies(inp["signature"], preimage, inp["claimedSigner"]) == exp["valid"],
                  "settlement signature did not recover to the claimed signer")


# ── live sets ────────────────────────────────────────────────────────────────

def run_transitions(rep: Report, endpoint: str | None) -> None:
    spec = json.loads((HERE / "transitions.json").read_text())
    groups = {
        "legal": len(spec["legal"]),
        # One entry per SETTLEMENT_OBSERVED-eligible terminal state: the
        # selfLoops list groups them under a single `states` array.
        "selfLoops": sum(len(e["states"]) for e in spec["selfLoops"]),
        "illegal": len(spec["illegal"]),
        "actorBinding": len(spec["actorBinding"]),
        "concurrency": len(spec["concurrency"]),
    }
    if endpoint is None:
        for group, count in groups.items():
            rep.skip(f"transitions/{group} ({count} cases)",
                     "needs --endpoint: these are properties of a Runtime holding "
                     "an agreement, not of a document")
        return
    # Driving these requires standing an agreement up in each `from` state,
    # which means formation, funding and delivery against a real Runtime.
    # Claiming a pass without doing that would be worse than not running —
    # and an --endpoint run that silently exits 0 with everything skipped
    # claims exactly that, so it FAILS instead (the caller asked for a live
    # run this release cannot perform).
    for group, count in groups.items():
        rep.fail(f"transitions/{group} ({count} cases)",
                 f"endpoint {endpoint} given, but the live driver is not implemented "
                 "in this release — see conformance/README.md")


def run_proofs(rep: Report) -> None:
    """The `proofs` interaction's array elements (§6.2.1, §6.3). This payload is
    load-bearing: `receiptHash` in every settlement signature (§4.4) is the PRIOR
    link's `proofHash`, so a consumer that reads absent members signs nothing and
    only finds out at the vault. The spec pins camelCase for exactly that reason
    — reject-snake-case-spelling is a Runtime leaking its storage spelling.

    Beyond the schema, the valid case asserts what a consumer must be able to
    derive from the payload alone: the sequence order, the hash-chain linkage,
    and which proofHash the next command quotes."""
    validator = Draft202012Validator(
        json.loads((SCHEMAS / "transition-proof.schema.json").read_text())
    )
    for case in _cases("proofs"):
        inp, exp = _load(case)
        # A valid case carries the whole reply's array; a reject carries one link.
        links = inp["proofs"] if isinstance(inp, dict) and "proofs" in inp else [inp]
        valid = all(validator.is_valid(link) for link in links)
        rep.check(f"proofs/{case.name} [schema]", valid == exp["schemaValid"],
                  f"schema said valid={valid}, expected {exp['schemaValid']}")
        if not exp["schemaValid"]:
            continue

        ordered = sorted(links, key=lambda p: p["sequence"])
        rep.check(f"proofs/{case.name} [order]",
                  [p["sequence"] for p in ordered] == exp["orderedBySequence"],
                  "sequence order does not match the expected chain")
        # previousProofHash == the proofHash at sequence - 1, absent on the first.
        linked = "previousProofHash" not in ordered[0] and all(
            later.get("previousProofHash") == earlier["proofHash"]
            for earlier, later in zip(ordered, ordered[1:])
        )
        rep.check(f"proofs/{case.name} [chain]", linked == exp["chainLinked"],
                  "the hash chain does not link as expected")
        rep.check(f"proofs/{case.name} [receiptHash]",
                  ordered[-1]["proofHash"] == exp["receiptHashForNextCommand"],
                  "the newest proofHash is not the anchor the next command must quote")

        # Recompute the §6.3.1 preimage. Chain linkage only proves the links
        # were served consistently WITH EACH OTHER; recomputation is what
        # proves a link's content is the content the Runtime attested. Without
        # it a Runtime could serve any payload it liked as long as the hashes
        # pointed at one another.
        if exp.get("proofHashesRecomputable"):
            rep.check(f"proofs/{case.name} [proofHash-preimage]",
                      all(proof_hash(p) == p["proofHash"] for p in ordered),
                      "a proofHash does not match the §6.3.1 preimage recomputed "
                      "from the link's own members")
        if exp.get("signaturesVerify"):
            ok = all(
                verifies(p["signature"],
                         PROOF_TAG + p["proofHash"].encode(),
                         p["signedBy"])
                for p in ordered
            )
            rep.check(f"proofs/{case.name} [signature]", ok,
                      "a Runtime proof signature does not recover to signedBy")
            rep.check(f"proofs/{case.name} [signedBy]",
                      all(p["signedBy"].lower() == exp["signedBy"].lower()
                          for p in ordered),
                      "signedBy is not the expected Runtime address — note it is "
                      "an EVM address, not a DID or keyId")


def run_proof_capture(rep: Report, path: Path) -> None:
    """Validate a decoded `agreement-proofs` response captured from a Runtime.

    This is deliberately separate from the live transition driver. It verifies
    evidence already returned by a Runtime; it does not create source states or
    exercise any transition and therefore cannot turn skipped behavioral cases
    into conformance successes.
    """
    prefix = "capture/proofs"
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        rep.fail(f"{prefix} [payload]", f"cannot read {path}: {exc}")
        return

    if not isinstance(payload, dict) or not isinstance(payload.get("proofs"), list):
        rep.fail(
            f"{prefix} [payload]",
            "expected a decoded agreement-proofs object with a proofs array",
        )
        return

    if "kind" in payload:
        rep.check(
            f"{prefix} [envelope]",
            payload["kind"] == "agreement-proofs"
            and set(payload) == {"kind", "proofs"},
            "expected exactly kind=agreement-proofs and proofs in the response",
        )

    links = payload["proofs"]
    if not links:
        rep.fail(f"{prefix} [payload]", "proofs must contain at least one link")
        return
    rep.ok(f"{prefix} [payload]")

    validator = Draft202012Validator(
        json.loads((SCHEMAS / "transition-proof.schema.json").read_text()),
        format_checker=FormatChecker(),
    )
    errors = [
        f"proofs[{i}]: {error.message}"
        for i, link in enumerate(links)
        for error in validator.iter_errors(link)
    ]
    rep.check(f"{prefix} [schema]", not errors, errors[0] if errors else "")
    if errors:
        return

    ordered = sorted(links, key=lambda p: p["sequence"])
    sequences = [p["sequence"] for p in ordered]
    rep.check(
        f"{prefix} [sequence]",
        sequences == list(range(1, len(ordered) + 1)),
        f"expected a contiguous chain beginning at 1, got {sequences}",
    )

    agreement_ids = {p["agreementId"] for p in ordered}
    rep.check(
        f"{prefix} [agreement]",
        len(agreement_ids) == 1,
        f"proofs span multiple agreements: {sorted(agreement_ids)}",
    )

    states_link = all(
        later.get("fromState") == earlier["toState"]
        for earlier, later in zip(ordered, ordered[1:])
    )
    rep.check(
        f"{prefix} [state-chain]",
        states_link,
        "a proof's fromState does not match the preceding proof's toState",
    )

    hashes_link = "previousProofHash" not in ordered[0] and all(
        later.get("previousProofHash") == earlier["proofHash"]
        for earlier, later in zip(ordered, ordered[1:])
    )
    rep.check(
        f"{prefix} [hash-chain]",
        hashes_link,
        "the first link has previousProofHash or a later link does not point to its predecessor",
    )

    rep.check(
        f"{prefix} [proofHash]",
        all(proof_hash(p) == p["proofHash"] for p in ordered),
        "a proofHash does not match the §6.3.1 preimage recomputed from its link",
    )

    state_hashes_valid = all(
        (
            "previousStateHash" not in p
            or (
                bool(p.get("fromState"))
                and p["previousStateHash"]
                == state_hash(
                    p["agreementId"], p["fromState"], p["sequence"] - 1
                )
            )
        )
        and (
            "nextStateHash" not in p
            or p["nextStateHash"]
            == state_hash(p["agreementId"], p["toState"], p["sequence"])
        )
        for p in ordered
    )
    rep.check(
        f"{prefix} [stateHash]",
        state_hashes_valid,
        "a previousStateHash or nextStateHash does not match its state tuple",
    )

    signatures_valid = all(
        bool(p.get("signature") and p.get("signedBy"))
        and verifies(
            p["signature"],
            PROOF_TAG + p["proofHash"].encode(),
            p["signedBy"],
        )
        for p in ordered
    )
    rep.check(
        f"{prefix} [signature]",
        signatures_valid,
        "a proof is unsigned or its Runtime signature does not recover to signedBy",
    )


def run_errors(rep: Report) -> None:
    """The domain-error payload a Runtime puts in JSON-RPC `error.data` (§7).

    Two independent checks, because the schema alone cannot catch the failure
    that actually hurts. The schema pins the shape and enumerates the codes. The
    catalog cross-check pins the SEMANTICS: `retriable` is normative and must
    agree with error-catalog.json, so a Runtime cannot ship a payload that is
    structurally perfect and tells the client to retry something that can never
    succeed. That is what reject-retriable-contradicts-catalog encodes — a case
    the schema passes and this check must fail."""
    validator = Draft202012Validator(
        json.loads((SCHEMAS / "domain-error.schema.json").read_text())
    )
    catalog = {
        e["code"]: e["retriable"]
        for e in json.loads((SCHEMAS / "error-catalog.json").read_text())["errors"]
    }
    for case in _cases("errors"):
        inp, exp = _load(case)
        valid = validator.is_valid(inp)
        rep.check(f"errors/{case.name} [schema]", valid == exp["schemaValid"],
                  f"schema said valid={valid}, expected {exp['schemaValid']}")
        if not valid:
            continue
        # The catalog is the authority on retry semantics; the wire value is a
        # copy carried for clients that have not vendored it. A copy that
        # disagrees with its source is the whole reason this check exists.
        rep.check(f"errors/{case.name} [catalog]",
                  catalog[inp["code"]] == exp["retriable"],
                  f"catalog says retriable={catalog[inp['code']]} for "
                  f"{inp['code']}, case expects {exp['retriable']}")
        rep.check(f"errors/{case.name} [wire-matches-catalog]",
                  (inp["retriable"] == exp["retriable"]) == exp["wireMatchesCatalog"],
                  f"payload carries retriable={inp['retriable']} for {inp['code']}; "
                  f"catalog says {exp['retriable']}, and the case expects this "
                  f"comparison to be {exp['wireMatchesCatalog']}")


def run_funding_live(rep: Report, endpoint: str | None) -> None:
    """§6.2.1 deal-identity binding — a behavioral security rule, not a schema
    one: the Runtime MUST NOT broadcast fund() when the buyer's expectedDealId
    does not equal the vault's dealIdFor(Activation). No error code is asserted
    (the requirement is that it refuse before broadcast, however surfaced).
    Needs a live Runtime, so offline it is reported as skipped — never passed."""
    spec = json.loads((HERE / "transitions.json").read_text())
    cases = spec["fundingDealIdentity"]["cases"]
    if endpoint is None:
        rep.skip(f"funding/dealIdentity ({len(cases)} cases)",
                 "needs --endpoint: refuse-before-broadcast is a property of a live "
                 "Runtime deriving dealIdFor, not of a document")
        return
    rep.fail(f"funding/dealIdentity ({len(cases)} cases)",
             f"endpoint {endpoint} given, but the live driver is not implemented "
             "in this release — see conformance/README.md")


def run_funding(rep: Report) -> None:
    """The funding-signatures `submission` object (§6.2.1). Role binding is only
    meaningful once the enclosing actorAgentId is resolved to a party, so each
    vector carries its resolved `role` and is validated against that role's
    sub-schema ($defs/buyerSubmission or $defs/sellerSubmission) — the same split
    the Runtime's authorizeFundingSubmission(role, sub) enforces. The
    deal-identity equality (expectedDealId == dealIdFor) is a behavioral
    pre-broadcast rule, not a schema one — it is covered by run_funding_live."""
    schema = json.loads((SCHEMAS / "funding-submission.schema.json").read_text())
    defs = schema["$defs"]
    role_validator = {
        role: Draft202012Validator({**defs[f"{role}Submission"], "$defs": defs})
        for role in ("buyer", "seller")
    }
    for case in _cases("funding"):
        inp, exp = _load(case)
        role = exp["role"]
        valid = role_validator[role].is_valid(inp)
        rep.check(f"funding/{case.name} [schema:{role}]", valid == exp["schemaValid"],
                  f"as a {role} submission, schema said valid={valid}, expected {exp['schemaValid']}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--endpoint",
        help="reserved live Runtime endpoint; supplying it fails until the live driver exists",
    )
    ap.add_argument(
        "--proofs-file",
        type=Path,
        help="decoded agreement-proofs response to validate as a captured proof chain",
    )
    ap.add_argument("--list", action="store_true", help="list cases and exit")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero if any case was skipped. Use this as the release "
             "gate: without it a document-only run exits 0 and reads as a pass.",
    )
    args = ap.parse_args()

    if not VECTORS.is_dir():
        sys.exit(f"vectors not found at {VECTORS}")

    if args.list:
        for s in ("canonical", "signing", "commands", "funding", "proofs", "receipts", "settlement", "errors"):
            for c in _cases(s):
                print(f"{s}/{c.name}")
        spec = json.loads((HERE / "transitions.json").read_text())
        for group in ("legal", "illegal", "actorBinding", "concurrency"):
            print(f"transitions/{group} ({len(spec[group])} cases)")
        print(f"funding/dealIdentity ({len(spec['fundingDealIdentity']['cases'])} cases)")
        return 0

    rep = Report()
    run_canonical(rep)
    run_signing(rep)
    run_commands(rep)
    run_funding(rep)
    run_proofs(rep)
    if args.proofs_file:
        run_proof_capture(rep, args.proofs_file)
    run_receipts(rep)
    run_settlement(rep)
    run_errors(rep)
    run_transitions(rep, args.endpoint)
    run_funding_live(rep, args.endpoint)
    return rep.summary(strict=args.strict)


if __name__ == "__main__":
    sys.exit(main())
