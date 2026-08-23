import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildFeedKey, handleSubscribe, isAllowedOrigin, isAuthorized, isRateLimited } from "./subscribe";

// wrangler.toml's RATE_LIMITER binding is configured `simple = { limit: 30,
// period: 60 }`, shared across every test in this file -- each test below
// uses its own randomized CF-Connecting-IP so tests can't pollute each
// other's bucket, the same isolation concern buildFeedKey's own tests take
// seriously for a different reason.
function uniqueIp(): string {
  return `203.0.113.${Math.floor(Math.random() * 255)}-${crypto.randomUUID()}`;
}

// Real bindings from wrangler.toml, running inside the actual workerd
// runtime -- not mocked. env.SUBSCRIBE_TOKEN / env.ALLOWED_ORIGIN_HOSTS are
// whatever wrangler.toml's [vars] currently say.

describe("isAuthorized (the legacy shared-token path -- scoped credentials have their own suite in lib/agentAuth.test.ts)", () => {
  it("accepts the correct bearer token", async () => {
    const req = new Request("https://x/", {
      headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` },
    });
    const result = await isAuthorized(req, env);
    expect(result.authorized).toBe(true);
    expect(result.agentName).toBe("shared-token");
  });

  it("rejects a wrong token", async () => {
    const req = new Request("https://x/", { headers: { Authorization: "Bearer wrong-token" } });
    expect((await isAuthorized(req, env)).authorized).toBe(false);
  });

  it("rejects a missing Authorization header", async () => {
    const req = new Request("https://x/");
    expect((await isAuthorized(req, env)).authorized).toBe(false);
  });

  it("rejects a header missing the Bearer prefix", async () => {
    const req = new Request("https://x/", { headers: { Authorization: env.SUBSCRIBE_TOKEN } });
    expect((await isAuthorized(req, env)).authorized).toBe(false);
  });

  it("rejects a token that only differs in length, not just content", async () => {
    // guards against a naive implementation that short-circuits on length
    // mismatch before ever reaching a constant-time comparison loop
    const req = new Request("https://x/", {
      headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}extra` },
    });
    expect((await isAuthorized(req, env)).authorized).toBe(false);
  });

  it("rejects an empty provided token against a MISSING expected token -- fails closed, not open", async () => {
    // This used to be the opposite test, asserting `true`: an empty
    // provided token and an empty/unset expected token hash to the same
    // digest, so the comparison alone would match. Found by a fresh
    // security review to be a real, complete auth bypass under a real
    // misconfiguration (SUBSCRIBE_TOKEN never set on the deployed Worker --
    // this project's own deploy hit exactly that once, for real, before
    // being caught and fixed with `--env production`) -- a caller sending
    // ZERO credentials would have been silently authorized. isAuthorized
    // now checks for a missing token explicitly and fails closed before
    // ever reaching the digest comparison; this test asserts that guard.
    const req = new Request("https://x/", { headers: { Authorization: "Bearer " } });
    // wrangler infers SUBSCRIBE_TOKEN as the literal type of its [vars]
    // value, not `string` -- the cast is deliberately widening for this one
    // test, not evidence the real binding type should be loosened.
    const fakeEnv = { ...env, SUBSCRIBE_TOKEN: "" } as unknown as Env;
    expect((await isAuthorized(req, fakeEnv)).authorized).toBe(false);
  });

  it("rejects every request, even with the exact right-shaped token, when SUBSCRIBE_TOKEN is unset", async () => {
    const req = new Request("https://x/", { headers: { Authorization: "Bearer anything-at-all" } });
    const fakeEnv = { ...env, SUBSCRIBE_TOKEN: undefined } as unknown as Env;
    expect((await isAuthorized(req, fakeEnv)).authorized).toBe(false);
  });

  describe("?token= query param fallback (for browser WebSocket clients, which can't set headers)", () => {
    it("accepts the correct token via query param when no Authorization header is present", async () => {
      const req = new Request(`https://x/?token=${env.SUBSCRIBE_TOKEN}`);
      expect((await isAuthorized(req, env)).authorized).toBe(true);
    });

    it("rejects a wrong token via query param", async () => {
      const req = new Request("https://x/?token=wrong-token");
      expect((await isAuthorized(req, env)).authorized).toBe(false);
    });

    it("prefers a valid Authorization header over the query param when both are present", async () => {
      const req = new Request("https://x/?token=wrong-token", {
        headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` },
      });
      expect((await isAuthorized(req, env)).authorized).toBe(true);
    });
  });
});

describe("isAllowedOrigin (SSRF guard)", () => {
  const allowlist = "127.0.0.1:8794,localhost:8794";

  it("allows a host on the allowlist", () => {
    expect(isAllowedOrigin("http://127.0.0.1:8794/mcp", allowlist)).toBe(true);
  });

  it("rejects a host not on the allowlist", () => {
    expect(isAllowedOrigin("http://evil.example.com/mcp", allowlist)).toBe(false);
  });

  it("rejects a host that merely contains an allowed host as a substring", () => {
    // e.g. "127.0.0.1:8794.evil.com" must not pass just because the
    // allowlist entry appears somewhere in the string
    expect(isAllowedOrigin("http://127.0.0.1:8794.evil.com/mcp", allowlist)).toBe(false);
  });

  it("rejects a non-http(s) protocol", () => {
    expect(isAllowedOrigin("file:///etc/passwd", allowlist)).toBe(false);
    expect(isAllowedOrigin("ftp://127.0.0.1:8794/mcp", allowlist)).toBe(false);
  });

  it("rejects a malformed URL rather than throwing", () => {
    expect(isAllowedOrigin("not a url at all", allowlist)).toBe(false);
  });

  it("rejects an allowed host on a different, non-allowlisted port", () => {
    expect(isAllowedOrigin("http://127.0.0.1:9999/mcp", allowlist)).toBe(false);
  });

  it("is not fooled by userinfo tricks like allowed-host@evil.com", () => {
    // a naive substring/startsWith check on the raw URL string could be
    // fooled by "http://127.0.0.1:8794@evil.com/" -- the *host* here is
    // actually evil.com, with 127.0.0.1:8794 as (ignored) userinfo, so this
    // must be rejected. Using URL.host (not the raw string) is what makes
    // this safe.
    expect(isAllowedOrigin("http://127.0.0.1:8794@evil.com/mcp", allowlist)).toBe(false);
  });
});

describe("isRateLimited (real Workers Rate Limiting API, not hand-rolled)", () => {
  it("allows a fresh key through", async () => {
    const req = new Request("https://x/", { headers: { "CF-Connecting-IP": uniqueIp() } });
    expect(await isRateLimited(req, env, "subscribe")).toBe(false);
  });

  it("trips after exceeding the configured limit (30 per 60s) for one key", async () => {
    const ip = uniqueIp();
    const req = new Request("https://x/", { headers: { "CF-Connecting-IP": ip } });
    const results: boolean[] = [];
    for (let i = 0; i < 31; i++) {
      results.push(await isRateLimited(req, env, "subscribe"));
    }
    expect(results.slice(0, 30)).toEqual(Array(30).fill(false));
    expect(results[30]).toBe(true);
  });

  it("keeps /subscribe and /relay in independent buckets on the same key", async () => {
    const ip = uniqueIp();
    const req = new Request("https://x/", { headers: { "CF-Connecting-IP": ip } });
    for (let i = 0; i < 30; i++) {
      await isRateLimited(req, env, "subscribe");
    }
    // subscribe's own bucket for this IP is now exhausted -- relay's bucket
    // for the SAME IP must be entirely unaffected, since they're keyed
    // "subscribe:<ip>" vs "relay:<ip>", not "<ip>" alone.
    expect(await isRateLimited(req, env, "subscribe")).toBe(true);
    expect(await isRateLimited(req, env, "relay")).toBe(false);
  });

  it("falls back to the shared token as the key when CF-Connecting-IP is absent (local dev)", async () => {
    // Not a bypass -- this is the same "one shared secret is the whole
    // trust boundary" model already true of SUBSCRIBE_TOKEN itself, applied
    // consistently. Just asserting it doesn't throw or silently no-op.
    const req = new Request("https://x/");
    expect(typeof (await isRateLimited(req, env, "subscribe"))).toBe("boolean");
  });
});

describe("buildFeedKey (cross-subscription data-leak guard)", () => {
  it("produces different keys for pairs that would collide under naive concatenation", () => {
    // "${originUrl}::${category}" would make these two DIFFERENT pairs
    // produce the IDENTICAL string: "http://x::a" + "::" + "b"  ===
    // "http://x" + "::" + "a::b"
    const keyA = buildFeedKey("http://x::a", "b");
    const keyB = buildFeedKey("http://x", "a::b");
    expect(keyA).not.toBe(keyB);
  });

  it("is stable and deterministic for the same inputs", () => {
    expect(buildFeedKey("http://x", "cat")).toBe(buildFeedKey("http://x", "cat"));
  });

  it("distinguishes different origins with the same category", () => {
    expect(buildFeedKey("http://a", "cat")).not.toBe(buildFeedKey("http://b", "cat"));
  });
});

describe("handleSubscribe integration", () => {
  it("returns 401 for an unauthorized request", async () => {
    const req = new Request("https://gateway/subscribe?originUrl=http://127.0.0.1:8794/mcp", {
      headers: { Upgrade: "websocket" },
    });
    const res = await handleSubscribe(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 400 when originUrl is missing", async () => {
    const req = new Request("https://gateway/subscribe", {
      headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}`, Upgrade: "websocket" },
    });
    const res = await handleSubscribe(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 403 when originUrl is not on the allowlist", async () => {
    const req = new Request("https://gateway/subscribe?originUrl=http://evil.example.com/mcp", {
      headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}`, Upgrade: "websocket" },
    });
    const res = await handleSubscribe(req, env);
    expect(res.status).toBe(403);
  });

  it("returns 403 for a real scoped credential whose scope doesn't cover the requested origin, even though the token itself is valid", async () => {
    const token = `subscribe-scope-test-${crypto.randomUUID()}`;
    const tokenHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    await env.DB.prepare("INSERT INTO agent_credentials (agent_name, token_hash, scope_origin_host, can_subscribe, created_at) VALUES (?, ?, ?, 1, ?)").bind(
      "scope-mismatch-agent",
      tokenHash,
      "only-this-host.test",
      new Date().toISOString(),
    ).run();

    const req = new Request("https://gateway/subscribe?originUrl=http://127.0.0.1:8794/mcp", {
      headers: { Authorization: `Bearer ${token}`, Upgrade: "websocket" },
    });
    const res = await handleSubscribe(req, env);
    // Not 401 -- the credential is real and valid, this is specifically
    // the checkScope() rejection, a different failure than "who are you".
    expect(res.status).toBe(403);
  });

  it(
    "returns 429 once one client's subscribe rate limit is exhausted",
    async () => {
      const ip = uniqueIp();
      const makeReq = () =>
        new Request("https://gateway/subscribe?originUrl=http://127.0.0.1:8794/mcp", {
          headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}`, Upgrade: "websocket", "CF-Connecting-IP": ip },
        });
      let last: Response | undefined;
      // 30 real attempts will fail for an unrelated reason (no real WebSocket
      // upgrade machinery in this unit test) before ever reaching FeedRelay --
      // that's fine, isRateLimited runs before any of that, so its own status
      // is what's under test here, not the eventual 101.
      for (let i = 0; i < 31; i++) {
        last = await handleSubscribe(makeReq(), env);
      }
      expect(last?.status).toBe(429);
    },
    // 31 real, sequential round-trips to the actual Rate Limiting binding
    // (remote mode under vitest-pool-workers, same as under local wrangler
    // dev) reliably exceed the default 5s timeout once the rest of the
    // suite is running concurrently and contending for the same real
    // network path -- confirmed flaky specifically under full-suite load,
    // not in isolation, so this is a real timing constraint to raise, not
    // a bug to chase.
    15000,
  );
});
