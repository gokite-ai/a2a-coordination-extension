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
    python3 run.py --endpoint URL         # offline + live (not yet implemented)
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
    from jsonschema import Draft202012Validator
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

    def summary(self) -> int:
        for name, why in self.failed:
            print(f"  FAIL  {name}\n        {why}")
        for name, why in self.skipped:
            print(f"  SKIP  {name} — {why}")
        print(
            f"\n{len(self.passed)} passed, {len(self.failed)} failed, "
            f"{len(self.skipped)} skipped"
        )
        if self.skipped and not self.failed:
            print("NOT a conformance pass: skipped cases were not checked.")
        return 1 if self.failed else 0


def _cases(set_name: str) -> list[Path]:
    d = VECTORS / set_name
    return sorted(p for p in d.iterdir() if p.is_dir()) if d.is_dir() else []


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


# ── live sets ────────────────────────────────────────────────────────────────

def run_transitions(rep: Report, endpoint: str | None) -> None:
    spec = json.loads((HERE / "transitions.json").read_text())
    groups = {
        "legal": len(spec["legal"]),
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
    # Claiming a pass without doing that would be worse than not running.
    for group, count in groups.items():
        rep.skip(f"transitions/{group} ({count} cases)",
                 f"endpoint {endpoint} given, but the live driver is not implemented "
                 "in this release — see conformance/README.md")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--endpoint", help="a live Runtime's A2A endpoint")
    ap.add_argument("--list", action="store_true", help="list cases and exit")
    args = ap.parse_args()

    if not VECTORS.is_dir():
        sys.exit(f"vectors not found at {VECTORS}")

    if args.list:
        for s in ("canonical", "signing", "commands", "receipts"):
            for c in _cases(s):
                print(f"{s}/{c.name}")
        spec = json.loads((HERE / "transitions.json").read_text())
        for group in ("legal", "illegal", "actorBinding", "concurrency"):
            print(f"transitions/{group} ({len(spec[group])} cases)")
        return 0

    rep = Report()
    run_canonical(rep)
    run_signing(rep)
    run_commands(rep)
    run_receipts(rep)
    run_transitions(rep, args.endpoint)
    return rep.summary()


if __name__ == "__main__":
    sys.exit(main())
