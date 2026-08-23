import { DurableObject } from "cloudflare:workers";
import { blake3Hex } from "../lib/wasmEngine";

// A hash-chained, tamper-evident record of agent actions: every real
// tool-call decision an authenticated agent makes gets appended here, each
// entry's hash computed over the previous entry's hash plus its own
// content. Altering or deleting a past entry breaks every hash after it,
// detectably, which is the actual property "audit-safe" has to mean if
// it's going to be more than a name -- a normal log table (delivery_log,
// agent_log) is honest about what happened but not provably untampered
// after the fact; this is.
//
// A single global instance, not one per agent or per feed: the whole
// point of a hash chain is one continuous, verifiable sequence. Sharding
// it would mean "prove nothing was altered" only ever answers for one
// shard at a time, a weaker and more confusing claim than "prove nothing
// in the whole log was altered."
//
// The chain lives here, in this DO's own SQLite, not in D1 -- the same
// reasoning ContextIndex's own comment already makes: computing
// `entryHash = hash(prevHash + entry)` correctly requires reading the
// previous hash and writing the new row with no `await` in between, so no
// concurrent append can race between the read and the write. A single DO
// instance's single-threaded execution makes that a structural guarantee;
// D1, reached from potentially many concurrent Worker invocations, could
// not offer it without its own separate coordination layer, which would
// just be reinventing what a DO already provides for free.

const GENESIS_HASH = "0".repeat(64);

export interface AuditEntry {
  seq: number;
  agentId: number | null;
  agentName: string;
  action: string;
  detail: string;
  occurredAt: string;
  prevHash: string;
  entryHash: string;
}

export interface VerifyResult {
  intact: boolean;
  checkedCount: number;
  brokenAtSeq: number | null;
}

function canonicalEntry(fields: { prevHash: string; agentId: number | null; agentName: string; action: string; detail: string; occurredAt: string }): string {
  // Field order fixed explicitly (not relying on object-key insertion
  // order matching between append() and verify()'s own recomputation) --
  // both call this exact same function, so there's no real risk of drift,
  // but pinning the order removes any doubt when reading this file cold.
  return JSON.stringify([fields.prevHash, fields.agentId, fields.agentName, fields.action, fields.detail, fields.occurredAt]);
}

export class AuditLog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id INTEGER,
          agent_name TEXT NOT NULL,
          action TEXT NOT NULL,
          detail TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          prev_hash TEXT NOT NULL,
          entry_hash TEXT NOT NULL
        )
      `);
    });
  }

  // Public RPC method. Synchronous body (the SELECT and the INSERT below
  // share one JS turn, no `await` between them) is what makes "read the
  // real previous hash, then write the new entry chained to it" atomic
  // against concurrent appends to this same DO instance -- an `await`
  // anywhere in this sequence would let a second, interleaved append read
  // the same stale prevHash and both entries would chain to the same
  // parent, silently breaking the guarantee this class exists to provide.
  append(entry: { agentId: number | null; agentName: string; action: string; detail: string }): { seq: number; entryHash: string } {
    const last = this.ctx.storage.sql.exec<{ entry_hash: string }>("SELECT entry_hash FROM entries ORDER BY seq DESC LIMIT 1").toArray()[0];
    const prevHash = last?.entry_hash ?? GENESIS_HASH;
    const occurredAt = new Date().toISOString();
    const entryHash = blake3Hex(canonicalEntry({ prevHash, agentId: entry.agentId, agentName: entry.agentName, action: entry.action, detail: entry.detail, occurredAt }));

    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        "INSERT INTO entries (agent_id, agent_name, action, detail, occurred_at, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
        entry.agentId,
        entry.agentName,
        entry.action,
        entry.detail,
        occurredAt,
        prevHash,
        entryHash,
      )
      .one();

    return { seq: row.seq, entryHash };
  }

  // Walks the whole chain in order, recomputing each entry's hash from its
  // stored fields and the previous entry's stored hash, and compares
  // against what's actually stored. A row edited after the fact (content
  // changed, but its own entry_hash left alone) fails at that exact seq;
  // a row deleted outright breaks the chain at the next surviving row,
  // since its prev_hash no longer matches anything recomputable.
  verify(): VerifyResult {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; agent_id: number | null; agent_name: string; action: string; detail: string; occurred_at: string; prev_hash: string; entry_hash: string }>(
        "SELECT * FROM entries ORDER BY seq ASC",
      )
      .toArray();

    let expectedPrev = GENESIS_HASH;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return { intact: false, checkedCount: rows.length, brokenAtSeq: row.seq };
      }
      const recomputed = blake3Hex(
        canonicalEntry({ prevHash: row.prev_hash, agentId: row.agent_id, agentName: row.agent_name, action: row.action, detail: row.detail, occurredAt: row.occurred_at }),
      );
      if (recomputed !== row.entry_hash) {
        return { intact: false, checkedCount: rows.length, brokenAtSeq: row.seq };
      }
      expectedPrev = row.entry_hash;
    }
    return { intact: true, checkedCount: rows.length, brokenAtSeq: null };
  }

  list(limit = 100): AuditEntry[] {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; agent_id: number | null; agent_name: string; action: string; detail: string; occurred_at: string; prev_hash: string; entry_hash: string }>(
        "SELECT * FROM entries ORDER BY seq DESC LIMIT ?",
        limit,
      )
      .toArray();
    return rows.map((row) => ({
      seq: row.seq,
      agentId: row.agent_id,
      agentName: row.agent_name,
      action: row.action,
      detail: row.detail,
      occurredAt: row.occurred_at,
      prevHash: row.prev_hash,
      entryHash: row.entry_hash,
    }));
  }
}
