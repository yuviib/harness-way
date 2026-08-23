# MCP Relay Harness & Fraud Ops — Master Technical Specification

**Status:** Living document, last verified against a real deployment on 2026-08-23.
**Scope:** Two repositories, one system. `harness-way` (this repo) is the relay/infrastructure
layer; `fraud-ops` is a separate repository and a separate deployment that consumes it as a real
external client. Every number in this document was measured directly against the actual deployed
Cloudflare account on the date above, not estimated — see §13 for how each was obtained.

---

## 0. How to read this document

This spec is organized bottom-up-verifiable: every architectural claim in §4–§9 is paired with the
file, test, or measurement that proves it, and §13 collects every quantitative number used anywhere
in this document into one place so a claim never has to be taken on faith. §2 is the only section
written for a non-technical reader; everything after it assumes familiarity with Cloudflare Workers,
Durable Objects, and the shape of a JSON-RPC protocol.

---

## 1. Executive Summary

**MCP Relay Harness** is an edge-native relay for the Model Context Protocol's
`subscriptions/listen` notification stream, built entirely on Cloudflare Workers and Durable
Objects. It solves one specific, real gap in the MCP spec's July 2026 revision: a
`subscriptions/listen` connection has no resumability at the protocol level at all — if it drops,
whatever was in flight is gone, and the client has no way to even know something was missed. The
relay sits between an MCP origin server and any number of subscribers, holds exactly one real
upstream connection per feed, fans it out live to every downstream subscriber, and keeps a bounded
replay buffer so a reconnecting client gets exactly what it missed — or, when the drop exceeds the
buffer window, an explicit, honest gap marker instead of silence.

**Fraud Ops** is a second, separately deployed system that exists to answer the question the relay's
own test suite can't: does this guarantee matter to something real that depends on it. It's a
synthetic fraud-signal origin, a real LangGraph.js AI agent that subscribes through the relay's
production gateway and makes real triage decisions, and an operator console that shows both a naive
direct connection and the relay-backed one side by side. Building it forced two new capabilities
into the relay itself — per-agent scoped credentials and a tamper-evident, hash-chained audit
log — which now exist as general infrastructure, not features specific to Fraud Ops.

Together: **2 repositories, 8 deployed Cloudflare services, 260 automated tests across 5 test
frameworks and 3 languages, zero known unresolved high-confidence security findings** (per the audit
in §12), and a full quantitative performance profile measured against live production
infrastructure, not a staging environment.

---

## 2. Business Case

### 2.1 The problem, stated plainly

Two failure modes, both real, both commonly shipped as-is because they're easy to miss until
something goes wrong in production:

1. **A dropped real-time connection loses data silently.** Most first integrations with any
   streaming protocol — MCP's `subscriptions/listen`, SSE, a WebSocket feed — connect directly to
   the source. When that connection drops, the client has no way to distinguish "caught up" from
   "missed something." For a feed carrying anything time-sensitive (a fraud signal, an inventory
   change, a security event), that blind spot is exactly where real damage happens unnoticed.
2. **An AI agent making autonomous decisions has no accountable trail.** Once an LLM decides
   escalate/clear/approve/deny instead of a human, "trust the model" is not an answer a compliance
   team, an auditor, or a postmortem six months later can accept. The decision has to be
   attributable to a specific, revocable identity, and provably unaltered after the fact — or it is
   not usable for anything that actually matters.

### 2.2 Who this is actually for

- **Teams building multi-agent systems on MCP.** As more products expose MCP servers and more
  agents subscribe to them concurrently, "ten agents means ten independent fragile connections doing
  identical work against the origin" becomes a real cost and a real reliability problem. A shared
  relay converts that to one upstream connection regardless of subscriber count.
- **Any team that needs AI-agent decisions to be auditable**, not just fraud specifically —
  content moderation, automated approvals, security triage, anything where "why did the system do
  that, and can you prove the record wasn't altered" is a real question someone will eventually ask.
- **Teams already on Cloudflare** who want this capability without standing up a separate message
  broker (Kafka, Redis Streams) — the entire relay runs on Workers + Durable Objects + D1, no
  additional infrastructure, and fits comfortably inside Cloudflare's free tier at this traffic
  volume (see §8.8).

### 2.3 Why this is a genuine engineering problem, not a CRUD wrapper

The two hardest parts of this system were both found by testing against real Cloudflare
infrastructure, not designed correctly on the first attempt:

