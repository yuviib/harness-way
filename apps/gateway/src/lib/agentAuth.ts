// Per-agent scoped credentials, layered on top of (not replacing) the
// original shared-token model. A credential issued here can be restricted
// to one origin host, one category, and one or both of subscribe/relay --
// the original shared SUBSCRIBE_TOKEN still works exactly as before,
// unattributed and unrestricted, so nothing that already depends on it
// (the dashboard, the existing apps/agents scripts) breaks the moment
// this exists. New callers that need real, individually revocable
// identity use a scoped credential instead; nothing forces the migration.
export interface AuthResult {
  authorized: boolean;
  agentId: number | null;
  agentName: string;
  scopeOriginHost: string | null;
  scopeCategory: string | null;
  canSubscribe: boolean;
  canRelay: boolean;
}

const UNAUTHORIZED: AuthResult = {
  authorized: false,
  agentId: null,
  agentName: "",
  scopeOriginHost: null,
  scopeCategory: null,
  canSubscribe: false,
  canRelay: false,
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Extracted once, shared by both the scoped-credential lookup and the
// legacy fallback below -- same token extraction subscribe.ts's own
// isAuthorized already used (Bearer header, or a query-param fallback
// specifically because browsers' native WebSocket constructor has no API
// to set an Authorization header on the handshake request).
export function extractToken(request: Request): string {
  const auth = request.headers.get("Authorization");
  const tokenParam = new URL(request.url).searchParams.get("token");
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : (tokenParam ?? "");
}

interface CredentialRow {
  id: number;
  agent_name: string;
  scope_origin_host: string | null;
  scope_category: string | null;
  can_subscribe: number;
  can_relay: number;
}

// Resolves a provided token to whichever credential it matches, scoped
// first, the original shared secret second. Fails closed all the way
// through: a missing token, an unreadable D1, and a non-matching token all
// converge on { authorized: false }, never a bypass.
export async function resolveCredential(env: Env, providedToken: string): Promise<AuthResult> {
  if (!providedToken) return UNAUTHORIZED;

  // A real, indexed exact-match lookup on an already-hashed value, not a
  // byte-by-byte secret comparison -- the timing-side-channel concern the
  // legacy check below still has to guard against (comparing raw secret
  // bytes in application code) doesn't apply the same way to a SQLite
  // index lookup keyed on a SHA-256 digest: there's no meaningful
  // early-exit signal for an attacker to observe from a row lookup the
  // way there is from a naive string compare.
  try {
    const tokenHash = await sha256Hex(providedToken);
    const row = await env.DB.prepare(
      "SELECT id, agent_name, scope_origin_host, scope_category, can_subscribe, can_relay FROM agent_credentials WHERE token_hash = ? AND revoked_at IS NULL",
    )
      .bind(tokenHash)
      .first<CredentialRow>();
    if (row) {
      return {
        authorized: true,
        agentId: row.id,
        agentName: row.agent_name,
        scopeOriginHost: row.scope_origin_host,
        scopeCategory: row.scope_category,
        canSubscribe: row.can_subscribe === 1,
        canRelay: row.can_relay === 1,
      };
    }
  } catch {
    // D1 unreachable or the table isn't there yet -- fall through to the
    // legacy check rather than hard-failing the whole auth path, same
    // fail-open-on-infra-hiccup principle already applied to the rate
    // limiter and the cache index elsewhere in this codebase. This is
    // fail-open to "check the OTHER real credential," never to "authorize
    // anyone" -- a valid SUBSCRIBE_TOKEN match is still required below.
  }

  // Legacy fallback: the original shared-token model, unattributed
  // ("shared-token" rather than a real agent name) and unrestricted,
  // exactly today's existing behavior. Fail closed on a missing token:
  // `TextEncoder.encode(undefined)` hashes identically to `encode("")`,
  // so without this guard an unset SUBSCRIBE_TOKEN would silently
  // authorize zero credentials rather than reject them (found by an
  // earlier security review, verified by testing).
  if (!env.SUBSCRIBE_TOKEN) return UNAUTHORIZED;
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(providedToken)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SUBSCRIBE_TOKEN)),
  ]);
  if (!crypto.subtle.timingSafeEqual(providedDigest, expectedDigest)) {
    return UNAUTHORIZED;
  }
  return { authorized: true, agentId: null, agentName: "shared-token", scopeOriginHost: null, scopeCategory: null, canSubscribe: true, canRelay: true };
}

// Applied AFTER resolveCredential succeeds, once the actual requested
// originUrl (and, for /subscribe, category) is known -- for /relay that's
// only available once the JSON body is parsed, later than auth itself
// runs, so this stays a separate, explicit step rather than folded into
// resolveCredential.
export function checkScope(auth: AuthResult, route: "subscribe" | "relay", originUrl: string, category: string | null): boolean {
  if (!auth.authorized) return false;
  if (route === "subscribe" && !auth.canSubscribe) return false;
  if (route === "relay" && !auth.canRelay) return false;

  if (auth.scopeOriginHost !== null) {
    let hostname: string;
    try {
      hostname = new URL(originUrl).hostname;
    } catch {
      return false;
    }
    if (hostname !== auth.scopeOriginHost) return false;
  }

  // Cache `scope` on /relay is a different concept (caller-chosen
  // partitioning key, see relay.ts's own module comment) from a
  // credential's scope_category restriction, which only applies to
  // /subscribe's feed category. Not checked for /relay at all, not an
  // oversight, there is nothing on that route for it to mean.
  if (route === "subscribe" && auth.scopeCategory !== null && category !== auth.scopeCategory) {
    return false;
  }

  return true;
}
