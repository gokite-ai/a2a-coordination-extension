# Example seller agent

An A2A **server** that participates in the Kite Coordination Extension:

- publishes an Agent Card declaring the Extension with `required: false`
  (a participant card — the seller stays usable for unrelated A2A work);
- serves a `quote-service` skill for off-protocol negotiation (plain A2A
  chat that never enters the workflow or the audit chain);
- countersigns final terms — acceptance is the second signature over
  exactly the proposal's `termsHash` (`extension.accept_terms`);
- builds the settlement objects a seller signs — the Agreement co-signature
  (`extension.accept_terms`), the `sellerActivationSig`, the seller-only
  `evidence` party envelope, and the signed `kite.contract.delivered` command
  (`extension.build_command`) with `deliveryHash` and `sellerDeliverySig`.

This example is an A2A **server** with two execution modes. Standalone mode
signs each object for real and returns it to the buyer peer while using
documented Runtime stand-ins. Live mode is a real Runtime participant: it
submits `acceptance` and `funding-signatures`, obtains a Runtime-issued
`evidenceId`, reads current settlement anchors, and submits `command` itself.

**Two media types.** The card declares the Extension's
`application/vnd.gokite.agreement-command+json;version=1` as its §2.1
`commandMediaType`, because that is the type a Coordination Runtime speaks.
The messages it exchanges with the buyer peer — `terms`, `proposal-ack`,
`acceptance-result`, `delivery`, `error`, and the buyer's requests — remain a
demo-private protocol on
`application/vnd.gokite.example-negotiation+json;version=1`, and none of them
is an interaction §6.2 defines. In live mode, the seller's separate calls to
the Runtime do stamp the normative command media type on their Parts. See
[`../README.md`](../README.md) for the full split. The seller requires the
§2.2 opt-in (header *and* `extensions` array) on every negotiation request and
rejects one missing either.

Built on the official `a2a-sdk` plus this bundle's schemas — no Kite SDK.

## Admin view

The home page links to a public admin view at `GET /admin`. It lists every
agreement observed by the running seller and links to details including the
buyer agent, signed contract, latest observed status, and status history.
There is intentionally no password or authentication in this example.

The view is process-local and non-durable. Its records are held in the same
in-memory executor state as the example's deals and are cleared whenever the
seller process restarts. In live mode, opening the list or a detail page
refreshes known agreements through the configured Coordination Runtime so a
later buyer-side release or completion is reflected in the in-memory history.

## Run

```bash
pip install -e .
SELLER_PORT=9999 KITE_COORDINATION_ENDPOINT=https://passport.dev.gokite.ai/a2a/v1 python -m seller_agent
```

| Env | Default | Meaning |
|---|---|---|
| `SELLER_HOST` / `SELLER_PORT` | `0.0.0.0` / `9999` | Bind address |
| `SELLER_PUBLIC_URL` | `http://localhost:9999/` | URL advertised in the Agent Card |
| `SELLER_AGENT_ID` | `did:kite:pubco:seller-42` | Kite Identity DID, published as `x-kite-registry.agentId` |
| `KITE_COORDINATION_ENDPOINT` | `https://passport.dev.gokite.ai/a2a/v1` | The Runtime's published A2A endpoint |
| `KITE_COORDINATION_MODE` | `standalone` | `live` drives the deal through the Runtime above (see below) |
| `SELLER_QUOTE_USDC` | `24.00` | The fixed quote — the seller refuses to countersign any other amount, and it is real spend on the deployment's chain |

### Optional: binding a durable runtime key (§8)

Left unset, the agent mints an ephemeral secp256k1 key at boot. That is enough
to demo the signing shapes, and not enough for anything real: §8 makes the key
Identity has bound to the DID the one a counterparty resolves to check these
signatures, and §4 makes its keccak address the party the EscrowVault
authorizes. An unbound agent signs things nobody can verify and gets paid to an
address nobody can derive.

Set these and the agent binds a durable key to its DID at startup:

| Env | Default | Meaning |
|---|---|---|
| `KITE_IDENTITY_BASE_URL` | *(unset — binding disabled)* | Kite Identity base URL, e.g. `https://passport.dev.gokite.ai` |
| `SELLER_RUNTIME_PRIVATE_KEY` | *(unset)* | 32-byte secp256k1 scalar, hex, `0x` optional |
| `SELLER_RUNTIME_PRIVATE_KEY_FILE` | *(unset)* | Same, read from a file — for secret stores that project files |
| `SELLER_RUNTIME_BIND_RETRY_SECONDS` | `300` | Poll interval while awaiting approval |
| `SELLER_RUNTIME_ENV` | `example` | Advisory label recorded on the binding |

