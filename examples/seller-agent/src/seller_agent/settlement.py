"""EIP-712 settlement profile — a self-contained implementation of spec §4.4.

The coordination layer carries `agreementSig` and the payload `*Sig` members
as opaque strings, but an independent agent must PRODUCE them, and §4.4 makes
their construction normative: two domains, eight frozen struct type strings,
and a derivation rule for every field. This module implements exactly that —
from the published document, with the same generic crypto libraries the rest
of the example uses (coincurve for recoverable secp256k1, pycryptodome for
keccak-256), and no Kite code. `tests/test_settlement_vectors.py` replays the
published `vectors/v1/settlement` set against it, which is what makes this
file an implementation of the spec rather than of the Kite engine.

Chain parameters are deployment configuration. The defaults are the PUBLISHED
FIXTURE values the settlement vectors are minted with, so the demo's
signatures are verifiable against the vectors; a real deployment sets both.
"""

from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation

from coincurve import PrivateKey, PublicKey
from Crypto.Hash import keccak

CHAIN_ID = int(os.environ.get("KITE_CHAIN_ID", "2368"))
VAULT_ADDRESS = os.environ.get("KITE_VAULT_ADDRESS", "0x" + "ec" * 20)

# §4.4 struct type strings — verbatim, frozen.
AGREEMENT_TYPE = (
    "Agreement(bytes32 agreementId,bytes32 termsHash,uint256 amount,"
    "address buyerAgent,address sellerAgent)"
)
ACTIVATION_TYPE = (
    "Activation(bytes32 termsHash,address buyer,address buyerAgent,"
    "address sellerAgent,address sellerPayout,address arbiter,uint256 amount,"
    "uint64 fundingDeadline,uint64 deliveryWindow,uint64 deliveryConfirmationWindow,"
    "uint64 appealResponseWindow,uint64 arbitrationWindow)"
)
DELIVERY_TYPE = (
    "Delivery(bytes32 dealId,bytes32 termsHash,bytes32 deliveryHash,"
    "bytes32 receiptHash,uint64 nonce,uint64 expiry)"
)
ACCEPTANCE_TYPE = (
    "Acceptance(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,"
    "uint64 nonce,uint64 expiry)"
)
REJECTION_TYPE = (
    "Rejection(bytes32 dealId,bytes32 termsHash,bytes32 reasonHash,"
    "bytes32 receiptHash,uint64 nonce,uint64 expiry)"
)
APPEAL_TYPE = (
    "Appeal(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,"
    "uint64 nonce,uint64 expiry)"
)
REFUND_CONSENT_TYPE = (
    "RefundConsent(bytes32 dealId,bytes32 termsHash,bytes32 receiptHash,"
    "uint64 nonce,uint64 expiry)"
)
RESOLUTION_TYPE = (
    "Resolution(bytes32 dealId,bytes32 termsHash,bytes32 decisionId,"
    "uint16 sellerBps,bytes32 receiptHash,uint64 nonce,uint64 expiry)"
)

# A demo stand-in for §4.4's receiptHash anchor (the PRIOR transition-proof
# hash, read via `status`). With no Runtime there is no proof chain; the zero
# anchor keeps the construction real and the value visibly a placeholder.
ZERO_ANCHOR = "0x" + "00" * 32


