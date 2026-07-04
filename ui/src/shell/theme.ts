/**
 * Theme selection + persistence for the app shell (R0). The console was hard-pinned to
 * Carbon `g100` (dark, the signed-off hi-fi theme); this adds a working light/dark switch
 * — `g10` (light) ↔ `g100` (dark) — persisted in `localStorage` so a reload keeps the
 * operator's choice. The default stays `g100` (the mockup's primary palette).
 *
 * Pure helpers + a thin hook, so the persistence is unit-testable with an injected
 * `Storage` and no `window` (the client/store discipline applied to the shell).
 */
import { useCallback, useEffect, useState } from "react";

/** The two Carbon themes the console ships. */
export type EcTheme = "g10" | "g100";

/** The default (the hi-fi's dark palette). */
export const DEFAULT_THEME: EcTheme = "g100";

/** The `localStorage` key the choice persists under. */
export const THEME_STORAGE_KEY = "ec-theme";

/** Whether a value is one of the shipped themes. */
export function isEcTheme(value: unknown): value is EcTheme {
  return value === "g10" || value === "g100";
}

/** The opposite theme (the toggle target). */
export function otherTheme(theme: EcTheme): EcTheme {
  return theme === "g100" ? "g10" : "g100";
}

/** Read the persisted theme (defaulting), tolerating a missing/hostile storage. */
export function loadTheme(storage?: Storage): EcTheme {
  try {
    const store = storage ?? window.localStorage;
    const value = store.getItem(THEME_STORAGE_KEY);
    return isEcTheme(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persist the theme, tolerating a missing/hostile storage (private mode, quota). */
export function saveTheme(theme: EcTheme, storage?: Storage): void {
  try {
    (storage ?? window.localStorage).setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort — a blocked storage must never break the shell.
  }
}

/** The shell's theme state: `[theme, toggle]`, persisted across reloads. */
export function useTheme(): [EcTheme, () => void] {
  const [theme, setTheme] = useState<EcTheme>(() => loadTheme());
  const toggle = useCallback(() => setTheme((t) => otherTheme(t)), []);
  useEffect(() => {
    saveTheme(theme);
  }, [theme]);
  return [theme, toggle];
}
