import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { checkScope, resolveCredential } from "./agentAuth";

// Applied once for the whole file, not per-test: this file deliberately
// never resets D1 between tests (see uniqueToken's own comment on why
// that's safe), so there's nothing to reapply after the first run.
// Explicit rather than relying on some other test file happening to have
// already migrated the shared D1 instance first -- vitest doesn't
// guarantee file execution order.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueCredential(opts: {
  token: string;
  agentName: string;
  scopeOriginHost?: string | null;
  scopeCategory?: string | null;
  canSubscribe?: boolean;
  canRelay?: boolean;
  revoked?: boolean;
}): Promise<void> {
  const tokenHash = await sha256Hex(opts.token);
  await env.DB.prepare(
    "INSERT INTO agent_credentials (agent_name, token_hash, scope_origin_host, scope_category, can_subscribe, can_relay, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      opts.agentName,
      tokenHash,
      opts.scopeOriginHost ?? null,
      opts.scopeCategory ?? null,
      opts.canSubscribe === false ? 0 : 1,
      opts.canRelay === true ? 1 : 0,
      new Date().toISOString(),
      opts.revoked ? new Date().toISOString() : null,
    )
    .run();
}

// Each test uses its own unique token so credentials issued by one test
// can never accidentally satisfy a lookup in another, D1 state (unlike
// each DO's own isolated storage) is genuinely shared across every test
// in this file, real persistence, not reset between tests the way
// `reset()` clears DO state elsewhere in this suite.
let counter = 0;
function uniqueToken(): string {
  counter += 1;
  return `test-token-${counter}-${crypto.randomUUID()}`;
}

describe("resolveCredential", () => {
  it("resolves a scoped credential by its token, attributed to the real agent name", async () => {
    const token = uniqueToken();
    await issueCredential({ token, agentName: "triage-agent" });
    const result = await resolveCredential(env, token);
    expect(result.authorized).toBe(true);
    expect(result.agentName).toBe("triage-agent");
    expect(result.agentId).not.toBeNull();
  });

  it("a credential with no scope restrictions carries null scope fields, not empty strings", async () => {
    const token = uniqueToken();
    await issueCredential({ token, agentName: "unrestricted-agent" });
    const result = await resolveCredential(env, token);
    expect(result.scopeOriginHost).toBeNull();
    expect(result.scopeCategory).toBeNull();
  });

  it("carries the real scope restrictions when the credential has them", async () => {
    const token = uniqueToken();
    await issueCredential({ token, agentName: "scoped-agent", scopeOriginHost: "example.test", scopeCategory: "fraud-cases" });
    const result = await resolveCredential(env, token);
    expect(result.scopeOriginHost).toBe("example.test");
    expect(result.scopeCategory).toBe("fraud-cases");
  });

  it("defaults to can_subscribe true, can_relay false, matching the migration's own default", async () => {
    const token = uniqueToken();
    await issueCredential({ token, agentName: "default-agent" });
    const result = await resolveCredential(env, token);
    expect(result.canSubscribe).toBe(true);
    expect(result.canRelay).toBe(false);
  });

  it("rejects a revoked credential, even with the exact right token", async () => {
    const token = uniqueToken();
    await issueCredential({ token, agentName: "revoked-agent", revoked: true });
    const result = await resolveCredential(env, token);
    expect(result.authorized).toBe(false);
  });

  it("falls back to the legacy shared token when no scoped credential matches", async () => {
    const result = await resolveCredential(env, env.SUBSCRIBE_TOKEN);
    expect(result.authorized).toBe(true);
    expect(result.agentName).toBe("shared-token");
  });

  it("rejects a token that matches neither a scoped credential nor the shared token", async () => {
    const result = await resolveCredential(env, "definitely-not-a-real-token");
    expect(result.authorized).toBe(false);
  });

  it("rejects an empty token outright, without ever querying D1 or the shared token", async () => {
    const result = await resolveCredential(env, "");
    expect(result.authorized).toBe(false);
  });

  it("falls through to the legacy check rather than throwing when D1 is unreachable", async () => {
    const brokenEnv = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("simulated D1 outage");
        },
      },
    } as unknown as Env;
    const result = await resolveCredential(brokenEnv, env.SUBSCRIBE_TOKEN);
    expect(result.authorized).toBe(true);
    expect(result.agentName).toBe("shared-token");
  });
});

