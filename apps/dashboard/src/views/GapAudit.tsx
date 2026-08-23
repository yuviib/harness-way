// Every gap marker issued, cause labeled -- both causes FeedRelay actually
// logs (see apps/gateway/src/do/FeedRelay.ts): "buffer-eviction" (a
// reconnecting client's lastSeenSeq predates the retained replay window) and
// "upstream-drop" (the upstream connection ended unexpectedly and
// reconnected). Two stat tiles for the two causes (a 2-slice pie is an
// explicit dataviz anti-pattern -- "a stat tile, the number is the chart"),
// a donut for the 3-way entry-type mix (a legitimate part-to-whole use), an
// area chart of event throughput over time, and the raw gap log as a table.
//
// KPIs and the donut use /api/delivery-log/counts (true per-type totals) --
// NOT a count of a row array. Found on the real dashboard, not designed up
// front: a single `limit=500` query mixing all entry types together let
// this feed's ~1-event-per-second volume completely crowd 2 real gap rows
// out of the fetched window, so "Gap markers: 0" was rendered next to gaps
// that genuinely existed. The gap log table and throughput chart still use
// entryType-filtered row queries (gaps are rare enough that even a modest
// limit sees all of them; the throughput chart only ever wants a recent
// window anyway, and says so).

import { useCallback, useEffect, useState } from "react";
import { AreaChart, type AreaPoint } from "../components/AreaChart";
import { Donut } from "../components/Donut";
import { StatTile } from "../components/StatTile";
import {
  type DeliveryLogCounts,
  type DeliveryLogRow,
  buildFeedKey,
  fetchDeliveryLog,
  fetchDeliveryLogCounts,
} from "../lib/deliveryLogApi";
import type { GatewaySettings } from "../lib/settings";

const POLL_INTERVAL_MS = 5000;
const BUCKET_MS = 15_000; // 15s buckets for the throughput chart
const THROUGHPUT_WINDOW = 500; // most recent N events -- a trend window, not a total

function causeLabel(detail: string | null): string {
  if (detail === "buffer-eviction") return "Buffer eviction";
  if (detail === "upstream-drop") return "Upstream drop";
  return detail ?? "Unlabeled";
}

