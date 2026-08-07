"""A2A executor for the seller.

Two surfaces on one A2A endpoint:

- plain text messages  → off-protocol negotiation (nothing here enters the
  workflow or the audit chain);
- Extension DataParts  → the typed, signed workflow objects: proposals to
  countersign, and delivery requests to fulfill.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.types import DataPart, Message, Part, Role
from a2a.utils import new_agent_text_message

from . import extension, signing


def _data_message(data: dict[str, Any]) -> Message:
    return Message(
        role=Role.agent,
        message_id=uuid4().hex,
        parts=[Part(root=DataPart(data=data))],
        extensions=[extension.EXTENSION_URI],
    )


class SellerExecutor(AgentExecutor):
    """Holds the seller's (demo, ephemeral) key and its accepted deals."""

    def __init__(self) -> None:
        self.key = extension.generate_demo_key()
        # termsHash -> accepted contract. A real seller persists this.
        self.deals: dict[str, dict[str, Any]] = {}
        # dealId -> the evidence id the Runtime returned. The demo has no
        # Runtime, so it stands in for one; see _deliver.
        self.evidence: dict[str, str] = {}

    def _extension_data(self, context: RequestContext) -> dict[str, Any] | None:
        message = context.message
        if message is None:
            return None
        for part in message.parts or []:
            if isinstance(part.root, DataPart):
                return part.root.data
        return None

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        data = self._extension_data(context)
        if data is None:
            await self._negotiate(context, event_queue)
        elif data.get("kind") == "request-terms":
            await self._publish_terms(event_queue)
        elif data.get("kind") == "proposal":
            await self._countersign(data, event_queue)
        elif data.get("kind") == "request-delivery":
            await self._deliver(data, event_queue)
        else:
            await event_queue.enqueue_event(
                _data_message({"kind": "error", "error": f"unknown kind {data.get('kind')!r}"})
            )

    async def _negotiate(self, context: RequestContext, event_queue: EventQueue) -> None:
        inquiry = context.get_user_input()
        quote = (
            "Quote: one promotional post, 24.00 USDC, delivery within 48h, "
            "review window 24h (auto-confirm at expiry). Send final terms "
            f"for countersignature. (inquiry was: {inquiry!r})"
        )
        await event_queue.enqueue_event(new_agent_text_message(quote))

    async def _publish_terms(self, event_queue: EventQueue) -> None:
        """The payout address goes into the SIGNED terms, so the buyer has to
        know it before drafting. Publishing it is not a commitment; countersigning
        the contract that carries it is."""
        await event_queue.enqueue_event(
            _data_message(
                {
                    "kind": "terms",
                    "payoutAddress": extension.SELLER_PAYOUT_ADDRESS,
                    "sellerAddress": signing.evm_address(self.key),
                }
            )
        )

    async def _countersign(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """spec §4.1 — verify the buyer's proposal signature against our own
        recomputed termsHash, countersign the same value."""
        try:
            # demo-only key exchange; real: resolve the buyer's key from its
            # DID through Kite Identity (§8)
            accepted = extension.accept_terms(data["contract"], data["buyerAddress"], self.key)
        except (KeyError, ValueError) as exc:
            await event_queue.enqueue_event(_data_message({"kind": "error", "error": str(exc)}))
            return
        terms_hash_ref = signing.terms_hash(accepted)
        self.deals[terms_hash_ref] = accepted
        await event_queue.enqueue_event(
            _data_message(
                {
                    "kind": "acceptance",
                    "contract": accepted,
                    "sellerAddress": signing.evm_address(self.key),
                    "dealId": "deal_" + terms_hash_ref.split(":", 1)[1][:12],
                }
            )
        )

    async def _deliver(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """spec §3 — deliver only on a deal we actually countersigned.

        Demo simplification: the buyer's request stands in for the Runtime's
        work-start signal, which in production fires only after funding
        reaches chain finality (broadcast is not finality).
        """
        accepted = self.deals.get(data.get("termsHash", ""))
        if accepted is None:
            await event_queue.enqueue_event(_data_message({"kind": "error", "error": "unknown termsHash"}))
            return
        deal_id = data.get("dealId", "")
        terms_hash_ref = signing.terms_hash(accepted)

        # Evidence FIRST. Against a live Runtime this envelope goes to the
        # `evidence` interaction (§6.2.1) and the Runtime returns the id; the
        # Runtime then refuses a `delivered` citing anything it did not
        # register, so the order is not optional. With no Runtime here, the
        # envelope is built and signed for real and the id is synthesized.
        content = (
            "LAUNCH DAY: the product your agents have been waiting for is live. "
            "Composed per the signed brief."
        ).encode()
        envelope = extension.evidence_envelope(deal_id, terms_hash_ref, content, self.key)
        evidence_ref = self.evidence.setdefault(
            deal_id, "ev_" + envelope["submission"]["hash"].split(":", 1)[1][:12]
        )

        command, text = extension.make_delivery(
            accepted, deal_id,
            expected_revision=int(data.get("expectedRevision", 3)),
            evidence_ref=evidence_ref, priv=self.key,
        )
        await event_queue.enqueue_event(
            _data_message(
                {
                    "kind": "delivery",
                    "command": command,
                    "evidenceEnvelope": envelope,
                    "content": text,
                }
            )
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError("exchanges are single-turn in this example")
