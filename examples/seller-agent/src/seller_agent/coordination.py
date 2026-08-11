"""§6 client for a Coordination Runtime (e.g. the Kite Passport persona).

This is the seller's *outbound* leg: the executor answers the buyer over A2A,
and uses this to talk to the Runtime named in the signed terms — reading
status and funding context, delivering its funding co-signature, registering
evidence, and submitting signed commands. Same rules as the rest of the
example: httpx plus the bundle's own signing helpers, no Kite SDK.

Wire shape (§6.1/§6.3): a JSON-RPC 2.0 `SendMessage` whose single Part is the
interaction payload in `raw` (base64), tagged with the command media type, and
opted in BOTH ways (§2.2 — the A2A-Extensions header and the message's
`extensions` array). The reply payload rides the same way inside
`result.message.parts`. Payloads travel in `raw`, never in a `data` Part: a
proto Struct holds only doubles, so integer members like `expectedRevision`
would round-trip as 6.0 and break every signature over the canonical bytes.

Domain rejections (§7): `-32010` carries a catalog code plus `retriable`, and
is surfaced as DomainRejection so the executor can answer the buyer with the
Runtime's own code rather than prose. `-32003` (engine unreachable) is
EngineUnreachable — a deployment state, not a caller error.
"""

from __future__ import annotations

import base64
import json
from typing import Any
from uuid import uuid4

import httpx
from a2a.extensions.common import HTTP_EXTENSION_HEADER
from coincurve import PrivateKey

from . import signing
from .extension import COMMAND_MEDIA_TYPE, EXTENSION_URI


class DomainRejection(RuntimeError):
    """A -32010 rejection: well-formed, decoded, and refused (§7)."""

    def __init__(self, code: str, message: str, retriable: bool, data: dict[str, Any]):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.retriable = retriable
        self.data = data


class EngineUnreachable(RuntimeError):
    """-32003: the Runtime's engine is not reachable behind its edge."""


