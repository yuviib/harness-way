import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleCacheLog, handleCacheLogPreflight, handleCacheLogStats } from "./cacheLog";

// Same "unique scope per test, no reset() needed" reasoning as
// deliveryLog.test.ts -- this route's own correctness doesn't depend on a
// clean table.
async function seedRow(
  scope: string,
  outcome: "hit" | "miss" | "fail-open",
  byteSize: number,
  latencyMs: number,
): Promise<void> {
  await env.DB.prepare("INSERT INTO cache_log (scope, request_hash, outcome, byte_size, latency_ms, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(scope, `hash-${crypto.randomUUID()}`, outcome, byteSize, latencyMs, new Date().toISOString())
    .run();
}

function authedRequest(path: string, query: string): Request {
  return new Request(`https://x${path}${query}`, {
    headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` },
  });
}

describe("handleCacheLog", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await handleCacheLog(new Request("https://x/api/cache-log"), env);
    expect(res.status).toBe(401);
  });

  it("returns rows filtered by scope, most recent first", async () => {
    const scope = `test-scope-${crypto.randomUUID()}`;
    await seedRow(scope, "miss", 100, 250);
    await seedRow(scope, "hit", 100, 2);
    await seedRow("some-other-scope", "miss", 50, 10);

    const res = await handleCacheLog(authedRequest("/api/cache-log", `?scope=${encodeURIComponent(scope)}`), env);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { scope: string; outcome: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scope === scope)).toBe(true);
    expect(rows[0]!.outcome).toBe("hit");
    expect(rows[1]!.outcome).toBe("miss");
  });

  it("clamps an excessive limit", async () => {
    const scope = `test-scope-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) await seedRow(scope, "hit", 10, 1);
    const res = await handleCacheLog(authedRequest("/api/cache-log", `?scope=${scope}&limit=999999`), env);
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(5);
  });

  it("sets CORS headers on the data response", async () => {
    const res = await handleCacheLog(authedRequest("/api/cache-log", "?scope=whatever"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers an OPTIONS preflight without requiring auth", () => {
    const res = handleCacheLogPreflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});

describe("handleCacheLogStats", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await handleCacheLogStats(new Request("https://x/api/cache-log/stats"), env);
    expect(res.status).toBe(401);
  });

  it("computes hit rate and bytes saved from real per-outcome totals", async () => {
    const scope = `test-scope-${crypto.randomUUID()}`;
    await seedRow(scope, "hit", 100, 2);
    await seedRow(scope, "hit", 200, 3);
    await seedRow(scope, "miss", 150, 250);
    await seedRow(scope, "fail-open", 50, 260);

    const res = await handleCacheLogStats(authedRequest("/api/cache-log/stats", `?scope=${scope}`), env);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      hit: { count: number; bytes: number };
      miss: { count: number; bytes: number };
      failOpen: { count: number; bytes: number };
      totalRequests: number;
      hitRate: number;
      bytesSaved: number;
    };
    expect(stats.hit.count).toBe(2);
    expect(stats.miss.count).toBe(1);
    expect(stats.failOpen.count).toBe(1);
    expect(stats.totalRequests).toBe(4);
    expect(stats.hitRate).toBeCloseTo(0.5, 5);
    // bytesSaved is the sum of hit-row byte_size only (100 + 200) -- miss
    // and fail-open bytes were real origin round-trips, not savings.
    expect(stats.bytesSaved).toBe(300);
  });

  it("reports zero hit rate, not NaN or a divide-by-zero error, for a scope with no history", async () => {
    const res = await handleCacheLogStats(authedRequest("/api/cache-log/stats", `?scope=never-seen-${crypto.randomUUID()}`), env);
    const stats = (await res.json()) as { hitRate: number; totalRequests: number };
    expect(stats.totalRequests).toBe(0);
    expect(stats.hitRate).toBe(0);
  });

  it("scopes stats to the given scope, not the whole table", async () => {
    const scope = `test-scope-${crypto.randomUUID()}`;
    await seedRow(scope, "hit", 10, 1);
    await seedRow("some-other-scope", "hit", 999, 1);
    await seedRow("some-other-scope", "miss", 999, 1);

    const res = await handleCacheLogStats(authedRequest("/api/cache-log/stats", `?scope=${scope}`), env);
    const stats = (await res.json()) as { hit: { count: number }; totalRequests: number };
    expect(stats.hit.count).toBe(1);
    expect(stats.totalRequests).toBe(1);
  });
});
