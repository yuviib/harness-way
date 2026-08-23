# Architecture

This is the deeper technical walkthrough. `README.md` covers the what and why; this covers the how, at the level of "what actually happens on each request" and "why this specific mechanism and not a simpler one."

## Request flow

1. A client opens a WebSocket to the gateway Worker at `/subscribe?originUrl=...&category=...&lastSeenSeq=0`.
2. `handleSubscribe` (`apps/gateway/src/routes/subscribe.ts`) checks the bearer token, checks the rate limit, validates `originUrl` against an explicit host allowlist (`isAllowedOrigin`), derives a feed key from `(originUrl, category)`, and routes to the `FeedRelay` Durable Object instance for that key via `idFromName`.
3. Every subscriber to the same `(originUrl, category)` pair derives the same feed key and lands on the same DO instance. That's the entire multiplexing mechanism: routing, not a separate coordination layer.
4. Inside `FeedRelay.fetch()`: accept the WebSocket as hibernatable (`ctx.acceptWebSocket`), cancel any pending idle-teardown alarm, start the upstream connection if it isn't already running, and send the client either a replay of buffered events since `lastSeenSeq` or a gap marker if `lastSeenSeq` predates what's retained.

## Exactly one upstream connection, even under concurrent subscribes

The check-then-set on `upstreamStarted` has to happen with no `await` in between, because DO method invocations don't auto-serialize across an `await`, only single synchronous statements are atomic. `connectUpstream` is deliberately not awaited inline; it's handed to `ctx.waitUntil` so the subscribe response can return immediately while the upstream connection establishes (or continues) in the background.

## The replay buffer, and why it isn't just a class field

A plain class field does not survive Durable Object eviction, only `ctx.storage` and already-accepted hibernatable WebSockets do. Confirmed by a dedicated test (`FeedRelay.test.ts`), not assumed. So `buf` and `nextSeq` are write-through to `ctx.storage.sql` (the SQLite backend, provisioned via `new_sqlite_classes` in `wrangler.toml`) on every event, and hydrated back in the constructor via `blockConcurrencyWhile` before the instance handles any request.

The buffer holds the 200 most recent events. A reconnecting client sends `lastSeenSeq`; if the oldest buffered event is still within one of that, it gets everything since. If not, it gets an explicit gap marker naming the oldest sequence number still available, never a silent partial replay.

## SSE parsing: why WASM, and why the replay buffer isn't also WASM

The upstream response body is a long-lived stream, read via the Streams API. An SSE event can legally split across two chunk boundaries at any byte offset, including mid-field-name or mid-line-terminator. The Rust crate (`crates/mcp-relay-engine`) implements a real incremental parser for that, tested against exactly those boundary cases (`split_mid_field_name`, `split_exactly_between_the_two_newlines_of_the_blank_line`, `split_exactly_between_cr_and_lf_of_a_crlf_terminator`, and others in `sse_framing.rs`), compiled to WASM and instantiated directly inside `FeedRelay`'s read loop (`WasmSseParser`, wired in at `FeedRelay.ts:308`).

The ring buffer that the same Rust crate also implements (`ring_buffer.rs`, 25 tests) is the reference implementation for the replay-buffer semantics, but `FeedRelay` reimplements the actual buffer natively in TypeScript against `ctx.storage.sql` rather than calling into the WASM instance for it. Reason: the buffer has to survive DO hibernation and eviction, and routing it through WASM's linear memory would mean manually serializing the whole buffer to durable storage around every call, for logic simple enough that a native reimplementation is the more honest design. The SSE parser's state is fine to lose on a genuine restart, since that's equivalent to a reconnect anyway; the replay buffer's state is not.

### The Cloudflare-bundler wasm-pack mismatch, and the actual fix

`wasm-pack build --target bundler` generates glue that assumes webpack's wasm-loader semantics: `import * as wasm from "*.wasm"` yielding an already-instantiated exports object. Cloudflare Workers' bundler instead resolves a `.wasm` import to a raw, uninstantiated `WebAssembly.Module`, confirmed against Cloudflare's own docs. The generated entry point fails at top level with `wasm.__wbindgen_start is not a function` the moment it's imported, unmodified.

The fix in `apps/gateway/src/lib/wasmEngine.ts` instantiates the module directly against the exact import object the compiled binary actually declares, verified via `WebAssembly.Module.imports()` rather than guessed: this module has exactly one import, `__wbindgen_init_externref_table`, from a namespace named after its own glue file, which is exactly what the generated `bindgen` exports already provide.

