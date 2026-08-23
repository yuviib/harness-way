// API for the demo agents (apps/agents) to report what they did, and for
// the dashboard's Agents view to read that history back. Same shape as
// deliveryLog.ts on purpose (auth, CORS, limit-clamping) -- this is the
// same kind of route (append-only log, read by the dashboard) with a
// different subject.
//
// Unlike delivery_log, which FeedRelay itself writes from inside the
// gateway, agent_log is written by external processes (the agents) over a
// real HTTP call -- so this route needs a POST handler, not just GET.

import { isAuthorized } from "./subscribe";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const VALID_ACTION_TYPES = new Set(["resync", "reconnect_verified", "order_check", "summary", "error"]);

interface AgentLogPost {
  feedKey?: string;
  agentName?: string;
  agentRole?: string;
  actionType?: string;
  seq?: number | null;
  detail?: string | null;
}

export function handleAgentLogPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function handleAgentLogPost(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  let body: AgentLogPost;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }

  const { feedKey, agentName, agentRole, actionType, seq, detail } = body;
  if (!feedKey || !agentName || !agentRole || !actionType) {
    return new Response("feedKey, agentName, agentRole, and actionType are required", {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
  if (!VALID_ACTION_TYPES.has(actionType)) {
    return new Response(`actionType must be one of: ${[...VALID_ACTION_TYPES].join(", ")}`, {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  await env.DB.prepare(
    "INSERT INTO agent_log (feed_key, agent_name, agent_role, action_type, seq, detail, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(feedKey, agentName, agentRole, actionType, seq ?? null, detail ?? null, new Date().toISOString())
    .run();

  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// True per-action-type totals via COUNT(*), not however many rows a
// row-window GET happens to return -- the exact same trap already caught
// and fixed for delivery_log (see deliveryLog.ts's own comment on this),
// applied here from the start rather than rediscovered the same way.
export async function handleAgentLogCounts(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const feedKey = url.searchParams.get("feedKey");

  const query = feedKey
    ? "SELECT action_type, COUNT(*) as n FROM agent_log WHERE feed_key = ? GROUP BY action_type"
    : "SELECT action_type, COUNT(*) as n FROM agent_log GROUP BY action_type";
  const { results } = await env.DB.prepare(query)
    .bind(...(feedKey ? [feedKey] : []))
    .all<{ action_type: string; n: number }>();

  const counts: Record<string, number> = { resync: 0, reconnect_verified: 0, order_check: 0, summary: 0, error: 0 };
  for (const row of results) {
    if (row.action_type in counts) counts[row.action_type] = row.n;
  }

  return new Response(JSON.stringify(counts), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleAgentLogGet(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const feedKey = url.searchParams.get("feedKey");
  const requestedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_LIMIT));

  const where = feedKey ? "WHERE feed_key = ?" : "";
  const query = `SELECT id, feed_key, agent_name, agent_role, action_type, seq, detail, occurred_at FROM agent_log ${where} ORDER BY id DESC LIMIT ?`;
  const binds = feedKey ? [feedKey, limit] : [limit];

  const { results } = await env.DB.prepare(query)
    .bind(...binds)
    .all();

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}
