/**
 * The public pages: home and the buyer-organized negotiation/agreement admin —
 * the same presentation `seller-agent/`'s `home.py` gives its seller, with the
 * data seller's own rows (corpus, product, buyer verification) added. One
 * shared page shell makes the two surfaces read as one service.
 */
import type { AgentCard } from "@a2a-js/sdk";
import type {
  AgreementHistoryEntry,
  BuyerRecord,
  DataSeller,
  DealRecord,
  NegotiationRecord,
} from "./seller.js";
import type { BindStatus } from "./binding.js";
import { EXTENSION_URI, NEGOTIATION_MEDIA_TYPE, SELLER_AGENT_ID, coordinationEndpoint } from "./extension.js";

export const esc = (v: unknown): string =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STYLE = `
    body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
    code, pre { font-family: ui-monospace, monospace; background: #f4f4f4; border-radius: 4px; }
    code { padding: 0.1em 0.35em; }
    pre { padding: 0.6rem 0.8rem; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    td, th { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
    .badge { background: #fff3cd; border: 1px solid #ffe08a; border-radius: 6px; padding: 0.6rem 1rem; }
    .ok { color: #0a7c2f; font-weight: 600; }
    .warn { color: #8a6100; font-weight: 600; }
    .bad { color: #a11; font-weight: 600; }
    .muted { color: #666; }
    .topbar { align-items: center; display: flex; justify-content: space-between; gap: 1rem; }
    .nav-link { border: 1px solid #bbb; border-radius: 6px; padding: 0.35rem 0.75rem; text-decoration: none; }
    body.wide { max-width: 76rem; }
    .history-table { font-size: 0.9rem; }
    .history-table th { white-space: nowrap; }
    .history-table td:nth-child(1) { white-space: nowrap; }
    .history-table details { margin-top: 0.35rem; }
    .history-table summary { color: #555; cursor: pointer; }
    .history-table pre { max-height: 28rem; white-space: pre-wrap; }
    .state-track { display: flex; flex-wrap: wrap; gap: 0.55rem; list-style: none; padding: 0; }
    .state-step { border: 1px solid #ddd; border-radius: 8px; min-width: 9rem; padding: 0.55rem 0.7rem; }
    .state-step small { display: block; color: #666; }
    .phase { text-transform: capitalize; }
    .direction { white-space: nowrap; }
    footer { margin-top: 2rem; color: #666; font-size: 0.85rem; }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #ddd; }
      code, pre { background: #1e1e1e; }
      td, th { border-color: #333; }
      .badge { background: #3a3000; border-color: #6b5900; }
      .ok { color: #4ade80; }
      .warn { color: #fbbf24; }
      .bad { color: #f87171; }
      .muted { color: #999; }
      .history-table summary { color: #aaa; }
      .state-step { border-color: #333; }
      .state-step small { color: #999; }
    }`;

