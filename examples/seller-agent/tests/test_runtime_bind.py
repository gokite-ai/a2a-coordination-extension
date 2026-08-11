"""The §8 runtime binding, checked against the wire contract it has to match.

Two things can silently break here and neither shows up as an exception: a
proof built over the wrong preimage (Identity rejects it, the agent retries
forever) and a poll loop that re-registers (Identity accepts every one, and the
owner drowns in duplicate pending requests). Both are asserted below.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib

import httpx
import pytest
from coincurve import PrivateKey, PublicKey

from seller_agent import runtime_bind

AGENT_DID = "did:kite:corp-kite:example-seller-agent"
AGENT_STORAGE_ID = "agt_01HEXAMPLE"
RUNTIME_ID = "rt_01HEXAMPLE"


@pytest.fixture
def priv() -> PrivateKey:
    return PrivateKey(bytes.fromhex("11" * 32))


def test_pub_key_ref_is_base64_of_the_compressed_point(priv: PrivateKey) -> None:
    """`secp256k1:<base64std>` of exactly 33 bytes — parseSecp256k1BindKey
    rejects any other length outright."""
    ref = runtime_bind.pub_key_ref(priv)
    assert ref.startswith("secp256k1:")
    raw = base64.b64decode(ref.removeprefix("secp256k1:"))
    assert len(raw) == 33
    assert raw == priv.public_key.format(compressed=True)


def test_bind_proof_matches_the_server_preimage(priv: PrivateKey) -> None:
    """The signed bytes are

        kite:identity:runtime-bind:direct:v1\\n<nonce>\\n<agent_id>\\n<pub_key>

    reproduced here independently of the helper, so a change to either side
    fails rather than agreeing with itself. `<agent_id>` is the agt_ storage
    id because the handler rebuilds the message from its path parameter.
    """
    nonce = base64.b64encode(b"\x02" * 32).decode()
    pub_key = runtime_bind.pub_key_ref(priv)
    proof = runtime_bind.bind_proof(priv, nonce, AGENT_STORAGE_ID, pub_key)

    expected = (
        "kite:identity:runtime-bind:direct:v1\n"
        f"{nonce}\n{AGENT_STORAGE_ID}\n{pub_key}"
    ).encode()

    signature = base64.b64decode(proof)
    # ASN.1 DER SEQUENCE, which is what the secp256k1 branch of the verifier
    # parses — a raw r||s signature would be silently rejected.
    assert signature[0] == 0x30
    assert PublicKey.from_secret(priv.secret).verify(signature, expected)
    # ...and over SHA-256 of the message, not the raw message.
    assert PublicKey.from_secret(priv.secret).verify(
        signature, hashlib.sha256(expected).digest(), hasher=None
    )


def test_signing_the_did_instead_of_the_storage_id_would_not_verify(priv: PrivateKey) -> None:
    """Guards the one substitution that looks harmless and is not."""
    nonce = base64.b64encode(b"\x03" * 32).decode()
    pub_key = runtime_bind.pub_key_ref(priv)
    proof = runtime_bind.bind_proof(priv, nonce, AGENT_DID, pub_key)
    server_preimage = (
        f"kite:identity:runtime-bind:direct:v1\n{nonce}\n{AGENT_STORAGE_ID}\n{pub_key}"
    ).encode()
    assert not PublicKey.from_secret(priv.secret).verify(base64.b64decode(proof), server_preimage)


class FakeIdentity:
    """The three endpoints the binding touches, with Identity's envelope and
    its pending-is-invisible lookup semantics."""

    def __init__(self, approve_after: int) -> None:
        self.approve_after = approve_after
        self.lookups_by_key = 0
        self.registrations = 0
        self.nonces_issued = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "agents:lookup" in url:
            ref = request.url.params.get("ref", "")
            if ref.startswith("secp256k1:"):
                self.lookups_by_key += 1
                # A pending binding does not resolve by key at all.
                if self.registrations and self.lookups_by_key > self.approve_after:
                    return httpx.Response(
                        200,
                        json={"data": {"id": AGENT_STORAGE_ID, "did": AGENT_DID,
                                       "matched_runtime": {"id": RUNTIME_ID, "status": "active",
                                                           "bind_method": "direct"}}},
                    )
                return httpx.Response(404, json={"error": "not found"})
            return httpx.Response(200, json={"data": {"id": AGENT_STORAGE_ID, "did": ref}})
        if "runtimes:issueBindNonce" in url:
            self.nonces_issued += 1
            return httpx.Response(
                200, json={"data": {"nonce": base64.b64encode(bytes([self.nonces_issued]) * 32).decode()}}
            )
        if "runtimes:registerDirect" in url:
            self.registrations += 1
            return httpx.Response(
                200, json={"data": {"id": RUNTIME_ID, "status": "pending", "bind_method": "direct"}}
            )
        return httpx.Response(404, json={"error": "unexpected " + url})


@pytest.mark.asyncio
async def test_registers_once_then_polls_until_approved(monkeypatch, priv: PrivateKey) -> None:
    """The whole point of the loop: ONE registration, then patience.

    Three passes happen before approval lands; a loop that re-registered would
    file three pending requests for one agent.
    """
    identity = FakeIdentity(approve_after=3)
    monkeypatch.setattr(runtime_bind, "IDENTITY_BASE_URL", "https://identity.example")
    monkeypatch.setattr(runtime_bind, "RETRY_SECONDS", 0)
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())

    transport = httpx.MockTransport(identity.handler)
    original = httpx.AsyncClient

    def client(*args, **kwargs):
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)

    await runtime_bind.maintain(AGENT_DID, priv)

    assert identity.registrations == 1
    assert identity.lookups_by_key == 4
    assert runtime_bind.STATUS.state == "active"
    assert runtime_bind.STATUS.runtime_id == RUNTIME_ID


@pytest.mark.asyncio
async def test_already_active_key_never_registers(monkeypatch, priv: PrivateKey) -> None:
    """A restart of an approved agent must not file a fresh bind request."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "agents:lookup" in str(request.url):
            return httpx.Response(
                200,
                json={"data": {"id": AGENT_STORAGE_ID,
                               "matched_runtime": {"id": RUNTIME_ID, "status": "active",
                                                   "bind_method": "direct"}}},
            )
        raise AssertionError(f"must not be called: {request.url}")

    monkeypatch.setattr(runtime_bind, "IDENTITY_BASE_URL", "https://identity.example")
    monkeypatch.setattr(runtime_bind, "RETRY_SECONDS", 0)
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: original(*a, **{**k, "transport": transport})
    )

    await runtime_bind.maintain(AGENT_DID, priv)
    assert runtime_bind.STATUS.state == "active"


