// The actual thing being proven: one upstream connection, fanned out live to
// N downstream subscribers -- drawn as what it is, not decorated. Real state
// per node (StatusBadge's fixed status colors), a single line in from the
// origin, N lines fanning out to subscribers, each animated only while that
// specific hop is actually open (motion has intent -- see microinteractions.md).

import type { ConnState } from "./StatusBadge";
import { StatusBadge } from "./StatusBadge";

interface TopologyNode {
  label: string;
  sub: string;
  state: ConnState;
}

export function NetworkTopology({
  origin,
  relay,
  subscribers,
}: {
  origin: TopologyNode;
  relay: TopologyNode;
  subscribers: TopologyNode[];
}) {
  const width = 640;
  const height = Math.max(140, subscribers.length * 44 + 20);
  const originX = 70;
  const relayX = width / 2;
  const subX = width - 90;
  const centerY = height / 2;
  const subYs = subscribers.map((_, i) => 20 + (i + 0.5) * ((height - 40) / subscribers.length));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      {/* origin -> relay */}
      <line
        x1={originX + 46}
        y1={centerY}
        x2={relayX - 52}
        y2={centerY}
        stroke={origin.state === "open" ? "var(--color-accent)" : "var(--color-rule)"}
        strokeWidth={2}
        strokeDasharray={origin.state === "open" ? undefined : "3 4"}
      />
      {/* relay -> each subscriber */}
      {subscribers.map((s, i) => (
        <path
          key={i}
          d={`M ${relayX + 52} ${centerY} L ${subX - 46} ${subYs[i]}`}
          fill="none"
          stroke={s.state === "open" ? "var(--color-accent)" : "var(--color-rule)"}
          strokeWidth={2}
          strokeDasharray={s.state === "open" ? undefined : "3 4"}
        />
      ))}

      <Node x={originX} y={centerY} node={origin} />
      <Node x={relayX} y={centerY} node={relay} emphasized />
      {subscribers.map((s, i) => (
        <Node key={i} x={subX} y={subYs[i]!} node={s} small />
      ))}
    </svg>
  );
}

function Node({ x, y, node, emphasized, small }: { x: number; y: number; node: TopologyNode; emphasized?: boolean; small?: boolean }) {
  const color =
    node.state === "open"
      ? "var(--color-status-good)"
      : node.state === "connecting"
        ? "var(--color-status-warning)"
        : node.state === "error"
          ? "var(--color-status-critical)"
          : "var(--color-muted)";
  const r = small ? 5 : emphasized ? 8 : 6.5;

  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={color} stroke="var(--color-paper)" strokeWidth={2} />
      {node.state === "open" && (
        <circle cx={x} cy={y} r={r} fill="none" stroke={color} strokeWidth={1.5} opacity={0.5}>
          <animate attributeName="r" values={`${r};${r + 8}`} dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.5;0" dur="1.8s" repeatCount="indefinite" />
        </circle>
      )}
      <text x={x} y={y - r - 8} textAnchor="middle" className="fill-ink font-mono text-[11px] font-medium">
        {node.label}
      </text>
      <text x={x} y={y - r - 8 + 13} textAnchor="middle" className="fill-muted text-[10px]">
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
