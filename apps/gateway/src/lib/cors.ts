// Shared CORS origin-allowlisting for the log/audit read-write API routes.
// These already require a real Authorization header, never cookies, so a
// wildcard Access-Control-Allow-Origin doesn't open the classic
// credentialed-CORS hole. It does mean that if a valid token were ever
// obtained by attacker-controlled JS through some OTHER vector, that page
// could read these responses back cross-origin. Reflecting the request's
// own Origin only when it's on this allowlist -- the real, known
// browser-based consumers of these routes -- closes that off entirely for
// every other origin, at zero cost to any legitimate caller: there are no
// other browser-based consumers of these routes today.
const ALLOWED_CORS_ORIGINS = new Set([
  "https://mcp-relay-harness-dashboard.ybains-dev.workers.dev",
  "https://fraud-ops-console.ybains-dev.workers.dev",
  // Both apps' local dev servers default to the same Vite port (neither
  // pins one), so both are listed rather than picked arbitrarily.
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export function corsHeaders(request: Request, methods: string, headers: string): Record<string, string> {
  const origin = request.headers.get("Origin");
  const result: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": headers,
    // The response now genuinely varies by request Origin (present or
    // absent depending on the allowlist), not a constant -- correct
    // caching hygiene even though none of these responses are cached
    // today.
    Vary: "Origin",
  };
  if (origin && ALLOWED_CORS_ORIGINS.has(origin)) {
    result["Access-Control-Allow-Origin"] = origin;
  }
  return result;
}
