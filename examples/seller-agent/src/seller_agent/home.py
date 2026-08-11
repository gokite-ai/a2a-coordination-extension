"""Human-readable home page for the seller agent.

The A2A surfaces (`/`, `/.well-known/agent-card.json`) are machine-readable
only — this gives a visiting human something to look at, and a visible link
into the machine-readable Agent Card.
"""

from __future__ import annotations

import json
import os
from html import escape
from typing import Any, Protocol
from urllib.parse import quote

from a2a.types import AgentCard
from starlette.requests import Request
from starlette.responses import HTMLResponse
from starlette.routing import Route

from . import extension, runtime_bind

AGENT_CARD_PATH = "/.well-known/agent-card.json"

# How each runtime_bind state reads to a human, and the colour it gets. The
# operational question this page answers is "can anyone actually verify what
# this agent signs?", so `active` is the only green: `pending` means a real
# bind request is filed but no counterparty can resolve the key yet.
_BIND_PRESENTATION = {
    "active": ("Bound &amp; approved", "ok"),
    "pending": ("Awaiting owner approval", "warn"),
    "error": ("Bind failed — retrying", "bad"),
    "no-key": ("No runtime key configured", "bad"),
    "disabled": ("Not configured (demo key)", "muted"),
}


class AgreementAdminReader(Protocol):
    """Read-only boundary between the public pages and executor state."""

    async def refresh_agreement_records(self, deal_id: str | None = None) -> None: ...

    def agreement_records(self) -> list[dict[str, Any]]: ...

    def agreement_record(self, deal_id: str) -> dict[str, Any] | None: ...


def _mode_row() -> str:
    """standalone (self-contained demo, invented anchors, documented as such)
    vs live (deal driven through the Runtime above)."""
    live = os.environ.get("KITE_COORDINATION_MODE", "standalone").strip().lower() == "live"
    label = (
        '<span class="ok">live</span> — funding, evidence and delivery run through the Runtime'
        if live else
        '<span class="muted">standalone</span> — demo anchors, no Runtime calls'
    )
    return f"<tr><td>Coordination mode</td><td>{label}</td></tr>"


