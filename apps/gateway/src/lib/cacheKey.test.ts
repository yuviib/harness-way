import { describe, expect, it } from "vitest";
import { buildRequestHash, canonicalJson } from "./cacheKey";

describe("canonicalJson", () => {
  it("produces the identical string regardless of top-level key order", () => {
    const a = canonicalJson({ resourceId: "42", scope: "agent-a" });
    const b = canonicalJson({ scope: "agent-a", resourceId: "42" });
    expect(a).toBe(b);
  });

  it("produces the identical string regardless of nested key order", () => {
    const a = canonicalJson({ tool: "x", arguments: { resourceId: "42", verbose: true } });
    const b = canonicalJson({ arguments: { verbose: true, resourceId: "42" }, tool: "x" });
    expect(a).toBe(b);
  });

  it("preserves array element order -- arrays are positional, not sorted", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("treats an explicit undefined value the same as an absent key", () => {
    // JSON.stringify already does this (JSON.stringify({a: undefined}) ===
    // "{}"); asserted here so canonicalJson doesn't regress that by
    // handling undefined naively (see the function's own comment).
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
  });

  it("distinguishes genuinely different content", () => {
    expect(canonicalJson({ resourceId: "42" })).not.toBe(canonicalJson({ resourceId: "43" }));
  });

  it("round-trips primitives and null through plain JSON.stringify", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("buildRequestHash", () => {
  const base = { originUrl: "http://origin.test/mcp", tool: "resource_lookup", arguments: { resourceId: "42" } };

  it("is deterministic for the identical request", async () => {
    const a = await buildRequestHash(base);
    const b = await buildRequestHash({ ...base });
    expect(a).toBe(b);
  });

  it("is a 64-character lowercase hex string", async () => {
    const hash = await buildRequestHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unaffected by argument key order (goes through canonicalJson)", async () => {
    const a = await buildRequestHash({ ...base, arguments: { resourceId: "42", extra: true } });
    const b = await buildRequestHash({ ...base, arguments: { extra: true, resourceId: "42" } });
    expect(a).toBe(b);
  });

  it("differs when originUrl differs, arguments held equal", async () => {
    const a = await buildRequestHash(base);
    const b = await buildRequestHash({ ...base, originUrl: "http://other.test/mcp" });
    expect(a).not.toBe(b);
  });

  it("differs when the tool name differs", async () => {
    const a = await buildRequestHash(base);
    const b = await buildRequestHash({ ...base, tool: "other_tool" });
    expect(a).not.toBe(b);
  });

  it("differs when arguments differ", async () => {
    const a = await buildRequestHash(base);
    const b = await buildRequestHash({ ...base, arguments: { resourceId: "43" } });
    expect(a).not.toBe(b);
  });
});
