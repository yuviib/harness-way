// Four real consumers of the relay (see apps/agents), each a genuine
// WebSocket subscriber through the same /subscribe endpoint any client
// uses -- not simulated traffic. This view exists to make the point the
// rest of the dashboard can't: the relay's guarantees aren't abstract,
// they're what these agents' own logic actually depends on. resume-agent
// only works because reconnect replay is gapless; gap-aware-agent only
// works because every drop gets an explicit marker, never silence.
//
// KPIs use /api/agent-log/counts (true per-action-type totals) for the
// same reason GapAudit does for delivery_log -- see that view's own
// comment on the row-window-vs-total bug this avoids repeating.

import { useCallback, useEffect, useState } from "react";
import {
  type AgentActionType,
  type AgentLogCounts,
  type AgentLogRow,
  fetchAgentLog,
  fetchAgentLogCounts,
} from "../lib/agentLogApi";
import { buildFeedKey } from "../lib/deliveryLogApi";
import type { GatewaySettings } from "../lib/settings";
import { StatTile } from "../components/StatTile";

const POLL_INTERVAL_MS = 4000;
const RECENT_PER_AGENT = 6;

interface AgentMeta {
  name: string;
  role: string;
}

const KNOWN_AGENTS: AgentMeta[] = [
  {
    name: "resume-agent",
    role: "Reconnects on a fixed interval and verifies the replay it receives is gapless and picks up exactly where it left off.",
  },
  {
    name: "gap-aware-agent",
    role: "Treats every gap marker as an explicit resync signal instead of silence, and reports exactly what it resynced from.",
  },
  {
    name: "ordering-agent",
    role: "Asserts live that sequence numbers arrive strictly increasing, with a periodic status report even when everything checks out.",
  },
  {
    name: "summarizer-agent",
    role: "Calls the Gemini API to turn each notification into a one-line summary. Optional: only runs when a Gemini API key is configured.",
  },
];

const ACTION_CONFIG: Record<AgentActionType, { label: string; color: string }> = {
  resync: { label: "Resync", color: "var(--color-status-warning)" },
  reconnect_verified: { label: "Reconnect verified", color: "var(--color-status-good)" },
  order_check: { label: "Order check", color: "var(--color-muted)" },
  summary: { label: "Summary", color: "var(--color-accent)" },
  error: { label: "Error", color: "var(--color-status-critical)" },
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1500) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function ActionRow({ row }: { row: AgentLogRow }) {
  const cfg = ACTION_CONFIG[row.action_type];
  return (
    <div className="flex items-start gap-2.5 border-b border-rule px-3.5 py-2.5 last:border-b-0">
      <span
        className="mt-0.5 inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
        style={{ borderColor: cfg.color, color: cfg.color }}
      >
        {cfg.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-ink-2">{row.detail ?? "—"}</div>
        <div className="mt-0.5 text-[11px] text-muted">{timeAgo(row.occurred_at)}</div>
      </div>
    </div>
  );
}

function AgentCard({ meta, rows }: { meta: AgentMeta; rows: AgentLogRow[] }) {
  const latest = rows[0];
  return (
    <div className="rounded-card border border-rule">
      <div className="border-b border-rule px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-sm font-medium text-ink">{meta.name}</h3>
          <span className="text-[11px] text-muted">{latest ? timeAgo(latest.occurred_at) : "no activity yet"}</span>
        </div>
        <p className="mt-1 text-xs text-muted">{meta.role}</p>
      </div>
      {rows.length > 0 ? (
        <div>
          {rows.slice(0, RECENT_PER_AGENT).map((r) => (
            <ActionRow key={r.id} row={r} />
          ))}
        </div>
      ) : (
        <div className="px-4 py-6 text-center text-xs text-muted">
          Nothing logged yet. Run <code className="rounded bg-paper-2 px-1 py-0.5 font-mono">npm run dev</code> in{" "}
          <code className="rounded bg-paper-2 px-1 py-0.5 font-mono">apps/agents</code>.
        </div>
      )}
    </div>
  );
}

export function AgentsView({ settings }: { settings: GatewaySettings }) {
  const [counts, setCounts] = useState<AgentLogCounts | null>(null);
  const [rows, setRows] = useState<AgentLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const feedKey = buildFeedKey(settings.originUrl, settings.category);

  const refresh = useCallback(() => {
    Promise.all([fetchAgentLogCounts(settings, feedKey), fetchAgentLog(settings, { feedKey, limit: 200 })])
      .then(([c, r]) => {
        setCounts(c);
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [settings, feedKey]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const totalActions = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Agents</h1>
        <p className="mt-1 text-sm text-muted">
          Real WebSocket subscribers through the same feed the dashboard uses, each depending on a specific guarantee the
          relay provides. Start them with <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">npm run dev</code>{" "}
          in <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">apps/agents</code>.
        </p>
      </div>

      {error && (
        <div className="rounded-card border px-4 py-3 text-sm" style={{ borderColor: "var(--color-status-critical)" }}>
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Actions logged" value={totalActions.toLocaleString()} />
        <StatTile label="Errors" value={(counts?.error ?? 0).toLocaleString()} accent={(counts?.error ?? 0) > 0} />
        <StatTile label="Gaps resynced" value={(counts?.resync ?? 0).toLocaleString()} />
        <StatTile label="Reconnects verified" value={(counts?.reconnect_verified ?? 0).toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {KNOWN_AGENTS.map((meta) => (
          <AgentCard key={meta.name} meta={meta} rows={rows.filter((r) => r.agent_name === meta.name)} />
        ))}
      </div>
    </div>
  );
}
