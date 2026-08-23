import { DurableObject } from "cloudflare:workers";

// Capability 2's cache index: one instance per caller-supplied `scope` (see
// routes/relay.ts, which derives the instance via
// env.CONTEXT_INDEX.idFromName(scope)), mapping a request's content hash to
// the content-addressed result it previously produced.
//
// Deliberate deviation from PLAN.md's original repo-layout sketch, which
// named this file's storage as "Cache API / KV read-write" (src/lib/
// cacheClient.ts's original comment). That sketch predated actually
// building this: DO SQLite storage is used instead, for the same reason
// FeedRelay's replay buffer ended up on ctx.storage.sql rather than routed
// through WASM linear memory (see FeedRelay.ts's own comment on that) --
// this needs synchronous, testable, exactly-once-per-key semantics (real
// RPC calls against a real workerd DO in vitest-pool-workers), not the
// Cache API's best-effort, eviction-at-any-time, edge-local-only
// semantics, which would make the correctness
// properties this cache is supposed to demonstrate (byte-identical
// replay, scope isolation) untestable in the same deterministic way
// FeedRelay's own suite already relies on.
//
// Scope isolation (PLAN.md correctness property 7) is a STRUCTURAL
// guarantee here, not a runtime check: two different scopes are two
// different Durable Object instances with two entirely separate SQLite
// databases. There is no code path in this class that could leak one
// scope's entry into a lookup for another -- an actual bug would have to
// be routing to the wrong DO instance (routes/relay.ts's own concern,
// covered by relay.test.ts), not anything this class could get wrong
// internally.

export interface CacheEntry {
  requestHash: string;
  resultHash: string;
  content: string;
  contentType: string;
  byteSize: number;
  hitCount: number;
  createdAt: string;
}

export type LookupResult = { hit: true; entry: CacheEntry } | { hit: false };

export class ContextIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS cache_entries (
          request_hash TEXT PRIMARY KEY,
          result_hash TEXT NOT NULL,
          content TEXT NOT NULL,
          content_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);
    });
  }

  // Read-and-increment in one call rather than a separate read then write:
  // both the SELECT and the UPDATE below are synchronous SQLite calls with
  // no `await` between them, so within this single fetch() invocation
  // they execute as one uninterrupted JS turn -- no other request to this
  // same DO instance can observe or race between them. That's what makes
  // "every hit is counted, exactly once, even under concurrent identical
  // lookups" a guarantee here rather than a best-effort increment.
  // Public: called as an RPC method directly (lib/cacheClient.ts), not
  // through a fetch() handler -- this DO never needs a WebSocket upgrade,
  // so there's no reason to round-trip through HTTP request/response
  // parsing for what's really just a typed function call.
  lookup(requestHash: string): LookupResult {
    const row = this.ctx.storage.sql
      .exec<{
        request_hash: string;
        result_hash: string;
        content: string;
        content_type: string;
        byte_size: number;
        hit_count: number;
        created_at: string;
      }>("SELECT * FROM cache_entries WHERE request_hash = ?", requestHash)
      .toArray()[0];
    if (!row) {
      return { hit: false };
    }
    this.ctx.storage.sql.exec("UPDATE cache_entries SET hit_count = hit_count + 1 WHERE request_hash = ?", requestHash);
    return {
      hit: true,
      entry: {
        requestHash: row.request_hash,
        resultHash: row.result_hash,
        content: row.content,
        contentType: row.content_type,
        byteSize: row.byte_size,
        hitCount: row.hit_count + 1,
        createdAt: row.created_at,
      },
    };
  }

  // INSERT OR REPLACE, not a plain INSERT: two concurrent misses for the
  // SAME requestHash (a genuine race -- two callers asking the identical
  // question for the first time, microseconds apart, before either's
  // /store call has landed) both go on to call the real origin and both
  // arrive here to store their result. For this project's deterministic
  // synthetic origin those two results are byte-identical anyway (see
  // origin-simulator's own comment on this), so last-write-wins is a
  // correct, not just convenient, resolution -- and REPLACE resets
  // hit_count to 0 on that second write, which is also correct: nobody has
  // been served this entry from cache yet at that point, real or synthetic
  // origin. A non-deterministic real-world origin would need a different,
  // explicitly-scoped policy here (e.g. first-write-wins); documented as
  // out of scope, same as this project's other stated v1 boundaries.
  store(entry: { requestHash: string; resultHash: string; content: string; contentType: string }): { byteSize: number } {
    const byteSize = new TextEncoder().encode(entry.content).length;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cache_entries (request_hash, result_hash, content, content_type, byte_size, hit_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
      entry.requestHash,
      entry.resultHash,
      entry.content,
      entry.contentType,
      byteSize,
      new Date().toISOString(),
    );
    return { byteSize };
  }
}
