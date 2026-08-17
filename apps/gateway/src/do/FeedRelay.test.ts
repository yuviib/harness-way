import { applyD1Migrations, evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeBackoffMs, OUTBOUND_BURST_CAPACITY } from "./FeedRelay";

// Builds a mock SSE Response standing in for the origin-simulator. Real
// root cause of the long-standing "harness limitation" this replaces,
// confirmed by direct tracing (not guessed): Workers enforces a hard
// cross-Durable-Object I/O ownership rule ("Cannot perform I/O on behalf of
// a different Durable Object"). The old mock's `ReadableStream` was
// constructed in the test RUNNER's own DO context (vitest-pool-workers runs
// test bodies as one), and FeedRelay -- a genuinely different DO -- hit
// that rule the moment it tried to read from it. Two things fix that here:
// (1) events are queued *before* subscribe() triggers the fetch, and the
// stream is constructed lazily inside `fetchMock`'s own body, which
// executes in the CALLER's IoContext (FeedRelay's, since FeedRelay is the
// one calling fetch()) -- so the stream is owned by the right DO from
// creation. (2) the stream deliberately never calls `controller.close()`,
// matching a real `subscriptions/listen` connection that doesn't end on
// its own -- an early version of this mock used a fully-static body that,
// for a test queuing zero events, resolved instantly, which raced
// FeedRelay's own "connection ended" cleanup (`upstreamStarted = false`)
// against a second concurrent subscriber's check of that same flag. That's
// a real reconnect-race worth its own fix (Week 3's already-planned
// reconnect-with-backoff work), not something this mock should trip
// incidentally.
function mockSseOrigin() {
  let requestCount = 0;
  const queued: string[] = [];
  // Both configured BEFORE subscribe() triggers the fetch, and both only
  // affect the constructed-inside-fetchMock stream (see the block comment
  // above) -- so simulating a drop or a failed connect attempt never needs
  // a later cross-context write into an already-returned stream, same
  // cross-DO-ownership constraint as the rest of this mock.
  let dropsRemaining = 0;
  let attemptsLeftToFail = 0;
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    requestCount++;
    if (attemptsLeftToFail > 0) {
      attemptsLeftToFail--;
      throw new Error("mock: simulated connect failure");
    }
    const eventsSnapshot = [...queued];
    // One-shot(s), not persistent: consumed here so a RECONNECT attempt
    // behaves like a normal stable long-lived stream, isolating "one drop,
    // then stable recovery" from "an origin that never stops dropping"
    // (the latter is a real, different, and arguably correct scenario --
    // FeedRelay treats each connect-then-instant-drop as its own honest
    // micro-outage -- but not what a given test necessarily wants to
    // isolate).
    const shouldClose = dropsRemaining > 0;
    if (shouldClose) dropsRemaining--;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Enqueued as ONE combined chunk, not one enqueue() per event: a
        // ReadableStream's default reader yields exactly one read() per
        // enqueue() call (not coalesced), so one-per-event would mean
        // FeedRelay's read loop (see connectOnce) always sees exactly one
        // parsed event per chunk -- which would make the outbound-queue
        // burst cap (see broadcastEvent/flushOutboundQueues) untestable,
        // and doesn't match how a real TCP read can legitimately span
        // multiple SSE events anyway.
        if (eventsSnapshot.length > 0) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(eventsSnapshot.join("")));
        }
        if (shouldClose) {
          controller.close();
        }
        // Otherwise no controller.close() -- see comment above.
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return {
    fetchMock,
    getRequestCount: () => requestCount,
    // Must be called BEFORE subscribe() triggers the fetch -- this is a
    // pre-baked batch delivered on connect, not a live push into an
    // already-open stream.
    queue(id: number, data: unknown) {
      queued.push(`id: ${id}\nevent: test\ndata: ${JSON.stringify(data)}\n\n`);
    },
    // Simulates a genuine upstream drop: the stream ends (naturally, not
    // via cancel()) right after delivering whatever's currently queued, on
    // exactly the next N connect attempts -- subsequent ones behave like a
    // normal never-ending stream.
    dropAfterQueuedEvents(n = 1) {
      dropsRemaining = n;
    },
    // Simulates the initial fetch() itself failing (network error), for
    // exactly the next N connect attempts.
    failNextAttempts(n: number) {
      attemptsLeftToFail = n;
    },
  };
}

