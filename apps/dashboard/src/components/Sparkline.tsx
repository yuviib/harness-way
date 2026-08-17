// Inter-arrival latency -- the actual "network diagnostics" signal: how
// regular is the cadence of messages hitting this connection. A steady bar
// height means a healthy, regular feed; ragged bars mean jitter. Bar mark
// spec: capped thickness, 4px rounded data-end, square at the baseline.

export function Sparkline({ values, height = 40 }: { values: number[]; height?: number }) {
  if (values.length === 0) {
    return <div style={{ height }} className="flex items-center text-xs text-muted">Waiting for data…</div>;
  }
  const max = Math.max(...values, 1);
  const width = Math.max(values.length * 10, 60);
  const barW = 6;
  const gap = 4;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="overflow-visible">
      <line x1={0} x2={width} y1={height - 1} y2={height - 1} stroke="var(--color-rule)" strokeWidth={1} />
      {values.map((v, i) => {
        const barH = Math.max(2, (v / max) * (height - 6));
        const x = i * (barW + gap);
        const y = height - barH - 1;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={barH}
            rx={2}
            fill={i === values.length - 1 ? "var(--color-accent)" : "var(--color-rule-2)"}
          />
        );
      })}
    </svg>
  );
}
