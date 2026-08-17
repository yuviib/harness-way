"""Async WebSocket chaos driver against the REAL running gateway.

Each ChaosClient is one simulated downstream subscriber: it connects,
records every message it receives (with a monotonic timestamp) into the
shared format metrics.py analyzes, and deliberately disconnects/reconnects
at scheduled offsets, tracking its own last-seen seq across reconnects the
same way a real client would (so replay correctness gets genuinely
exercised, not simulated). Disconnect timing should be drawn from a
`random.Random` seeded per-run by the caller (see run_eval.py), not
wall-clock jitter -- a chaos run that isn't reproducible from its own
logged seed is a worse chaos tool than not having one (same principle
PLAN.md states for the harness generally).
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from urllib.parse import urlencode

import websockets

from harness.metrics import ReceivedMessage


@dataclass
class ChaosClientConfig:
    gateway_ws_base: str  # e.g. "ws://127.0.0.1:18787/subscribe"
    origin_url: str
    category: str
    token: str
    client_id: str
    # Absolute offsets (seconds from this client's run() start) at which to
    # deliberately disconnect and immediately reconnect. Sorted ascending.
    disconnect_offsets_s: tuple[float, ...] = field(default_factory=tuple)


class ChaosClient:
    def __init__(self, config: ChaosClientConfig):
        self._config = config
        self.messages: list[ReceivedMessage] = []
        self.last_seen_seq: int = 0

    def _url(self) -> str:
        params = {
            "originUrl": self._config.origin_url,
            "category": self._config.category,
            "lastSeenSeq": str(self.last_seen_seq),
        }
        return f"{self._config.gateway_ws_base}?{urlencode(params)}"

    def _record(self, raw: str) -> None:
        payload = json.loads(raw)
        now = time.monotonic()
        msg_type = payload["type"]
        if msg_type == "replay":
            seqs = tuple(e["seq"] for e in payload["events"])
            self.messages.append(ReceivedMessage(self._config.client_id, "replay", now, replay_seqs=seqs))
            if seqs:
                self.last_seen_seq = max(self.last_seen_seq, max(seqs))
        elif msg_type == "event":
            seq = payload["seq"]
            self.messages.append(ReceivedMessage(self._config.client_id, "event", now, seq=seq))
            self.last_seen_seq = max(self.last_seen_seq, seq)
        elif msg_type == "gap":
            oldest_available = payload["oldestAvailableSeq"]
            self.messages.append(ReceivedMessage(self._config.client_id, "gap", now, gap_from_seq=oldest_available))
            # Without this, a client that ever actually receives a gap
            # would reconnect with the SAME stale last_seen_seq forever,
            # hitting the identical gap on every future reconnect and
            # never making progress -- found while writing metrics.py's
            # replay-self-consistency check, before it ever caused a
            # visible failure. Treat oldest_available - 1 as "acknowledged
            # lost", matching PLAN.md's "you have a gap, resubscribe
            # fresh" -- the next reconnect's lastSeenSeq then lands exactly
            # on the boundary sendReplay treats as no-longer-a-gap.
            self.last_seen_seq = max(self.last_seen_seq, oldest_available - 1)
        else:
            raise ValueError(f"unrecognized message type from gateway: {payload!r}")

    async def _recv_until(self, ws: websockets.ClientConnection, deadline: float) -> None:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except TimeoutError:
                return
            self._record(raw)

    async def run(self, duration_s: float) -> list[ReceivedMessage]:
        start = time.monotonic()
        remaining_offsets = list(self._config.disconnect_offsets_s)

        while time.monotonic() - start < duration_s:
            next_disconnect_at = remaining_offsets.pop(0) if remaining_offsets else duration_s
            segment_deadline = start + min(next_disconnect_at, duration_s)

            async with websockets.connect(
                self._url(), additional_headers={"Authorization": f"Bearer {self._config.token}"}
            ) as ws:
                await self._recv_until(ws, segment_deadline)
            # `async with` closing here IS the deliberate disconnect --
            # looping back reconnects with the updated last_seen_seq,
            # exercising real replay-on-reconnect against the gateway.

        return self.messages
