"""Optional Kite Identity runtime binding (§8) for the example seller.

The rest of this example is deployment-neutral, and this module keeps it that
way: with `KITE_IDENTITY_BASE_URL` unset — the default — nothing here runs, the
agent keeps its ephemeral demo key, and the home page says so. Point it at a
Kite Identity deployment and supply a durable secp256k1 key and the agent binds
that key to its DID at boot.

Why the binding matters at all: §8 says the key that signs coordination
commands is the key Identity has bound to the agent's DID, and §4 says the
EscrowVault authorizes the keccak address of that same key. An unbound agent
can still negotiate and sign, but a counterparty resolving its DID finds no
key to check the signature against, and settlement has no address to pay.

    KITE_IDENTITY_BASE_URL            unset ⇒ disabled (default)
    SELLER_RUNTIME_PRIVATE_KEY        32-byte secp256k1 scalar, hex
    SELLER_RUNTIME_PRIVATE_KEY_FILE   same, read from a file instead
    SELLER_RUNTIME_BIND_RETRY_SECONDS poll interval, default 300

The private key arrives through ordinary env/file indirection precisely so the
example stays portable: a Kubernetes deployment can project it from a secret
store, a laptop can export it from a shell, and neither spelling is baked in
here.

## The bind is tokenless, so it always lands pending

Two paths bind a runtime. The token path presents an owner-minted bind token;
this one names the (public, directory-discoverable) agent id instead. Naming a
public identifier proves nothing about authority, so Identity treats the result
as a request rather than a grant: it lands `pending` unconditionally and is
marked `bind_method: "direct"` so the owner reviewing it sees the weaker
provenance. **An agent cannot approve itself** — a human with owner rights runs
`POST /v1/agents/{agent}/runtimes/{runtime}:approve`.

That is why this module polls rather than retries: re-POSTing the registration
every interval would file a fresh pending request each time and bury the owner
in duplicates. It registers once, then waits for the approval to land.

## Reading approval back without credentials

Listing an agent's bindings is owner-authenticated, so this agent cannot ask
for its own. It does not need to: `GET /v1/agents:lookup?ref=secp256k1:…` is
public, and resolving BY KEY deliberately answers only for a live binding —
"pending claims and revoked bindings do not resolve at all". So the 404/200 of
that one public call IS the approval signal, and a 200 additionally carries
`matched_runtime.status` to confirm what answered.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
from coincurve import PrivateKey

log = logging.getLogger("seller_agent.runtime_bind")

IDENTITY_BASE_URL = os.environ.get("KITE_IDENTITY_BASE_URL", "").strip().rstrip("/")
RUNTIME_PRIVATE_KEY = os.environ.get("SELLER_RUNTIME_PRIVATE_KEY", "").strip()
RUNTIME_PRIVATE_KEY_FILE = os.environ.get("SELLER_RUNTIME_PRIVATE_KEY_FILE", "").strip()
RETRY_SECONDS = int(os.environ.get("SELLER_RUNTIME_BIND_RETRY_SECONDS", "300"))

# Distinct from the token path's tag so a proof minted for one registration
# path can never be replayed on the other.
DIRECT_BIND_DOMAIN = "kite:identity:runtime-bind:direct:v1"

# What this runtime reports about itself at registration. Advisory only —
# Identity records it so an owner reviewing a pending request can see what is
# asking.
RUNTIME_DESCRIPTOR = {
    "software": "kite-example-seller-agent",
    "env": os.environ.get("SELLER_RUNTIME_ENV", "example"),
}


@dataclass
class BindStatus:
    """What the home page and the logs report about the binding.

    `state` is one of:
      disabled  — KITE_IDENTITY_BASE_URL unset; the example runs standalone
      no-key    — an Identity URL but no private key to bind
      pending   — registered, waiting for an owner to approve
      active    — the key resolves for this DID; signatures are checkable
      error     — last attempt failed; `detail` says how, retried on interval
    """

    state: str = "disabled"
    detail: str = "runtime binding not configured"
    runtime_id: str = ""
    pub_key: str = ""
    agent_storage_id: str = ""
    checked_at: str = ""

    def touch(self, state: str, detail: str) -> None:
        self.state = state
        self.detail = detail
        self.checked_at = (
            datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        )


# Module-level so home.py can render the live value without threading it
# through the Agent Card or the executor.
STATUS = BindStatus()


def load_runtime_key() -> PrivateKey | None:
    """The durable secp256k1 key to bind, or None to stay on the demo key.

    Hex either way, with or without the `0x` prefix. The file form exists
    because secret stores commonly project a file rather than an env var, and
    a file keeps the key out of the process environment.
    """
    raw = RUNTIME_PRIVATE_KEY
    if not raw and RUNTIME_PRIVATE_KEY_FILE:
        try:
            with open(RUNTIME_PRIVATE_KEY_FILE, encoding="utf-8") as fh:
                raw = fh.read().strip()
        except OSError as exc:
            log.warning("cannot read SELLER_RUNTIME_PRIVATE_KEY_FILE: %s", exc)
            return None
    if not raw:
        return None
    try:
        return PrivateKey(bytes.fromhex(raw.removeprefix("0x")))
    except ValueError as exc:
        log.warning("SELLER_RUNTIME_PRIVATE_KEY is not a valid secp256k1 scalar: %s", exc)
        return None


def pub_key_ref(priv: PrivateKey) -> str:
    """`secp256k1:<base64std of the 33-byte compressed point>` — the exact
    spelling Identity parses, and the same string that goes into the signed
    proof, so the two can never disagree."""
    compressed = priv.public_key.format(compressed=True)
    return "secp256k1:" + base64.b64encode(compressed).decode()


def bind_proof(priv: PrivateKey, nonce: str, agent_storage_id: str, pub_key: str) -> str:
    """base64std of the ASN.1 DER ECDSA signature over SHA-256 of

        kite:identity:runtime-bind:direct:v1\\n<nonce>\\n<agent_id>\\n<pub_key>

    `<agent_id>` is the STORAGE id (`agt_…`), not the DID: the handler rebuilds
    this message from its path parameter, so signing the DID would verify
    against a different string and fail.
    """
    message = "\n".join([DIRECT_BIND_DOMAIN, nonce, agent_storage_id, pub_key]).encode()
    # coincurve.sign defaults to DER output over a SHA-256 digest, which is
    # exactly what the secp256k1 branch of the verifier expects.
    return base64.b64encode(priv.sign(message)).decode()


def _data(resp: httpx.Response) -> Any:
    """Unwrap Identity's `{data, error, details}` envelope."""
    return (resp.json() or {}).get("data")


