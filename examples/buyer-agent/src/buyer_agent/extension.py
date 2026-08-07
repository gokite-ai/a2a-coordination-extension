"""Extension participation: the buyer's side of the agreement workflow.

Built directly from the bundle's schemas (schemas/v1) and spec — no Kite SDK.
Each function cites the spec section it implements, and `tests/test_vectors.py`
replays `vectors/v1` against the signing primitives so this file is checkably
the same protocol the Kite runtime speaks.

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
CONTRACT_SCHEMA = "https://a2a.gokite.ai/schemas/deal-contract/v1"

# The one deployment-specific value. Every identifier above is
# environment-neutral on purpose: they are pinned inside signed contracts (the
# `schema` member is part of the termsHash preimage), so they must not name an
# environment. The endpoint is where a deployment is named.
COORDINATION_ENDPOINT = os.environ.get(
    "KITE_COORDINATION_ENDPOINT", "https://passport.dev.gokite.ai/a2a/v1"
)

BUYER_AGENT_ID = os.environ.get("BUYER_AGENT_ID", "did:kite:acme:buyer-17")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def generate_demo_key() -> PrivateKey:
    """Ephemeral secp256k1 key for the demo. A real agent binds ONE durable
    secp256k1 runtime key through Kite Identity and reuses it for everything
    Kite-native — coordination signatures and on-chain settlement alike (§8)."""
    return PrivateKey()


def draft_contract(
    seller_agent_id: str,
    price_usdc: str,
    deliverable: str,
    payout_address: str,
    runtime_agent_id: str = "did:kite:kite:coordination-engine",
    runtime_card_hash: str = "sha256:" + "0" * 64,
) -> dict[str, Any]:
    """Assemble final terms as a DealContract (§4.1, schemas/v1).

    Everything negotiated off-protocol lands here as typed fields; nothing from
    the chat itself enters the workflow.

    `escrow.payoutAddress` is REQUIRED: fixed_outcome/v1 settles by paying an
    address, so a contract without one cannot be executed — the schema rejects
    it here rather than letting it fail after both parties have signed.

    `runtimeBinding` pins WHICH Runtime may execute this deal, inside the signed
    terms, so the deal cannot later be redirected to another one. A real buyer
    fills `runtime_card_hash` from the Runtime's VERIFIED Agent Card (§2); the
    zero default is a placeholder that a live deployment must replace.
    """
    return {
        "schema": CONTRACT_SCHEMA,
        "template": "fixed_outcome/v1",
        "buyerAgentId": BUYER_AGENT_ID,
        "sellerAgentId": seller_agent_id,
        "deliverable": deliverable,
        "acceptanceCriteria": "recomposes byte-exact from the signed brief",
        "price": {"amount": price_usdc, "asset": "USDC"},
        "escrow": {"payoutAddress": payout_address},
        "disputePolicy": {"arbiterAgentId": "did:kite:arbiterco:arbiter-01"},
        "runtimeBinding": {
            "runtimeAgentId": runtime_agent_id,
            "agentCardHash": runtime_card_hash,
            "extensionUri": EXTENSION_URI,
            "endpoint": COORDINATION_ENDPOINT,
        },
        "signatures": [],
    }


def propose(draft: dict[str, Any], priv: PrivateKey) -> dict[str, Any]:
    """First signature over termsHash = the proposal (§4.1)."""
    if draft.get("signatures"):
        raise ValueError("draft must be unsigned; any change is a new proposal")
    entry = signing.sign_terms(signing.terms_hash(draft), priv, BUYER_AGENT_ID)
    return {**draft, "signatures": [entry]}


def verify_acceptance(
    proposed: dict[str, Any], accepted: dict[str, Any], seller_address: str
) -> str:
    """Check the seller countersigned EXACTLY what we proposed (§4.1).

    Both hashes are recomputed locally — a claimed `termsHash` is never trusted
    — and the second signature must be the seller's over that identical value.
    A contract that differs in any member is a NEW proposal, not an acceptance.
    Returns the agreed termsHash.
    """
    ours = signing.terms_hash(proposed)
    theirs = signing.terms_hash(accepted)
    if ours != theirs:
        raise ValueError("accepted contract differs from the proposal — that is a new proposal, not an acceptance")
    sigs = accepted.get("signatures", [])
    if len(sigs) != 2 or sigs[0] != proposed["signatures"][0]:
        raise ValueError("acceptance must carry our untouched proposal signature plus the seller's")
    if sigs[1]["signerAgentId"] != accepted["sellerAgentId"]:
        raise ValueError("second signature must be the seller's")
    if not signing.verify_terms_signature(theirs, sigs[1], seller_address):
        raise ValueError("seller terms signature does not verify")
    return theirs


def build_command(
    command_type: str,
    deal_id: str,
    expected_revision: int,
    terms_hash_ref: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Assemble an unsigned AgreementCommand per schemas/v1 (§4.2).

    `payload` travels INSIDE the command and `payloadHash` commits to its
    canonical bytes; the signature then covers the whole body. That ordering is
    what lets a Runtime say which of the two broke — a swapped payload fails the
    hash check before the signature is consulted.
    """
    return {
        "schema": COMMAND_SCHEMA,
        "commandId": "cmd_" + secrets.token_hex(13),
        "commandType": command_type,
        "dealId": deal_id,
        "expectedRevision": expected_revision,
        "actorAgentId": BUYER_AGENT_ID,
        "termsHash": terms_hash_ref,
        "payload": payload,
        "payloadHash": signing.sha256_ref(signing.canonical_bytes(payload)),
        "occurredAt": now_iso(),
    }


