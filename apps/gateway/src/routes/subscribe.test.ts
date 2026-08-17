import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildFeedKey, handleSubscribe, isAllowedOrigin, isAuthorized } from "./subscribe";

// Real bindings from wrangler.toml, running inside the actual workerd
// runtime -- not mocked. env.SUBSCRIBE_TOKEN / env.ALLOWED_ORIGIN_HOSTS are
// whatever wrangler.toml's [vars] currently say.

describe("isAuthorized (timing-safe token check)", () => {
  it("accepts the correct bearer token", async () => {
    const req = new Request("https://x/", {
      headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` },
    });
    expect(await isAuthorized(req, env)).toBe(true);
  });

  it("rejects a wrong token", async () => {
    const req = new Request("https://x/", { headers: { Authorization: "Bearer wrong-token" } });
    expect(await isAuthorized(req, env)).toBe(false);
  });

  it("rejects a missing Authorization header", async () => {
    const req = new Request("https://x/");
    expect(await isAuthorized(req, env)).toBe(false);
  });

  it("rejects a header missing the Bearer prefix", async () => {
    const req = new Request("https://x/", { headers: { Authorization: env.SUBSCRIBE_TOKEN } });
    expect(await isAuthorized(req, env)).toBe(false);
  });

  it("rejects a token that only differs in length, not just content", async () => {
    // guards against a naive implementation that short-circuits on length
    // mismatch before ever reaching a constant-time comparison loop
    const req = new Request("https://x/", {
      headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}extra` },
    });
    expect(await isAuthorized(req, env)).toBe(false);
  });

  it("matches an empty provided token only against an empty expected token", async () => {
    // Documents the actual behavior explicitly rather than leaving it an
    // untested assumption: both sides hash to the same fixed digest when
    // both are empty, so this is expected to match -- it's the "provided
    // empty against a REAL non-empty secret" case (covered by the missing-
    // header test above, which already asserts false) that must never pass.
    const req = new Request("https://x/", { headers: { Authorization: "Bearer " } });
    // wrangler infers SUBSCRIBE_TOKEN as the literal type of its [vars]
    // value, not `string` -- the cast is deliberately widening for this one
    // test, not evidence the real binding type should be loosened.
    const fakeEnv = { ...env, SUBSCRIBE_TOKEN: "" } as unknown as Env;
    expect(await isAuthorized(req, fakeEnv)).toBe(true);
  });

  describe("?token= query param fallback (for browser WebSocket clients, which can't set headers)", () => {
    it("accepts the correct token via query param when no Authorization header is present", async () => {
      const req = new Request(`https://x/?token=${env.SUBSCRIBE_TOKEN}`);
      expect(await isAuthorized(req, env)).toBe(true);
    });

    it("rejects a wrong token via query param", async () => {
      const req = new Request("https://x/?token=wrong-token");
      expect(await isAuthorized(req, env)).toBe(false);
    });

    it("prefers a valid Authorization header over the query param when both are present", async () => {
      const req = new Request("https://x/?token=wrong-token", {
        headers: { Authorization: `Bearer ${env.SUBSCRIBE_TOKEN}` },
      });
      expect(await isAuthorized(req, env)).toBe(true);
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
});
