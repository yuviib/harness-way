# Resume & Interview Prep — MCP Relay Harness

Working notes for turning this repo into a polished resume line, portfolio entry, and interview
story for the Cloudflare Software Engineering Intern cycle (roles post ~mid-Oct 2026 for Summer
2027, reviewed rolling — see "Timing" at the bottom). Everything technical here is pulled directly
from `README.md`, `docs/ARCHITECTURE.md`, `PLAN.md`, and the source tree as of 2026-08-18 — nothing
invented. Where a number depends on a fresh test run, it's marked so you re-verify before quoting it
out loud.

---

## 1. The one-line pitch

> Built an edge-native relay on Cloudflare Workers and Durable Objects that turns MCP's
> `subscriptions/listen` protocol — which the July 2026 spec revision made stateless and
> non-resumable — back into a multiplexed, resumable, gap-honest stream for many concurrent agents,
> plus a shared content-addressed cache for one-shot tool calls.

## 2. The 30-second version (say-out-loud pitch)

> "MCP is the protocol AI agents use to call tools and subscribe to notifications. The current spec
> made subscriptions request-scoped with no resumability — if your connection drops, you just lose
> whatever happened, no redelivery. That's fine for one client, but it means ten agents watching the
> same feed are ten fragile, duplicate connections, and a network blip silently drops data for all
> of them. I built a relay that sits in a Durable Object between the origin and every subscriber: one
> real upstream connection per feed, fanned out live to everyone, with a replay buffer so a
> reconnecting client gets exactly what it missed — and if it missed something outside that window,
> it gets an explicit gap marker, never silence. I also built a second capability on top: a shared,
> content-addressed cache for one-shot tool calls, so two agents asking the identical question only
> hit the origin once. Both are backed by real chaos testing — I kill the real origin process and flap
> real WebSocket connections mid-run and assert zero silent gaps, zero duplicate sequence numbers,
> zero out-of-order delivery, across every recorded run."

That's the whole story in one breath. Everything below is ammunition for follow-ups.

---

## 3. Resume bullets

Pick 2–4 depending on space. These map directly to the "Systems programming," "Networking,"
"TypeScript/JS," and "Distributed systems" rows Cloudflare's own JDs weight most heavily (see
§4 for the mapping).

- **Designed and built an edge-native relay (Cloudflare Workers + Durable Objects, Rust→WASM) that
  restores stream resumability the MCP protocol's 2026 spec revision removed — multiplexes N
  downstream subscribers onto one real upstream connection per feed and replays missed events on
  reconnect with zero silent data loss, verified against 3 real chaos-engineering runs (0
  violations across 254 observed messages).**
- **Implemented a chunk-boundary-safe SSE parser and BLAKE3 content-hashing engine in Rust,
  compiled to WASM and wired into the Workers runtime's `fetch()`-streamed request path — including
  diagnosing and fixing a `wasm-pack`/Cloudflare-bundler ABI mismatch by inspecting the compiled
  module's actual import table rather than guessing.**
- **Built a second capability — a shared, content-addressed cache for one-shot MCP tool calls,
  backed by a per-scope Durable Object SQLite index — that serves byte-identical cache hits ~14x
  faster than a live call, with structural (not runtime-checked) scope isolation between callers.**
- **Wrote a Python chaos-testing harness that kills and restarts a real origin process and flaps
  live WebSocket connections on a randomized schedule, asserting no silent gaps, no duplicate
  sequence numbers, and correct replay ordering — 28/28 tests passing, plus 3 recorded live runs.**
- **Shipped a full operator dashboard (React 19 + Tailwind v4) with a live network-topology view,
  gap audit log, agent-activity view, and cache-metrics view, all reading real D1-backed aggregate
  queries rather than client-side sums — fixing a real bug where a row-windowed query silently
  under-reported gap counts on long-running feeds.**

Draft, don't paste blind — trim to whatever's left of your character budget and keep the verbs
active. If a version of this project ends up deployed live (see §8), swap "verified against 3
chaos-engineering runs" for real production numbers once you have them.

---

## 4. Mapping this project onto what Cloudflare's JDs actually ask for

Pulled from the skills breakdown in the Extern internship guide you pasted (full-text analysis of
6 Cloudflare intern JDs, 2025–26 cycle) plus the live Austin SWE Intern posting.

