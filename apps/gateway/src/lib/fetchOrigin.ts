// origin-simulator (and, since it was added, fraud-ops-origin -- a separate
// consumer's demo, deployed on this same account) are themselves other
// Workers on this account's workers.dev zone -- a plain fetch() between two
// workers.dev Workers is rejected with Cloudflare error 1042 (loop
// prevention), confirmed live. Each is routed through its own service
// binding instead, only for that one known host; every other allowlisted
// origin (a real external MCP server, never itself another Worker on this
// zone in practice) still goes through the unchanged, general-purpose
// fetch() path.
export function fetchOrigin(env: Env, originUrl: string, init: RequestInit): Promise<Response> {
  let hostname: string;
  try {
    hostname = new URL(originUrl).hostname;
  } catch {
    hostname = "";
  }
  if (hostname === env.ORIGIN_SIMULATOR_HOST) {
    return env.ORIGIN_SIMULATOR.fetch(originUrl, init);
  }
  if (hostname === env.FRAUD_OPS_ORIGIN_HOST) {
    return env.FRAUD_OPS_ORIGIN.fetch(originUrl, init);
  }
  return fetch(originUrl, init);
}
