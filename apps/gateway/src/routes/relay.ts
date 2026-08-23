// Discrete tool-call path (Capability 2): a caller POSTs {originUrl, scope,
// tool, arguments}; this route serves the result from the shared,
// content-addressed cache when a caller (any caller sharing the same
// scope, not just the original one) has already made the identical call,
// and falls through to a real origin call otherwise. Fully synchronous
// request/response, unlike subscribe.ts's WebSocket upgrade -- a discrete
// MCP tools/call has no long-lived-stream shape to preserve.
//
// `scope` is caller-supplied, not derived from real authenticated caller
// identity -- same documented v1 boundary as SUBSCRIBE_TOKEN itself (see
// subscribe.ts): this project's auth model is a single shared secret, not
// per-caller identity, so there is no stronger notion of "who is this
// caller" to scope against yet. What IS enforced regardless: two different
// scope strings can never observe each other's cached entries (see
// ContextIndex.ts), so a real deployment can layer real per-tenant
// identity on top of this later by deriving `scope` from it, without
// changing anything about the isolation guarantee itself.

import { lookupCache, storeCache } from "../lib/cacheClient";
import { logCacheAccess } from "../lib/cacheLog";
import { buildRequestHash } from "../lib/cacheKey";
import { fetchOrigin } from "../lib/fetchOrigin";
import { blake3Hex } from "../lib/wasmEngine";
import { isAllowedOrigin, isAuthorized, isRateLimited } from "./subscribe";

interface RelayRequestBody {
  originUrl?: string;
  scope?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Fire-and-forget from this route's own perspective (errors swallowed):
// a failed observability write must never turn an otherwise-successful
// relay call into an error response, same principle as FeedRelay's
// logDeliveryAsync, just awaited inline here since routes have no
// ctx.waitUntil to defer onto (see lib/cacheLog.ts's own comment).
async function logCacheAccessBestEffort(env: Env, entry: Parameters<typeof logCacheAccess>[1]): Promise<void> {
  try {
    await logCacheAccess(env.DB, entry);
  } catch {
    // observability only; see comment above
  }
}

export async function handleRelay(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (await isRateLimited(request, env, "relay")) {
    return new Response("Too many relay calls, slow down", { status: 429 });
  }

  let body: RelayRequestBody;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { originUrl, scope, tool } = body;
  const args = body.arguments ?? {};
  if (!originUrl || typeof originUrl !== "string") {
    return new Response("originUrl (string) is required", { status: 400 });
  }
  if (!scope || typeof scope !== "string") {
    return new Response("scope (string) is required", { status: 400 });
  }
  if (!tool || typeof tool !== "string") {
    return new Response("tool (string) is required", { status: 400 });
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return new Response("arguments, if present, must be a JSON object", { status: 400 });
  }
  // Same SSRF boundary as /subscribe -- originUrl is attacker-controlled
  // input from any caller holding the shared token, and this route is
  // another path that ends in this Worker's own fetch() to it.
  if (!isAllowedOrigin(originUrl, env.ALLOWED_ORIGIN_HOSTS)) {
    return new Response("originUrl is not on the allowed origin list", { status: 403 });
  }

  const requestHash = buildRequestHash({ originUrl, tool, arguments: args });

  const lookupStart = Date.now();
  const cached = await lookupCache(env, scope, requestHash);
  if (cached.hit) {
    const latencyMs = Date.now() - lookupStart;
    await logCacheAccessBestEffort(env, {
      scope,
      requestHash,
      outcome: "hit",
      byteSize: cached.entry.byteSize,
      latencyMs,
      occurredAt: new Date().toISOString(),
    });
    return new Response(cached.entry.content, {
      status: 200,
      headers: {
        "content-type": cached.entry.contentType,
        "x-cache": "HIT",
        "x-cache-hit-count": String(cached.entry.hitCount),
        "x-cache-result-hash": cached.entry.resultHash,
      },
    });
  }

  // Not served from cache -- either a genuine miss or the index itself
  // couldn't be consulted (cached.failedOpen). Both cases converge here on
  // purpose: PLAN.md correctness property 6 requires a discrete cache miss
  // to always trigger a full real call, never an error and never partial
  // content, and that guarantee has to hold regardless of *why* nothing
  // was served from cache.
  const originStart = Date.now();
  let originRes: Response;
  try {
    originRes = await fetchOrigin(env, originUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
  } catch (err) {
    // A real failure with nothing to serve -- this is NOT the "fail-open"
    // property from PLAN.md (that's specifically about the CACHE INDEX
    // failing, always resolved by falling through to this real call).
    // When the real call itself fails, there is no honest content left to
    // return, so this surfaces as an actual error, same as any other
    // upstream-call failure in this codebase (see subscribe.ts's own
    // non-OK handling) rather than being papered over.
    return new Response(`Origin call failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }

  if (!originRes.ok) {
    return new Response(`Origin returned HTTP ${originRes.status}`, { status: 502 });
  }

  // Read to completion before doing anything else with it -- caching or
  // returning a still-streaming body would risk exactly the "partial
  // content" PLAN.md's property 6 explicitly rules out.
  const content = await originRes.text();
  const contentType = originRes.headers.get("content-type") ?? "application/json";
  const originLatencyMs = Date.now() - originStart;

  const resultHash = blake3Hex(content);
  const stored = await storeCache(env, scope, { requestHash, resultHash, content, contentType });

  await logCacheAccessBestEffort(env, {
    scope,
    requestHash,
    outcome: cached.failedOpen ? "fail-open" : "miss",
    byteSize: byteLength(content),
    latencyMs: originLatencyMs,
    occurredAt: new Date().toISOString(),
  });

  return new Response(content, {
    status: 200,
    headers: {
      "content-type": contentType,
      "x-cache": "MISS",
      "x-cache-outcome": cached.failedOpen ? "fail-open" : "miss",
      "x-cache-result-hash": resultHash,
      "x-cache-stored": String(stored),
    },
  });
}
