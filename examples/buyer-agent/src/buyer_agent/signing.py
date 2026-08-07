"""secp256k1-keccak-v1 signing helpers (spec §4).

Four signed families, each under its own domain-separation tag so a signature
over one can never be replayed as another (§4's tag table):

- terms    §4.1  tag ‖ termsHash                                  (the STRING)
- command  §4.2  tag ‖ rfc8785(command without "signature")
- receipt  §4.3  tag ‖ rfc8785(the nine signed receipt members)
- funding  §6.2.1 tag ‖ rfc8785(envelope without "signature")

Duplicated verbatim in seller-agent/ on purpose: each example stays
self-contained so it can be read or copied alone. Test keys only — never load
a production key into an example agent.

No Kite dependency: `coincurve` is libsecp256k1, `pycryptodome` is keccak, and
`rfc8785` is JCS. The bundle's `vectors/v1` are what prove this file agrees
with every other implementation — `test_vectors.py` replays them.
"""

from __future__ import annotations

import hashlib
from typing import Any

import rfc8785
from Crypto.Hash import keccak
from coincurve import PrivateKey, PublicKey

TERMS_DOMAIN_TAG = b"kite:a2a-agreement:terms:v1"
COMMAND_DOMAIN_TAG = b"kite:a2a-agreement:command:v1"
RECEIPT_DOMAIN_TAG = b"kite:a2a-agreement:receipt:v1"
FUNDING_DOMAIN_TAG = b"kite:a2a-agreement:funding:v1"

SIGNATURE_PROFILE = "secp256k1-keccak-v1"

# §4.3 — the receipt's signed members, in the spec's order. An allowlist, not a
# "delete runtimeSignature": a member added to the schema later must not
# silently enter the signature. The Audit-owned auditStatus / auditReceiptRef
# are excluded so a re-stamp does not invalidate a signature already handed
# out, which is also why they are NOT signed evidence (§4.3).
RECEIPT_SIGNED_FIELDS = (
    "schema", "receiptId", "dealId", "commandId", "commandHash",
    "fromState", "toState", "revision", "recordedAt",
)


