import { DurableObject } from "cloudflare:workers";
import { buildFeedKey } from "../lib/feedKey";
import { logDelivery } from "../lib/metricsWriter";
import { WasmSseParser } from "../lib/wasmEngine";

export interface BufferedEvent {
  seq: number;
  upstreamId: string | null;
  event: string | null;
  data: string;
}

// Replay-buffer semantics here intentionally mirror ring_buffer.rs (tested
// with 25 unit tests as the reference implementation) rather than calling
// into the WASM ring buffer directly. The buffer needs to survive Durable
// Object hibernation/eviction, which means it has to live in DO state the
// runtime actually persists -- routing it through a WASM instance's linear
// memory would mean manually serializing the whole buffer to DO storage
// around every call just to survive eviction, for logic simple enough that
// reimplementing it natively against `this.buf` is the more honest design,
// not a shortcut. The SSE parsing stays in WASM below: that state is fine
// to lose on a genuine restart (equivalent to a reconnect), unlike the
// replay buffer.
//
// Confirmed by a dedicated test (see FeedRelay.test.ts), not assumed: a
// plain class field does NOT survive a DO eviction -- only ctx.storage and
// accepted hibernatable WebSockets do. `buf`/`nextSeq` are therefore
// write-through to ctx.storage.sql (the SQLite backend this class is
// provisioned with, per wrangler.toml's new_sqlite_classes) on every push,
// and hydrated back in the constructor via blockConcurrencyWhile before any
// request is handled on a fresh/woken instance.
const REPLAY_CAPACITY = 200;

// Grace period before tearing down an upstream connection after the last
// downstream subscriber disconnects. Not zero: a client that reconnects
// within a few seconds (a page refresh, a brief network blip) should reuse
// the still-live upstream connection and its buffered history rather than
// pay a fresh subscribe round-trip and lose in-flight state. Not indefinite
// either -- discovered by testing, not designed up front: without any
// teardown at all, an idle feed with zero listeners keeps its upstream
// connection open (and billed as DO residency time, per the plan's own
// "upstream-residency cost" property) forever.
const IDLE_TEARDOWN_GRACE_MS = 5000;

// Per-socket cap on how many events from a single upstream chunk's parsed
// batch get queued for delivery before the oldest ones start dropping (see
// broadcastEvent/flushOutboundQueues). Not a defense against a genuinely
// slow network client -- the platform gives no signal for that at all (see
// the comment at the drop site) -- but a real, testable bound on this DO's
// own per-subscriber memory regardless of how large one upstream burst is.
export const OUTBOUND_BURST_CAPACITY = 20;

const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 5000;

// "Full jitter" (Marc Brooker / AWS Architecture Blog's well-known
// formula): grow the ceiling exponentially, capped, then draw uniformly
// from [0, ceiling] rather than applying a fixed offset -- a fixed-offset
// jitter still lets every DO retrying against the same failed origin drift
// back into lockstep over several attempts; a full random draw each time
// doesn't. Exported (and `random` injectable) so this is unit-testable in
// isolation rather than only observable through real timing.
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return random() * ceiling;
}

interface DownstreamReplay {
  type: "replay";
  events: BufferedEvent[];
}
// Reused for two distinct situations that share the same client-facing
// contract ("you may have missed events; oldestAvailableSeq is where
// reliable delivery resumes, resubscribe if you need what came before"):
// buffer-eviction gaps (client's lastSeenSeq predates what's retained) and
// live-stream gaps (the upstream connection dropped and reconnected -- per
// the MCP spec revision, "a broken response stream loses the in-flight
// request", so there's no way to know what, if anything, was actually
// missed, and the honest response is to always signal rather than guess).
interface DownstreamGap {
  type: "gap";
  oldestAvailableSeq: number;
}
interface DownstreamEvent extends BufferedEvent {
  type: "event";
}