class CoordinationClient:
    """One agreement party's view of a Runtime's §6.2 interactions.

    `http` is injectable for tests; by default a client is created lazily and
    kept for connection reuse. Party-scoped reads (`funding`, `proofs`) are
    signed here with the agent's own key — the same key the executor signs
    commands with, because §8 gives an agent exactly one.
    """

    def __init__(
        self,
        endpoint: str,
        agent_id: str,
        priv: PrivateKey,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.endpoint = endpoint
        self.agent_id = agent_id
        self._priv = priv
        self._http = http

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30.0)
        return self._http

    async def _call(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = uuid4().hex
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "SendMessage",
            "params": {"message": {
                "messageId": uuid4().hex,
                "role": "ROLE_USER",
                "parts": [{
                    "raw": base64.b64encode(json.dumps(payload).encode()).decode(),
                    "mediaType": COMMAND_MEDIA_TYPE,
                }],
                "extensions": [EXTENSION_URI],
            }},
        }
        resp = await self._client().post(
            self.endpoint, json=request, headers={HTTP_EXTENSION_HEADER: EXTENSION_URI}
        )
        resp.raise_for_status()
        body = resp.json()
        # JSON-RPC discipline before reading anything out of the reply: the
        # version marker, and the id echo — a response to someone else's call
        # must never be read as the answer to ours.
        if body.get("jsonrpc") != "2.0":
            raise RuntimeError(f"reply is not JSON-RPC 2.0: {body.get('jsonrpc')!r}")
        if body.get("id") != request_id:
            raise RuntimeError(f"reply id {body.get('id')!r} does not match request {request_id!r}")
        if body.get("error"):
            err = body["error"]
            data = err.get("data") or {}
            if err.get("code") == -32010:
                raise DomainRejection(
                    str(data.get("code") or "domain_error"),
                    str(err.get("message") or ""),
                    bool(data.get("retriable")),
                    data,
                )
            if err.get("code") == -32003:
                raise EngineUnreachable(str(err.get("message") or "engine not reachable"))
            raise RuntimeError(f"runtime rejected the call ({err.get('code')}): {err.get('message')}")
        message = (body.get("result") or {}).get("message") or {}
        # §2.2 both ways: the reply message must echo the activated extension,
        # and it speaks as the agent. A reply missing the echo is a peer that
        # never activated the extension — its payload is not a §6.3 answer.
        if EXTENSION_URI not in (message.get("extensions") or []):
            raise RuntimeError("runtime reply does not echo the activated extension (§2.2)")
        if message.get("role") != "ROLE_AGENT":
            raise RuntimeError(f"runtime reply role is {message.get('role')!r}, not ROLE_AGENT")
        for part in message.get("parts") or []:
            if part.get("mediaType") == COMMAND_MEDIA_TYPE and part.get("raw"):
                return json.loads(base64.b64decode(part["raw"]))
        raise RuntimeError("runtime reply carries no extension raw Part (§6.3)")

    @staticmethod
    def _expect(reply: dict[str, Any], kind: str) -> dict[str, Any]:
        if reply.get("kind") != kind:
            raise RuntimeError(f"expected a {kind} reply, got {reply.get('kind')!r}")
        return reply

    def _envelope(
        self, kind: str, deal_id: str, terms_hash: str, extra: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """A §6.2.1 party envelope, `kind` inside the signed bytes."""
        return signing.sign_party_envelope(
            {"kind": kind, "dealId": deal_id, "actorAgentId": self.agent_id,
             "termsHash": terms_hash, **(extra or {})},
            self._priv, self.agent_id,
        )

    # ── reads ────────────────────────────────────────────────────────────

    async def fetch_runtime_card(self) -> dict[str, Any]:
        """The Runtime's Agent Card, from the endpoint's origin (§2). Raw JSON
        rather than the SDK parser: `x-kite-registry` is a Kite extension field
        a proto parse would drop, and `agentCardHash` must cover the exact
        bytes the Runtime serves."""
        url = httpx.URL(self.endpoint).copy_with(path="/.well-known/agent-card.json", query=None)
        resp = await self._client().get(str(url))
        resp.raise_for_status()
        return resp.json()

    async def status(self, deal_id: str) -> dict[str, Any]:
        """The AgreementStatus — state, revision, latestProofHash, and the
        vault block every settlement signature anchors to (§4.4)."""
        reply = await self._call({"kind": "status", "dealId": deal_id})
        return self._expect(reply, "agreement-status")["status"]

    async def funding(self, deal_id: str, terms_hash: str) -> dict[str, Any]:
        """The FundingContext: the Activation to sign, WHICH artifacts have
        arrived, and the EIP-712 domain (vaultAddress/chainId) — a party MUST
        take the domain from here rather than from its own configuration."""
        reply = await self._call(self._envelope("funding", deal_id, terms_hash))
        return self._expect(reply, "agreement-funding")["funding"]

    async def proofs(self, deal_id: str, terms_hash: str) -> list[dict[str, Any]]:
        reply = await self._call(self._envelope("proofs", deal_id, terms_hash))
        return self._expect(reply, "agreement-proofs")["proofs"]

    # ── writes ───────────────────────────────────────────────────────────

    async def submit_proposal(self, contract: dict[str, Any]) -> dict[str, Any]:
        """§6.2 `proposal` (the buyer's interaction): final terms with the
        first signature. The reply's status carries the Runtime-assigned
        dealId — the id every later signature commits to."""
        reply = await self._call({"kind": "proposal", "contract": contract})
        return self._expect(reply, "agreement-result")

    async def submit_acceptance(self, deal_id: str, contract: dict[str, Any]) -> dict[str, Any]:
        """§6.2 `acceptance`: the countersigned contract. The sender is not
        authenticated — authority derives from the contract's two signatures —
        so either party (or a relay) may deliver it."""
        reply = await self._call({"kind": "acceptance", "dealId": deal_id, "contract": contract})
        return self._expect(reply, "agreement-result")

    async def submit_funding_signatures(
        self, deal_id: str, terms_hash: str, submission: dict[str, Any]
    ) -> dict[str, Any]:
        """Deliver this party's funding artifacts (§6.2.1). Role binding is the
        Runtime's to enforce — a seller may supply sellerActivationSig and
        nothing else; the buyer its own fields only. Returns the
        AgreementStatus."""
        reply = await self._call(self._envelope(
            "funding-signatures", deal_id, terms_hash, {"submission": submission},
        ))
        return self._expect(reply, "agreement-funding-accepted")["status"]

    async def submit_evidence_envelope(self, envelope: dict[str, Any]) -> str:
        """Register a delivery artifact; returns the Runtime-issued evidenceId
        — the ONLY id a `delivered` command may cite (§6.2.1). Takes the
        pre-signed envelope so the bytes submitted are exactly the bytes the
        executor also hands the buyer."""
        reply = await self._call(envelope)
        return str(self._expect(reply, "agreement-evidence-recorded")["evidenceId"])

    async def submit_command(self, command: dict[str, Any]) -> dict[str, Any]:
        """Submit a signed AgreementCommand (§6.2 `command`). Returns the
        agreement-result payload; `receipt` is always null in v1 — the proof
        chain is the transition evidence, not a synchronous receipt."""
        reply = await self._call({"kind": "command", "command": command})
        return self._expect(reply, "agreement-result")
