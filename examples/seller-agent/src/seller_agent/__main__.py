"""Seller agent entry point: an A2A 1.0 server whose Agent Card declares the
Kite Coordination Extension.

`required: false` on a PARTICIPANT card (unlike the Coordination Engine's
own card): the seller stays interoperable for unrelated A2A work; the
Extension's requirements become mandatory only for a deal both parties have
signed under it.

The transport is the JSON-RPC 2.0 binding of A2A 1.0 — `POST` SendMessage
with ProtoJSON bodies, exactly the shape spec §6 pins. The server echoes the
`A2A-Extensions` header on every response whose request carried it (§2.2).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import a2a.types as a2a_types
import uvicorn
from a2a.extensions.common import HTTP_EXTENSION_HEADER
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.request_handlers.response_helpers import agent_card_to_dict
from a2a.server.routes import create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.utils import TransportProtocol
from google.protobuf import json_format
from google.protobuf.struct_pb2 import Struct
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route

from . import extension, runtime_bind, settlement
from .executor import SellerExecutor
from .extension import COMMAND_MEDIA_TYPE, EXTENSION_URI
from .home import AGENT_CARD_PATH, admin_routes, homepage_route

HOST = os.environ.get("SELLER_HOST", "0.0.0.0")
PORT = int(os.environ.get("SELLER_PORT", "9999"))
PUBLIC_URL = os.environ.get("SELLER_PUBLIC_URL", f"http://localhost:{PORT}/")
RPC_PATH = "/a2a"


def agent_card() -> a2a_types.AgentCard:
    return a2a_types.AgentCard(
        name="Example Seller Agent",
        description="Non-normative example seller for the A2A Kite Coordination Extension",
        version="0.0.1",
        supported_interfaces=[
            a2a_types.AgentInterface(
                url=PUBLIC_URL.rstrip("/") + RPC_PATH,
                protocol_binding=TransportProtocol.JSONRPC,
                protocol_version="1.0",
            )
        ],
        default_input_modes=["text"],
        default_output_modes=["text"],
        capabilities=a2a_types.AgentCapabilities(
            streaming=False,
            extensions=[
                a2a_types.AgentExtension(
                    uri=EXTENSION_URI,
                    description="Can countersign terms and execute agreements via the Kite Coordination Engine",
                    required=False,
                    # chainId/escrowVault are §2.1 Runtime-card params (the
                    # §4.4 domain parameters). The demo seller stands in for
                    # the Runtime, so it publishes them the same way.
                    params=json_format.ParseDict(
                        {
                            "commandMediaType": COMMAND_MEDIA_TYPE,
                            "templates": ["fixed_outcome/v1"],
                            "signatureProfiles": ["secp256k1-keccak-v1"],
                            "chainId": settlement.CHAIN_ID,
                            "escrowVault": settlement.VAULT_ADDRESS,
                        },
                        Struct(),
                    ),
                )
            ],
        ),
        skills=[
            a2a_types.AgentSkill(
                id="quote-service",
                name="Quote a promotional post",
                description="Negotiate price and terms for one promotional post (off-protocol chat)",
                tags=["negotiation", "quote"],
            )
        ],
    )


class EchoExtensionsHeader(BaseHTTPMiddleware):
    """§2.2: the activated extension URI is echoed in the A2A-Extensions
    response header. The SDK surfaces the REQUESTED extensions to the executor
    but does not write the response header itself, so the echo lives here."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        requested = request.headers.get(HTTP_EXTENSION_HEADER)
        if requested and EXTENSION_URI in requested:
            response.headers[HTTP_EXTENSION_HEADER] = EXTENSION_URI
        return response


def card_json(card: a2a_types.AgentCard) -> dict:
    """The served Agent Card, with the Kite registry binding attached.

    `x-kite-registry.agentId` is how a counterparty gets from this card to the
    DID whose Identity record holds the signing key — buyer-agent reads exactly
    this field to fill the §4.1 `runtimeBinding.runtimeAgentId` pin. It is a
    Kite extension field, outside the A2A proto, so it cannot ride on the
    AgentCard message: the SDK's proto serialization would drop it. Hence the
    dict is built by the SDK and the field merged on top, rather than the whole
    card being hand-rolled — the A2A-defined half stays the SDK's business.

    The card is served as these exact bytes, which matters beyond cosmetics:
    §4.1's `agentCardHash` is sha256 over their JCS canonical form, so a
    counterparty's pin covers the registry binding too.
    """
    return {**agent_card_to_dict(card), "x-kite-registry": {"agentId": extension.SELLER_AGENT_ID}}


def agent_card_route(card: a2a_types.AgentCard) -> Route:
    body = card_json(card)

    async def serve_card(_request) -> JSONResponse:
        return JSONResponse(body)

    return Route(AGENT_CARD_PATH, serve_card, methods=["GET"], name="agent_card")


def build_app(
    card: a2a_types.AgentCard | None = None,
    executor: SellerExecutor | None = None,
) -> Starlette:
    card = card or agent_card()
    executor = executor or SellerExecutor()
    handler = DefaultRequestHandler(
        agent_executor=executor,
        task_store=InMemoryTaskStore(),
        agent_card=card,
    )
    routes = [
        homepage_route(card),
        *admin_routes(executor),
        agent_card_route(card),
        *create_jsonrpc_routes(request_handler=handler, rpc_url=RPC_PATH),
    ]

    @asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        """§8 binding is optional and must never gate serving, so the task is
        started and not awaited — it outlives startup on purpose, polling until
        an owner approves. See runtime_bind for why it polls rather than
        re-registering. Cancelled on shutdown so the process can exit."""
        task = runtime_bind.start(extension.SELLER_AGENT_ID)
        try:
            yield
        finally:
            if task is not None:
                task.cancel()

    return Starlette(
        routes=routes,
        middleware=[Middleware(EchoExtensionsHeader)],
        lifespan=lifespan,
    )


def main() -> None:
    uvicorn.run(build_app(), host=HOST, port=PORT)


if __name__ == "__main__":
    main()
