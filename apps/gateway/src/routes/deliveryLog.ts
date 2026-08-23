// Read-only API for the dashboard (apps/dashboard) to query the delivery
// log D1 table -- everything a FeedRelay instance has ever logged via
// metricsWriter.ts (events, gaps of both causes, reconnects). Kept as its
// own route rather than folded into subscribe.ts: this is a plain HTTP
// GET returning JSON, not a WebSocket upgrade, and has a genuinely
// different concern (querying already-durable history vs. routing a live
// subscription to a DO).
//
// Same Bearer-token auth as /subscribe, reusing isAuthorized rather than
// leaving this one route open -- both share the same "known gap, noted not
// hidden" dev-only token model (see subscribe.ts), and there's no reason
// for this endpoint to have a weaker story than the rest of the gateway.
//
// CORS: the dashboard is a separate origin (Pages in production, a Vite
// dev server locally) making a cross-origin fetch() with an Authorization
// header, which browsers preflight with OPTIONS -- unlike the WebSocket
// upgrade on /subscribe, which browsers don't subject to CORS at all.
// Access-Control-Allow-Origin: "*" is a dev-only simplification, the same
// class of documented gap as SUBSCRIBE_TOKEN itself: a real deployment
// should scope this to the dashboard's actual origin, not "*".

import { isAuthorized } from "./subscribe";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export function handleDeliveryLogPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function handleDeliveryLog(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const feedKey = url.searchParams.get("feedKey");
  const entryType = url.searchParams.get("entryType"); // "event" | "gap" | "reconnect", optional filter
  const requestedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  // Clamped, not trusted from the query string directly -- an unbounded
  // LIMIT here would be a real (if minor) way for a caller to force a
  // needlessly expensive D1 scan.
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (feedKey) {
    conditions.push("feed_key = ?");
    binds.push(feedKey);
  }
  if (entryType) {
    conditions.push("entry_type = ?");
    binds.push(entryType);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT id, feed_key, entry_type, seq, occurred_at, detail FROM delivery_log ${where} ORDER BY id DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await env.DB.prepare(query)
    .bind(...binds)
    .all();

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

// True per-type totals via COUNT(*), not "however many rows happened to be
// in a LIMITed window" -- found necessary by testing the actual dashboard,
// not designed up front: a feed running for hours logs an "event" row
// roughly every second, which silently pushes rare "gap"/"reconnect" rows
// (sometimes just 2 total) entirely outside any reasonably-sized LIMIT
// window. handleDeliveryLog's own limit is right for "show me the recent
// gap log rows"; it is NOT right for "how many gaps have there EVER been" --
// those are two different questions needing two different queries.
export async function handleDeliveryLogCounts(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const feedKey = url.searchParams.get("feedKey");

  const query = feedKey
    ? "SELECT entry_type, COUNT(*) as n FROM delivery_log WHERE feed_key = ? GROUP BY entry_type"
    : "SELECT entry_type, COUNT(*) as n FROM delivery_log GROUP BY entry_type";
  const { results } = await env.DB.prepare(query)
    .bind(...(feedKey ? [feedKey] : []))
    .all<{ entry_type: string; n: number }>();

  const counts = { event: 0, gap: 0, reconnect: 0 };
  for (const row of results) {
    if (row.entry_type in counts) counts[row.entry_type as keyof typeof counts] = row.n;
  }

  return new Response(JSON.stringify(counts), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}
