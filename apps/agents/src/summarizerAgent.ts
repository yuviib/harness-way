// A real consumer that calls an LLM to turn each raw notification into a
// one-line human-readable summary. Optional: runs only if GEMINI_API_KEY is
// set, so the other three agents work fully without it. No SDK dependency
// -- direct REST calls, so the request and failure modes are visible
// rather than hidden behind a client library.

import { type BufferedEvent, type Config, connect, loadConfig, logAction, parseMessage } from "./shared.ts";

const AGENT_NAME = "summarizer-agent";
const AGENT_ROLE =
  "Calls an LLM to turn each notification into a one-line human-readable summary, falling back across models (and, if configured, providers) on quota/overload errors.";

// "gemini-flash-latest" is a stable alias Google maintains rather than a
// dated version -- confirmed against the actual /v1beta/models list for a
// real key (not assumed): the specific dated model this defaulted to
// originally ("gemini-2.0-flash") no longer exists at all, a real 404 not
// a config mistake, since model availability moves faster than this
// default should need re-verifying by hand.
const DEFAULT_MODEL = "gemini-flash-latest";

// Quota-fallback chain: every model on the same Gemini API key has its own
// separate quota bucket (the same pattern and confirmed-working model set
// used in a sibling project, CarletonUniAcademicOS/backend/app/agent/
// orchestrator.py -- re-verified here live against THIS project's own key
// via GET /v1beta/models before reuse, not copied on trust: all four model
// names below genuinely exist and support generateContent as of this
// writing). Falling back to a different model on the SAME key when one is
// quota-exhausted or momentarily overloaded is normal, expected multi-
// model usage. This deliberately does NOT rotate API keys/projects to
// dodge one model's own limit -- the sibling project's own code comment
// states that distinction explicitly, and it's kept here too: a chain of
// models under one key, never a chain of keys.
// `gemma-4-31b-it` was dropped from this chain (2026-08-21): unlike the
// Gemini-branded models above, it doesn't reliably follow the "one sentence,
// no preamble" instruction against this endpoint -- observed live, dumping a
// full chain-of-thought ("Draft 1... Draft 2... Wait, let's check...") into
// the summary instead of just the answer. Not swapped for another unverified
// name, per this file's own discipline above: only models re-checked live
// against a real key belong in this chain.
const GEMINI_FALLBACK_MODELS = ["gemini-flash-lite-latest", "gemini-3.1-flash-lite"] as const;

// Builds the actual chain to try: the configured (or default) model first,
// then every fallback not already equal to it -- so setting GEMINI_MODEL to
// one of the fallbacks doesn't produce a chain that tries the same model
// twice in a row.
export function buildModelChain(configuredModel: string): string[] {
  const chain = [configuredModel];
  for (const m of GEMINI_FALLBACK_MODELS) {
    if (!chain.includes(m)) chain.push(m);
  }
  return chain;
}

// 429 (quota exhausted) and 503 (model overloaded) are both transient,
// per-model failures where retrying the same request against the next
// model in the chain is a legitimate fix -- unlike a 4xx like 400/404 (a
// malformed request or a genuinely wrong model name), which will fail
// identically on every model and should surface immediately rather than
// burn through the whole chain for nothing. Same two codes, same
// reasoning, as the sibling project's own _is_retryable_error.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

// Not a parameter-property (`constructor(public readonly status...)`) --
// that shorthand has runtime semantics (it both declares AND assigns the
// field), which Node's --experimental-strip-types explicitly rejects as
// unsupported ("TypeScript parameter property is not supported in
// strip-only mode"), confirmed by this actually failing that way first.
// Explicit field + assignment is the type-erasure-safe equivalent.
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

// Conservative client-side throttle on the happy path: with zero
// consecutive fully-exhausted chains, calls are still allowed at most this
// often. Free-tier per-minute limits vary by model and account and change
// over time, so this errs low rather than assuming a specific number --
// skipped calls are silently dropped, never queued, since a summary is a
// nice-to-have annotation, not a guarantee.
const MIN_INTERVAL_MS = 8_000;

// Real bug, found running this against a live account for real: with a
// FIXED 8s throttle and no backoff, a quota exhaustion (HTTP 429) or a
// transient overload (HTTP 503) doesn't recover on its own -- the agent
// just keeps retrying every 8s regardless, which does nothing but spam
// the Agents view with an error every 8s and keep hammering an API that
// already said "stop." This backoff governs how often a FULL chain attempt
// (every model, then the optional Groq tier below) is even allowed to run
// -- not retries within one chain attempt, which happen immediately (see
// callModelChain). Doubling the required interval on every consecutive
// fully-exhausted chain (capped at 10 minutes) means a sustained account-
// wide exhaustion quickly backs off instead of hammering every 8 seconds,
// and a single success resets it immediately. Same shape as FeedRelay's
// own computeBackoffMs, minus jitter: jitter exists there to stop many
// independent DO instances retrying the same origin from drifting into
// lockstep, which doesn't apply here -- there is exactly one
// summarizer-agent process.
const BACKOFF_CAP_MS = 10 * 60_000;

