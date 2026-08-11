"""The LIVE agreement flow: buyer-equivalent + a verifying fake Runtime + seller.

test_transport_roundtrip proves the standalone demo; this proves the mode the
demo cannot: KITE_COORDINATION_MODE=live, where the dealId is the Runtime's,
the seller co-signs funding, work starts on a §6.5 notification whose content
is read back rather than trusted, and every settlement anchor in the delivery
signature is a value the Runtime issued.

The fake Runtime VERIFIES what it accepts — terms signatures, both §4.4
agreementSigs, the funding envelope, the sellerActivationSig over ITS OWN
Activation digest, and the sellerDeliverySig over ITS OWN anchors (vault deal
id, latestProofHash, nonce). That is the point of the test: a seller that
invented any of those values (the old demo behaviour) fails here, exactly as
it would against Passport.

The fake's chain context (chainId/vault) deliberately differs from
settlement.py's defaults, so a seller signing under its LOCAL configuration —
instead of the §6.2.1 read-back domain — is caught.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any
from uuid import uuid4

import httpx
import pytest

import a2a.types as a2a_types
from a2a.extensions.common import HTTP_EXTENSION_HEADER

from seller_agent import coordination, extension, runtime_bind, settlement, signing
from seller_agent.__main__ import build_app

SELLER_URL = "http://seller.test"
FAKE_RUNTIME_URL = extension.COORDINATION_ENDPOINT  # where the executor points its client

BUYER_ID = "did:kite:e2e:buyer"
DEAL_ID = "agr_e2e_0001"

# NOT settlement.py's defaults (2368 / 0xec…) — the seller must sign under the
# domain it READ BACK, or nothing here verifies.
CHAIN_ID = 5042002
VAULT_ADDR = "0x3e7cba53381d95c645b6f08a7e7b1602a52d1224"
VAULT_DEAL_ID = "0x" + "d1" * 32
PROOF_HASH = "sha256:" + "11" * 32
VAULT_NONCE = 7
ARBITER_ADDR = "0x" + "ab" * 20
WINDOWS = {
    "fundingDeadline": 1_900_000_000, "deliveryWindow": 172_800,
    "deliveryConfirmationWindow": 86_400, "appealResponseWindow": 86_400,
    "arbitrationWindow": 604_800,
}


def _domain_error(request_id: Any, code: str, message: str, retriable: bool) -> httpx.Response:
    return httpx.Response(200, json={
        "jsonrpc": "2.0", "id": request_id,
        "error": {"code": -32010, "message": message,
                  "data": {"code": code, "retriable": retriable}},
    })


RUNTIME_DID = "did:kite:corp-kite:kite-coordination-engine"

# The card the fake serves at /.well-known/agent-card.json — the §2.1 source
# of the chain context, carrying values that DIFFER from settlement.py's
# defaults so a seller signing under local configuration fails verification.
RUNTIME_CARD: dict[str, Any] = {
    "name": "Fake Coordination Runtime",
    "version": "1.0.0",
    "x-kite-registry": {"agentId": RUNTIME_DID},
    "capabilities": {"extensions": [{
        "uri": extension.EXTENSION_URI,
        "params": {"chainId": CHAIN_ID, "escrowVault": VAULT_ADDR,
                   "commandMediaType": extension.COMMAND_MEDIA_TYPE},
    }]},
}
# The REAL pin (§4.1): sha256 over the card's JCS canonical bytes — not the
# zero placeholder, so the seller's card verification has to actually run.
RUNTIME_CARD_HASH = signing.sha256_ref(signing.canonical_bytes(RUNTIME_CARD))


class FakeRuntime:
    """A §6.2/§6.3 Runtime edge that refuses anything it cannot verify."""

    def __init__(self, buyer_address: str, seller_address: str) -> None:
        self.buyer_address = buyer_address
        self.seller_address = seller_address
        self.state = "NONE"
        self.revision = 0
        self.contract: dict[str, Any] | None = None
        self.terms = ""
        self.buyer_wallet = ""
        self.seller_activation_sig = ""
        self.evidence: dict[str, str] = {}  # evidenceId -> deliveryHash
        self.delivered_command: dict[str, Any] | None = None
        self.status_reads = 0
        self.evidence_calls = 0
        # When set, the NEXT evidence submission is refused once — for the
        # bounded-retry test: the engine never re-sends fulfill_started, so a
        # transient failure here must be retried by the seller itself.
        self.fail_next_evidence = False

    # ── envelope / signature checks ──────────────────────────────────────

    def _verify_envelope(self, env: dict[str, Any]) -> str:
        actor = env["actorAgentId"]
        address = {BUYER_ID: self.buyer_address,
                   extension.SELLER_AGENT_ID: self.seller_address}.get(actor)
        assert address, f"envelope actor {actor} is not a party"
        unsigned = {k: v for k, v in env.items() if k != "signature"}
        assert signing.verify_signature(
            env["signature"]["sig"],
            signing.FUNDING_DOMAIN_TAG + signing.canonical_bytes(unsigned),
            address,
        ), f"party envelope signature does not verify for {actor}"
        assert env["termsHash"] == self.terms, "envelope termsHash is not the agreement's"
        return actor

    def _activation(self) -> dict[str, Any]:
        assert self.contract is not None
        return {
            # 0x-spelled, exactly as the real engine's funding view renders it
            # (the coordination layer says sha256:<hex>; chain-adjacent views
            # say 0x<hex> — same bytes). The fake once spelled it sha256: and
            # thereby hid a seller that compared the STRINGS: the first real
            # dev run refused every deal with "termsHash '0x…' is not the
            # accepted 'sha256:…'".
            "termsHash": "0x" + self.terms.removeprefix("sha256:"),
            "buyer": self.buyer_wallet,
            "buyerAgent": self.buyer_address,
            "sellerAgent": self.seller_address,
            "sellerPayout": self.contract["escrow"]["payoutAddress"],
            "arbiter": ARBITER_ADDR,
            # BASE UNITS — the wire form activation.schema.json pins
            # (^[0-9]+$), not the contract's decimal. Returning "24.00" here
            # is exactly the modelling error that once masked the seller's
            # double conversion.
            "amount": str(settlement.usdc_base_units(self.contract["price"]["amount"])),
            **WINDOWS,
        }

    def _status(self) -> dict[str, Any]:
        status: dict[str, Any] = {
            "dealId": DEAL_ID, "state": self.state, "revision": self.revision,
            "updatedAt": "2026-08-10T00:00:00Z", "termsHash": self.terms,
            "buyerAgentId": BUYER_ID, "sellerAgentId": extension.SELLER_AGENT_ID,
        }
        if self.state in ("FULFILLING", "DELIVERED"):
            status["latestProofHash"] = PROOF_HASH
            status["vault"] = {"dealId": VAULT_DEAL_ID, "nonce": VAULT_NONCE,
                               "vaultAddress": VAULT_ADDR, "chainId": CHAIN_ID,
                               "state": "FUNDED"}
        return status

    # ── the wire ─────────────────────────────────────────────────────────

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/.well-known/agent-card.json":
            return httpx.Response(200, json=RUNTIME_CARD)
        body = json.loads(request.content)
        assert body["method"] == "SendMessage"
        assert extension.EXTENSION_URI in request.headers.get(HTTP_EXTENSION_HEADER, "")
        message = body["params"]["message"]
        assert extension.EXTENSION_URI in message["extensions"]
        part = message["parts"][0]
        assert part["mediaType"] == extension.COMMAND_MEDIA_TYPE
        payload = json.loads(base64.b64decode(part["raw"]))

        try:
            reply = self.dispatch(payload)
        except DomainError as exc:
            return _domain_error(body["id"], exc.code, str(exc), exc.retriable)
        raw = base64.b64encode(json.dumps(reply).encode()).decode()
        return httpx.Response(200, json={
            "jsonrpc": "2.0", "id": body["id"],
            "result": {"message": {
                "role": "ROLE_AGENT", "messageId": uuid4().hex,
                "extensions": [extension.EXTENSION_URI],
                "parts": [{"raw": raw, "mediaType": extension.COMMAND_MEDIA_TYPE}],
            }},
        })

    def dispatch(self, payload: dict[str, Any]) -> dict[str, Any]:
        kind = payload.get("kind")
        if kind == "proposal":
            contract = payload["contract"]
            computed = signing.terms_hash(contract)
            sigs = contract["signatures"]
            assert len(sigs) == 1 and "agreementSig" not in sigs[0]
            assert signing.verify_terms_signature(computed, sigs[0], self.buyer_address)
            self.contract, self.terms = contract, computed
            self.state, self.revision = "PROPOSED", 1
            return {"kind": "agreement-result", "receipt": None, "status": self._status()}

        if kind == "status":
            self.status_reads += 1
            if payload.get("dealId") != DEAL_ID:
                raise DomainError("unknown_deal", f"unknown deal {payload.get('dealId')!r}")
            return {"kind": "agreement-status", "status": self._status()}

        if kind == "acceptance":
            assert payload["dealId"] == DEAL_ID and self.state == "PROPOSED"
            contract = payload["contract"]
            assert signing.terms_hash(contract) == self.terms, "acceptance changed the terms"
            entries = {e["signerAgentId"]: e for e in contract["signatures"]}
            assert set(entries) == {BUYER_ID, extension.SELLER_AGENT_ID}
            # Word by word, with the amount as a LITERAL — never through the
            # seller's own derivation helpers. A fake verifying with the code
            # under test agrees with any bug that code has (a double-converted
            # amount would double-convert on both sides and "verify"); the
            # engine derives independently, so the fake must too. Explicitly
            # under the CARD's chain: an agreementSig produced under
            # settlement.py's default (2368) fails here, as the engine would.
            digest = settlement.typed_digest(
                settlement.agreement_domain(CHAIN_ID),
                settlement.struct_hash(
                    settlement.AGREEMENT_TYPE,
                    settlement.agreement_id32(DEAL_ID),
                    settlement.word_bytes32(self.terms),
                    settlement.word_int(24_000_000),  # 24.00 USDC, 6-decimal base units
                    settlement.word_addr(self.buyer_address),
                    settlement.word_addr(self.seller_address),
                ),
            )
            for did, address in ((BUYER_ID, self.buyer_address),
                                 (extension.SELLER_AGENT_ID, self.seller_address)):
                assert signing.verify_terms_signature(self.terms, entries[did], address)
                assert settlement.verifies(digest, entries[did]["agreementSig"], address), \
                    f"{did} agreementSig does not verify over the REAL dealId digest"
            self.state, self.revision = "COMMITTED", 2
            return {"kind": "agreement-result", "receipt": None, "status": self._status()}

        if kind == "funding":
            self._verify_envelope(payload)
            return {"kind": "agreement-funding", "funding": {
                "activation": self._activation(),
                "vaultAddress": VAULT_ADDR, "chainId": CHAIN_ID, "phase": self.state,
                "haveBuyerWallet": bool(self.buyer_wallet),
                "haveBuyerActivationSig": False,
                "haveSellerActivationSig": bool(self.seller_activation_sig),
                "haveAuth3009": False, "haveExpectedDealId": False,
            }}

        if kind == "funding-signatures":
            actor = self._verify_envelope(payload)
            submission = payload["submission"]
            if actor == extension.SELLER_AGENT_ID:
                # §6.2.1 role binding: the seller's one artifact, nothing else.
                assert set(submission) == {"sellerActivationSig"}, \
                    f"seller submitted buyer fields: {sorted(submission)}"
                # Word by word with a literal amount, for the same reason the
                # Agreement digest above is: this is the exact digest the
                # engine's fund() derives, and the double-conversion this
                # guards against once hid precisely because both sides shared
                # one derivation helper.
                digest = settlement.typed_digest(
                    settlement.vault_domain(CHAIN_ID, VAULT_ADDR),
                    settlement.struct_hash(
                        settlement.ACTIVATION_TYPE,
                        settlement.word_bytes32(self.terms),
                        settlement.word_addr(self.buyer_wallet),
                        settlement.word_addr(self.buyer_address),
                        settlement.word_addr(self.seller_address),
                        settlement.word_addr(self.contract["escrow"]["payoutAddress"]),
                        settlement.word_addr(ARBITER_ADDR),
                        settlement.word_int(24_000_000),  # 24.00 USDC in base units
                        *(settlement.word_int(WINDOWS[k]) for k in (
                            "fundingDeadline", "deliveryWindow",
                            "deliveryConfirmationWindow", "appealResponseWindow",
                            "arbitrationWindow",
                        )),
                    ),
                )
                assert settlement.verifies(digest, submission["sellerActivationSig"],
                                           self.seller_address), \
                    "sellerActivationSig does not verify over the Runtime's own Activation digest"
                self.seller_activation_sig = submission["sellerActivationSig"]
            else:
                assert "sellerActivationSig" not in submission
                self.buyer_wallet = submission["buyerWallet"]
            if self.buyer_wallet and self.seller_activation_sig:
                # Funding complete: the fake stands in for chain finality.
                self.state, self.revision = "FULFILLING", 3
            return {"kind": "agreement-funding-accepted", "status": self._status()}

        if kind == "evidence":
            actor = self._verify_envelope(payload)
            assert actor == extension.SELLER_AGENT_ID, "evidence is the seller's alone (§6.2.1)"
            self.evidence_calls += 1
            if self.fail_next_evidence:
                self.fail_next_evidence = False
                raise DomainError("internal_error", "transient store failure — try again")
            evidence_id = f"ev_rt_{len(self.evidence) + 1:04d}"
            self.evidence[evidence_id] = payload["submission"]["hash"]
            return {"kind": "agreement-evidence-recorded", "evidenceId": evidence_id}

        if kind == "command":
            cmd = payload["command"]
            assert cmd["commandType"] == "kite.contract.delivered"
            assert cmd["dealId"] == DEAL_ID and self.state == "FULFILLING"
            assert cmd["expectedRevision"] == self.revision, \
                f"expectedRevision {cmd['expectedRevision']} != current {self.revision}"
            assert cmd["termsHash"] == self.terms
            assert signing.verify_command_signature(cmd, self.seller_address)
            body = cmd["payload"]
            assert body["evidenceId"] in self.evidence, \
                f"delivered cites {body['evidenceId']!r}, which this Runtime never issued"
            assert body["deliveryHash"] == self.evidence[body["evidenceId"]]
            # The expiry is the SELLER's clock, in a sane broadcast window —
            # a requester-controlled value could be already expired, leaving
            # DELIVERED recorded while markDelivered can never land.
            now = int(time.time())
            assert now + 600 < body["expiry"] <= now + 7200, \
                f"delivery expiry {body['expiry']} is not a seller-chosen ~1h horizon"
            digest = settlement.delivery_digest(
                VAULT_DEAL_ID, self.terms, body["deliveryHash"],
                receipt_hash=PROOF_HASH, nonce=VAULT_NONCE, expiry=body["expiry"],
                chain_id=CHAIN_ID, vault=VAULT_ADDR,
            )
            assert settlement.verifies(digest, body["sellerDeliverySig"], self.seller_address), \
                "sellerDeliverySig does not verify over the Runtime's anchors (§4.4)"
            self.delivered_command = cmd
            self.state, self.revision = "DELIVERED", 4
            return {"kind": "agreement-result", "receipt": None, "status": self._status()}

        raise AssertionError(f"unexpected interaction kind {kind!r}")


class DomainError(AssertionError):
    """A -32010 with a code from the PUBLIC catalog — the fake must speak the
    catalog's own vocabulary and retriable flags, or it tests a Runtime that
    does not exist."""

    # code -> retriable, verbatim from schemas/v1/error-catalog.json.
    CATALOG = {
        "unknown_deal": False,
        "internal_error": True,
        "idempotency_conflict": False,
        "evidence_not_validated": False,
    }

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        assert code in self.CATALOG, f"{code!r} is not in the published error catalog"
        self.code = code
        self.retriable = self.CATALOG[code]


# ── driving the seller over real A2A ────────────────────────────────────────

def _request(data: dict[str, Any], media_type: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0", "id": uuid4().hex, "method": "SendMessage",
        "params": {"message": {
            "messageId": uuid4().hex, "role": "ROLE_USER",
            "parts": [{"raw": base64.b64encode(json.dumps(data).encode()).decode(),
                       "mediaType": media_type}],
            "extensions": [extension.EXTENSION_URI],
        }},
    }


async def _exchange(
    http: httpx.AsyncClient, data: dict[str, Any],
    media_type: str = extension.NEGOTIATION_MEDIA_TYPE,
) -> dict[str, Any]:
    resp = await http.post("/a2a", json=_request(data, media_type))
    resp.raise_for_status()
    body = resp.json()
    assert "error" not in body or not body["error"], body
    message = body["result"]["message"]
    for part in message["parts"]:
        if part.get("mediaType") == media_type and part.get("raw"):
            return json.loads(base64.b64decode(part["raw"]))
    raise AssertionError(f"no {media_type} raw Part in seller reply: {message}")


@pytest.mark.asyncio
async def test_live_flow_against_a_verifying_runtime(monkeypatch) -> None:
    # The seller's durable key — known to the test so the fake can verify.
    seller_secret = "aa" * 32
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", seller_secret)
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())
    monkeypatch.setenv("KITE_COORDINATION_MODE", "live")
    # Retries back-to-back: the bounded-retry loop is exercised below and must
    # not sleep 30s in a test.
    monkeypatch.setenv("SELLER_DELIVERY_RETRY_SECONDS", "0")

    from coincurve import PrivateKey
    seller_address = signing.evm_address(PrivateKey(bytes.fromhex(seller_secret)))
    buyer_key = PrivateKey(bytes.fromhex("bb" * 32))
    buyer_address = signing.evm_address(buyer_key)

    fake = FakeRuntime(buyer_address, seller_address)
    fake_http = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    # Every CoordinationClient — the seller's internal one and the test's
    # buyer-side one — routes to the fake.
    monkeypatch.setattr(coordination.CoordinationClient, "_client", lambda self: fake_http)

    app = build_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=SELLER_URL, timeout=30,
        headers={HTTP_EXTENSION_HEADER: extension.EXTENSION_URI,
                 # Absent, the SDK server assumes an 0.3 caller and refuses.
                 "A2A-Version": "1.0"},
    ) as http:
        # Passport accepts a signature only when it recovers to the DID's
        # ACTIVE runtime binding, so live signing gates on exactly that state
        # — simulated here the way the real approval flips it.
        runtime_bind.STATUS.touch("active", "test: owner approved the binding")

        # 0. request-terms: swap addresses, learn the payout (demo stand-in
        #    for Identity resolution, same as standalone).
        intro = await _exchange(http, {
            "kind": "request-terms", "agentId": BUYER_ID, "address": buyer_address,
        })
        assert intro["address"] == seller_address, "seller must sign with its DURABLE key"

        # 1. live mode refuses to invent a dealId.
        contract = {
            "schema": "https://a2a.gokite.ai/schemas/deal-contract/v1",
            "template": "fixed_outcome/v1",
            "buyerAgentId": BUYER_ID,
            "sellerAgentId": extension.SELLER_AGENT_ID,
            "deliverable": "one promotional post recomposed from the signed brief",
            "acceptanceCriteria": "recomposes byte-exact from the signed brief",
            "price": {"amount": extension.QUOTE_AMOUNT_USDC, "asset": "USDC"},
            "escrow": {"payoutAddress": intro["payoutAddress"]},
            "disputePolicy": {"arbiterAgentId": RUNTIME_DID},
            "runtimeBinding": {
                "runtimeAgentId": RUNTIME_DID,
                # The REAL pin over the served card, not a placeholder: the
                # seller recomputes this hash from the bytes it fetches, and
                # takes the Agreement chainId from the card only if they match.
                "agentCardHash": RUNTIME_CARD_HASH,
                "extensionUri": extension.EXTENSION_URI,
                "endpoint": extension.COORDINATION_ENDPOINT,
            },
            "signatures": [],
        }
        terms_ref = signing.terms_hash(contract)
        contract["signatures"] = [signing.sign_terms(terms_ref, buyer_key, BUYER_ID)]

        refused = await _exchange(http, {"kind": "submit-proposal", "contract": contract})
        assert refused["kind"] == "error" and "Runtime" in refused["error"]

        # 2. the BUYER submits the proposal to the Runtime — real dealId.
        buyer_client = coordination.CoordinationClient(FAKE_RUNTIME_URL, BUYER_ID, buyer_key)
        proposed = await buyer_client.submit_proposal(contract)
        deal_id = proposed["status"]["dealId"]
        assert deal_id == DEAL_ID and proposed["status"]["state"] == "PROPOSED"

        # 3. acceptance-request with the Runtime's id; the seller verifies the
        #    deal against the Runtime, countersigns, and submits the acceptance
        #    itself. A bogus id dies on the status read, with the Runtime's code.
        bogus = await _exchange(http, {
            "kind": "acceptance-request", "dealId": "agr_invented", "contract": contract,
            "buyerAgreementSig": "0x" + "00" * 65,
        })
        assert bogus["kind"] == "error" and bogus.get("code") == "unknown_deal"

        # Under the CARD's chain (5042002), as a real buyer derives it from the
        # verified Runtime card — the local default (2368) would be refused.
        buyer_agreement_sig = settlement.sign_digest32(
            buyer_key,
            settlement.agreement_digest(
                deal_id, terms_ref, contract["price"]["amount"],
                buyer_address, seller_address, chain_id=CHAIN_ID,
            ),
        )
        accepted_reply = await _exchange(http, {
            "kind": "acceptance-request", "dealId": deal_id, "contract": contract,
            "buyerAgreementSig": buyer_agreement_sig,
        })
        assert accepted_reply["kind"] == "acceptance-result"
        assert accepted_reply["status"]["state"] == "COMMITTED", \
            "the reply must carry the Runtime's own answer, not a relay promise"
        assert fake.state == "COMMITTED"

        # 4. funding. Before the buyer's wallet lands the Activation is not
        #    signable, and the seller must SAY so rather than sign a gap.
        not_yet = await _exchange(http, {"kind": "funding-request", "dealId": deal_id})
        assert not_yet["kind"] == "funding-state"
        assert not fake.seller_activation_sig

        await buyer_client.submit_funding_signatures(
            deal_id, terms_ref, {"buyerWallet": buyer_address},
        )
        funded = await _exchange(http, {"kind": "funding-request", "dealId": deal_id})
        assert funded["kind"] == "funding-result"
        assert fake.seller_activation_sig, "the seller's co-signature must have landed"
        assert fake.state == "FULFILLING"

        # 5. §6.5 fulfill_started. A notification the seller cannot verify —
        #    unknown deal — must come back as a JSON-RPC ERROR, not a polite
        #    message: the relay in front (Passport → Temporal) treats any
        #    well-formed reply as delivered and never retries, so a message
        #    saying "not acknowledged" would permanently eat the signal.
        # delivery_deadline is the engine's int64 unix timestamp
        # (fulfill-engine model.A2AFulfillStartedMsg), not an RFC 3339 string.
        deadline = int(time.time()) + 86_400
        bad_note = await http.post("/a2a", json=_request(
            {"type": "kite.contract.fulfill_started", "deal_id": "agr_forged",
             "terms_hash": terms_ref, "delivery_deadline": deadline},
            extension.CONTRACT_MESSAGE_MEDIA_TYPE,
        ))
        assert bad_note.json().get("error"), \
            "an unverifiable notification must be a JSON-RPC error so the Runtime retries"
        assert fake.state == "FULFILLING", "a forged notification must change nothing"

        #    The genuine signal: read back, acknowledged with the Runtime's own
        #    state — and the WORK STARTS. Delivery is the seller's obligation
        #    on the Runtime's work-start; the buyer sends no follow-up request.
        #    The first evidence submission FAILS on purpose: SendFulfillStart
        #    completes on this ack and the engine never re-sends, so the retry
        #    that saves the agreement has to be the seller's own.
        fake.fail_next_evidence = True
        reads_before = fake.status_reads
        ack = await _exchange(http, {
            "type": "kite.contract.fulfill_started", "deal_id": deal_id,
            "terms_hash": terms_ref, "delivery_deadline": deadline,
        }, media_type=extension.CONTRACT_MESSAGE_MEDIA_TYPE)
        assert ack["acknowledged"] is True and ack["verifiedState"] == "FULFILLING"
        assert fake.status_reads > reads_before, \
            "a §6.5 notification MUST be read back, never trusted"

        # 6. the autonomous delivery lands: Runtime-issued evidenceId, Runtime
        #    anchors, Runtime answer — with no request-delivery from the buyer.
        for _ in range(500):
            if fake.state == "DELIVERED":
                break
            await asyncio.sleep(0)
        assert fake.state == "DELIVERED", "fulfill_started must start the work"
        assert fake.delivered_command is not None
        assert fake.delivered_command["payload"]["evidenceId"] in fake.evidence
        assert fake.evidence_calls == 2, \
            "the failed first attempt must have been retried by the seller itself"

        # 7. a replayed notification neither double-delivers nor errors the
        #    retry loop into oblivion: the deal has moved past FULFILLING, so
        #    the read-back now refuses it — visible to the Runtime as an error,
        #    harmless to the agreement.
        replay = await http.post("/a2a", json=_request(
            {"type": "kite.contract.fulfill_started", "deal_id": deal_id,
             "terms_hash": terms_ref, "delivery_deadline": "2026-08-12T00:00:00Z"},
            extension.CONTRACT_MESSAGE_MEDIA_TYPE,
        ))
        assert replay.json().get("error")
        assert fake.state == "DELIVERED"

    await fake_http.aclose()


@pytest.mark.asyncio
async def test_non_retriable_rejection_stops_delivery_retries(monkeypatch) -> None:
    """§7 puts `retriable` on the wire so the CLIENT decides: a Runtime that
    answered idempotency_conflict has said the same request can never succeed,
    and replaying it just burns the delivery deadline on an unchanging answer.
    A retriable internal_error, by contrast, keeps the loop alive — asserted
    in the main flow test, whose transient failure uses exactly that code."""
    from seller_agent.executor import SellerExecutor

    monkeypatch.setenv("KITE_COORDINATION_MODE", "live")
    monkeypatch.setenv("SELLER_DELIVERY_RETRY_SECONDS", "0")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", "dd" * 32)
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())
    runtime_bind.STATUS.touch("active", "test: owner approved the binding")

    executor = SellerExecutor()
    terms_ref = "sha256:" + "ee" * 32
    executor.deal_terms[DEAL_ID] = terms_ref
    executor.deals[terms_ref] = {"escrow": {"payoutAddress": "0x" + "33" * 20},
                                 "price": {"amount": "24.00", "asset": "USDC"}}

    class StubRuntime:
        def __init__(self) -> None:
            self.evidence_attempts = 0

        async def status(self, deal_id: str) -> dict[str, Any]:
            return {"dealId": deal_id, "state": "FULFILLING", "revision": 3,
                    "updatedAt": "2026-08-10T00:00:00Z", "latestProofHash": PROOF_HASH,
                    "vault": {"dealId": VAULT_DEAL_ID, "nonce": VAULT_NONCE,
                              "vaultAddress": VAULT_ADDR, "chainId": CHAIN_ID}}

        async def submit_evidence_envelope(self, envelope: dict[str, Any]) -> str:
            self.evidence_attempts += 1
            raise coordination.DomainRejection(
                "idempotency_conflict", "already used with different content",
                retriable=False, data={},
            )

    stub = StubRuntime()
    executor.runtime = stub  # type: ignore[assignment]

    # Deadline far away and zero retry sleep: only the retriable verdict can
    # be what stops this after one attempt. The wait_for is the regression
    # guard's own guard — a loop that ignores the verdict would otherwise spin
    # toward the 24h deadline and HANG the suite instead of failing it.
    await asyncio.wait_for(
        executor._background_delivery(DEAL_ID, deadline=int(time.time()) + 86_400),
        timeout=5,
    )
    assert stub.evidence_attempts == 1, \
        "a non-retriable rejection must stop the retry loop immediately (§7)"


@pytest.mark.asyncio
async def test_live_mode_without_a_durable_key_fails_closed(monkeypatch) -> None:
    """A live seller minting a fresh key per boot signs real deals nobody can
    resolve — the failure must be at startup, not at settlement."""
    monkeypatch.setenv("KITE_COORDINATION_MODE", "live")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", "")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY_FILE", "")
    with pytest.raises(RuntimeError, match="durable runtime key"):
        build_app()


@pytest.mark.asyncio
async def test_live_signing_requires_an_active_binding(monkeypatch) -> None:
    """Passport verifies every signature against the DID's ACTIVE runtime
    binding — so in live mode nothing signs until the binding is active.
    That includes `disabled` (no Identity configured): a live seller without
    Identity is a misconfiguration whose every signature bounces, not a
    lighter deployment."""
    monkeypatch.setenv("KITE_COORDINATION_MODE", "live")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", "cc" * 32)
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())
    app = build_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=SELLER_URL, timeout=30,
        headers={HTTP_EXTENSION_HEADER: extension.EXTENSION_URI, "A2A-Version": "1.0"},
    ) as http:
        request = {"kind": "acceptance-request", "dealId": "agr_x", "contract": {},
                   "buyerAgreementSig": "0x00"}
        # Startup left the binding `disabled` (no KITE_IDENTITY_BASE_URL).
        refused = await _exchange(http, request)
        assert refused["kind"] == "error" and "binding is disabled" in refused["error"]
        runtime_bind.STATUS.touch("pending", "awaiting owner approval")
        refused = await _exchange(http, request)
        assert refused["kind"] == "error" and "binding is pending" in refused["error"]
