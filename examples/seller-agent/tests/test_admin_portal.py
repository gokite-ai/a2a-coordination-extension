"""Public admin pages over the example seller's process-local agreement state."""

from __future__ import annotations

import httpx
import pytest

from seller_agent.__main__ import build_app
from seller_agent.executor import SellerExecutor


def _contract() -> dict:
    return {
        "schema": "https://a2a.gokite.ai/schemas/deal-contract/v1",
        "template": "fixed_outcome/v1",
        "buyerAgentId": "did:kite:buyerco:buyer-01",
        "sellerAgentId": "did:kite:pubco:seller-42",
        "deliverable": "One <script>alert('unsafe')</script> promotional post",
        "acceptanceCriteria": "Matches the signed brief",
        "price": {"amount": "24.00", "asset": "USDC"},
        "escrow": {"payoutAddress": "0x" + "11" * 20},
        "disputePolicy": {"arbiterAgentId": "did:kite:arbiterco:arbiter-01"},
        "runtimeBinding": {
            "runtimeAgentId": "did:kite:passport:coordination",
            "agentCardHash": "sha256:" + "22" * 32,
            "extensionUri": "https://a2a.gokite.ai/extensions/coordination/v1",
            "endpoint": "https://passport.dev.gokite.ai/a2a/v1",
        },
        "signatures": [],
    }


@pytest.mark.asyncio
async def test_public_admin_lists_and_opens_in_memory_agreement(monkeypatch) -> None:
    monkeypatch.setenv("KITE_COORDINATION_MODE", "standalone")
    executor = SellerExecutor()
    contract = _contract()
    executor._observe_agreement(
        "deal_admin_test",
        event="Proposal received",
        contract=contract,
        status={"state": "PROPOSED", "revision": 1},
    )
    executor._observe_agreement(
        "deal_admin_test",
        event="Agreement accepted",
        contract=contract,
        status={"state": "COMMITTED", "revision": 2},
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=build_app(executor=executor)),
        base_url="http://seller.test",
    ) as client:
        home = await client.get("/")
        assert home.status_code == 200
        assert 'href="/admin"' in home.text

        # No credentials or authorization headers are supplied: this page is
        # intentionally public for the example seller.
        listing = await client.get("/admin")
        assert listing.status_code == 200
        assert "deal_admin_test" in listing.text
        assert "did:kite:buyerco:buyer-01" in listing.text
        assert "COMMITTED" in listing.text
        assert "&lt;script&gt;" in listing.text
        assert "<script>" not in listing.text

        detail = await client.get("/admin/agreements/deal_admin_test")
        assert detail.status_code == 200
        assert "Agreement accepted" in detail.text
        assert "Proposal received" in detail.text
        assert "did:kite:arbiterco:arbiter-01" in detail.text
        assert "Latest Runtime status" in detail.text
        assert "Raw agreement contract" in detail.text

        missing = await client.get("/admin/agreements/missing")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_admin_empty_state(monkeypatch) -> None:
    monkeypatch.setenv("KITE_COORDINATION_MODE", "standalone")
    executor = SellerExecutor()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=build_app(executor=executor)),
        base_url="http://seller.test",
    ) as client:
        response = await client.get("/admin")
    assert response.status_code == 200
    assert "No agreements have been observed" in response.text


@pytest.mark.asyncio
async def test_admin_refreshes_current_runtime_status(monkeypatch) -> None:
    class Runtime:
        async def status(self, deal_id: str) -> dict:
            assert deal_id == "deal_refresh_test"
            return {"state": "COMPLETED", "revision": 7}

    monkeypatch.setenv("KITE_COORDINATION_MODE", "standalone")
    executor = SellerExecutor()
    executor._observe_agreement(
        "deal_refresh_test",
        event="Delivery submitted",
        contract=_contract(),
        status={"state": "DELIVERED", "revision": 6},
    )
    executor.runtime = Runtime()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=build_app(executor=executor)),
        base_url="http://seller.test",
    ) as client:
        response = await client.get("/admin/agreements/deal_refresh_test")

    assert response.status_code == 200
    assert "COMPLETED" in response.text
    assert "Status refreshed" in response.text
    assert "revision&quot;: 7" in response.text