| JD skill (frequency in JDs) | Where this project proves it |
|---|---|
| Systems programming — Go/Rust (5 of 6 JDs) | `crates/mcp-relay-engine` — Rust SSE parser (`sse_framing.rs`, 301 lines), ring buffer (`ring_buffer.rs`, 235 lines), BLAKE3 hashing (`hash.rs`, 78 lines), compiled to `wasm32-unknown-unknown`, `#[profile.release] opt-level = "z", lto = true` for a real deploy-size budget. `cargo clippy --all-targets` clean. |
| Data structures & algorithms (5 of 6) | Bounded ring buffer with sequence-number replay semantics; content-addressed cache keyed by canonicalized, key-order-independent hashing; per-socket bounded outbound queues with explicit eviction policy. |
| Computer networking — TCP/IP, DNS, HTTP (4 of 6) | Real streaming-HTTP client work: incremental SSE parsing across arbitrary chunk boundaries (not line-buffered), full-jitter exponential backoff on reconnect (the Marc Brooker/AWS formula, cited and implemented), explicit statement of what TLS/HTTP-version negotiation Cloudflare provides at the platform layer vs. what the app owns. |
| TypeScript/JavaScript, Workers, front-end (4 of 6) | The entire gateway (`apps/gateway`, Hono-style Worker + 2 Durable Object classes), 4 real WebSocket agent consumers (`apps/agents`), and the operator dashboard (`apps/dashboard`, React 19 + Tailwind v4 + Vite) are all TypeScript against the real Workers runtime, tested with `@cloudflare/vitest-pool-workers` (real `workerd`, not mocks). |
| Distributed systems fundamentals (3 of 6) | The actual thesis of the project: exactly-once upstream connection under concurrent subscribe races (solved via DO single-threaded execution + a no-`await`-between check-then-set), durable state that survives DO hibernation/eviction (`ctx.storage.sql`, confirmed by a dedicated eviction test), content-addressing and scope isolation as structural properties instead of runtime checks. |
| Linux/Unix systems (3 of 6) | Chaos harness kills and restarts a real OS process (`taskkill` on Windows equivalent, `_wrangler_process.py`) mid-run and asserts on the resulting behavior — not a mocked failure. |
| Security concepts — DDoS, Zero Trust (3 of 6) | Explicit host-allowlist validation on any user-supplied `originUrl` before it's ever passed to `fetch()` (SSRF-relevant input, checked deliberately), constant-time bearer-token comparison, and an honestly-documented known gap (shared dev token, not per-agent identity) rather than a glossed-over one — good interview material for "tell me about a security tradeoff you made," see §6. |
| API design & RESTful services (2 of 6) | `POST /relay` discrete-call endpoint, `/api/*-log` and `/api/*-log/counts` read endpoints designed specifically to avoid a real bug class (row-windowed queries silently under-reporting totals — see §5's bug stories). |
| Python (scripting & automation) (2 of 6) | `eval/` chaos-testing harness — `pytest`, `uv`-managed, `ruff`-linted, 28/28 tests passing, including tests of the chaos client itself. |

If you only have room to emphasize two things in a cover letter or the application's "why are you
interested" field, make it **Rust→WASM inside the Workers runtime** and **Durable Objects for
correctness, not just state** — those are the two most Cloudflare-specific, least-generic pieces of
this project, and they're exactly what a generic "I built a REST API" project can't show.

---

## 5. Interview-ready stories (STAR format)

Real bugs, found by testing against the real stack, not invented for the interview. Each of these
answers "tell me about a bug you found" or "tell me about a time you had to debug something
tricky" without you having to improvise under pressure.

### Story A — the WASM/bundler ABI mismatch
- **Situation**: The Rust SSE parser needed to run inside a Cloudflare Worker, compiled via
  `wasm-pack build --target bundler`.
- **Task**: Get it actually instantiating inside `workerd`, not just compiling.
- **Action**: The generated glue assumed webpack's wasm-loader semantics (`import * as wasm from
  "*.wasm"` yielding an already-instantiated exports object). Cloudflare's bundler instead resolves
  a `.wasm` import to a raw, uninstantiated `WebAssembly.Module` — confirmed against Cloudflare's
  own docs, not guessed. It failed at top level with `wasm.__wbindgen_start is not a function`.
  Instead of patching around the symptom, inspected the compiled module's actual import table with
  `WebAssembly.Module.imports()` to see exactly what it declared, then wrote `wasmEngine.ts` to
  instantiate it directly against that real import object.
- **Result**: A durable fix grounded in what the binary actually needs, not trial-and-error — and a
  good story about reading the actual contract instead of copy-pasting a fix from a GitHub issue.

### Story B — the 15-second `WebSocket.close()` bug
- **Situation**: `resume-agent` needed to deliberately disconnect and reconnect on a timer to prove
  replay correctness. It logged zero reconnects.
- **Task**: Find out whether the relay was actually broken, or whether the test client was.
- **Action**: Polled the socket's own `readyState` directly instead of trusting event timing.
  Found the socket entered `CLOSING` immediately but didn't fire its `close` event for 15+ seconds
  against wrangler's local dev server — a platform quirk, not a browser-standard timing assumption
  that held.
- **Result**: Stopped waiting on the event entirely; used an `intentionalReconnect` flag (mirroring
  a pattern the relay itself already used for its own teardown) so the delayed `close` couldn't
  trigger a second, redundant reconnect. Good story for "assumptions about platform behavior will
  bite you — verify, don't assume," especially with an env-specific one nobody would think to doubt.

### Story C — the silently-wrong KPI (row-window vs. true aggregate)
- **Situation**: Built the dashboard's Gap Audit view against a row-windowed log endpoint. It
  looked correct in dev.
- **Task**: Notice that "correct in a 5-minute dev session" isn't the same claim as "correct."
- **Action**: Reasoned through what happens on a long-running feed: `event` rows log roughly once a
  second, so any fixed-size row window eventually pushes rare `gap`/`reconnect` rows out of range
  entirely — a KPI tile could silently read zero on a feed that had genuinely logged gaps hours
  earlier.
- **Result**: Split the API in two on purpose — a row-window endpoint for a recent-activity table,
  and a separate `GROUP BY`-based counts endpoint for anything claiming to be a true total. Applied
  the same discipline preemptively to the agent-log and cache-log endpoints once the pattern was
  understood, instead of rediscovering it three times. Good "how do you think about correctness,
  not just passing tests" story.

### Story D — the empty-string env fallback
- **Situation**: `summarizer-agent`'s Gemini integration silently produced no summaries with a real
  API key configured.
- **Task**: Root-cause it, not just restart until it worked.
- **Action**: Found two independent bugs stacked on each other: the default model name
  (`gemini-2.0-flash`) no longer existed against a real `/v1beta/models` listing, and separately,
  `.env.example`'s bare `GEMINI_MODEL=` line is read by Node's `--env-file` as an empty string, not
  `undefined` — and `??` doesn't fall back on an empty string the way it does on `undefined`, so the
  intended default was silently losing to nothing.
- **Result**: Fixed the model to a stable alias (`gemini-flash-latest`) and switched the fallback
  operator to `||`. Verified end-to-end against a real key, not a mock response. Good example of a
  bug that only a real integration (not a stub) could have caught — ties into "why test against a
  real `workerd` runtime and a real Gemini key instead of mocks" if asked.

### Story E — a design decision you reversed, and can defend
- **Situation**: The original project plan (`PLAN.md`) sketched the discrete-call cache as
  `cacheClient.ts # Cache API / KV read-write`.
- **Task**: Decide whether to build it as planned or change course once building it surfaced a
  problem.
- **Action**: The Cache API's best-effort, evict-at-any-time, edge-local semantics made two of the
  project's own correctness properties (byte-identical replay, scope isolation) hard to pin down
  deterministically in a test — the same tension the replay buffer had already resolved once.
  Switched to a Durable Object with `ctx.storage.sql`, one instance per cache `scope` via
  `idFromName`, so scope isolation became structural (two different scopes are two different SQLite
  databases) instead of a runtime check that could have a bug in it.
- **Result**: A cache with provable, not merely tested, isolation — and a real answer to "tell me
  about a time your original design didn't survive contact with the implementation."

---

## 6. Honest answers for the hard questions

Cloudflare's interviewers will find the gaps if you don't name them first — naming them
unprompted reads as engineering judgment, not weakness.

**"Is this deployed?"** No — verified locally against the real `workerd` runtime via
`@cloudflare/vitest-pool-workers` and real killed/restarted processes, and `wrangler deploy
--dry-run` confirms the bundle (82.2 KiB / 30.6 KiB gzip) and bindings are correct, but it hasn't
been pushed to a live Cloudflare account yet. Say this plainly if asked — see §8 for closing this
gap before you apply.

**"How would this handle real multi-tenant auth?"** Current auth is a shared bearer token —
enough to prove the caller holds a shared secret, not real per-agent identity. The cache `scope`
is caller-supplied for the same reason. What *is* structurally real regardless: two different
scope strings can never observe each other's cache entries, independent of how weak the identity
model around `scope` currently is. A real deployment would derive `scope` from actual authenticated
identity once there's a real identity system to derive it from — framed as a stated v1 scope cut,
not an oversight.

**"What don't you know the cost of yet?"** Hibernation covers the DO's *incoming* downstream
WebSockets, not its *outgoing* leg — the upstream `subscriptions/listen` connection is a `fetch()`
with a streamed body the DO has to actively keep reading, so it stays resident the whole time that
connection is open, independent of downstream subscriber count. That's a real, stated cost, not
glossed over — but measuring actual GB-seconds requires a real deploy, which hasn't happened, so
it's an open item on the list, not a finished claim.

**"Why Durable Objects and not [alternative]?"** Two separate answers, both defensible: (1) for the
relay itself, DO's single-threaded execution is what turns "exactly one upstream connection per
feed, even under concurrent subscribes" into a structural guarantee instead of a race to defend
against — the single best-fit primitive in the whole design. (2) For the cache index, it was a
revised decision (see Story E) — the Cache API/KV named in the original plan turned out not to
give strong enough consistency guarantees to prove the correctness properties this project cares
about.

---

## 7. Draft answer — Cloudflare application's "Why are you interested" field

The Austin posting's form asks: *"Why are you interested in Cloudflare's Software Engineering
Internship? What products or features are you interested in building?"* Starting point below —
personalize it, don't submit verbatim, and read the linked engineering blog post it points to
before finalizing:

> I spent the last few weeks building a relay for MCP's `subscriptions/listen` protocol on Workers
> and Durable Objects, specifically because the July 2026 spec revision removed stream
> resumability and made every subscription strictly per-client. That's the kind of problem I want
> to keep working on — infrastructure that sits at the edge and makes something correct and shared
> that a spec deliberately left per-client. Building it against Cloudflare's actual primitives (DO
> hibernation, DO SQLite, D1's Sessions API, Rust-to-WASM inside `workerd`) taught me things a
> generic cloud provider wouldn't have: what hibernation does and doesn't cover, why
> `wasm-pack`'s bundler target doesn't match Workers' module resolution, what a Durable Object
> guarantees under concurrent requests and what it doesn't. I'd want to keep building at that
> layer — the pieces of Cloudflare's stack (Workers, Durable Objects, D1, the edge network itself)
> that make correctness guarantees possible at a scale a single server never could.

Adjust the last sentence to name a specific product area from the posting's tech list
(Workers/Pingora/QUIC/Zero Trust) once you know which team you're actually interviewing with —
generic enthusiasm reads worse than one specific, correct detail.

---

## 8. Portfolio polish checklist — do these before you apply

In rough priority order:

1. **Commit and push the Capability 2 work.** As of this writing, `git status` shows the entire
   cache-index capability (`ContextIndex.ts`, `cacheClient.ts`, `cacheKey.ts`, `cacheLog.ts`,
   `relay.ts`, the D1 migration, `cacheSharingAgent.ts`, `CacheMetrics.tsx`, and their tests) is
   uncommitted. The README and architecture docs already describe it as built and verified — the
   git history needs to catch up before a recruiter's `git log` tells the same story your README
   does.
2. **Re-run the full verification table in `README.md` fresh** (`cargo test`, `cargo clippy
   --all-targets`, `vitest run`, `tsc -b && vite build && oxlint`, `pytest`) right before you
   finalize anything public, and update any numbers that drifted. Don't quote stale test counts.
3. **Get a real deploy.** This is the single biggest gap between "local-only" and "production
   engineering" in an interviewer's eyes, and it's explicitly called out as the next step in both
   `README.md`'s "Known gaps" and `PLAN.md`'s verification plan. Even a `workers.dev` deploy behind
   the free tier closes "is this deployed?" for good and lets you report a real GB-seconds number
   for the open upstream-residency-cost item (`PLAN.md` correctness property 4b).
4. **Record a short demo video** following `docs/DEMO_SCRIPT.md` (it's already written as a ~5
   minute guided walkthrough) and link it from the README. A recruiter skimming GitHub will watch
   90 seconds of video before they'll run four terminals locally.
5. **Add screenshots of the dashboard** (Live Fan-out, Gap Audit, Agents, Cache Metrics) to the
   README — the architecture prose is strong, but a resume reviewer decides whether to keep
   reading in about five seconds, and a visual earns you the rest.
6. **Add a top-level license and confirm the repo is public** before it needs to survive a
   recruiter's link click.
7. **GitHub profile URL field on the application** — make sure this repo (or a pinned version of
   it) is what's visible on your profile, not buried under unrelated coursework repos.

---

## 9. Quick-reference fact sheet (for rapid recall mid-interview)

| Fact | Value |
|---|---|
| Core problem | MCP 2026-07-28 spec removed subscription resumability; this project restores it at the edge without requiring origin or client changes |
| Platform | Cloudflare Workers, 2 Durable Object classes (`FeedRelay`, `ContextIndex`), D1 (Sessions API), Rust→WASM |
| Languages | TypeScript (gateway, agents, dashboard), Rust (SSE parser, ring buffer, BLAKE3 hashing), Python (chaos harness) |
| Rust engine tests | 30/30 passing via `cargo test`, `cargo clippy --all-targets` clean |
| Gateway tests | 113/113 passing via `vitest` against real `workerd` (`@cloudflare/vitest-pool-workers`), not mocks |
| Chaos harness tests | 28/28 passing via `pytest` |
| Chaos runs recorded | 3 real runs (2x upstream-outage, 1x downstream-flap), 254 messages observed, 0 violations |
| Deploy size | 82.2 KiB / 30.6 KiB gzip (`wrangler deploy --dry-run`) — comfortably inside the Workers free-tier 3 MiB gzip cap |
| Cache speedup (Capability 2) | ~14x faster on a hit vs. a real call (30ms vs 412ms), byte-identical, same `originCallSeq` proving the origin wasn't re-called |
| Frontend stack | React 19, Tailwind v4, Vite, oxlint |
| Rust dependencies | `wasm-bindgen`, `serde`/`serde_json`, `blake3`; release profile `opt-level = "z"`, `lto = true` |
| Known gaps (state unprompted) | Not yet deployed live; auth is a shared bearer token, not per-agent identity; upstream-residency GB-seconds cost not yet measured (needs a real deploy) |
| Approx. source size | Gateway core (DOs + routes + lib) ~2,100 lines incl. tests; dashboard ~1,700 lines; agents ~870 lines; Rust engine ~680 lines; chaos harness ~650 lines |

---

## 10. Timing, from the research you pulled

For context on why "polish this now" matters: Cloudflare's SWE internship postings are expected to
go live mid-October 2026 for the Summer 2027 cycle, reviewed **on a rolling basis** — the Austin
Fall 2026 posting you pasted states this explicitly ("we will be hiring interns on a rolling basis
until all roles are filled"). Rolling review means the practical deadline is "as early as you can
apply with something finished," not the posted closing date. Everything in §8 should be done
*before* mid-October, not started after applications open — a live deploy, a demo video, and a
clean commit history all take real days, not the hours you'll have once you're also filling out
application forms and prepping for the OA.

The HackerRank OA (2–3 medium problems, 60–90 min) and 2–3 technical interview rounds test DS&A
and, per community reports, networking fundamentals and systems design — this project is strong
prep material for the systems-design and networking conversation specifically (the SSE
chunk-boundary parsing, the backpressure design under a platform with no queue-depth signal, and
the DO concurrency guarantee are all real, defensible systems-design answers), but it doesn't
replace dedicated DS&A/LeetCode practice for the OA itself.
