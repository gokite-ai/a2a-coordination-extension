"""Drive the full agreement flow over the REAL A2A 1.0 transport, in-process.

This is the §9 shape check the vector replays cannot make: the buyer client
and seller server exchange actual JSON-RPC SendMessage requests through the
a2a-sdk — raw Parts selected by media type (never `data`), the A2A-Extensions
header both ways, ROLE_USER/ROLE_AGENT, and the 1.0 oneof reply wrapper —
wired through httpx's ASGI transport so no socket is needed.

The Parts carry the demo's NEGOTIATION media type, not the Extension's: what
these two agents exchange is a private peer protocol, and no §6.2 interaction
is transmitted anywhere in this bundle. What IS exercised end to end is the
transport, the §2.2 opt-in handshake, and every signature and hash inside the
objects the negotiation carries.

Requires the sibling buyer-agent package (installed together in this bundle);
skipped if it is absent.
"""

from __future__ import annotations

import json
import time
from uuid import uuid4

import httpx
import pytest

buyer = pytest.importorskip("buyer_agent", reason="sibling buyer-agent package not installed")

import a2a.types as a2a_types  # noqa: E402
from a2a.client import ClientConfig, create_client  # noqa: E402
from a2a.extensions.common import HTTP_EXTENSION_HEADER  # noqa: E402

from buyer_agent import extension as buyer_ext  # noqa: E402
from buyer_agent import settlement, signing  # noqa: E402
from seller_agent.__main__ import build_app  # noqa: E402
from seller_agent.executor import SellerExecutor  # noqa: E402

SELLER_URL = "http://seller.test"


def _negotiation_request(data: dict) -> a2a_types.SendMessageRequest:
    return a2a_types.SendMessageRequest(
        message=a2a_types.Message(
            message_id=uuid4().hex,
            role=a2a_types.Role.ROLE_USER,
            parts=[a2a_types.Part(
                raw=json.dumps(data).encode(),
                media_type=buyer_ext.NEGOTIATION_MEDIA_TYPE,
            )],
            extensions=[buyer_ext.EXTENSION_URI],
        )
    )


async def _reply(client, request) -> a2a_types.Message:
    async for event in client.send_message(request):
        assert event.WhichOneof("payload") == "message", "1.0 oneof must carry a message"
        return event.message
    raise AssertionError("no reply")


def _decode(message: a2a_types.Message) -> dict:
    assert buyer_ext.EXTENSION_URI in list(message.extensions), "reply must echo the extension (§2.2)"
    for part in message.parts:
        if part.WhichOneof("content") == "raw" and part.media_type == buyer_ext.NEGOTIATION_MEDIA_TYPE:
            return json.loads(part.raw)
    raise AssertionError("no negotiation raw Part in reply")


