"""Process controller for the REAL apps/origin-simulator Worker.

Not a Python stand-in for the origin -- that's what apps/origin-simulator
itself already is (a real Worker, deliberately labeled synthetic in its own
source, per PLAN.md's traffic-model section). This module's job is
narrower: start/stop/restart that real process on command, so a chaos
scenario can trigger a genuine upstream outage (not a mocked one) by
actually killing and restarting the origin's real wrangler dev instance --
exercising FeedRelay's reconnect-with-backoff and gap-marker paths against
real infrastructure, the way the vitest mock-based tests structurally can't.
"""

from __future__ import annotations

from harness._wrangler_process import WranglerDevConfig, WranglerDevProcess

FeedSimulatorConfig = WranglerDevConfig


class FeedSimulator(WranglerDevProcess):
    def restart(self) -> None:
        """Simulates a genuine upstream outage: the real origin process
        goes away and comes back, exactly as FeedRelay's connectUpstream
        would see a real network/process failure -- not a mocked one."""
        super().restart()
