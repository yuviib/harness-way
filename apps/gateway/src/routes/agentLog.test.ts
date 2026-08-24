import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleAgentLogCounts, handleAgentLogGet, handleAgentLogPost, handleAgentLogPreflight } from "./agentLog";

function authedRequest(query: string): Request {
  return new Request(`https://x/api/agent-log${query}`, {
    headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` },
  });
}

function postRequest(body: unknown, auth = true, origin?: string): Request {
  return new Request("https://x/api/agent-log", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("handleAgentLogPost", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await handleAgentLogPost(
      postRequest({ feedKey: "x", agentName: "a", agentRole: "r", actionType: "summary" }, false),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a request missing required fields", async () => {
    const res = await handleAgentLogPost(postRequest({ feedKey: "x" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects an actionType outside the known set", async () => {
    const res = await handleAgentLogPost(
      postRequest({ feedKey: "x", agentName: "a", agentRole: "r", actionType: "not-a-real-type" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed entry and it is readable back via GET", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    const postRes = await handleAgentLogPost(
      postRequest({
        feedKey,
        agentName: "resume-agent",
        agentRole: "verifies gapless replay on reconnect",
        actionType: "reconnect_verified",
        seq: 42,
        detail: "replay covered seq 40-42, no gap",
      }),
      env,
    );
    expect(postRes.status).toBe(204);

    const getRes = await handleAgentLogGet(authedRequest(`?feedKey=${encodeURIComponent(feedKey)}`), env);
    const rows = (await getRes.json()) as { agent_name: string; action_type: string; seq: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_name).toBe("resume-agent");
    expect(rows[0]!.action_type).toBe("reconnect_verified");
    expect(rows[0]!.seq).toBe(42);
  });

  it("is really rate limited, not just parsed and stored unbounded -- a real gap before this was added", async () => {
    // Its own distinct IP so this doesn't share a bucket with any of the
    // other tests in this file, which all post via the no-IP default key.
    const ip = `203.0.113.${Math.floor(Math.random() * 255)}-${crypto.randomUUID()}`;
    const body = { feedKey: `test-feed-${crypto.randomUUID()}`, agentName: "a", agentRole: "r", actionType: "summary" };
    const req = () =>
      new Request("https://x/api/agent-log", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}`, "CF-Connecting-IP": ip },
        body: JSON.stringify(body),
      });
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      lastStatus = (await handleAgentLogPost(req(), env)).status;
    }
    expect(lastStatus).toBe(429);
  });

  it("echoes back the request's own Origin when it's on the allowlist", async () => {
    const res = await handleAgentLogPost(
      postRequest(
        { feedKey: `test-feed-${crypto.randomUUID()}`, agentName: "a", agentRole: "r", actionType: "summary" },
        true,
        "https://mcp-relay-harness-dashboard.ybains-dev.workers.dev",
      ),
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mcp-relay-harness-dashboard.ybains-dev.workers.dev");
  });

  it("omits Access-Control-Allow-Origin entirely for an origin not on the allowlist", async () => {
    const res = await handleAgentLogPost(
      postRequest({ feedKey: `test-feed-${crypto.randomUUID()}`, agentName: "a", agentRole: "r", actionType: "summary" }, true, "https://evil.example.com"),
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("handleAgentLogGet", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await handleAgentLogGet(new Request("https://x/api/agent-log"), env);
    expect(res.status).toBe(401);
  });

  it("scopes results to the given feedKey", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    await handleAgentLogPost(
      postRequest({ feedKey, agentName: "a", agentRole: "r", actionType: "summary", detail: "in scope" }),
      env,
    );
    await handleAgentLogPost(
      postRequest({ feedKey: "some-other-feed", agentName: "a", agentRole: "r", actionType: "summary", detail: "not in scope" }),
      env,
    );

    const res = await handleAgentLogGet(authedRequest(`?feedKey=${encodeURIComponent(feedKey)}`), env);
    const rows = (await res.json()) as { detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe("in scope");
  });

  it("returns most recent first", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    await handleAgentLogPost(
      postRequest({ feedKey, agentName: "a", agentRole: "r", actionType: "order_check", detail: "first" }),
      env,
    );
    await handleAgentLogPost(
      postRequest({ feedKey, agentName: "a", agentRole: "r", actionType: "order_check", detail: "second" }),
      env,
    );

    const res = await handleAgentLogGet(authedRequest(`?feedKey=${encodeURIComponent(feedKey)}`), env);
    const rows = (await res.json()) as { detail: string }[];
    expect(rows[0]!.detail).toBe("second");
    expect(rows[1]!.detail).toBe("first");
  });
});

describe("handleAgentLogCounts", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await handleAgentLogCounts(new Request("https://x/api/agent-log/counts"), env);
    expect(res.status).toBe(401);
  });

  it("returns exact per-action-type totals even when one type vastly outnumbers the others", async () => {
    // This test alone posts more than the real, enforced rate limit (30/60s)
    // on purpose -- it's testing count-aggregation accuracy under volume, a
    // different concern entirely, so it needs its own isolated identity (a
    // unique IP) rather than sharing the default no-IP bucket every other
    // test in this file uses, the same isolation subscribe.test.ts's own
    // rate-limit tests already rely on for the identical reason.
    const ip = `203.0.113.${Math.floor(Math.random() * 255)}-${crypto.randomUUID()}`;
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    function post(body: unknown): Request {
      return new Request("https://x/api/agent-log", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}`, "CF-Connecting-IP": ip },
        body: JSON.stringify(body),
      });
    }
    // 25, not the original 40 -- comfortably under the real, enforced
    // rate limit (30/60s) while still genuinely lopsided against the 1-each
    // of the other two types, which is the actual property this test
    // proves; the exact count was never the point, only that it's exact.
    for (let i = 0; i < 25; i++) {
      await handleAgentLogPost(post({ feedKey, agentName: "ordering-agent", agentRole: "r", actionType: "order_check" }), env);
    }
    await handleAgentLogPost(post({ feedKey, agentName: "gap-aware-agent", agentRole: "r", actionType: "resync" }), env);
    await handleAgentLogPost(post({ feedKey, agentName: "resume-agent", agentRole: "r", actionType: "error" }), env);

    const res = await handleAgentLogCounts(authedRequest(`?feedKey=${encodeURIComponent(feedKey)}`), env);
    expect(res.status).toBe(200);
    const counts = (await res.json()) as Record<string, number>;
    expect(counts.order_check).toBe(25);
    expect(counts.resync).toBe(1);
    expect(counts.error).toBe(1);
    expect(counts.reconnect_verified).toBe(0);
    expect(counts.summary).toBe(0);
  });

  it("scopes counts to the given feedKey, not the whole table", async () => {
    const feedKey = `test-feed-${crypto.randomUUID()}`;
    await handleAgentLogPost(postRequest({ feedKey, agentName: "a", agentRole: "r", actionType: "summary" }), env);
    await handleAgentLogPost(postRequest({ feedKey: "some-other-feed", agentName: "a", agentRole: "r", actionType: "summary" }), env);

    const res = await handleAgentLogCounts(authedRequest(`?feedKey=${encodeURIComponent(feedKey)}`), env);
    const counts = (await res.json()) as Record<string, number>;
    expect(counts.summary).toBe(1);
  });
});

describe("handleAgentLogPreflight", () => {
  it("answers an OPTIONS preflight without requiring auth", () => {
    const res = handleAgentLogPreflight(new Request("https://x/api/agent-log", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
