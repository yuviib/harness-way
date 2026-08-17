// Delivery log: every delivered event, feed-level gap, and successful
// reconnect after an outage, logged durably and queryably (per PLAN.md).
// Writes go through D1's Sessions API (`withSession`) even though the
// value of bookmark-based sequential consistency is fully realized once
// the Week 4 dashboard actually reads this data -- establishing the
// correct write pattern now costs nothing and avoids a later migration.
//
// Callers are expected to fire this via `ctx.waitUntil(...)`, not await it
// inline in the live-delivery path (see FeedRelay): a D1 write is a genuine
// cross-service network call, and this log is an observability concern,
// not a correctness one -- replay/gap-marker correctness never depends on
// this write succeeding, so blocking live delivery on it would trade real
// user-facing latency for no real correctness gain.
//
// Cost-aware by design, not by accident: D1's free tier is 100,000 rows
// written/day (verified against Cloudflare's current published pricing,
// not assumed). One row per delivery-log entry -- keyed to actual upstream
// events/outages/reconnects, NOT to how many downstream sockets a given
// event fanned out to -- keeps write volume proportional to real feed
// activity, not subscriber count. Against the origin-simulator's own
// ~1-notification-per-1.2s cadence, this is nowhere near the limit for
// realistic demo/test usage; a real high-throughput origin would need
// batching here, which is a genuinely different scaling regime, not
// something to silently assume away.

export type DeliveryLogEntryType = "event" | "gap" | "reconnect";

export interface DeliveryLogEntry {
  feedKey: string;
  entryType: DeliveryLogEntryType;
  seq: number | null;
  occurredAt: string;
  detail?: string;
}

export async function logDelivery(db: D1Database, entry: DeliveryLogEntry): Promise<void> {
  const session = db.withSession("first-primary");
  await session
    .prepare("INSERT INTO delivery_log (feed_key, entry_type, seq, occurred_at, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(entry.feedKey, entry.entryType, entry.seq, entry.occurredAt, entry.detail ?? null)
    .run();
}
