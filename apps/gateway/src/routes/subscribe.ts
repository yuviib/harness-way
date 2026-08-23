import { buildFeedKey } from "../lib/feedKey";

export { buildFeedKey };

// Deliberately minimal validation baseline for v1 (see wrangler.toml for why):
// proves the caller holds a shared secret, nothing more. Real per-agent
// identity/authorization is explicitly out of scope and documented as such,
// not silently absent. The comparison itself, though, is a real defense-in-
// depth fix worth making regardless of the token model's other limits: a
// raw `===` on the token short-circuits on the first differing byte, a
// known (if narrow) timing side-channel. Hashing both sides to a fixed-
// length digest before comparing removes both that and any length-based
// signal on the raw secret.
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  // Fail closed on a missing token: `TextEncoder.encode(undefined)` hashes
  // identically to `encode("")`, so without this guard, an unset
  // SUBSCRIBE_TOKEN (e.g. `wrangler secret put` run against the wrong
  // environment) would silently authorize any caller sending zero
  // credentials rather than reject them. Found by security review, verified
  // by testing.
  if (!env.SUBSCRIBE_TOKEN) {
    return false;
  }
  const auth = request.headers.get("Authorization");
  // Query-param fallback exists for exactly one real reason: browsers'
  // native WebSocket constructor cannot set an Authorization header on the
  // handshake request at all (no API for it) -- the dashboard's
  // LiveFanoutView, which connects directly from the browser, has no other
  // way to authenticate a WS /subscribe call. This widens the SAME
  // dev-only shared-secret model (see the module comment above) to a
  // second transport, not a separate or weaker one -- it does not apply to
  // anything beyond what a valid bearer token already grants.
  const tokenParam = new URL(request.url).searchParams.get("token");
  const provided = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : (tokenParam ?? "");
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.SUBSCRIBE_TOKEN)),
  ]);
  const a = new Uint8Array(providedDigest);
  const b = new Uint8Array(expectedDigest);
  // Both are always 32 bytes (fixed SHA-256 output length), so there is no
  // length-based branch here regardless of the provided token's length --
  // the non-null assertions are safe specifically because of that fixed,
  // known length, not a general assumption about indexed access.
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
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
  if (!(await isAuthorized(request, env))) {
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

  const feedKey = buildFeedKey(originUrl, category);
  const id = env.FEED_RELAY.idFromName(feedKey);
  const stub = env.FEED_RELAY.get(id);

  return stub.fetch(request);
}
