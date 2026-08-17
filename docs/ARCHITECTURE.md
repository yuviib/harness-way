# Architecture

This is the deeper technical walkthrough. `README.md` covers the what and why; this covers the how, at the level of "what actually happens on each request" and "why this specific mechanism and not a simpler one."

## Request flow

1. A client opens a WebSocket to the gateway Worker at `/subscribe?originUrl=...&category=...&lastSeenSeq=0`.
2. `handleSubscribe` (`apps/gateway/src/routes/subscribe.ts`) checks the bearer token, validates `originUrl` against an explicit host allowlist (`isAllowedOrigin`), derives a feed key from `(originUrl, category)`, and routes to the `FeedRelay` Durable Object instance for that key via `idFromName`.
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

## Idle teardown

Five seconds after the last downstream subscriber disconnects, an alarm fires and cancels the upstream connection. Not zero: a client that reconnects within a few seconds, a page refresh or a brief network blip, reuses the still-live upstream connection and its buffered history instead of paying a fresh subscribe round trip. Not indefinite either: an idle feed with zero listeners would otherwise keep its upstream connection open, and billed as DO residency time, forever. This grace period was arrived at by testing, not designed up front.

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
| Upstream-residency cost, measured not assumed | Not yet done. Needs a real deploy; tracked as an open item, not silently dropped. |

## Dashboard

React + Tailwind v4, built with Vite. `LiveFanoutView` connects directly from the browser to the gateway's `/subscribe` WebSocket for each subscriber pane and renders the real per-subscriber connection state, not a simulated one, in a topology diagram. `GapAudit` polls the delivery-log endpoints and renders true totals (via the counts endpoint), gap causes, and a recent-events throughput chart, explicitly labeled as a trend window rather than an all-time count where that distinction matters.

One real bug worth naming: the dashboard originally tagged each subscriber's WebSocket URL with a fragment (`#sub0`, `#sub1`, ...) for easier devtools debugging. Browsers' native `WebSocket` constructor throws a `SyntaxError` on any URL containing a fragment, unlike `fetch()`, which silently strips one. That crashed the whole app with no error boundary in place. Fixed by removing the fragments and adding `ErrorBoundary` so a future bug in one view can't take down the entire dashboard.

## Agents

`apps/agents` is four real WebSocket consumers of the relay, each connecting through the exact same `/subscribe` endpoint a browser client uses. The point of building these wasn't to add more test coverage, the existing suite already covers correctness. It was to demonstrate that the guarantees matter to something that actually depends on them: an agent whose own reconnect logic assumes a gapless replay, or whose resync logic assumes gap markers are never silent, is the literal scenario this project is built for.

Each agent posts its decisions to a new `agent_log` D1 table via `POST /api/agent-log`, read back by the dashboard's Agents view through `GET /api/agent-log` (row window) and `GET /api/agent-log/counts` (true per-action-type totals, added from the start this time rather than rediscovered the way `delivery_log`'s counts endpoint was).

### Two real bugs found building this, both from testing against the live stack rather than assumed correct

**Node's `WebSocket.close()` can take 15+ seconds to actually complete against wrangler's local dev server.** `resume-agent` needs to deliberately disconnect and reconnect on a fixed interval to prove replay correctness. The first version scheduled the next connection from inside the `close` event handler, on the assumption that calling `.close()` completes promptly the way it does in a browser. Verified by polling the socket's own `readyState` directly: it enters `CLOSING` (2) immediately, then sits there for 15+ seconds before the `close` event actually fires with code 1006. During that window, `resume-agent` never logged a single reconnect. Fixed by not waiting on it at all: the reconnect timer closes the old socket and opens the new one in the same tick, using an `intentionalReconnect` flag (the same pattern `FeedRelay`'s own `intentionalTeardown` already uses) so the eventual, delayed `close` event on the old socket doesn't also trigger a second, redundant reconnect.

**`wrangler dev` has no default port collision protection.** Neither `apps/gateway/wrangler.toml` nor `apps/origin-simulator/wrangler.toml` pinned a dev port; both had been relying on whatever port got passed ad hoc on the command line in earlier sessions. Starting both fresh, they raced for the same default port; one silently landed one port higher with no error message. Every hardcoded "8787" and "8794" across the dashboard's defaults, this README, and `ALLOWED_ORIGIN_HOSTS` assumed the losing convention hadn't happened. Fixed by adding an explicit `[dev]` port block to each `wrangler.toml`, so the actual port is guaranteed by config rather than by whoever happened to start first.
