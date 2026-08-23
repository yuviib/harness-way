import { describe, expect, it } from "vitest";
import { lookupCache, storeCache } from "./cacheClient";

// Unit-level, not the real workerd DO binding: what's under test here is
// specifically lookupCache/storeCache's own contract ("never throw, always
// resolve to an honest miss/failure signal") independent of whatever a real
// ContextIndex instance does -- ContextIndex's own behavior has its own
// suite (ContextIndex.test.ts) against the real binding. A fake env lets
// each test control exactly what the DO's RPC methods "do" (throw vs.
// return a value) in a way a real DO can't easily be forced into on demand.
function fakeEnv(lookup: (requestHash: string) => unknown, store: (entry: unknown) => unknown = () => ({ byteSize: 0 })): Env {
  const stub = { lookup, store } as unknown as DurableObjectStub;
  return {
    CONTEXT_INDEX: {
      idFromName: () => ({}) as unknown as DurableObjectId,
      get: () => stub,
    },
  } as unknown as Env;
}

describe("lookupCache", () => {
  it("reports failedOpen (not a genuine miss) when the RPC call throws", async () => {
    const env = fakeEnv(() => {
      throw new Error("simulated DO failure");
    });
    const result = await lookupCache(env, "scope-a", "hash");
    expect(result).toEqual({ hit: false, failedOpen: true });
  });

  it("reports a genuine miss (failedOpen: false) when the DO honestly reports hit: false", async () => {
    const env = fakeEnv(() => ({ hit: false }));
    const result = await lookupCache(env, "scope-a", "hash");
    expect(result).toEqual({ hit: false, failedOpen: false });
  });

  it("passes through a real hit unchanged", async () => {
    const entry = {
      requestHash: "h",
      resultHash: "r",
      content: "c",
      contentType: "application/json",
      byteSize: 1,
      hitCount: 1,
      createdAt: "now",
    };
    const env = fakeEnv(() => ({ hit: true, entry }));
    const result = await lookupCache(env, "scope-a", "hash");
    expect(result).toEqual({ hit: true, entry });
  });
});

describe("storeCache", () => {
  it("returns false, without throwing, when the RPC call throws", async () => {
    const env = fakeEnv(
      () => ({ hit: false }),
      () => {
        throw new Error("simulated DO failure");
      },
    );
    const stored = await storeCache(env, "scope-a", { requestHash: "h", resultHash: "r", content: "c", contentType: "application/json" });
    expect(stored).toBe(false);
  });

  it("returns true on a successful store", async () => {
    const env = fakeEnv(
      () => ({ hit: false }),
      () => ({ byteSize: 1 }),
    );
    const stored = await storeCache(env, "scope-a", { requestHash: "h", resultHash: "r", content: "c", contentType: "application/json" });
    expect(stored).toBe(true);
  });
});
