"""Extension participation: the seller's side of the agreement workflow.

Built directly from the bundle's schemas (schemas/v1) and spec — no Kite SDK.
Each function cites the spec section it implements.

Demo scope: signed objects are built and verified for real, then verified
locally. Delivering them to a Coordination Engine is the caller's job — point
KITE_COORDINATION_ENDPOINT at a live Runtime and send them as Extension-typed
Parts (§6). The traffic the two example agents exchange with each other is a
demo-private negotiation on its own media type, never the Extension's; see
NEGOTIATION_MEDIA_TYPE below.
"""

from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone
from typing import Any

from coincurve import PrivateKey

from . import settlement, signing

EXTENSION_URI = "https://a2a.gokite.ai/extensions/coordination-workflow/v1"
COMMAND_SCHEMA = "https://a2a.gokite.ai/schemas/agreement-command/v1"

# The Extension's own media type (§6.1). It belongs on Parts carrying the
# interactions §6.2 defines, addressed to a Coordination Runtime — which is
# exactly what this demo does NOT do. It is DECLARED on the Agent Card as the
# §2.1 commandMediaType param, because that is what a card advertises; it is
# never stamped on a Part this agent sends.
COMMAND_MEDIA_TYPE = "application/vnd.gokite.agreement-command+json;version=1"

# DEMO-PRIVATE, and not part of the Extension contract. The two example agents
# negotiate with EACH OTHER, and none of what they exchange to do it —
# request-terms, submit-proposal, acceptance-request, request-delivery and this
# agent's replies — is an interaction §6.2 defines. Stamping those with
# COMMAND_MEDIA_TYPE would advertise a private peer protocol as Extension
# traffic, so they get their own carrier. Anyone copying this demo should
# expect to replace the negotiation entirely; the signed objects it produces
# are the part that is normative.
NEGOTIATION_MEDIA_TYPE = "application/vnd.gokite.example-negotiation+json;version=1"

# §6.5: Runtime → party notifications ride their own media type — deliberately
# distinct from the command carrier, so a receiver can tell a notification
# FROM the state machine apart from a signed instruction INTO it by media type
# alone. v1 defines exactly one type: kite.contract.fulfill_started.
CONTRACT_MESSAGE_MEDIA_TYPE = "application/vnd.gokite.contract-message+json;version=1"

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

# The one service this demo sells, at the price its quote names. The terms the
# buyer proposes are checked against THIS, not merely for well-formedness:
# protocol validity is the Runtime's job, but only the seller can say whether
# the business terms are the ones it quoted. Env-configurable because the
# amount is REAL spend on whatever chain the deployment settles on — a
# recurring e2e against dev funds this out of a test wallet on every run, and
# a fixed 24.00 drained it (the first full run died on
# "ERC20: transfer amount exceeds balance").
QUOTE_AMOUNT_USDC = os.environ.get("SELLER_QUOTE_USDC", "24.00")

# Demo expiry for embedded settlement signatures (§4.2: bounds the signature).
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


def validate_terms(contract: dict[str, Any]) -> None:
    """The seller's OWN check of the terms it is about to be bound by.

    The Runtime validates protocol shape and signatures; it cannot know what
    this seller quoted. Every member checked here is inside the termsHash
    preimage, so passing once means passing for the life of the deal:

    - payout: a contract paying elsewhere is agreeing to work for free;
    - identity: a contract naming another seller is not ours to countersign;
    - price: exactly the quoted amount — protocol-valid terms for a different
      number are a renegotiation, not an acceptance;
    - deliverable: an empty one leaves acceptance criteria judging nothing;
    - runtimeBinding: the pinned Runtime must be the one this seller executes
      against, or funding and delivery could never be driven through it;
    - arbiter: §4.1 — a party able to name itself arbiter resolves its own
      dispute, so the arbiter must be a third party.
    """
    if contract.get("escrow", {}).get("payoutAddress", "").lower() != SELLER_PAYOUT_ADDRESS.lower():
        raise ValueError("contract does not pay our payout address — refusing to countersign")
    if contract.get("sellerAgentId") != SELLER_AGENT_ID:
        raise ValueError(
            f"contract names seller {contract.get('sellerAgentId')!r}, not {SELLER_AGENT_ID}"
        )
    price = contract.get("price") or {}
    if price.get("asset") != "USDC" or price.get("amount") != QUOTE_AMOUNT_USDC:
        raise ValueError(
            f"contract prices {price.get('amount')!r} {price.get('asset')!r}; "
            f"the quote was {QUOTE_AMOUNT_USDC} USDC — refusing to countersign unquoted terms"
        )
    if not str(contract.get("deliverable") or "").strip():
        raise ValueError("contract carries no deliverable")
    binding = contract.get("runtimeBinding") or {}
    if binding.get("extensionUri") != EXTENSION_URI:
        raise ValueError(f"runtimeBinding pins extension {binding.get('extensionUri')!r}, not this one")
    if binding.get("endpoint") != COORDINATION_ENDPOINT:
        raise ValueError(
            f"runtimeBinding pins Runtime {binding.get('endpoint')!r}; this seller executes "
            f"against {COORDINATION_ENDPOINT} — a deal pinned elsewhere could never be funded here"
        )
    arbiter = (contract.get("disputePolicy") or {}).get("arbiterAgentId")
    if not arbiter or arbiter in (contract.get("buyerAgentId"), SELLER_AGENT_ID):
        raise ValueError("disputePolicy.arbiterAgentId must name a third party (§4.1)")