/** The shared page shell: topbar with cross-links, shared style, honest footer. */
export function page(input: {
  title: string;
  nav: { href: string; label: string }[];
  body: string;
  wide?: boolean;
}): string {
  const nav = input.nav.map((n) => `<a class="nav-link" href="${esc(n.href)}">${esc(n.label)}</a>`).join(" ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(input.title)}</title>
  <style>${STYLE}</style>
</head>
<body${input.wide === true ? ' class="wide"' : ""}>
  <header class="topbar">
    <h1>${esc(input.title)}</h1>
    <nav>${nav}</nav>
  </header>
${input.body}
  <footer>Documentation, not a product: deal state, capability tokens and artifacts are process-local and non-durable.</footer>
</body>
</html>
`;
}

const BIND_PRESENTATION: Record<string, [string, string]> = {
  active: ["Bound &amp; approved", "ok"],
  pending: ["Awaiting owner approval", "warn"],
  error: ["Bind failed — retrying", "bad"],
  "no-key": ["No runtime key configured", "bad"],
  disabled: ["Not configured (demo key)", "muted"],
};

function bindRow(status: BindStatus): string {
  const [label, tone] = BIND_PRESENTATION[status.state] ?? [status.state, "muted"];
  const checked = status.checkedAt ? ` <small>(${esc(status.checkedAt)})</small>` : "";
  return (
    `<tr><td>Runtime binding</td><td><span class="${tone}">${label}</span>${checked}` +
    `<br><small>${esc(status.detail)}</small></td></tr>`
  );
}

function modeRow(mode: string): string {
  const label =
    mode === "live"
      ? '<span class="ok">live</span> — funding, evidence and delivery run through the Runtime'
      : '<span class="muted">standalone</span> — demo anchors, no Runtime calls';
  return `<tr><td>Coordination mode</td><td>${label}</td></tr>`;
}

export function renderHome(input: {
  card: AgentCard;
  cardHash: string;
  seller: DataSeller;
  binding: BindStatus;
  mode: string;
}): string {
  const { card, seller } = input;
  const ext = card.capabilities?.extensions?.[0];
  const endpoint = card.supportedInterfaces[0]?.url ?? "?";
  const skillsRows = card.skills
    .map(
      (skill) =>
        `<tr><td><code>${esc(skill.id)}</code></td><td>${esc(skill.name)}</td><td>${esc(skill.description)}</td></tr>`,
    )
    .join("\n    ");
  const corpus = seller.corpus.totals;

  const body = `  <p class="badge"><strong>Non-normative example.</strong> Reference <em>data</em> seller for the
    <a href="https://github.com/a2aproject/A2A">A2A protocol</a>'s Kite Coordination Extension — not a
    production merchant. Its deliverable is real, though: synthetic individual-level records over the
    public CDC PLACES release, regenerable byte-for-byte by the buyer.</p>

  <p>${esc(card.description)}</p>

  <table>
    <tr><td>Agent DID</td><td><code>${esc(SELLER_AGENT_ID)}</code></td></tr>
    <tr><td>A2A endpoint (JSON-RPC, A2A 1.0)</td><td><code>${esc(endpoint)}</code></td></tr>
    ${ext ? `<tr><td>Extension</td><td><code>${esc(ext.uri)}</code> (${ext.required ? "required" : "optional"})</td></tr>` : ""}
    <tr><td>Negotiation media type</td><td><code>${esc(NEGOTIATION_MEDIA_TYPE)}</code> <small class="muted">(demo-private)</small></td></tr>
    <tr><td>Coordination endpoint</td><td><code>${esc(coordinationEndpoint())}</code></td></tr>
    ${modeRow(input.mode)}
    ${bindRow(input.binding)}
    <tr><td>Corpus</td><td>${corpus.tracts.toLocaleString("en-US")} tracts, ${corpus.states} states, ${corpus.counties} counties<br><small><code>${esc(seller.corpusHash)}</code></small></td></tr>
    <tr><td>Signing address</td><td><code>${esc(seller.address)}</code></td></tr>
  </table>

  <h2>Skills</h2>
  <table>
    <tr><th>ID</th><th>Name</th><th>Description</th></tr>
    ${skillsRows}
  </table>

  <h2>What a buyer can verify</h2>
  <p>Every quote commits to the slice's statistics (<code>statsHash</code>) before any money moves; the
    signed terms pin the query, the price arithmetic, the corpus digest and the verifier digest
    (<code>${esc(seller.verifierHash)}</code>); and the delivered CSV regenerates byte-for-byte from the
    seed the delivery manifest publishes. A buyer that can hash and re-run the generator does not have
    to trust this seller.</p>

  <h2>Agent Card</h2>
  <p>Machine-readable capabilities live at
    <a href="/.well-known/agent-card.json"><code>/.well-known/agent-card.json</code></a>
    <small class="muted">(hash <code>${esc(input.cardHash)}</code>)</small>.</p>
`;
  return page({ title: card.name, nav: [{ href: "/admin", label: "Admin" }], body });
}

const stateTone = (state: string): string =>
  state.startsWith("DELIVERED") || state.startsWith("ACCEPTED") || state === "RESOLVED"
    ? "ok"
    : state === "CANCELLED" || state === "DEFAULTED"
      ? "bad"
      : "warn";

const buyerAdminPath = (buyerAgentId: string): string =>
  `/admin/buyers/${encodeURIComponent(buyerAgentId)}`;

function renderAgreementTable(deals: DealRecord[]): string {
  if (deals.length === 0) return '  <p class="muted">No agreements for this buyer.</p>';
  const rows = deals
    .map(
      (d) =>
        `<tr><td><a href="/admin/agreements/${esc(d.dealId)}"><code>${esc(d.dealId)}</code></a></td>` +
        `<td><span class="${stateTone(currentDealState(d))}">${esc(currentDealState(d))}</span></td>` +
        `<td><code>${esc(d.termsDocumentHash.slice(0, 24))}…</code></td>` +
        `<td>${esc((d.contract["price"] as Record<string, unknown> | undefined)?.["amount"] ?? "—")} USDC</td>` +
        `<td>${d.capabilityToken === undefined ? '<span class="muted">—</span>' : d.capabilityRevoked === true ? '<span class="bad">revoked</span>' : '<span class="ok">active</span>'}</td></tr>`,
    )
    .join("\n    ");
  return `  <table>
    <tr><th>Deal</th><th>State</th><th>Terms document</th><th>Price</th><th>Capability</th></tr>
    ${rows}
  </table>`;
}

export function renderAdminIndex(buyers: BuyerRecord[]): string {
  const rows = buyers
    .map((buyer) => {
      const states = buyer.deals.length
        ? buyer.deals
            .map((deal) => `<span class="${stateTone(currentDealState(deal))}">${esc(currentDealState(deal))}</span>`)
            .join(" · ")
        : '<span class="muted">pre-agreement only</span>';
      return `<tr>
      <td><a href="${esc(buyerAdminPath(buyer.buyerAgentId))}"><code>${esc(buyer.buyerAgentId)}</code></a></td>
      <td>${buyer.negotiations.length}</td>
      <td>${buyer.deals.length}</td>
      <td>${states}</td>
      <td><time datetime="${esc(buyer.updatedAt)}">${esc(buyer.updatedAt)}</time></td>
    </tr>`;
    })
    .join("\n    ");
  const inventory =
    buyers.length === 0
      ? "  <p>No buyer negotiations observed by this process.</p>"
      : `  <table>
    <tr><th>Buyer agent</th><th>Negotiations</th><th>Agreements</th><th>Agreement states</th><th>Last activity</th></tr>
    ${rows}
  </table>`;
  const body = `  <p>Organized by buyer so quote exchanges remain visible before an agreement exists.</p>
  <p class="muted">A buyer DID is self-declared during demo-private negotiation. A proposed deal links that claim to a contract; the identity becomes agreement-authenticated only after the seller validates and countersigns the matching contract.</p>
${inventory}`;
  return page({ title: "Buyers", nav: [{ href: "/", label: "Seller home" }], body, wide: true });
}

function negotiationTone(state: NegotiationRecord["state"]): string {
  if (state === "AGREEMENT_STARTED") return "ok";
  if (state === "REFUSED") return "bad";
  return "warn";
}

function renderNegotiations(negotiations: NegotiationRecord[]): string {
  if (negotiations.length === 0) return '  <p class="muted">No negotiations for this buyer.</p>';
  return negotiations
    .map((negotiation) => {
      const agreements = negotiation.dealIds.length
        ? negotiation.dealIds
            .map(
              (dealId) =>
                `<a href="/admin/agreements/${esc(dealId)}"><code>${esc(dealId)}</code></a>`,
            )
            .join(" · ")
        : '<span class="muted">none yet</span>';
      const terms = negotiation.termsDocumentHash
        ? `<a href="/terms/${esc(negotiation.termsDocumentHash)}"><code>${esc(negotiation.termsDocumentHash)}</code></a>`
        : '<span class="muted">no quote issued</span>';
      return `  <section>
    <h3><code>${esc(negotiation.negotiationId)}</code> <span class="${negotiationTone(negotiation.state)}">${esc(negotiation.state)}</span></h3>
    <table>
      <tr><th>Terms document</th><td>${terms}</td></tr>
      <tr><th>Agreements</th><td>${agreements}</td></tr>
      <tr><th>Created</th><td><time datetime="${esc(negotiation.createdAt)}">${esc(negotiation.createdAt)}</time></td></tr>
      <tr><th>Last activity</th><td><time datetime="${esc(negotiation.updatedAt)}">${esc(negotiation.updatedAt)}</time></td></tr>
    </table>
    ${renderHistoryTable(negotiation.history)}
  </section>`;
    })
    .join("\n");
}

export function renderBuyerDetail(buyer: BuyerRecord): string {
  const body = `  <p class="badge"><strong>Negotiation identity.</strong> <code>${esc(buyer.buyerAgentId)}</code> is self-declared before agreement formation. A proposed deal remains unverified until the seller validates and countersigns its matching contract.</p>

  <table>
    <tr><th>First interaction</th><td><time datetime="${esc(buyer.firstSeenAt)}">${esc(buyer.firstSeenAt)}</time></td></tr>
    <tr><th>Last activity</th><td><time datetime="${esc(buyer.updatedAt)}">${esc(buyer.updatedAt)}</time></td></tr>
    <tr><th>Negotiations</th><td>${buyer.negotiations.length}</td></tr>
    <tr><th>Agreements</th><td>${buyer.deals.length}</td></tr>
  </table>

  <h2>Negotiations</h2>
  <p class="muted">Query and quote exchanges are process-local and may exist without an agreement.</p>
  ${renderNegotiations(buyer.negotiations)}

  <h2>Agreements</h2>
  ${renderAgreementTable(buyer.deals)}
`;
  return page({
    title: buyer.buyerAgentId,
    nav: [
      { href: "/", label: "Seller home" },
      { href: "/admin", label: "Buyers" },
    ],
    body,
    wide: true,
  });
}

export function renderAdminDetail(deal: DealRecord): string {
  const manifest = deal.manifest;
  const buyerDid = String(deal.contract["buyerAgentId"] ?? "");
  const signatures = Array.isArray(deal.contract["signatures"])
    ? (deal.contract["signatures"] as Record<string, unknown>[])
    : [];
  const buyerSignature = signatures.find((signature) => signature["signerAgentId"] === buyerDid);
  const currentState = currentDealState(deal);
  const stateHistory = stateTransitions(deal.history);
  const negotiation = deal.history.filter((entry) => entry.phase === "negotiation");
  const lifecycle = deal.history.filter((entry) => entry.phase !== "negotiation");
  const firstInteractionAt = deal.history[0]?.at ?? deal.createdAt;
  const body = `  <table>
    <tr><th>current agreement state</th><td><span class="${stateTone(currentState)}">${esc(currentState)}</span></td></tr>
    <tr><th>seller-local state</th><td><span class="${stateTone(deal.state)}">${esc(deal.state)}</span></td></tr>
    <tr><th>Runtime revision</th><td>${esc(deal.runtimeRevision ?? "—")}</td></tr>
    <tr><th>price</th><td>${esc((deal.contract["price"] as Record<string, unknown> | undefined)?.["amount"] ?? "—")} USDC</td></tr>
    <tr><th>terms document</th><td><a href="/terms/${esc(deal.termsDocumentHash)}"><code>${esc(deal.termsDocumentHash)}</code></a></td></tr>
    <tr><th>deliveryHash</th><td><code>${esc(deal.deliveryHash ?? "—")}</code></td></tr>
    <tr><th>rows</th><td>${esc(manifest?.rowCount ?? "—")}</td></tr>
    <tr><th>capability</th><td>${deal.capabilityToken === undefined ? '<span class="muted">—</span>' : deal.capabilityRevoked === true ? '<span class="bad">revoked</span>' : '<span class="ok">active</span>'}</td></tr>
  </table>

  <h2>Buyer agent</h2>
  <table>
    <tr><th>DID</th><td><code>${esc(buyerDid)}</code></td></tr>
    <tr><th>Runtime address</th><td><code>${esc(deal.buyerAddress)}</code></td></tr>
    <tr><th>Signing key</th><td><code>${esc(buyerSignature?.["keyId"] ?? "—")}</code></td></tr>
    <tr><th>Signature profile</th><td><code>${esc(buyerSignature?.["profile"] ?? "—")}</code></td></tr>
    <tr><th>First interaction</th><td><time datetime="${esc(firstInteractionAt)}">${esc(firstInteractionAt)}</time></td></tr>
    <tr><th>Last interaction</th><td><time datetime="${esc(deal.updatedAt)}">${esc(deal.updatedAt)}</time></td></tr>
  </table>

  <h2>State history</h2>
  ${renderStateHistory(stateHistory)}

  <h2>Negotiation and quote</h2>
  <p class="muted">The selected query and seller quote that became this signed agreement.</p>
  ${renderHistoryTable(negotiation)}

  <h2>Agreement lifecycle</h2>
  <p class="muted">Formation, funding, fulfillment and settlement interactions in observed order.</p>
  ${renderHistoryTable(lifecycle)}

  <h2>Signed contract</h2>
  <pre>${esc(JSON.stringify(deal.contract, null, 2))}</pre>
`;
  return page({
    title: deal.dealId,
    nav: [
      { href: "/", label: "Seller home" },
      { href: "/admin", label: "Buyers" },
      { href: buyerAdminPath(buyerDid), label: "Buyer" },
    ],
    body,
    wide: true,
  });
}

function currentDealState(deal: DealRecord): string {
  return deal.runtimeState ?? deal.state;
}

function stateTransitions(history: AgreementHistoryEntry[]): AgreementHistoryEntry[] {
  const transitions: AgreementHistoryEntry[] = [];
  let previous: string | undefined;
  for (const entry of history) {
    if (entry.state !== undefined && entry.state !== previous) {
      transitions.push(entry);
      previous = entry.state;
    }
  }
  return transitions;
}

const DIRECTION_LABELS: Record<AgreementHistoryEntry["direction"], string> = {
  "buyer-to-seller": "Buyer → Seller",
  "seller-to-buyer": "Seller → Buyer",
  "buyer-to-runtime": "Buyer → Runtime",
  "seller-to-runtime": "Seller → Runtime",
  "runtime-to-seller": "Runtime → Seller",
  system: "Seller process",
};

function renderStateHistory(entries: AgreementHistoryEntry[]): string {
  if (entries.length === 0) return '  <p class="muted">No state transitions observed yet.</p>';
  return `  <ol class="state-track">
    ${entries
      .map(
        (entry) => `<li class="state-step">
      <span class="${stateTone(entry.state ?? "")}">${esc(entry.state ?? "")}</span>
      <small><time datetime="${esc(entry.at)}">${esc(entry.at)}</time></small>
    </li>`,
      )
      .join("\n    ")}
  </ol>`;
}

function renderHistoryTable(entries: AgreementHistoryEntry[]): string {
  if (entries.length === 0) return '  <p class="muted">No interactions observed yet.</p>';
  const rows = entries
    .map(
      (entry) => `<tr>
      <td><time datetime="${esc(entry.at)}">${esc(entry.at)}</time></td>
      <td><span class="phase">${esc(entry.phase)}</span></td>
      <td class="direction">${esc(DIRECTION_LABELS[entry.direction])}</td>
      <td><code>${esc(entry.kind)}</code></td>
      <td>${entry.state === undefined ? '<span class="muted">—</span>' : `<span class="${stateTone(entry.state)}">${esc(entry.state)}</span>`}</td>
      <td>${esc(entry.summary)}${
        entry.payload === undefined
          ? ""
          : `<details><summary>View payload</summary><pre>${esc(JSON.stringify(entry.payload, null, 2))}</pre></details>`
      }</td>
    </tr>`,
    )
    .join("\n    ");
  return `  <table class="history-table">
    <tr><th>Time</th><th>Phase</th><th>Direction</th><th>Interaction</th><th>State</th><th>Details</th></tr>
    ${rows}
  </table>`;
}

export function renderAdminNotFound(subject: "buyer" | "agreement" = "agreement"): string {
  return page({
    title: "Not found",
    nav: [
      { href: "/", label: "Seller home" },
      { href: "/admin", label: "Buyers" },
    ],
    body: `  <p>No such ${esc(subject)} in this process.</p>`,
  });
}