def keccak256(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def canonical_bytes(obj: dict[str, Any]) -> bytes:
    """RFC 8785 (JCS) canonical serialization."""
    return rfc8785.dumps(obj)


def sha256_ref(data: bytes) -> str:
    """Hash reference in the bundle's `sha256:<hex>` spelling."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def evm_address(key: PrivateKey | PublicKey) -> str:
    """The key's on-chain EVM address — the identity a signature recovers to,
    and the same one the EscrowVault authorizes for that party (§4)."""
    pub = key.public_key if isinstance(key, PrivateKey) else key
    uncompressed = pub.format(compressed=False)  # 0x04 ‖ X ‖ Y
    return "0x" + keccak256(uncompressed[1:]).hex()[-40:]


def thumbprint(key: PrivateKey | PublicKey) -> str:
    """§8 canonical key fragment — FROZEN, because it names signed receipts:

        jkt: || first 16 lowercase-hex of
                hex(sha256("secp256k1:" ‖ 33-byte compressed public key))

    The ASCII prefix is concatenated with the RAW key bytes, not an encoding of
    them. Self-verifying: it names exactly one key without a lookup.
    """
    pub = key.public_key if isinstance(key, PrivateKey) else key
    digest = hashlib.sha256(b"secp256k1:" + pub.format(compressed=True)).hexdigest()
    return "jkt:" + digest[:16]


def key_id(agent_did: str, key: PrivateKey | PublicKey) -> str:
    return f"{agent_did}#{thumbprint(key)}"


def sign_digest(private_key: PrivateKey, preimage: bytes) -> str:
    """Recoverable secp256k1 over keccak256(preimage) → 0x r‖s‖v, wire v ∈ {27,28}.

    coincurve emits the raw 0/1 recovery id; the wire form is 27/28. The
    vectors carry a rejection case for the raw id precisely so this conversion
    is not skipped somewhere and silently accepted on the other side.
    """
    raw = private_key.sign_recoverable(keccak256(preimage), hasher=None)
    return "0x" + (raw[:64] + bytes([raw[64] + 27])).hex()


def recover_signer(signature: str, preimage: bytes) -> str:
    """Recover the EVM address that produced `signature` over `preimage`.

    Raises ValueError on any encoding the profile does not admit. There is
    exactly ONE accepted spelling — 0x-prefixed, 65 bytes, v ∈ {27,28} — so a
    bare-hex or legacy-recovery-id signature is refused rather than repaired;
    quietly normalizing either would make two implementations disagree about
    which signatures are valid.
    """
    if not signature.startswith("0x"):
        raise ValueError("sig must be a 0x-prefixed 65-byte r‖s‖v hex string")
    body = bytes.fromhex(signature[2:])
    if len(body) != 65:
        raise ValueError(f"sig must be 65 bytes, got {len(body)}")
    v = body[64]
    if v not in (27, 28):
        raise ValueError(f"recovery id must be 27 or 28 on the wire, got {v}")
    recovered = PublicKey.from_signature_and_message(
        body[:64] + bytes([v - 27]), keccak256(preimage), hasher=None
    )
    return evm_address(recovered)


def verify_signature(signature: str, preimage: bytes, expected_address: str) -> bool:
    """True when `signature` recovers to `expected_address`.

    The address is an INPUT: the question is always "did the key this agent is
    authorized under sign this?", never "who signed this?". A verifier that
    recovers an address and then trusts it has authenticated nobody.
    """
    try:
        return recover_signer(signature, preimage).lower() == expected_address.lower()
    except ValueError:
        return False


# ── the four families ────────────────────────────────────────────────────────

def terms_hash(contract: dict[str, Any]) -> str:
    """termsHash = sha256 over the canonical contract with `signatures` and any
    declared `termsHash` removed. The declared value is never trusted: a
    contract that could name its own anchor could name someone else's."""
    unsigned = {k: v for k, v in contract.items() if k not in ("signatures", "termsHash")}
    return sha256_ref(canonical_bytes(unsigned))


def terms_preimage(terms_hash_ref: str) -> bytes:
    """NOTE: the tag is concatenated with the hash STRING (`sha256:<hex>`), not
    with the 32 raw bytes it denotes."""
    return TERMS_DOMAIN_TAG + terms_hash_ref.encode()


def sign_terms(terms_hash_ref: str, priv: PrivateKey, signer_agent_id: str) -> dict[str, Any]:
    """One DealContract signature entry (§4.1): the first entry is the
    proposal, a second over the IDENTICAL hash is the acceptance."""
    return {
        "signerAgentId": signer_agent_id,
        "profile": SIGNATURE_PROFILE,
        "keyId": key_id(signer_agent_id, priv),
        "sig": sign_digest(priv, terms_preimage(terms_hash_ref)),
    }


def verify_terms_signature(terms_hash_ref: str, entry: dict[str, Any], signer_address: str) -> bool:
    if entry.get("profile") != SIGNATURE_PROFILE:
        return False
    return verify_signature(entry["sig"], terms_preimage(terms_hash_ref), signer_address)


def command_preimage(command: dict[str, Any]) -> bytes:
    unsigned = {k: v for k, v in command.items() if k != "signature"}
    return COMMAND_DOMAIN_TAG + canonical_bytes(unsigned)


def sign_command(command: dict[str, Any], priv: PrivateKey, actor_agent_id: str) -> dict[str, Any]:
    """Return a copy of `command` with its `signature` object attached."""
    unsigned = {k: v for k, v in command.items() if k != "signature"}
    return {
        **unsigned,
        "signature": {
            "profile": SIGNATURE_PROFILE,
            "keyId": key_id(actor_agent_id, priv),
            "sig": sign_digest(priv, COMMAND_DOMAIN_TAG + canonical_bytes(unsigned)),
        },
    }


def verify_command_signature(signed: dict[str, Any], signer_address: str) -> bool:
    """Verify a command signature.

    `signer_address` is passed in rather than resolved here so this stays
    offline-testable. A real deployment resolves `signature.keyId` through Kite
    Identity's public resolve surface and requires the recovered address to
    equal the address of the key the FRAGMENT names — not merely some active
    key of the agent (§8).
    """
    if signed.get("signature", {}).get("profile") != SIGNATURE_PROFILE:
        return False
    return verify_signature(signed["signature"]["sig"], command_preimage(signed), signer_address)


def receipt_preimage(receipt: dict[str, Any]) -> bytes:
    signed = {f: receipt[f] for f in RECEIPT_SIGNED_FIELDS if receipt.get(f) is not None}
    return RECEIPT_DOMAIN_TAG + canonical_bytes(signed)


def verify_receipt(receipt: dict[str, Any], runtime_address: str) -> bool:
    """Verify a Runtime transition receipt (§4.3).

    `runtimeSignature: null` is schema-VALID and returns False here: an
    unsigned receipt is a visible non-guarantee and MUST NOT be presented as
    proof of anything. Note also that `auditStatus` is outside the preimage, so
    a `recorded` value is never evidence of durability — only the referenced
    Audit receipt is.
    """
    sig = receipt.get("runtimeSignature")
    if not sig:
        return False
    return verify_signature(sig["sig"], receipt_preimage(receipt), runtime_address)


def sign_party_envelope(
    envelope: dict[str, Any], priv: PrivateKey, actor_agent_id: str
) -> dict[str, Any]:
    """§6.2.1 — the signed wrapper the funding / evidence / proofs interactions
    require. Those are party-only: the Runtime rejects a request whose
    signature does not verify, or whose actor is not a party to the deal."""
    unsigned = {k: v for k, v in envelope.items() if k != "signature"}
    return {
        **unsigned,
        "signature": {
            "profile": SIGNATURE_PROFILE,
            "keyId": key_id(actor_agent_id, priv),
            "sig": sign_digest(priv, FUNDING_DOMAIN_TAG + canonical_bytes(unsigned)),
        },
    }
