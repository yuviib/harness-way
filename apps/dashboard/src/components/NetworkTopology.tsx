/* Hallmark · genre: modern-minimal · design-system: design.md · designed-as-app
 * Redesigned for real hierarchy (FeedRelay is the one thing that matters --
 * drawn as the hub, everything else is secondary) and real motion: a pulse
 * only travels an edge when a genuine event crossed that hop, never on a
 * timer. See design.md's Motion section -- this carries the project's own
 * "never silence, never simulate" principle into the UI layer.
 *
 * The traveling pulse is driven by requestAnimationFrame, not SMIL
 * <animateMotion> -- found by testing, not assumed: SMIL animation elements
 * inserted dynamically by React (as opposed to present in static markup)
 * are unreliable about auto-starting in Chrome, so a key-remount-triggered
 * <animateMotion> silently never played. Plain rAF interpolation over the
 * same cubic Bezier the line itself is drawn with has no such dependency.
 */

import { useEffect, useRef, useState } from "react";
import type { ConnState } from "./StatusBadge";
import { StatusBadge } from "./StatusBadge";

interface TopologyNode {
  label: string;
  sub: string;
  state: ConnState;
}

interface CubicPath {
  x0: number;
  y0: number;
  cx1: number;
  cy1: number;
  cx2: number;
  cy2: number;
  x1: number;
  y1: number;
}

function pathD(p: CubicPath): string {
  return `M ${p.x0} ${p.y0} C ${p.cx1} ${p.cy1}, ${p.cx2} ${p.cy2}, ${p.x1} ${p.y1}`;
}

function pointOnCubic(p: CubicPath, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p.x0 + b * p.cx1 + c * p.cx2 + d * p.x1,
    y: a * p.y0 + b * p.cy1 + c * p.cy2 + d * p.y1,
  };
}

const PULSE_DURATION_MS = 750;

