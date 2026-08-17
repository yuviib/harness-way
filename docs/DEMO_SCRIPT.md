# Demo script

A guided walkthrough for showing this project live, roughly 5 minutes. Assumes local dev, per the root `README.md`'s "Running it locally" section, with all four terminals started (origin-simulator, gateway, dashboard, and optionally agents).

## 1. Show the multiplexing claim is real (Live Fan-out, ~1 minute)

Open the dashboard, go to **Live Fan-out**, click **Connect 3 subscribers**.

Point out:
- The topology diagram: one line from the origin to the relay, then it fans out to three subscribers. That single upstream line is the actual claim of this project, not decoration, it's one real `fetch()` connection open on the server.
- All three subscriber panes show the **same sequence numbers arriving at the same time**. That's the proof: it's one upstream connection multiplexed live, not three independent polling loops each faking synchrony.
- Click **Disconnect all**, wait 5 seconds, reconnect. The relay's idle-teardown alarm closed the real upstream connection while nobody was listening, and reopened it fresh, no wasted connection time when nobody's watching.

## 2. Show a real failure and a real recovery (Gap Audit, ~1 minute)

Kill the origin-simulator process (Ctrl+C in its terminal), wait a few seconds, restart it (`npm run dev`).

Switch to **Gap Audit**. Point out:
- The Gap markers stat tile increments, and the gap log table shows a new row with cause `Upstream drop`, an actual timestamp, and the sequence number reliable delivery resumed from.
- This wasn't simulated. The origin process really died and really restarted; the relay's reconnect-with-backoff logic and gap-marker broadcast both fired for real, and the dashboard is reading the same D1 table the relay wrote to, not replaying a script.
- The KPI row (Events logged, Gap markers, Reconnects, Gap rate) uses `/api/delivery-log/counts`, true totals, not a count of however many rows a limited fetch happened to return. Worth explaining why that distinction exists (see the root README's Gap Audit note) if asked.

## 3. Show why this matters for agents specifically (Agents, ~1.5 minutes)

Start `apps/agents` if not already running (`npm run dev` in that directory).

Switch to the **Agents** tab. Point out, per card:
- **resume-agent**: every ~20 seconds it deliberately disconnects and reconnects, then verifies the replay it gets back is gapless and starts exactly where it left off. Each `Reconnect verified` entry is a real check that just passed against the real relay.
- **gap-aware-agent**: only logs when it actually receives a gap marker. If you killed the origin in step 2 while this was running, there should be a `Resync` entry here too, an agent that treated the gap honestly instead of silently missing data.
- **ordering-agent**: periodic `Order check` entries confirming zero ordering violations across however many live events it's seen.
- **summarizer-agent** (if a Gemini key is configured): one-line natural-language summaries of what each notification actually means, generated live.

The point to land here: these aren't decorative test clients. Each agent's own logic is written assuming the relay's guarantees hold, gapless replay, honest gap signaling, strict ordering, and the dashboard is showing those assumptions being validated live, not asserted in a test file nobody in the room can see.

## 4. If there's time: show the chaos harness results directly

```bash
cd eval
cat results/*/result.json
```

Three real recorded runs, each killing a real process or flapping real WebSocket connections on a schedule, zero violations across all of them. Worth mentioning what "violation" means precisely if asked: a silent gap, a duplicate sequence number, an out-of-order delivery, or a replay that isn't internally consistent, defined in `eval/harness/metrics.py`, not hand-waved.

## What not to claim

- Not deployed to real Cloudflare infrastructure yet, this is all local `wrangler dev`. Say so if asked about a live URL.
- The auth model is a shared dev token, not per-agent identity. Say so if asked how a real deployment would handle multiple untrusted callers.
- Capability 2 (a shared content-addressed cache) was scoped but never built. Say so rather than implying it exists.
