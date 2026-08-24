# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MCP Relay Harness: an edge-native relay for MCP's `subscriptions/listen` notification streams, built on Cloudflare Workers and Durable Objects. It multiplexes one real upstream connection per `(originUrl, category)` feed across N downstream subscribers, keeps a bounded replay buffer so reconnecting clients never silently miss events, and adds a content-addressed cache for discrete `tools/call` requests. Full narrative and rationale live in `README.md` (start there for "what and why") and `docs/ARCHITECTURE.md` (the "how, at the level of what actually happens on each request"). `docs/TECHNICAL_SPEC.md` and `docs/TECHNICAL_OVERVIEW.md` go deeper still. Read the relevant doc section before touching a subsystem you don't already understand — this repo documents *why* a mechanism is shaped the way it is (real bugs found, real platform constraints hit), and that context changes what a "fix" should look like.

## Repo layout

```
apps/gateway/            Worker + FeedRelay/ContextIndex/AuditLog Durable Objects — the relay itself
apps/origin-simulator/   synthetic MCP origin for dev and chaos testing
apps/agents/             four real WebSocket agent consumers, plus the cache-sharing demo
apps/dashboard/          React + Tailwind operator dashboard
crates/mcp-relay-engine/ Rust -> WASM: SSE framing, replay ring buffer, BLAKE3 hashing
eval/                    Python chaos-testing harness and recorded results
docs/                    architecture notes and the master technical spec
design.md                locked design system for apps/dashboard — read before touching dashboard UI
PLAN.md                  the original scoping document this was built against
```

## Commands

### Local dev (four terminals, in order)

```bash
# build the WASM SSE parser the gateway depends on — rerun after any change to crates/mcp-relay-engine
cd apps/gateway && npm run build:wasm

# terminal 1: synthetic upstream feed
cd apps/origin-simulator && npm run dev

# terminal 2: the relay (applies D1 migrations locally on first run)
cd apps/gateway && npm run dev

# terminal 3: the operator dashboard
cd apps/dashboard && npm run dev

# terminal 4 (optional): the four agent consumers
cd apps/agents && cp .env.example .env && npm install && npm run dev

# optional: two-caller cache-sharing demo, once the above three are up
cd apps/agents && npm run demo:cache
```

Gateway and origin-simulator dev ports are pinned in each's `wrangler.toml` `[dev]` block (8787, 8794) — do not remove those, wrangler's auto-increment-on-collision behavior silently lands one of them on the wrong port with no error.

### Gateway (`apps/gateway`)

```bash
npm run test              # vitest run, real workerd runtime via @cloudflare/vitest-pool-workers
npx vitest run src/do/FeedRelay.test.ts   # single file
npx vitest run -t "name of test"          # single test by name
npm run typecheck         # tsc --noEmit
npm run build:wasm        # rebuild WASM engine from crates/mcp-relay-engine
npm run deploy             # applies remote D1 migrations, then wrangler deploy --env production
```

Do not run `wrangler dev`/`wrangler deploy` directly, bypassing the `npm run dev`/`deploy` scripts — they chain the D1 migration step, and skipping it produces a real "no such table" 404 on every delivery-log write against a fresh D1 state.

### Dashboard (`apps/dashboard`)

```bash
npm run dev       # vite --host 127.0.0.1
npm run build     # tsc -b && vite build
npm run lint      # oxlint
npm run deploy    # build then wrangler deploy (Cloudflare Pages)
```

Read `design.md` before any dashboard view work — it's a locked design system (Cobalt theme, Workbench layout family, specific type/motion/spacing tokens) that every redesign is expected to read first rather than regenerate ad hoc.

### Agents (`apps/agents`)

```bash
npm run dev         # runs all four agents via Node 22 native TS execution, no build step
npm run typecheck
npm test            # node --test against src/*.test.ts
npm run demo:cache  # cacheSharingAgent.ts two-caller cache demo
```

### Rust engine (`crates/mcp-relay-engine`)

```bash
cargo test                       # from crates/mcp-relay-engine, or cargo test -p mcp-relay-engine from repo root
cargo test <test_name>           # single test
cargo clippy --all-targets       # lint, expected clean
```

### Chaos harness (`eval`, Python/uv)

```bash
uv venv && uv pip install -e ".[dev]"
pytest                                          # fast, non-live tests only (test_metrics.py, test_chaos_client.py)
pytest -m live                                  # requires a real running gateway + origin-simulator
python -m harness.run_eval scenarios/upstream_outage.json    # real chaos scenario, requires live gateway/origin
python -m harness.run_eval scenarios/downstream_flap.json
ruff check .
```

Results land in timestamped dirs under `eval/results/` (`scenario.json`, `messages.jsonl`, `result.json`).

### Deploying

```bash
cd apps/origin-simulator && npx wrangler deploy
cd apps/gateway && npx wrangler d1 create mcp-relay-harness-delivery-log   # first time only
cd apps/gateway && npx wrangler secret put SUBSCRIBE_TOKEN --env production
cd apps/gateway && npm run deploy
cd apps/dashboard && npm run build && npx wrangler deploy
```

## Architecture

