"""A2A 1.0 executor for the seller.

Two surfaces on one A2A endpoint:

- plain text Parts        → off-protocol chat (nothing here enters the
  workflow or the audit chain);
- negotiation `raw` Parts → the demo's own peer protocol, carrying the typed,
  signed workflow objects between the two agents. `raw`, never `data` — §6.1:
  `data` is a google.protobuf.Value whose only number is a double, so integer
  members like expectedRevision would round-trip as 6.0 and break every
  signature.

The second surface uses extension.NEGOTIATION_MEDIA_TYPE, NOT the Extension's
command media type. What travels on it — request-terms, submit-proposal,
acceptance-request, request-delivery and the replies below — is a private
arrangement between these two agents; §6.2 defines the interactions a
Coordination Runtime serves, and none of these is one of them. The objects
INSIDE the negotiation (DealContract, AgreementCommand, the §6.2.1 party
envelope) are the normative part, and they are built to the published schemas.

The parties still opt in to the Extension BOTH ways (§2.2): the A2A-Extensions
header (surfaced as context.requested_extensions) and the message's extensions
array. They are negotiating an agreement to be executed under the Extension, so
declaring it is exactly what §2.2 asks of a participant — and it keeps the
demo exercising the handshake a Runtime performs. A negotiation request
arriving without both is rejected, not guessed at.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
import logging
import os
import time
from typing import Any
from uuid import uuid4

import a2a.types as a2a_types
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue

from . import coordination, extension, runtime_bind, settlement, signing

log = logging.getLogger("seller_agent.executor")


def _raw_message(
    data: dict[str, Any],
    media_type: str = extension.NEGOTIATION_MEDIA_TYPE,
) -> a2a_types.Message:
    """One reply: ROLE_AGENT, a single raw Part, and the activated Extension
    URI echoed in the extensions array (§2.2).

    `media_type` defaults to the demo's negotiation carrier because that is
    all this agent emits. It is a parameter rather than a constant so the same
    helper carries extension.COMMAND_MEDIA_TYPE unchanged for a reader wiring
    a §6.2 interaction to a real Coordination Runtime.
    """
    return a2a_types.Message(
        message_id=uuid4().hex,
        role=a2a_types.Role.ROLE_AGENT,
        parts=[a2a_types.Part(
            raw=json.dumps(data).encode(),
            media_type=media_type,
        )],
        extensions=[extension.EXTENSION_URI],
    )


def _text_message(text: str) -> a2a_types.Message:
    return a2a_types.Message(
        message_id=uuid4().hex,
        role=a2a_types.Role.ROLE_AGENT,
        parts=[a2a_types.Part(text=text)],
    )


class SellerExecutor(AgentExecutor):
    """Holds the seller's signing key and its deals."""

    def __init__(self) -> None:
        # KITE_COORDINATION_MODE=live drives the deal through the Runtime at
        # KITE_COORDINATION_ENDPOINT: real dealId, funding co-signature,
        # Runtime-issued evidenceId, and settlement anchors read back fresh.
        # The default stays standalone — the endpoint env has a non-empty
        # default (it is pinned into signed terms either way), so "is it set"
        # cannot distinguish a clone on a laptop from a deployment, and a
        # demo that phones home by default would be the wrong kind of example.
        self.live = os.environ.get("KITE_COORDINATION_MODE", "standalone").strip().lower() == "live"
        # The durable runtime key when one is configured, else an ephemeral
        # demo key. It has to be this key and not a separate one: §8 makes the
        # bound runtime key the thing a counterparty resolves from the DID to
        # check these signatures, and §4 makes its keccak address the party
        # the EscrowVault authorizes. Signing with an unbound key would leave
        # every signature unverifiable and every payout unaddressable — which
        # is why live mode FAILS CLOSED without one: a live seller minting a
        # fresh key per boot signs real deals nobody can resolve, and the
        # failure surfaces deals later, at settlement, instead of at start.
        durable = runtime_bind.load_runtime_key()
        if self.live and durable is None:
            raise RuntimeError(
                "KITE_COORDINATION_MODE=live requires a durable runtime key "
                "(SELLER_RUNTIME_PRIVATE_KEY or SELLER_RUNTIME_PRIVATE_KEY_FILE) — "
                "refusing to start against a real Runtime with an ephemeral key"
            )
        self.key = durable or extension.generate_demo_key()
        self.runtime: coordination.CoordinationClient | None = (
            coordination.CoordinationClient(
                extension.COORDINATION_ENDPOINT, extension.SELLER_AGENT_ID, self.key
            ) if self.live else None
        )
        # Verified chain context (chainId, escrowVault) per (agentCardHash,
        # runtimeAgentId) PIN — not one global slot: each agreement pins its
        # own card hash, and a second deal signed after the Runtime rotated
        # its card must verify ITS pin, not ride the first deal's answer.
        self._card_contexts: dict[tuple[str, str], tuple[int, str]] = {}
        # Bounded delivery-retry cadence. The engine's SendFulfillStart
        # activity completes on any successful reply and never re-sends, so
        # retrying a failed delivery is this side's job (see
        # _background_delivery).
        self.delivery_retry_seconds = int(os.environ.get("SELLER_DELIVERY_RETRY_SECONDS", "30"))
        # Deals whose delivery is already running, so a replayed §6.5
        # notification schedules one delivery, not one per replay.
        self._delivering: set[str] = set()
        self._background: set[Any] = set()
        # agent DID -> signing address, learned from the negotiation. This is
        # the demo's stand-in for Kite Identity (§8): a real seller resolves
        # the buyer's address FROM its DID, so the lookup is keyed by DID here
        # too and the address never has to ride inside a signed object.
        self.addresses: dict[str, str] = {}
        # dealId -> pending proposal awaiting the buyer's agreementSig.
        self.pending: dict[str, dict[str, Any]] = {}
        # termsHash -> accepted contract; dealId -> termsHash. A real seller
        # persists these.
        self.deals: dict[str, dict[str, Any]] = {}
        self.deal_terms: dict[str, str] = {}
        # dealId -> the evidence id the Runtime returned. The demo has no
        # Runtime, so it stands in for one; see _deliver.
        self.evidence: dict[str, str] = {}
        # dealId -> the agreement snapshot and state observations exposed by
        # the demo's public admin pages. This is intentionally process-local:
        # restarting the example seller clears the view along with its other
        # demo state.
        self._agreement_records: dict[str, dict[str, Any]] = {}

    def agreement_records(self) -> list[dict[str, Any]]:
        """Return isolated snapshots for the in-memory admin list."""
        records = deepcopy(list(self._agreement_records.values()))
        return sorted(records, key=lambda item: item["updatedAt"], reverse=True)

    def agreement_record(self, deal_id: str) -> dict[str, Any] | None:
        """Return one isolated snapshot for the in-memory admin detail page."""
        record = self._agreement_records.get(deal_id)
        return deepcopy(record) if record is not None else None

    async def refresh_agreement_records(self, deal_id: str | None = None) -> None:
        """Refresh known live agreements without making the Runtime inventory."""
        if self.runtime is None:
            return
        deal_ids = (
            [deal_id] if deal_id in self._agreement_records
            else list(self._agreement_records) if deal_id is None
            else []
        )

        async def refresh_one(known_deal_id: str) -> None:
            try:
                status = await self.runtime.status(known_deal_id)
            except Exception as exc:  # noqa: BLE001 — the admin view remains available with stale state
                log.warning("admin status refresh for %s failed: %s", known_deal_id, exc)
                return
            self._observe_agreement(
                known_deal_id, event="Status refreshed", status=status,
            )

        await asyncio.gather(*(refresh_one(known_deal_id) for known_deal_id in deal_ids))

    def _observe_agreement(
        self,
        deal_id: str,
        *,
        event: str,
        contract: dict[str, Any] | None = None,
        status: dict[str, Any] | None = None,
        state: str | None = None,
        detail: str | None = None,
    ) -> None:
        """Remember a seller-observed agreement state without persisting it."""
        if not deal_id:
            return
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        record = self._agreement_records.setdefault(deal_id, {
            "agreementId": deal_id,
            "state": "UNKNOWN",
            "revision": None,
            "contract": {},
            "termsHash": "",
            "latestStatus": {},
            "history": [],
            "createdAt": now,
            "updatedAt": now,
        })
        if contract is not None:
            record["contract"] = deepcopy(contract)
            record["termsHash"] = signing.terms_hash(contract)
        if status is not None:
            record["latestStatus"] = deepcopy(status)
        observed_state = state or (status or {}).get("state") or record["state"]
        revision = (status or {}).get("revision", record["revision"])
        record["state"] = str(observed_state)
        record["revision"] = revision
        record["updatedAt"] = now
        observation = {
            "event": event,
            "state": record["state"],
            "revision": revision,
            "observedAt": now,
        }
        if detail:
            observation["detail"] = detail
        history = record["history"]
        comparable = (event, record["state"], revision, detail)
        if not history or (
            history[-1].get("event"), history[-1].get("state"),
            history[-1].get("revision"), history[-1].get("detail"),
        ) != comparable:
            history.append(observation)

    def _negotiation_data(self, context: RequestContext) -> dict[str, Any] | None:
        """The decoded negotiation payload, or None for a plain-text exchange.

        §6.1 tells a Runtime to select the Part by its declared media type
        rather than by position when several raw Parts are present; the same
        rule applies to any typed carrier, so it is what picks this one.
        """
        message = context.message
        if message is None:
            return None
        for part in message.parts:
            if part.WhichOneof("content") == "raw" and part.media_type == extension.NEGOTIATION_MEDIA_TYPE:
                return json.loads(part.raw)
        return None

    def _extension_opted_in(self, context: RequestContext) -> bool:
        """§2.2: header (requested_extensions) AND message extensions array."""
        message = context.message
        return (
            extension.EXTENSION_URI in (context.requested_extensions or set())
            and message is not None
            and extension.EXTENSION_URI in list(message.extensions)
        )

    def _contract_message(self, context: RequestContext) -> dict[str, Any] | None:
        """The decoded §6.5 Runtime notification, or None. Selected by its own
        media type — that distinction is the reason the type exists."""
        message = context.message
        if message is None:
            return None
        for part in message.parts:
            if (part.WhichOneof("content") == "raw"
                    and part.media_type == extension.CONTRACT_MESSAGE_MEDIA_TYPE):
                return json.loads(part.raw)
        return None

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        note = self._contract_message(context)
        if note is not None:
            if not self._extension_opted_in(context):
                await event_queue.enqueue_event(_raw_message({
                    "kind": "error",
                    "error": "contract-message without §2.2 extension opt-in (A2A-Extensions header + message extensions array)",
                }))
                return
            await self._runtime_notification(note, event_queue)
            return
        data = self._negotiation_data(context)
        if data is None:
            await self._negotiate(context, event_queue)
            return
        if not self._extension_opted_in(context):
            await event_queue.enqueue_event(_raw_message({
                "kind": "error",
                "error": "negotiation request without §2.2 extension opt-in (A2A-Extensions header + message extensions array)",
            }))
            return
        handlers = {
            "request-terms": self._publish_terms,
            "submit-proposal": self._propose,
            "acceptance-request": self._countersign,
            "funding-request": self._funding,
            "request-delivery": self._deliver,
        }
        handler = handlers.get(data.get("kind", ""))
        if handler is None:
            await event_queue.enqueue_event(
                _raw_message({"kind": "error", "error": f"unknown kind {data.get('kind')!r}"})
            )
            return
        await handler(data, event_queue)

    async def _negotiate(self, context: RequestContext, event_queue: EventQueue) -> None:
        inquiry = context.get_user_input()
        quote = (
            f"Quote: one promotional post, {extension.QUOTE_AMOUNT_USDC} USDC, delivery within 48h, "
            "review window 24h (auto-confirm at expiry). Send final terms "
            f"for countersignature. (inquiry was: {inquiry!r})"
        )
        await event_queue.enqueue_event(_text_message(quote))

    @staticmethod
    async def _reject(event_queue: EventQueue, error: str, exc: Exception | None = None) -> None:
        """One error reply. A Runtime domain rejection keeps its catalog code
        and retriable flag, so the buyer can branch on the Runtime's own
        verdict instead of this demo's prose."""
        payload: dict[str, Any] = {"kind": "error", "error": error}
        if isinstance(exc, coordination.DomainRejection):
            payload["code"] = exc.code
            payload["retriable"] = exc.retriable
        await event_queue.enqueue_event(_raw_message(payload))

    def _binding_block(self) -> str | None:
        """Why live signing must refuse right now, or None.

        In live mode ONLY an active binding may sign. Passport verifies every
        formation, funding and delivery signature by recovering the address
        and comparing it against the DID's ACTIVE runtime binding — so a
        signature from a key Identity has never approved is refused whoever
        relays it. That includes `disabled`: a live seller without
        KITE_IDENTITY_BASE_URL is a misconfiguration whose every signature
        bounces, not a lighter deployment."""
        if not self.live:
            return None
        state = runtime_bind.STATUS.state
        if state != "active":
            return (
                f"runtime binding is {state} ({runtime_bind.STATUS.detail}) — refusing to sign: "
                "Passport checks every signature against the DID's ACTIVE runtime binding, so "
                "nothing this key signs is accepted until the binding is approved"
            )
        return None

    async def _runtime_chain_context(self, binding: dict[str, Any]) -> tuple[int, str]:
        """The Runtime's (chainId, escrowVault), from its VERIFIED card (§2.1).

        Cached per PIN — (agentCardHash, runtimeAgentId) — so a contract whose
        pin differs from anything seen before always verifies its OWN card
        fetch; a card the Runtime rotated (new chain, new vault) can never
        ride an earlier agreement's cached answer. Raises ValueError with the
        reason when the served card is not the pinned one."""
        key = (str(binding.get("agentCardHash") or ""), str(binding.get("runtimeAgentId") or ""))
        if key not in self._card_contexts:
            card = await self.runtime.fetch_runtime_card()
            self._card_contexts[key] = extension.validate_runtime_card(card, binding)
        return self._card_contexts[key]

    async def _runtime_notification(self, note: dict[str, Any], event_queue: EventQueue) -> None:
        """§6.5: a notification is advisory, NEVER authoritative. It carries no
        party signature and v1 gives the receiver no way to authenticate the
        Runtime as its origin, so nothing here acts on the payload — the state
        is read back from the Runtime itself, correlated by the notification's
        deal_id, and only a read-back that answers FULFILLING for a deal this
        seller countersigned is acknowledged.

        Every failure RAISES rather than replying: the relay in front of this
        (Passport → Temporal) treats any well-formed A2A reply as delivered
        and never retries, so a polite `acknowledged: false` message would
        convert a transient status-read failure into a permanently lost
        work-start signal. A JSON-RPC error is the only shape that keeps the
        retry loop alive.

        On a verified signal the seller STARTS THE WORK — delivery runs as a
        background task and its command goes to the Runtime directly. The
        buyer does not send a follow-up request; fulfilment is the seller's
        obligation, triggered by the Runtime's own state."""
        deal_id = str(note.get("deal_id") or "")
        if note.get("type") != "kite.contract.fulfill_started":
            raise RuntimeError(
                f"unknown notification type {note.get('type')!r} — v1 defines exactly one (§6.5)"
            )
        if self.runtime is None:
            raise RuntimeError(
                "standalone mode: no Runtime to read back from, and a notification "
                "MUST NOT be acted on directly (§6.5)"
            )
        terms_ref = self.deal_terms.get(deal_id)
        if terms_ref is None:
            raise RuntimeError(f"unknown dealId {deal_id!r} — nothing countersigned under it")
        # Byte equality, like every other 32-byte anchor comparison: the
        # engine's own model spells anchors either sha256:<hex> or 0x<hex>
        # depending on the surface, and the funding view already taught this
        # seller that lesson once.
        if note.get("terms_hash") and not settlement.bytes32_equal(str(note["terms_hash"]), terms_ref):
            raise RuntimeError(
                f"notification names terms {note['terms_hash']!r}, not the accepted {terms_ref!r}"
            )
        status = await self.runtime.status(deal_id)  # failure propagates as a JSON-RPC error
        if status.get("state") != "FULFILLING":
            raise RuntimeError(
                f"read-back says {deal_id} is {status.get('state')}, not FULFILLING — "
                "not acknowledging a work-start the Runtime does not report"
            )
        self._observe_agreement(
            deal_id, event="Fulfillment started", status=status,
        )
        if deal_id not in self._delivering:
            self._delivering.add(deal_id)
            # delivery_deadline is the engine's unix timestamp (int64 epoch
            # seconds — fulfill-engine model.A2AFulfillStartedMsg), advisory
            # like the rest of the payload, but the right bound for retries.
            try:
                deadline = int(note.get("delivery_deadline") or 0) or None
            except (TypeError, ValueError):
                deadline = None
            task = asyncio.create_task(self._background_delivery(deal_id, deadline))
            # Referenced until done, or the loop may garbage-collect it mid-run.
            self._background.add(task)
            task.add_done_callback(self._background.discard)
        await event_queue.enqueue_event(_raw_message(
            {"type": note.get("type"), "dealId": deal_id, "acknowledged": True,
             "verifiedState": status.get("state")},
            media_type=extension.CONTRACT_MESSAGE_MEDIA_TYPE,
        ))

    async def _background_delivery(self, deal_id: str, deadline: int | None) -> None:
        """The autonomous half of fulfil-on-notification, with the retries the
        engine will NOT provide: SendFulfillStart's activity completes on any
        successful reply and the workflow then only waits for
        kite.contract.delivered — the notification is never re-sent. So once
        this seller has acknowledged, a transient failure here (evidence,
        status, the command itself) is nobody's to retry but ours, and giving
        up early means the agreement times out into DEFAULTED.

        Bounded by the notification's delivery_deadline (fallback: six hours),
        and stopped early when the agreement is no longer FULFILLING — someone
        delivered, or the deal moved on, and retrying would only spam."""
        limit = deadline or int(time.time()) + 6 * 3600
        try:
            while True:
                try:
                    payload = await self._run_delivery(deal_id)
                    log.info("delivery for %s committed: evidence %s, state %s",
                             deal_id, payload.get("evidenceId"),
                             (payload.get("status") or {}).get("state"))
                    return
                except coordination.DomainRejection as exc:
                    # §7 puts `retriable` on the wire precisely so the client
                    # decides this: the Runtime has already said whether the
                    # same request can ever succeed. Replaying a non-retriable
                    # rejection (a spent commandId, a mismatched hash) burns
                    # the deadline on an answer that will not change.
                    if not exc.retriable:
                        log.error("delivery for %s refused as NOT retriable (%s) — stopping: %s",
                                  deal_id, exc.code, exc)
                        self._observe_agreement(
                            deal_id,
                            event="Delivery stopped",
                            detail=f"{exc.code}: {exc}",
                        )
                        return
                    log.warning("delivery attempt for %s rejected (%s, retriable): %s",
                                deal_id, exc.code, exc)
                except Exception as exc:  # noqa: BLE001 — transport/engine faults, retried below
                    log.warning("delivery attempt for %s failed: %s", deal_id, exc)
                try:
                    status = await self.runtime.status(deal_id)
                    state = status.get("state")
                    if state != "FULFILLING":
                        log.info("stopping delivery retries for %s: state is %s", deal_id, state)
                        self._observe_agreement(
                            deal_id, event="Delivery retries stopped", status=status,
                        )
                        return
                except Exception as exc:  # noqa: BLE001 — the probe failing is itself retriable
                    log.warning("status probe for %s failed: %s", deal_id, exc)
                if time.time() >= limit:
                    log.error(
                        "delivery for %s did not land before its deadline — the agreement "
                        "will time out into DEFAULTED", deal_id,
                    )
                    self._observe_agreement(
                        deal_id,
                        event="Delivery deadline reached",
                        detail="Delivery did not complete before the observed deadline.",
                    )
                    return
                await asyncio.sleep(self.delivery_retry_seconds)
        finally:
            self._delivering.discard(deal_id)

    async def _publish_terms(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """The payout address goes into the SIGNED terms, so the buyer has to
        know it before drafting. Publishing it is not a commitment;
        countersigning the contract that carries it is.

        The two signing addresses are exchanged here, in the demo's OWN
        negotiation, and not inside any workflow object: a §6.2 `proposal`
        carries the contract and nothing else, so an address smuggled in
        beside it would be rejected by the schema. A real deployment drops
        this exchange entirely and resolves both addresses from their DIDs
        through Kite Identity (§8).
        """
        buyer_agent_id, buyer_address = data.get("agentId"), data.get("address")
        if buyer_agent_id and buyer_address:
            self.addresses[buyer_agent_id] = buyer_address
        await event_queue.enqueue_event(_raw_message({
            "kind": "terms",
            "payoutAddress": extension.SELLER_PAYOUT_ADDRESS,
            "agentId": extension.SELLER_AGENT_ID,
            "address": signing.evm_address(self.key),
        }))

    async def _propose(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """Phase one of §4.1's two-phase formation: verify the buyer's
        formation signature, assign the deal id, and hand it back — the
        buyer's agreementSig can only exist once it knows this id. Against a
        live Runtime the id comes from the Runtime's proposal reply; the demo
        stands in for it."""
        if self.runtime is not None:
            # §6.2: `proposal` is the buyer's interaction, and the dealId that
            # matters is the one the RUNTIME assigns. A locally invented id
            # would produce an agreementSig over a digest no Runtime deal
            # matches — the buyer must submit the proposal there and come back
            # with the Runtime's id.
            await self._reject(event_queue, (
                "live mode: submit the proposal to the Runtime at "
                f"{extension.COORDINATION_ENDPOINT} (§6.2 — proposal is the buyer's interaction), "
                "then send acceptance-request carrying the Runtime-assigned dealId, the contract, "
                "and your buyerAgreementSig over that id"
            ))
            return
        try:
            contract = data["contract"]
            # Resolved from the contract's own buyerAgentId, the way a real
            # seller resolves it through Identity (§8) — never read out of the
            # message that carries the proposal. The demo's directory was
            # filled by the earlier request-terms exchange.
            buyer_address = self.addresses.get(contract["buyerAgentId"])
            if buyer_address is None:
                raise ValueError(
                    f"no signing address known for {contract['buyerAgentId']} — "
                    "the demo learns it from request-terms"
                )
            if len(contract.get("signatures", [])) != 1:
                raise ValueError("a proposal carries exactly one signature")
            if "agreementSig" in contract["signatures"][0]:
                raise ValueError("a proposal entry must not carry agreementSig (§4.1 two-phase rule)")
            computed = signing.terms_hash(contract)
            if not signing.verify_terms_signature(computed, contract["signatures"][0], buyer_address):
                raise ValueError("buyer terms signature does not verify against the recomputed termsHash")
        except (KeyError, ValueError) as exc:
            await event_queue.enqueue_event(_raw_message({"kind": "error", "error": str(exc)}))
            return
        deal_id = "deal_" + computed.split(":", 1)[1][:12]
        self.pending[deal_id] = {"contract": contract, "buyerAddress": buyer_address}
        self._observe_agreement(
            deal_id, event="Proposal received", contract=contract, state="PROPOSED",
        )
        await event_queue.enqueue_event(_raw_message({
            "kind": "proposal-ack",
            "dealId": deal_id,
        }))

    async def _countersign(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """Phase two: the buyer's §4.4 Agreement signature arrives; verify it,
        countersign the terms, and bind our own agreementSig next to it
        (spec §4.1 — both entries carry one on the accepted contract)."""
        if self.runtime is not None:
            await self._countersign_live(data, event_queue)
            return
        pending = self.pending.get(data.get("dealId", ""))
        if pending is None:
            await event_queue.enqueue_event(_raw_message({"kind": "error", "error": "unknown dealId"}))
            return
        try:
            accepted = extension.accept_terms(
                pending["contract"], pending["buyerAddress"],
                data["dealId"], data["buyerAgreementSig"], self.key,
            )
        except (KeyError, ValueError) as exc:
            await event_queue.enqueue_event(_raw_message({"kind": "error", "error": str(exc)}))
            return
        terms_hash_ref = signing.terms_hash(accepted)
        self.deals[terms_hash_ref] = accepted
        self.deal_terms[data["dealId"]] = terms_hash_ref
        self._observe_agreement(
            data["dealId"], event="Agreement accepted", contract=accepted, state="COMMITTED",
        )
        # `acceptance-result`, not `acceptance`: §6.2's `acceptance` is a
        # REQUEST a party sends to a Runtime, and this is a reply to a peer.
        # Reusing the name for a different message is how a demo shape gets
        # mistaken for the interaction it is not.
        await event_queue.enqueue_event(_raw_message({
            "kind": "acceptance-result",
            "contract": accepted,
            "dealId": data["dealId"],
        }))

    async def _countersign_live(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """Live phase two: the dealId is the RUNTIME's, so the proposal never
        passed through this seller — the contract must arrive here, and the
        deal's existence is verified against the Runtime before anything is
        signed. Countersigning against a status read is what makes the
        agreementSig bind a deal that actually exists rather than a claimed id.

        The acceptance is then submitted by this seller itself (§6.2 allows
        either party — authority is the contract's two signatures, not the
        sender), so the reply's `status` is the Runtime's own COMMITTED answer,
        not an unverified relay promise."""
        blocked = self._binding_block()
        if blocked is not None:
            await self._reject(event_queue, blocked)
            return
        deal_id = str(data.get("dealId") or "")
        contract = data.get("contract")
        if not deal_id or not isinstance(contract, dict):
            await self._reject(event_queue, (
                "live acceptance-request must carry the Runtime-assigned dealId AND the proposed "
                "contract — the proposal went to the Runtime, so this seller has never seen it"
            ))
            return
        buyer_address = self.addresses.get(contract.get("buyerAgentId", ""))
        if buyer_address is None:
            await self._reject(event_queue, (
                f"no signing address known for {contract.get('buyerAgentId')!r} — "
                "the demo learns it from request-terms"
            ))
            return
        try:
            status = await self.runtime.status(deal_id)
        except Exception as exc:  # noqa: BLE001
            await self._reject(event_queue, f"Runtime status read for {deal_id} failed: {exc}", exc)
            return
        if status.get("state") != "PROPOSED":
            await self._reject(event_queue, (
                f"deal {deal_id} is {status.get('state')}, not PROPOSED — acceptance countersigns "
                "a proposal, nothing later"
            ))
            return
        computed = signing.terms_hash(contract)
        # Byte equality, not string equality: the system mints both spellings
        # of a 32-byte anchor (sha256:<hex> on the coordination layer,
        # 0x<hex> on chain-adjacent views), and they name the same value.
        if status.get("termsHash") and not settlement.bytes32_equal(status["termsHash"], computed):
            await self._reject(event_queue, (
                "the Runtime holds different terms for this dealId than the contract presented — "
                f"refusing to countersign ({status['termsHash']} vs {computed})"
            ))
            return
        # The Agreement domain's chainId comes from the Runtime's VERIFIED
        # card (§2.1) — pinned by the contract's own agentCardHash — never
        # from local configuration: an agreementSig under the locally
        # configured chain is refused by the engine as an opaque signature
        # failure, after both parties thought they were done.
        try:
            chain_id, _escrow_vault = await self._runtime_chain_context(
                contract.get("runtimeBinding") or {}
            )
        except Exception as exc:  # noqa: BLE001
            await self._reject(event_queue, f"runtime card verification failed: {exc}", exc)
            return
        try:
            accepted = extension.accept_terms(
                contract, buyer_address, deal_id, data["buyerAgreementSig"], self.key,
                chain_id=chain_id,
            )
        except (KeyError, ValueError) as exc:
            await self._reject(event_queue, str(exc))
            return
        # Only retain the proposal after its Runtime binding and both buyer
        # signatures have verified. An invalid request must not populate the
        # public admin inventory.
        self._observe_agreement(
            deal_id, event="Proposal verified", contract=contract, status=status,
        )
        try:
            result = await self.runtime.submit_acceptance(deal_id, accepted)
        except Exception as exc:  # noqa: BLE001
            await self._reject(event_queue, f"Runtime refused the acceptance: {exc}", exc)
            return
        self.deals[computed] = accepted
        self.deal_terms[deal_id] = computed
        result_status = result.get("status") or {}
        self._observe_agreement(
            deal_id,
            event="Agreement accepted",
            contract=accepted,
            status=result_status,
            state="COMMITTED" if not result_status else None,
        )
        await event_queue.enqueue_event(_raw_message({
            "kind": "acceptance-result",
            "contract": accepted,
            "dealId": deal_id,
            "status": result_status,
        }))

    async def _funding(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """funding-request {dealId}: produce the seller's ONE funding artifact.

        §6.2.1 role binding: the seller may supply sellerActivationSig and
        nothing else. The Activation it signs is read back from the Runtime —
        never assembled locally — because the digest covers members only the
        Runtime aggregates (the buyer's wallet, the platform windows), and the
        EIP-712 domain (chainId/vaultAddress) MUST come from the same read.
        What IS checked locally is that the read-back Activation matches the
        terms this seller signed: same termsHash, same payout, same amount,
        and our own key's address as sellerAgent — co-signing an Activation
        that diverges from the accepted terms would authorize settlement of a
        different deal.
        """
        if self.runtime is None:
            await self._reject(event_queue, (
                "standalone mode has no Runtime to read the Activation from — funding needs "
                "KITE_COORDINATION_MODE=live"
            ))
            return
        blocked = self._binding_block()
        if blocked is not None:
            await self._reject(event_queue, blocked)
            return
        deal_id = str(data.get("dealId") or "")
        terms_ref = self.deal_terms.get(deal_id)
        if terms_ref is None:
            await self._reject(event_queue, f"unknown dealId {deal_id!r} — nothing countersigned under it")
            return
        accepted = self.deals[terms_ref]
        try:
            ctx = await self.runtime.funding(deal_id, terms_ref)
        except Exception as exc:  # noqa: BLE001
            await self._reject(event_queue, f"Runtime funding read failed: {exc}", exc)
            return
        self._observe_agreement(
            deal_id,
            event="Funding context read",
            state=str(ctx.get("phase") or "FUNDING"),
        )
        activation = ctx.get("activation") or {}
        if not activation.get("buyer"):
            # A normal stage, not an error: the buyer's wallet completes the
            # Activation, and until it lands there is no digest to sign.
            await event_queue.enqueue_event(_raw_message({
                "kind": "funding-state",
                "dealId": deal_id,
                "funding": ctx,
                "note": "activation is not yet signable (buyer wallet missing) — "
                        "ask again once the buyer's funding submission lands",
            }))
            return
        if not ctx.get("vaultAddress") or not ctx.get("chainId"):
            await self._reject(event_queue, (
                "funding context omits vaultAddress/chainId — the EIP-712 domain MUST come from "
                "this read (§6.2.1), so there is nothing safe to sign under"
            ))
            return
        problems = []
        # Byte equality: the engine's funding view spells this anchor 0x<hex>
        # while the accepted contract's is sha256:<hex> — same 32 bytes, and
        # word_bytes32 already treats them as one value for the signature.
        # A literal string comparison here refused every real deal.
        if not settlement.bytes32_equal(str(activation.get("termsHash") or ""), terms_ref):
            problems.append(f"termsHash {activation.get('termsHash')!r} is not the accepted {terms_ref!r}")
        payout = accepted["escrow"]["payoutAddress"]
        if str(activation.get("sellerPayout", "")).lower() != payout.lower():
            problems.append(f"sellerPayout {activation.get('sellerPayout')!r} is not the signed payout {payout!r}")
        our_address = signing.evm_address(self.key)
        if str(activation.get("sellerAgent", "")).lower() != our_address.lower():
            problems.append(f"sellerAgent {activation.get('sellerAgent')!r} is not this agent's key ({our_address})")
        try:
            # Two spellings of one number: the Activation's amount is ALREADY
            # base units ("24000000"), the contract's price is decimal
            # ("24.00"). Each goes through ITS OWN parser — running the
            # activation amount through the decimal conversion again would
            # compare 24000000·10^6 against 24·10^6 and refuse every deal.
            if settlement.base_units(str(activation.get("amount"))) != settlement.usdc_base_units(
                accepted["price"]["amount"]
            ):
                problems.append(f"amount {activation.get('amount')!r} is not the signed {accepted['price']['amount']!r}")
        except ValueError as exc:
            problems.append(f"amount: {exc}")
        if problems:
            await self._reject(event_queue, (
                "read-back Activation diverges from the accepted terms — refusing to co-sign: "
                + "; ".join(problems)
            ))
            return
        try:
            digest = settlement.activation_digest(
                activation["termsHash"], activation["buyer"], activation["buyerAgent"],
                activation["sellerAgent"], activation["sellerPayout"], activation["arbiter"],
                str(activation["amount"]),
                {k: int(activation[k]) for k in (
                    "fundingDeadline", "deliveryWindow", "deliveryConfirmationWindow",
                    "appealResponseWindow", "arbitrationWindow",
                )},
                chain_id=int(ctx["chainId"]), vault=str(ctx["vaultAddress"]),
            )
        except (KeyError, ValueError) as exc:
            await self._reject(event_queue, f"activation is not signable: {exc}")
            return
        try:
            status = await self.runtime.submit_funding_signatures(
                deal_id, terms_ref,
                {"sellerActivationSig": settlement.sign_digest32(self.key, digest)},
            )
        except Exception as exc:  # noqa: BLE001
            await self._reject(event_queue, f"Runtime refused the funding co-signature: {exc}", exc)
            return
        self._observe_agreement(
            deal_id, event="Seller funding signature submitted", status=status,
        )
        await event_queue.enqueue_event(_raw_message({
            "kind": "funding-result",
            "dealId": deal_id,
            "status": status,
        }))

    async def _deliver(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """spec §3 — deliver only on a deal we actually countersigned.

        Demo simplification: the buyer's request stands in for the Runtime's
        work-start signal, which in production fires only after funding
        reaches chain finality (broadcast is not finality).
        """
        if self.runtime is not None:
            await self._deliver_live(data, event_queue)
            return
        accepted = self.deals.get(data.get("termsHash", ""))
        if accepted is None:
            await event_queue.enqueue_event(_raw_message({"kind": "error", "error": "unknown termsHash"}))
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
        evidence_id = self.evidence.setdefault(
            deal_id, "ev_" + envelope["submission"]["hash"].split(":", 1)[1][:12]
        )

        command, text = extension.make_delivery(
            accepted, deal_id,
            expected_revision=int(data.get("expectedRevision", 3)),
            evidence_id=evidence_id, priv=self.key,
        )
        self._observe_agreement(
            deal_id, event="Delivery produced", state="DELIVERED",
        )
        await event_queue.enqueue_event(_raw_message({
            "kind": "delivery",
            "command": command,
            "evidenceEnvelope": envelope,
            "content": text,
        }))

    async def _deliver_live(self, data: dict[str, Any], event_queue: EventQueue) -> None:
        """Buyer-triggered live delivery. Live deals normally deliver on the
        Runtime's §6.5 work-start signal (see _runtime_notification), so this
        exists for retries and for driving the flow by hand; it runs the same
        pipeline and answers with the same payload."""
        deal_id = str(data.get("dealId") or "")
        try:
            payload = await self._run_delivery(deal_id)
        except Exception as exc:  # noqa: BLE001 — reported to the peer as a rejection
            await self._reject(event_queue, str(exc), exc)
            return
        await event_queue.enqueue_event(_raw_message(payload))

    async def _run_delivery(self, deal_id: str) -> dict[str, Any]:
        """Live delivery: every anchor is read back fresh, none invented.

        The order is forced by what refuses what (§6.2.1, §4.4):

        1. `status` — the deal must actually be FULFILLING (any notification
           that said so was advisory; this read is the authority), and it
           carries the anchors: the VAULT deal id (dealIdFor(Activation) — not
           the Runtime agreement id, conflating them is a bug), the vault's
           CURRENT nonce, and `latestProofHash`, the receipt anchor every
           settlement signature quotes. A nonce or receipt from a cache signs
           a transition the chain has already moved past.
        2. `evidence` — the envelope goes to the Runtime FIRST, because the
           Runtime refuses a `delivered` citing an evidenceId it never issued;
           a locally synthesized id is a claim, not evidence.
        3. `command` — the signed kite.contract.delivered, expectedRevision
           from the same status read, submitted to the Runtime.

        Raises on every failure; callers decide whether that becomes a peer
        rejection (_deliver_live) or a logged background retry
        (_background_delivery). Returns the delivery reply payload.
        """
        blocked = self._binding_block()
        if blocked is not None:
            raise RuntimeError(blocked)
        terms_ref = self.deal_terms.get(deal_id)
        if terms_ref is None:
            raise RuntimeError(f"unknown dealId {deal_id!r} — nothing countersigned under it")
        accepted = self.deals[terms_ref]
        status = await self.runtime.status(deal_id)
        if status.get("state") != "FULFILLING":
            raise RuntimeError(
                f"deal {deal_id} is {status.get('state')}, not FULFILLING — delivery starts on the"
                " Runtime's work-start, not on request"
            )
        self._observe_agreement(
            deal_id, event="Delivery started", status=status,
        )
        vault = status.get("vault") or {}
        receipt_hash = status.get("latestProofHash")
        if not vault.get("dealId") or vault.get("nonce") is None or not receipt_hash:
            raise RuntimeError(
                "status carries no vault block or proof anchor — a Delivery signature needs the"
                " vault dealId, the current nonce and latestProofHash (§4.4), and signing over"
                " invented ones fails only at broadcast"
            )
        content = (
            "LAUNCH DAY: the product your agents have been waiting for is live. "
            "Composed per the signed brief."
        ).encode()
        envelope = extension.evidence_envelope(deal_id, terms_ref, content, self.key)
        evidence_id = await self.runtime.submit_evidence_envelope(envelope)
        chain_id, vault_addr = vault.get("chainId"), vault.get("vaultAddress")
        if not chain_id or not vault_addr:
            # The vault block's domain members are optional; the funding
            # context's are not (§6.2.1 — the domain MUST come from a read).
            ctx = await self.runtime.funding(deal_id, terms_ref)
            chain_id, vault_addr = ctx["chainId"], ctx["vaultAddress"]
        command, text = extension.make_delivery(
            accepted, deal_id,
            expected_revision=int(status["revision"]),
            evidence_id=evidence_id, priv=self.key,
            anchors={
                "dealId32": vault["dealId"],
                "receiptHash": receipt_hash,
                "nonce": int(vault["nonce"]),
                # The SELLER's clock, never the requester's: expiry bounds the
                # window in which this signature can broadcast, and a peer able
                # to name it could ask for one already expired — an agreement
                # that reads DELIVERED while the on-chain markDelivered can
                # never succeed.
                "expiry": int(time.time()) + 3600,
                "chainId": int(chain_id),
                "vault": str(vault_addr),
            },
        )
        result = await self.runtime.submit_command(command)
        result_status = result.get("status") or {}
        self._observe_agreement(
            deal_id,
            event="Delivery submitted",
            status=result_status,
            state="DELIVERED" if not result_status else None,
        )
        return {
            "kind": "delivery",
            "command": command,
            "evidenceEnvelope": envelope,
            "evidenceId": evidence_id,
            "content": text,
            "status": result_status,
        }

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        raise NotImplementedError("exchanges are single-turn in this example")