export class FeedRelay extends DurableObject<Env> {
  private buf: BufferedEvent[] = [];
  private nextSeq = 1;
  // Deliberately NOT persisted, unlike buf/nextSeq above. A DO id only ever
  // has one live JS instance at a time -- eviction fully retires the old
  // instance (and with it, the real upstreamReader/fetch()) before a fresh
  // one is ever constructed. If this flag were reloaded as `true` after an
  // eviction, the fresh instance would wrongly believe a connection it
  // never actually made was already live, and would never call
  // connectUpstream again -- a permanently-dead feed despite subscribers.
  // Resetting to `false` on every fresh instance is the CORRECT recovery
  // signal, not a gap: it's what makes the next incoming subscribe actually
  // reconnect.
  private upstreamStarted = false;
  private upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // Set right before a deliberate `upstreamReader.cancel()` (idle teardown,
  // see alarm() below), so the read loop's own catch/finally -- which can't
  // otherwise tell a deliberate cancel apart from a genuine upstream drop,
  // since both just end the pending read() one way or another -- knows
  // which one just happened.
  private intentionalTeardown = false;
  // Instance state (not a connectUpstream-local), because connectOnce needs
  // to read and clear it directly at the moment a connection establishes --
  // see the comment where it's used there for why that specific timing
  // matters. There's only ever one connectUpstream loop running at a time
  // per instance (guaranteed by upstreamStarted), so this doesn't need to
  // be scoped any more tightly than the instance itself.
  private outageSignaled = false;
  // Purely transient, in-flight batching state -- correctly NOT persisted,
  // unlike buf/nextSeq. There's nothing meaningfully "pending" to recover
  // after a restart: a queue only ever holds events from a batch that's
  // still being processed in the current synchronous turn, always fully
  // drained (see flushOutboundQueues) before this ever awaits again. A
  // WeakMap also means closed sockets' entries are simply forgotten, no
  // manual cleanup needed on webSocketClose.
  private readonly outboundQueues = new WeakMap<WebSocket, { queue: DownstreamEvent[]; pendingGap: boolean }>();
  // Set on first fetch() -- same derivation subscribe.ts already used to
  // route here in the first place (see ../lib/feedKey), so the delivery
  // log is tagged with the exact key a query against it would filter on.
  // Not persisted: cheap to recompute, and only ever needed while this
  // instance is actively handling requests for its own feed.
  private feedKey: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS replay_events (
          seq INTEGER PRIMARY KEY,
          upstream_id TEXT,
          event TEXT,
          data TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS relay_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      const rows = this.ctx.storage.sql
        .exec<{ seq: number; upstream_id: string | null; event: string | null; data: string }>(
          "SELECT seq, upstream_id, event, data FROM replay_events ORDER BY seq ASC",
        )
        .toArray();
      this.buf = rows.map((r) => ({ seq: r.seq, upstreamId: r.upstream_id, event: r.event, data: r.data }));

      const metaRow = this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM relay_meta WHERE key = 'nextSeq'")
        .toArray()[0];
      // nextSeq must survive even a buf fully evicted down to empty (all
      // rows trimmed) -- it's the source of truth for "how far has this
      // feed counted," independent of how much history is still retained.
      this.nextSeq = metaRow ? Number(metaRow.value) : 1;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const originUrl = url.searchParams.get("originUrl");
    const category = url.searchParams.get("category") ?? "default";
    const lastSeenSeq = Number(url.searchParams.get("lastSeenSeq") ?? "0");
    if (!originUrl) {
      return new Response("Missing originUrl", { status: 400 });
    }
    // Idempotent across repeat subscribes to the same feed (identical
    // originUrl/category always derive the identical key) -- cheap enough
    // to just recompute rather than branch on already-set.
    this.feedKey = buildFeedKey(originUrl, category);

    // Accessed via the literal `0`/`1` properties, not `Object.values(pair)`
    // -- WebSocketPair types those as fixed properties (`{0: WebSocket, 1:
    // WebSocket}`), so direct indexing is exact `WebSocket`, unaffected by
    // `noUncheckedIndexedAccess` (which only widens true index signatures,
    // not literal keys); `Object.values()` loses that precision and returns
    // a general array, which the flag does widen.
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable accept: this connection can go idle-and-hibernated at no
    // compute cost while waiting for the next upstream event, and the
    // runtime wakes this DO instance and re-delivers to webSocketMessage /
    // webSocketClose below even after a hibernation-triggered eviction.
    this.ctx.acceptWebSocket(server);

    // A new subscriber arrived -- cancel any pending idle-teardown alarm
    // from a previous subscriber count hitting zero, since the upstream
    // connection (if still alive) is about to be useful again.
    await this.ctx.storage.deleteAlarm();

    // Correctness property: exactly one upstream connection per feed, even
    // under concurrent subscribe requests. DO method invocations do NOT
    // auto-serialize across an `await` -- only single JS statements are
    // atomic -- so the check-then-set here has to happen with no await in
    // between, which it does: reading and setting `upstreamStarted` are
    // synchronous, and `connectUpstream` is deliberately not awaited inline.
    if (!this.upstreamStarted) {
      this.upstreamStarted = true;
      this.ctx.waitUntil(this.connectUpstream(originUrl, category));
    }

    this.sendReplay(server, lastSeenSeq);

    return new Response(null, { status: 101, webSocket: client });
  }

