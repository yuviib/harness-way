// Capability 2's dashboard view: the shared, content-addressed discrete
// tool-call cache (see apps/gateway/src/routes/relay.ts,
// apps/gateway/src/do/ContextIndex.ts). Every number here comes from
// cache_log, written by a real /relay call, not a simulation -- hitting
// /relay twice with the same {originUrl, scope, tool, arguments} from two
// different callers is the actual multi-client cache-sharing property this
// view exists to make visible (see apps/agents/src/cacheSharingAgent.ts for
// a real two-caller demo that drives exactly this).
//
// Scoped by an operator-entered `scope` string (mirrors relay.ts's own
// caller-supplied scope, the same v1 identity boundary documented there),
// defaulting to blank -- unscoped shows totals across every scope, useful
// as a first look before narrowing to one.

import { useCallback, useEffect, useState } from "react";
import { type CacheLogRow, type CacheLogStats, type CacheOutcome, fetchCacheLog, fetchCacheLogStats } from "../lib/cacheLogApi";
import type { GatewaySettings } from "../lib/settings";
import { StatTile } from "../components/StatTile";

const POLL_INTERVAL_MS = 4000;
const RECENT_LIMIT = 30;

const OUTCOME_CONFIG: Record<CacheOutcome, { label: string; color: string }> = {
  hit: { label: "Hit", color: "var(--color-status-good)" },
  miss: { label: "Miss", color: "var(--color-muted)" },
  "fail-open": { label: "Fail-open", color: "var(--color-status-warning)" },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1500) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

// Proportional stacked bar over the three outcomes -- the same shape as a
// gap-audit ratio view, deliberately simple: this is meant to be read at a
// glance ("mostly green = the cache is doing its job for this scope"), not
// analyzed precisely (exact counts are in the StatTiles and table below).
function OutcomeBar({ stats }: { stats: CacheLogStats }) {
  const total = stats.totalRequests;
  if (total === 0) {
    return <div className="h-2 w-full rounded-full" style={{ background: "var(--color-paper-2)" }} />;
  }
  const segments: { outcome: CacheOutcome; count: number }[] = [
    { outcome: "hit", count: stats.hit.count },
    { outcome: "miss", count: stats.miss.count },
    { outcome: "fail-open", count: stats.failOpen.count },
  ];
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full">
      {segments
        .filter((s) => s.count > 0)
        .map((s) => (
          <div
            key={s.outcome}
            style={{ width: `${(s.count / total) * 100}%`, background: OUTCOME_CONFIG[s.outcome].color }}
            title={`${OUTCOME_CONFIG[s.outcome].label}: ${s.count}`}
          />
        ))}
    </div>
  );
}

function LogRow({ row }: { row: CacheLogRow }) {
  const cfg = OUTCOME_CONFIG[row.outcome];
  return (
    <div className="flex items-center gap-2.5 border-b border-rule px-3.5 py-2 last:border-b-0">
      <span
        className="inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
        style={{ borderColor: cfg.color, color: cfg.color }}
      >
        {cfg.label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{row.scope}</span>
      <span className="shrink-0 text-xs text-muted">{formatBytes(row.byte_size)}</span>
      <span className="w-16 shrink-0 text-right text-xs text-muted">{row.latency_ms}ms</span>
      <span className="w-16 shrink-0 text-right text-[11px] text-muted">{timeAgo(row.occurred_at)}</span>
    </div>
  );
}

export function CacheMetrics({ settings }: { settings: GatewaySettings }) {
  const [scope, setScope] = useState("");
  const [stats, setStats] = useState<CacheLogStats | null>(null);
  const [rows, setRows] = useState<CacheLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const trimmed = scope.trim() || undefined;
    Promise.all([fetchCacheLogStats(settings, trimmed), fetchCacheLog(settings, { scope: trimmed, limit: RECENT_LIMIT })])
      .then(([s, r]) => {
        setStats(s);
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [settings, scope]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const avgLatencySavedMs = stats && stats.miss.count > 0 ? Math.max(0, stats.miss.avgLatencyMs - stats.hit.avgLatencyMs) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Cache Metrics</h1>
        <p className="mt-1 text-sm text-muted">
          Capability 2: discrete tool-call results, cached by content hash and shared across every caller in a scope, not
          held locally per client. A hit means a DIFFERENT caller's identical request was already answered -- see{" "}
          <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">apps/agents/src/cacheSharingAgent.ts</code>{" "}
          for a real two-caller demo.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="cache-scope-filter" className="text-xs text-muted">
          Scope
        </label>
        <input
          id="cache-scope-filter"
          type="text"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder="all scopes"
          className="rounded-control border border-rule bg-paper px-2.5 py-1.5 font-mono text-xs text-ink-2 outline-none focus:border-rule-2"
        />
      </div>

      {error && (
        <div className="rounded-card border px-4 py-3 text-sm" style={{ borderColor: "var(--color-status-critical)" }}>
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Hit rate"
          value={stats ? `${(stats.hitRate * 100).toFixed(0)}%` : "—"}
          accent={(stats?.hitRate ?? 0) > 0}
        />
        <StatTile label="Bytes saved" value={stats ? formatBytes(stats.bytesSaved) : "—"} />
        <StatTile label="Total requests" value={(stats?.totalRequests ?? 0).toLocaleString()} />
        <StatTile
          label="Latency saved / hit"
          value={avgLatencySavedMs > 0 ? `~${Math.round(avgLatencySavedMs)}ms` : "—"}
          hint="avg miss latency − avg hit latency"
        />
      </div>

      {stats && (
        <div className="rounded-card border border-rule px-4 py-3.5">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              {stats.hit.count} hit{stats.hit.count === 1 ? "" : "s"} · {stats.miss.count} miss{stats.miss.count === 1 ? "" : "es"} ·{" "}
              {stats.failOpen.count} fail-open
            </span>
          </div>
          <div className="mt-2.5">
            <OutcomeBar stats={stats} />
          </div>
        </div>
      )}

      <div className="rounded-card border border-rule">
        <div className="border-b border-rule px-4 py-3">
          <h3 className="font-mono text-sm font-medium text-ink">Recent cache accesses</h3>
        </div>
        {rows.length > 0 ? (
          <div>
            {rows.map((r) => (
              <LogRow key={r.id} row={r} />
            ))}
          </div>
        ) : (
          <div className="px-4 py-6 text-center text-xs text-muted">
            No cache accesses logged yet. POST to{" "}
            <code className="rounded bg-paper-2 px-1 py-0.5 font-mono">/relay</code> or run{" "}
            <code className="rounded bg-paper-2 px-1 py-0.5 font-mono">npm run demo:cache</code> in{" "}
            <code className="rounded bg-paper-2 px-1 py-0.5 font-mono">apps/agents</code>.
          </div>
        )}
      </div>
    </div>
  );
}