def _keccak(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


# ── ABI words (every §4.4 field encodes as one 32-byte word) ─────────────────

def word_int(n: int) -> bytes:
    return int(n).to_bytes(32, "big")


def word_bytes32(ref: str) -> bytes:
    """A 32-byte value in either spelling the system mints: sha256:<hex> or
    0x<hex>. Exactly 32 bytes — nothing padded or truncated."""
    h = ref.removeprefix("sha256:").removeprefix("0x")
    if len(h) != 64:
        raise ValueError(f"not a 32-byte value: {ref}")
    return bytes.fromhex(h)


def word_addr(addr: str) -> bytes:
    return b"\x00" * 12 + bytes.fromhex(addr.removeprefix("0x"))


def bytes32_equal(a: str, b: str) -> bool:
    """Whether two 32-byte references name the SAME bytes, whatever their
    spelling. The system legitimately mints both forms — the coordination
    layer says `sha256:<hex>`, the chain-adjacent views say `0x<hex>` — and
    word_bytes32 already treats them as one value for SIGNING. Comparing the
    strings instead of the bytes rejects a value against itself: the engine's
    funding view spells the termsHash `0x…` while the accepted contract's
    anchor is `sha256:…`, and a literal comparison refuses every deal.
    Unparseable input is False, not an exception — callers are validating."""
    try:
        return word_bytes32(a) == word_bytes32(b)
    except (ValueError, TypeError):
        return False


# ── §4.4 field derivations ───────────────────────────────────────────────────

def usdc_base_units(amount: str) -> int:
    """`price.amount` ("25.00") as the uint256 the Agreement digest commits:
    USDC base units, 6 decimals. An unparseable or over-precise amount is an
    ERROR — a silent zero would verify a signature over the wrong amount.

    For the CONTRACT's decimal spelling only. The wire Activation's `amount`
    is already base units — see base_units below; running it through this
    conversion again multiplies it by 10^6 and every Activation signature
    breaks."""
    try:
        units = Decimal(amount) * (10**6)
    except InvalidOperation as exc:
        raise ValueError(f"not a decimal amount: {amount!r}") from exc
    if units != int(units) or units <= 0:
        raise ValueError(f"not a positive USDC amount at 6 decimals: {amount!r}")
    return int(units)


def base_units(amount: str) -> int:
    """The wire Activation's `amount`: ALREADY base units, a bare integer
    decimal string ("25000000" — activation.schema.json pins the ^[0-9]+$
    pattern, and the engine parses it with big.Int.SetString, no conversion).
    Distinct from usdc_base_units on purpose: the two `uint256 amount` fields
    have different SOURCES — the Agreement's comes from the contract's decimal
    price, the Activation's from the Runtime's already-converted view — and
    collapsing them is exactly the double-conversion this split prevents."""
    amount = amount.strip()
    if not amount.isdigit():
        raise ValueError(f"not a base-units integer string: {amount!r}")
    units = int(amount)
    if units <= 0:
        raise ValueError(f"not a positive base-units amount: {amount!r}")
    return units


def agreement_id32(deal_id: str) -> bytes:
    """bytes32 agreementId = keccak256(UTF-8 of the Runtime-assigned id)."""
    return _keccak(deal_id.encode())


def reason_hash(reason_code: str) -> str:
    """The vault's bytes32 reasonHash = keccak256(UTF-8 reasonCode) (§4.2)."""
    return "0x" + _keccak(reason_code.encode()).hex()


def decision_id32(decision_id: str) -> str:
    """The vault's bytes32 decisionId = keccak256(UTF-8 decisionId) (§4.2)."""
    return "0x" + _keccak(decision_id.encode()).hex()


def demo_deal_id32(deal_id: str) -> str:
    """DEMO ONLY. The real bytes32 dealId is EscrowVault.dealIdFor(Activation),
    READ BACK through the funding/status interactions (§4.4) — it cannot be
    derived without the Activation. With no Runtime to read from, the demo
    anchors its vault structs to keccak256 of the deal id string instead; the
    construction and verification around it are the real ones."""
    return "0x" + _keccak(deal_id.encode()).hex()


# ── domains ──────────────────────────────────────────────────────────────────

_DOMAIN_TYPE_WITH_CONTRACT = (
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)
_DOMAIN_TYPE_NO_CONTRACT = "EIP712Domain(string name,string version,uint256 chainId)"


def vault_domain(chain_id: int = CHAIN_ID, vault: str = VAULT_ADDRESS) -> bytes:
    """KiteEscrowVault/1 — the domain of every payload *Sig (vault calls)."""
    return _keccak(
        _keccak(_DOMAIN_TYPE_WITH_CONTRACT.encode())
        + _keccak(b"KiteEscrowVault") + _keccak(b"1")
        + word_int(chain_id) + word_addr(vault)
    )


def agreement_domain(chain_id: int = CHAIN_ID) -> bytes:
    """KiteFulfill/1 — the Agreement (accept gate) domain. NO verifyingContract:
    the accept gate is off-chain, so there is no contract address to bind."""
    return _keccak(
        _keccak(_DOMAIN_TYPE_NO_CONTRACT.encode())
        + _keccak(b"KiteFulfill") + _keccak(b"1")
        + word_int(chain_id)
    )


def struct_hash(type_string: str, *words: bytes) -> bytes:
    return _keccak(_keccak(type_string.encode()) + b"".join(words))


def typed_digest(domain: bytes, shash: bytes) -> bytes:
    """EIP-712: keccak256( 0x1901 ‖ domainSeparator ‖ structHash )."""
    return _keccak(b"\x19\x01" + domain + shash)


# ── signing and recovery over a 32-byte digest ──────────────────────────────

def sign_digest32(priv: PrivateKey, digest: bytes) -> str:
    """Recoverable secp256k1 over an EIP-712 digest, 0x r‖s‖v hex, v ∈ {27,28}.
    Same key and encoding as the coordination profile (§8: one agent key)."""
    raw = priv.sign_recoverable(digest, hasher=None)
    return "0x" + raw[:64].hex() + bytes([raw[64] + 27]).hex()


def recover_digest32(digest: bytes, sig_hex: str) -> str:
    body = bytes.fromhex(sig_hex.removeprefix("0x"))
    if len(body) != 65 or body[64] not in (27, 28):
        raise ValueError("settlement signature must be 65 bytes with v in {27,28}")
    pub = PublicKey.from_signature_and_message(
        body[:64] + bytes([body[64] - 27]), digest, hasher=None
    )
    return "0x" + _keccak(pub.format(compressed=False)[1:])[-20:].hex()


def verifies(digest: bytes, sig_hex: str, address: str) -> bool:
    try:
        return recover_digest32(digest, sig_hex).lower() == address.lower()
    except (ValueError, Exception):  # noqa: B014 - any decode failure is a rejection
        return False


# ── §4.4 digests, one per struct ─────────────────────────────────────────────

def agreement_digest(
    deal_id: str, terms_hash_ref: str, amount: str,
    buyer_address: str, seller_address: str, chain_id: int = CHAIN_ID,
) -> bytes:
    """The digest behind `agreementSig` (§4.1/§4.4). Exists only once the
    Runtime has assigned deal_id — which is WHY agreementSig is two-phase."""
    return typed_digest(
        agreement_domain(chain_id),
        struct_hash(
            AGREEMENT_TYPE,
            agreement_id32(deal_id),
            word_bytes32(terms_hash_ref),
            word_int(usdc_base_units(amount)),
            word_addr(buyer_address),
            word_addr(seller_address),
        ),
    )


def activation_digest(
    terms_hash_ref: str, buyer_wallet: str, buyer_agent: str, seller_agent: str,
    seller_payout: str, arbiter: str, amount: str, windows: dict[str, int],
    chain_id: int = CHAIN_ID, vault: str = VAULT_ADDRESS,
) -> bytes:
    """The digest behind BOTH funding artifacts (§6.2.1): buyerActivationSig
    and sellerActivationSig sign this same value, and the vault's fund()
    verifies the pair. EVERY member — including `amount` — is the value read
    back through the `funding` interaction, and the read-back amount is
    ALREADY base units ("25000000", not "25.00"): converting it again would
    sign a digest 10^6 too large, refused only at the vault."""
    return typed_digest(
        vault_domain(chain_id, vault),
        struct_hash(
            ACTIVATION_TYPE,
            word_bytes32(terms_hash_ref), word_addr(buyer_wallet),
            word_addr(buyer_agent), word_addr(seller_agent),
            word_addr(seller_payout), word_addr(arbiter),
            word_int(base_units(amount)),
            word_int(windows["fundingDeadline"]), word_int(windows["deliveryWindow"]),
            word_int(windows["deliveryConfirmationWindow"]),
            word_int(windows["appealResponseWindow"]), word_int(windows["arbitrationWindow"]),
        ),
    )


def delivery_digest(
    deal_id32: str, terms_hash_ref: str, delivery_hash_ref: str,
    receipt_hash: str = ZERO_ANCHOR, nonce: int = 0, expiry: int = 0,
    chain_id: int = CHAIN_ID, vault: str = VAULT_ADDRESS,
) -> bytes:
    return typed_digest(
        vault_domain(chain_id, vault),
        struct_hash(
            DELIVERY_TYPE,
            word_bytes32(deal_id32), word_bytes32(terms_hash_ref),
            word_bytes32(delivery_hash_ref), word_bytes32(receipt_hash),
            word_int(nonce), word_int(expiry),
        ),
    )


def acceptance_digest(
    deal_id32: str, terms_hash_ref: str,
    receipt_hash: str = ZERO_ANCHOR, nonce: int = 0, expiry: int = 0,
    chain_id: int = CHAIN_ID, vault: str = VAULT_ADDRESS,
) -> bytes:
    return typed_digest(
        vault_domain(chain_id, vault),
        struct_hash(
            ACCEPTANCE_TYPE,
            word_bytes32(deal_id32), word_bytes32(terms_hash_ref),
            word_bytes32(receipt_hash), word_int(nonce), word_int(expiry),
        ),
    )


def rejection_digest(
    deal_id32: str, terms_hash_ref: str, reason_code: str,
    receipt_hash: str = ZERO_ANCHOR, nonce: int = 0, expiry: int = 0,
    chain_id: int = CHAIN_ID, vault: str = VAULT_ADDRESS,
) -> bytes:
    return typed_digest(
        vault_domain(chain_id, vault),
        struct_hash(
            REJECTION_TYPE,
            word_bytes32(deal_id32), word_bytes32(terms_hash_ref),
            word_bytes32(reason_hash(reason_code)), word_bytes32(receipt_hash),
            word_int(nonce), word_int(expiry),
        ),
    )


def resolution_digest(
    deal_id32: str, terms_hash_ref: str, decision_id: str, seller_bps: int,
    receipt_hash: str = ZERO_ANCHOR, nonce: int = 0, expiry: int = 0,
    chain_id: int = CHAIN_ID, vault: str = VAULT_ADDRESS,
) -> bytes:
    return typed_digest(
        vault_domain(chain_id, vault),
        struct_hash(
            RESOLUTION_TYPE,
            word_bytes32(deal_id32), word_bytes32(terms_hash_ref),
            word_bytes32(decision_id32(decision_id)), word_int(seller_bps),
            word_bytes32(receipt_hash), word_int(nonce), word_int(expiry),
        ),
    )
