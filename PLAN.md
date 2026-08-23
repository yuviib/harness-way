# MCP Relay Harness: Edge-Native Subscription Relay and Shared Cache for MCP

(Originally scoped and referred to internally as "Waystation" during design; renamed before the build was made public.)

## Context and verification status

Portfolio project for a Cloudflare Software Engineering Internship application (Summer 2027 cycle, not yet posted, so no rolling-admission time pressure, but a real, tightening window before the RBC Data & Innovation co-op starts Sept 2026, so the honest build budget is ~3-4 weeks, not months).

Every load-bearing technical claim below has been checked against the actual MCP 2026-07-28 specification changelog (not just a summary post), because this project's credibility depends on describing the protocol precisely:
- `subscriptions/listen` genuinely replaces `resources/subscribe`/`unsubscribe`, and is genuinely a request-scoped, long-lived SSE stream, not a revived session. Confirmed.
- SSE resumability (Last-Event-ID, event redelivery) was genuinely removed in this revision: "A broken response stream loses the in-flight request; clients MUST re-issue it as a new request." Confirmed.
- `tools/list`/`prompts/list`/`resources/list`/`resources/read` genuinely now carry `ttlMs` and `cacheScope` hints for client-local caching. Confirmed.

Also verified during earlier design work: Cloudflare Workers negotiate inbound HTTP version (1.1/2/3) automatically at the edge/zone level, and outbound `fetch()` uses HTTP/2 automatically when available, neither is an app-level choice, so the design correctly treats both as platform-provided (same category as TLS termination), not something the gateway "picks."

## The unifying problem

The MCP spec revision pushes optimization to the edges and makes it a strictly per-client concern in two places: request-response caching (hints, but no shared cache) and streaming (resumability removed entirely, a broken subscription just restarts from now with no redelivery). Both are deliberate, reasonable choices for a stateless-core protocol, but both leave a real gap once more than one caller is involved. Ten agents subscribed to the same notification feed is ten independent fragile connections doing identical work; two callers asking the same question is two full round trips instead of one plus a cache hit.

This isn't just a personal read of the spec, the MCP community itself frames subscription adoption as a coordination problem: servers need to emit changes, clients need to handle notifications, and "infrastructure between them" needs to support persistent connections, with no single party able to make it useful alone. This project is that missing infrastructure layer, the edge piece that makes both concerns shared and multi-client instead of per-client, without requiring the origin server or the client to change.

**Prior art, checked deliberately**: real MCP gateways already exist and are well-established, IBM's ContextForge (federation + Redis-backed caching), Lunar's MCPX (AI control-plane, access control/audit), AIRIS (Docker-based tool multiplexer), Gate22 (governance/control plane). None of them target this specific gap: edge-native (not traditional server infra), Durable-Object-backed shared subscription state, built directly against what the 2026-07-28 spec revision removed. This is a deliberately narrow, checked claim, not "nothing like this exists anywhere."

## Two capabilities, built and evaluated in priority order

**Capability 1 (headline, guaranteed deliverable): subscription multiplexing and resumable replay.** The relay holds exactly one real upstream `subscriptions/listen` connection per origin-and-notification-category pair, fans it out to every downstream agent subscribed through it, and keeps a bounded recent replay window so a client reconnecting within that window gets replayed what it missed, resumability restored at the edge without requiring origin support.

**Capability 2 (secondary, stretch goal behind Capability 1): shared content-addressed cache.** Discrete tool-call results cached by content hash rather than key+TTL, shared across every caller instead of held locally per client. Only happens if time remains after Capability 1 is complete and correct, better to ship one capability fully than two half-finished.

## Why Cloudflare specifically, with tradeoffs stated