describe("FeedRelay", () => {
  let origin: ReturnType<typeof mockSseOrigin>;

  beforeEach(async () => {
    origin = mockSseOrigin();
    vi.stubGlobal("fetch", origin.fetchMock);
    // reset() below wipes D1 schema, not just rows (confirmed by testing --
    // the delivery_log table came back "no such table" after the first
    // reset(), even though test/apply-migrations.ts already ran once via
    // setupFiles at worker startup). applyD1Migrations() only applies
    // migrations not already recorded as applied, so reapplying here every
    // test is a safe no-op except right after a reset() actually did wipe
    // the tracking table too, which is exactly when it's needed.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Now load-bearing, not just hygiene: buf/nextSeq are write-through to
    // real ctx.storage.sql (see FeedRelay.ts), which -- unlike the old
    // purely-in-memory fields -- can survive across separate `vitest run`
    // process invocations via Miniflare's local persistence, not just
    // within one run. Without this, a feed key reused across runs (every
    // test here uses a fixed suffix) would carry stale seq numbers forward
    // from a previous run.
    await reset();
  });

  async function subscribe(feedSuffix: string, lastSeenSeq = 0) {
    const id = env.FEED_RELAY.idFromName(`test-feed-${feedSuffix}`);
    const stub = env.FEED_RELAY.get(id);
    const req = new Request(
      `https://x/subscribe?originUrl=https://origin.test/mcp&category=c&lastSeenSeq=${lastSeenSeq}`,
      { headers: { Upgrade: "websocket" } },
    );
    const response = await stub.fetch(req);
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (!ws) throw new Error("expected a webSocket on the 101 response");
    ws.accept();
    return { stub, ws };
  }

  function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const received: unknown[] = [];
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} messages, got ${received.length}`)), timeoutMs);
      ws.addEventListener("message", (evt: MessageEvent) => {
        received.push(JSON.parse(evt.data as string));
        if (received.length >= count) {
          clearTimeout(timer);
          resolve(received);
        }
      });
    });
  }

  // Path-agnostic collector: with the static-body mock (see mockSseOrigin
  // above), whether a given subscriber sees a given seq via a live "event"
  // message or bundled into its initial "replay" message is a genuine race
  // (a static body can finish draining before a second subscriber even
  // connects) -- and that race isn't something FeedRelay's own correctness
  // depends on resolving one particular way. What FeedRelay's correctness
  // properties actually require is that every subscriber ends up knowing
  // about every seq one way or another. This resolves once `seen` is a
  // superset of `expectedSeqs`, regardless of which message type(s)
  // supplied them.
  function collectKnownSeqs(ws: WebSocket, expectedSeqs: number[], timeoutMs = 2000): Promise<Set<number>> {
    return new Promise((resolve, reject) => {
      const seen = new Set<number>();
      const timer = setTimeout(
        () => reject(new Error(`timed out; seen so far [${[...seen].join(",")}], expected [${expectedSeqs.join(",")}]`)),
        timeoutMs,
      );
      ws.addEventListener("message", (evt: MessageEvent) => {
        const msg = JSON.parse(evt.data as string) as
          | { type: "replay"; events: { seq: number }[] }
          | { type: "event"; seq: number }
          | { type: "gap"; oldestAvailableSeq: number };
        if (msg.type === "replay") {
          for (const e of msg.events) seen.add(e.seq);
        } else if (msg.type === "event") {
          seen.add(msg.seq);
        }
        if (expectedSeqs.every((s) => seen.has(s))) {
          clearTimeout(timer);
          resolve(seen);
        }
      });
    });
  }

  it("delivers a replay message immediately on connect, even with nothing buffered yet", async () => {
    const { ws } = await subscribe("replay-empty");
    const [first] = await collectMessages(ws, 1);
    expect(first).toEqual({ type: "replay", events: [] });
  });

  // EXPERIMENT ROUND 1: proving/refuting the real root cause of the old
  // "harness limitation" (see git history for the original three skipped
  // tests and their prior write-up). Actual root cause, confirmed by direct
  // tracing: the old mock stubbed `fetch` with a live `ReadableStream`
  // constructed in the test RUNNER's own Durable Object context (that's how
  // vitest-pool-workers itself runs test bodies); FeedRelay, a genuinely
  // different Durable Object, hit Workers' hard "Cannot perform I/O on
  // behalf of a different Durable Object" rule the moment it read from that
  // stream. Not a timing/isolation quirk -- a real cross-DO I/O ownership
  // rule no flag can bypass. `mockSseOrigin` above now pre-bakes the whole
  // response body as a static string inside `fetchMock` itself (which
  // executes in the CALLER's -- FeedRelay's -- context), with no live
  // cross-context writes afterward. One consequence: events must be queued
  // BEFORE subscribe() triggers the fetch, not pushed in afterward, so
  // "replay" and "live" no longer arrive as two safely-separated phases --
  // this collects all expected messages in one listener to avoid a race
  // between message dispatch and listener attachment.
  it("broadcasts live events to a connected subscriber", async () => {
    origin.queue(1, { hello: "world" });
    origin.queue(2, { hello: "again" });
    const { ws } = await subscribe("live-events");
    const messages = (await collectMessages(ws, 3)) as { type: string; seq?: number }[];
    expect(messages[0]).toEqual({ type: "replay", events: [] });
    expect(messages.slice(1).map((m) => m.seq)).toEqual([1, 2]);
  });

  // Same static-body mock as above. Subscribing sequentially (not
  // concurrently) means `b`'s connection is a genuine race against the
  // first subscriber's already-kicked-off connectUpstream drain -- `b`
  // might see these events live, or already bundled into its own initial
  // replay if connectUpstream finishes first. Both are correct; see
  // collectKnownSeqs above for why this asserts the path-independent
  // property instead of a specific message sequence.
  //
  // Confirmed by tracing (not guessed): `a`'s listener MUST attach right
  // after `a` subscribes, before `b`'s subscribe() call -- with this mock's
  // near-instant drain, connectUpstream can broadcast to `a` while the test
  // is still busy awaiting `b`'s subscribe(), and a message dispatched with
  // no listener yet attached is simply lost (same reason every other test
  // here attaches its listener in the very next line after subscribing,
  // not after a second unrelated await).
  it("fans out identical events to two independent subscribers on the same feed", async () => {
    origin.queue(1, { x: 1 });
    origin.queue(2, { x: 2 });
    const a = await subscribe("fanout");
    const aSeqsPromise = collectKnownSeqs(a.ws, [1, 2]);
    const b = await subscribe("fanout");
    const bSeqsPromise = collectKnownSeqs(b.ws, [1, 2]);
    const [aSeqs, bSeqs] = await Promise.all([aSeqsPromise, bSeqsPromise]);
    expect(aSeqs).toEqual(new Set([1, 2]));
    expect(bSeqs).toEqual(new Set([1, 2]));
  });

  it("opens exactly one upstream connection even for two concurrent subscribers", async () => {
    await Promise.all([subscribe("single-upstream"), subscribe("single-upstream")]);
    expect(origin.getRequestCount()).toBe(1);
  });

  // Same static-body mock as above. Queuing all 3 upfront and waiting for
  // `first` to have seen all of them (via collectKnownSeqs, live-or-replay
  // agnostic) is what makes this deterministic: broadcastEvent pushes into
  // `this.buf` before it ever sends to a socket, so by the time `first` has
  // observed seq 3 one way or another, `buf` is guaranteed fully populated
  // for `second`'s replay filtering to be tested against.
  it("replay only includes events strictly newer than lastSeenSeq", async () => {
    origin.queue(1, {});
    origin.queue(2, {});
    origin.queue(3, {});
    const first = await subscribe("replay-filter");
    await collectKnownSeqs(first.ws, [1, 2, 3]);

    const second = await subscribe("replay-filter", 1);
    const messages = (await collectMessages(second.ws, 1)) as {
      type: string;
      events: { seq: number }[];
    }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.events.map((e) => e.seq)).toEqual([2, 3]);
  });

  // Probing a real design question, not assuming an answer. First attempt
  // (evicting a DO with a live upstream fetch() still open) just hangs on
  // evictDurableObject's own "wait for in-flight requests to drain"
  // semantics -- which is expected, not a bug: PLAN.md already documents
  // that the upstream leg keeps the DO resident regardless of downstream
  // hibernation, so it can't gracefully drain while that fetch is open.
  // That's a real finding on its own (see the follow-up test below), but it
  // means eviction-with-a-live-upstream can't be exercised this way.
  //
  // The separate, still-open question this isolates instead: hibernation's
  // documented contract is that a DO's in-memory JS state is discarded on
  // eviction and reconstructed from ctx.storage (or the constructor) on
  // wake -- accepted WebSockets and ctx.storage survive, plain class fields
  // do not. buf/nextSeq are now write-through to ctx.storage.sql (see the
  // constructor and broadcastEvent), specifically so they survive this;
  // upstreamStarted is deliberately left as a plain field (see its own
  // comment at the field declaration for why that's correct, not a gap).
  // Seeding goes through the real ctx.storage.sql path here, not direct
  // field mutation, so this proves the actual write-through/hydrate cycle
  // rather than just the in-memory field.
  it("buf/nextSeq survive a DO eviction via ctx.storage; upstreamStarted correctly does not", async () => {
    const id = env.FEED_RELAY.idFromName("test-feed-eviction-state");
    const stub = env.FEED_RELAY.get(id);

    // runInDurableObject itself sends a request to the instance (routed to
    // this callback instead of the real fetch() handler), which is enough
    // to make it "running" for eviction purposes -- deliberately NOT going
    // through the real fetch()/connectUpstream path here, so there's no
    // competing live upstream fetch() to block eviction's drain (see the
    // comment above on why that hangs).
    await runInDurableObject(stub, async (instance) => {
      const fr = instance as unknown as {
        ctx: DurableObjectState;
        upstreamStarted: boolean;
      };
      fr.ctx.storage.sql.exec(
        "INSERT INTO replay_events (seq, upstream_id, event, data) VALUES (?, ?, ?, ?)",
        1,
        null,
        null,
        "seeded",
      );
      fr.ctx.storage.sql.exec(
        "INSERT INTO relay_meta (key, value) VALUES ('nextSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        "2",
      );
      fr.upstreamStarted = true;
    });

    await evictDurableObject(stub, { webSockets: "close" });

    await runInDurableObject(stub, async (instance) => {
      const fr = instance as unknown as {
        buf: unknown[];
        nextSeq: number;
        upstreamStarted: boolean;
      };
      expect(fr.buf).toEqual([{ seq: 1, upstreamId: null, event: null, data: "seeded" }]);
      expect(fr.nextSeq).toBe(2);
      expect(fr.upstreamStarted).toBe(false);
    });
  });

  it("tears down the upstream connection after the idle grace period once the last subscriber disconnects", async () => {
    const { stub, ws } = await subscribe("idle-teardown");
    await collectMessages(ws, 1);
    ws.close();
    // give webSocketClose a moment to run and schedule the alarm
    await new Promise((r) => setTimeout(r, 50));
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);
  });

  // Proves the intentionalTeardown flag actually does its job: an idle
  // teardown's cancel() must NOT be mistaken for an unexpected drop and
  // trigger a reconnect. If it were, this DO would immediately reopen an
  // upstream connection nobody asked for (and, since it'd then have zero
  // subscribers, would just idle-teardown again -- but getRequestCount
  // climbing above 1 at all is the observable bug this guards against).
  it("does not reconnect after an intentional idle-teardown cancel", async () => {
    const { stub, ws } = await subscribe("idle-teardown-no-reconnect");
    await collectMessages(ws, 1);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    await runDurableObjectAlarm(stub);
    // give connectOnce's read loop a moment to actually unblock and the
    // outer loop to observe intentionalTeardown, in case cancel() resolves
    // asynchronously rather than synchronously
    await new Promise((r) => setTimeout(r, 50));
    expect(origin.getRequestCount()).toBe(1);
  });

  // The actual Week 3 behavior: an unexpected drop (stream ends on its own,
  // not via a deliberate cancel()) must reconnect -- and must tell whoever
  // is still listening that it may have missed something, per the "never
  // silence" principle. dropAfterQueuedEvents(1) simulates a real
  // subscriptions/listen connection ending unexpectedly ONCE after
  // delivering some events, then recovering on reconnect and staying
  // stable -- which the real origin-simulator's stream never does on its
  // own by design, but a real network blip or origin restart genuinely
  // would.
  it("reconnects with backoff and broadcasts exactly one gap marker after an unexpected upstream drop", async () => {
    origin.queue(1, { x: 1 });
    origin.dropAfterQueuedEvents(1);
    const { ws } = await subscribe("unexpected-drop");

    const messages: { type: string; seq?: number; oldestAvailableSeq?: number }[] = [];
    const gapSeen = new Promise<void>((resolve) => {
      ws.addEventListener("message", (evt: MessageEvent) => {
        const msg = JSON.parse(evt.data as string) as { type: string; seq?: number; oldestAvailableSeq?: number };
        messages.push(msg);
        if (msg.type === "gap") resolve();
      });
    });
    await gapSeen;

    // Backoff runs in the background on the DO's own timers; give it real
    // wall-clock room (attempt 0's ceiling is BACKOFF_BASE_MS=100ms) to
    // actually retry rather than asserting immediately.
    await new Promise((r) => setTimeout(r, 500));

    expect(messages.filter((m) => m.type === "gap")).toHaveLength(1);
    expect(origin.getRequestCount()).toBeGreaterThanOrEqual(2);
  });

  // Found on code review, not by a failing test first -- outageSignaled is
  // reset inside connectOnce right when a NEW connection establishes (see
  // that comment), but was NOT being reset at either point connectUpstream
  // fully gives up (intentional-teardown, or zero subscribers remaining).
  // Left stuck `true`, a WHOLLY NEW subscriber arriving later, after this
  // feed fully went idle and restarted from scratch, would have its own
  // first real drop wrongly suppressed -- the outer loop's gap-broadcast
  // would see outageSignaled already true and stay silent, exactly what
  // "never silence" exists to prevent. This sequences a real give-up (drop
  // -> disconnect -> second drop with zero subscribers left -> give up)
  // and then proves a brand-new subscriber's own drop still gets signaled.
  it("still signals a gap for a brand-new subscriber's drop after the feed fully gave up and restarted", async () => {
    origin.queue(1, { x: 1 });
    origin.dropAfterQueuedEvents(3); // 1st connect, retry, and the new subscriber's connect all drop

    const first = await subscribe("outage-flag-reset");
    await new Promise<void>((resolve) => {
      first.ws.addEventListener("message", (evt: MessageEvent) => {
        const msg = JSON.parse(evt.data as string) as { type: string };
        if (msg.type === "gap") resolve();
      });
    });
    first.ws.close();

    // Give the retry loop room to: reconnect (2nd attempt, also drops per
    // dropAfterQueuedEvents(3) above), observe zero remaining subscribers,
    // and fully give up -- resetting upstreamStarted AND outageSignaled.
    await new Promise((r) => setTimeout(r, 500));

    // A wholly new subscriber to the SAME feed triggers a fresh
    // connectUpstream from scratch (upstreamStarted was reset). Its own
    // connection ALSO drops (the 3rd configured drop) -- but only after
    // first delivering the queued event live (since it's the same read
    // loop, and delivery happens before the stream ends), so the full
    // sequence is replay, then that live event, then finally the gap once
    // the connection ends. The "gap" showing up at all -- not suppressed --
    // is the actual property this test exercises.
    const second = await subscribe("outage-flag-reset");
    const messages = (await collectMessages(second.ws, 3)) as { type: string }[];
    expect(messages.map((m) => m.type)).toEqual(["replay", "event", "gap"]);
  });

  // The self-imposed bounded-queue backpressure mechanism (see
  // broadcastEvent/flushOutboundQueues): a single upstream chunk producing
  // more events than OUTBOUND_BURST_CAPACITY must drop the OLDEST ones from
  // that burst, not the newest, and must say so exactly once -- while
  // buf/replay (a separate, much larger capacity) stays completely
  // unaffected, since this queue is guaranteed to be a live subscriber, not
  // a resubscribe. All `totalEvents` are queued before subscribe() so they
  // arrive as one combined chunk (see mockSseOrigin), which is what makes
  // this a single burst rather than many separately-flushed small ones.
  it("caps a single burst's live delivery per socket, dropping the oldest and sending exactly one gap marker", async () => {
    const totalEvents = OUTBOUND_BURST_CAPACITY + 5;
    for (let i = 1; i <= totalEvents; i++) {
      origin.queue(i, { x: i });
    }
    const { ws } = await subscribe("burst-cap");

    const expectedMessageCount = 2 + OUTBOUND_BURST_CAPACITY; // initial replay + one gap + capacity's worth of events
    const messages = (await collectMessages(ws, expectedMessageCount)) as {
      type: string;
      seq?: number;
      events?: unknown[];
      oldestAvailableSeq?: number;
    }[];

    expect(messages[0]).toEqual({ type: "replay", events: [] });
    expect(messages[1]!.type).toBe("gap");

    const survivingSeqs = messages.slice(2).map((m) => m.seq);
    const expectedSeqs = Array.from(
      { length: OUTBOUND_BURST_CAPACITY },
      (_, i) => totalEvents - OUTBOUND_BURST_CAPACITY + 1 + i,
    );
    expect(survivingSeqs).toEqual(expectedSeqs);
    expect(messages[1]!.oldestAvailableSeq).toBe(expectedSeqs[0]);
  });

  // Pure-function unit tests for the backoff formula itself -- deterministic
  // via the injectable `random`, not dependent on real timing.
  describe("computeBackoffMs", () => {
    it("scales the ceiling exponentially with attempt, before capping", () => {
      // random() => 1 makes the return value exactly the ceiling, isolating
      // the exponential-growth part of the formula from the jitter part.
      expect(computeBackoffMs(0, () => 1)).toBe(100);
      expect(computeBackoffMs(1, () => 1)).toBe(200);
      expect(computeBackoffMs(2, () => 1)).toBe(400);
      expect(computeBackoffMs(3, () => 1)).toBe(800);
    });

    it("caps the ceiling rather than growing unbounded", () => {
      expect(computeBackoffMs(20, () => 1)).toBe(5000);
    });

    it("draws uniformly from [0, ceiling], not a fixed offset", () => {
      expect(computeBackoffMs(0, () => 0)).toBe(0);
      expect(computeBackoffMs(0, () => 0.5)).toBe(50);
      expect(computeBackoffMs(0, () => 1)).toBe(100);
    });
  });

  // D1 writes (see logDeliveryAsync in FeedRelay.ts) are fire-and-forget via
  // ctx.waitUntil, with a swallowed .catch() -- deliberately, so an
  // observability write can never surface as a delivery failure. The direct
  // consequence: a broken write would NOT fail any test above; only
  // actually querying D1 back proves the write path works at all. Polling
  // (not a fixed sleep) because the write genuinely races the test's own
  // continuation -- there's no signal from logDeliveryAsync's caller that
  // the background write has landed.
  describe("D1 delivery log", () => {
    async function pollDeliveryLog(
      whereClause: string,
      ...binds: unknown[]
    ): Promise<Record<string, unknown>[]> {
      const deadline = Date.now() + 2000;
      for (;;) {
        const { results } = await env.DB.prepare(`SELECT * FROM delivery_log WHERE ${whereClause}`)
          .bind(...binds)
          .all();
        if (results.length > 0 || Date.now() > deadline) return results;
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it("logs a delivered event with the correct feed key and seq", async () => {
      origin.queue(1, { x: 1 });
      await subscribe("d1-event-log");

      const rows = await pollDeliveryLog("entry_type = 'event' AND seq = ?", 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entry_type: "event", seq: 1 });
      expect(typeof rows[0]!.feed_key).toBe("string");
      expect(typeof rows[0]!.occurred_at).toBe("string");
    });

    it("logs exactly one gap and a subsequent reconnect for one outage", async () => {
      origin.queue(1, { x: 1 });
      origin.dropAfterQueuedEvents(1);
      const { ws } = await subscribe("d1-gap-reconnect-log");

      // Wait for the gap message to actually arrive on the socket before
      // polling D1 -- broadcastGap() and logDeliveryAsync("gap", ...) are
      // called back-to-back at the same point in connectUpstream, so
      // observing the former is a reliable proxy for the latter having
      // been issued (not necessarily completed, hence the poll below).
      await new Promise<void>((resolve) => {
        ws.addEventListener("message", (evt: MessageEvent) => {
          const msg = JSON.parse(evt.data as string) as { type: string };
          if (msg.type === "gap") resolve();
        });
      });

      const gapRows = await pollDeliveryLog("entry_type = 'gap'");
      expect(gapRows).toHaveLength(1);

      // The reconnect only logs once connectOnce's NEXT attempt actually
      // establishes -- give backoff (attempt 0's ceiling is 100ms) real
      // wall-clock room, same as the WebSocket-level reconnect test above.
      const reconnectRows = await pollDeliveryLog("entry_type = 'reconnect'");
      expect(reconnectRows).toHaveLength(1);
    });

    // Found by building the dashboard's GapAudit view, which claims to show
    // EVERY gap marker issued -- this specific gap (sendReplay's
    // buffer-eviction branch, distinct from connectUpstream's outage-gap
    // above) was silently NOT being logged until fixed. Seeding `buf`
    // directly via runInDurableObject rather than actually pushing 200+
    // events through REPLAY_CAPACITY to trigger real eviction -- this is
    // testing that the gap path logs correctly, not re-testing eviction
    // itself (already covered by the Rust ring_buffer tests).
    it("logs the buffer-eviction gap too, labeled with a distinct cause from the outage gap", async () => {
      const id = env.FEED_RELAY.idFromName("test-feed-d1-eviction-gap-log");
      const stub = env.FEED_RELAY.get(id);
      await runInDurableObject(stub, async (instance) => {
        const fr = instance as unknown as { buf: { seq: number }[]; nextSeq: number };
        fr.buf = [{ seq: 50, upstreamId: null, event: null, data: "x" } as never];
        fr.nextSeq = 51;
      });

      const req = new Request(
        "https://x/subscribe?originUrl=https://origin.test/mcp&category=c&lastSeenSeq=0",
        { headers: { Upgrade: "websocket" } },
      );
      const response = await stub.fetch(req);
      expect(response.status).toBe(101);
      const ws = response.webSocket;
      if (!ws) throw new Error("expected a webSocket on the 101 response");
      ws.accept();
      await collectMessages(ws, 1); // the gap message itself

      const rows = await pollDeliveryLog("entry_type = 'gap' AND seq = ?", 50);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.detail).toBe("buffer-eviction");
    });
  });
});