- **Isolate affinity.** A naive implementation keeping shared state (an outage window, in Fraud
  Ops's origin; the "is the upstream connection already open" flag, in the relay) as a module-scope
  variable in a plain Worker silently fails, because Cloudflare can route two requests for the "same"
  Worker to two different isolates with two independent copies of that variable. This is not
  documented as a gotcha anywhere obvious — it was found live, by triggering an outage and observing
  zero effect on an already-open connection. The fix (a single Durable Object instance) is the
  correct Cloudflare-native answer, and is now used in three separate places across both repos for
  exactly this reason.
- **No platform signal for a slow downstream client.** Cloudflare's hibernatable WebSocket API
  exposes no `bufferedAmount` or equivalent (confirmed against the open GitHub issue,
  `cloudflare/workerd#988`). A relay fanning one upstream feed out to N subscribers has no way to
  detect that one specific subscriber's network is the bottleneck. The design response — a bounded
  per-socket queue with an explicit gap marker on overflow — is documented in §5.2 along with exactly
  what it does and does not guarantee.

### 2.4 Cost model

Every deployed service in this system runs comfortably inside Cloudflare's free tier at the traffic
volumes exercised in testing and demoing:

| Resource | Free tier limit | Actual usage (measured) |
|---|---|---|
| Workers requests | 100,000/day per account | Load test in §9.3 used ~340 requests total across all scenarios |
| Workers bundle size (gzip) | 3 MiB | Gateway: 32.8 KiB (1.1% of cap) — see §8.8 |
| D1 storage | 5 GB | 4 tables, append-only logs, negligible at demo scale |
| Durable Objects requests | 1,000,000/day (paid) / included in Workers free tier for compute | Not a bottleneck at any scale tested |

No paid Cloudflare product is required to run this system as built. The one line item genuinely
worth planning for at real scale is Durable Object **residency time** for the upstream connection's
outgoing leg (an open `fetch()` stream keeps a DO instance active independent of downstream
subscriber count) — flagged explicitly as an unmeasured, open item in §14, not glossed over.

---

## 3. System Landscape

### 3.1 Repository map

| Repo | Public name | Role | Deployed services |
|---|---|---|---|
| `harness-way` (this repo) | MCP Relay Harness | The relay itself — infrastructure layer | gateway, origin-simulator, dashboard |
| `fraud-ops` | Fraud Ops | A real external consumer, proving the relay matters | origin, console (agent runs locally, connects out) |

These are two separate GitHub repositories, two separate `wrangler` projects, and (with one
exception — the agent process) entirely separate Cloudflare deployments. `fraud-ops` depends on
`harness-way`'s live production gateway; `harness-way` has zero dependency in the other direction —
it doesn't know `fraud-ops` exists except as one more allowlisted origin host in its own config.

### 3.2 High-level architecture

```
┌─────────────────────────────── harness-way ────────────────────────────────┐
│                                                                              │
│  origin-simulator ──subscriptions/listen──▶  FeedRelay (DO)  ──fan-out──▶  │
│  (synthetic MCP           ▲                        │                       │
│   origin, dev/eval)       │                    ContextIndex (DO)            │
│                           │                    (content-addressed cache)    │
│                           │                        │                       │
│                     gateway Worker  ◀────────  AuditLog (DO)               │
│                     (routes, auth,             (hash-chained,              │
│                      rate limit)                per-agent credentials)     │
│                           │                                                │
│                        D1 (delivery_log, agent_log, cache_log,             │
│                            agent_credentials)                              │
│                           │                                                │
│                      dashboard (React, operator view)                      │
└──────────────────────────┼───────────────────────────────────────────────┘
                            │ real deployed gateway, not a local copy
┌───────────────────────────┼──────────────────── fraud-ops ─────────────────┐
│                            ▼                                                │
│  origin (synthetic     ──subscriptions/listen──▶  same gateway, same       │
│  fraud-signal DO)                                  FeedRelay/AuditLog      │
│         ▲                                                  │               │
│         │                                          scoped credential       │
│    console (naive panel,      triage agent (LangGraph.js, local process,   │
│    direct connection,          subscribes via /subscribe, writes           │
│    no relay)                   decisions to /api/audit-log)                │
│         ▲                              │                                   │
│         └──────── relay panel ─────────┘                                   │
│              (subscribes through the gateway above)                        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Deployed services inventory

| Service | Repo | Cloudflare product | Public URL |
|---|---|---|---|
| Gateway | harness-way | Worker + 3 Durable Object classes + D1 | `mcp-relay-harness-gateway-production.ybains-dev.workers.dev` |
| Origin simulator | harness-way | Worker + 1 Durable Object class | `mcp-relay-harness-origin-simulator.ybains-dev.workers.dev` |
| Dashboard | harness-way | Workers Static Assets (React SPA) | `mcp-relay-harness-dashboard.ybains-dev.workers.dev` |
| Fraud Ops origin | fraud-ops | Worker + 1 Durable Object class | `fraud-ops-origin.ybains-dev.workers.dev` |
| Fraud Ops console | fraud-ops | Workers Static Assets (React SPA) | `fraud-ops-console.ybains-dev.workers.dev` |
| Triage agent | fraud-ops | Local Node process (not deployed) | connects out to the gateway above |

All five deployed Workers live on the same Cloudflare account and the same `workers.dev` zone,
which is exactly the condition that triggers Cloudflare's error 1042 (a Worker cannot plain-`fetch()`
another Worker on the same zone) — see §8.7 for the service-binding fix applied twice for this
reason.

---

## 4. MCP Protocol Compliance

### 4.1 What `subscriptions/listen` actually is

Per the MCP spec's 2026-07-28 revision, `resources/subscribe`/`unsubscribe` was replaced with
`subscriptions/listen`: a single JSON-RPC request whose response is a long-lived stream (SSE in this
system's implementation), carrying `notifications/*`-shaped push messages for as long as the
connection stays open. The request shape used throughout this system:

```json
{"jsonrpc":"2.0","id":1,"method":"subscriptions/listen","params":{"category":"transaction-signals-v1"}}
```

The critical spec detail this whole project is built around: **this revision removed stream
resumability entirely.** There is no `id`-based redelivery, no server-side buffer implied by the
protocol itself. If the connection breaks, the client re-issues the whole request from scratch and
receives only what's sent after that point — nothing about the protocol itself can tell a client
whether it missed anything in between.

### 4.2 What's deliberately not implemented

Both this repo's `origin-simulator` and `fraud-ops`'s `origin` implement **only**
`subscriptions/listen` and, in the relay's case, a `tools/call` shape for the discrete cache
capability. Neither implements the full MCP surface (resources, prompts, sampling, elicitation).
This is a stated scope decision, not an oversight: the relay's entire value proposition is about the
one piece of MCP that has a real resumability gap, and building out an MCP-spec-complete server would
add surface area without adding to what this project is actually demonstrating.

---

## 5. MCP Relay Harness — Component Deep Dive

### 5.1 Gateway Worker — routing table

`apps/gateway/src/index.ts`, the single entry point. Zero npm runtime dependencies — everything is
built on Workers-native APIs (`fetch`, `WebSocket`, `DurableObject`, `D1Database`) plus the
project's own Rust/WASM module. Full route table, verified directly against the source:

| Method | Path | Handler | Auth | Notes |
|---|---|---|---|---|
| `GET` (WS upgrade) | `/subscribe` | `handleSubscribe` | Bearer token or scoped credential | Routes to `FeedRelay` by `(originUrl, category)` |
| `POST` | `/relay` | `handleRelay` | Bearer token or scoped credential | Routes to `ContextIndex`, cached tool calls |
| `GET`/`OPTIONS` | `/api/delivery-log`, `/api/delivery-log/counts` | `handleDeliveryLog*` | Bearer token | Read-only, dashboard-facing |
| `GET`/`POST`/`OPTIONS` | `/api/agent-log`, `/api/agent-log/counts` | `handleAgentLog*` | Bearer token | Agent activity, read + write |
| `GET`/`OPTIONS` | `/api/cache-log`, `/api/cache-log/stats` | `handleCacheLog*` | Bearer token | Cache hit/miss history |
| `GET`/`POST`/`OPTIONS` | `/api/audit-log`, `/api/audit-log/verify` | `handleAuditLog*` | Bearer token | Hash-chained decision log |

Every route funnels through the same `isAuthorized`/`resolveCredential` logic (§5.7) — there is no
route with a separately-implemented, potentially-divergent auth check.

### 5.2 FeedRelay Durable Object — the multiplexing core

**File:** `apps/gateway/src/do/FeedRelay.ts`. One instance per `(originUrl, category)` pair, routed
via `idFromName(buildFeedKey(originUrl, category))` where `buildFeedKey` is
`JSON.stringify([originUrl, category])` — chosen specifically over string concatenation to prevent
two different `(originUrl, category)` pairs from ever colliding into the same key (verified as part
of the security audit in §12).

**Exactly-once upstream connection.** The check-then-set on `upstreamStarted` happens with no
`await` between the check and the set, because Durable Object method invocations do not
auto-serialize across an `await` — only single synchronous statements are guaranteed atomic. This is
what makes "one real upstream connection per feed, even under N concurrent `/subscribe` requests" a
structural guarantee rather than a race condition to defend against.

**Replay buffer.** 200 most recent events, backed by `ctx.storage.sql` (the DO's SQLite storage
class), not a plain class field — a plain field does not survive DO eviction, confirmed by a
dedicated test. On reconnect, a client sends `lastSeenSeq`; if the oldest buffered event is still
within that window, it receives full, ordered replay. If not, it receives an explicit gap marker
naming the oldest sequence number still available — never a silent partial replay, and never a
best-effort guess.

**Backpressure.** Cloudflare's hibernatable WebSocket `send()` exposes no queue-depth signal
(confirmed against `cloudflare/workerd#988`, open since August 2023). The design response: a bounded
per-socket outbound queue (`OUTBOUND_BURST_CAPACITY = 20`). If a single upstream chunk produces more
events than the cap for one specific subscriber, the oldest queued events for *that socket* are
dropped and the survivors are preceded by an explicit gap marker at flush time. This bounds DO memory
per subscriber regardless of upstream burst size and guarantees any resulting drop is signaled — but
explicitly does **not** detect or react to a genuinely slow network client, because the platform
provides no signal to react to. Stated as a real limit, not implied away.

**Reconnect and gap marking.** Per the spec fact in §4.1, a broken upstream connection
unconditionally loses whatever was in flight — there is no server-side redelivery to fall back on.
`connectUpstream` always broadcasts a gap marker before attempting reconnection, on any drop,
expected or not, since there is no way to know in advance whether anything was actually missed.
Reconnection uses full-jitter exponential backoff (the Marc Brooker / AWS Architecture Blog formula):
the ceiling grows exponentially and is capped, and the actual delay is drawn uniformly from
`[0, ceiling]` — a fixed-offset jitter would still let every DO retrying against the same failed
origin drift back into lockstep after a few attempts; a full random draw doesn't.

**Idle teardown.** Five seconds after the last subscriber disconnects, an alarm cancels the upstream
connection — not zero (a page refresh reuses the still-live connection and buffer), not indefinite
(an idle feed with zero listeners would otherwise bill DO residency time forever). Arrived at by
testing, not designed up front.

**A real bug found in this DO's design:** `connectUpstream`'s retry loop runs inside
`ctx.waitUntil`, outside the request's own call stack — an uncaught exception mid-loop had no
`try`/`catch` above it and silently ended the loop every current and future subscriber to that feed
depends on, observed live as a repeating uncaught error during a long-running outage simulation.
Fixed by wrapping the loop body in its own `try`/`catch`, treating an unexpected error as an ordinary
failed connection attempt so the retry-with-backoff cycle continues rather than the feed going
permanently, silently dark.

### 5.3 ContextIndex Durable Object — content-addressed cache

**File:** `apps/gateway/src/do/ContextIndex.ts`. One instance per cache `scope` (a caller-supplied
partitioning key), routed the same way as `FeedRelay`. Backs the `POST /relay` capability: a caller
submits `{originUrl, scope, tool, arguments}`, and if another caller in the same `scope` already
asked the byte-identical question, the response is served from cache without a second real call to
the origin.

**Two hashes, not one.** `buildRequestHash` hashes a canonicalized (recursively key-sorted) JSON
encoding of `{originUrl, tool, arguments}` — the index key, identifying "this exact call"
independent of how a particular caller happened to order its JSON keys. Once a real call succeeds,
its response body is hashed a second time to produce the content address (`resultHash`) the bytes
are stored under. Both hashes are BLAKE3, computed by a WASM export shared with the SSE parser's
crate (§5.5).

**Scope isolation is structural, not a runtime check.** Two different scopes are two entirely
separate SQLite databases (two different DO instances) — there is no code path inside `ContextIndex`
that could leak one scope's entry into another's lookup. A bug there would have to be `routes/relay.ts`
routing to the wrong DO instance, a distinct, separately-tested failure mode.

**RPC, not `fetch()`.** Converted from a `fetch()`-handler DO to real RPC methods (`lookup`, `store`)
during this project's Cloudflare best-practices pass — current Cloudflare guidance favors RPC when
no WebSocket upgrade is needed, and it removed an entire layer of manually-constructed fake `Request`
objects that existed only to satisfy the old `fetch()` interface.

**Fail-open, precisely scoped.** A genuine cache miss and an index *failure* (the RPC call throws)
both converge on "nothing served from cache, fall through to a real origin call" — logged under
different `cache_log` outcomes (`miss` vs. `fail-open`) so a sustained run of index failures stays
visible rather than blending into ordinary cold-cache traffic. What is never papered over: if the
real origin call itself fails, that surfaces as a genuine `502`, and nothing gets cached.

**Proven against a real origin, not a mock.** `origin-simulator`'s `resource_lookup` tool returns a
monotonically increasing call counter that only advances on a genuinely new call — this is what
makes "this response came from cache" independently verifiable, not inferred from response time
alone. `cacheSharingAgent.ts` drives two distinct logical callers through the real stack end to end;
a second caller's identical request in the same scope hits the first caller's cached entry,
byte-identical, same `originCallSeq`, roughly **14× faster** (the simulator adds a real 250ms
artificial tool latency specifically so the saving is measurable, not theoretical).

### 5.4 AuditLog Durable Object — tamper-evident, hash-chained decision log

**File:** `apps/gateway/src/do/AuditLog.ts`. A single global instance (`idFromName("global-v3")`,
bumped twice from the original name to shed accumulated test data, never to hide real data). The
name is `-v3` specifically because a hash chain's entire value proposition — "prove nothing was
altered" — only means something for one continuous sequence; sharding it would weaken that claim to
"nothing in this one shard was altered," which is a different, less useful guarantee.

**Why a Durable Object, not another D1 table.** Computing `entryHash = BLAKE3(prevHash +
canonicalEntry)` correctly requires reading the previous hash and writing the new row with **no
`await` in between**, so no concurrently-appending caller can race between the read and the write. A
single DO instance's single-threaded execution model provides this as a structural guarantee; D1,
reached from potentially many concurrent Worker invocations, would need its own separate
coordination layer to offer the same thing — which would just be reimplementing what a DO already
provides.

```sql
CREATE TABLE entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER,
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
)
```

- `GENESIS_HASH` = 64 zero characters; the first real entry chains to this.
- `append()`: synchronous body — `SELECT ... ORDER BY seq DESC LIMIT 1` immediately followed by the
  `INSERT`, no `await` between them.
- `verify()`: walks the entire table in `seq` order, recomputes each row's expected hash from its own
  stored fields and the *previous row's stored hash*, and compares against what's actually stored,
  never trusting the storage layer. An edited row (content changed, `entry_hash` left stale) fails
  exactly at that `seq`. A deleted row breaks the chain one row later, at the first surviving row
  whose claimed `prev_hash` no longer has anything to have recomputed from.
- Both tamper scenarios are proven with tests that mutate the underlying SQLite table directly via
  `runInDurableObject`, not through the class's own public API — the test genuinely exercises "a
  tamperer with row-level access," not just "a bug in `append`."

**`agentId`/`agentName` are never taken from the request body** — only from the caller's own
resolved credential (§5.7). An audit log that let a caller claim to be someone else would be
worthless as an audit log.

### 5.5 Rust/WASM engine

**Crate:** `crates/mcp-relay-engine`, 680 lines across 4 files, 30 unit tests, `cargo clippy
--all-targets` clean. Two responsibilities, both genuinely hot-path, both worth testing natively
before compilation:

1. **Incremental, chunk-boundary-safe SSE parsing** (`sse_framing.rs`, 301 lines). An SSE event can
   legally split across two chunk boundaries at any byte offset, including mid-field-name or
   mid-line-terminator — this is a real incremental parser for that, tested against exactly those
   boundary cases (`split_mid_field_name`, `split_exactly_between_the_two_newlines_of_the_blank_line`,
   `split_exactly_between_cr_and_lf_of_a_crlf_terminator`, among others).
2. **BLAKE3 content hashing** (`hash.rs`, 78 lines, 5 tests including the published BLAKE3
   empty-input test vector, asserted as a known value — a future dependency bump that silently
   changed the algorithm would be caught).

**The Cloudflare-bundler `wasm-pack` mismatch.** `wasm-pack build --target bundler` generates glue
assuming webpack's wasm-loader semantics (`import * as wasm from "*.wasm"` yielding an
already-instantiated exports object). Cloudflare Workers' own bundler instead resolves a `.wasm`
import to a raw, *uninstantiated* `WebAssembly.Module`, confirmed against Cloudflare's own docs — the
generated entry point fails at top level with `wasm.__wbindgen_start is not a function` the moment
it's imported, unmodified. The fix (`apps/gateway/src/lib/wasmEngine.ts`) instantiates the module
directly against the exact import object the compiled binary actually declares, verified via
`WebAssembly.Module.imports()` rather than guessed.

**Why the replay buffer is NOT also implemented in WASM**, despite the same crate having a reference
`ring_buffer.rs` (235 lines, 25 tests): the buffer has to survive DO hibernation and eviction, and
routing it through WASM's linear memory would mean manually serializing the whole buffer to durable
storage around every call. `FeedRelay` reimplements the buffer natively in TypeScript against
`ctx.storage.sql` instead — the SSE parser's state is fine to lose on a genuine restart (equivalent
to a reconnect anyway); the replay buffer's state is not.

### 5.6 D1 schema — full, all 4 tables

| Table | Migration | Purpose | Key columns |
|---|---|---|---|
| `delivery_log` | `0000_delivery_log.sql` | Every delivered event, gap, reconnect | `feed_key`, `entry_type` (CHECK: event/gap/reconnect), `seq`, `occurred_at` |
| `agent_log` | `0001_agent_log.sql` | Demo agent activity/decisions | `feed_key`, `agent_name`, `agent_role`, `action_type` (CHECK: resync/reconnect_verified/order_check/summary/error) |
| `cache_log` | `0002_cache_log.sql` | Every `/relay` call outcome | `scope`, `request_hash`, `outcome` (CHECK: hit/miss/fail-open), `byte_size`, `latency_ms` |
| `agent_credentials` | `0003_agent_credentials.sql` | Per-agent scoped credentials | `token_hash` (SHA-256, UNIQUE), `scope_origin_host`, `scope_category`, `can_subscribe`, `can_relay`, `revoked_at` |

Deliberately four separate append-only tables rather than one wide table with a discriminator column
— `delivery_log` is the relay's own record of what it did, independent of who's listening;
`agent_log` is a consumer's record of how it reacted; `cache_log` is a genuinely different subject
(a caller's cache outcome); mixing any of them would blur "what the relay guarantees" with "what one
particular thing chose to do about it."

`agent_credentials.revoked_at` is a nullable timestamp, never a `DELETE` — revoking a credential
needs to be immediate *and* auditable (the row's continued existence, with a `revoked_at` set, is
itself the record that the credential was once issued). Deleting the row would make "was this
credential ever issued" unanswerable later, which a system calling itself audit-safe can't have in
its own access control.

Every read route (`delivery-log`, `agent-log`, `cache-log`) builds its `WHERE` clause from static
`"field = ?"` fragments with real values passed exclusively through `.bind()` — confirmed clean of
SQL injection risk across all three during the security audit (§12).

### 5.7 Auth and credential model

Two layers, the newer one strictly additive:

1. **Legacy shared token** (`SUBSCRIBE_TOKEN`, a Worker secret via `wrangler secret put`, never a
   plaintext `[vars]` entry). Compared via `crypto.subtle.timingSafeEqual` against a SHA-256 digest
   of the caller-provided token — a real, non-standard Workers API extension, replacing an earlier
   hand-rolled constant-time XOR loop. Explicitly fails closed if `SUBSCRIBE_TOKEN` itself is unset
   (see §12's documented historical bug on why this guard exists).
2. **Per-agent scoped credentials** (`agent_credentials` in D1). `resolveCredential` checks this
   table first — an indexed exact-match lookup on a SHA-256 hash, never the plaintext token — before
   falling back to the legacy check. A D1 failure (unreachable, or the table doesn't exist in an
   older environment) falls through to the legacy check, the same fail-open-on-infrastructure-hiccup
   principle applied to the rate limiter and cache index elsewhere in this codebase. A **missing
   token**, by contrast, is rejected immediately, before either path runs — fail-open only ever means
   "try the other real credential system," never "authorize anyone."

`checkScope`, applied after `resolveCredential` succeeds: an unrestricted credential
(`scope_origin_host`/`scope_category` both `NULL`) passes any origin/category; a scoped one is
checked against the real parsed hostname of the requested `originUrl`, never a string a caller could
spoof through some other field. `can_subscribe`/`can_relay` separately gate the two routes — a
caller that only needs to watch a feed has no legitimate reason to also trigger `/relay`'s discrete
tool-call path.

**A real regression, caught by the test suite, not manual review:** changing `isAuthorized`'s return
type from `boolean` to a result object silently broke seven pre-existing call sites
(`agentLog.ts` ×3, `deliveryLog.ts` ×2, `cacheLog.ts` ×2) still written as
`if (!(await isAuthorized(...)))` — always `false` against a truthy object, meaning every one of
those routes would have started authorizing every caller unconditionally. The existing 401 tests for
those routes failed immediately; the fix was `.authorized` added to each call site.

### 5.8 Rate limiting

Cloudflare's real Workers Rate Limiting API (`[[unsafe.bindings]]`, `type = "ratelimit"`,
`simple = { limit = 30, period = 60 }`), not a hand-rolled counter — free on every plan, and the
platform tracks the window itself. One binding, two independently-bucketed keys
(`subscribe:<clientIP>` and `relay:<clientIP>`), so exhausting one route's budget never touches the
other's. Runs in "remote" mode under local `wrangler dev`, meaning it needs real Cloudflare auth to
answer and hangs (doesn't error) if it can't reach it — the check is wrapped in a 500ms `Promise.race`
against a timeout and fails open on either a timeout or a thrown error, the same
infrastructure-hiccup-degrades-availability principle applied elsewhere. Live-verified, not just
locally: driven past the limit against the real production gateway using the caller's own real client
IP (Cloudflare's edge rejects a client-supplied `CF-Connecting-IP` header outright with error 1000,
so the rate-limit key can't be spoofed).

### 5.9 Observability

`[observability] enabled = true, head_sampling_rate = 1` on every deployed Worker in both repos
(gateway, origin-simulator, dashboard, fraud-ops origin, fraud-ops console) — structured logs and
traces captured for every request at this traffic volume, not sampled down, since none of these
Workers are close to the traffic level where sampling would matter for cost.

---

## 6. Fraud Ops — Component Deep Dive

### 6.1 Origin — deterministic synthetic signal generator

**File:** `origin/src/index.ts`, 352 lines, single Durable Object (`FraudOrigin`, `idFromName
("singleton")`). Emits raw transaction-fraud signals over the real `subscriptions/listen` shape —
zero verdicts. Every emitted event is exactly
`{caseId, entityId, signalType, severity, occurredAt, globalSeq}` (plus an optional `amount` on a
case's opening signal); the origin has no concept of a case's overall risk at all. An earlier
version of this file decided escalate/clear itself, which made the whole project a demo of the relay
rather than a demo of a real agent reasoning over raw data — removed entirely.

**Deterministic, wall-clock-driven, replayable.** A seeded `mulberry32` PRNG (not
`Math.random()` — same seed produces the identical sequence every time) is replayed from tick 1 up to
the current tick on every evaluation. `trueTickNumber()` = `(Date.now() - EPOCH_MS) / 2400ms`. This
is what lets two independent connections (the naive panel and the relay panel) derive the exact
identical event stream with zero shared server-side broadcasting state — confirmed directly by a
unit test asserting `computeEventForTrueTick(N)` called twice returns identical output.

**Generation rules**, each independently verified by a dedicated test walking a full 2,250-tick cycle:

- At most `MAX_ACTIVE_CASES = 5` cases open at once.
- A case stops producing signals after `MAX_SIGNALS_PER_CASE = 6`.
- A case's **opening** signal severity is deliberately mild: `5 + rng() × 30` (range 5–35) —
  "most real transactions start out looking fine."
- Every **subsequent** signal's severity is a flat, independent, uniform `rng() × 100` (0–100) — no
  memory of the case's prior signals, no running score. Whether a run of signals should raise
  suspicion is entirely the triage agent's call.
- The 6 signal types (`velocity_anomaly`, `device_mismatch`, `impossible_travel`,
  `known_bad_actor_link`, `chargeback_pattern`, `new_payee_high_value`) are picked uniformly at
  random per signal, independent of severity.

**Cyclic replay.** The deterministic story replays fully bounded at `CYCLE_TICKS = 2250`
(2,250 × 2.4s ≈ 90 minutes), then repeats — bounding replay cost forever rather than letting it grow
with real elapsed time since the epoch. `globalSeq`/timestamps shown to a viewer still derive from
the **true**, non-cyclic tick count, confirmed by test to keep advancing normally and never repeat,
even exactly at a cycle boundary.

**Two real production bugs, found and fixed** (full detail in `origin/src/index.ts`'s own top
comment and `fraud-ops/README.md`):

1. Isolate affinity on the outage window (see §2.3) — fixed by making the origin a single Durable
   Object.
2. A background timer scheduled through a shared module-scope function invoked across separate
   requests silently never emitted a byte once deployed ("the Workers runtime canceled this request
   because it detected that your Worker's code had hung"). Fixed by giving every open connection its
   own inline timer loop, entirely local to its own stream.

### 6.2 Agents — the real LangGraph.js triage agent

**Package:** `agents/`, 709 lines across production + test code. The one piece of this whole system
that makes an actual autonomous decision.

**State graph** (`triageGraph.ts`, 181 lines): a real `@langchain/langgraph` `StateGraph`, not an
if-statement pretending to be one.

- `TriageState` (`Annotation.Root`): `caseId`, `entityId`, `currentSignal`, `signalHistory` (a
  *concatenating* reducer — each invocation appends the new signal to what the checkpointer already
  restored, rather than overwriting), `assessment`, `decision`.
- Five nodes reached by a real conditional edge: `ingestSignal` → `assessRisk` → one of
  `escalate`/`clear`/`monitor`.
- `MemorySaver` checkpointer, keyed by `caseId` as the LangGraph `thread_id` — a case's accumulated
  signal history genuinely persists across separate signal-arrival events instead of reasoning blind
  each time. **Stated scope cut, not glossed over:** in-process only, not durable across an agent
  restart.
- Routing policy (`routeByRisk`): `high` risk escalates unconditionally; `medium` escalates once 3+
  signals have accumulated; `low` clears once 4+ signals have accumulated with no escalation; anything
  else stays `monitor`.
- `retryPolicy` on `assessRisk` only — the one node with a real network failure mode
  (`{maxAttempts: 3, initialInterval: 500, backoffFactor: 2, jitter: true}`).

**A real, found-and-fixed prompt-calibration bug.** Live testing showed the model rating signals
"high" risk based on how alarming a signal *type label* sounded (`known_bad_actor_link`,
`impossible_travel`) rather than the actual, independently-random severity number attached to it —
concretely, two `velocity_anomaly` signals at severity 24 and 51 were rated "high" on timing alone.
The prompt now explicitly instructs the model to treat the severity number as primary evidence and
timing/type as corroborating context only, not a verdict on its own.

**Model resilience — three distinct, independently verified layers** (`openRouterClient.ts`, 92
lines):

1. **Retry, same model** — the graph's own `retryPolicy` above; verified live via real backoff logs.
2. **Fallback, different model** — `nvidia/nemotron-3.5-lightning:free` (primary, live-verified
   against the real triage-prompt shape) → `google/gemma-4-31b-it:free` → `z-ai/glm-5.2:free`, all
   three model IDs confirmed real against OpenRouter's live `/api/v1/models` listing. Implemented via
   LangChain's real `RunnableLambda.withFallbacks()`, not a hand-rolled try/catch chain. **Honestly
   unverified:** the fallback *mechanism* is verified with `fetch` stubbed (correct call order,
   correct result selection, correct rejection when every tier fails) — an actual live completion
   from either fallback model under real conditions has not happened yet, because the shared
   free-tier daily quota that would trigger it in practice was exhausted by testing before either
   model got a real turn.
3. **Shared throttle** — every outbound call, primary or fallback, passes through one shared
   minimum-interval gate (3.5s) before firing, because OpenRouter's free-tier per-minute limit (20
   req/min, confirmed live via a real `429`) turned out to be shared account-wide across every
   `:free` model, not per-model. Refactored to per-`buildModelCaller`-instance closure state
   (`createThrottle`) specifically so tests could use a short interval without leaking state between
   tests — production still only ever calls `buildModelCaller` once, so real behavior is unchanged.

### 6.3 Console — operator UI

**Package:** `console/`, 1,204 lines across production + test code. React 19 + Tailwind v4 on Vite,
deployed to Workers Static Assets.

- **Naive Feed panel** (`naiveClient.ts`): a genuine, unmodified raw MCP client — POSTs
  `subscriptions/listen` directly to the origin's `/mcp` from the browser, parses the SSE stream with
  a minimal string-buffered parser. **Verified, not assumed**, during this project's own test-writing
  pass: the buffer-then-split-on-blank-line approach correctly reassembles a frame whose bytes land
  split across two separate `read()` calls — an earlier comment claiming "no chunk-boundary safety"
  was checked directly and found false, and corrected rather than left standing. The real
  naive-vs-relay distinction stays what it always was: the complete absence of any resumability
  contract, not fragile parsing.
- **Relay Feed panel** (`relayClient.ts`): subscribes through the real deployed gateway's
  `/subscribe` WebSocket, the identical protocol the triage agent itself uses. Renders the gap
  banner's "N real signals happened during the drop" number from `computeGapJump`, a pure function
  diffing the origin's own honest `globalSeq` counter before and after a gap.
- **Agent Reasoning panel** (`AuditTrailPanel.tsx`): polls `/api/audit-log` for the triage agent's
  real decisions and reasoning, plus a "Verify integrity" button calling `/api/audit-log/verify`.
  `isVerifyResultStale` compares the last-verified `checkedCount` against the live polled entry count,
  so a stale result (new entries arrived since the last check) is shown honestly amber rather than
  silently displaying an outdated "intact" number forever.
- **Settings** (`settings.ts`): the gateway token defaults to empty and is stored only in
  `localStorage`, never baked into the built bundle — confirmed directly by downloading and grepping
  the actual live deployed JS bundle for known real secret values during this project's security
  audit (§12), zero matches.

---

## 7. Cross-System Integration

### 7.1 Full request/data flow, one signal end to end

```
1. FraudOrigin DO (fraud-ops)         computes a deterministic signal for the current tick
2. FraudOrigin DO                     pushes it as an SSE `notifications/transaction-signals` frame
                                       to every open /mcp subscriber, including the gateway's own
                                       upstream FeedRelay connection
3. FeedRelay DO (harness-way)         receives it via the WASM SSE parser, writes it into its
                                       replay buffer (ctx.storage.sql), fans it out to every
                                       downstream WebSocket subscriber -- the console's Relay Feed
                                       panel AND the triage agent, both real, independent /subscribe
                                       connections through the SAME FeedRelay instance
4. triage agent (fraud-ops)           receives the event over its own /subscribe WebSocket,
                                       invokes the LangGraph with { thread_id: caseId }
5. triageGraph                        ingestSignal -> assessRisk (real OpenRouter call, retry/
                                       fallback/throttle per S6.2) -> routeByRisk -> a decision node
6. agent (auditClient.ts)             POSTs the decision to the gateway's /api/audit-log,
                                       authenticated with its OWN scoped credential (S5.7)
7. AuditLog DO (harness-way)          appends the entry, hash-chained to the previous real entry,
                                       attributed to the agent's real resolved identity
8. console (fraud-ops)                polls /api/audit-log, renders the decision + reasoning live
                                       in the Agent Reasoning panel
```

Steps 1–3 are pure infrastructure (harness-way's job); steps 4–6 are the one piece of real
autonomous decision-making in the whole system; steps 7–8 are the accountability layer, also
harness-way's infrastructure, consumed by a `fraud-ops`-owned identity.

### 7.2 Shared conventions between the two repos

- **Identical event-generation pattern**: both origins (harness-way's `origin-simulator` and
  fraud-ops's `origin`) use the same deterministic-wall-clock-tick + per-connection-local-timer
  pattern, arrived at independently in each repo after hitting the same isolate-affinity class of bug
  twice.
- **Identical service-binding fix**: both `fraud-ops-origin` and `origin-simulator` needed a
  Cloudflare service binding (not plain `fetch()`) to be reachable from the gateway, for the
  identical error-1042 reason (§8.7).
- **Identical "verify, don't assume" testing discipline**: every package in both repos now has a
  real automated test suite exercising either a real `workerd` runtime (gateway, fraud-ops origin) or
  fully-stubbed network calls (fraud-ops agents, fraud-ops console) — never a bare assertion that
  something "should" work.
- **Identical clean-slate convention**: both repos have, at different points, bumped a Durable
  Object's `idFromName()` string (the relay's feed category, the audit log's instance name) to shed
  accumulated test/debug data without deleting anything — a documented, repeatable pattern, not a
  one-off hack.

### 7.3 Service binding topology

```
gateway (harness-way)
  ├─[env.production].services.ORIGIN_SIMULATOR  → mcp-relay-harness-origin-simulator
  └─[env.production].services.FRAUD_OPS_ORIGIN   → fraud-ops-origin
```

Both bindings exist for the identical reason: the gateway's own `fetchOrigin.ts` checks the target
hostname against `ORIGIN_SIMULATOR_HOST`/`FRAUD_OPS_ORIGIN_HOST` and, only for those two known hosts,
dispatches through the service binding instead of a plain `fetch()` — every other allowlisted origin
(a real external MCP server, never itself another Worker on this account's zone in practice) still
goes through the unchanged, general-purpose `fetch()` path.

---

## 8. Cloudflare Platform Usage

### 8.1 Workers

Both repos' compute layer is 100% Cloudflare Workers — no origin server, no container, no VM
anywhere in the deployed system. `compatibility_date` pinned per-service (`2026-08-01` for gateway/
origin-simulator/fraud-ops-origin, `2026-08-20` for the dashboard), `compatibility_flags =
["nodejs_compat"]` on the gateway specifically (needed for D1's Node-compatible APIs).

### 8.2 Durable Objects — SQLite storage class

Four DO classes across the two repos, every one provisioned via `new_sqlite_classes` in a
`[[migrations]]` block (the SQLite storage class, not the older key-value storage class):

| Class | Repo | Instancing key | Purpose |
|---|---|---|---|
| `FeedRelay` | harness-way | `(originUrl, category)` via `idFromName` | Multiplexing + replay buffer |
| `ContextIndex` | harness-way | `scope` via `idFromName` | Content-addressed cache |
| `AuditLog` | harness-way | Single instance, `idFromName("global-v3")` | Hash-chained decision log |
| `FraudOrigin` | fraud-ops | Single instance, `idFromName("singleton")` | Deterministic signal generator + outage state |

Every DO's schema is created via `blockConcurrencyWhile` in the constructor (`CREATE TABLE IF NOT
EXISTS ...`) — safe to re-run, guarantees the schema exists before the instance serves its first
real request. `FeedRelay` and `ContextIndex` use hibernatable WebSockets (`ctx.acceptWebSocket`) for
their downstream connections; `AuditLog` and `FraudOrigin` are RPC-only (`AuditLog`) or SSE-stream-only
(`FraudOrigin`), no WebSocket surface.

**Migration tags are sequential and additive, never retroactively rewritten**: `v1` (`FeedRelay`
alone) → `v2` (adds `ContextIndex`) → `v3` (adds `AuditLog`), because Durable Object migrations
describe a delta from the previous state, not a full restatement — retroactively adding a class to
`v1` would be incorrect for any environment where `v1` had already run.

### 8.3 D1

One database (`mcp-relay-harness-delivery-log`, real ID `e14b2ccd-c9a7-4cee-a6bb-9d42c6698e9d`,
created against the live account on 2026-08-22), four tables (§5.6). `withSession("first-primary")`
used for delivery-log writes specifically for bookmark-based sequential consistency, since the
dashboard reads shortly after the write and needs to see it. **A real, confirmed-by-testing trap**:
neither `wrangler dev` nor `wrangler deploy` auto-applies SQL migrations — a fresh D1 state genuinely
404s with "no such table" until `wrangler d1 migrations apply` has run at least once; the project's
own `npm run dev`/`npm run deploy` scripts chain this automatically (fast, idempotent once already
applied) specifically to avoid this trap for anyone running the npm scripts rather than bare
`wrangler` commands directly.

### 8.4 Workers Static Assets

Both the dashboard (harness-way) and console (fraud-ops) deploy as Workers Static Assets — a React
SPA built with Vite, `not_found_handling: "single-page-application"` so client-side routing works
correctly on a hard refresh of a non-root path. Verified bundle size, gzip: console 66.3 KiB,
dashboard not separately measured in this pass (both comfortably inside any relevant size limit for
a static-assets deployment).

### 8.5 Rate Limiting API

Covered in depth in §5.8. Notable Cloudflare-specific detail: at the time of this build, the Rate
Limiting API had not yet been promoted out of `[[unsafe.bindings]]` into a dedicated top-level config
table in the installed `wrangler` version (4.123.0) — confirmed by `wrangler deploy --dry-run`, which
resolves it correctly as a real `ratelimit` binding despite the "unsafe/experimental" label wrangler
prints for it.

### 8.6 Observability

Covered in §5.9. `head_sampling_rate = 1` (capture everything) on every Worker in both repos —
appropriate at this traffic volume; a genuinely high-traffic deployment would lower this to control
cost, and this system is nowhere near that threshold.

### 8.7 Service bindings — the error-1042 fix, applied twice

Cloudflare rejects a plain `fetch()` from one Worker to another Worker's public URL when both share
the same `workers.dev` zone (error 1042, a real loop-prevention restriction, confirmed live during
deployment by inspecting the actual response body). A service binding routes Worker-to-Worker calls
internally, bypassing this restriction entirely — Cloudflare's own recommended pattern for exactly
this shape. Applied for `ORIGIN_SIMULATOR` (harness-way's own dev origin) and again for
`FRAUD_OPS_ORIGIN` (a separate repo's Worker, same account, same zone) — the second instance was not
copy-pasted blindly; `fetchOrigin.ts`'s hostname-check logic was verified to correctly branch to
whichever binding matches the requested origin, falling through to plain `fetch()` for every other
allowlisted host.

### 8.8 Free-tier cost analysis

| Service | Bundle size (gzip) | % of 3 MiB Workers cap |
|---|---|---|
| Gateway | 32.8 KiB | 1.07% |
| Fraud Ops console | 66.3 KiB (66.22 KiB build output confirmed) | 2.16% |

Real dry-run output, gateway: `Total Upload: 91.58 KiB / gzip: 32.75 KiB`, with bindings resolved as
`FEED_RELAY`/`CONTEXT_INDEX`/`AUDIT_LOG` (Durable Objects), `DB` (D1), `ORIGIN_SIMULATOR`/
`FRAUD_OPS_ORIGIN` (service bindings), `RATE_LIMITER` (unsafe/ratelimit metadata), plus three
environment variables.

---

## 9. Load Balancing & Scaling Model

### 9.1 How "sharding" actually works here

There is no traditional load balancer anywhere in this system — Cloudflare's edge network and the
Durable Objects routing model together are the load-balancing mechanism. Each `FeedRelay`/
`ContextIndex` instance is addressed by a deterministic key (`idFromName`) derived from the request's
own parameters (`(originUrl, category)` or `scope`), so Cloudflare's own object-location service
routes every request for the same logical feed/scope to the exact same DO instance, wherever it
currently lives, without this codebase implementing any routing logic of its own. Different feeds/
scopes naturally land on different DO instances, which Cloudflare distributes and can run
concurrently — this is the system's actual horizontal scaling mechanism: **scale by number of
distinct feeds/scopes, not by throughput on a single one.**

### 9.2 Concurrency guarantees, precisely stated

- **Within one DO instance**: single-threaded execution guarantees no two `append()` calls (AuditLog)
  or upstream-connection-start checks (FeedRelay) ever race, with zero application-level locking code.
- **Across DO instances**: fully independent, fully concurrent — a slow or overloaded feed's DO
  instance has no way to affect a different feed's instance.
- **What this does NOT guarantee**: throughput on a single hot feed/scope beyond what one DO
  instance can sustain. This system has not been load-tested for that specific scenario (many
  concurrent subscribers on the *same* feed) — the load test in §9.3 exercises HTTP API endpoints,
  not WebSocket fan-out concurrency, and is stated as a real, unclosed gap in §14.

### 9.3 Real load test data

Run against the live `mcp-relay-harness-gateway-production` deployment from a separate machine, not
a synthetic benchmark environment:

| Endpoint | Concurrency | Result |
|---|---|---|
| `GET /api/audit-log` (D1 read) | 20 | 100/100 succeeded. p50 106ms, p90 227ms, p99 316ms |
| `GET /api/audit-log/verify` (full hash-chain walk + BLAKE3 rehash of every entry) | 20 | 100/100 succeeded. p50 237ms, p90 258ms, p99 268ms — a higher, steadier floor than the plain read (real CPU-bound work over every entry, not one indexed row), but tighter tail variance |
| `GET /api/audit-log`, concurrency sweep | 5 → 20 → 50 | p50: 127ms → 92ms → 186ms. p99: 286ms → 198ms → 370ms. Roughly flat through 20 concurrent readers, visibly (not catastrophically) degrading at 50 |
| `POST /relay` (Rate Limiting, configured 30 req/60s) | 40 sequential, one IP | First 31 reached application logic (rejected there for an unrelated, intentionally-invalid demo payload); request 32 onward correctly returned real `429`s from the live Workers Rate Limiting API |

The rate-limiting result is the structurally important one: it's proof the binding declared in
`wrangler.toml` actually enforces its configured limit against live production traffic, not merely
that the config exists and was never exercised.

### 9.4 Known scaling limits, stated rather than hidden

- **Upstream-residency cost, unmeasured.** Hibernation covers a DO's incoming downstream WebSocket
  connections; it does **not** cover the DO's own outgoing leg — the upstream `subscriptions/listen`
  connection is a `fetch()` with a streamed body the DO has to actively keep reading, which keeps the
  instance resident the whole time that connection is open, independent of downstream subscriber
  count. This is a real, measurable Durable-Object-billing cost that has not yet been measured
  against real sustained load. Tracked explicitly as an open item, not silently dropped.
- **No platform signal for a genuinely slow downstream client** (§5.2) — the bounded per-socket queue
  bounds memory and guarantees signaling, but cannot detect or specifically react to network-level
  slowness in one subscriber.
- **Single-DO-instance throughput ceiling on one hot feed**, not yet load-tested (§9.2).

---

## 10. DevOps & Deployment

### 10.1 Local development, per service

```bash
# harness-way
cd apps/gateway && npm run build:wasm        # builds the Rust/WASM engine gateway depends on
cd apps/origin-simulator && npm run dev      # terminal 1, pinned port 8794
cd apps/gateway && npm run dev               # terminal 2, pinned port 8787, auto-applies D1 migrations locally
cd apps/dashboard && npm run dev             # terminal 3
cd apps/agents && npm run dev                # terminal 4, optional, four demo consumers

# fraud-ops
cd origin && npm run dev                     # pinned port 8801
cd console && npm run dev
cd agents && npm run dev                     # requires AGENT_TOKEN + OPENROUTER_API_KEY in .env
```

Every dev port across both repos is pinned via an explicit `[dev]` block, never left to `wrangler`'s
default-with-auto-increment behavior — found necessary by testing, not assumed: with no pinned port,
two Workers starting close together race for the same default port, and the loser silently lands one
port over with no error, breaking every hardcoded reference to it across dashboards, READMEs, and
allowlists.

### 10.2 Deployment, per service

```bash
# harness-way
cd apps/origin-simulator && npx wrangler deploy
cd apps/gateway
  npx wrangler d1 create mcp-relay-harness-delivery-log   # first time only
  npx wrangler secret put SUBSCRIBE_TOKEN --env production
  npm run deploy    # chains: db:migrate:remote, then wrangler deploy --env production
cd apps/dashboard && npm run build && npx wrangler deploy

# fraud-ops
cd origin && npx wrangler deploy
cd console && npm run build && npx wrangler deploy
```

### 10.3 Environment management

The gateway is the only service with a named environment (`[env.production]`) — required because
named environments in the installed `wrangler` version do **not** inherit `vars`,
`durable_objects`, `d1_databases`, or `unsafe` from the top level (confirmed by
`wrangler deploy --dry-run --env production`; wrangler's own config warning lists exactly these four
as needing to be repeated). Both the top-level and `[env.production]` copies of every such binding
are kept in the same file, immediately adjacent, specifically so drift between them is easy to spot
in review rather than easy to miss across two separate files.

### 10.4 Secrets management

| Secret | Mechanism | Never appears in |
|---|---|---|
| `SUBSCRIBE_TOKEN` | `wrangler secret put --env production` | Git history, `wrangler.toml`, any built client bundle |
| `AGENT_TOKEN` (fraud-ops agent) | `.env`, gitignored | Git history (confirmed via `git log --all`), built console bundle |
| `OPENROUTER_API_KEY` | `.env`, gitignored | Same |

Confirmed directly this session, not assumed: `git log --all --diff-filter=A --name-only` across
both repos for any `.env`/`.dev.vars` file ever added returns zero results; the actual live deployed
console JS bundle was downloaded and grepped for the real known secret values in use during this
project, zero matches.

### 10.5 Migration workflow

`npm run dev` / `npm run deploy` in `apps/gateway` chain `db:migrate:local` / `db:migrate:remote`
automatically before starting/deploying — bare `wrangler dev`/`wrangler deploy`, bypassing the npm
scripts, will hit the "no such table" trap described in §8.3.

---

## 11. Testing & Quality Assurance

### 11.1 Testing philosophy

**Real runtime over mocks, everywhere it's feasible.** The gateway and fraud-ops origin are tested
via `@cloudflare/vitest-pool-workers` against the actual `workerd` runtime, with real Durable Object
and D1 binding behavior — not a Node-side simulation of Cloudflare's platform. This is what caught
real, runtime-specific bugs (the WebSocket-close timing issue documented in `ARCHITECTURE.md`, the
isolate-affinity bugs in §2.3) that a plain Node test runner would never have reproduced. Where a
real runtime genuinely isn't the right tool (fraud-ops's `agents` and `console` packages — a LangGraph
process and a React SPA, neither of which needs `workerd`), pure logic is extracted into named,
exported functions and unit-tested directly with `fetch` stubbed out, rather than either skipping
tests or standing up a heavier integration harness than the logic warrants.

### 11.2 Full test inventory

| Suite | Framework | Runtime | Count | What it proves |
|---|---|---|---|---|
| Gateway | Vitest | Real `workerd` (`@cloudflare/vitest-pool-workers`) | **144/144** | Multiplexing, replay, gap marking, credential scoping, hash-chain tamper detection, rate limiting logic |
| Rust engine | `cargo test` | Native | **30/30** | SSE chunk-boundary parsing, ring buffer, BLAKE3 (incl. published test vector) |
| Chaos harness | `pytest` | Native, drives real processes | **28/28** (1 deselected — requires live infra) | No silent gaps, no duplicate/out-of-order sequences across real kill/reconnect scenarios |
| Fraud Ops agents | Node's native test runner | Native, `fetch` stubbed | **16/16** | Graph routing thresholds, checkpointer isolation, retry-then-succeed, fallback cascade order/timing |
| Fraud Ops origin | Vitest | Real `workerd` | **14/14** | Deterministic generation math, business-rule bounds across a full cycle, real HTTP/outage behavior |
| Fraud Ops console | Vitest | Node, no DOM | **28/28** | SSE parsing (incl. cross-chunk reassembly), gap-jump math, severity bands, stale-verify detection |
| **Total** | | | **260/260** | |

Plus three real, recorded chaos-engineering runs against live infrastructure (not simulated):
`upstream-outage` (68 messages, 0 violations), `upstream-outage` (64 messages, 0 violations),
`downstream-flap` (122 messages, 0 violations) — "violations" meaning any silent gap, duplicate
sequence number, out-of-order delivery, or self-inconsistent replay.

---

## 12. Security Model

### 12.1 Threat model, stated explicitly

**In scope, actively defended against**: SSRF via caller-supplied origin URLs (§5.7's `isAllowedOrigin`
allowlist), credential forgery/replay (SHA-256 hashing, never plaintext storage; timing-safe
comparison on the legacy path), audit-log tampering (the hash chain, §5.4), unauthenticated access to
any data-bearing route (every route funnels through the same auth check, §5.1), SQL injection (100%
parameterized queries, confirmed by direct code review of every `.prepare()`/`.exec()` call site).

**Explicitly out of scope, stated rather than hidden**: DDoS/resource-exhaustion attacks (excluded
from this project's own security review criteria as a documented convention, and Cloudflare's edge
network is the actual first line of defense here regardless); the legacy shared-token model itself
being weaker than true per-caller identity (a known, stated v1 gap, now layered over by real scoped
credentials, not yet fully replaced); prompt injection into the LLM (not a live attack surface today —
the origin's signal content is entirely synthetic and self-generated, not externally attacker-
controlled, so there is no path for untrusted input to reach the triage prompt in the current
architecture).

### 12.2 A full manual audit was performed and is current as of this document

Methodology: direct code review across both repositories against the standard categories (SQL/
injection, auth/authz, secrets, SSRF, XSS, timing side-channels, CORS), each claim verified against
the actual source rather than assumed from a comment, cross-checked with live verification wherever
possible (downloading and grepping the actual deployed bundle, tracing the actual call graph of
`isAuthorized`).

**Result: zero high-confidence exploitable findings.** Specific checks performed:

- Every D1 query building a dynamic `WHERE` clause was confirmed to interpolate only static
  `"field = ?"` fragments, with real values passed exclusively through `.bind()`. The one
  template-literal SQL interpolation found in the entire codebase is in a test-only helper, always
  called with a hardcoded literal.
- `isAuthorized` was traced end-to-end (`isAuthorized` → `resolveCredential` → `checkScope`) to
  confirm zero implementation drift between the exported wrapper and the real logic, and to confirm
  the audit log's `agentId`/`agentName` fields are populated exclusively from the resolved credential,
  never from request body content.
- `isAllowedOrigin`'s exact-host allowlist matching was confirmed genuinely reused (not duplicated or
  weakened) by both `/subscribe` and `/relay`.
- Zero occurrences of `dangerouslySetInnerHTML`, `eval()`, or `new Function()` anywhere in either
  repository.
- The live deployed Fraud Ops console JS bundle was downloaded directly and grepped for two real
  secret values in active use during this project (the agent's scoped credential, the OpenRouter API
  key) — zero matches, confirming the "token never baked into the build" design claim in `settings.ts`
  holds in production, not just in source.
- `git log --all` across both repositories confirmed zero `.env`/`.dev.vars` files were ever
  committed.
- `buildFeedKey`'s use of `JSON.stringify([originUrl, category])` (rather than string concatenation)
  was confirmed to prevent feed-key collisions between different `(originUrl, category)` pairs.

**Two items noted, deliberately not reported as findings, both for stated reasons**: the
`Access-Control-Allow-Origin: "*"` on the log/audit read routes is a pre-existing, already-documented
gap in the code's own comments, not something newly introduced in this pass, and auth is still
required regardless of CORS policy; the audit log's `detail` field has no length bound, which is a
resource-exhaustion concern explicitly excluded from this project's own review criteria.

---

## 13. Quantitative Metrics Appendix

Every number used anywhere in this document, in one place, with how it was obtained:

| Metric | Value | How measured |
|---|---|---|
| Gateway test suite | 144/144 passing | `npx vitest run` against real `workerd`, re-run fresh for this document |
| Rust engine test suite | 30/30 passing | `cargo test`, re-run fresh for this document |
| Chaos harness test suite | 28/28 passing (1 deselected) | `uv run pytest`, re-run fresh for this document |
| Fraud Ops agents test suite | 16/16 passing | `node --test`, real graph + stubbed fallback chain |
| Fraud Ops origin test suite | 14/14 passing | Real `workerd`, `@cloudflare/vitest-pool-workers` |
| Fraud Ops console test suite | 28/28 passing | Vitest, pure-function extraction, no DOM |
| **Total automated tests** | **260** | Sum of the above |
| Gateway bundle size | 91.58 KiB / 32.75 KiB gzip | `wrangler deploy --dry-run --env production`, live dry-run |
| Fraud Ops console bundle | 213.4 KB / 66.34 KB gzip | `npm run build` output |
| Cache speedup (Capability 2) | ~14× | `cacheSharingAgent.ts` live run vs. real 250ms artificial origin latency |
| `/api/audit-log` read latency (concurrency 20) | p50 106ms, p90 227ms, p99 316ms | Live load test, production gateway, 100 requests |
| `/api/audit-log/verify` latency (concurrency 20) | p50 237ms, p90 258ms, p99 268ms | Same |
| Concurrency sweep p50 (5 → 20 → 50) | 127ms → 92ms → 186ms | Same |
| Concurrency sweep p99 (5 → 20 → 50) | 286ms → 198ms → 370ms | Same |
| Rate limiter enforcement point | Request #32 of 40 | Live sequential test against production `/relay` |
| Rate limiter configured threshold | 30 requests / 60 seconds | `wrangler.toml`, live-verified |
| Chaos scenario: `upstream-outage` (run 1) | 68 messages, 0 violations | Recorded run, `eval/results/` |
| Chaos scenario: `upstream-outage` (run 2) | 64 messages, 0 violations | Recorded run, `eval/results/` |
| Chaos scenario: `downstream-flap` | 122 messages, 0 violations | Recorded run, `eval/results/` |
| Replay buffer size | 200 events | `FeedRelay.ts` constant |
| Per-socket outbound queue cap | 20 events | `FeedRelay.ts`, `OUTBOUND_BURST_CAPACITY` |
| Idle DO teardown delay | 5 seconds | `FeedRelay.ts` |
| Rust/WASM crate size | 680 lines, 4 files | `wc -l crates/mcp-relay-engine/src/*.rs` |
| Gateway source size | 4,091 lines (`do/`, `routes/`, `lib/`, incl. tests) | `wc -l`, re-run for this document |
| Fraud Ops agents source size | 709 lines | `wc -l`, re-run for this document |
| Fraud Ops origin source size | 521 lines | `wc -l`, re-run for this document |
| Fraud Ops console source size | 1,204 lines | `wc -l`, re-run for this document |
| Signal generation cycle length | 2,250 ticks (~90 min at 2.4s/tick) | `origin/src/index.ts`, `CYCLE_TICKS` |
| Max active fraud cases at once | 5 | `origin/src/index.ts`, `MAX_ACTIVE_CASES` |
| Max signals per case | 6 | `origin/src/index.ts`, `MAX_SIGNALS_PER_CASE` |
| Opening-signal severity range | 5–35 | `origin/src/index.ts`, verified by test across a full cycle |
| Follow-on signal severity range | 0–100 (uniform) | Same |
| OpenRouter free-tier per-minute limit | 20 requests/min | Confirmed live via real `429` response |
| OpenRouter free-tier daily limit (0-credit account) | 50 requests/day | Confirmed live via real `429` response |
| Model-call throttle interval | 3.5 seconds | `openRouterClient.ts`, `MIN_CALL_INTERVAL_MS` |
| Gemini free-tier daily limit (`gemini-flash-latest` alias) | 20 requests/day | Confirmed live via real `429`, project's own quota-exhaustion history |
| D1 database creation date | 2026-08-22 | `wrangler.toml` comment, real account |
| D1 tables | 4 (`delivery_log`, `agent_log`, `cache_log`, `agent_credentials`) | Migration files |

---

## 14. Known Gaps & Future Work

Stated explicitly, ranked roughly by what would matter most at real production scale:

1. **Upstream-residency GB-seconds cost is unmeasured.** The design and reasoning are documented
   (§9.4); the actual number from sustained real load is the one item from the original project plan
   still open.
2. **No load test of WebSocket fan-out concurrency on a single hot feed** — §9.3's load test covers
   HTTP API endpoints; many concurrent subscribers on the *same* `FeedRelay` instance is a distinct,
   unmeasured scenario.
3. **The two OpenRouter fallback models' real completion quality is unverified** — their IDs are
   confirmed real, the fallback mechanism is verified with stubbed calls, but neither has produced a
   real live completion under real conditions yet (§6.2).
4. **The LangGraph checkpointer is in-process only** (`MemorySaver`), not durable across an agent
   restart — a real production version would back this with a persisted checkpointer.
5. **The legacy shared-token auth model still exists** alongside real per-agent credentials, not yet
   fully retired — any caller still using `SUBSCRIBE_TOKEN` gets none of the new accountability
   properties.
6. **`Access-Control-Allow-Origin: "*"`** on the read/write log and audit routes is a real, if
   low-severity, gap — a production deployment should scope this to the dashboard/console's actual
   origin.
7. **The audit log's `detail` field has no length bound** — a valid credential holder could write
   arbitrarily large blobs, a resource-exhaustion-adjacent concern.

---

## 15. Conventions & Style Guide

Patterns applied consistently across both repositories, worth naming explicitly since they're what
makes the codebase legible as one system rather than two unrelated projects:

- **Verify, don't assume.** Every non-trivial claim in source comments and documentation
  (this document included) is paired with how it was confirmed — a test, a live curl, a downloaded
  bundle grep — not stated as received wisdom.
- **State gaps, don't hide them.** Every README and this document itself has a "known gaps" section
  naming real, current limitations, updated as gaps close (and, twice this session, corrected when a
  documented gap turned out to already be false).
- **Fail-open only to a weaker real check, never to "authorize everyone."** Applied identically
  across the rate limiter, the cache index, and the credential resolver.
- **Real platform primitives over hand-rolled equivalents.** Cloudflare's own Rate Limiting API, not
  a counter in D1; `crypto.subtle.timingSafeEqual`, not a hand-rolled XOR loop; LangChain's
  `RunnableLambda.withFallbacks()`, not a custom try/catch chain.
- **Durable Objects chosen for a stated reason, every time** — never "because it's the interesting
  choice," always because of a specific atomicity or single-shared-state requirement a plain Worker
  provably can't provide (documented per-DO in §5 and §6.1).
- **Separate concerns get separate tables/files/DO classes**, even when the shape looks similar —
  `delivery_log` vs. `agent_log` vs. `cache_log` is the canonical example (§5.6).

---

## 16. Glossary

| Term | Meaning in this system |
|---|---|
| **MCP** | Model Context Protocol — the JSON-RPC-based protocol both origins implement a subset of |
| **`subscriptions/listen`** | The one MCP method this whole project is built around; a long-lived, non-resumable notification stream |
| **Feed** | One `(originUrl, category)` pair; the unit `FeedRelay` DO instances are keyed on |
| **Scope** | A caller-chosen partitioning key for the discrete-call cache; unrelated to a credential's `scope_origin_host`/`scope_category` restriction, a naming overlap noted deliberately in source comments |
| **Gap marker** | An explicit message telling a client "something was possibly missed here," issued on any path that can lose an event |
| **Replay** | Buffered events sent to a reconnecting client whose `lastSeenSeq` is still within the retained window |
| **Hash chain** | The `AuditLog`'s tamper-evidence mechanism: each entry's hash is a function of its own content plus the previous entry's hash |
| **Scoped credential** | A per-agent, individually revocable, individually restricted D1-backed identity, layered over the legacy shared token |
| **`idFromName`** | The Cloudflare Durable Objects API used throughout both repos to deterministically route a request to the same DO instance for the same logical key |
| **Fail-open / fail-closed** | Whether a check defaults to allowing or denying when the check itself can't complete (an infrastructure hiccup vs. a genuine denial) — applied differently and deliberately per check throughout §5.7–5.8 |

---

*This document is generated from, and should be regenerated against, the actual state of both
repositories. Every quantitative figure in §13 has a listed reproduction method — re-run it before
trusting an old copy of this document over the live system.*