Three Durable Object classes inside the single `apps/gateway` Worker, each with a distinct sharding key:

- **`FeedRelay`** (`apps/gateway/src/do/FeedRelay.ts`) — one instance per `(originUrl, category)` feed, keyed via `idFromName`. Owns the single real upstream `subscriptions/listen` connection, a 200-event replay buffer written through to `ctx.storage.sql` (a plain class field would not survive DO eviction), and fan-out to every downstream hibernatable WebSocket. The check-then-set on `upstreamStarted` that guarantees exactly one upstream connection has to happen with no `await` in between — DO methods only auto-serialize across single synchronous statements, not across awaits. `connectUpstream` runs unawaited inside `ctx.waitUntil`, wrapped in its own `try`/`catch` (a real bug: an uncaught error in that background loop used to silently kill the retry cycle for every subscriber). Reconnect uses full-jitter exponential backoff. Every drop path (backpressure overflow, buffer eviction, upstream disconnect) always emits an explicit gap marker — never silence — which is the project's central design invariant.
- **`ContextIndex`** (`apps/gateway/src/do/ContextIndex.ts`) — one instance per cache `scope`, keyed via `idFromName`, so scope isolation is structural (separate SQLite DBs), not a runtime check. Backs `POST /relay`'s content-addressed cache: index key is BLAKE3 of a canonicalized request encoding, stored content separately BLAKE3-hashed. Fails open to a real origin call on any cache-index infrastructure failure; never fails open on a genuine origin failure, and never caches one.
- **`AuditLog`** (`apps/gateway/src/do/AuditLog.ts`) — single instance, real RPC methods (`append`, `list`, `verify`), not a `fetch()` handler. Each entry embeds `BLAKE3(prevHash + canonicalEntry)`; `verify()` walks the full chain from genesis rather than trusting storage. Single-instance specifically because read-last-hash-then-insert must be atomic with no `await` in between.

Request routing lives in `apps/gateway/src/index.ts` (a flat pathname/method dispatch, no framework) to route handlers under `apps/gateway/src/routes/`. `handleSubscribe` (`routes/subscribe.ts`) is the fullest example of the request pipeline: bearer/scoped-credential auth → rate limit (Cloudflare Rate Limiting binding, 500ms-timeout fail-open) → `isAllowedOrigin` SSRF allowlist check → feed-key derivation → route to the `FeedRelay` DO. `routes/relay.ts` reuses `isAllowedOrigin` unchanged.

Auth has two layers: the legacy shared `SUBSCRIBE_TOKEN` (constant-time compare via `crypto.subtle.timingSafeEqual`, explicitly rejects when the secret itself is unset — a real auth-bypass bug once fixed here) and per-agent scoped credentials in D1 (`agent_credentials`, SHA-256-hashed, scoped to origin/category/capability, individually revocable). Credential resolution fails open to the legacy token on a D1 error, fails closed on a genuinely missing/revoked token. `apps/gateway/src/lib/agentAuth.ts` is the credential path; `isAuthorized` in `subscribe.ts` is the legacy path.

`crates/mcp-relay-engine` (Rust → WASM) provides chunk-boundary-safe incremental SSE parsing and BLAKE3 hashing, instantiated directly in `FeedRelay`'s upstream read loop via `apps/gateway/src/lib/wasmEngine.ts`. That file's manual `WebAssembly.Module` instantiation exists because `wasm-pack build --target bundler` generates webpack-style glue that Cloudflare's own bundler can't satisfy — do not "simplify" it back to a plain `import * as wasm` without re-reading `docs/ARCHITECTURE.md`'s explanation. The ring buffer in the same crate is a reference implementation only; `FeedRelay`'s actual replay buffer is reimplemented natively against `ctx.storage.sql` because its state must survive hibernation, unlike WASM linear memory.

`apps/origin-simulator` and (in production) `fraud-ops-origin` are Workers on the same `workers.dev` zone as the gateway, so a plain `fetch()` between them gets rejected with Cloudflare error 1042 (same-zone loop prevention). `apps/gateway/src/lib/fetchOrigin.ts` routes those two specific hosts through a service binding instead; every other allowlisted origin still uses ordinary `fetch()`. When adding a new same-zone origin, follow this exact pattern (host var + `env.production.services` binding in `wrangler.toml`), don't invent a new one.

D1 (`migrations/` in `apps/gateway`) holds four logs read by the dashboard: `delivery_log`, `agent_log`, `cache_log`, `agent_credentials`. Writes go through `ctx.waitUntil` so observability writes never block live delivery. Two read shapes exist per log for a reason: a row-window endpoint (recent N) and a `/counts` endpoint (true `GROUP BY` totals) — a real dashboard bug came from using the row-window endpoint for a KPI that needed true totals, since rare event types get pushed out of a fixed-size window on a long-running feed. Follow the same two-endpoint pattern for any new log-backed KPI.

