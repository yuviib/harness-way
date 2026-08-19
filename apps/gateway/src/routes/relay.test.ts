import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRelay } from "./relay";

// http://127.0.0.1:8794 is on wrangler.toml's ALLOWED_ORIGIN_HOSTS
// allowlist for real (same value the origin-simulator itself listens on in
// dev) -- used here as a realistic, already-approved originUrl rather than
// a made-up host that would trip the SSRF check this route also enforces.
const ORIGIN_URL = "http://127.0.0.1:8794/mcp";

// Standing in for origin-simulator's own tools/call handler (see
// apps/origin-simulator/src/index.ts): a real call increments a counter
// and echoes it back, which is exactly what lets these tests independently
// verify "was the origin actually called again" without inspecting the
// cache's internals -- same proof technique the real simulator uses.
function mockToolOrigin() {
  let callCount = 0;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    callCount++;
    const body = JSON.parse((init?.body as string) ?? "{}");
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { arguments: body.params?.arguments, originCallSeq: callCount },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetchMock, getCallCount: () => callCount };
}

function relayRequest(body: unknown, auth = true): Request {
  return new Request("https://x/relay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("handleRelay", () => {
  let origin: ReturnType<typeof mockToolOrigin>;

  beforeEach(async () => {
    origin = mockToolOrigin();
    vi.stubGlobal("fetch", origin.fetchMock);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "s", tool: "resource_lookup", arguments: {} }, false),
      env,
    );
    expect(res.status).toBe(401);
    expect(origin.getCallCount()).toBe(0);
  });

  it("rejects a request missing originUrl/scope/tool", async () => {
    const res = await handleRelay(relayRequest({ scope: "s", tool: "t" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects arguments that aren't a JSON object", async () => {
    const res = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "s", tool: "t", arguments: [1, 2, 3] }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an origin not on the allowlist (SSRF boundary)", async () => {
    const res = await handleRelay(
      relayRequest({ originUrl: "http://evil.example/mcp", scope: "s", tool: "t", arguments: {} }),
      env,
    );
    expect(res.status).toBe(403);
    expect(origin.getCallCount()).toBe(0);
  });

  it("a first call is a cache miss: calls the real origin and returns its content", async () => {
    const res = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-1", tool: "resource_lookup", arguments: { resourceId: "42" } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(origin.getCallCount()).toBe(1);
    const body = (await res.json()) as { result: { originCallSeq: number } };
    expect(body.result.originCallSeq).toBe(1);
  });

  it("a second identical call (same scope, same tool+arguments) is served from cache without re-calling the origin", async () => {
    const first = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-2", tool: "resource_lookup", arguments: { resourceId: "42" } }),
      env,
    );
    const firstBodyText = await first.text();

    const second = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-2", tool: "resource_lookup", arguments: { resourceId: "42" } }),
      env,
    );
    const secondBodyText = await second.text();

    // The core proof: the origin's own call counter did NOT advance a
    // second time, so this content could only have come from the cache,
    // not a second real call that happened to look similar.
    expect(origin.getCallCount()).toBe(1);
    expect(second.headers.get("x-cache")).toBe("HIT");
    // Byte-identical (correctness property 5), not just "similar" -- if
    // the second response had gone to the origin again, originCallSeq
    // inside the body would read 2, not match the first response's 1.
    expect(secondBodyText).toBe(firstBodyText);
  });

  it("argument key order doesn't defeat cache sharing (canonicalized before hashing)", async () => {
    await handleRelay(
      relayRequest({
        originUrl: ORIGIN_URL,
        scope: "scope-order",
        tool: "resource_lookup",
        arguments: { resourceId: "1", verbose: true },
      }),
      env,
    );
    const second = await handleRelay(
      relayRequest({
        originUrl: ORIGIN_URL,
        scope: "scope-order",
        tool: "resource_lookup",
        arguments: { verbose: true, resourceId: "1" },
      }),
      env,
    );
    expect(origin.getCallCount()).toBe(1);
    expect(second.headers.get("x-cache")).toBe("HIT");
  });

  it("a different scope requesting the identical call is its own cache miss (correctness property 7)", async () => {
    await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-3a", tool: "resource_lookup", arguments: { resourceId: "42" } }),
      env,
    );
    const secondScopeRes = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-3b", tool: "resource_lookup", arguments: { resourceId: "42" } }),
      env,
    );
    expect(origin.getCallCount()).toBe(2);
    expect(secondScopeRes.headers.get("x-cache")).toBe("MISS");
    const body = (await secondScopeRes.json()) as { result: { originCallSeq: number } };
    expect(body.result.originCallSeq).toBe(2);
  });

  it("different arguments under the same scope are their own cache miss", async () => {
    await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-4", tool: "resource_lookup", arguments: { resourceId: "1" } }),
      env,
    );
    await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-4", tool: "resource_lookup", arguments: { resourceId: "2" } }),
      env,
    );
    expect(origin.getCallCount()).toBe(2);
  });

  it("fails open on a discrete cache miss: always a full real call, never an error (correctness property 6)", async () => {
    // Every call in this test is against a scope no prior test has ever
    // used, so every single one is, by construction, a miss -- exercising
    // exactly the path property 6 describes, end to end through the real
    // route (not just cacheClient's own unit contract, see
    // cacheClient.test.ts for that half).
    for (let i = 0; i < 3; i++) {
      const res = await handleRelay(
        relayRequest({ originUrl: ORIGIN_URL, scope: "scope-5", tool: "resource_lookup", arguments: { resourceId: String(i) } }),
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("x-cache")).toBe("MISS");
    }
    expect(origin.getCallCount()).toBe(3);
  });

  it("a real origin failure surfaces as a genuine error and is never cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream is down", { status: 503 })),
    );
    const first = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-6", tool: "resource_lookup", arguments: { resourceId: "1" } }),
      env,
    );
    expect(first.status).toBe(502);

    // A retry after the origin recovers must be a normal miss, not a
    // cached error -- proves the failed attempt above never got stored.
    vi.stubGlobal("fetch", origin.fetchMock);
    const second = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-6", tool: "resource_lookup", arguments: { resourceId: "1" } }),
      env,
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("MISS");
  });

  it("a thrown network error surfaces as a genuine error and is never cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );
    const res = await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-7", tool: "resource_lookup", arguments: { resourceId: "1" } }),
      env,
    );
    expect(res.status).toBe(502);
  });

  it("writes a cache_log row for a miss and for a hit", async () => {
    await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-8", tool: "resource_lookup", arguments: { resourceId: "1" } }),
      env,
    );
    await handleRelay(
      relayRequest({ originUrl: ORIGIN_URL, scope: "scope-8", tool: "resource_lookup", arguments: { resourceId: "1" } }),
      env,
    );
    const { results } = await env.DB.prepare("SELECT outcome FROM cache_log WHERE scope = ? ORDER BY id ASC")
      .bind("scope-8")
      .all<{ outcome: string }>();
    expect(results.map((r) => r.outcome)).toEqual(["miss", "hit"]);
  });
});