  private sendReplay(ws: WebSocket, lastSeenSeq: number): void {
    const oldest = this.buf[0]?.seq;
    if (oldest !== undefined && lastSeenSeq + 1 < oldest) {
      const msg: DownstreamGap = { type: "gap", oldestAvailableSeq: oldest };
      ws.send(JSON.stringify(msg));
      // Was missing until this was actually caught by building the
      // dashboard's GapAudit view, which claims to show EVERY gap marker
      // issued -- only the connectUpstream outage-gap was logged, not this
      // buffer-eviction one, which would have made that claim false.
      this.logDeliveryAsync("gap", oldest, "buffer-eviction");
      return;
    }
    const msg: DownstreamReplay = {
      type: "replay",
      events: this.buf.filter((e) => e.seq > lastSeenSeq),
    };
    ws.send(JSON.stringify(msg));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Fire-and-forget by design -- see metricsWriter.ts's own comment on why
  // this must never block the live-delivery path it's called from.
  private logDeliveryAsync(entryType: "event" | "gap" | "reconnect", seq: number | null, detail?: string): void {
    if (!this.feedKey) return; // set synchronously in fetch() before this can ever run; defensive only
    this.ctx.waitUntil(
      logDelivery(this.env.DB, {
        feedKey: this.feedKey,
        entryType,
        seq,
        occurredAt: new Date().toISOString(),
        detail,
      }).catch(() => {
        // Delivery to subscribers has already happened by the time this
        // runs -- a failed observability write must never surface as, or
        // cause, a delivery failure.
      }),
    );
  }

  private broadcastGap(): void {
    const msg: DownstreamGap = { type: "gap", oldestAvailableSeq: this.nextSeq };
    const encoded = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(encoded);
    }
  }