## Backpressure: what's real and what isn't claimed

Cloudflare's hibernatable WebSocket `send()` exposes no `bufferedAmount` or any queue-depth signal (`cloudflare/workerd#988`, open since August 2023, confirmed still open). A Durable Object has no way to detect that one specific downstream client is genuinely network-slow.

What's built instead is a per-socket bounded queue (`OUTBOUND_BURST_CAPACITY = 20`). Each upstream chunk's parsed batch of events is queued per subscriber before any are sent. If a batch pushes a socket's queue past the cap, the oldest queued events for that socket are dropped and the survivors are preceded by an explicit gap marker at flush time. This bounds the DO's own memory per subscriber regardless of upstream burst size, and guarantees any resulting drop is signaled, never silent. It does not, and cannot, detect or react to a genuinely slow network client, because the platform provides no signal for that. Flushing happens once per upstream chunk, not once per event, since draining per-event would make the cap meaningless (the queue would never hold more than one item at a time).

## Reconnect and gap marking on upstream failure

Per the MCP 2026-07-28 spec revision, a broken response stream unconditionally loses whatever was in flight; there is no server-side redelivery to fall back on. So when the upstream connection ends, expectedly or not, `connectUpstream` always broadcasts a gap marker before attempting to reconnect, since there's no way to know whether anything was actually missed.

Reconnection uses full-jitter exponential backoff (`computeBackoffMs`, the Marc Brooker / AWS Architecture Blog formula): the ceiling grows exponentially and is capped, then the actual delay is drawn uniformly from `[0, ceiling]`. A fixed-offset jitter still lets every DO retrying against the same failed origin drift back into lockstep after a few attempts; a full random draw each time doesn't.

`outageSignaled` tracks whether the current outage has already been announced, so a connection that drops and reconnects only signals once, not on every retry attempt. It resets at two points, both confirmed by tests: intentional teardown (idle timeout) and the "no subscribers left, give up" path. Both matter for the same reason: a future subscriber to a feed that's fully restarted from scratch must not inherit a stale "already told you about a drop" flag left over from a different subscriber's outage.

**A background-loop crash was found during extended local testing, not designed against up front.** `connectUpstream`'s retry loop runs inside `ctx.waitUntil`, outside the request's own call stack, so an exception thrown mid-loop had no `try`/`catch` above it to land in and would silently end the loop every current and future subscriber to that feed depends on. Observed live as a repeating uncaught error partway through a long-running outage simulation. The loop body is now wrapped in its own `try`/`catch`: an unexpected error is logged and treated as an ordinary failed connection attempt, so the retry-with-backoff cycle continues instead of the feed going permanently dark.

## Idle teardown

Five seconds after the last downstream subscriber disconnects, an alarm fires and cancels the upstream connection. Not zero: a client that reconnects within a few seconds, a page refresh or a brief network blip, reuses the still-live upstream connection and its buffered history instead of paying a fresh subscribe round trip. Not indefinite either: an idle feed with zero listeners would otherwise keep its upstream connection open, and billed as DO residency time, forever. This grace period was arrived at by testing, not designed up front.

## Rate limiting

`isRateLimited` (`apps/gateway/src/routes/subscribe.ts`) checks a real Cloudflare Rate Limiting binding (`RATE_LIMITER`, configured in `wrangler.toml` under `unsafe.bindings`, not a hand-rolled counter) after auth succeeds and before the request does any real work. `/subscribe` and `/relay` each get their own bucket on the same shared binding, keyed on `routeKey:clientKey`, so exhausting one route's budget doesn't touch the other's.

The binding runs in remote mode under local `wrangler dev`, meaning it needs real Cloudflare auth to answer and hangs rather than errors when it can't reach it. A bare `await` on it would stall every local request indefinitely. The check is wrapped in a 500ms `Promise.race` against a timeout and fails open on either a timeout or a thrown error, on the same principle as `ContextIndex`'s cache lookup: an infrastructure hiccup should degrade availability, not block a real request outright.

Verified live, not just locally: driven past the limit against the real production gateway using the caller's actual client IP (Cloudflare's edge outright rejects a client-supplied `CF-Connecting-IP` header with error 1000, so the key can't be spoofed by the caller). The first 30 requests in a 60-second window succeeded; the 31st and beyond correctly returned 429.