def accept(
    deal_id: str,
    terms_hash_ref: str,
    expected_revision: int,
    acceptance_sig: str,
    expiry: int,
    priv: PrivateKey,
) -> dict[str, Any]:
    """kite.contract.accepted — the buyer releases escrow to the seller (§3, §5).

    `acceptance_sig` is the buyer agent's own EIP-712 Acceptance over the
    EscrowVault struct: a SETTLEMENT-layer signature, opaque to this extension
    and carried through as a payload member. The platform holds no
    fund-authoritative key, so nobody else can produce it.
    """
    command = build_command(
        "kite.contract.accepted", deal_id, expected_revision, terms_hash_ref,
        payload={"buyerAcceptanceSig": acceptance_sig, "expiry": expiry},
    )
    return signing.sign_command(command, priv, BUYER_AGENT_ID)


def reject(
    deal_id: str,
    terms_hash_ref: str,
    expected_revision: int,
    reason_code: str,
    rejection_sig: str,
    expiry: int,
    priv: PrivateKey,
) -> dict[str, Any]:
    """kite.contract.rejected — the buyer refuses delivery within the
    confirmation window (§3). No action within that window auto-confirms; that
    rule is part of the signed terms, consented to at acceptance."""
    command = build_command(
        "kite.contract.rejected", deal_id, expected_revision, terms_hash_ref,
        payload={"reasonCode": reason_code, "buyerRejectionSig": rejection_sig, "expiry": expiry},
    )
    return signing.sign_command(command, priv, BUYER_AGENT_ID)


def funding_envelope(
    deal_id: str, terms_hash_ref: str, submission: dict[str, Any], priv: PrivateKey
) -> dict[str, Any]:
    """A §6.2.1 party envelope for the funding interactions.

    Funding is NOT a command: it is a Runtime chain observation (§3). What the
    buyer does is supply artifacts — its wallet, its Activation signature, its
    payment authorization — and read back what has arrived. Those interactions
    are party-only, so each carries this signed envelope; and the role split
    means a buyer may supply only ITS OWN fields.
    """
    return signing.sign_party_envelope(
        {"dealId": deal_id, "actorAgentId": BUYER_AGENT_ID,
         "termsHash": terms_hash_ref, "submission": submission},
        priv, BUYER_AGENT_ID,
    )


def verify_delivery(command: dict[str, Any], terms_hash_ref: str, seller_address: str) -> None:
    """Verify the seller's kite.contract.delivered end to end (§4.2).

    Note what is NOT checked here: that `evidenceRef` names a real artifact.
    That reference must have been REGISTERED against this agreement through the
    Runtime's evidence intake (§6.2.1), and only the Runtime can confirm it — a
    locally computed digest is a claim, not evidence. The buyer's check is that
    the command is genuine and bound to these terms; the Runtime's is that the
    evidence exists.
    """
    if command.get("commandType") != "kite.contract.delivered":
        raise ValueError("expected a kite.contract.delivered command")
    if command.get("termsHash") != terms_hash_ref:
        raise ValueError("delivery bound to a different termsHash")
    payload = command.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    if command.get("payloadHash") != signing.sha256_ref(signing.canonical_bytes(payload)):
        raise ValueError("payloadHash does not commit to the payload")
    if not payload.get("evidenceRef"):
        raise ValueError("delivery must cite the evidenceRef the Runtime registered")
    if not signing.verify_command_signature(command, seller_address):
        raise ValueError("delivery command signature does not verify")
