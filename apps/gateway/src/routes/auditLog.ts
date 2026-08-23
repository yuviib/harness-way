// HTTP surface for the tamper-evident AuditLog Durable Object (see
// do/AuditLog.ts for the actual hash-chain). External agent processes
// (apps/agents, Fraud Ops's LangGraph agent) can't call a DO's RPC methods
// directly, they're not running inside this Worker, so this route exists
// specifically to bridge a real HTTP call to the one real RPC call
// underneath it, same reason agentLog.ts exists as a bridge to agent_log
// even though a plain Worker-internal caller wouldn't need one.
//
// agentId/agentName are NEVER taken from the request body, only from the
// caller's own resolved credential (see lib/agentAuth.ts). An audit log
// that let a caller claim to be someone else would be worthless as an
// audit log -- the one thing it has to guarantee is that "who did this"
// is exactly who authenticated, not who the request merely says did.
import { isAuthorized } from "./subscribe";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// A single global instance -- see AuditLog.ts's own comment: sharding a
// hash chain would only ever let "prove nothing was altered" apply to one
// shard at a time, a weaker and more confusing claim than covering the
// whole log.
//
// "global-v3", not "global": bumped twice now, same reasoning already
// applied to the relay's own feed buffer (see fraud-ops/console's
// relayClient.ts) -- heavy manual testing of the triage agent against a
// real, rate-limited free-tier Gemini key left this log dominated by
// quota-exhaustion error entries, real and honestly logged, but not what
// a first-time visitor should see as the demo's own opening state. A
// fresh instance name routes to a brand new, empty chain going forward.
function auditLogStub(env: Env) {
  const id = env.AUDIT_LOG.idFromName("global-v3");
  return env.AUDIT_LOG.get(id);
}

export function handleAuditLogPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface AuditLogPostBody {
  action?: string;
  detail?: string;
}

export async function handleAuditLogPost(request: Request, env: Env): Promise<Response> {
  const auth = await isAuthorized(request, env);
  if (!auth.authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  let body: AuditLogPostBody;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400, headers: CORS_HEADERS });
  }
  if (!body.action || typeof body.action !== "string") {
    return new Response("action (string) is required", { status: 400, headers: CORS_HEADERS });
  }
  if (typeof body.detail !== "string") {
    return new Response("detail (string) is required", { status: 400, headers: CORS_HEADERS });
  }

  const result = await auditLogStub(env).append({ agentId: auth.agentId, agentName: auth.agentName, action: body.action, detail: body.detail });
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

export async function handleAuditLogGet(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Math.min(500, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));

  const entries = await auditLogStub(env).list(limit);
  return new Response(JSON.stringify(entries), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

export async function handleAuditLogVerify(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env)).authorized) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }
  const result = await auditLogStub(env).verify();
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}
