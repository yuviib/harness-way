# Chaos-testing harness

Validates the gateway's replay and gap-marker correctness against real, controlled failures, not mocked ones. `upstream_outage` kills and restarts the actual `origin-simulator` process mid-run using `taskkill` (Windows requires killing the child process directly, not just the shell wrapper `terminate()` reaches). `downstream_flap` disconnects and reconnects real WebSocket clients against a live gateway on a randomized schedule.

## Setup

```bash
uv venv
uv pip install -e ".[dev]"
```

## Running the fast (non-live) tests

```bash
pytest
```

This covers the metrics/analysis logic (`test_metrics.py`) and the chaos client's own connection handling (`test_chaos_client.py`) without needing a running gateway.

## Running a real chaos scenario

Requires the gateway and origin-simulator built and reachable (see the root `README.md` for local dev setup).

```bash
python -m harness.run_eval scenarios/upstream_outage.json
python -m harness.run_eval scenarios/downstream_flap.json
```

Each run writes a timestamped directory under `results/` containing:

- `scenario.json`: the exact scenario config used
- `messages.jsonl`: every message every client actually received, in order
- `result.json`: pass/fail and a list of any violations

A violation is one of: a silent gap (an event skipped with no gap marker), a duplicate sequence number, an out-of-order delivery, or a replay that isn't internally consistent with the events actually sent. See `harness/metrics.py` for the exact checks.

## Live-tier tests

A small number of tests in `test_chaos_client.py` are marked `@pytest.mark.live` and require a real running gateway and origin-simulator. Excluded by default (`addopts = "-m 'not live'"` in `pyproject.toml`); run explicitly with:

```bash
pytest -m live
```