// Plays once per genuine nonce change (a real message on that hop, see
// LiveFanoutView -- never a timer). Renders nothing between pulses and
// nothing at all under prefers-reduced-motion, matching this project's
// global reduced-motion stance in index.css.
function PulseDot({ path, nonce }: { path: CubicPath; nonce: number }) {
  const [progress, setProgress] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const prevNonce = useRef(nonce);

  useEffect(() => {
    const isNewPulse = nonce > 0 && nonce !== prevNonce.current;
    prevNonce.current = nonce;
    if (!isNewPulse) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const start = performance.now();
    function tick(now: number): void {
      const t = Math.min(1, (now - start) / PULSE_DURATION_MS);
      setProgress(t);
      rafRef.current = t < 1 ? requestAnimationFrame(tick) : null;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [nonce]);

  if (progress === null || progress >= 1) return null;
  const { x, y } = pointOnCubic(path, progress);
  const opacity = progress < 0.1 ? progress / 0.1 : progress > 0.75 ? Math.max(0, (1 - progress) / 0.25) : 1;

  return (
    <g style={{ pointerEvents: "none" }}>
      <circle cx={x} cy={y} r={7} fill="var(--color-status-good)" opacity={opacity * 0.35} />
      <circle cx={x} cy={y} r={3.5} fill="var(--color-status-good)" stroke="var(--color-paper)" strokeWidth={1.25} opacity={opacity} />
    </g>
  );
}

// A pulse only plays when its nonce changes. Nonces are monotonically
// increasing counts of REAL messages received on that hop -- see
// LiveFanoutView, which increments these directly off the WebSocket
// `message` event, never off an interval.
export function NetworkTopology({
  origin,
  relay,
  subscribers,
  originPulse,
  subscriberPulses,
}: {
  origin: TopologyNode;
  relay: TopologyNode;
  subscribers: TopologyNode[];
  originPulse: number;
  subscriberPulses: number[];
}) {
  const width = 640;
  const height = Math.max(150, subscribers.length * 46 + 30);
  const originX = 68;
  const relayX = width / 2;
  const subX = width - 86;
  const centerY = height / 2;
  const subYs = subscribers.map((_, i) => 24 + (i + 0.5) * ((height - 48) / subscribers.length));

  const originCubic: CubicPath = {
    x0: originX + 30,
    y0: centerY,
    cx1: originX + 30 + (relayX - originX) * 0.5,
    cy1: centerY,
    cx2: relayX - 30 - (relayX - originX) * 0.5,
    cy2: centerY,
    x1: relayX - 30,
    y1: centerY,
  };
  const relayCubics: CubicPath[] = subscribers.map((_, i) => ({
    x0: relayX + 30,
    y0: centerY,
    cx1: relayX + 30 + (subX - relayX) * 0.55,
    cy1: centerY,
    cx2: subX - 26 - (subX - relayX) * 0.15,
    cy2: subYs[i]!,
    x1: subX - 26,
    y1: subYs[i]!,
  }));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      <defs>
        <radialGradient id="relay-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* origin -> relay */}
      <path
        d={pathD(originCubic)}
        fill="none"
        stroke={origin.state === "open" ? "var(--color-accent)" : "var(--color-rule)"}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={origin.state === "open" ? undefined : "3 5"}
      />
      {origin.state === "open" && <PulseDot path={originCubic} nonce={originPulse} />}

      {/* relay -> each subscriber */}
      {subscribers.map((s, i) => (
        <path
          key={i}
          d={pathD(relayCubics[i]!)}
          fill="none"
          stroke={s.state === "open" ? "var(--color-accent)" : "var(--color-rule)"}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeDasharray={s.state === "open" ? undefined : "3 5"}
        />
      ))}
      {subscribers.map(
        (s, i) => s.state === "open" && <PulseDot key={i} path={relayCubics[i]!} nonce={subscriberPulses[i] ?? 0} />,
      )}

      {/* relay glow -- the one real connection is the thing worth looking at */}
      {relay.state === "open" && <circle cx={relayX} cy={centerY} r={34} fill="url(#relay-glow)" />}

      <Node x={originX} y={centerY} node={origin} />
      <Node x={relayX} y={centerY} node={relay} hub />
      {subscribers.map((s, i) => (
        <Node key={i} x={subX} y={subYs[i]!} node={s} small />
      ))}
    </svg>
  );
}

function Node({ x, y, node, hub, small }: { x: number; y: number; node: TopologyNode; hub?: boolean; small?: boolean }) {
  const color =
    node.state === "open"
      ? "var(--color-status-good)"
      : node.state === "connecting"
        ? "var(--color-status-warning)"
        : node.state === "error"
          ? "var(--color-status-critical)"
          : "var(--color-muted)";
  const r = small ? 5 : hub ? 11 : 6.5;

  return (
    <g>
      {hub && (
        <circle
          cx={x}
          cy={y}
          r={r + 5}
          fill="none"
          stroke={node.state === "open" ? "var(--color-accent)" : "var(--color-rule)"}
          strokeWidth={1}
          strokeDasharray="1 4"
          opacity={0.6}
        />
      )}
      <circle cx={x} cy={y} r={r} fill={color} stroke="var(--color-paper)" strokeWidth={hub ? 3 : 2} />
      {node.state === "open" && (
        <circle cx={x} cy={y} r={r} fill="none" stroke={color} strokeWidth={1.5} opacity={0.5}>
          <animate attributeName="r" values={`${r};${r + (hub ? 12 : 8)}`} dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0" dur="1.8s" repeatCount="indefinite" />
        </circle>
      )}
      <text
        x={x}
        y={y - r - 9}
        textAnchor="middle"
        className={hub ? "fill-ink font-mono text-[12px] font-semibold" : "fill-ink font-mono text-[11px] font-medium"}
      >
        {node.label}
      </text>
      <text x={x} y={y - r - 9 + 13} textAnchor="middle" className="fill-muted text-[10px]">
        {node.sub}
      </text>
    </g>
  );
}

export function TopologyLegendRow({ node }: { node: TopologyNode }) {
  return (
    <div className="flex items-center justify-between border-t border-rule py-2 first:border-t-0">
      <div>
        <div className="text-sm font-medium text-ink">{node.label}</div>
        <div className="text-xs text-muted">{node.sub}</div>
      </div>
      <StatusBadge state={node.state} />
    </div>
  );
}
