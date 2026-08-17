// Manual light/dark override, layered on top of the OS preference already
// wired in index.css (`prefers-color-scheme` + the `:root:not([data-theme])`
// guard). Persisted so a reload doesn't reset an explicit choice.

import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "mcp-relay-harness-dashboard-theme";

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

export function useTheme(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => {
    apply(choice);
    localStorage.setItem(STORAGE_KEY, choice);
  }, [choice]);

  return [choice, setChoiceState];
}
