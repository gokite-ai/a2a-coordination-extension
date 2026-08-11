"""Replay vectors/v1/settlement against this example's settlement module.

The settlement profile (spec §4.4) is what makes agreementSig and the payload
*Sig members publicly implementable. These vectors pin every derivation —
domains, struct hashes, digests, and recoverable signatures — so a module
that reproduces them can settle, and one that cannot has diverged from the
vault regardless of what else it passes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from buyer_agent import settlement

VECTORS = Path(__file__).resolve().parents[3] / "vectors" / "v1" / "settlement"

TYPE_STRINGS = {
    "Agreement": settlement.AGREEMENT_TYPE,
    "Activation": settlement.ACTIVATION_TYPE,
    "Delivery": settlement.DELIVERY_TYPE,
    "Acceptance": settlement.ACCEPTANCE_TYPE,
    "Rejection": settlement.REJECTION_TYPE,
    "Appeal": settlement.APPEAL_TYPE,
    "RefundConsent": settlement.REFUND_CONSENT_TYPE,
    "Resolution": settlement.RESOLUTION_TYPE,
}


def _cases() -> list[Path]:
    assert VECTORS.is_dir(), f"settlement vectors not found at {VECTORS}"
    return sorted(p for p in VECTORS.iterdir() if p.is_dir())


def _field_word(name: str, struct: dict) -> bytes:
    """One ABI word per §4.4 — INCLUDING the normative derivations, so a
    module deriving differently fails here rather than at the vault."""
    if name == "agreementId":
        return settlement.agreement_id32(struct["agreementId"])
    if name == "amount":
        # Agreement vectors spell the contract's decimal price (and pin its
        # derivation via amountBaseUnits); Activation vectors spell the wire's
        # base-units integer. Each goes through the parser the live code uses
        # for that struct, so a double conversion fails here first.
        if "amountBaseUnits" in struct:
            return settlement.word_int(settlement.usdc_base_units(struct["amount"]))
        return settlement.word_int(settlement.base_units(struct["amount"]))
    if name == "reasonHash":
        return settlement.word_bytes32(settlement.reason_hash(struct["reasonCode"]))
    if name == "decisionId":
        return settlement.word_bytes32(settlement.decision_id32(struct["decisionId"]))
    value = struct[name]
    if isinstance(value, int):
        return settlement.word_int(value)
    if isinstance(value, str) and value.startswith("0x") and len(value) == 42:
        return settlement.word_addr(value)
    return settlement.word_bytes32(value)


@pytest.mark.parametrize("case", _cases(), ids=lambda p: p.name)
def test_settlement_vector(case: Path) -> None:
    inp = json.loads((case / "input.json").read_text())
    exp = json.loads((case / "expected.json").read_text())

    dom = inp["domain"]
    if "verifyingContract" in dom:
        domain = settlement.vault_domain(dom["chainId"], dom["verifyingContract"])
        assert dom["name"] == "KiteEscrowVault" and dom["version"] == "1"
    else:
        domain = settlement.agreement_domain(dom["chainId"])
        assert dom["name"] == "KiteFulfill" and dom["version"] == "1"

    type_string = inp["typeString"]
    type_name = type_string[: type_string.index("(")]
    assert TYPE_STRINGS[type_name] == type_string, "type string diverged from §4.4"

    fields = [f.split(" ")[1] for f in type_string[type_string.index("(") + 1 : -1].split(",")]
    shash = settlement.struct_hash(
        type_string, *(_field_word(f, inp["struct"]) for f in fields)
    )
    assert "0x" + shash.hex() == exp["structHash"]

    digest = settlement.typed_digest(domain, shash)
    assert "0x" + digest.hex() == exp["digest"]

    assert settlement.verifies(digest, inp["signature"], inp["claimedSigner"]) == exp["valid"]
    assert settlement.recover_digest32(digest, inp["signature"]).lower() == exp["recoveredAddress"].lower()
