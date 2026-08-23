# Demo script

A guided walkthrough for showing this project live, roughly 5 minutes. Works either against the
real production deployment (see the "Live" section of the root `README.md` for URLs) or against
local dev, per the README's "Running it locally" section, with all four terminals started
(origin-simulator, gateway, dashboard, and optionally agents). The local version lets you kill and
restart the origin process yourself for step 2; the live version shows the same guarantees holding
on real Cloudflare infrastructure instead.

## 1. Show the multiplexing claim is real (Live Fan-out, ~1 minute)

Open the dashboard, go to **Live Fan-out**, click **Connect 3 subscribers**.

Point out:
- The topology diagram: one line from the origin to the relay, then it fans out to three subscribers. That single upstream line is the actual claim of this project, not decoration, it's one real `fetch()` connection open on the server.
- All three subscriber panes show the same sequence numbers arriving at the same time. That's the proof: it's one upstream connection multiplexed live, not three independent polling loops each faking synchrony.
- Click **Disconnect all**, wait 5 seconds, reconnect. The relay's idle-teardown alarm closed the real upstream connection while nobody was listening, and reopened it fresh, no wasted connection time when nobody's watching.

## 2. Show a real failure and a real recovery (Gap Audit, ~1 minute)

Local dev only: kill the origin-simulator process (Ctrl+C in its terminal), wait a few seconds, restart it (`npm run dev`). Against the live deployment, this step can be narrated from a recorded outage instead, or skipped in favor of pointing at an existing gap row in the log from an earlier run.

Switch to **Gap Audit**. Point out:
- The Gap markers stat tile increments, and the gap log table shows a new row with cause `Upstream drop`, an actual timestamp, and the sequence number reliable delivery resumed from.
- This wasn't simulated. The origin process really died and really restarted; the relay's reconnect-with-backoff logic and gap-marker broadcast both fired for real, and the dashboard is reading the same D1 table the relay wrote to, not replaying a script.
- The KPI row (Events logged, Gap markers, Reconnects, Gap rate) uses `/api/delivery-log/counts`, true totals, not a count of however many rows a limited fetch happened to return. Worth explaining why that distinction exists (see the root README's Gap Audit note) if asked.

## 3. Show why this matters for agents specifically (Agents, ~1.5 minutes)

Start `apps/agents` if not already running (`npm run dev` in that directory, pointed at either the live gateway or local dev).

Switch to the **Agents** tab. Point out, per card:
- **resume-agent**: every ~20 seconds it deliberately disconnects and reconnects, then verifies the replay it gets back is gapless and starts exactly where it left off. Each `Reconnect verified` entry is a real check that just passed against the real relay.
- **gap-aware-agent**: only logs when it actually receives a gap marker. If you killed the origin in step 2 while this was running, there should be a `Resync` entry here too, an agent that treated the gap honestly instead of silently missing data.
- **ordering-agent**: periodic `Order check` entries confirming zero ordering violations across however many live events it's seen.
- **summarizer-agent** (if a Gemini or Groq key is configured): one-line natural-language summaries of what each notification actually means, generated live.

The point to land here: these aren't decorative test clients. Each agent's own logic is written assuming the relay's guarantees hold, gapless replay, honest gap signaling, strict ordering, and the dashboard is showing those assumptions being validated live, not asserted in a test file nobody in the room can see.

## 4. Show the second capability: a real caller sharing another caller's cached result (Cache Metrics, ~1.5 minutes)

Run the two-caller demo live: `cd apps/agents && npm run demo:cache`.

Narrate each step as it prints:
- **Step 1**: `caller-agent-1` asks the relay's `POST /relay` a question nobody has asked yet, in a fresh scope. `x-cache: MISS`, and the response takes ~250-400ms, the origin-simulator's synthetic tool has a real artificial latency baked in specifically so this is felt, not just claimed.
- **Step 2**: `caller-agent-2`, a genuinely separate call, modeling a different caller process, not a repeat from the same one, asks the identical question in the same scope. `x-cache: HIT`, ~20-40ms, and the script asserts the body is byte-identical to step 1's. Point out `originCallSeq` inside both JSON bodies: it's the same number in both responses, proof the origin was never asked a second time, not just an inference from the response being fast.
- **Step 3**: a third caller asks the identical question in an unrelated scope. `x-cache: MISS` again, and `originCallSeq` has advanced, a different scope never sees another scope's cached entry. This is scope isolation, demonstrated, not just tested.

Then switch to the dashboard's **Cache Metrics** tab, optionally filtering the scope box to the `demo-shared-...` scope the script printed at the end. Point out:
- Hit rate, bytes saved, and "latency saved / hit" all come from `GET /api/cache-log/stats`, a real `GROUP BY` aggregate over `cache_log`, not a client-side sum of whatever rows happen to be visible.
- The outcome bar and recent-accesses table are reading the exact same D1 rows the `/relay` calls above just wrote, refresh the terminal demo again and watch the tab update within its 4-second poll.

Worth stating plainly if asked: `scope` here is caller-supplied, not derived from real authenticated identity, the same "known gap, noted not hidden" boundary as the shared subscribe token (see "What not to claim" below).

## 5. If there's time: show rate limiting hold the line (~1 minute)

Against the live deployment, send more than 30 requests to `/subscribe` or `/relay` from the same client within 60 seconds. The first 30 succeed; the 31st and beyond return 429. Worth stating plainly: this is a real Cloudflare Rate Limiting binding, not a hand-rolled counter, and the key it limits on is the caller's actual `CF-Connecting-IP`, which Cloudflare's own edge rejects any attempt to spoof with error 1000, so the limit can't be routed around by lying about your IP.

## 6. If there's time: show the chaos harness results directly

```bash
cd eval
cat results/*/result.json
```

Three real recorded runs, each killing a real process or flapping real WebSocket connections on a schedule, zero violations across all of them. Worth mentioning what "violation" means precisely if asked: a silent gap, a duplicate sequence number, an out-of-order delivery, or a replay that isn't internally consistent, defined in `eval/harness/metrics.py`, not hand-waved.

## What not to claim

- The auth model is a shared dev token, not per-agent identity. Say so if asked how a real deployment would handle multiple untrusted callers. Capability 2's `scope` is caller-supplied for the same reason, a real deployment would derive it from real identity, but there is no real per-caller identity to derive it from yet in v1.
- The upstream-residency GB-seconds cost hasn't been measured yet. The deployment now exists to measure it against; it needs sustained production load to collect meaningfully, and hasn't happened, say so if asked what this would actually cost to run at scale.
- Capability 2's cache-index lookup is a Durable Object with its own SQLite storage, not the Cache API or KV named in the original plan sketch, say so if asked why, and point to `docs/ARCHITECTURE.md`'s "storage: DO SQLite, not Cache API/KV" section for the reasoning (same one `FeedRelay`'s own replay buffer already settled).
