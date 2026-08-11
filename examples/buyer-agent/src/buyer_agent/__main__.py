"""Buyer agent entry point: an A2A 1.0 client driving the agreement flow
against the example seller, over the JSON-RPC binding.

    negotiate (plain A2A) → propose → agreementSig → acceptance
                          → funding → delivery → accept

Every signed object is built and verified for real: termsHash recomputation,
two terms signatures over the identical anchor, BOTH parties' §4.4 Agreement
co-signatures, command signatures, the seller's §4.4 Delivery settlement
signature, and the §6.2.1 party envelope. What a live Coordination Engine
adds — the state machine, revision checks, escrow, evidence intake, receipts,
audit — is marked at each step.

The transport is the A2A 1.0 one a Runtime speaks — `raw` Parts, the
A2A-Extensions header, ROLE_USER/ROLE_AGENT, the SendMessage oneof reply —
but the messages are the demo's own peer negotiation, on
extension.NEGOTIATION_MEDIA_TYPE. Nothing here is a §6.2 interaction and
nothing carries the Extension's command media type: this agent is talking to
another agent, not to a Coordination Engine.

Run the example seller first (see ../../seller-agent), then:

    SELLER_AGENT_URL=http://localhost:9999 python -m buyer_agent
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any
from uuid import uuid4

import a2a.types as a2a_types
import httpx
from a2a.client import A2ACardResolver, ClientConfig, create_client
from a2a.client.client import Client
from a2a.extensions.common import HTTP_EXTENSION_HEADER, find_extension_by_uri
from google.protobuf import json_format

from . import extension, settlement, signing

SELLER_AGENT_URL = os.environ.get("SELLER_AGENT_URL", "http://localhost:9999")
SELLER_AGENT_ID = os.environ.get("SELLER_AGENT_ID", "did:kite:pubco:seller-42")

# A REAL Coordination Runtime to pin in the contract (its Passport-served
# card supplies the DID, endpoint, agentCardHash and chain context). Unset ⇒
# the local two-agent demo runs with documented stand-ins, and no Runtime
# checks the pin — see resolve_runtime_binding.
RUNTIME_URL = os.environ.get("KITE_RUNTIME_URL", "")


async def resolve_runtime_binding(http: httpx.AsyncClient) -> dict[str, Any] | None:
    """Resolve the RUNTIME's card and derive the §4.1 runtimeBinding pins.

    The card is fetched as raw JSON (not through the SDK parser) because the
    x-kite-registry binding is a Kite extension field a proto parse would
    drop, and because agentCardHash must cover the exact bytes the Runtime
    serves — sha256 over their JCS canonical form (§4.1)."""
    if not RUNTIME_URL:
        return None
    resp = await http.get(RUNTIME_URL.rstrip("/") + "/.well-known/agent-card.json")
    resp.raise_for_status()
    card = resp.json()
    ext = next((e for e in card.get("capabilities", {}).get("extensions", [])
                if e.get("uri") == extension.EXTENSION_URI), None)
    if ext is None:
        sys.exit(f"runtime at {RUNTIME_URL} does not declare the extension")
    params = ext.get("params") or {}
    # §2.1: a Runtime card MUST publish the chain context. No fallback — a
    # card without it cannot be signed against, so it is rejected, not
    # papered over with local defaults.
    if "chainId" not in params or "escrowVault" not in params:
        sys.exit(f"runtime card at {RUNTIME_URL} omits chainId/escrowVault (§2.1) — refusing to form")
    return {
        "runtimeAgentId": card.get("x-kite-registry", {}).get("agentId", ""),
        "endpoint": card.get("supportedInterfaces", [{}])[0].get("url", ""),
        "agentCardHash": signing.sha256_ref(signing.canonical_bytes(card)),
        "chainId": int(params["chainId"]),
        "escrowVault": str(params["escrowVault"]),
    }


def _message(parts: list[a2a_types.Part], with_extension: bool) -> a2a_types.SendMessageRequest:
    return a2a_types.SendMessageRequest(
        message=a2a_types.Message(
            message_id=uuid4().hex,
            role=a2a_types.Role.ROLE_USER,
            parts=parts,
            extensions=[extension.EXTENSION_URI] if with_extension else None,
        )
    )


async def _reply_message(client: Client, request: a2a_types.SendMessageRequest) -> a2a_types.Message:
    """One SendMessage exchange; unwraps the 1.0 oneof (§6.3: the reply
    message is WRAPPED in a member named for the event type)."""
    async for event in client.send_message(request):
        if event.WhichOneof("payload") != "message":
            raise RuntimeError(f"expected a message reply, got {event.WhichOneof('payload')}")
        return event.message
    raise RuntimeError("no reply from seller")


async def _send_negotiation(
    client: Client,
    data: dict[str, Any],
    media_type: str = extension.NEGOTIATION_MEDIA_TYPE,
) -> dict[str, Any]:
    """One typed exchange with the seller: the payload rides in a raw Part
    (never `data`, whose double-only numbers corrupt integer members — §6.1)
    and the reply's raw Part of the same media type is decoded back.

    `media_type` defaults to the demo's negotiation carrier, which is all this
    agent sends. It is a parameter rather than a constant so the same helper
    carries extension.COMMAND_MEDIA_TYPE unchanged for a reader pointing these
    objects at a real Coordination Runtime, where the §6.2 interactions —
    `proposal`, `acceptance`, `command`, `status` — are what travel.
    """
    reply = await _reply_message(
        client,
        _message(
            [a2a_types.Part(
                raw=json.dumps(data).encode(),
                media_type=media_type,
            )],
            with_extension=True,
        ),
    )
    if extension.EXTENSION_URI not in list(reply.extensions):
        raise RuntimeError("seller reply does not echo the activated extension (§2.2)")
    for part in reply.parts:
        if part.WhichOneof("content") == "raw" and part.media_type == media_type:
            payload = json.loads(part.raw)
            if payload.get("kind") == "error":
                raise RuntimeError(f"seller rejected: {payload['error']}")
            return payload
    raise RuntimeError(f"no {media_type} raw Part in seller reply")


async def run() -> None:
    def ok(step: str, detail: str) -> None:
        print(f"  [ok] {step}: {detail}")

    buyer_key = extension.generate_demo_key()

    # The A2A-Extensions header rides on every request (§2.2: opt in BOTH
    # ways — this header plus the message's extensions array).
    async with httpx.AsyncClient(
        timeout=30, headers={HTTP_EXTENSION_HEADER: extension.EXTENSION_URI}
    ) as http:
        # 1. Discover — and check the seller declares the Extension. For the
        #    RUNTIME's card the same check also verifies template + keys and
        #    pins the card hash into the terms (§2).
        card = await A2ACardResolver(http, base_url=SELLER_AGENT_URL).get_agent_card()
        declared = find_extension_by_uri(card, extension.EXTENSION_URI)
        if declared is None:
            sys.exit(f"seller does not declare the extension: {card.capabilities.extensions}")
        ok("discover", f"{card.name} declares {extension.EXTENSION_URI} "
                       f"(A2A {card.supported_interfaces[0].protocol_version}, "
                       f"{card.supported_interfaces[0].protocol_binding})")

        # §2.1/§4.4: the chain context every settlement signature needs comes
        # from a card's extension params — the RUNTIME's card when one is
        # configured, else the demo seller's (which stands in for it). A card
        # that omits them is rejected per §2.1; there is NO fallback to local
        # defaults — signing under a guessed domain is exactly the failure
        # the card publication exists to prevent.
        runtime = await resolve_runtime_binding(http)
        if runtime is not None:
            card_chain, card_vault = runtime["chainId"], runtime["escrowVault"]
        else:
            params = json_format.MessageToDict(declared.params)
            if "chainId" not in params or "escrowVault" not in params:
                sys.exit("seller card omits chainId/escrowVault (§2.1) — refusing to form")
            card_chain, card_vault = int(params["chainId"]), str(params["escrowVault"])
        if card_chain != settlement.CHAIN_ID or card_vault.lower() != settlement.VAULT_ADDRESS.lower():
            sys.exit(
                f"card publishes chainId={card_chain} escrowVault={card_vault}, but this agent "
                f"is configured for {settlement.CHAIN_ID}/{settlement.VAULT_ADDRESS} — set "
                "KITE_CHAIN_ID/KITE_VAULT_ADDRESS to the card's values"
            )
        ok("chain-context", f"chainId {card_chain}, vault {card_vault[:10]}… (from the card params)")
        client = await create_client(
            card, ClientConfig(streaming=False, httpx_client=http)
        )

        # 2. Negotiate off-protocol — plain A2A chat, no extension part.
        #    Nothing said here enters the workflow or the audit chain.
        reply = await _reply_message(
            client,
            _message(
                [a2a_types.Part(text="Need one promotional post for a product launch. Quote?")],
                with_extension=False,
            ),
        )
        quote = next(p.text for p in reply.parts if p.WhichOneof("content") == "text")
        ok("negotiate", quote.split("(")[0].strip())

        # 3. Final terms → first signature = the proposal (§4.1). NO
        #    agreementSig yet — the Agreement digest commits to the deal id
        #    the Runtime assigns on proposal, so the signature cannot exist.
        #    The seller's payout address is part of the SIGNED terms: where
        #    settlement lands is agreed up front, not chosen later.
        #    The two signing addresses are swapped HERE, in the demo's own
        #    negotiation, and never inside a workflow object — a §6.2
        #    `proposal` carries the contract and nothing else. A real buyer
        #    drops this exchange and resolves the seller's address from its
        #    DID through Kite Identity (§8).
        intro = await _send_negotiation(client, {
            "kind": "request-terms",
            "agentId": extension.BUYER_AGENT_ID,
            "address": signing.evm_address(buyer_key),
        })
        seller_address = intro["address"]
        draft = extension.draft_contract(
            seller_agent_id=SELLER_AGENT_ID,
            price_usdc="24.00",
            deliverable="one promotional post recomposed from the signed brief",
            payout_address=intro["payoutAddress"],
            # Pin the REAL Runtime when one is configured (§4.1); the local
            # demo keeps its documented stand-ins and no Runtime checks them.
            **({"runtime_agent_id": runtime["runtimeAgentId"],
                "runtime_card_hash": runtime["agentCardHash"],
                "runtime_endpoint": runtime["endpoint"]} if runtime else {}),
        )
        proposed = extension.propose(draft, buyer_key)
        terms_hash_ref = signing.terms_hash(proposed)
        ok("propose", f"termsHash {terms_hash_ref[:23]}… signed by {extension.BUYER_AGENT_ID}")

        ack = await _send_negotiation(
            client, {"kind": "submit-proposal", "contract": proposed},
        )
        deal_id = ack["dealId"]
        ok("proposal-ack", f"dealId {deal_id} assigned — agreementSig can exist now")

        # 4. Phase two of §4.1: sign the §4.4 Agreement digest (deal id,
        #    termsHash, USDC base units, both agent addresses) and request
        #    the acceptance. The seller verifies ours, countersigns the same
        #    termsHash, and binds its own agreementSig next to it.
        buyer_agreement_sig = settlement.sign_digest32(
            buyer_key,
            settlement.agreement_digest(
                deal_id, terms_hash_ref, proposed["price"]["amount"],
                signing.evm_address(buyer_key), seller_address,
            ),
        )
        reply = await _send_negotiation(
            client, {"kind": "acceptance-request", "dealId": deal_id,
                     "buyerAgreementSig": buyer_agreement_sig},
        )
        agreed = extension.verify_acceptance(
            proposed, reply["contract"], deal_id,
            signing.evm_address(buyer_key), seller_address,
        )
        ok("accept", f"both terms signatures AND both §4.4 agreementSigs verify over {agreed[:23]}…")

        # 5. Funding (§3) is a Runtime CHAIN OBSERVATION, not a command: the
        #    buyer supplies artifacts and the Runtime watches for the on-chain
        #    Funded event. This is the §6.2.1 party envelope those interactions
        #    require — party-only, and role-bound so the buyer can supply only
        #    its own fields.
        envelope = extension.funding_envelope(
            deal_id, agreed,
            submission={"buyerWallet": signing.evm_address(buyer_key)},
            priv=buyer_key,
        )
        ok("funding", f"envelope signed with {envelope['signature']['keyId']}")

        # 6. Delivery: the seller's signed kite.contract.delivered, verified
        #    for command signature, terms binding, AND the embedded §4.4
        #    Delivery settlement signature. Whether its evidenceId names a
        #    real artifact — and its deliveryHash matches it — is the
        #    RUNTIME's check: it refuses an id it never issued.
        delivery = await _send_negotiation(
            client, {"kind": "request-delivery", "dealId": deal_id,
                     "termsHash": agreed, "expectedRevision": 3},
        )
        command = delivery["command"]
        extension.verify_delivery(command, agreed, seller_address)
        ok("deliver", f"{command['commandId']} verified (incl. sellerDeliverySig); "
                      f"evidenceId {command['payload']['evidenceId']}")

        # 7. Accept within the confirmation window (§3) — no action would
        #    auto-confirm, per the platform windows. The buyer's Acceptance
        #    is a REAL §4.4 settlement signature over the demo anchors.
        expiry = int(time.time()) + 3600
        acceptance_sig = settlement.sign_digest32(
            buyer_key,
            settlement.acceptance_digest(
                settlement.demo_deal_id32(deal_id), agreed, expiry=expiry,
            ),
        )
        decision = extension.accept(
            deal_id, agreed, expected_revision=4,
            acceptance_sig=acceptance_sig, expiry=expiry, priv=buyer_key,
        )
        assert signing.verify_command_signature(decision, signing.evm_address(buyer_key))
        ok("decide", f"{decision['commandType']} {decision['commandId']} signed")

        print("\ndeal transcript (what a Runtime + Audit would record):")
        print(f"  termsHash   {agreed}")
        print(f"  dealId      {deal_id}")
        print(f"  buyer       {extension.BUYER_AGENT_ID}  seller  {SELLER_AGENT_ID}")
        print(f"  commands    {command['commandId']}, {decision['commandId']}")
        print(f"  next        point KITE_COORDINATION_ENDPOINT at a live Coordination Engine (§6)")
        print(f"              currently {extension.COORDINATION_ENDPOINT}")

        await client.close()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