## Cross-Worker calls: a service binding where one applies

`apps/origin-simulator` is itself another Worker on this account's `workers.dev` zone. A plain `fetch()` from the gateway to it is rejected by Cloudflare with error 1042, a real loop-prevention restriction between two Workers on the same zone, confirmed live during deployment by temporarily surfacing the 502 response body, which contained the error code directly.

`fetchOrigin` (`apps/gateway/src/lib/fetchOrigin.ts`) routes around this: it checks the target hostname against `ORIGIN_SIMULATOR_HOST`, and only for that one known host, dispatches through the `ORIGIN_SIMULATOR` service binding instead of a plain fetch. Every other allowlisted origin still goes through ordinary `fetch()`, unaffected. A real MCP origin hosted anywhere else would never hit this path at all; the binding exists only because this project's own dev origin happens to live on the same zone as the gateway.

## Auth: a real bug, found by a security review of the diff that introduced rate limiting

`isAuthorized` compares a SHA-256 digest of the caller-supplied token against a digest of `env.SUBSCRIBE_TOKEN`, using a constant-time XOR diff rather than a plain string comparison, to avoid a timing side channel. That part was correct from the start. What it never checked was whether `SUBSCRIBE_TOKEN` was actually set.

`TextEncoder.encode(undefined)` produces the identical empty byte array as `TextEncoder.encode("")`, confirmed with a direct Node test. So if the secret were ever missing at deploy time, for instance `wrangler secret put` run against the wrong named environment, a caller sending zero credentials at all would hash to the same digest as the missing expected value, and would be silently authorized.

This was caught by a security review scoped to that night's diff rather than the whole codebase (an earlier full-codebase review had found nothing; this bug didn't exist yet at that point). The fix is an explicit guard at the top of `isAuthorized`: reject outright, before any comparison happens, if `env.SUBSCRIBE_TOKEN` is falsy. Covered by two new tests, one confirming an empty token is rejected against a missing expected token, one confirming every request is rejected, even a well-formed one, when the secret is unset, and confirmed live against the real deployment: a valid token still returns success, and a request with no credentials now correctly returns 401.

## Delivery log

Every delivered event, gap marker, and successful reconnect is logged to D1 through `logDelivery`, called via `ctx.waitUntil` so a failed or slow observability write never blocks or fails live delivery. Writes go through D1's Sessions API (`withSession("first-primary")`) for bookmark-based sequential consistency, which matters once the dashboard is reading this data shortly after it's written.

Two entry points read this log: `GET /api/delivery-log` (row-window queries, filterable by feed key and entry type) and `GET /api/delivery-log/counts` (true per-type totals via `GROUP BY`, independent of any row window). The counts endpoint exists because a long-running feed logs an `event` row roughly once a second; a fixed-size row window, even a generously large one, eventually pushes rare `gap`/`reconnect` rows out of the fetched range entirely. That was a real bug caught by building the dashboard's Gap Audit view against the row-window endpoint alone: total counts silently understated to zero on a feed that had genuinely logged gaps hours earlier. Any KPI claiming to be a total, not a "most recent N," has to come from the counts endpoint.

## Correctness properties and where each is proven

| Property | Where it's tested |
|---|---|
| Exactly one upstream connection per feed, even under concurrent subscribes | `FeedRelay.test.ts` |
| No silent gaps on any drop path (backpressure, buffer eviction, reconnect) | `FeedRelay.test.ts`, `eval/tests/test_metrics.py`'s `_check_no_silent_gaps`, and both real chaos scenarios |
| Replay within the buffer window is complete, ordered, and deduplicated | `FeedRelay.test.ts`, `ring_buffer.rs` unit tests, `_check_replay_is_self_consistent` |
| Ordering preserved under concurrent fan-out | `downstream-flap` chaos scenario, `_check_strictly_increasing_within_run` |
| A missing `SUBSCRIBE_TOKEN` fails closed, never authorizes | `subscribe.test.ts`, and confirmed live against production |
| Rate limits enforced independently per route, not spoofable via client-supplied headers | Manual live test against production (30 requests succeed, the 31st returns 429) |
| Upstream-residency cost, measured not assumed | Not yet done. Tracked as an open item, not silently dropped. |
| A served cache hit is byte-identical to what produced its hash (Capability 2) | `ContextIndex.test.ts` ("stores then serves byte-identical content"), `relay.test.ts` ("second identical call ... served from cache") |
| Fail-open on a discrete cache miss: always a full real call, never an error, never partial content (Capability 2) | `relay.test.ts` ("fails open on a discrete cache miss"), `cacheClient.test.ts` (the DO-unreachable half of fail-open) |
| Scope isolation: no caller resolves into another scope's cached entry (Capability 2) | `ContextIndex.test.ts` ("scope isolation"), `relay.test.ts` ("a different scope ... is its own cache miss") |

