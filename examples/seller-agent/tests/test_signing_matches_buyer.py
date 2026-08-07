"""The two examples duplicate signing.py on purpose — this catches drift.

Each agent is self-contained so it can be read or copied alone, which means
the module exists twice. Duplication that silently diverges is worse than no
duplication at all: the two agents would still interoperate on every case
anyone tried, right up to the one where they disagree. Only the cross-reference
comment naming the other agent is allowed to differ.

The protocol behaviour itself is checked in buyer-agent/tests/test_vectors.py,
which replays the published vectors/v1 against this same code.
"""

from __future__ import annotations

from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[2]
SELLER = EXAMPLES / "seller-agent" / "src" / "seller_agent" / "signing.py"
BUYER = EXAMPLES / "buyer-agent" / "src" / "buyer_agent" / "signing.py"


def _normalized(path: Path) -> list[str]:
    return [
        line for line in path.read_text().splitlines()
        if "on purpose: each example stays" not in line
        and "Duplicated verbatim in" not in line
    ]


def test_signing_modules_are_identical():
    assert BUYER.is_file() and SELLER.is_file()
    buyer, seller = _normalized(BUYER), _normalized(SELLER)
    assert buyer == seller, (
        "buyer-agent and seller-agent signing.py have diverged; they must stay "
        "byte-identical apart from the comment naming the other agent"
    )
