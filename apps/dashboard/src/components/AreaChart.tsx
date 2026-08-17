// Trend over time, single series -> area chart per dataviz choosing-a-form.md.
// 2px line, ~10% opacity fill wash, hairline solid gridlines (never dashed),
// a crosshair + tooltip on hover (the default interaction layer for line/area,
// not optional), and tabular-nums on the axis ticks.

import { useMemo, useState } from "react";

export interface AreaPoint {
  t: number; // ms epoch, bucket start
  value: number;
}

const PADDING = { top: 12, right: 12, bottom: 24, left: 36 };

export function AreaChart({
  points,
  height = 180,
  formatX,
  label,
}: {
  points: AreaPoint[];
  height?: number;
  formatX: (t: number) => string;
  label: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const width = 640;

  const { path, areaPath, xFor, yFor, ticksY } = useMemo(() => {
    const innerW = width - PADDING.left - PADDING.right;
    const innerH = height - PADDING.top - PADDING.bottom;
    const maxVal = Math.max(1, ...points.map((p) => p.value));
    // round the axis ceiling to a clean number, per marks-and-anatomy.md
    const magnitude = 10 ** Math.floor(Math.log10(maxVal || 1));
    const roundedMax = Math.ceil(maxVal / magnitude) * magnitude || 1;

    const xForFn = (i: number) => PADDING.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * innerW);
    const yForFn = (v: number) => PADDING.top + innerH - (v / roundedMax) * innerH;

    const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xForFn(i)} ${yForFn(p.value)}`).join(" ");
    const area =
      points.length > 0
        ? `${linePath} L ${xForFn(points.length - 1)} ${PADDING.top + innerH} L ${xForFn(0)} ${PADDING.top + innerH} Z`
        : "";

    const stepCount = 4;
    const ticks = Array.from({ length: stepCount + 1 }, (_, i) => (roundedMax / stepCount) * i);

    return { path: linePath, areaPath: area, xFor: xForFn, yFor: yForFn, ticksY: ticks };
  }, [points, height]);

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>
        No data yet
      </div>
    );
  }

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * width;
          const innerW = width - PADDING.left - PADDING.right;
          const frac = (relX - PADDING.left) / innerW;
          const idx = Math.round(frac * (points.length - 1));
          setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
        }}
      >
        {/* hairline gridlines -- solid, one step off the surface */}
        {ticksY.map((tick) => (
          <g key={tick}>
            <line
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke="var(--color-rule)"
              strokeWidth={1}
            />
            <text x={PADDING.left - 8} y={yFor(tick) + 3} textAnchor="end" className="fill-muted font-mono text-[10px] tabular">
              {Math.round(tick)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="var(--color-chart-1)" opacity={0.1} />
        <path d={path} fill="none" stroke="var(--color-chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* end marker */}
        {points.length > 0 && (
          <circle
            cx={xFor(points.length - 1)}
            cy={yFor(points[points.length - 1]!.value)}
            r={4}
            fill="var(--color-chart-1)"
            stroke="var(--color-paper)"
            strokeWidth={2}
          />
        )}

        {/* crosshair */}
        {hoverIdx !== null && (
          <>
            <line
              x1={xFor(hoverIdx)}
              x2={xFor(hoverIdx)}
              y1={PADDING.top}
              y2={height - PADDING.bottom}
              stroke="var(--color-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <circle
              cx={xFor(hoverIdx)}
              cy={yFor(points[hoverIdx]!.value)}
              r={4}
              fill="var(--color-chart-1)"
              stroke="var(--color-paper)"
              strokeWidth={2}
            />
          </>
        )}

        {/* x-axis labels: first, middle, last only -- avoid crowding */}
        {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i, idx) => (
          <text
            key={`${i}-${idx}`}
            x={xFor(i)}
            y={height - 6}
            textAnchor={idx === 0 ? "start" : idx === 2 ? "end" : "middle"}
            className="fill-muted font-mono text-[10px]"
          >
            {formatX(points[i]!.t)}
          </text>
        ))}
      </svg>

      {hovered && hoverIdx !== null && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs shadow-sm"
          style={{
            left: `${(xFor(hoverIdx) / width) * 100}%`,
            transform: xFor(hoverIdx) > width * 0.7 ? "translateX(-100%)" : "translateX(8px)",
          }}
        >
          <div className="text-muted">{formatX(hovered.t)}</div>
          <div className="font-mono font-medium text-ink tabular">
            {hovered.value.toLocaleString()} {label}
          </div>
        </div>
      )}
    </div>
  );
}
