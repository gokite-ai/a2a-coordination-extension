"""Human-readable home page for the seller agent.

The A2A surfaces (`/`, `/.well-known/agent-card.json`) are machine-readable
only — this gives a visiting human something to look at, and a visible link
into the machine-readable Agent Card.
"""

from __future__ import annotations

from html import escape

from a2a.types import AgentCard
from starlette.requests import Request
from starlette.responses import HTMLResponse
from starlette.routing import Route

from . import extension

AGENT_CARD_PATH = "/.well-known/agent-card.json"


def _render(card: AgentCard) -> str:
    ext = card.capabilities.extensions[0] if card.capabilities.extensions else None
    skills_rows = "".join(
        f"<tr><td><code>{escape(skill.id)}</code></td>"
        f"<td>{escape(skill.name)}</td>"
        f"<td>{escape(skill.description)}</td></tr>"
        for skill in card.skills
    )
    ext_row = (
        f"<tr><td>Extension</td><td><code>{escape(ext.uri)}</code>"
        f" ({'required' if ext.required else 'optional'})</td></tr>"
        if ext
        else ""
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(card.name)}</title>
  <style>
    body {{ font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }}
    code, pre {{ font-family: ui-monospace, monospace; background: #f4f4f4; border-radius: 4px; }}
    code {{ padding: 0.1em 0.35em; }}
    table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
    td, th {{ border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }}
    .badge {{ background: #fff3cd; border: 1px solid #ffe08a; border-radius: 6px; padding: 0.6rem 1rem; }}
    @media (prefers-color-scheme: dark) {{
      body {{ background: #111; color: #ddd; }}
      code, pre {{ background: #1e1e1e; }}
      td, th {{ border-color: #333; }}
      .badge {{ background: #3a3000; border-color: #6b5900; }}
    }}
  </style>
</head>
<body>
  <h1>{escape(card.name)}</h1>
  <p class="badge"><strong>Non-normative example.</strong> Reference seller implementation for the
    <a href="https://github.com/a2aproject/A2A">A2A protocol</a>'s Kite Coordination Extension — not a
    production merchant.</p>

  <p>{escape(card.description)}</p>

  <table>
    <tr><td>Agent DID</td><td><code>{escape(extension.SELLER_AGENT_ID)}</code></td></tr>
    <tr><td>A2A endpoint (JSON-RPC)</td><td><code>{escape(card.url)}</code></td></tr>
    {ext_row}
    <tr><td>Coordination endpoint</td><td><code>{escape(extension.COORDINATION_ENDPOINT)}</code></td></tr>
  </table>

  <h2>Skills</h2>
  <table>
    <tr><th>ID</th><th>Name</th><th>Description</th></tr>
    {skills_rows}
  </table>

  <h2>Agent Card</h2>
  <p>Machine-readable capabilities live at
    <a href="{AGENT_CARD_PATH}"><code>{AGENT_CARD_PATH}</code></a>.</p>
</body>
</html>
"""


def homepage_route(card: AgentCard) -> Route:
    """Builds the `GET /` Starlette route for the home page.

    Coexists with the A2A JSON-RPC `POST /` route the SDK registers
    separately — Starlette dispatches by method, not just path.
    """
    html = _render(card)

    async def homepage(_request: Request) -> HTMLResponse:
        return HTMLResponse(html)

    return Route("/", homepage, methods=["GET"], name="homepage")
