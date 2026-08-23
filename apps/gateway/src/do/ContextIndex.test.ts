import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

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

  it("a fresh scope reports a clean miss, not an error", async () => {
    const result = await stubFor("scope-fresh").lookup("never-stored-hash");
    expect(result).toEqual({ hit: false });
  });

  it("stores then serves byte-identical content back on lookup (correctness property 5)", async () => {
    await stubFor("scope-a").store({ requestHash: "h1", resultHash: "r1", content: "hello world", contentType: "application/json" });
    const result = await stubFor("scope-a").lookup("h1");
    expect(result.hit).toBe(true);
    if (!result.hit) throw new Error("unreachable");
    expect(result.entry.content).toBe("hello world");
    expect(result.entry.resultHash).toBe("r1");
    expect(result.entry.contentType).toBe("application/json");
    expect(result.entry.byteSize).toBe(new TextEncoder().encode("hello world").length);
  });

  it("byte size is computed from the actual UTF-8 encoding, not string length", async () => {
    // A multi-byte character (emoji here) makes charCodeAt/`.length`-based
    // sizing wrong -- this specific content would silently under-report if
    // ContextIndex.store ever regressed to `content.length` instead of
    // encoding it first.
    const content = "café 😀";
    const stored = await stubFor("scope-utf8").store({ requestHash: "h-utf8", resultHash: "r-utf8", content, contentType: "text/plain" });
    const expectedBytes = new TextEncoder().encode(content).length;
    expect(stored.byteSize).toBe(expectedBytes);
    const result = await stubFor("scope-utf8").lookup("h-utf8");
    expect(result.hit).toBe(true);
    if (!result.hit) throw new Error("unreachable");
    expect(result.entry.byteSize).toBe(expectedBytes);
    expect(result.entry.content).toBe(content);
  });

  it("hit_count increments exactly once per lookup", async () => {
    await stubFor("scope-b").store({ requestHash: "h2", resultHash: "r2", content: "x", contentType: "text/plain" });
    const first = await stubFor("scope-b").lookup("h2");
    const second = await stubFor("scope-b").lookup("h2");
    const third = await stubFor("scope-b").lookup("h2");
    if (!first.hit || !second.hit || !third.hit) throw new Error("unreachable");
    expect(first.entry.hitCount).toBe(1);
    expect(second.entry.hitCount).toBe(2);
    expect(third.entry.hitCount).toBe(3);
  });

  it("two different request hashes in the same scope are stored independently", async () => {
    await stubFor("scope-c").store({ requestHash: "ha", resultHash: "ra", content: "A", contentType: "text/plain" });
    await stubFor("scope-c").store({ requestHash: "hb", resultHash: "rb", content: "B", contentType: "text/plain" });
    const a = await stubFor("scope-c").lookup("ha");
    const b = await stubFor("scope-c").lookup("hb");
    if (!a.hit || !b.hit) throw new Error("unreachable");
    expect(a.entry.content).toBe("A");
    expect(b.entry.content).toBe("B");
  });

  it("re-storing under the same request hash replaces the entry and resets hit_count", async () => {
    await stubFor("scope-d").store({ requestHash: "h3", resultHash: "r3v1", content: "v1", contentType: "text/plain" });
    await stubFor("scope-d").lookup("h3");
    await stubFor("scope-d").lookup("h3");
    await stubFor("scope-d").store({ requestHash: "h3", resultHash: "r3v2", content: "v2", contentType: "text/plain" });
    const result = await stubFor("scope-d").lookup("h3");
    if (!result.hit) throw new Error("unreachable");
    expect(result.entry.content).toBe("v2");
    expect(result.entry.resultHash).toBe("r3v2");
    // Reset to 0 by the overwrite, then this one lookup makes it 1 -- not a
    // carry-over of the 2 hits the OLD entry accumulated.
    expect(result.entry.hitCount).toBe(1);
  });

  it("scope isolation: an identical request hash in a different scope never sees the other scope's entry (correctness property 7)", async () => {
    await stubFor("scope-e1").store({ requestHash: "shared-hash", resultHash: "r-e1", content: "scope-e1-secret", contentType: "text/plain" });
    const otherScope = await stubFor("scope-e2").lookup("shared-hash");
    expect(otherScope).toEqual({ hit: false });
    // And the original scope is unaffected by the other scope's lookup.
    const originalScope = await stubFor("scope-e1").lookup("shared-hash");
    if (!originalScope.hit) throw new Error("unreachable");
    expect(originalScope.entry.content).toBe("scope-e1-secret");
  });
});
