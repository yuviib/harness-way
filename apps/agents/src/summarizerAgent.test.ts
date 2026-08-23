import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelChain, callGeminiChain, generateSummary, nextAllowedIntervalMs } from "./summarizerAgent.ts";
import type { BufferedEvent } from "./shared.ts";

test("zero consecutive failures uses the base 8s throttle, unchanged from before this fix", () => {
  assert.equal(nextAllowedIntervalMs(0), 8_000);
});

test("doubles on each consecutive failure", () => {
  assert.equal(nextAllowedIntervalMs(1), 16_000);
  assert.equal(nextAllowedIntervalMs(2), 32_000);
  assert.equal(nextAllowedIntervalMs(3), 64_000);
});

test("caps at 10 minutes instead of growing unbounded", () => {
  assert.equal(nextAllowedIntervalMs(10), 10 * 60_000);
  assert.equal(nextAllowedIntervalMs(1000), 10 * 60_000);
});

test("is monotonically non-decreasing in consecutiveFailures", () => {
  let previous = 0;
  for (let n = 0; n <= 20; n++) {
    const interval = nextAllowedIntervalMs(n);
    assert.ok(interval >= previous, `interval regressed at failures=${n}: ${interval} < ${previous}`);
    previous = interval;
  }
});

test("buildModelChain puts the configured model first, then every fallback", () => {
  const chain = buildModelChain("gemini-flash-latest");
  assert.equal(chain[0], "gemini-flash-latest");
  assert.ok(chain.includes("gemini-flash-lite-latest"));
  assert.ok(chain.includes("gemini-3.1-flash-lite"));
  // gemma-4-31b-it was removed from the fallback chain: verified live, it
  // doesn't reliably honor "no preamble" and returns its full reasoning
  // trace instead of a one-line summary. Every model left in the chain is
  // Gemini-branded and was re-checked for this behavior.
  assert.ok(!chain.includes("gemma-4-31b-it"));
});

test("buildModelChain never tries the same model twice if the configured model is itself a fallback", () => {
  const chain = buildModelChain("gemini-flash-lite-latest");
  const occurrences = chain.filter((m) => m === "gemini-flash-lite-latest").length;
  assert.equal(occurrences, 1);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const geminiOk = (text: string) => jsonResponse(200, { candidates: [{ content: { parts: [{ text }] } }] });
const geminiHttpError = (status: number) => jsonResponse(status, { error: { code: status, message: "simulated" } });

test("callGeminiChain returns the first model's result when it succeeds", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return geminiOk("first model summary");
  });
  const result = await callGeminiChain("k", ["model-a", "model-b"], "prompt");
  assert.deepEqual(result, { text: "first model summary", servedBy: "model-a" });
  assert.equal(calls.length, 1);
});

test("callGeminiChain falls back to the next model on a 429, immediately, no delay", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return url.includes("model-a") ? geminiHttpError(429) : geminiOk("second model summary");
  });
  const result = await callGeminiChain("k", ["model-a", "model-b"], "prompt");
  assert.deepEqual(result, { text: "second model summary", servedBy: "model-b" });
  assert.equal(calls.length, 2);
});

test("callGeminiChain falls back on a 503 the same way as a 429", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => (url.includes("model-a") ? geminiHttpError(503) : geminiOk("recovered")));
  const result = await callGeminiChain("k", ["model-a", "model-b"], "prompt");
  assert.equal(result.servedBy, "model-b");
});

test("callGeminiChain does NOT fall back on a non-retryable status (e.g. 400) -- fails fast instead of burning the whole chain", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return geminiHttpError(400);
  });
  await assert.rejects(() => callGeminiChain("k", ["model-a", "model-b"], "prompt"), /HTTP 400/);
  assert.equal(calls.length, 1, "must not have tried model-b after a non-retryable failure on model-a");
});

test("callGeminiChain throws the last model's error once every model in the chain is exhausted", async (t) => {
  t.mock.method(globalThis, "fetch", async () => geminiHttpError(429));
  await assert.rejects(() => callGeminiChain("k", ["model-a", "model-b", "model-c"], "prompt"), /HTTP 429/);
});

const evt: BufferedEvent = { seq: 1, upstreamId: null, event: "test", data: "{}" };

test("generateSummary falls through to Groq only after the entire Gemini chain fails", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("generativelanguage.googleapis.com")) return geminiHttpError(429);
    if (url.includes("groq.com")) return jsonResponse(200, { choices: [{ message: { content: "groq summary" } }] });
    throw new Error(`unexpected URL in test: ${url}`);
  });
  const result = await generateSummary(evt, "gemini-key", ["model-a"], "groq-key");
  assert.equal(result.text, "groq summary");
  assert.equal(result.servedBy, "groq:llama-3.3-70b-versatile");
});

test("generateSummary never calls Groq when no groqApiKey is passed (opt-in, not automatic)", async (t) => {
  let groqWasCalled = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("groq.com")) groqWasCalled = true;
    return geminiHttpError(429);
  });
  await assert.rejects(() => generateSummary(evt, "gemini-key", ["model-a"], undefined));
  assert.equal(groqWasCalled, false);
});

test("callGeminiChain extracts just the final line when a model leaks its reasoning trace instead of one clean sentence", async (t) => {
  // A real response shape observed from gemma-4-31b-it in production, before
  // it was dropped from the fallback chain -- kept as a regression test for
  // the defensive extraction in callGemini/callGroq, since a well-behaved
  // model could still ramble occasionally even without that specific model
  // in the chain.
  const leaked =
    '* Draft 1: A resource was updated on August 20, 2026.\n' +
    "* Draft 2: An MCP resource has changed.\n" +
    "Let's go with:\n" +
    "A resource was updated on August 20, 2026.";
  t.mock.method(globalThis, "fetch", async () => geminiOk(leaked));
  const result = await callGeminiChain("k", ["model-a"], "prompt");
  assert.equal(result.text, "A resource was updated on August 20, 2026.");
});

test("callGeminiChain strips a 'Final choice:' / 'Final:' prefix left on the last line", async (t) => {
  t.mock.method(globalThis, "fetch", async () => geminiOk("Reasoning...\nFinal choice: A resource changed."));
  const result = await callGeminiChain("k", ["model-a"], "prompt");
  assert.equal(result.text, "A resource changed.");
});

test("callGeminiChain leaves an already-clean one-line summary unchanged", async (t) => {
  t.mock.method(globalThis, "fetch", async () => geminiOk("A resource was updated."));
  const result = await callGeminiChain("k", ["model-a"], "prompt");
  assert.equal(result.text, "A resource was updated.");
});

test("generateSummary succeeds directly from Gemini when it works, never touching Groq", async (t) => {
  let groqWasCalled = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("groq.com")) {
      groqWasCalled = true;
      return jsonResponse(200, { choices: [{ message: { content: "should not be used" } }] });
    }
    return geminiOk("gemini summary");
  });
  const result = await generateSummary(evt, "gemini-key", ["model-a"], "groq-key");
  assert.equal(result.text, "gemini summary");
  assert.equal(result.servedBy, "model-a");
  assert.equal(groqWasCalled, false);
});

test("generateSummary reports both failures when every tier is exhausted", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => (url.includes("groq.com") ? geminiHttpError(500) : geminiHttpError(429)));
  await assert.rejects(() => generateSummary(evt, "gemini-key", ["model-a"], "groq-key"), (err: unknown) => {
    assert.ok(err instanceof AggregateError);
    assert.equal(err.errors.length, 2);
    return true;
  });
});