describe("checkScope", () => {
  it("an unauthorized result never passes, regardless of route or target", () => {
    const auth = { authorized: false, agentId: null, agentName: "", scopeOriginHost: null, scopeCategory: null, canSubscribe: false, canRelay: false };
    expect(checkScope(auth, "subscribe", "https://x.test/mcp", "any")).toBe(false);
  });

  it("an unrestricted credential (all scope fields null) passes any origin/category", () => {
    const auth = { authorized: true, agentId: 1, agentName: "a", scopeOriginHost: null, scopeCategory: null, canSubscribe: true, canRelay: true };
    expect(checkScope(auth, "subscribe", "https://anything.test/mcp", "anything")).toBe(true);
  });

  it("rejects a route the credential isn't permitted to use", () => {
    const canOnlySubscribe = { authorized: true, agentId: 1, agentName: "a", scopeOriginHost: null, scopeCategory: null, canSubscribe: true, canRelay: false };
    expect(checkScope(canOnlySubscribe, "subscribe", "https://x.test/mcp", "cat")).toBe(true);
    expect(checkScope(canOnlySubscribe, "relay", "https://x.test/mcp", null)).toBe(false);
  });

  it("rejects a mismatched origin host when the credential is scoped to a specific one", () => {
    const auth = { authorized: true, agentId: 1, agentName: "a", scopeOriginHost: "allowed.test", scopeCategory: null, canSubscribe: true, canRelay: true };
    expect(checkScope(auth, "subscribe", "https://allowed.test/mcp", "cat")).toBe(true);
    expect(checkScope(auth, "subscribe", "https://different.test/mcp", "cat")).toBe(false);
  });

  it("rejects a malformed originUrl against a host-scoped credential rather than throwing", () => {
    const auth = { authorized: true, agentId: 1, agentName: "a", scopeOriginHost: "allowed.test", scopeCategory: null, canSubscribe: true, canRelay: true };
    expect(checkScope(auth, "subscribe", "not a url", "cat")).toBe(false);
  });

  it("rejects a mismatched category on /subscribe when the credential is category-scoped", () => {
    const auth = { authorized: true, agentId: 1, agentName: "a", scopeOriginHost: null, scopeCategory: "fraud-cases", canSubscribe: true, canRelay: true };
    expect(checkScope(auth, "subscribe", "https://x.test/mcp", "fraud-cases")).toBe(true);
    expect(checkScope(auth, "subscribe", "https://x.test/mcp", "other-category")).toBe(false);
  });

  it("never checks category on /relay, even when the credential is category-scoped -- there's no category concept on that route", () => {
    const auth = { authorized: true, agentId: 1, agentName: "a", scopeOriginHost: null, scopeCategory: "fraud-cases", canSubscribe: true, canRelay: true };
    expect(checkScope(auth, "relay", "https://x.test/mcp", null)).toBe(true);
  });
});

// Sanity check that the migration's own schema actually enforces what the
// tests above assume it does -- if this ever regressed, every test above
// could still pass for the wrong reason (issueCredential always setting
// an explicit value, never relying on SQL's own DEFAULT).
describe("agent_credentials schema defaults", () => {
  it("can_subscribe defaults to 1 and can_relay to 0 when omitted from the INSERT entirely", async () => {
    const token = uniqueToken();
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare("INSERT INTO agent_credentials (agent_name, token_hash, created_at) VALUES (?, ?, ?)").bind("bare-insert-agent", tokenHash, new Date().toISOString()).run();
    const result = await resolveCredential(env, token);
    expect(result.canSubscribe).toBe(true);
    expect(result.canRelay).toBe(false);
  });
});
