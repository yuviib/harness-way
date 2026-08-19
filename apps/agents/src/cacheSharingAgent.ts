// A real demonstration of Capability 2 (the shared, content-addressed
// discrete-call cache): two independent callers -- modeling two separate
// agent processes, not two requests from the same one -- ask the relay's
// POST /relay endpoint the identical question. The SECOND caller gets an
// instant response served from the FIRST caller's cached result, without
// the origin ever being asked again. That's the literal claim Capability 2
// makes ("shared across every caller instead of held locally per client"),
// proven here against the real gateway and real origin-simulator, not
// asserted from a unit test's mocked-out I/O.
//
// Unlike this app's other four agents, this one is NOT a long-lived
// WebSocket subscriber -- POST /relay is a discrete request/response call,
// so there's no persistent connection to hold open. Run standalone via
// `npm run demo:cache` (see package.json), separate from `npm run dev`'s
// four subscription agents.

import { loadConfig, type Config } from "./shared.ts";

const TOOL = "resource_lookup";

interface RelayResult {
  status: number;
  cacheHeader: string | null;
  latencyMs: number;
  body: unknown;
}

async function callRelay(config: Config, scope: string, resourceId: string): Promise<RelayResult> {
  const start = Date.now();
  const res = await fetch(`${config.gatewayHttpBase}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({
      originUrl: config.originUrl,
      scope,
      tool: TOOL,
      arguments: { resourceId },
    }),
  });
  const latencyMs = Date.now() - start;
  const body = await res.json();
  return { status: res.status, cacheHeader: res.headers.get("x-cache"), latencyMs, body };
}

function log(caller: string, label: string, result: RelayResult): void {
  console.log(
    `[${caller}] ${label}: HTTP ${result.status}, x-cache=${result.cacheHeader ?? "?"}, ${result.latencyMs}ms\n` +
      `           ${JSON.stringify(result.body)}`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`Cache-sharing demo against ${config.gatewayHttpBase}/relay (origin ${config.originUrl})\n`);

  // A shared workspace two independent callers both participate in --
  // "caller-agent-1" and "caller-agent-2" model two separate processes
  // (a different machine, a different agent framework, anything) that
  // simply happen to be configured with the same scope string, the same
  // caller-supplied identity boundary routes/relay.ts documents.
  const sharedScope = `demo-shared-${Date.now()}`;
  const resourceId = "workspace-42";

  console.log("--- Step 1: caller-agent-1 asks first (expect a cache MISS: nobody has asked this yet) ---");
  const first = await callRelay(config, sharedScope, resourceId);
  log("caller-agent-1", "first request", first);
  if (first.cacheHeader !== "MISS") {
    throw new Error(`expected the first request in a fresh scope to MISS, got x-cache=${first.cacheHeader}`);
  }

  console.log("\n--- Step 2: caller-agent-2, a DIFFERENT caller, asks the identical question (expect a cache HIT) ---");
  const second = await callRelay(config, sharedScope, resourceId);
  log("caller-agent-2", "identical request", second);
  if (second.cacheHeader !== "HIT") {
    throw new Error(`expected caller-agent-2's identical request to HIT the cache caller-agent-1 populated, got x-cache=${second.cacheHeader}`);
  }
  if (JSON.stringify(second.body) !== JSON.stringify(first.body)) {
    throw new Error("cache hit returned different content than the original miss -- byte-identical serving is broken");
  }
  console.log(
    `\n✓ caller-agent-2 got byte-identical content in ${second.latencyMs}ms vs caller-agent-1's real ${first.latencyMs}ms ` +
      `-- served from cache, the origin was never asked a second time.`,
  );

  console.log("\n--- Step 3: a third caller in an UNRELATED scope asks the same question (expect MISS -- scope isolation) ---");
  const isolatedScope = `demo-isolated-${Date.now()}`;
  const third = await callRelay(config, isolatedScope, resourceId);
  log("caller-agent-3 (different scope)", "identical request, different scope", third);
  if (third.cacheHeader !== "MISS") {
    throw new Error(`expected a different scope's identical request to MISS (scope isolation), got x-cache=${third.cacheHeader}`);
  }
  console.log("\n✓ a different scope never saw the shared scope's cached entry -- scope isolation holds.");

  console.log(`\nAll assertions passed. See the dashboard's Cache Metrics tab (scope "${sharedScope}") for these numbers live.`);
}

main().catch((err: unknown) => {
  console.error("cache-sharing demo failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