  // One connection attempt: fetch, then read until the stream ends (however
  // it ends) or errors. Policy (retry, backoff, gap-marker, when to finally
  // give up) lives in connectUpstream below, not here -- this only reports
  // what happened.
  private async connectOnce(
    originUrl: string,
    category: string,
  ): Promise<{ outcome: "intentional-teardown" | "ended-unexpectedly"; establishedConnection: boolean }> {
    let res: Response;
    try {
      res = await fetch(originUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "subscriptions/listen",
          params: { category },
        }),
      });
    } catch {
      return { outcome: "ended-unexpectedly", establishedConnection: false };
    }
    if (!res.ok || !res.body) {
      return { outcome: "ended-unexpectedly", establishedConnection: false };
    }

    // Connection genuinely established -- if an outage was already
    // signaled, THIS is the recovery, and it needs logging right now, not
    // deferred until this (possibly very long-lived, maybe never-ending)
    // connection also eventually ends. Waiting until connectOnce returns
    // would mean "reconnect" never logs at all for a connection that
    // recovers and then just stays up, which is the common case, not an
    // edge case -- confirmed by a test that caught exactly this.
    if (this.outageSignaled) {
      this.logDeliveryAsync("reconnect", null);
      this.outageSignaled = false;
    }

    const parser = new WasmSseParser();
    const reader = res.body.getReader();
    this.upstreamReader = reader;
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const events: { id: string | null; event: string | null; data: string }[] = JSON.parse(parser.push(text));
        for (const evt of events) {
          this.broadcastEvent(evt);
        }
        // Flushed once per chunk, not per event -- see broadcastEvent's own
        // comment on why draining per-event would make the outbound cap
        // meaningless (the queue would never hold more than one item at a
        // time to actually cap).
        this.flushOutboundQueues();
      }
    } catch {
      // Falls through to the same "ended-unexpectedly" classification as a
      // clean end, below -- both are equally "we don't know what, if
      // anything, was missed" from the client's perspective.
    } finally {
      this.upstreamReader = null;
    }

    // A deliberate idle-teardown cancel() and a genuine drop both just end
    // the pending read() one way or another -- this flag (set by alarm()
    // right before calling cancel()) is what actually distinguishes them,
    // not anything observable from the read loop itself.
    if (this.intentionalTeardown) {
      this.intentionalTeardown = false;
      return { outcome: "intentional-teardown", establishedConnection: true };
    }
    return { outcome: "ended-unexpectedly", establishedConnection: true };
  }

  private async connectUpstream(originUrl: string, category: string): Promise<void> {
    let attempt = 0;

    for (;;) {
      const result = await this.connectOnce(originUrl, category);

      if (result.outcome === "intentional-teardown") {
        this.upstreamStarted = false;
        // See the comment on the other reset below -- same reasoning:
        // the feed is fully stopping, and a future subscriber restarting
        // it must not inherit a stale "already told you about a drop"
        // flag from a completely different subscriber's outage.
        this.outageSignaled = false;
        return;
      }

      if (result.establishedConnection) {
        // "reconnect" logging and outageSignaled's reset already happened
        // inside connectOnce, right when the connection established --
        // not here, since waiting for connectOnce to RETURN would mean a
        // connection that recovers and then just stays up (the common
        // case) never gets logged as a reconnect at all.
        attempt = 0;
      }

      // Per the MCP spec revision, a broken response stream unconditionally
      // loses whatever was in flight -- there's no way to know whether
      // anything was actually missed, so this signals regardless of how
      // quickly the reconnect below succeeds. Same "never silence"
      // principle as the buffer-eviction gap in sendReplay.
      if (!this.outageSignaled) {
        this.broadcastGap();
        this.logDeliveryAsync("gap", this.nextSeq, "upstream-drop");
        this.outageSignaled = true;
      }

      if (this.ctx.getWebSockets().length === 0) {
        // Nobody left to reconnect for -- same "next subscriber starts
        // fresh" recovery as the intentional-teardown path above. Resetting
        // outageSignaled here too matters, not just upstreamStarted: left
        // `true`, a WHOLLY NEW subscriber arriving later (after this feed
        // fully went idle and is starting over) would have connectOnce
        // treat its first-ever connection attempt as "recovering from" an
        // outage nobody watching right now was ever told about, AND --
        // more importantly -- the outer loop's own gap-broadcast above
        // would wrongly stay suppressed for that new subscriber's actual
        // first real drop, since it'd already see outageSignaled as true.
        this.upstreamStarted = false;
        this.outageSignaled = false;
        return;
      }

      await this.sleep(computeBackoffMs(attempt));
      attempt++;
    }
  }

  private broadcastEvent(evt: { id: string | null; event: string | null; data: string }): void {
    const seq = this.nextSeq++;
    const buffered: BufferedEvent = { seq, upstreamId: evt.id, event: evt.event, data: evt.data };
    this.buf.push(buffered);
    if (this.buf.length > REPLAY_CAPACITY) {
      this.buf.shift();
    }
    this.logDeliveryAsync("event", seq);

    // Write-through, not batched: this is the one property (replay-on-
    // reconnect) that has to survive an eviction between now and whenever a
    // client next reconnects, so it can't be deferred or coalesced without
    // reopening the exact gap this fixes. Cost of this per-event I/O is a
    // real, open question -- tracked as PLAN.md's correctness property 4b
    // (measure actual GB-seconds/duration, don't assume it's fine).
    this.ctx.storage.sql.exec(
      "INSERT INTO replay_events (seq, upstream_id, event, data) VALUES (?, ?, ?, ?)",
      buffered.seq,
      buffered.upstreamId,
      buffered.event,
      buffered.data,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM replay_events WHERE seq <= (SELECT MAX(seq) FROM replay_events) - ?",
      REPLAY_CAPACITY,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO relay_meta (key, value) VALUES ('nextSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(this.nextSeq),
    );

    const msg: DownstreamEvent = { type: "event", ...buffered };
    for (const ws of this.ctx.getWebSockets()) {
      let state = this.outboundQueues.get(ws);
      if (!state) {
        state = { queue: [], pendingGap: false };
        this.outboundQueues.set(ws, state);
      }
      state.queue.push(msg);
      if (state.queue.length > OUTBOUND_BURST_CAPACITY) {
        // Bounded per-socket outbound queue, overflow policy: drop the
        // OLDEST queued event for THIS socket specifically and note the
        // drop for an honest gap marker at flush time -- never grow past
        // capacity, and never let one lagging-behind-in-processing socket's
        // backlog affect any other socket's own queue (each is independent
        // here, same isolation principle as the fan-out loop itself).
        //
        // Verified against the actual platform (not assumed): Workers'
        // hibernatable WebSocket has no bufferedAmount / queue-depth signal
        // at all (cloudflare/workerd#988, confirmed still open) -- so this
        // cannot react to genuine client-side network slowness, and it
        // does not claim to. What it DOES guarantee: this DO's own memory
        // per subscriber is bounded regardless of how many events one
        // upstream chunk's parsed batch produces, and any consequent drop
        // is always honestly signaled, never silent.
        state.queue.shift();
        state.pendingGap = true;
      }
    }
  }

  // Drains every socket's accumulated queue from the current batch. Called
  // once per upstream chunk (see connectOnce), not once per event -- see
  // broadcastEvent's own comment for why per-event draining would make the
  // cap meaningless.
  private flushOutboundQueues(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.outboundQueues.get(ws);
      if (!state || state.queue.length === 0) continue;
      if (state.pendingGap) {
        const oldestAvailableSeq = state.queue[0]!.seq;
        const gapMsg: DownstreamGap = { type: "gap", oldestAvailableSeq };
        ws.send(JSON.stringify(gapMsg));
        state.pendingGap = false;
      }
      for (const queuedMsg of state.queue) {
        ws.send(JSON.stringify(queuedMsg));
      }
      state.queue = [];
    }
  }

  override async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // v1 is subscribe-only: no client -> server messages expected yet.
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // `code` can be a reserved/reflective value the WebSocket spec allows
      // *reporting* but not re-sending -- 1005 ("no status code was
      // present") and 1006 ("abnormal closure") are the common cases,
      // surfaced here by testing an actual client disconnect, not assumed.
      // The close handshake is already effectively done at this point
      // either way; this call is just best-effort symmetry.
    }
    // getWebSockets() still includes `ws` itself at this point -- confirmed
    // by testing, not assumed (the closing socket isn't removed from the
    // hibernation-tracked list until after this handler returns) -- so the
    // "is anyone else still connected" check has to exclude it explicitly.
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws).length;
    if (remaining === 0 && this.upstreamStarted) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TEARDOWN_GRACE_MS);
    }
  }

  override async alarm(): Promise<void> {
    const remaining = this.ctx.getWebSockets().length;
    // Re-check rather than trusting the state at schedule time: a new
    // subscriber may have connected during the grace period (which itself
    // would have cancelled this alarm via deleteAlarm() in fetch() -- this
    // is a defensive second check, not the primary mechanism).
    if (remaining === 0) {
      this.intentionalTeardown = true;
      this.upstreamReader?.cancel();
    }
  }
}
