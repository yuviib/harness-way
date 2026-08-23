import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAuditLogGet, handleAuditLogPost, handleAuditLogVerify } from "./auditLog";

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

function postReq(token: string, body: unknown): Request {
  return new Request("https://x/api/audit-log", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
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
});