`apps/agents` are real WebSocket subscribers through the same `/subscribe` any external client uses (not internal test doubles): `resumeAgent` verifies gapless replay on reconnect, `gapAwareAgent` treats gap markers as resync signals, `orderingAgent` asserts strictly-increasing sequence numbers, `summarizerAgent` is optional (only runs with a Gemini key configured). `cacheSharingAgent.ts` drives two distinct callers through `/relay` and asserts a real cache hit via the origin-simulator's call counter (which only advances on a genuine origin call — this is how "served from cache" is verified independently rather than inferred from latency).

`wrangler.toml` in `apps/gateway` does not let named environments inherit `vars`/`durable_objects`/`d1_databases`/`unsafe` from the top level (confirmed via `wrangler deploy --dry-run`) — every top-level binding has a duplicated `env.production.*` twin immediately below it. If you change one, change its twin, or production silently diverges from dev.

## Testing philosophy in this repo

Tests run against real infrastructure wherever feasible, not mocks: gateway tests use a real `workerd` runtime with real DO/D1 bindings (`@cloudflare/vitest-pool-workers`), the chaos harness kills and restarts an actual `origin-simulator` process (`taskkill`, not a mocked failure), and the four agents run against a real live gateway. When adding tests, prefer this pattern over mocking the platform. `AuditLog.test.ts` demonstrates the expected rigor for tamper-detection claims: it mutates DO storage directly (`runInDurableObject`) rather than only exercising the public API, since the point is proving `verify()` catches tampering it didn't cause itself.

## Security review checklist

When asked to do a security review/audit of this codebase (or `fraud-ops`), work through this list rather than an ad hoc pass. Bracketed notes reflect this stack's real shape and the state of a full audit performed 2026-08-23 — treat them as a starting point to re-verify, not a standing fact, since the code moves.

- **Secrets**: `.env`/`.dev.vars` gitignored and never committed — check full history, not just current state: `git log --all --full-history -- "*.env"`. [Clean as of the last audit, both repos.]
- **CORS**: `Access-Control-Allow-Origin` must be a real allowlist, never a bare `"*"`, on any route with real auth behind it. [`apps/gateway/src/lib/cors.ts` — the gateway's log/audit routes use a real allowlist. `fraud-ops/origin`'s `/mcp` intentionally reflects any origin; that endpoint has zero auth, nothing for CORS to protect, not an oversight.]
- **Auth coverage**: grep every route handler for its auth check; confirm every mutating route requires it, none slip through. [Every handler in `apps/gateway/src/routes/` funnels through `isAuthorized`/`resolveCredential` — re-check this holds for any newly added route.]
- **JWT verification**: not applicable to this stack — auth is bearer-token / SHA-256-hashed scoped credential, not JWT/JWKS. If JWT is ever introduced: the signing algorithm must come from the trusted JWKS key entry, never the token's own unverified header (alg confusion), and `aud` must be checked.
- **SQL injection**: every dynamic query must use `?` placeholders + `.bind()`, never string/template-literal interpolation of a value. [Confirmed clean across every D1 query in `apps/gateway/src/routes/` as of the last audit.]
- **File uploads**: not applicable — no upload endpoint exists anywhere in this system.
- **Rate limiting**: must key on the caller's real authenticated identity (`agentId`) when one exists, IP only as a fallback for the legacy shared-token path — a raw IP can represent many real, distinct callers behind one NAT. Must cover every mutating route, not just the obviously expensive ones. [`apps/gateway/src/routes/subscribe.ts`'s `isRateLimited`, covering `/subscribe`, `/relay`, `/api/agent-log`, `/api/audit-log`. Wire in any new POST route the same way.]
- **AI-specific abuse vectors** (`fraud-ops/agents`): a per-identity request-rate bound on the LLM-calling path, a server-side cap on what's interpolated into the prompt, and a bound on tool-calling steps per turn. [`triageGraph.ts` is a fixed, acyclic 5-node graph — structurally can't loop unboundedly. `caseId`/`entityId` capped at 200 chars in `index.ts`'s `parseSignalEvent`; prompt history capped at the 20 most recent signals in `buildAssessmentPrompt`; a shared 3.5s-interval throttle in `openRouterClient.ts` bounds call rate across primary + fallbacks.]
- **Error handling**: no `ctx.passThroughOnException()`; a caught error's real detail (message, stack) logs server-side (captured by this repo's `[observability]` config) and the client gets a generic message only. Grep for `catch (err)`/`catch(e)` blocks that put `err.message`/`String(err)` straight into a `Response` body — that pattern has recurred before (`routes/relay.ts`) and is worth re-checking on any new upstream-call handler.
- **Duplication/account abuse**: not applicable — no self-service signup or resource-creation endpoint exists; `agent_credentials` is provisioned entirely out-of-band (a direct D1 insert, never via an HTTP route).
- **Signup restriction**: not applicable, same reason — no signup flow, no third-party auth provider.
- **Third-party capacity risk**: identify any shared, rate-limited external dependency (OpenRouter's API key in `fraud-ops/agents`) and confirm a failure there degrades gracefully rather than crashing a request or process. [`auditClient.ts`'s `recordDecision` wraps its whole `fetch()` in try/catch, not just the status check — a genuine network failure there was once capable of becoming an unhandled rejection and crashing the whole agent process; fixed. Re-check any new fire-and-forget async call (`void someAsyncFn()`) for the same gap.]
