"""Buyer agent entry point: an A2A client driving the agreement flow against
the example seller.

    negotiate (plain A2A) → propose → acceptance → funding → delivery → accept

Every signed object is built and verified for real: termsHash recomputation,
two terms signatures over the identical anchor, command signatures, and the
§6.2.1 party envelope. What a live Coordination Engine adds — the state
machine, revision checks, escrow, evidence intake, receipts, audit — is marked
at each step; the signed objects here are exactly what would be sent to it as
Extension-typed Parts (§6).

Run the example seller first (see ../../seller-agent), then:

    SELLER_AGENT_URL=http://localhost:9999 python -m buyer_agent
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any
from uuid import uuid4

import httpx
from a2a.client import A2ACardResolver, A2AClient
from a2a.types import (
    DataPart,
    Message,
    MessageSendParams,
    Part,
    Role,
    SendMessageRequest,
    SendMessageSuccessResponse,
    TextPart,
)

from . import extension, signing

SELLER_AGENT_URL = os.environ.get("SELLER_AGENT_URL", "http://localhost:9999")
SELLER_AGENT_ID = os.environ.get("SELLER_AGENT_ID", "did:kite:pubco:seller-42")

# Stand-ins for the settlement layer. These are EIP-712 signatures over
# EscrowVault structs — a separate signing layer this extension carries but
# never interprets (§4). A real buyer produces them with the same secp256k1
# key; the demo has no vault to sign against.
DEMO_SETTLEMENT_SIG = "0x" + "ab" * 65
DEMO_EXPIRY = 1_800_000_000


def _request(parts: list[Part], with_extension: bool) -> SendMessageRequest:
    return SendMessageRequest(
        id=str(uuid4()),
        params=MessageSendParams(
            message=Message(
                role=Role.user,
                message_id=uuid4().hex,
                parts=parts,
                extensions=[extension.EXTENSION_URI] if with_extension else None,
            )
        ),
    )


async def _send_data(client: A2AClient, data: dict[str, Any]) -> dict[str, Any]:
    """One Extension-typed exchange; returns the seller's DataPart."""
    response = await client.send_message(_request([Part(root=DataPart(data=data))], with_extension=True))
    if not isinstance(response.root, SendMessageSuccessResponse):
        raise RuntimeError(f"A2A error: {response.root.model_dump_json(exclude_none=True)}")
    result = response.root.result
    if not isinstance(result, Message):
        raise RuntimeError(f"expected a Message result, got {type(result).__name__}")
    for part in result.parts or []:
        if isinstance(part.root, DataPart):
            reply = part.root.data
            if reply.get("kind") == "error":
                raise RuntimeError(f"seller rejected: {reply['error']}")
            return reply
    raise RuntimeError("no DataPart in seller reply")


async def run() -> None:
    def ok(step: str, detail: str) -> None:
        print(f"  [ok] {step}: {detail}")

    buyer_key = extension.generate_demo_key()

    async with httpx.AsyncClient(timeout=30) as http:
        # 1. Discover — and check the seller declares the Extension. For the
        #    RUNTIME's card the same check also verifies template + keys and
        #    pins the card hash into the terms (§2).
        card = await A2ACardResolver(http, base_url=SELLER_AGENT_URL).get_agent_card()
        declared = [e.uri for e in (card.capabilities.extensions or [])]
        if extension.EXTENSION_URI not in declared:
            sys.exit(f"seller does not declare the extension: {declared}")
        ok("discover", f"{card.name} declares {extension.EXTENSION_URI}")
        client = A2AClient(http, agent_card=card)

        # 2. Negotiate off-protocol — plain A2A chat, no extension. Nothing
        #    said here enters the workflow or the audit chain.
        response = await client.send_message(
            _request(
                [Part(root=TextPart(text="Need one promotional post for a product launch. Quote?"))],
                with_extension=False,
            )
        )
        quote = next(p.root.text for p in response.root.result.parts if isinstance(p.root, TextPart))
        ok("negotiate", quote.split("(")[0].strip())

        # 3. Final terms → first signature = the proposal (§4.1). The seller's
        #    payout address is part of the SIGNED terms: where settlement lands
        #    is agreed up front, not chosen later.
        intro = await _send_data(client, {"kind": "request-terms"})
        draft = extension.draft_contract(
            seller_agent_id=SELLER_AGENT_ID,
            price_usdc="24.00",
            deliverable="one promotional post recomposed from the signed brief",
            payout_address=intro["payoutAddress"],
        )
        proposed = extension.propose(draft, buyer_key)
        terms_hash_ref = signing.terms_hash(proposed)
        ok("propose", f"termsHash {terms_hash_ref[:23]}… signed by {extension.BUYER_AGENT_ID}")

        # 4. Seller countersigns the IDENTICAL hash = acceptance (§4.1).
        #    buyerAddress is a demo-only key exchange; production resolves the
        #    counterparty's key from its DID through Kite Identity (§8).
        reply = await _send_data(
            client,
            {
                "kind": "proposal",
                "contract": proposed,
                "buyerAddress": signing.evm_address(buyer_key),
            },
        )
        seller_address = reply["sellerAddress"]
        agreed = extension.verify_acceptance(proposed, reply["contract"], seller_address)
        ok("accept", f"both signatures verify over {agreed[:23]}…")

        # 5. Funding (§3) is a Runtime CHAIN OBSERVATION, not a command: the
        #    buyer supplies artifacts and the Runtime watches for the on-chain
        #    Funded event. This is the §6.2.1 party envelope those interactions
        #    require — party-only, and role-bound so the buyer can supply only
        #    its own fields.
        deal_id = reply.get("dealId", "deal_" + agreed.split(":", 1)[1][:12])
        envelope = extension.funding_envelope(
            deal_id, agreed,
            submission={"buyerWallet": signing.evm_address(buyer_key)},
            priv=buyer_key,
        )
        ok("funding", f"envelope signed with {envelope['signature']['keyId']}")

        # 6. Delivery: the seller's signed kite.contract.delivered, verified for
        #    signature and terms binding. Whether its evidenceRef names a real
        #    artifact is the RUNTIME's check — it refuses a reference it never
        #    registered, which a local digest cannot satisfy.
        delivery = await _send_data(
            client, {"kind": "request-delivery", "dealId": deal_id,
                     "termsHash": agreed, "expectedRevision": 3}
        )
        command = delivery["command"]
        extension.verify_delivery(command, agreed, seller_address)
        ok("deliver", f"{command['commandId']} verified; evidenceRef {command['payload']['evidenceRef']}")

        # 7. Accept within the confirmation window (§3) — no action would
        #    auto-confirm, per the signed terms.
        decision = extension.accept(
            deal_id, agreed, expected_revision=4,
            acceptance_sig=DEMO_SETTLEMENT_SIG, expiry=DEMO_EXPIRY, priv=buyer_key,
        )
        assert signing.verify_command_signature(decision, signing.evm_address(buyer_key))
        ok("decide", f"{decision['commandType']} {decision['commandId']} signed")

        print("\ndeal transcript (what a Runtime + Audit would record):")
        print(f"  termsHash   {agreed}")
        print(f"  buyer       {extension.BUYER_AGENT_ID}  seller  {SELLER_AGENT_ID}")
        print(f"  commands    {command['commandId']}, {decision['commandId']}")
        print(f"  next        point KITE_COORDINATION_ENDPOINT at a live Coordination Engine (§6)")
        print(f"              currently {extension.COORDINATION_ENDPOINT}")


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
