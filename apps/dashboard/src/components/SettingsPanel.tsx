// Bordered popover, not a floating pill (that's Coral's vocabulary, not
// Cobalt's) -- opens from the settings gear, closes on outside click / Escape.

import { useEffect, useRef } from "react";
import type { GatewaySettings } from "../lib/settings";

export function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: GatewaySettings;
  onChange: (next: GatewaySettings) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const field = (key: keyof GatewaySettings, label: string, type = "text") => (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="text-muted">{label}</span>
      <input
        type={type}
        value={settings[key]}
        onChange={(e) => onChange({ ...settings, [key]: e.target.value })}
        className="rounded-control border border-rule bg-paper px-2.5 py-1.5 font-mono text-[13px] text-ink outline-none focus-visible:border-accent"
      />
    </label>
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Connection settings"
      className="absolute right-0 top-[calc(100%+8px)] z-dropdown w-[340px] rounded-card border border-rule bg-paper-2 p-4 shadow-lg"
    >
      <div className="mb-3 text-sm font-medium text-ink">Connection settings</div>
      <div className="grid grid-cols-1 gap-3">
        {field("gatewayHttpBase", "Gateway HTTP base")}
        {field("gatewayWsBase", "Gateway WS base")}
        {field("token", "Token", "password")}
        {field("originUrl", "Origin URL")}
        {field("category", "Category")}
      </div>
      <p className="mt-3 border-t border-rule pt-3 text-[11px] leading-relaxed text-muted">
        Stored only in this browser's localStorage — never baked into the deployed dashboard build.
      </p>
    </div>
  );
}
