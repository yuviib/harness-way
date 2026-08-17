"""CLI entrypoint: runs a chaos scenario against a REAL gateway +
origin-simulator, analyzes the recorded run against PLAN.md's correctness
properties, and writes a results artifact to eval/results/. Exits non-zero
if any property was violated, so this is safe to wire into CI later.

Usage:
    uv run python -m harness.run_eval scenarios/downstream_flap.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from harness._wrangler_process import WranglerDevConfig, WranglerDevProcess
from harness.chaos_client import ChaosClient, ChaosClientConfig
from harness.feed_simulator import FeedSimulator
from harness.metrics import AnalysisResult, ReceivedMessage, analyze

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_NODE_BIN_DIR = r"C:\Users\yuvra\AppData\Local\nvm\v24.19.0"
# Fixed, not arbitrary: gateway/wrangler.toml's ALLOWED_ORIGIN_HOSTS SSRF
# allowlist only permits 127.0.0.1:8794 for dev -- confirmed by testing
# (any other origin port gets a correct, deliberate 403).
ORIGIN_PORT = 8794
GATEWAY_TOKEN = "dev-only-shared-secret"  # matches wrangler.toml's dev-only SUBSCRIBE_TOKEN


@dataclass
class Scenario:
    name: str
    description: str
    duration_s: float
    num_clients: int
    seed: int
    category: str
    disconnect_min_s: float = 1e9  # effectively "never" if unset
    disconnect_max_s: float = 1e9
    max_disconnects_per_client: int = 0
    upstream_outage_offsets_s: tuple[float, ...] = field(default_factory=tuple)
    gateway_port: int = 18795


def load_scenario(path: Path) -> Scenario:
    data = json.loads(path.read_text())
    data["upstream_outage_offsets_s"] = tuple(data.get("upstream_outage_offsets_s", ()))
    return Scenario(**data)


def _generate_disconnect_offsets(rng: random.Random, scenario: Scenario) -> tuple[float, ...]:
    """Reproducible from the scenario's own seed, not wall-clock jitter --
    a chaos run that can't be reproduced from its logged config is a worse
    chaos tool than not having one (PLAN.md's own stated principle)."""
    if scenario.max_disconnects_per_client == 0:
        return ()
    offsets: list[float] = []
    t = rng.uniform(scenario.disconnect_min_s, scenario.disconnect_max_s)
    while t < scenario.duration_s and len(offsets) < scenario.max_disconnects_per_client:
        offsets.append(t)
        t += rng.uniform(scenario.disconnect_min_s, scenario.disconnect_max_s)
    return tuple(offsets)


async def _run_outage_schedule(origin: FeedSimulator, offsets_s: tuple[float, ...], run_start: float) -> None:
    for offset in offsets_s:
        target = run_start + offset
        delay = target - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        # FeedSimulator.restart() is a blocking subprocess call (real
        # process kill + real wrangler dev startup, seconds-scale) --
        # run it off the event loop so it doesn't stall the chaos clients'
        # own asyncio.wait_for timers mid-segment.
        await asyncio.to_thread(origin.restart)


async def run_scenario(scenario: Scenario, node_bin_dir: Path, output_dir: Path) -> AnalysisResult:
    origin = FeedSimulator(
        WranglerDevConfig(project_dir=REPO_ROOT / "apps" / "origin-simulator", port=ORIGIN_PORT, node_bin_dir=node_bin_dir)
    )
    gateway = WranglerDevProcess(
        WranglerDevConfig(
            project_dir=REPO_ROOT / "apps" / "gateway", port=scenario.gateway_port, node_bin_dir=node_bin_dir
        )
    )

    rng = random.Random(scenario.seed)
    client_offsets = {i: _generate_disconnect_offsets(rng, scenario) for i in range(scenario.num_clients)}
    print(f"[run_eval] scenario={scenario.name!r} seed={scenario.seed} disconnect offsets: {client_offsets}")

    print("[run_eval] starting origin-simulator + gateway...")
    with origin, gateway:
        print(f"[run_eval] both ready -- running {scenario.num_clients} client(s) for {scenario.duration_s}s")
        clients = [
            ChaosClient(
                ChaosClientConfig(
                    gateway_ws_base=f"ws://127.0.0.1:{scenario.gateway_port}/subscribe",
                    origin_url=origin.base_url + "/mcp",
                    category=scenario.category,
                    token=GATEWAY_TOKEN,
                    client_id=f"client-{i}",
                    disconnect_offsets_s=client_offsets[i],
                )
            )
            for i in range(scenario.num_clients)
        ]

        run_start = time.monotonic()
        tasks = [asyncio.create_task(c.run(scenario.duration_s)) for c in clients]
        if scenario.upstream_outage_offsets_s:
            tasks.append(
                asyncio.create_task(_run_outage_schedule(origin, scenario.upstream_outage_offsets_s, run_start))
            )
        results = await asyncio.gather(*tasks)

    all_messages: list[ReceivedMessage] = []
    for r in results[: scenario.num_clients]:
        all_messages.extend(r)

    result = analyze(all_messages)
    _write_results(scenario, client_offsets, all_messages, result, output_dir)
    return result


def _write_results(
    scenario: Scenario,
    client_offsets: dict[int, tuple[float, ...]],
    messages: list[ReceivedMessage],
    result: AnalysisResult,
    output_dir: Path,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "scenario.json").write_text(
        json.dumps({**asdict(scenario), "client_disconnect_offsets_s": client_offsets}, indent=2)
    )
    (output_dir / "messages.jsonl").write_text("\n".join(json.dumps(asdict(m)) for m in messages))
    (output_dir / "result.json").write_text(
        json.dumps(
            {
                "passed": result.passed,
                "total_messages": result.total_messages,
                "violations": [asdict(v) for v in result.violations],
            },
            indent=2,
        )
    )
    print(f"[run_eval] results written to {output_dir}")
    print(result.summary())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario_path", type=Path)
    parser.add_argument("--node-bin-dir", type=Path, default=Path(os.environ.get("WAYSTATION_NODE_BIN_DIR", DEFAULT_NODE_BIN_DIR)))
    parser.add_argument("--output-dir", type=Path, default=None)
    args = parser.parse_args()

    scenario = load_scenario(args.scenario_path)
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    output_dir = args.output_dir or (REPO_ROOT / "eval" / "results" / f"{timestamp}-{scenario.name}")

    result = asyncio.run(run_scenario(scenario, args.node_bin_dir, output_dir))
    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(main())