## Capability 2: the shared, content-addressed discrete-call cache

Where Capability 1 multiplexes a long-lived stream, Capability 2 does the equivalent for a one-shot `tools/call`: a caller POSTs `{originUrl, scope, tool, arguments}` to `POST /relay`; if another caller in the same `scope` already asked the identical question, the answer comes back from cache, and the origin is never touched a second time.

### Two hashes, not one

`buildRequestHash` (`apps/gateway/src/lib/cacheKey.ts`) hashes a canonicalized (recursively key-sorted) JSON encoding of `{originUrl, tool, arguments}`, the cache's index key, identifying "this exact call" independent of how a particular HTTP client happened to order its JSON keys. Separately, once a real call succeeds, its raw response body is hashed again to produce the content address (`resultHash`) the bytes are stored under. Two different requests that happen to produce byte-identical output legitimately share a `resultHash`, that's content-addressing working as intended, not a collision to worry about. Both hashes are BLAKE3, computed by a WASM export (`blake3_hex`, `crates/mcp-relay-engine/src/hash.rs`) added to the same Rust crate Capability 1's SSE parser already lives in, for the same reason: this is genuine hot-path logic worth testing natively before it's ever compiled to WASM (`hash.rs`'s own 5 tests, including the published BLAKE3 empty-input test vector, asserted as a known value so a future dependency bump that silently changed the algorithm would be caught).

### Storage: DO SQLite, not Cache API/KV, a revised decision, stated like the last one

PLAN.md's original repo-layout sketch named this `src/lib/cacheClient.ts # Cache API / KV read-write`, written before any of this was actually built. Building it surfaced the same tension Capability 1's replay buffer already resolved once: the Cache API's best-effort, evict-at-any-time, edge-local semantics make the correctness properties this cache is supposed to demonstrate (byte-identical replay, scope isolation) hard to pin down deterministically in a test. `ContextIndex` (`apps/gateway/src/do/ContextIndex.ts`) is a Durable Object instead, one instance per `scope`, keyed via `idFromName`, backed by `ctx.storage.sql`, the same storage mechanism `FeedRelay`'s own replay buffer already uses, for the same reason.

Scope isolation (correctness property 7) falls out of this structurally, not as a runtime check: two different scopes are two different DO instances with two entirely separate SQLite databases. There is no code path inside `ContextIndex` that could leak one scope's entry into another's lookup, a bug there would have to be `routes/relay.ts` routing to the wrong DO instance, a distinct and separately-tested failure mode.

### Fail-open, precisely scoped

PLAN.md's correctness property 6 ("fail-open on a discrete cache miss ... never an error, never partial content") covers two distinct situations that converge on the same behavior: a genuine miss (the index honestly has never seen this request) and an index failure (the `ContextIndex` DO fetch throws or returns non-OK). `lib/cacheClient.ts`'s `lookupCache` never throws, both cases resolve to "nothing served from cache," logged under different `cache_log` outcomes (`miss` vs `fail-open`) so a sustained run of index failures stays visible rather than blending into ordinary cold-cache traffic, and `routes/relay.ts` always falls through to a real origin call either way. What is not papered over: if the real origin call itself fails, that surfaces as an actual `502`, and nothing gets cached, there is no honest content to serve or store in that case, same principle as every other upstream-call failure in this codebase.

### Proving it against a real origin, not a mock

`apps/origin-simulator`'s synthetic `resource_lookup` tool (added alongside this capability) returns deterministic content for a given `resourceId` plus a monotonically-increasing `originCallSeq` that only advances on a genuinely new call. That's what makes "this response came from cache, not a second real call" independently verifiable rather than merely inferred: `apps/agents/src/cacheSharingAgent.ts` (`npm run demo:cache`) drives two distinct logical callers against a shared scope end to end against the real dev stack, the second caller's response carries the same `originCallSeq` as the first, and arrives roughly an order of magnitude faster (the simulator adds a real 250ms artificial tool latency specifically so the saving is observable, not theoretical).

### Dashboard: Cache Metrics

`CacheMetrics.tsx` polls `GET /api/cache-log/stats` (true aggregate hit rate, bytes saved, and average latency by outcome, same "totals need their own `GROUP BY` query, not a summed row window" discipline as `GapAudit`'s and `AgentsView`'s own counts endpoints) and `GET /api/cache-log` for a recent-accesses table, filterable by `scope`.

## Dashboard

React + Tailwind v4, built with Vite, deployed to Cloudflare's Workers Static Assets. `LiveFanoutView` connects directly from the browser to the gateway's `/subscribe` WebSocket for each subscriber pane and renders the real per-subscriber connection state, not a simulated one, in a topology diagram. `GapAudit` polls the delivery-log endpoints and renders true totals (via the counts endpoint), gap causes, and a recent-events throughput chart, explicitly labeled as a trend window rather than an all-time count where that distinction matters.

One real bug worth naming: the dashboard originally tagged each subscriber's WebSocket URL with a fragment (`#sub0`, `#sub1`, ...) for easier devtools debugging. Browsers' native `WebSocket` constructor throws a `SyntaxError` on any URL containing a fragment, unlike `fetch()`, which silently strips one. That crashed the whole app with no error boundary in place. Fixed by removing the fragments and adding `ErrorBoundary` so a future bug in one view can't take down the entire dashboard.

## Agents

`apps/agents` is four real WebSocket consumers of the relay, each connecting through the exact same `/subscribe` endpoint a browser client uses. The point of building these wasn't to add more test coverage, the existing suite already covers correctness. It was to demonstrate that the guarantees matter to something that actually depends on them: an agent whose own reconnect logic assumes a gapless replay, or whose resync logic assumes gap markers are never silent, is the literal scenario this project is built for.

Each agent posts its decisions to a new `agent_log` D1 table via `POST /api/agent-log`, read back by the dashboard's Agents view through `GET /api/agent-log` (row window) and `GET /api/agent-log/counts` (true per-action-type totals, added from the start this time rather than rediscovered the way `delivery_log`'s counts endpoint was).

