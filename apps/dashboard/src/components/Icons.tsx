// One small hand-built line-icon set, one stroke voice throughout (1.6px,
// round joins) -- deliberately not pulling in an icon library for ~8 icons.
// Mixing library icons with hand-built ones is the "mismatched icon set"
// tell; a single consistent voice, however small, reads as considered.

import type { SVGProps } from "react";

function base(props: SVGProps<SVGSVGElement>) {
  return {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

export function IconSun(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1" />
    </svg>
  );
}

export function IconMoon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M13.5 9.5A5.8 5.8 0 0 1 6.5 2.5a5.8 5.8 0 1 0 7 7Z" />
    </svg>
  );
}

export function IconMonitor(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
      <path d="M5.5 14h5M8 11v3" />
    </svg>
  );
}

export function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.8v1.4M8 12.8v1.4M14.2 8h-1.4M3.2 8H1.8M12.2 3.8l-1 1M4.8 11.2l-1 1M12.2 12.2l-1-1M4.8 4.8l-1-1" />
    </svg>
  );
}

export function IconChevronDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function IconCircleDot(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconAlertTriangle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M8 2.3 1.7 13.2h12.6L8 2.3Z" />
      <path d="M8 6.3v3M8 11.3v.1" />
    </svg>
  );
}

export function IconXCircle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6 6l4 4M10 6l-4 4" />
    </svg>
  );
}

export function IconActivity(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M1.5 8.5h3l1.5-4.5 3 8L10.5 8.5H14.5" />
    </svg>
  );
}

export function IconArrowRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d="M2 8h11.5M9.5 4l4 4-4 4" />
    </svg>
  );
}