async def resolve_agent_storage_id(http: httpx.AsyncClient, did: str) -> str:
    """DID → `agt_…`. Public, unauthenticated."""
    resp = await http.get(f"{IDENTITY_BASE_URL}/v1/agents:lookup", params={"ref": did})
    resp.raise_for_status()
    entry = _data(resp) or {}
    storage_id = str(entry.get("id") or "")
    if not storage_id:
        raise RuntimeError(f"lookup of {did} returned no agent id")
    return storage_id


async def lookup_live_binding(http: httpx.AsyncClient, pub_key: str) -> dict[str, Any] | None:
    """The approval probe: resolve the agent BY KEY.

    404 is the expected answer while the binding is pending — not an error
    condition, so it is reported as "no live binding" rather than raised.

    Returns the whole directory ENTRY, not just `matched_runtime`: resolving
    by key answers with whatever agent the key is bound under, and the caller
    must check that agent is OURS before reporting the binding as ours.
    """
    resp = await http.get(f"{IDENTITY_BASE_URL}/v1/agents:lookup", params={"ref": pub_key})
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return _data(resp) or {}


async def register_direct(
    http: httpx.AsyncClient, agent_storage_id: str, priv: PrivateKey, pub_key: str
) -> dict[str, Any]:
    """Fetch a single-use nonce, then file the tokenless bind request."""
    nonce_resp = await http.post(f"{IDENTITY_BASE_URL}/v1/runtimes:issueBindNonce")
    nonce_resp.raise_for_status()
    nonce = str((_data(nonce_resp) or {}).get("nonce") or "")
    if not nonce:
        raise RuntimeError("issueBindNonce returned no nonce")

    resp = await http.post(
        f"{IDENTITY_BASE_URL}/v1/agents/{agent_storage_id}/runtimes:registerDirect",
        json={
            "nonce": nonce,
            "pub_key": pub_key,
            "proof": bind_proof(priv, nonce, agent_storage_id, pub_key),
            **RUNTIME_DESCRIPTOR,
        },
    )
    resp.raise_for_status()
    return _data(resp) or {}


