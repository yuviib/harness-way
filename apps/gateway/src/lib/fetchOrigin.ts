// origin-simulator (and, since it was added, fraud-ops-origin -- a separate
// consumer's demo, deployed on this same account) are themselves other
// Workers on this account's workers.dev zone -- a plain fetch() between two
// workers.dev Workers is rejected with Cloudflare error 1042 (loop
// prevention), confirmed live. Each is routed through its own service
// binding instead, only for that one known host; every other allowlisted
// origin (a real external MCP server, never itself another Worker on this
// zone in practice) still goes through the unchanged, general-purpose
// fetch() path.
//
// The *_HOST vars are set at the top level (so local dev's ALLOWED_ORIGIN_HOSTS
// check still works against them), but their matching service bindings only
// exist under [env.production.services] -- named environments in this
// wrangler version don't inherit `services` any more than they inherit
// `vars`/`durable_objects`/`d1_databases` (see wrangler.toml). So a hostname
// can legitimately match while its binding is undefined: local dev running
// against a real deployed origin's public hostname, confirmed live (a bare
// `env.ORIGIN_SIMULATOR.fetch()` there throws `Cannot read properties of
// undefined`, not a type-checker false positive). Falling through to plain
// fetch() in that case is also the CORRECT behavior, not just a safe
// fallback: error 1042 is specifically a same-zone Worker-to-Worker
// restriction inside Cloudflare's own network, and local `wrangler dev`
// calling out to a real deployed Worker's public HTTPS endpoint is an
// ordinary external request, not a same-zone Worker call, so it was never
// going to hit 1042 in the first place.
export function fetchOrigin(env: Env, originUrl: string, init: RequestInit): Promise<Response> {
  let hostname: string;
  try {
    hostname = new URL(originUrl).hostname;
  } catch {
    hostname = "";
  }
  if (hostname === env.ORIGIN_SIMULATOR_HOST && env.ORIGIN_SIMULATOR) {
    return env.ORIGIN_SIMULATOR.fetch(originUrl, init);
  }
  if (hostname === env.FRAUD_OPS_ORIGIN_HOST && env.FRAUD_OPS_ORIGIN) {
    return env.FRAUD_OPS_ORIGIN.fetch(originUrl, init);
  }
  return fetch(originUrl, init);
}
