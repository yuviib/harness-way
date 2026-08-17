# Agents

Four real consumers of the relay, each a genuine WebSocket subscriber through the same `/subscribe` endpoint a browser client uses, not simulated traffic. Each one exercises a specific correctness property the relay provides:

- **resume-agent**: reconnects on a fixed interval and verifies the replay it gets back is gapless and picks up exactly where it left off.
- **gap-aware-agent**: treats every gap marker as an explicit resync signal, never as silence.
- **ordering-agent**: asserts live that sequence numbers arrive strictly increasing, with a periodic status report.
- **summarizer-agent** (optional): calls the Gemini API to turn each notification into a one-line human-readable summary. Only runs if `GEMINI_API_KEY` is set; the other three work fully without it.

## Running

Requires the gateway and origin-simulator running (see the root `README.md`).

```bash
cp .env.example .env   # fill in GEMINI_API_KEY if you want summarizer-agent
npm install
npm run dev
```

All four (or three, without a Gemini key) start in one process, each with its own independent WebSocket connection and reconnect loop. Every decision an agent makes gets posted to the gateway's `/api/agent-log` and shows up in the dashboard's Agents view.

## Why these four specifically

The point isn't "AI agents exist," it's that these agents' own logic depends on the exact guarantees this project is built to provide. An agent that reconnects and expects a gapless replay, or that treats a gap marker as a resync signal instead of quietly missing data, is the actual scenario the relay was built for, not a decorative label on a test client.