@pytest.mark.asyncio
async def test_key_bound_to_another_agent_is_an_error_not_active(monkeypatch, priv: PrivateKey) -> None:
    """Resolving by key answers with whatever agent the key is bound under.

    A key that resolves — but under someone else's DID — must never be
    reported as our active binding: the agent would sign under an identity a
    counterparty resolves to a different agent.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if "agents:lookup" in str(request.url):
            return httpx.Response(
                200,
                json={"data": {"id": "agt_SOMEONE_ELSE", "did": "did:kite:corp-kite:someone-else",
                               "matched_runtime": {"id": RUNTIME_ID, "status": "active",
                                                   "bind_method": "direct"}}},
            )
        raise AssertionError(f"must not be called: {request.url}")

    monkeypatch.setattr(runtime_bind, "IDENTITY_BASE_URL", "https://identity.example")
    monkeypatch.setattr(runtime_bind, "RETRY_SECONDS", 3600)
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())

    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: original(*a, **{**k, "transport": transport})
    )

    task = asyncio.create_task(runtime_bind.maintain(AGENT_DID, priv))
    for _ in range(200):
        if runtime_bind.STATUS.state == "error":
            break
        await asyncio.sleep(0)
    task.cancel()

    assert runtime_bind.STATUS.state == "error"
    assert "someone-else" in runtime_bind.STATUS.detail
    assert runtime_bind.STATUS.runtime_id == ""


def test_disabled_without_an_identity_url(monkeypatch) -> None:
    """The default posture for anyone who cloned this example: no binding, no
    error, and a home page that says which."""
    monkeypatch.setattr(runtime_bind, "IDENTITY_BASE_URL", "")
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())
    assert runtime_bind.start(AGENT_DID) is None
    assert runtime_bind.STATUS.state == "disabled"


def test_identity_url_without_a_key_is_reported_not_crashed(monkeypatch) -> None:
    monkeypatch.setattr(runtime_bind, "IDENTITY_BASE_URL", "https://identity.example")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", "")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY_FILE", "")
    monkeypatch.setattr(runtime_bind, "STATUS", runtime_bind.BindStatus())
    assert runtime_bind.start(AGENT_DID) is None
    assert runtime_bind.STATUS.state == "no-key"


def test_load_runtime_key_accepts_hex_with_and_without_prefix(monkeypatch) -> None:
    secret = "11" * 32
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", secret)
    assert runtime_bind.load_runtime_key().secret == bytes.fromhex(secret)
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", "0x" + secret)
    assert runtime_bind.load_runtime_key().secret == bytes.fromhex(secret)


def test_load_runtime_key_from_file(monkeypatch, tmp_path) -> None:
    """Secret stores commonly project a file rather than an env var."""
    path = tmp_path / "runtime.key"
    path.write_text("0x" + "22" * 32 + "\n")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", "")
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY_FILE", str(path))
    assert runtime_bind.load_runtime_key().secret == bytes.fromhex("22" * 32)


def test_garbage_key_is_reported_not_raised(monkeypatch) -> None:
    monkeypatch.setattr(runtime_bind, "RUNTIME_PRIVATE_KEY", "not-hex")
    assert runtime_bind.load_runtime_key() is None