- **Durable Objects (SQLite storage backend explicitly, the free-tier-available class, not the legacy KV-backed DO storage class which has different plan requirements) + hibernation API, for the feed relay.** The single natural best fit in the whole project. One DO per feed holds the one upstream connection and fans out to every downstream hibernatable WebSocket. Hibernation means idle *downstream* connections cost nothing while waiting; the DO wakes instantly on a new upstream event or inbound client message. Single-threaded execution is what makes "exactly one upstream connection per feed even under concurrent subscribe requests" a guarantee instead of a race condition to defend against.
  - **Important asymmetry, stated honestly rather than implied away**: Hibernation applies to the *incoming* downstream WebSockets (accepted via `acceptWebSocket()`), not to the DO's *outgoing* leg. The upstream `subscriptions/listen` connection is an ongoing `fetch()` with a streamed response body the DO must actively keep reading, that keeps the DO instance resident for the entire time the upstream subscription is open, independent of how many (or how few) downstream clients are currently connected. "Hibernation makes idle connections free" is true for fan-out, not for the relay's own upstream leg, this is a real, measurable cost/engineering tradeoff to document and report actual numbers on, not a detail to gloss over.
- **Workers, for the entry point.** Subscribe handshake, auth, category validation, then handoff to the relevant DO.
- **D1 + Sessions API, for the delivery log.** Every delivered event, gap marker, and reconnect logged durably and queryably (bookmark-based sequential consistency for the write-then-read pattern the dashboard needs).
- **DO SQLite storage, for the replay buffer.** Small, recent, fast-read, colocated with the feed's own coordination state, different access pattern from D1's durable log so it's kept separate from it rather than mixed together.
- **Pages, for the dashboard.**

## Networking decisions, stated as decisions with tradeoffs

- **TLS not reimplemented.** Cloudflare terminates it at the edge for both the HTTP entry point and the WebSocket upgrade riding the same connection. Design effort goes into what happens after termination.
- **Incremental, chunk-boundary-safe parsing of the upstream stream.** The single upstream `subscriptions/listen` connection is a long-lived response that never ends by design; read via the Streams API, processing chunks as they arrive, with an SSE event-boundary parser that correctly handles an event spanning two chunks. Real streaming-HTTP-client engineering, not hand-waved.
- **Bounded backpressure with an honest failure mode, precisely scoped to what the platform can actually detect (verified, not assumed).** Cloudflare's hibernatable WebSocket `send()` exposes no `bufferedAmount` or any other queue-depth signal at all (confirmed against `cloudflare/workerd#issues/988`, open since August 2023, still open as checked). There is no way for a Durable Object to detect that a specific downstream network client is genuinely slow. What's actually built: a self-imposed, per-socket bounded queue in `FeedRelay`, each upstream chunk's parsed batch of events is queued per subscriber before any are sent; if a single batch exceeds the cap, the oldest queued events for that socket are dropped and the client gets an explicit gap marker before the survivors, never silence. This guarantees the DO's own memory per subscriber can't grow unboundedly no matter how large one upstream burst is, and that any resulting drop is always honestly signaled, but it does **not** guarantee reacting to a genuinely slow network client, because the platform gives no signal to react to. Same "never silence" principle for replay: reconnecting past the buffer window gets an explicit "you have a gap, resubscribe fresh," not a silently incomplete stream. This distinction (burst-volume protection vs. true network-backpressure detection) is the single most important trust property in the design and leads the README, stated precisely rather than implied to be more than it is.
- **mTLS and DNS carry over unchanged.** Workers' native mTLS certificate binding for any origin requiring client-cert auth; gateway deployed behind a real custom domain via Cloudflare DNS, not bare `workers.dev`.

## Gateway plumbing

- **Dispatch**: incoming calls resolve by tool name or feed category to the right origin pool; streaming and discrete traffic routed differently through the same entry point.
- **Load balancing / circuit breaking on the discrete-call path**: least-outstanding-requests across redundant origin instances, breaker trips after consecutive failures, retries with jittered backoff limited to calls the gateway can prove are read-only.
- **Upstream reconnect with backoff, on the streaming path**: if the single upstream subscription drops, the owning DO reconnects with jittered backoff; anything genuinely missed during the outage gets a gap marker broadcast to every downstream subscriber, the same honesty principle applied to the relay's own failures, not just the client's.
- Explicitly distinct from AI Gateway-style provider routing, which stays out of scope as redundant with a shipped Cloudflare product.

