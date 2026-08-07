"""Extension participation: the seller's side of the agreement workflow.

Built directly from the bundle's schemas (schemas/v1) and spec — no Kite SDK.
Each function cites the spec section it implements.

Demo scope: signed objects are built and verified for real. Delivering them to
a Coordination Engine is the caller's job — point KITE_COORDINATION_ENDPOINT at
a live Runtime and send them as Extension-typed Parts (§6).
"""

from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone
from typing import Any

from coincurve import PrivateKey

from . import signing

EXTENSION_URI = "https://a2a.gokite.ai/extensions/coordination-workflow/v1"
COMMAND_MEDIA_TYPE = "application/vnd.gokite.agreement-command+json;version=1"
COMMAND_SCHEMA = "https://a2a.gokite.ai/schemas/agreement-command/v1"

# The Runtime's published A2A endpoint, from its Agent Card (§2). The parties
# pin this inside the signed terms (runtimeBinding), so an accepted agreement
# can never be redirected to another Runtime. It is the ONE deployment-specific
# value here; every identifier above is environment-neutral because they are
# part of the termsHash preimage.
COORDINATION_ENDPOINT = os.environ.get(
    "KITE_COORDINATION_ENDPOINT", "https://passport.dev.gokite.ai/a2a/v1"
)

SELLER_AGENT_ID = os.environ.get("SELLER_AGENT_ID", "did:kite:pubco:seller-42")

# Where settlement lands. It goes into the SIGNED terms (escrow.payoutAddress),
# so the buyer agrees to it up front rather than the seller naming it later.
SELLER_PAYOUT_ADDRESS = os.environ.get(
    "SELLER_PAYOUT_ADDRESS", "0x" + "33" * 20
)

# Stand-in for the settlement layer: an EIP-712 Delivery over the EscrowVault
# struct, carried through as an opaque payload member (§4).
DEMO_SETTLEMENT_SIG = "0x" + "cd" * 65
DEMO_EXPIRY = 1_800_000_000


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def generate_demo_key() -> PrivateKey:
    """Ephemeral secp256k1 key for the demo. A real agent binds ONE durable
    secp256k1 runtime key through Kite Identity and reuses it for coordination
    signatures and on-chain settlement alike (§8)."""
    return PrivateKey()


def build_command(
    command_type: str,
    deal_id: str,
    expected_revision: int,
    terms_hash_ref: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Assemble an unsigned AgreementCommand per schemas/v1 (§4.2).

    `payload` travels INSIDE the command and `payloadHash` commits to its
    canonical bytes; the signature then covers the whole body. A swapped
    payload therefore fails the hash check before the signature is consulted,
    so a Runtime can say which of the two broke.
    """
    return {
        "schema": COMMAND_SCHEMA,
        "commandId": "cmd_" + secrets.token_hex(13),
        "commandType": command_type,
        "dealId": deal_id,
        "expectedRevision": expected_revision,
        "actorAgentId": SELLER_AGENT_ID,
        "termsHash": terms_hash_ref,
        "payload": payload,
        "payloadHash": signing.sha256_ref(signing.canonical_bytes(payload)),
        "occurredAt": now_iso(),
    }


def accept_terms(
    contract: dict[str, Any], buyer_address: str, priv: PrivateKey
) -> dict[str, Any]:
    """Countersign a proposed DealContract (§4.1).

    Acceptance is the second signature over EXACTLY the proposal's termsHash. A
    contract differing in any member canonicalizes to a different hash, so
    recomputing the hash locally — never trusting a claimed one — is the whole
    defence: verify the buyer's signature against OUR OWN recomputation, then
    countersign that same value.

    The seller also has to check the terms it is about to be bound by. Here that
    means the payout address: signing a contract that pays somewhere else would
    be agreeing to work for free.

    In the demo the buyer's address arrives with the proposal; a real deployment
    resolves it from the buyer's DID through Kite Identity (§8).
    """
    if len(contract.get("signatures", [])) != 1:
        raise ValueError("a proposal carries exactly one signature")
    if contract.get("escrow", {}).get("payoutAddress", "").lower() != SELLER_PAYOUT_ADDRESS.lower():
        raise ValueError("contract does not pay our payout address — refusing to countersign")

    computed = signing.terms_hash(contract)
    proposal_sig = contract["signatures"][0]
    if proposal_sig["signerAgentId"] != contract["buyerAgentId"]:
        raise ValueError("proposal signature must be the buyer's")
    if not signing.verify_terms_signature(computed, proposal_sig, buyer_address):
        raise ValueError("buyer terms signature does not verify against the recomputed termsHash")

    acceptance = signing.sign_terms(computed, priv, SELLER_AGENT_ID)
    return {**contract, "signatures": [proposal_sig, acceptance]}


def evidence_envelope(
    deal_id: str, terms_hash_ref: str, content: bytes, priv: PrivateKey
) -> dict[str, Any]:
    """A §6.2.1 party envelope registering delivery evidence — SELLER ONLY.

    This has to happen BEFORE the delivered command: the Runtime refuses a
    `delivered` whose evidenceRef it never registered against this agreement, so
    a locally computed digest is a claim, not evidence. The Runtime returns the
    id to cite. (The kind is seller-only for the same reason it exists: a buyer
    able to register evidence could manufacture the backing for the other side's
    delivery claim.)
    """
    return signing.sign_party_envelope(
        {
            "dealId": deal_id,
            "actorAgentId": SELLER_AGENT_ID,
            "termsHash": terms_hash_ref,
            "submission": {
                "type": "delivery",
                "hash": signing.sha256_ref(content),
                "url": "https://example.invalid/delivered-artifact",
                "format": "text/plain",
                "sizeBytes": len(content),
            },
        },
        priv, SELLER_AGENT_ID,
    )


def make_delivery(
    accepted_contract: dict[str, Any],
    deal_id: str,
    expected_revision: int,
    evidence_ref: str,
    priv: PrivateKey,
) -> tuple[dict[str, Any], str]:
    """Produce the deliverable and its signed kite.contract.delivered command.

    Returns (signed_command, content). Evidence bytes never travel in the
    command — only `evidence_ref`, the id the Runtime returned when the artifact
    was registered (see evidence_envelope).
    """
    content = (
        "LAUNCH DAY: the product your agents have been waiting for is live. "
        "Composed per the signed brief."
    )
    command = build_command(
        "kite.contract.delivered",
        deal_id,
        expected_revision,
        signing.terms_hash(accepted_contract),
        payload={
            "evidenceRef": evidence_ref,
            "sellerDeliverySig": DEMO_SETTLEMENT_SIG,
            "expiry": DEMO_EXPIRY,
        },
    )
    return signing.sign_command(command, priv, SELLER_AGENT_ID), content
