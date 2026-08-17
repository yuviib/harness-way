// Stat-tile contract (dataviz marks-and-anatomy.md): label (sentence case, no
// trailing colon) + value (sans semibold, proportional figures -- NOT
// tabular-nums, which looks loose at display sizes) + optional delta/trend.

import type { ReactNode } from "react";

export function StatTile({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-card border border-rule bg-paper-2 px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div
        className="mt-1.5 font-display text-[1.75rem] font-semibold leading-none"
        style={{ color: accent ? "var(--color-accent)" : "var(--color-ink)" }}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}