function bucketEvents(events: DeliveryLogRow[]): AreaPoint[] {
  if (events.length === 0) return [];
  const times = events.map((r) => new Date(r.occurred_at).getTime()).sort((a, b) => a - b);
  const first = Math.floor(times[0]! / BUCKET_MS) * BUCKET_MS;
  const last = Math.ceil(times[times.length - 1]! / BUCKET_MS) * BUCKET_MS;
  const buckets = new Map<number, number>();
  for (let t = first; t <= last; t += BUCKET_MS) buckets.set(t, 0);
  for (const t of times) {
    const bucket = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const points = [...buckets.entries()].map(([t, value]) => ({ t, value }));
  // Drop the last bucket if it's a partial window (the fetch cutoff usually
  // lands mid-bucket) -- otherwise every refresh shows a misleading cliff
  // down to a low number that isn't a real throughput drop, just an
  // incomplete final bucket.
  return points.length > 1 ? points.slice(0, -1) : points;
}

export function GapAudit({ settings }: { settings: GatewaySettings }) {
  const [counts, setCounts] = useState<DeliveryLogCounts>({ event: 0, gap: 0, reconnect: 0 });
  const [gapRows, setGapRows] = useState<DeliveryLogRow[]>([]);
  const [recentEvents, setRecentEvents] = useState<DeliveryLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const feedKey = buildFeedKey(settings.originUrl, settings.category);

  const refresh = useCallback(() => {
    Promise.all([
      fetchDeliveryLogCounts(settings, feedKey),
      fetchDeliveryLog(settings, { feedKey, entryType: "gap", limit: 200 }),
      fetchDeliveryLog(settings, { feedKey, entryType: "event", limit: THROUGHPUT_WINDOW }),
    ])
      .then(([c, gaps, events]) => {
        setCounts(c);
        setGapRows(gaps);
        setRecentEvents(events);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [settings, feedKey]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const gapsByCause = {
    "buffer-eviction": gapRows.filter((g) => g.detail === "buffer-eviction").length,
    "upstream-drop": gapRows.filter((g) => g.detail === "upstream-drop").length,
  };
  const throughput = bucketEvents(recentEvents);
  const totalEntries = counts.event + counts.gap + counts.reconnect;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Gap Audit</h1>
        <p className="mt-1 text-sm text-muted">
          Feed <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">{feedKey}</code> · polling every{" "}
          {POLL_INTERVAL_MS / 1000}s
        </p>
      </div>

      {error && (
        <div className="rounded-card border px-4 py-3 text-sm" style={{ borderColor: "var(--color-status-critical)" }}>
          {error}
        </div>
      )}

      {/* KPI row -- true totals from /counts, independent of any row window */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Events logged" value={counts.event.toLocaleString()} hint="All-time total for this feed" />
        <StatTile label="Gap markers" value={counts.gap.toLocaleString()} accent={counts.gap > 0} hint="All-time total" />
        <StatTile label="Reconnects" value={counts.reconnect.toLocaleString()} hint="All-time total" />
        <StatTile
          label="Gap rate"
          value={`${totalEntries > 0 ? ((counts.gap / totalEntries) * 100).toFixed(2) : "0.00"}%`}
          hint="Gaps as a share of all logged entries"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
        {/* Gap causes -- two stat tiles, not a 2-slice pie */}
        <div className="rounded-card border border-rule p-4">
          <h2 className="text-sm font-medium text-ink">Gap causes</h2>
          <p className="mt-0.5 text-xs text-muted">Two known causes, tracked separately since a pie can't do two slices honestly.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <StatTile label="Buffer eviction" value={gapsByCause["buffer-eviction"]} hint="Client behind the retention window" />
            <StatTile label="Upstream drop" value={gapsByCause["upstream-drop"]} hint="Origin connection ended unexpectedly" />
          </div>
        </div>

        {/* Entry-type mix -- legitimate donut, 3 categories, true totals */}
        <div className="rounded-card border border-rule p-4">
          <h2 className="text-sm font-medium text-ink">Delivery-log mix</h2>
          <p className="mt-0.5 text-xs text-muted">Every entry ever logged for this feed, by type.</p>
          <div className="mt-3">
            <Donut
              slices={[
                { label: "Events", value: counts.event, color: "var(--color-chart-1)" },
                { label: "Gaps", value: counts.gap, color: "var(--color-chart-2)" },
                { label: "Reconnects", value: counts.reconnect, color: "var(--color-chart-3)" },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Throughput over time -- a recent-trend window, explicitly labeled as such */}
      <div className="rounded-card border border-rule p-4">
        <h2 className="text-sm font-medium text-ink">Event throughput</h2>
        <p className="mt-0.5 text-xs text-muted">
          Delivered events per 15s bucket, most recent {THROUGHPUT_WINDOW} events, a trend window, not the all-time total.
        </p>
        <div className="mt-3">
          <AreaChart
            points={throughput}
            label="events"
            formatX={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          />
        </div>
      </div>

      {/* Gap log -- entryType-filtered, so it isn't starved by event volume */}
      <div className="rounded-card border border-rule">
        <div className="border-b border-rule px-4 py-3">
          <h2 className="text-sm font-medium text-ink">Gap log</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">ID</th>
                <th className="px-4 py-2 font-medium">Seq / oldest available</th>
                <th className="px-4 py-2 font-medium">Occurred at</th>
                <th className="px-4 py-2 font-medium">Cause</th>
              </tr>
            </thead>
            <tbody>
              {gapRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    No gap markers recorded yet for this feed.
                  </td>
                </tr>
              )}
              {gapRows.map((r) => (
                <tr key={r.id} className="border-b border-rule last:border-b-0">
                  <td className="px-4 py-2 font-mono tabular text-muted">{r.id}</td>
                  <td className="px-4 py-2 font-mono tabular text-ink-2">{r.seq ?? "—"}</td>
                  <td className="px-4 py-2 font-mono tabular text-ink-2">{r.occurred_at}</td>
                  <td className="px-4 py-2 text-ink-2">{causeLabel(r.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