## Correctness properties (the actual test suite backbone)

1. Exactly one upstream connection per feed, verified under concurrent subscribe requests, not just the happy path.
2. No silent gaps, ever. Every path that can drop an event (backpressure, buffer overflow, reconnect past window) is covered by a test asserting the client receives an explicit gap marker.
3. At-least-once/exactly-once-delivered within the buffer window, reconnecting client gets every missed event, in order, deduped by event ID.
4. Ordering preserved per feed under concurrent fan-out to many downstream clients, tested under load.
4b. **Upstream-residency cost, measured not assumed.** Since hibernation doesn't cover the DO's own outgoing stream read, report actual GB-seconds/duration billing for a `FeedRelay` DO holding an open upstream subscription over a realistic test window, at a few different downstream-subscriber-count levels (1, 10, 50), the point being to show the cost is dominated by "is the upstream feed active" not "how many downstream clients are attached," and to have a real number instead of an assumption when this comes up in conversation.
5. Content-addressed cache correctness (Capability 2). A served block resolved from its hash is byte-identical to what produced that hash, tested in the Rust crate before WASM.
6. Fail-open on a discrete cache miss (Capability 2). Triggers a full call, never an error, never partial content.
7. Scope isolation on cache keys (Capability 2). No caller resolves into another's cached entry outside an intended shared scope.

## Repo layout

```
mcp-relay-harness/
  apps/gateway/
    src/index.ts               # entry: subscribe handshake + discrete-call dispatch, no business logic
    src/do/FeedRelay.ts         # DO: one upstream subscription, hibernatable fan-out to N downstream
    src/do/ContextIndex.ts      # DO: discrete-call cache index (Capability 2)
    src/lib/sseParser.ts        # incremental, chunk-boundary-safe SSE parsing
    src/lib/wasmEngine.ts       # binding into the Rust/WASM engine
    src/lib/cacheClient.ts      # Cache API / KV read-write, no protocol logic
    src/lib/metricsWriter.ts    # D1 writes via Sessions API
    src/routes/subscribe.ts     # streaming subscription path
    src/routes/relay.ts         # discrete tool-call path (Capability 2)
    wrangler.toml
  apps/origin-simulator/        # synthetic upstream feed + synthetic MCP tool backend, dev + eval
  apps/dashboard/
    src/views/LiveFanoutView.tsx   # one upstream feed branching to many downstream subscribers, live
    src/views/GapAudit.tsx         # every gap marker issued, cause labeled
    src/views/CacheMetrics.tsx     # Capability 2: hit rate, bytes saved
  crates/mcp-relay-engine/      # Rust -> wasm32-unknown-unknown
    src/lib.rs, src/sse_framing.rs, src/ring_buffer.rs, src/hash.rs (Capability 2, BLAKE3)
  eval/
    scenarios/, harness/feed_simulator.py, harness/chaos_client.py, harness/metrics.py, harness/run_eval.py, results/
  docs/ARCHITECTURE.md
```

`FeedRelay.ts` and `ContextIndex.ts` are separate DO classes with separate responsibilities on purpose. `index.ts` only dispatches, no parsing, caching, or fan-out logic itself, so swapping any one piece never requires touching the others.

## Traffic model: chaos-tested synthetic feeds, honestly labeled

Validating gap-marker and replay correctness requires controlled, repeatable connection drops, real organic traffic can't reliably exercise those paths on demand. A chaos client that deliberately disconnects/reconnects on a known schedule is the correct validation approach here (same discipline as production chaos engineering), not a lesser stand-in for real usage. Synthetic upstream feed and tool backend live in `apps/origin-simulator`, clearly labeled in the README as synthetic. Pointing the upstream feed at something with real shape (a RavenMap data-refresh event, an Aura-Mesh-modeled case-status-change event) is a natural optional extension once Capability 1 is proven, not a prerequisite.

## Toolchain state (already verified on this machine)