def _bind_row() -> str:
    status = runtime_bind.STATUS
    label, tone = _BIND_PRESENTATION.get(status.state, (status.state, "muted"))
    checked = f" <small>({escape(status.checked_at)})</small>" if status.checked_at else ""
    return (
        f'<tr><td>Runtime binding</td><td><span class="{tone}">{label}</span>{checked}'
        f'<br><small>{escape(status.detail)}</small></td></tr>'
    )


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
    endpoint = card.supported_interfaces[0].url if card.supported_interfaces else "?"
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
    .ok {{ color: #0a7c2f; font-weight: 600; }}
    .warn {{ color: #8a6100; font-weight: 600; }}
    .bad {{ color: #a11; font-weight: 600; }}
    .muted {{ color: #666; }}
    .topbar {{ align-items: center; display: flex; justify-content: space-between; gap: 1rem; }}
    .admin-link {{ border: 1px solid #bbb; border-radius: 6px; padding: 0.35rem 0.75rem; text-decoration: none; }}
    @media (prefers-color-scheme: dark) {{
      body {{ background: #111; color: #ddd; }}
      code, pre {{ background: #1e1e1e; }}
      td, th {{ border-color: #333; }}
      .badge {{ background: #3a3000; border-color: #6b5900; }}
      .ok {{ color: #4ade80; }}
      .warn {{ color: #fbbf24; }}
      .bad {{ color: #f87171; }}
      .muted {{ color: #999; }}
    }}
  </style>
</head>
<body>
  <header class="topbar">
    <h1>{escape(card.name)}</h1>
    <a class="admin-link" href="/admin">Admin</a>
  </header>
  <p class="badge"><strong>Non-normative example.</strong> Reference seller implementation for the
    <a href="https://github.com/a2aproject/A2A">A2A protocol</a>'s Kite Coordination Extension — not a
    production merchant.</p>

  <p>{escape(card.description)}</p>

  <table>
    <tr><td>Agent DID</td><td><code>{escape(extension.SELLER_AGENT_ID)}</code></td></tr>
    <tr><td>A2A endpoint (JSON-RPC, A2A 1.0)</td><td><code>{escape(endpoint)}</code></td></tr>
    {ext_row}
    <tr><td>Coordination endpoint</td><td><code>{escape(extension.COORDINATION_ENDPOINT)}</code></td></tr>
    {_mode_row()}
    {_bind_row()}
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

    Rendered per request rather than once at startup: the runtime binding
    starts out pending and turns active minutes later when an owner approves,
    and a page cached at boot would report the boot-time answer forever.
    """

    async def homepage(_request: Request) -> HTMLResponse:
        return HTMLResponse(_render(card))

    return Route("/", homepage, methods=["GET"], name="homepage")


def _value(value: Any) -> str:
    if value is None or value == "":
        return '<span class="muted">—</span>'
    return escape(str(value))


def _state_badge(state: Any) -> str:
    label = str(state or "UNKNOWN")
    return f'<span class="state state-{escape(label.lower())}">{escape(label)}</span>'


def _admin_page(title: str, content: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(title)} · Seller Admin</title>
  <style>
    body {{ font: 15px/1.55 system-ui, sans-serif; max-width: 72rem; margin: 2.5rem auto; padding: 0 1rem; color: #1a1a1a; }}
    a {{ color: #075fbd; }}
    code, pre {{ font-family: ui-monospace, monospace; background: #f4f4f4; border-radius: 4px; }}
    code {{ padding: 0.1em 0.35em; }}
    pre {{ overflow: auto; padding: 1rem; white-space: pre-wrap; word-break: break-word; }}
    table {{ border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }}
    td, th {{ border-bottom: 1px solid #ddd; padding: 0.65rem; text-align: left; vertical-align: top; }}
    th {{ color: #555; font-size: 0.82rem; text-transform: uppercase; }}
    .topbar {{ align-items: center; display: flex; justify-content: space-between; gap: 1rem; }}
    .topbar nav {{ display: flex; gap: 1rem; }}
    .notice {{ background: #fff7dc; border: 1px solid #ead99c; border-radius: 6px; padding: 0.65rem 0.9rem; }}
    .muted {{ color: #666; }}
    .state {{ background: #edf2f7; border-radius: 999px; display: inline-block; font-size: 0.8rem; font-weight: 700; padding: 0.15rem 0.55rem; }}
    .state-committed, .state-funded, .state-fulfilling {{ background: #e8f2ff; color: #075fbd; }}
    .state-delivered, .state-completed, .state-released {{ background: #def7e5; color: #087333; }}
    .state-defaulted, .state-cancelled, .state-disputed {{ background: #fde8e8; color: #a11; }}
    .empty {{ border: 1px dashed #bbb; border-radius: 6px; padding: 2rem; text-align: center; }}
    .table-wrap {{ overflow-x: auto; }}
    dl {{ display: grid; grid-template-columns: minmax(9rem, 14rem) 1fr; margin: 1rem 0 2rem; }}
    dt, dd {{ border-bottom: 1px solid #eee; margin: 0; padding: 0.55rem 0; }}
    dt {{ color: #555; font-weight: 600; }}
    @media (max-width: 42rem) {{ dl {{ display: block; }} dt {{ border: 0; padding-bottom: 0; }} dd {{ padding-top: 0.15rem; }} }}
    @media (prefers-color-scheme: dark) {{
      body {{ background: #111; color: #ddd; }}
      a {{ color: #7db9ff; }}
      code, pre {{ background: #1e1e1e; }}
      td, th, dt, dd {{ border-color: #333; }}
      th, dt, .muted {{ color: #999; }}
      .notice {{ background: #3a3000; border-color: #6b5900; }}
      .empty {{ border-color: #555; }}
    }}
  </style>
</head>
<body>
  <header class="topbar">
    <h1>{escape(title)}</h1>
    <nav><a href="/">Seller home</a><a href="/admin">Agreements</a></nav>
  </header>
  {content}
</body>
</html>
"""


def _render_admin_index(records: list[dict[str, Any]]) -> str:
    if not records:
        listing = '<p class="empty">No agreements have been observed by this seller process.</p>'
    else:
        rows = []
        for record in records:
            contract = record.get("contract") or {}
            price = contract.get("price") or {}
            agreement_id = str(record.get("agreementId") or "")
            rows.append(
                "<tr>"
                f'<td><a href="/admin/agreements/{quote(agreement_id, safe="")}"><code>{escape(agreement_id)}</code></a></td>'
                f'<td>{_value(contract.get("buyerAgentId"))}</td>'
                f'<td>{_value(contract.get("deliverable"))}</td>'
                f'<td>{_value(price.get("amount"))} {_value(price.get("asset"))}</td>'
                f'<td>{_state_badge(record.get("state"))}</td>'
                f'<td>{_value(record.get("updatedAt"))}</td>'
                "</tr>"
            )
        listing = (
            '<div class="table-wrap"><table><thead><tr>'
            '<th>Agreement</th><th>Buyer agent</th><th>Deliverable</th>'
            '<th>Price</th><th>Status</th><th>Last observed</th>'
            '</tr></thead><tbody>' + "".join(rows) + "</tbody></table></div>"
        )
    content = (
        '<p class="notice"><strong>Public demo view.</strong> No authentication is required. '
        'The list contains seller-observed, in-memory state and is cleared when the process restarts.</p>'
        + listing
    )
    return _admin_page("Agreements", content)


def _render_admin_detail(record: dict[str, Any]) -> str:
    contract = record.get("contract") or {}
    price = contract.get("price") or {}
    escrow = contract.get("escrow") or {}
    dispute_policy = contract.get("disputePolicy") or {}
    runtime_binding = contract.get("runtimeBinding") or {}
    history_rows = "".join(
        "<tr>"
        f'<td>{_value(item.get("observedAt"))}</td>'
        f'<td>{_value(item.get("event"))}</td>'
        f'<td>{_state_badge(item.get("state"))}</td>'
        f'<td>{_value(item.get("revision"))}</td>'
        f'<td>{_value(item.get("detail"))}</td>'
        "</tr>"
        for item in record.get("history") or []
    )
    if not history_rows:
        history_rows = '<tr><td colspan="5" class="muted">No status observations.</td></tr>'
    raw_contract = escape(json.dumps(contract, indent=2, sort_keys=True, ensure_ascii=False))
    raw_status = escape(json.dumps(
        record.get("latestStatus") or {}, indent=2, sort_keys=True, ensure_ascii=False,
    ))
    content = f"""
  <p><a href="/admin">← All agreements</a></p>
  <p class="notice"><strong>Public demo view.</strong> This record is process-local and is cleared on restart.</p>
  <dl>
    <dt>Agreement ID</dt><dd><code>{_value(record.get("agreementId"))}</code></dd>
    <dt>Current status</dt><dd>{_state_badge(record.get("state"))}</dd>
    <dt>Revision</dt><dd>{_value(record.get("revision"))}</dd>
    <dt>Buyer agent</dt><dd><code>{_value(contract.get("buyerAgentId"))}</code></dd>
    <dt>Seller agent</dt><dd><code>{_value(contract.get("sellerAgentId"))}</code></dd>
    <dt>Deliverable</dt><dd>{_value(contract.get("deliverable"))}</dd>
    <dt>Acceptance criteria</dt><dd>{_value(contract.get("acceptanceCriteria"))}</dd>
    <dt>Price</dt><dd>{_value(price.get("amount"))} {_value(price.get("asset"))}</dd>
    <dt>Payout address</dt><dd><code>{_value(escrow.get("payoutAddress"))}</code></dd>
    <dt>Arbiter</dt><dd><code>{_value(dispute_policy.get("arbiterAgentId"))}</code></dd>
    <dt>Terms hash</dt><dd><code>{_value(record.get("termsHash"))}</code></dd>
    <dt>Runtime agent</dt><dd><code>{_value(runtime_binding.get("runtimeAgentId"))}</code></dd>
    <dt>Created</dt><dd>{_value(record.get("createdAt"))}</dd>
    <dt>Last observed</dt><dd>{_value(record.get("updatedAt"))}</dd>
  </dl>
  <h2>Status history</h2>
  <div class="table-wrap"><table><thead><tr>
    <th>Observed at</th><th>Event</th><th>Status</th><th>Revision</th><th>Detail</th>
  </tr></thead><tbody>{history_rows}</tbody></table></div>
  <details><summary>Latest Runtime status</summary><pre>{raw_status}</pre></details>
  <details><summary>Raw agreement contract</summary><pre>{raw_contract}</pre></details>
"""
    return _admin_page(str(record.get("agreementId") or "Agreement"), content)


def admin_routes(reader: AgreementAdminReader) -> list[Route]:
    """Public, read-only routes over this process's agreement memory."""

    async def agreements(_request: Request) -> HTMLResponse:
        await reader.refresh_agreement_records()
        return HTMLResponse(_render_admin_index(reader.agreement_records()))

    async def agreement_detail(request: Request) -> HTMLResponse:
        agreement_id = request.path_params["agreement_id"]
        await reader.refresh_agreement_records(agreement_id)
        record = reader.agreement_record(agreement_id)
        if record is None:
            return HTMLResponse(
                _admin_page(
                    "Agreement not found",
                    f'<p>No in-memory agreement matches <code>{escape(agreement_id)}</code>.</p>',
                ),
                status_code=404,
            )
        return HTMLResponse(_render_admin_detail(record))

    return [
        Route("/admin", agreements, methods=["GET"], name="admin_agreements"),
        Route(
            "/admin/agreements/{agreement_id}",
            agreement_detail,
            methods=["GET"],
            name="admin_agreement_detail",
        ),
    ]
