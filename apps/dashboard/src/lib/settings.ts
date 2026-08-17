// Connection settings the dashboard operator enters at runtime and that
// persist in the browser's own localStorage -- deliberately NEVER baked
// into the built bundle. This is a static site shipped to Cloudflare
// Pages; embedding a bearer token in that build would ship it to anyone
// who opens devtools, a real secret-leak class of bug, not a style
// preference. Defaults below match the gateway's own documented dev-only
// values (see wrangler.toml) purely as a local-dev convenience, not
// something to rely on for a real deployment.

import { useEffect, useState } from "react";

export interface GatewaySettings {
  gatewayHttpBase: string; // e.g. http://127.0.0.1:8787
  gatewayWsBase: string; // e.g. ws://127.0.0.1:8787
  token: string;
  originUrl: string;
  category: string;
}

const STORAGE_KEY = "mcp-relay-harness-dashboard-settings";

const DEFAULTS: GatewaySettings = {
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