Node 18 was present but too old for Wrangler (needs 20+), Node 24.19.0 installed via existing nvm-windows; `nvm use` itself needs admin elevation this shell doesn't have, so the versioned path gets referenced directly rather than relying on the symlink. Rust installed via rustup with the `wasm32-unknown-unknown` target; this machine has no MSVC Build Tools, so the default `x86_64-pc-windows-msvc` toolchain can target WASM (bundled `rust-lld`) but can't link native binaries, resolved by also installing `stable-x86_64-pc-windows-gnu` (bundled MinGW linker, no Visual Studio needed), verified with a native compile+link+run smoke test. `wasm-pack` installation was in progress. `uv` already present for Python; `ruff`/`pytest` to be added as project dev dependencies, not global installs.

## SDLC and tooling

Trunk-based development, short-lived branches per component, conventional commits, protected main requiring CI to pass even solo. `vitest` + `@cloudflare/vitest-pool-workers` for the gateway (real `workerd` runtime, real DO/D1 bindings, not a mock). `cargo test` + `wasm-pack test --node` for the engine. `pytest` for the harness, including tests of the chaos client itself, a chaos tool that doesn't reliably reproduce its intended failure is worse than not having one. `clippy`+`fmt`, `ruff`, `eslint` per language. Lockfiles committed for every language (`Cargo.lock`, `uv.lock`, `package-lock.json`), no floating versions; current APIs used deliberately (hibernatable WebSockets over the older always-on DO pattern, current Wrangler major version).

## Explicitly out of scope for v1

Reimplementing TLS, QUIC, or HTTP/2. AI Gateway-style cost/latency routing across model providers. Authentication/authorization beyond what's needed to validate a subscribe request (known gap, noted not hidden). Persisting the replay buffer beyond a bounded recent window (unbounded history is a different, larger system). Capability 2 entirely, if Week 4 runs out first.

## Phased build order (~3-4 weeks realistic window)

- **Week 1**: toolchain finish (wasm-pack, wrangler), Rust crate SSE framing + ring buffer, native tests only, no WASM yet, then wasm-pack build + smoke test through a bare Worker.
- **Week 2**: `FeedRelay` DO, hibernatable WebSocket fan-out, origin-simulator's synthetic upstream feed, one real upstream connection confirmed multiplexing to multiple downstream test clients.
- **Week 3**: chaos client, backpressure + gap-marker paths, replay buffer + reconnect-within-window correctness, D1 delivery logging via Sessions API.
- **Week 4**: dashboard, full deploy (Workers, DO, D1, KV, Pages), README with architecture diagram + correctness properties demonstrated against chaos-harness results.
- **Week 5+ (stretch only)**: Capability 2, discrete content-addressed cache, reusing the hashing work already scoped in the Rust crate.

## Verification plan

- Confirmed limits to build against, not assume: Workers Free plan caps a script at 3 MiB gzip-compressed (10 MiB paid, 64 MB ceiling pre-compression) and requires top-level code to parse/execute within 1 second at deploy time. The Week 1 wasm-in-Worker smoke test should report actual compressed size and top-level init time for the BLAKE3+SSE-framing WASM module against this budget, not assume it's fine.
- `cargo test` for SSE framing/ring-buffer logic before any WASM build.
- `wrangler dev` manual test: open a subscription, confirm fan-out to 2+ simultaneous downstream connections receives identical events in order.
- Chaos-client-driven test run: scripted disconnects at known points, assert every affected client gets an explicit gap marker (never silence) and correct replay on reconnect within the window.
- Concurrent-subscribe-request test against a fresh `FeedRelay` DO, asserting exactly one upstream connection is ever opened.
- `vitest`/`@cloudflare/vitest-pool-workers` suite green against real DO/D1 bindings.
- Full deploy smoke test on Cloudflare's actual free tier (not just local `wrangler dev`) before calling any milestone done.

## Follow-on, after this plan

Resume bullets written once the chaos harness produces real, honestly-labeled results, not before. DS&A/OA prep and TCP/IP, DNS, HTTP, DDoS-mitigation interview review are separate, user-owned tracks this project gives talking material for but doesn't replace.
