import { useState } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { IconMonitor, IconMoon, IconSettings, IconSun } from "./components/Icons";
import { SettingsPanel } from "./components/SettingsPanel";
import { useGatewaySettings } from "./lib/settings";
import { type ThemeChoice, useTheme } from "./lib/theme";
import { AgentsView } from "./views/AgentsView";
import { CacheMetrics } from "./views/CacheMetrics";
import { GapAudit } from "./views/GapAudit";
import { LiveFanoutView } from "./views/LiveFanoutView";

type Tab = "fanout" | "gaps" | "agents" | "cache";

const THEME_OPTIONS: { choice: ThemeChoice; Icon: typeof IconSun; label: string }[] = [
  { choice: "light", Icon: IconSun, label: "Light" },
  { choice: "dark", Icon: IconMoon, label: "Dark" },
  { choice: "system", Icon: IconMonitor, label: "System" },
];

function ThemeToggle() {
  const [choice, setChoice] = useTheme();
  return (
    <div className="flex items-center rounded-control border border-rule p-0.5">
      {THEME_OPTIONS.map(({ choice: c, Icon, label }) => (
        <button
          key={c}
          type="button"
          aria-label={`${label} theme`}
          aria-pressed={choice === c}
          onClick={() => setChoice(c)}
          className="rounded-[4px] p-1.5 text-muted transition-colors hover:text-ink"
          style={choice === c ? { background: "var(--color-paper-2)", color: "var(--color-accent)" } : undefined}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useGatewaySettings();
  const [tab, setTab] = useState<Tab>("fanout");
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="min-h-svh bg-paper text-ink-2">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-[17px] font-semibold tracking-tight text-ink">MCP Relay Harness</span>
            <span className="text-xs text-muted">operator dashboard</span>
          </div>
          <div className="flex items-center gap-2.5">
            <ThemeToggle />
            <div className="relative">
              <button
                type="button"
                aria-label="Connection settings"
                onClick={() => setSettingsOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-control border border-rule px-2.5 py-[7px] text-xs text-ink-2 transition-colors hover:border-rule-2"
              >
                <IconSettings />
                Settings
              </button>
              {settingsOpen && (
                <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
              )}
            </div>
          </div>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 px-6">
          {(
            [
              ["fanout", "Live Fan-out"],
              ["gaps", "Gap Audit"],
              ["agents", "Agents"],
              ["cache", "Cache Metrics"],
            ] as const
          ).map(([id, tabLabel]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className="relative px-3 py-2.5 text-sm transition-colors"
              style={{ color: tab === id ? "var(--color-ink)" : "var(--color-muted)" }}
            >
              {tabLabel}
              {tab === id && <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-accent" />}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {!settings.token && (
          <div className="mb-5 rounded-card border border-rule bg-paper-2 px-4 py-3 text-sm text-ink-2">
            Enter a token in <span className="font-medium text-ink">Settings</span> before connecting.
          </div>
        )}
        <ErrorBoundary key={tab}>
          {tab === "fanout" && <LiveFanoutView settings={settings} />}
          {tab === "gaps" && <GapAudit settings={settings} />}
          {tab === "agents" && <AgentsView settings={settings} />}
          {tab === "cache" && <CacheMetrics settings={settings} />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
