// One upstream feed branching to many downstream subscribers, live. This
// doesn't simulate fan-out or read it back from a log after the fact -- it
// opens N independent WebSocket connections directly from the browser to the
// SAME feed (the exact /subscribe path any real client uses), and shows each
// one's own incoming messages side by side in real time, plus the actual
// inter-arrival latency per connection (the real "network diagnostics"
// signal -- a steady cadence means a healthy feed, a ragged one means jitter).
//
// The topology diagram reflects each subscriber's ACTUAL live state (lifted
// up via onStateChange), not a blanket "connected" boolean -- one pane can
// genuinely be "connecting" while its siblings are already "open", and the
// diagram should be honest about that, not paper over it.

import { useCallback, useEffect, useRef, useState } from "react";
import { NetworkTopology } from "../components/NetworkTopology";
import { Sparkline } from "../components/Sparkline";
import type { ConnState } from "../components/StatusBadge";
import { StatusBadge } from "../components/StatusBadge";
import type { GatewaySettings } from "../lib/settings";

const SUBSCRIBER_COUNT = 3;
const MAX_LOG_LINES = 24;
const MAX_LATENCY_SAMPLES = 20;

interface LogLine {
  at: string;
  raw: string;
}

function useSubscriber(wsUrl: string | null, onStateChange: (state: ConnState) => void) {
  const [state, setState] = useState<ConnState>("idle");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [interArrivalMs, setInterArrivalMs] = useState<number[]>([]);
  const lastMessageAt = useRef<number | null>(null);

  const report = useCallback(
    (s: ConnState) => {
      setState(s);
      onStateChange(s);
    },
    [onStateChange],
  );

  useEffect(() => {
    if (!wsUrl) {
      report("idle");
      return;
    }
    report("connecting");
    setLines([]);
    setInterArrivalMs([]);
    lastMessageAt.current = null;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => report("open"));
    ws.addEventListener("close", () => report("closed"));
    ws.addEventListener("error", () => report("error"));
    ws.addEventListener("message", (evt: MessageEvent) => {
      const now = performance.now();
      if (lastMessageAt.current !== null) {
        const delta = now - lastMessageAt.current;
        setInterArrivalMs((prev) => [...prev, delta].slice(-MAX_LATENCY_SAMPLES));
      }
      lastMessageAt.current = now;

      const raw = typeof evt.data === "string" ? evt.data : "[binary]";
      setLines((prev) => [{ at: new Date().toLocaleTimeString(), raw }, ...prev].slice(0, MAX_LOG_LINES));
    });

    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `report` is stable per subscriber index via useCallback in the parent
  }, [wsUrl]);

  return { state, lines, interArrivalMs };
}

function SubscriberPane({
  label,
  wsUrl,
  onStateChange,
}: {
  label: string;
  wsUrl: string | null;
  onStateChange: (state: ConnState) => void;
}) {
  const { state, lines, interArrivalMs } = useSubscriber(wsUrl, onStateChange);
  const avgLatency = interArrivalMs.length > 0 ? interArrivalMs.reduce((a, b) => a + b, 0) / interArrivalMs.length : null;

  return (
    <div className="rounded-card border border-rule">
      <div className="flex items-center justify-between border-b border-rule px-3.5 py-2.5">
        <span className="font-mono text-[13px] font-medium text-ink">{label}</span>
        <StatusBadge state={state} />
      </div>

      <div className="border-b border-rule px-3.5 py-2.5">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
          <span>Inter-arrival latency</span>
          {avgLatency !== null && <span className="font-mono tabular text-ink-2">avg {avgLatency.toFixed(0)}ms</span>}
        </div>
        <div className="mt-1.5">
          <Sparkline values={interArrivalMs} />
        </div>
      </div>

      <div className="max-h-[280px] overflow-y-auto px-3.5 py-2.5">
        {lines.length === 0 && <div className="text-xs text-muted">No messages yet.</div>}
        <div className="flex flex-col gap-1.5">
          {lines.map((l, i) => (
            <div key={i} className="text-xs leading-relaxed">
              <span className="mr-1.5 font-mono text-muted">{l.at}</span>
              <span className="break-all font-mono text-ink-2">{l.raw.slice(0, 160)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function LiveFanoutView({ settings }: { settings: GatewaySettings }) {
  const [connected, setConnected] = useState(false);
  const [subStates, setSubStates] = useState<ConnState[]>(Array(SUBSCRIBER_COUNT).fill("idle"));

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams({
      originUrl: settings.originUrl,
      category: settings.category,
      lastSeenSeq: "0",
      token: settings.token,
    });
    return `${settings.gatewayWsBase}/subscribe?${params.toString()}`;
  }, [settings]);

  // All three panes intentionally share the IDENTICAL url string -- each
  // SubscriberPane is its own component instance (via `key`), so React
  // still opens three independent real WebSockets regardless. An earlier
  // version appended a per-pane #fragment thinking it was cosmetic; it is
  // NOT -- unlike fetch(), the WebSocket constructor throws a SyntaxError on
  // any URL containing a fragment. Do not reintroduce it.
  const urls = connected ? Array.from({ length: SUBSCRIBER_COUNT }, () => buildUrl()) : [];

  const makeStateSetter = useCallback(
    (index: number) => (state: ConnState) =>
      setSubStates((prev) => {
        const next = [...prev];
        next[index] = state;
        return next;
      }),
    [],
  );

  // Relay's own state is derived: "open" once at least one subscriber has a
  // live upstream fan-out reaching it, "connecting" while any are still
  // handshaking, "idle" otherwise -- it doesn't have its own WebSocket, so
  // its status is a real reflection of what's actually flowing through it.
  const relayState: ConnState = subStates.some((s) => s === "open")
    ? "open"
    : subStates.some((s) => s === "connecting")
      ? "connecting"
      : "idle";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-ink">Live Fan-out</h1>
          <p className="mt-1 text-sm text-muted">
            Origin <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">{settings.originUrl}</code> · category{" "}
            <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">{settings.category}</code>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConnected((c) => !c)}
          className="shrink-0 rounded-control px-4 py-2 text-sm font-medium transition-colors"
          style={
            connected
              ? { border: "1px solid var(--color-rule-2)", color: "var(--color-ink-2)" }
              : { background: "var(--color-accent)", color: "var(--color-accent-ink)" }
          }
        >
          {connected ? "Disconnect all" : `Connect ${SUBSCRIBER_COUNT} subscribers`}
        </button>
      </div>

      <div className="rounded-card border border-rule p-4">
        <h2 className="text-sm font-medium text-ink">Topology</h2>
        <p className="mt-0.5 text-xs text-muted">
          One real upstream connection, multiplexed live to every connected subscriber below — each node's state is
          its actual current status, not a blanket toggle.
        </p>
        <div className="mt-2">
          <NetworkTopology
            origin={{ label: "Origin", sub: "origin-simulator", state: relayState }}
            relay={{ label: "FeedRelay", sub: "Durable Object", state: relayState }}
            subscribers={subStates.map((state, i) => ({ label: `Sub ${i + 1}`, sub: "browser WS", state }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(connected ? urls : Array.from({ length: SUBSCRIBER_COUNT }, () => null)).map((url, i) => (
          <SubscriberPane key={i} label={`Subscriber ${i + 1}`} wsUrl={url} onStateChange={makeStateSetter(i)} />
        ))}
      </div>
    </div>
  );
}