def validate_runtime_card(card: dict[str, Any], binding: dict[str, Any]) -> tuple[int, str]:
    """§2/§4.1: prove the served card IS the one the terms pin, then take the
    chain context from it.

    Returns (chainId, escrowVault). The chain id matters beyond bookkeeping:
    the §4.4 Agreement domain commits to it, so an agreementSig produced under
    a locally configured chain — instead of the Runtime's published one — is
    refused by the engine with nothing but an opaque signature failure. The
    card is the ONLY place that context is published before funding exists
    (§2.1), and `agentCardHash` in the signed terms is what stops a
    swapped-out card from supplying a different one.
    """
    computed = signing.sha256_ref(signing.canonical_bytes(card))
    if computed != binding.get("agentCardHash"):
        raise ValueError(
            f"runtime card hash {computed} is not the one the terms pin "
            f"({binding.get('agentCardHash')}) — the card changed after signing, or the "
            "proposal pinned a placeholder"
        )
    registry = (card.get("x-kite-registry") or {}).get("agentId")
    if registry != binding.get("runtimeAgentId"):
        raise ValueError(
            f"runtime card belongs to {registry!r}, not the pinned {binding.get('runtimeAgentId')!r}"
        )
    declared = next(
        (e for e in (card.get("capabilities") or {}).get("extensions") or []
         if e.get("uri") == EXTENSION_URI),
        None,
    )
    if declared is None:
        raise ValueError("runtime card does not declare this extension (§2.1)")
    params = declared.get("params") or {}
    if "chainId" not in params or "escrowVault" not in params:
        raise ValueError("runtime card omits chainId/escrowVault (§2.1) — nothing safe to sign under")
    return int(params["chainId"]), str(params["escrowVault"])


def accept_terms(
    contract: dict[str, Any],
    buyer_address: str,
    deal_id: str,
    buyer_agreement_sig: str,
    priv: PrivateKey,
    chain_id: int = settlement.CHAIN_ID,
) -> dict[str, Any]:
    """Countersign a proposed DealContract (§4.1).

    Acceptance is the second signature over EXACTLY the proposal's termsHash. A
    contract differing in any member canonicalizes to a different hash, so
    recomputing the hash locally — never trusting a claimed one — is the whole
    defence: verify the buyer's signature against OUR OWN recomputation, then
    countersign that same value.

    The seller also has to check the terms it is about to be bound by —
    validate_terms, which judges the business terms against what this seller
    actually quoted.

    In the demo the buyer's address arrives with the proposal; a real deployment
    resolves it from the buyer's DID through Kite Identity (§8).
    """
    if len(contract.get("signatures", [])) != 1:
        raise ValueError("a proposal carries exactly one signature")
    validate_terms(contract)

    computed = signing.terms_hash(contract)
    proposal_sig = contract["signatures"][0]
    if proposal_sig["signerAgentId"] != contract["buyerAgentId"]:
        raise ValueError("proposal signature must be the buyer's")
    if not signing.verify_terms_signature(computed, proposal_sig, buyer_address):
        raise ValueError("buyer terms signature does not verify against the recomputed termsHash")

    # §4.1 two-phase rule: the accepted contract carries agreementSig on BOTH
    # entries, and both are REAL §4.4 Agreement signatures — they exist only
    # now, because the digest commits to the deal id assigned at proposal.
    # The buyer's arrived with the acceptance request; verify it before
    # binding ourselves next to it.
    # `chain_id` is the Agreement domain (§4.4). Standalone keeps the local
    # default; live callers pass the value from the VERIFIED Runtime card
    # (validate_runtime_card) — signing under a configured chain that differs
    # from the Runtime's published one produces a signature the engine refuses.
    digest = settlement.agreement_digest(
        deal_id, computed, contract["price"]["amount"],
        buyer_address, signing.evm_address(priv), chain_id=chain_id,
    )
    if not settlement.verifies(digest, buyer_agreement_sig, buyer_address):
        raise ValueError("buyer agreementSig does not verify over the §4.4 Agreement digest")
    acceptance = signing.sign_terms(
        computed, priv, SELLER_AGENT_ID, settlement.sign_digest32(priv, digest)
    )
    return {**contract, "signatures": [
        {**proposal_sig, "agreementSig": buyer_agreement_sig}, acceptance]}