export function nextAllowedIntervalMs(consecutiveFailures: number): number {
  return Math.min(BACKOFF_CAP_MS, MIN_INTERVAL_MS * 2 ** consecutiveFailures);
}

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
    throw new HttpStatusError(res.status, `Gemini API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini API response had no candidate text");
  }
  return extractFinalSentence(text);
}

// Defense in depth against ANY model (present or future) that ignores the
// prompt's "no preamble" instruction and returns visible reasoning ahead of
// its answer: every real example of that seen from this endpoint still ended
// with the clean final sentence as its last non-blank line, so that's the
// one thing worth trusting over the raw response. A well-behaved model's
// single-sentence reply is unaffected -- last line of one line is a no-op.
function extractFinalSentence(raw: string): string {
  const lines = raw
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return (lines[lines.length - 1] ?? raw.trim()).replace(/^(final( choice| string)?|answer)\s*:\s*/i, "");
}

export interface SummaryResult {
  text: string;
  // Which model (or provider:model) actually produced this, so a summary
  // served by fallback #3 is visibly distinguishable in the log from one
  // served by the configured primary -- the same visibility concern the
  // sibling project's own docstring names explicitly ("a request can
  // silently end up served by a weaker fallback model... with no other
  // signal that happened").
  servedBy: string;
}

// Tries each model in `chain` in order over the SAME Gemini key. On a
// retryable status (429/503), moves to the next model immediately, no
// delay -- this is a single logical request, just aimed at successive
// quota buckets, not a slow retry loop (that's what nextAllowedIntervalMs,
// applied one level up in run(), is for). A non-retryable error (a genuine
// 400/404, or the last model in the chain failing) stops immediately and
// throws, since trying the rest of the chain wouldn't help.
export async function callGeminiChain(apiKey: string, chain: readonly string[], prompt: string): Promise<SummaryResult> {
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    try {
      const text = await callGemini(apiKey, model, prompt);
      return { text, servedBy: model };
    } catch (err) {
      const retryable = err instanceof HttpStatusError && isRetryableStatus(err.status);
      if (!retryable || i === chain.length - 1) throw err;
    }
  }
  // Unreachable (chain always has at least one element, and the loop body
  // either returns or throws on its last iteration), but keeps this an
  // exhaustive function per TypeScript's control-flow analysis.
  throw new Error("callGeminiChain: empty model chain");
}

const GROQ_MODEL = "llama-3.3-70b-versatile";

// Optional last-resort tier, a genuinely different provider, not just a
// different Gemini model -- gated behind GROQ_API_KEY exactly like Gemini
// itself is gated behind GEMINI_API_KEY: unset means this tier is simply
// never reached, no other agent behavior changes. Groq specifically
// because its free tier is generous and its API is OpenAI-chat-completions
// -shaped, so this needs no SDK, matching this file's own "direct REST
// calls" choice. Unlike GEMINI_FALLBACK_MODELS (re-verified live above
// against a real key this project actually has), GROQ_MODEL has NOT been
// verified against a real Groq key -- there isn't one configured in this
// project yet. If you add GROQ_API_KEY, re-check this model name against
// https://api.groq.com/openai/v1/models with that key before trusting it,
// the same way the Gemini chain was checked, rather than assuming it's
// still current.
async function callGroq(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 60 }),
  });
  if (!res.ok) {
    throw new HttpStatusError(res.status, `Groq API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("Groq API response had no choice content");
  }
  return extractFinalSentence(text);
}

// Full pipeline for one notification: the whole Gemini model chain first,
// then Groq (only if configured) as a wholly separate provider tier if
// every Gemini model failed. Throws an AggregateError carrying both
// failures only when there genuinely was a second tier to fail -- a
// plain Gemini error propagates unchanged when Groq isn't configured, so
// the logged error message doesn't get more confusing for a caller who
// never opted into the fallback provider.
export async function generateSummary(evt: BufferedEvent, geminiApiKey: string, modelChain: readonly string[], groqApiKey?: string): Promise<SummaryResult> {
  const prompt = summarizePrompt(evt);
  try {
    return await callGeminiChain(geminiApiKey, modelChain, prompt);
  } catch (geminiErr) {
    if (!groqApiKey) throw geminiErr;
    try {
      const text = await callGroq(groqApiKey, prompt);
      return { text, servedBy: `groq:${GROQ_MODEL}` };
    } catch (groqErr) {
      throw new AggregateError([geminiErr, groqErr], "every summarization tier failed (Gemini chain, then Groq)");
    }
  }
}

function run(config: Config, geminiApiKey: string, modelChain: readonly string[], groqApiKey: string | undefined): Promise<never> {
  let lastSeenSeq = 0;
  let lastCallAt = 0;
  let consecutiveFailures = 0;

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
      if (now - lastCallAt < nextAllowedIntervalMs(consecutiveFailures)) return; // throttled/backing off, skip silently
      lastCallAt = now;

      generateSummary(msg, geminiApiKey, modelChain, groqApiKey)
        .then(({ text, servedBy }) => {
          consecutiveFailures = 0;
          const detail = servedBy === modelChain[0] ? text : `[via ${servedBy}] ${text}`;
          void logAction(config, { agentName: AGENT_NAME, agentRole: AGENT_ROLE, actionType: "summary", seq: msg.seq, detail });
        })
        .catch((err: unknown) => {
          consecutiveFailures++;
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
  // `||`, not `??`: an unset var and an empty string both mean "use the
  // default" here. Found by testing, not assumed -- .env.example ships a
  // bare `GEMINI_MODEL=` line, which Node's --env-file reads as "", not
  // undefined, so `??` alone silently picked "" as the model and every
  // call 404'd on an empty model name in the URL.
  const configuredModel = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const groqApiKey = process.env.GROQ_API_KEY || undefined;
  if (groqApiKey) {
    console.log(`[${AGENT_NAME}] GROQ_API_KEY found, will fall back to Groq if the whole Gemini chain fails`);
  }
  return run(config, apiKey, buildModelChain(configuredModel), groqApiKey);
}