Ordinary env/file indirection on purpose: nothing here assumes a particular
secret store, so a laptop `export` and a Kubernetes secret projection are the
same code path.

**The bind is tokenless, so approval is a human step.** The agent names its own
(public) DID rather than presenting an owner-minted bind token, which proves
nothing about authority — so Identity records the request as `pending`
unconditionally, marked `bind_method: "direct"` so the owner can see the weaker
provenance. An owner then approves it:

```bash
POST /v1/agents/{agent}/runtimes/{runtime}:approve
```

The agent registers **once** and then polls `GET /v1/agents:lookup?ref=secp256k1:…`
every `SELLER_RUNTIME_BIND_RETRY_SECONDS` until that call resolves — resolving
by key deliberately answers only for a live binding, so its 404→200 flip *is*
the approval signal, and no owner credentials are needed to watch for it.
Re-registering on each pass would file a duplicate pending request every
interval, so it does not.

The current state — `Not configured` / `Awaiting owner approval` / `Bound &
approved` / `Bind failed` — is rendered on the agent's home page (`GET /`) and
logged at startup.

Status: working demo with two modes.

**Standalone** (default): negotiation answers a fixed quote; countersigning
verifies the buyer's signatures against the seller's OWN recomputed
`termsHash`; delivery produces real content, a really-signed `evidence` party
envelope (§6.2.1), and a really-signed `kite.contract.delivered` command. The
dealId, evidenceId and §4.4 settlement anchors are DOCUMENTED PLACEHOLDERS —
the construction and every signature are real, the values are not, and
nothing produced in this mode can be submitted to a Runtime.

**Live** (`KITE_COORDINATION_MODE=live`): the deal runs through the Runtime at
`KITE_COORDINATION_ENDPOINT` over the §6.2 interactions. The buyer submits the
`proposal` itself and brings back the Runtime-assigned dealId; the seller
verifies that deal against a `status` read AND verifies the Runtime's Agent
Card against the `agentCardHash` the terms pin — the Agreement chainId comes
from that verified card (§2.1), never from local configuration — before
countersigning and submitting the `acceptance`. It co-signs funding over the
READ-BACK Activation and EIP-712 domain (§6.2.1; the read-back `amount` is
already base units and is **not** converted again), registers evidence for a
Runtime-issued `evidenceId`, and signs delivery over anchors read back fresh:
the vault dealId, `latestProofHash`, and the vault's current nonce.

A §6.5 `fulfill_started` notification is the work-start: the seller reads the
state back from the Runtime (never trusting the notification), acknowledges,
and **runs delivery itself** as a background task — the buyer sends no
follow-up. Any notification it cannot verify — unknown deal, mismatched
termsHash, failed or non-FULFILLING read-back — is answered with a JSON-RPC
**error**, not a polite message: the relay in front treats any well-formed
reply as delivered, so only an error keeps the Runtime's retry loop alive.
And that acknowledgement is a one-shot: the engine's `SendFulfillStart`
activity completes on it and the notification is **never re-sent**, so the
delivery task retries failures itself (`SELLER_DELIVERY_RETRY_SECONDS`,
default 30s), bounded by the notification's `delivery_deadline` (a unix
timestamp) and stopped early once the agreement is no longer FULFILLING.
The Delivery signature's `expiry` is always the seller's own clock (~1h) —
a requester-chosen expiry could already be in the past, recording DELIVERED
while the on-chain `markDelivered` can never land.

Live mode fails closed: it refuses to start without a durable runtime key,
and refuses to sign until the runtime binding is **active** — Passport
verifies every signature against the DID's active binding, so a signature
from an unbound key is refused whoever relays it. That includes running live
without `KITE_IDENTITY_BASE_URL` at all: a live seller outside Identity is a
misconfiguration whose every signature bounces, not a lighter deployment.
`tests/test_live_coordination.py` drives the whole loop against a fake Runtime
that cryptographically verifies every artifact it accepts, deriving its
digests independently of this package's helpers.

The same live path has completed against a deployed Runtime and an external
buyer participant, including active key binding, countersignature, funding
co-signature, autonomous delivery, buyer acceptance, on-chain settlement, and
the Runtime proof-chain read. See
[`../../conformance/live-validation.md`](../../conformance/live-validation.md)
for the exact coverage boundary.

Still out of scope: the seller does not read or verify the `proofs` chain
(delivery's `receiptHash` anchor comes from `status.latestProofHash`, which is
what §4.4 quotes), and the buyer-side funding artifacts (`auth3009`,
`expectedDealId`) are the buyer's to produce. The in-band public-key exchange
— carried in the demo's own `request-terms`/`terms` pair, never inside a
workflow object — remains a stand-in for Identity DID resolution (spec §8).
