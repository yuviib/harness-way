import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

interface LookupBody {
  hit: boolean;
  entry?: {
    requestHash: string;
    resultHash: string;
    content: string;
    contentType: string;
    byteSize: number;
    hitCount: number;
    createdAt: string;
  };
}

describe("ContextIndex", () => {
  afterEach(async () => {
    // Same reasoning as FeedRelay.test.ts's own afterEach: DO storage can
    // survive across separate `vitest run` invocations via Miniflare's
    // local persistence, not just within one run -- every test below uses
    // a scope name unique to itself, but reset() removes any dependency on
    // that discipline holding perfectly forever.
    await reset();
  });

  function stubFor(scope: string) {
    const id = env.CONTEXT_INDEX.idFromName(scope);
    return env.CONTEXT_INDEX.get(id);
  }

  async function lookup(scope: string, requestHash: string): Promise<{ status: number; body: LookupBody }> {
    const res = await stubFor(scope).fetch("https://context-index/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestHash }),
    });
    return { status: res.status, body: (await res.json()) as LookupBody };
  }

  async function store(
    scope: string,
    entry: { requestHash: string; resultHash: string; content: string; contentType: string },
  ): Promise<{ status: number; body: { byteSize?: number } }> {
    const res = await stubFor(scope).fetch("https://context-index/store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    return { status: res.status, body: (await res.json()) as { byteSize?: number } };
  }

  it("a fresh scope reports a clean miss, not an error", async () => {
    const { status, body } = await lookup("scope-fresh", "never-stored-hash");
    expect(status).toBe(200);
    expect(body).toEqual({ hit: false });
  });

  it("stores then serves byte-identical content back on lookup (correctness property 5)", async () => {
    await store("scope-a", { requestHash: "h1", resultHash: "r1", content: "hello world", contentType: "application/json" });
    const { body } = await lookup("scope-a", "h1");
    expect(body.hit).toBe(true);
    expect(body.entry?.content).toBe("hello world");
    expect(body.entry?.resultHash).toBe("r1");
    expect(body.entry?.contentType).toBe("application/json");
    expect(body.entry?.byteSize).toBe(new TextEncoder().encode("hello world").length);
  });

  it("byte size is computed from the actual UTF-8 encoding, not string length", async () => {
    // A multi-byte character (emoji here) makes charCodeAt/`.length`-based
    // sizing wrong -- this specific content would silently under-report if
    // ContextIndex.store ever regressed to `content.length` instead of
    // encoding it first.
    const content = "café 😀";
    const { status, body: storeBody } = await store("scope-utf8", {
      requestHash: "h-utf8",
      resultHash: "r-utf8",
      content,
      contentType: "text/plain",
    });
    expect(status).toBe(200);
    const expectedBytes = new TextEncoder().encode(content).length;
    expect(storeBody.byteSize).toBe(expectedBytes);
    const { body } = await lookup("scope-utf8", "h-utf8");
    expect(body.entry?.byteSize).toBe(expectedBytes);
    expect(body.entry?.content).toBe(content);
  });

  it("hit_count increments exactly once per lookup", async () => {
    await store("scope-b", { requestHash: "h2", resultHash: "r2", content: "x", contentType: "text/plain" });
    const first = await lookup("scope-b", "h2");
    expect(first.body.entry?.hitCount).toBe(1);
    const second = await lookup("scope-b", "h2");
    expect(second.body.entry?.hitCount).toBe(2);
    const third = await lookup("scope-b", "h2");
    expect(third.body.entry?.hitCount).toBe(3);
  });

  it("two different request hashes in the same scope are stored independently", async () => {
    await store("scope-c", { requestHash: "ha", resultHash: "ra", content: "A", contentType: "text/plain" });
    await store("scope-c", { requestHash: "hb", resultHash: "rb", content: "B", contentType: "text/plain" });
    const a = await lookup("scope-c", "ha");
    const b = await lookup("scope-c", "hb");
    expect(a.body.entry?.content).toBe("A");
    expect(b.body.entry?.content).toBe("B");
  });

  it("re-storing under the same request hash replaces the entry and resets hit_count", async () => {
    await store("scope-d", { requestHash: "h3", resultHash: "r3v1", content: "v1", contentType: "text/plain" });
    await lookup("scope-d", "h3");
    await lookup("scope-d", "h3");
    await store("scope-d", { requestHash: "h3", resultHash: "r3v2", content: "v2", contentType: "text/plain" });
    const { body } = await lookup("scope-d", "h3");
    expect(body.entry?.content).toBe("v2");
    expect(body.entry?.resultHash).toBe("r3v2");
    // Reset to 0 by the overwrite, then this one lookup makes it 1 -- not a
    // carry-over of the 2 hits the OLD entry accumulated.
    expect(body.entry?.hitCount).toBe(1);
  });

  it("scope isolation: an identical request hash in a different scope never sees the other scope's entry (correctness property 7)", async () => {
    await store("scope-e1", { requestHash: "shared-hash", resultHash: "r-e1", content: "scope-e1-secret", contentType: "text/plain" });
    const otherScope = await lookup("scope-e2", "shared-hash");
    expect(otherScope.body).toEqual({ hit: false });
    // And the original scope is unaffected by the other scope's lookup.
    const originalScope = await lookup("scope-e1", "shared-hash");
    expect(originalScope.body.entry?.content).toBe("scope-e1-secret");
  });

  it("rejects a lookup missing requestHash", async () => {
    const res = await stubFor("scope-f").fetch("https://context-index/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a store missing required fields", async () => {
    const res = await stubFor("scope-g").fetch("https://context-index/store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestHash: "h" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-POST methods", async () => {
    const res = await stubFor("scope-h").fetch("https://context-index/lookup", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("404s on an unknown path", async () => {
    const res = await stubFor("scope-i").fetch("https://context-index/nope", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