def evidence_envelope(
    deal_id: str, terms_hash_ref: str, content: bytes, priv: PrivateKey
) -> dict[str, Any]:
    """A §6.2.1 party envelope registering delivery evidence — SELLER ONLY.

    This has to happen BEFORE the delivered command: the Runtime refuses a
    `delivered` whose evidenceId it never issued for this agreement, so
    a locally computed digest is a claim, not evidence. The Runtime returns the
    id to cite. (The kind is seller-only for the same reason it exists: a buyer
    able to register evidence could manufacture the backing for the other side's
    delivery claim.)
    """
    return signing.sign_party_envelope(
        {
            # `kind` is part of the SIGNED object: the Runtime canonicalizes the
            # whole wire payload minus "signature" (spec §6.2.1), so an envelope
            # signed without its kind recovers a different address and is
            # rejected as "not an active signing key of the signer".
            "kind": "evidence",
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


def demo_anchors(deal_id: str) -> dict[str, Any]:
    """The standalone stand-ins for the §4.4 settlement anchors.

    With no Runtime there is no funded vault deal, no proof chain, and no
    nonce, so the demo signs over documented placeholders. Against a live
    Runtime EVERY one of these must instead be read back fresh: the vault deal
    id and nonce from `status`'s vault block, the receipt anchor from
    `latestProofHash` — a signature over stale or invented anchors is refused
    by the vault, and worse, refused only at broadcast.
    """
    return {
        "dealId32": settlement.demo_deal_id32(deal_id),
        "receiptHash": settlement.ZERO_ANCHOR,
        "nonce": 0,
        "expiry": DEMO_EXPIRY,
        "chainId": settlement.CHAIN_ID,
        "vault": settlement.VAULT_ADDRESS,
    }


def make_delivery(
    accepted_contract: dict[str, Any],
    deal_id: str,
    expected_revision: int,
    evidence_id: str,
    priv: PrivateKey,
    anchors: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str]:
    """Produce the deliverable and its signed kite.contract.delivered command.

    Returns (signed_command, content). Evidence bytes never travel in the
    command. The payload names two different things (§4.2): `evidenceId`, the
    id the Runtime returned when the artifact was registered (see
    evidence_envelope), and `deliveryHash`, the sha256 of the artifact itself —
    the value whose 32 raw digest bytes become the settlement layer's bytes32
    deliveryHash, which is why an opaque id could never do its job.

    `anchors` is the §4.4 signing context — vault deal id, receipt hash,
    nonce, expiry, and the EIP-712 domain. None means the standalone demo's
    documented placeholders (demo_anchors); a live flow passes the values it
    just read back from the Runtime.
    """
    if anchors is None:
        anchors = demo_anchors(deal_id)
    content = (
        "LAUNCH DAY: the product your agents have been waiting for is live. "
        "Composed per the signed brief."
    )
    delivery_hash = signing.sha256_ref(content.encode())
    command = build_command(
        "kite.contract.delivered",
        deal_id,
        expected_revision,
        signing.terms_hash(accepted_contract),
        payload={
            "evidenceId": evidence_id,
            "deliveryHash": delivery_hash,
            # A REAL §4.4 Delivery signature over the anchors — the same
            # digest the buyer re-derives and verifies on receipt.
            "sellerDeliverySig": settlement.sign_digest32(
                priv,
                settlement.delivery_digest(
                    anchors["dealId32"],
                    signing.terms_hash(accepted_contract),
                    delivery_hash,
                    receipt_hash=anchors["receiptHash"],
                    nonce=int(anchors["nonce"]),
                    expiry=int(anchors["expiry"]),
                    chain_id=int(anchors["chainId"]),
                    vault=anchors["vault"],
                ),
            ),
            "expiry": int(anchors["expiry"]),
        },
    )
    return signing.sign_command(command, priv, SELLER_AGENT_ID), content