async def maintain(agent_did: str, priv: PrivateKey) -> None:
    """Bind once, then poll until an owner approves.

    Returns — ending the task — as soon as the binding is live. Everything
    else loops on RETRY_SECONDS, including failures: an Identity that is down
    at boot must not leave the agent permanently unbound.
    """
    pub_key = pub_key_ref(priv)
    STATUS.pub_key = pub_key
    registered = False

    async with httpx.AsyncClient(timeout=15.0) as http:
        while True:
            try:
                entry = await lookup_live_binding(http, pub_key)
                if entry is not None:
                    # Resolving BY KEY answers with whatever agent the key is
                    # bound under. If that is not us, this key belongs to some
                    # other registration and reporting it as ours would let the
                    # agent sign under an identity a counterparty resolves to a
                    # different DID. A misconfiguration, not a pending state —
                    # it will not clear on its own, but it stays on the retry
                    # loop so a fixed registry is picked up without a restart.
                    resolved_did = str(entry.get("did") or "")
                    if resolved_did and resolved_did != agent_did:
                        STATUS.touch(
                            "error",
                            f"runtime key is bound to {resolved_did}, not {agent_did} — "
                            "refusing to report the binding as ours",
                        )
                        log.warning("runtime bind mismatch: %s", STATUS.detail)
                        await asyncio.sleep(RETRY_SECONDS)
                        continue
                    matched = entry.get("matched_runtime") or {}
                    STATUS.runtime_id = str(matched.get("id") or "")
                    STATUS.touch(
                        "active",
                        f"runtime {STATUS.runtime_id or '(id withheld)'} is active"
                        f" ({matched.get('bind_method') or 'direct'} bind)",
                    )
                    log.info("runtime binding active for %s: %s", agent_did, STATUS.detail)
                    return

                if not registered:
                    # Resolved per attempt rather than cached: a DID that does
                    # not exist yet is a normal boot-order race, and the next
                    # pass should pick it up once the agent is created.
                    if not STATUS.agent_storage_id:
                        STATUS.agent_storage_id = await resolve_agent_storage_id(http, agent_did)
                    view = await register_direct(http, STATUS.agent_storage_id, priv, pub_key)
                    registered = True
                    STATUS.runtime_id = str(view.get("id") or "")
                    STATUS.touch(
                        "pending",
                        f"runtime {STATUS.runtime_id or '(id withheld)'} filed a tokenless"
                        " bind request; awaiting owner approval",
                    )
                    log.warning(
                        "runtime %s registered for %s and is PENDING — an owner must approve it:"
                        " POST /v1/agents/%s/runtimes/%s:approve",
                        STATUS.runtime_id,
                        agent_did,
                        STATUS.agent_storage_id,
                        STATUS.runtime_id,
                    )
                else:
                    # Deliberately does NOT re-register: a second POST files a
                    # second pending request against the same key.
                    STATUS.touch("pending", STATUS.detail.split(";")[0] + "; awaiting owner approval")
            except Exception as exc:  # noqa: BLE001 — a bind failure must not kill the server
                STATUS.touch("error", f"{type(exc).__name__}: {exc}")
                log.warning("runtime bind attempt failed for %s: %s", agent_did, exc)

            await asyncio.sleep(RETRY_SECONDS)


def start(agent_did: str) -> asyncio.Task[None] | None:
    """Kick off the binding task, or record why there is nothing to do.

    Never raises and never blocks startup: an example whose HTTP server refuses
    to come up because an unrelated identity service is unreachable would be a
    worse example.
    """
    if not IDENTITY_BASE_URL:
        STATUS.touch("disabled", "KITE_IDENTITY_BASE_URL unset — running with an ephemeral demo key")
        return None
    priv = load_runtime_key()
    if priv is None:
        STATUS.touch(
            "no-key",
            "KITE_IDENTITY_BASE_URL is set but no SELLER_RUNTIME_PRIVATE_KEY[_FILE] was readable",
        )
        log.warning("runtime binding skipped: %s", STATUS.detail)
        return None
    STATUS.touch("pending", "resolving agent and filing bind request")
    return asyncio.create_task(maintain(agent_did, priv))
