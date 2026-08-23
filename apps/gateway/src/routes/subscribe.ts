import { type AuthResult, checkScope, extractToken, resolveCredential } from "../lib/agentAuth";
import { buildFeedKey } from "../lib/feedKey";

export { buildFeedKey };
export { checkScope, extractToken, resolveCredential } from "../lib/agentAuth";
export type { AuthResult } from "../lib/agentAuth";

// Resolves whichever credential the request is carrying (a scoped, named
// agent credential, or the original shared secret) -- see lib/agentAuth.ts
// for the full reasoning. Scope restrictions (which origin, which
// category, subscribe vs. relay) are checked separately by the caller via
// checkScope(), once the actual requested target is known.
export async function isAuthorized(request: Request, env: Env): Promise<AuthResult> {
  return resolveCredential(env, extractToken(request));
}

// Real Workers Rate Limiting binding (see wrangler.toml), not a hand-rolled
// counter. `routeKey` keeps /subscribe and /relay in independent buckets on
// one shared binding. The timeout+fail-open below exists because this
// binding runs in "remote" mode under local `wrangler dev` and hangs
// (doesn't error) without real Cloudflare auth -- same fail-open principle
// as ContextIndex's cache lookup, applied here so an infra hiccup degrades
// availability, not blocks real requests.
const RATE_LIMIT_TIMEOUT_MS = 500;

export async function isRateLimited(request: Request, env: Env, routeKey: "subscribe" | "relay"): Promise<boolean> {
  // CF-Connecting-IP is the real per-client signal; absent in local dev, so
  // this falls back to the shared token -- same trust boundary as
  // SUBSCRIBE_TOKEN itself, not a weaker one.
  const clientKey = request.headers.get("CF-Connecting-IP") ?? env.SUBSCRIBE_TOKEN;
  try {
    const outcome = await Promise.race([
      env.RATE_LIMITER.limit({ key: `${routeKey}:${clientKey}` }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rate limiter timed out")), RATE_LIMIT_TIMEOUT_MS)),
    ]);
    return !outcome.success;
  } catch {
    return false;
  }
}

// `originUrl` is attacker-controlled input from any caller holding the
// (weak, shared) token above -- passing it unchecked into the Worker's own
// `fetch()` inside FeedRelay would be a real SSRF vector: arbitrary outbound
// requests from Cloudflare's network to wherever a caller points it, and
// since feedKey (and therefore a fresh Durable Object) derives from this
// same input, also an unbounded-DO-creation vector. Unlike the auth
// baseline, this is not a documented-and-deferred gap -- it's checked here.
export function isAllowedOrigin(originUrl: string, allowedHostsCsv: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(originUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const allowed = allowedHostsCsv
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return allowed.includes(parsed.host);
}

export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const auth = await isAuthorized(request, env);
  if (!auth.authorized) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (await isRateLimited(request, env, "subscribe")) {
    return new Response("Too many subscribe attempts, slow down", { status: 429 });
  }

  const url = new URL(request.url);
  const originUrl = url.searchParams.get("originUrl");
  const category = url.searchParams.get("category") ?? "default";
  if (!originUrl) {
    return new Response("Missing originUrl query param", { status: 400 });
  }
  if (!isAllowedOrigin(originUrl, env.ALLOWED_ORIGIN_HOSTS)) {
    return new Response("originUrl is not on the allowed origin list", { status: 403 });
  }
  // Distinct from isAllowedOrigin above: that's the account-wide SSRF
  // boundary (which hosts exist to talk to at all), this is a per-credential
  // restriction (which of those hosts THIS caller is allowed to reach) --
  // a legacy shared-token caller has no scope restriction and always
  // passes this check, exactly today's behavior.
  if (!checkScope(auth, "subscribe", originUrl, category)) {
    return new Response("This credential is not scoped to that origin/category", { status: 403 });
  }

  const feedKey = buildFeedKey(originUrl, category);
  const id = env.FEED_RELAY.idFromName(feedKey);
  const stub = env.FEED_RELAY.get(id);

  return stub.fetch(request);
}