### Bugs found building this, all from testing against the live stack rather than assumed correct

**Node's `WebSocket.close()` can take 15+ seconds to actually complete against wrangler's local dev server.** `resume-agent` needs to deliberately disconnect and reconnect on a fixed interval to prove replay correctness. The first version scheduled the next connection from inside the `close` event handler, on the assumption that calling `.close()` completes promptly the way it does in a browser. Verified by polling the socket's own `readyState` directly: it enters `CLOSING` (2) immediately, then sits there for 15+ seconds before the `close` event actually fires with code 1006. During that window, `resume-agent` never logged a single reconnect. Fixed by not waiting on it at all: the reconnect timer closes the old socket and opens the new one in the same tick, using an `intentionalReconnect` flag (the same pattern `FeedRelay`'s own `intentionalTeardown` already uses) so the eventual, delayed `close` event on the old socket doesn't also trigger a second, redundant reconnect.

**`wrangler dev` has no default port collision protection.** Neither `apps/gateway/wrangler.toml` nor `apps/origin-simulator/wrangler.toml` pinned a dev port; both had been relying on whatever port got passed ad hoc on the command line in earlier sessions. Starting both fresh, they raced for the same default port; one silently landed one port higher with no error message. Every hardcoded "8787" and "8794" across the dashboard's defaults, this README, and `ALLOWED_ORIGIN_HOSTS` assumed the losing convention hadn't happened. Fixed by adding an explicit `[dev]` port block to each `wrangler.toml`, so the actual port is guaranteed by config rather than by whoever happened to start first.

**summarizer-agent's Gemini fallback chain leaked reasoning text instead of a clean summary.** One of the fallback models in the chain (`gemma-4-31b-it`) occasionally returned its own intermediate reasoning as the "final" output rather than a clean one-line summary. Removed from the fallback chain, and both `callGemini` and `callGroq` now run their raw model output through `extractFinalSentence`, a defensive post-processing step that takes the last non-blank line and strips a `Final choice:` / `Final:` / `Answer:` style prefix, as a second line of defense against any future model in the chain doing the same thing.
