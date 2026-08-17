"""Tests of the chaos client itself -- per PLAN.md's SDLC section, "a chaos
tool that doesn't reliably reproduce its intended failure is worse than not
having one." Split in two tiers:

- Unit tests below exercise _record()'s message-parsing and last_seen_seq
  tracking directly, no network involved -- these run by default.
- The `live` tier (bottom of file, @pytest.mark.live, excluded by default
  per pyproject.toml's addopts) actually starts the real gateway +
  origin-simulator and runs a real ChaosClient with a real scheduled
  disconnect against them. Run explicitly with `uv run pytest -m live`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from harness.chaos_client import ChaosClient, ChaosClientConfig
from harness.metrics import analyze


def _client() -> ChaosClient:
    return ChaosClient(
        ChaosClientConfig(
            gateway_ws_base="ws://unused/subscribe",
            origin_url="http://unused/mcp",
            category="c",
            token="t",
            client_id="test-client",
        )
    )


class TestRecord:
    def test_replay_with_events_is_recorded_and_advances_last_seen_seq(self):
        client = _client()
        client._record(json.dumps({"type": "replay", "events": [{"seq": 3}, {"seq": 4}]}))
        assert client.last_seen_seq == 4
        assert client.messages[0].msg_type == "replay"
        assert client.messages[0].replay_seqs == (3, 4)

    def test_empty_replay_does_not_move_last_seen_seq_backwards(self):
        client = _client()
        client.last_seen_seq = 10
        client._record(json.dumps({"type": "replay", "events": []}))
        assert client.last_seen_seq == 10

    def test_event_is_recorded_and_advances_last_seen_seq(self):
        client = _client()
        client._record(json.dumps({"type": "event", "seq": 7, "upstreamId": None, "event": None, "data": "{}"}))
        assert client.last_seen_seq == 7
        assert client.messages[0].seq == 7

    def test_gap_advances_last_seen_seq_to_the_boundary_so_the_next_reconnect_makes_progress(self):
        # Without this, a client stuck behind a gap would reconnect with
        # the same stale lastSeenSeq forever and hit the identical gap on
        # every future reconnect -- confirmed as a real bug found while
        # building metrics.py's replay-self-consistency check, fixed here.
        client = _client()
        client.last_seen_seq = 5
        client._record(json.dumps({"type": "gap", "oldestAvailableSeq": 20}))
        assert client.last_seen_seq == 19
        assert client.messages[0].gap_from_seq == 20

    def test_gap_never_moves_last_seen_seq_backwards(self):
        client = _client()
        client.last_seen_seq = 50
        client._record(json.dumps({"type": "gap", "oldestAvailableSeq": 20}))
        assert client.last_seen_seq == 50

    def test_unrecognized_message_type_raises_rather_than_silently_dropping(self):
        client = _client()
        with pytest.raises(ValueError, match="unrecognized"):
            client._record(json.dumps({"type": "something-new"}))

    def test_url_includes_current_last_seen_seq(self):
        client = _client()
        client.last_seen_seq = 42
        assert "lastSeenSeq=42" in client._url()


# ---------------------------------------------------------------------------
# Live tier: real gateway + real origin-simulator, real WebSocket, a real
# scheduled disconnect/reconnect. Skipped automatically if the toolchain
# this needs isn't set up on the current machine (documented, not silent).
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_BIN_DIR = Path(os.environ.get("WAYSTATION_NODE_BIN_DIR", r"C:\Users\yuvra\AppData\Local\nvm\v24.19.0"))


def _node_available() -> bool:
    return (NODE_BIN_DIR / "node.exe").exists()


@pytest.mark.live
@pytest.mark.skipif(not _node_available(), reason=f"node.exe not found at {NODE_BIN_DIR} (set WAYSTATION_NODE_BIN_DIR)")
async def test_real_chaos_client_survives_a_scheduled_disconnect_with_no_violations():
    from harness._wrangler_process import WranglerDevConfig, WranglerDevProcess
    from harness.feed_simulator import FeedSimulator

    # Port 8794 is not arbitrary -- it's the one host:port gateway/wrangler.toml's
    # ALLOWED_ORIGIN_HOSTS SSRF allowlist actually permits for dev; any other
    # port gets a correct, deliberate 403 (confirmed by testing -- the
    # allowlist doing its job, not a bug to route around).
    origin = FeedSimulator(
        WranglerDevConfig(project_dir=REPO_ROOT / "apps" / "origin-simulator", port=8794, node_bin_dir=NODE_BIN_DIR)
    )
    gateway = WranglerDevProcess(
        WranglerDevConfig(project_dir=REPO_ROOT / "apps" / "gateway", port=18793, node_bin_dir=NODE_BIN_DIR)
    )
    with origin, gateway:
        client = ChaosClient(
            ChaosClientConfig(
                gateway_ws_base="ws://127.0.0.1:18793/subscribe",
                origin_url="http://127.0.0.1:8794/mcp",
                category="resource_changed",
                token="dev-only-shared-secret",
                client_id="live-test-client",
                disconnect_offsets_s=(3.0,),
            )
        )
        messages = await client.run(duration_s=7.0)

    assert len(messages) > 0, "chaos client received nothing at all -- the real pipeline is not working"
    result = analyze(messages)
    assert result.passed, result.summary()
