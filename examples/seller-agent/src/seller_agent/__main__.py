"""Seller agent entry point: an A2A server whose Agent Card declares the
Kite Coordination Extension.

`required: false` on a PARTICIPANT card (unlike the Coordination Engine's
own card): the seller stays interoperable for unrelated A2A work; the
Extension's requirements become mandatory only for a deal both parties have
signed under it.
"""

from __future__ import annotations

import os

import uvicorn
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentExtension, AgentSkill

from .executor import SellerExecutor
from .extension import EXTENSION_URI, COMMAND_MEDIA_TYPE
from .home import homepage_route

HOST = os.environ.get("SELLER_HOST", "0.0.0.0")
PORT = int(os.environ.get("SELLER_PORT", "9999"))
PUBLIC_URL = os.environ.get("SELLER_PUBLIC_URL", f"http://localhost:{PORT}/")
RPC_PATH = "/a2a"


def agent_card() -> AgentCard:
    return AgentCard(
        name="Example Seller Agent",
        description="Non-normative example seller for the A2A Kite Coordination Extension",
        url=PUBLIC_URL.rstrip("/") + RPC_PATH,
        version="0.0.1",
        default_input_modes=["text"],
        default_output_modes=["text"],
        capabilities=AgentCapabilities(
            streaming=False,
            extensions=[
                AgentExtension(
                    uri=EXTENSION_URI,
                    description="Can countersign terms and execute agreements via the Kite Coordination Engine",
                    required=False,
                    params={"commandMediaType": COMMAND_MEDIA_TYPE, "templates": ["fixed_outcome/v1"]},
                )
            ],
        ),
        skills=[
            AgentSkill(
                id="quote-service",
                name="Quote a promotional post",
                description="Negotiate price and terms for one promotional post (off-protocol chat)",
                tags=["negotiation", "quote"],
            )
        ],
    )


def main() -> None:
    card = agent_card()
    handler = DefaultRequestHandler(agent_executor=SellerExecutor(), task_store=InMemoryTaskStore())
    server = A2AStarletteApplication(agent_card=card, http_handler=handler)
    app = server.build(rpc_url=RPC_PATH, routes=[homepage_route(card)])
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
