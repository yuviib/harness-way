// Typed I/O helpers for talking to a scope's ContextIndex Durable Object.
// No protocol logic lives here (no auth, no origin-fetch, no hashing) --
// that's routes/relay.ts's job; this file only knows how to shape a
// request to the DO and parse its response, same division of labor as
// lib/metricsWriter.ts (D1 I/O, no policy) relative to do/FeedRelay.ts.
import type { CacheEntry, LookupResult } from "../do/ContextIndex";

export { type CacheEntry };

// Richer than the DO's own LookupResult: `failedOpen` distinguishes "the
// index was consulted and honestly reported no entry" (a genuine miss)
// from "the index couldn't be consulted at all" (DO fetch threw, or
// returned a non-OK status) -- both fall through to a real origin call in
// routes/relay.ts (see lookupCache below), but they are NOT the same event
// and cache_log records them under different outcomes ('miss' vs
// 'fail-open') specifically so a run of index failures is visible in the
// dashboard rather than indistinguishable from ordinary cold-cache misses.
export type ClientLookupResult = { hit: true; entry: CacheEntry } | { hit: false; failedOpen: boolean };

function stubFor(env: Env, scope: string) {
  const id = env.CONTEXT_INDEX.idFromName(scope);
  return env.CONTEXT_INDEX.get(id);
}

// Never throws: any failure to reach or parse a response from the DO is
// reported as `{ hit: false, failedOpen: true }`, not propagated as an
// exception -- routes/relay.ts's fail-open guarantee (PLAN.md correctness
// property 6) depends on this function being unable to itself become the
// error that takes a caller down.
export async function lookupCache(env: Env, scope: string, requestHash: string): Promise<ClientLookupResult> {
  try {
    const res = await stubFor(env, scope).fetch("https://context-index/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestHash }),
    });
    if (!res.ok) {
      return { hit: false, failedOpen: true };
    }
    const result = (await res.json()) as LookupResult;
    return result.hit ? { hit: true, entry: result.entry } : { hit: false, failedOpen: false };
  } catch {
    return { hit: false, failedOpen: true };
  }
}

export interface StoreCacheEntry {
  requestHash: string;
  resultHash: string;
  content: string;
  contentType: string;
}

// Best-effort by design, same reasoning as lookupCache: a failure to
// persist a cache entry must never surface as a failure of the underlying
// (already-successful) origin call it's trying to cache the result of.
// Returns whether the store succeeded so the caller can log it accurately
// (see routes/relay.ts's cache_log write), without ever throwing.
export async function storeCache(env: Env, scope: string, entry: StoreCacheEntry): Promise<boolean> {
  try {
    const res = await stubFor(env, scope).fetch("https://context-index/store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    return res.ok;
  } catch {
    return false;
  }
}
