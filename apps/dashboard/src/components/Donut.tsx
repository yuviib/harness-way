// Part-to-whole donut -- legitimate use per dataviz/anti-patterns.md ("part-to-
// whole at a glance only, <= 6 segments"), unlike a 2-slice pie (explicitly an
// anti-pattern; see the two gap-cause stat tiles in GapAudit instead). Fixed
// categorical hues in order, a 2px surface gap between segments (never a
// stroke), a legend (mandatory for >= 2 series), and a real per-segment hover
// tooltip -- not a static image.

import { useId, useState } from "react";

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

const GAP_DEG = 3; // surface-color gap between segments, in degrees of arc

export function Donut({ slices, size = 168 }: { slices: DonutSlice[]; size?: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const gradientId = useId();
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const radius = size / 2;
  const stroke = size * 0.22;
  const innerRadius = radius - stroke / 2;
  const circumference = 2 * Math.PI * innerRadius;

  if (total === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted" style={{ width: size, height: size }}>
        No data yet
      </div>
    );
  }

  let cursor = 0;
  const segments = slices.map((slice) => {
    const fraction = slice.value / total;
    const arcLen = Math.max(0, circumference * fraction - GAP_DEG);
    const offset = circumference * (1 - cursor / total);
    cursor += slice.value;
    return { ...slice, fraction, arcLen, offset };
  });

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={radius} cy={radius} r={innerRadius} fill="none" stroke="var(--color-rule)" strokeWidth={stroke} />
          {segments.map((seg, i) => (
            <circle
              key={seg.label}
              cx={radius}
              cy={radius}
              r={innerRadius}
              fill="none"
              stroke={seg.color}
              strokeWidth={stroke}
              strokeDasharray={`${seg.arcLen} ${circumference - seg.arcLen}`}
              strokeDashoffset={seg.offset}
              strokeLinecap="butt"
              opacity={hovered === null || hovered === i ? 1 : 0.35}
              className="cursor-pointer transition-opacity duration-150"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-2xl font-medium text-ink tabular">
            {hovered !== null ? segments[hovered]!.value.toLocaleString() : total.toLocaleString()}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-muted">
            {hovered !== null ? segments[hovered]!.label : "total"}
          </span>
        </div>
      </div>

      {/* Legend -- mandatory for >= 2 series, doubles as the table-view twin */}
      <ul className="flex flex-col gap-2" aria-label={`${gradientId}-legend`}>
        {segments.map((seg, i) => (
          <li key={seg.label}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-paper-2"
              style={{ opacity: hovered === null || hovered === i ? 1 : 0.5 }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: seg.color }} />
              <span className="text-ink-2">{seg.label}</span>
              <span className="ml-auto font-mono tabular text-muted">
                {seg.value.toLocaleString()} · {(seg.fraction * 100).toFixed(0)}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
