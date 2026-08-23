import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAuditLogGet, handleAuditLogPost, handleAuditLogPreflight, handleAuditLogVerify } from "./auditLog";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueCredential(agentName: string, canRelay = false): Promise<string> {
  const token = `audit-test-${agentName}-${crypto.randomUUID()}`;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare("INSERT INTO agent_credentials (agent_name, token_hash, can_relay, created_at) VALUES (?, ?, ?, ?)")
    .bind(agentName, tokenHash, canRelay ? 1 : 0, new Date().toISOString())
    .run();
  return token;
}

function postReq(token: string, body: unknown, origin?: string): Request {
  return new Request("https://x/api/audit-log", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
}

describe("audit log routes", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    await reset();
  });

  it("rejects an unauthenticated append", async () => {
    const res = await handleAuditLogPost(postReq("not-a-real-token", { action: "escalate", detail: "case-1" }), env);
    expect(res.status).toBe(401);
  });

  it("appends an entry attributed to the caller's OWN real credential, not anything the request body claims", async () => {
    const token = await issueCredential("triage-agent");
    const res = await handleAuditLogPost(postReq(token, { action: "escalate", detail: "case-1", agentName: "someone-else-entirely" } as never), env);
    expect(res.status).toBe(200);

    const listRes = await handleAuditLogGet(new Request("https://x/api/audit-log", { headers: { Authorization: `Bearer ${token}` } }), env);
    const entries = (await listRes.json()) as { agentName: string; detail: string }[];
    expect(entries[0]!.agentName).toBe("triage-agent");
    expect(entries[0]!.detail).toBe("case-1");
  });

  it("rejects a POST missing action or detail", async () => {
    const token = await issueCredential("triage-agent");
    const res = await handleAuditLogPost(postReq(token, { action: "escalate" }), env);
    expect(res.status).toBe(400);
  });

  it("verify reports intact immediately after real appends through the real HTTP route", async () => {
    const token = await issueCredential("triage-agent");
    await handleAuditLogPost(postReq(token, { action: "escalate", detail: "case-1" }), env);
    await handleAuditLogPost(postReq(token, { action: "clear", detail: "case-2" }), env);

    const res = await handleAuditLogVerify(new Request("https://x/api/audit-log/verify", { headers: { Authorization: `Bearer ${token}` } }), env);
    const result = (await res.json()) as { intact: boolean; checkedCount: number };
    expect(result.intact).toBe(true);
    expect(result.checkedCount).toBeGreaterThanOrEqual(2);
  });

  it("a legacy shared-token caller (no scoped credential) is still attributed honestly, as 'shared-token', not a forged name", async () => {
    const res = await handleAuditLogPost(
      new Request("https://x/api/audit-log", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` },
        body: JSON.stringify({ action: "escalate", detail: "case-x" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const listRes = await handleAuditLogGet(new Request("https://x/api/audit-log", { headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` } }), env);
    const entries = (await listRes.json()) as { agentName: string }[];
    expect(entries[0]!.agentName).toBe("shared-token");
  });

  it("rejects a detail beyond the real, enforced length cap rather than silently truncating it", async () => {
    const token = await issueCredential("triage-agent");
    const res = await handleAuditLogPost(postReq(token, { action: "escalate", detail: "x".repeat(4001) }), env);
    expect(res.status).toBe(400);
  });

  it("accepts a detail right at the cap", async () => {
    const token = await issueCredential("triage-agent");
    const res = await handleAuditLogPost(postReq(token, { action: "escalate", detail: "x".repeat(4000) }), env);
    expect(res.status).toBe(200);
  });

  it("rejects an action beyond its own, much shorter length cap", async () => {
    const token = await issueCredential("triage-agent");
    const res = await handleAuditLogPost(postReq(token, { action: "x".repeat(101), detail: "case-1" }), env);
    expect(res.status).toBe(400);
  });

  it("echoes back the request's own Origin when it's on the allowlist, never a bare wildcard", async () => {
    const token = await issueCredential("triage-agent");
    const res = await handleAuditLogPost(postReq(token, { action: "escalate", detail: "case-1" }, "https://fraud-ops-console.ybains-dev.workers.dev"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://fraud-ops-console.ybains-dev.workers.dev");
  });

  it("omits Access-Control-Allow-Origin entirely for an origin not on the allowlist", async () => {
    const token = await issueCredential("triage-agent");
    const res = await handleAuditLogPost(postReq(token, { action: "escalate", detail: "case-1" }, "https://evil.example.com"), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("answers an OPTIONS preflight without requiring auth", () => {
    const res = handleAuditLogPreflight(new Request("https://x/api/audit-log", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
