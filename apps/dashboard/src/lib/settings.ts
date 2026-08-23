// Connection settings the dashboard operator enters at runtime and that
// persist in the browser's own localStorage -- deliberately NEVER baked
// into the built bundle for the ONE field that's actually secret (token).
// This is a static site shipped to Cloudflare Pages; embedding a bearer
// token in that build would ship it to anyone who opens devtools, a real
// secret-leak class of bug, not a style preference.
//
// The URL fields are a different story -- they're not secret, and a
// visitor to the deployed dashboard opening it for the first time
// shouldn't have to already know the real gateway's URL just to see
// anything work. `import.meta.env.PROD` (Vite's own build-time flag, true
// only in a real `vite build`, false in `vite --host` local dev) switches
// these three defaults to the real deployed endpoints; local dev keeps the
// original localhost values unchanged. `token` stays blank either way.
import { useEffect, useState } from "react";

export interface GatewaySettings {
  gatewayHttpBase: string; // e.g. http://127.0.0.1:8787
  gatewayWsBase: string; // e.g. ws://127.0.0.1:8787
  token: string;
  originUrl: string;
  category: string;
}

const STORAGE_KEY = "mcp-relay-harness-dashboard-settings";

const DEFAULTS: GatewaySettings = import.meta.env.PROD
  ? {
      gatewayHttpBase: "https://mcp-relay-harness-gateway-production.ybains-dev.workers.dev",
      gatewayWsBase: "wss://mcp-relay-harness-gateway-production.ybains-dev.workers.dev",
      token: "",
      originUrl: "https://mcp-relay-harness-origin-simulator.ybains-dev.workers.dev/mcp",
      category: "resource_changed",
    }
  : {
      gatewayHttpBase: "http://127.0.0.1:8787",
      gatewayWsBase: "ws://127.0.0.1:8787",
      token: "",
      originUrl: "http://127.0.0.1:8794/mcp",
      category: "resource_changed",
    };

function load(): GatewaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<GatewaySettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function useGatewaySettings(): [GatewaySettings, (next: GatewaySettings) => void] {
  const [settings, setSettings] = useState<GatewaySettings>(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  return [settings, setSettings];
}
