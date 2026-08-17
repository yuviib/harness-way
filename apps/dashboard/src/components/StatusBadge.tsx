// Status is never color-alone (dataviz color-formula.md § Status is fixed):
// every state pairs a reserved status color with an icon AND a text label.
// Uses the dataviz skill's fixed status steps -- not a generic green/amber/red
// guess -- so it stays visually distinct from the chart's own categorical hues.

import { IconAlertTriangle, IconCircleDot, IconXCircle } from "./Icons";

export type ConnState = "idle" | "connecting" | "open" | "closed" | "error";

const CONFIG: Record<ConnState, { label: string; color: string; Icon: typeof IconCircleDot }> = {
  idle: { label: "Idle", color: "var(--color-muted)", Icon: IconCircleDot },
  connecting: { label: "Connecting", color: "var(--color-status-warning)", Icon: IconCircleDot },
  open: { label: "Open", color: "var(--color-status-good)", Icon: IconCircleDot },
  closed: { label: "Closed", color: "var(--color-muted)", Icon: IconXCircle },
  error: { label: "Error", color: "var(--color-status-critical)", Icon: IconAlertTriangle },
};

export function StatusBadge({ state }: { state: ConnState }) {
  const { label, color, Icon } = CONFIG[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide text-ink-2"
      style={{ borderColor: state === "idle" ? undefined : color }}
    >
      <Icon style={{ color }} className={state === "connecting" ? "animate-pulse" : undefined} />
      {label}
    </span>
  );
}
