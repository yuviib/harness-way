// A real consumer that calls the Gemini API to turn each raw notification
// into a one-line human-readable summary. Optional: runs only if
// GEMINI_API_KEY is set, so the other three agents work fully without it.
// No SDK dependency -- a direct call to Gemini's REST API, so the request
// and failure modes are visible rather than hidden behind a client library.

import { type BufferedEvent, type Config, connect, loadConfig, logAction, parseMessage } from "./shared.ts";

const AGENT_NAME = "summarizer-agent";
const AGENT_ROLE = "Calls the Gemini API to turn each notification into a one-line human-readable summary.";
const DEFAULT_MODEL = "gemini-2.0-flash";
// Conservative client-side throttle. Free-tier per-minute limits vary by
// model and account and change over time, so this errs low rather than
// assuming a specific number -- skipped calls are silently dropped, never
// queued, since a summary is a nice-to-have annotation, not a guarantee.
const MIN_INTERVAL_MS = 8_000;

function summarizePrompt(evt: BufferedEvent): string {
  return `You are watching a live stream of MCP resource-change notifications. In ONE short sentence (under 20 words, no preamble, no markdown), describe what this notification means in plain language:\n\n${evt.data}`;
}

async function callGemini(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini API response had no candidate text");
  }
  return text.trim();
}

function run(config: Config, apiKey: string, model: string): Promise<never> {
  let lastSeenSeq = 0;
  let lastCallAt = 0;

  function connectOnce(): void {
    const ws = connect(config, lastSeenSeq);

    ws.addEventListener("message", (evt: MessageEvent) => {
      const msg = parseMessage(String(evt.data));
      if (msg.type === "gap") {
        lastSeenSeq = Math.max(lastSeenSeq, msg.oldestAvailableSeq - 1);
        return;
      }
      if (msg.type === "replay") {
        if (msg.events.length > 0) lastSeenSeq = msg.events[msg.events.length - 1]!.seq;
        return;
      }

      lastSeenSeq = msg.seq;
      const now = Date.now();
      if (now - lastCallAt < MIN_INTERVAL_MS) return; // throttled, skip silently
      lastCallAt = now;

      callGemini(apiKey, model, summarizePrompt(msg))
        .then((summary) => {
          void logAction(config, { agentName: AGENT_NAME, agentRole: AGENT_ROLE, actionType: "summary", seq: msg.seq, detail: summary });
        })
        .catch((err: unknown) => {
          void logAction(config, {
            agentName: AGENT_NAME,
            agentRole: AGENT_ROLE,
            actionType: "error",
            seq: msg.seq,
            detail: err instanceof Error ? err.message : String(err),
          });
        });
    });

    ws.addEventListener("close", () => {
      setTimeout(connectOnce, 500);
    });
  }

  connectOnce();
  return new Promise<never>(() => {});
}

export function startSummarizerAgent(config: Config = loadConfig()): Promise<never> | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(`[${AGENT_NAME}] GEMINI_API_KEY not set, this agent will not run. The other three work fine without it.`);
    return null;
  }
  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  return run(config, apiKey, model);
}
