import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog } from "./AuditLog";

describe("AuditLog", () => {
  afterEach(async () => {
    await reset();
  });

  function stubFor(name: string) {
    const id = env.AUDIT_LOG.idFromName(name);
    return env.AUDIT_LOG.get(id);
  }

  it("the first entry chains to the genesis hash, not a real prior entry", async () => {
    const { seq, entryHash } = await stubFor("chain-a").append({ agentId: 1, agentName: "triage-agent", action: "escalate", detail: "case-1" });
    expect(seq).toBe(1);
    expect(entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("each entry chains to the previous entry's exact hash", async () => {
    const stub = stubFor("chain-b");
    const first = await stub.append({ agentId: 1, agentName: "triage-agent", action: "escalate", detail: "case-1" });
    const second = await stub.append({ agentId: 1, agentName: "triage-agent", action: "clear", detail: "case-2" });
    expect(second.seq).toBe(2);
    expect(second.entryHash).not.toBe(first.entryHash);

    const entries = await stub.list(10);
    expect(entries).toHaveLength(2);
    // list() returns newest first
    expect(entries[0]!.prevHash).toBe(first.entryHash);
    expect(entries[1]!.prevHash).toMatch(/^0+$/);
  });

  it("verify() reports intact on a real, untouched chain", async () => {
    const stub = stubFor("chain-c");
    await stub.append({ agentId: 1, agentName: "triage-agent", action: "escalate", detail: "case-1" });
    await stub.append({ agentId: 2, agentName: "gap-aware-agent", action: "resync", detail: "case-2" });
    await stub.append({ agentId: 1, agentName: "triage-agent", action: "clear", detail: "case-3" });

    const result = await stub.verify();
    expect(result).toEqual({ intact: true, checkedCount: 3, brokenAtSeq: null });
  });

  it("verify() detects an entry edited after the fact, without its hash being recomputed", async () => {
    const stub = stubFor("chain-d");
    await stub.append({ agentId: 1, agentName: "triage-agent", action: "escalate", detail: "original detail" });
    await stub.append({ agentId: 1, agentName: "triage-agent", action: "clear", detail: "case-2" });

    // Simulating exactly what "tampered with after the fact" means: the
    // content changed, but entry_hash was left as whatever it originally
    // was, since a real tamperer editing a database row directly has no
    // way to also recompute a hash they don't know how this class derives.
    await runInDurableObject(stub, async (instance) => {
      const log = instance as unknown as AuditLog & { ctx: DurableObjectState };
      log.ctx.storage.sql.exec("UPDATE entries SET detail = ? WHERE seq = 1", "tampered detail");
    });

    const result = await stub.verify();
    expect(result.intact).toBe(false);
    expect(result.brokenAtSeq).toBe(1);
    expect(result.checkedCount).toBe(2);
  });

  it("verify() detects a deleted entry via the resulting broken chain link", async () => {
    const stub = stubFor("chain-e");
    await stub.append({ agentId: 1, agentName: "triage-agent", action: "escalate", detail: "case-1" });
    await stub.append({ agentId: 1, agentName: "triage-agent", action: "clear", detail: "case-2" });
    await stub.append({ agentId: 1, agentName: "triage-agent", action: "clear", detail: "case-3" });

    await runInDurableObject(stub, async (instance) => {
      const log = instance as unknown as AuditLog & { ctx: DurableObjectState };
      log.ctx.storage.sql.exec("DELETE FROM entries WHERE seq = 2");
    });

    const result = await stub.verify();
    expect(result.intact).toBe(false);
    // seq 3's prev_hash still points at seq 2's real hash, which no longer
    // has a row to have recomputed from -- the break surfaces at seq 3,
    // the first row whose claimed lineage can no longer be verified, not
    // at the deleted row itself, which no longer exists to fail at.
    expect(result.brokenAtSeq).toBe(3);
  });

  it("different named instances (different audit logs) never share a chain", async () => {
    await stubFor("chain-isolated-1").append({ agentId: 1, agentName: "a", action: "x", detail: "1" });
    const otherChainFirst = await stubFor("chain-isolated-2").append({ agentId: 1, agentName: "a", action: "x", detail: "1" });
    // Both are genuinely the first entry in their own separate chain, both
    // chain to genesis, not to each other.
    const entries = await stubFor("chain-isolated-2").list(1);
    expect(entries[0]!.prevHash).toMatch(/^0+$/);
    expect(otherChainFirst.seq).toBe(1);
  });
});