@pytest.mark.asyncio
async def test_full_flow_over_a2a_1_0() -> None:
    executor = SellerExecutor()
    app = build_app(executor=executor)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url=SELLER_URL,
        timeout=30,
        headers={HTTP_EXTENSION_HEADER: buyer_ext.EXTENSION_URI},
    ) as http:
        # The header echo is part of §2.2 — assert it on a raw POST first.
        probe = await http.get("/.well-known/agent-card.json")
        assert probe.status_code == 200
        assert probe.headers.get(HTTP_EXTENSION_HEADER) == buyer_ext.EXTENSION_URI

        client = await create_client(
            SELLER_URL, ClientConfig(streaming=False, httpx_client=http)
        )
        buyer_key = buyer_ext.generate_demo_key()

        # Terms discovery, which is also where the demo swaps signing
        # addresses — outside every workflow object, since a §6.2 `proposal`
        # carries the contract and nothing else.
        terms = _decode(await _reply(client, _negotiation_request({
            "kind": "request-terms",
            "agentId": buyer_ext.BUYER_AGENT_ID,
            "address": signing.evm_address(buyer_key),
        })))
        assert terms["kind"] == "terms"
        seller_address = terms["address"]

        # Proposal (one entry, NO agreementSig) → deal id.
        draft = buyer_ext.draft_contract(
            seller_agent_id="did:kite:pubco:seller-42",
            price_usdc="24.00",
            deliverable="one promotional post recomposed from the signed brief",
            payout_address=terms["payoutAddress"],
        )
        proposed = buyer_ext.propose(draft, buyer_key)
        assert "agreementSig" not in proposed["signatures"][0]
        ack = _decode(await _reply(client, _negotiation_request({
            "kind": "submit-proposal", "contract": proposed,
        })))
        assert ack["kind"] == "proposal-ack" and ack["dealId"]

        # Acceptance with a REAL buyer agreementSig; verify the seller's too.
        terms_hash = signing.terms_hash(proposed)
        buyer_agreement_sig = settlement.sign_digest32(
            buyer_key,
            settlement.agreement_digest(
                ack["dealId"], terms_hash, "24.00",
                signing.evm_address(buyer_key), seller_address,
            ),
        )
        acc = _decode(await _reply(client, _negotiation_request({
            "kind": "acceptance-request", "dealId": ack["dealId"],
            "buyerAgreementSig": buyer_agreement_sig,
        })))
        agreed = buyer_ext.verify_acceptance(
            proposed, acc["contract"], ack["dealId"],
            signing.evm_address(buyer_key), seller_address,
        )
        assert agreed == terms_hash

        # Delivery: command + §4.4 sellerDeliverySig verify end to end.
        delivery = _decode(await _reply(client, _negotiation_request({
            "kind": "request-delivery", "dealId": ack["dealId"],
            "termsHash": agreed, "expectedRevision": 3,
        })))
        buyer_ext.verify_delivery(delivery["command"], agreed, seller_address)

        record = executor.agreement_record(ack["dealId"])
        assert record is not None
        assert record["state"] == "DELIVERED"
        assert record["contract"]["buyerAgentId"] == buyer_ext.BUYER_AGENT_ID
        assert [item["event"] for item in record["history"]] == [
            "Proposal received", "Agreement accepted", "Delivery produced",
        ]

        # The buyer's decision command with a real Acceptance settlement sig.
        expiry = int(time.time()) + 3600
        decision = buyer_ext.accept(
            ack["dealId"], agreed, expected_revision=4,
            acceptance_sig=settlement.sign_digest32(
                buyer_key,
                settlement.acceptance_digest(
                    settlement.demo_deal_id32(ack["dealId"]), agreed, expiry=expiry,
                ),
            ),
            expiry=expiry, priv=buyer_key,
        )
        assert signing.verify_command_signature(decision, signing.evm_address(buyer_key))

        await client.close()


@pytest.mark.asyncio
async def test_negotiation_part_without_opt_in_is_rejected() -> None:
    """§2.2: the parties opt in to the Extension BOTH ways before they may
    negotiate an agreement to be executed under it — the A2A-Extensions header
    and the message's extensions array. Neither is present here, so the
    request must be refused, not guessed at."""
    app = build_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=SELLER_URL, timeout=30,
    ) as http:  # note: NO A2A-Extensions header
        client = await create_client(SELLER_URL, ClientConfig(streaming=False, httpx_client=http))
        request = a2a_types.SendMessageRequest(
            message=a2a_types.Message(
                message_id=uuid4().hex,
                role=a2a_types.Role.ROLE_USER,
                parts=[a2a_types.Part(
                    raw=json.dumps({"kind": "request-terms"}).encode(),
                    media_type=buyer_ext.NEGOTIATION_MEDIA_TYPE,
                )],
                # extensions array deliberately absent as well
            )
        )
        reply = await _reply(client, request)
        payload = None
        for part in reply.parts:
            if part.WhichOneof("content") == "raw":
                payload = json.loads(part.raw)
        assert payload is not None and payload["kind"] == "error"
        assert "opt-in" in payload["error"]
        await client.close()
