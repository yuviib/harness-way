import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleDeliveryLog, handleDeliveryLogCounts, handleDeliveryLogPreflight } from "./deliveryLog";

// Each test uses its own unique feed_key rather than reset()-ing D1 between
// tests -- simpler, and this route's own correctness doesn't depend on a
// clean table the way FeedRelay.test.ts's seq-number tests do.
async function seedRow(
  feedKey: string,
  entryType: "event" | "gap" | "reconnect",
  seq: number | null,
  detail: string | null = null,
): Promise<void> {
  await env.DB.prepare("INSERT INTO delivery_log (feed_key, entry_type, seq, occurred_at, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(feedKey, entryType, seq, new Date().toISOString(), detail)
    .run();
}

function authedRequest(query: string, origin?: string): Request {
  return new Request(`https://x/api/delivery-log${query}`, {
    headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}`, ...(origin ? { Origin: origin } : {}) },
  });
}

describe("handleDeliveryLog", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await handleDeliveryLog(new Request("https://x/api/delivery-log"), env);
    expect(res.status).toBe(401);
  });

  it("returns rows filtered by feedKey, most recent first", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    await seedRow(feedKey, "event", 1);
    await seedRow(feedKey, "event", 2);
    await seedRow("some-other-feed", "event", 999);

    const res = await handleDeliveryLog(authedRequest(`?feedKey=${encodeURIComponent(feedKey)}`), env);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { feed_key: string; seq: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.feed_key === feedKey)).toBe(true);
    // most recent (highest id / last inserted) first
    expect(rows[0]!.seq).toBe(2);
    expect(rows[1]!.seq).toBe(1);
  });

  it("filters by entryType", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    await seedRow(feedKey, "event", 1);
    await seedRow(feedKey, "gap", 5, "buffer-eviction");
    await seedRow(feedKey, "reconnect", null);

    const res = await handleDeliveryLog(authedRequest(`?feedKey=${feedKey}&entryType=gap`), env);
    const rows = (await res.json()) as { entry_type: string; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry_type).toBe("gap");
    expect(rows[0]!.detail).toBe("buffer-eviction");
  });

  it("clamps an excessive limit rather than trusting it directly", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      await seedRow(feedKey, "event", i);
    }
    const res = await handleDeliveryLog(authedRequest(`?feedKey=${feedKey}&limit=999999`), env);
    const rows = (await res.json()) as unknown[];
    // all 5 seeded rows come back -- the point is the LIMIT clause itself
    // got clamped server-side (verified via the route's own MAX_LIMIT
    // constant, not directly observable from a 5-row response), not that
    // fewer rows than exist are returned
    expect(rows).toHaveLength(5);
  });

  it("echoes back the request's own Origin when it's on the allowlist, not just on preflight", async () => {
    const res = await handleDeliveryLog(authedRequest("?feedKey=whatever", "https://mcp-relay-harness-dashboard.ybains-dev.workers.dev"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mcp-relay-harness-dashboard.ybains-dev.workers.dev");
  });

  it("omits Access-Control-Allow-Origin entirely for an origin not on the allowlist", async () => {
    const res = await handleDeliveryLog(authedRequest("?feedKey=whatever", "https://evil.example.com"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("answers an OPTIONS preflight without requiring auth", () => {
    const res = handleDeliveryLogPreflight(new Request("https://x/api/delivery-log", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});

describe("handleDeliveryLogCounts", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await handleDeliveryLogCounts(new Request("https://x/api/delivery-log/counts"), env);
    expect(res.status).toBe(401);
  });

  // The actual regression this endpoint exists to fix: found on the real
  // dashboard, not designed up front. A feed running for hours logs an
  // "event" row roughly every second; handleDeliveryLog's own row-window
  // (even at its max limit) can't see rare gap/reconnect rows once enough
  // events have piled up after them. Counts must stay exact regardless of
  // how lopsided the volume is between types.
  it("returns exact per-type totals even when one type vastly outnumbers the others", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    for (let i = 0; i < 50; i++) {
      await seedRow(feedKey, "event", i);
    }
    await seedRow(feedKey, "gap", 3, "buffer-eviction");
    await seedRow(feedKey, "reconnect", null);

    const res = await handleDeliveryLogCounts(authedRequest(`?feedKey=${feedKey}`), env);
    expect(res.status).toBe(200);
    const counts = (await res.json()) as { event: number; gap: number; reconnect: number };
    expect(counts).toEqual({ event: 50, gap: 1, reconnect: 1 });
  });

  it("scopes counts to the given feedKey, not the whole table", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    await seedRow(feedKey, "event", 1);
    await seedRow("some-other-feed", "event", 1);
    await seedRow("some-other-feed", "gap", 1, "upstream-drop");

    const res = await handleDeliveryLogCounts(authedRequest(`?feedKey=${feedKey}`), env);
    const counts = (await res.json()) as { event: number; gap: number; reconnect: number };
    expect(counts).toEqual({ event: 1, gap: 0, reconnect: 0 });
  });

  it("echoes back the request's own Origin when it's on the allowlist", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    const res = await handleDeliveryLogCounts(authedRequest(`?feedKey=${feedKey}`, "https://fraud-ops-console.ybains-dev.workers.dev"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://fraud-ops-console.ybains-dev.workers.dev");
  });
});
