"""Replay the bundle's golden vectors against this example's signing module.

This is the §9 release criterion doing its job. These agents are the
Extension's INDEPENDENT implementation — written from the spec and schemas,
importing no Kite code — so when they and the Kite runtime both pass the same
cases, the vectors are demonstrably the protocol rather than one codebase's
behaviour. A disagreement shows up here, not in a partner's integration.

Run: pytest (from public/examples/buyer-agent, with vectors/v1 alongside).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from coincurve import PrivateKey

from buyer_agent import signing

VECTORS = Path(__file__).resolve().parents[3] / "vectors" / "v1"

pytestmark = pytest.mark.skipif(
    not VECTORS.is_dir(), reason=f"vectors bundle not found at {VECTORS}"
)


def _index() -> dict:
    return json.loads((VECTORS / "index.json").read_text())


def _cases(set_name: str) -> list[Path]:
    dirs = sorted(p for p in (VECTORS / set_name).iterdir() if p.is_dir())
    assert dirs, f"no vectors under {set_name}/ — the bundle is missing or empty"
    return dirs


def _load(case: Path) -> tuple[dict, dict]:
    return (
        json.loads((case / "input.json").read_text()),
        json.loads((case / "expected.json").read_text()),
    )


def _ids(set_name: str) -> list[str]:
    return [p.name for p in _cases(set_name)]


# ── keys ─────────────────────────────────────────────────────────────────────

def test_fixture_keys_derive_the_published_addresses_and_thumbprints():
    """The address and the §8 thumbprint are both derived from the key. If this
    module derived either differently, every signature below could still verify
    while naming the wrong identity."""
    for role, k in _index()["keys"].items():
        priv = PrivateKey(bytes.fromhex(k["privateKey"][2:]))
        assert signing.evm_address(priv).lower() == k["address"].lower(), role
        assert signing.thumbprint(priv) == k["thumbprint"], role


# ── canonical/ ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("case", _cases("canonical"), ids=_ids("canonical"))
def test_canonical(case: Path):
    """Both the exact RFC 8785 bytes and the derived hash. Matching only the
    hash would let a differently-behaving canonicalizer pass by colliding on
    this one input."""
    obj, exp = _load(case)
    if exp["member"] == "termsHash":
        stripped = {k: v for k, v in obj.items() if k not in ("signatures", "termsHash")}
    else:
        stripped = {k: v for k, v in obj.items() if k != "signature"}

    canonical = signing.canonical_bytes(stripped)
    assert canonical.decode() == exp["canonical"]
    assert signing.sha256_ref(canonical) == exp["hash"]

    if exp["member"] == "termsHash":
        assert signing.terms_hash(obj) == exp["hash"]


# ── signing/ ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("case", _cases("signing"), ids=_ids("signing"))
def test_signing(case: Path):
    """Every domain tag, and — the part that matters — every rejection: cross-tag
    replay, wrong key, mutated body, and the three malformed encodings."""
    inp, exp = _load(case)
    tag = inp["domainTag"].encode()

    if "signedValue" in inp:
        body = inp["signedValue"].encode()
    else:
        unsigned = {k: v for k, v in inp["signedObject"].items() if k != "signature"}
        body = signing.canonical_bytes(unsigned)

    ok = signing.verify_signature(inp["signature"], tag + body, inp["claimedSigner"])
    assert ok is exp["valid"], (
        f"{case.name}: expected valid={exp['valid']}"
        + (f" (reason: {exp['reason']})" if not exp["valid"] else "")
    )

    if exp["valid"]:
        assert signing.recover_signer(inp["signature"], tag + body).lower() \
            == exp["recoveredAddress"].lower()


# ── commands/ ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("case", _cases("commands"), ids=_ids("commands"))
def test_commands(case: Path):
    """payloadHash derivation and the command signature. Schema validity itself
    is checked by the conformance suite against the published schema; what this
    asserts is that the two hashes an implementation must compute come out
    right."""
    inp, exp = _load(case)
    if not exp.get("schemaValid", False):
        return  # malformed by construction; nothing to sign or hash
    if "first" in inp:  # the conflict pairs
        bodies = [inp["first"], inp["second"]]
    else:
        bodies = [inp]

    for cmd in bodies:
        assert cmd["payloadHash"] == signing.sha256_ref(
            signing.canonical_bytes(cmd["payload"])
        ), "payloadHash must commit to the canonical payload"

        if exp.get("signatureValid"):
            # Authorize against the ACTOR's key, not against whatever the
            # signature happens to recover to.
            assert signing.verify_command_signature(
                cmd, _index()["keys"][exp["actorRole"]]["address"]
            )


# ── receipts/ ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("case", _cases("receipts"), ids=_ids("receipts"))
def test_receipts(case: Path):
    inp, exp = _load(case)
    # The PINNED Runtime key is the authorized address, and it is an input.
    # expected.recoveredAddress is what the signature actually recovers to — in
    # reject-signed-by-non-runtime that is a different key, and verifying
    # against it would authorize the very forgery the case exists to catch.
    runtime_addr = _index()["keys"]["runtime"]["address"]

    if "signedPreimage" in exp:
        preimage = signing.receipt_preimage(inp)
        assert preimage[len(signing.RECEIPT_DOMAIN_TAG):].decode() == exp["signedPreimage"]

    assert signing.verify_receipt(inp, runtime_addr) is exp["signatureValid"], (
        f"{case.name}: " + (exp.get("reason") or "")
    )

    if exp.get("reason") == "recovered_address_not_authorized":
        assert signing.recover_signer(
            inp["runtimeSignature"]["sig"], signing.receipt_preimage(inp)
        ).lower() == exp["recoveredAddress"].lower()
        assert exp["expectedRuntimeAddress"].lower() == runtime_addr.lower()


def test_audit_restamp_reuses_the_signature():
    """auditStatus is OUTSIDE the preimage, so re-stamping a receipt as durably
    appended keeps the same signature valid. That is the design — and exactly
    why auditStatus is not evidence: anyone relaying a receipt can set it."""
    original, _ = _load(VECTORS / "receipts" / "valid-command-driven")
    restamped, _ = _load(VECTORS / "receipts" / "audit-restamp-keeps-signature")

    assert original["runtimeSignature"]["sig"] == restamped["runtimeSignature"]["sig"]
    assert original["auditStatus"] != restamped["auditStatus"]
    runtime_addr = _index()["keys"]["runtime"]["address"]
    assert signing.verify_receipt(restamped, runtime_addr)
