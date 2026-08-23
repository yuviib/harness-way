// origin-simulator is itself another Worker on this account's workers.dev
// zone -- a plain fetch() between two workers.dev Workers is rejected with
// Cloudflare error 1042 (loop prevention), confirmed live. Routed through
// the ORIGIN_SIMULATOR service binding instead, only for that one host;
// every other allowlisted origin still goes through plain fetch().
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
  return fetch(originUrl, init);
}
