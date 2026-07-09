/**
 * The shell theme helpers (R0): persistence-tolerant load/save + the toggle target,
 * plus the `useTheme` hook's persist-on-change behavior over an injected storage.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyBrandTheme,
  brandTheme,
  isEcTheme,
  loadTheme,
  otherTheme,
  saveTheme,
  useTheme,
} from "../src/shell/theme";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

/** A throwing storage (private-mode / quota) — the helpers must tolerate it. */
const hostileStorage: Storage = {
  get length() {
    return 0;
  },
  clear() {
    throw new Error("nope");
  },
  getItem() {
    throw new Error("nope");
  },
  key() {
    return null;
  },
  removeItem() {
    throw new Error("nope");
  },
  setItem() {
    throw new Error("nope");
  },
};

describe("theme helpers", () => {
  it("isEcTheme / otherTheme", () => {
    expect(isEcTheme("g10")).toBe(true);
    expect(isEcTheme("g100")).toBe(true);
    expect(isEcTheme("g90")).toBe(false);
    expect(otherTheme("g100")).toBe("g10");
    expect(otherTheme("g10")).toBe("g100");
  });

  it("loadTheme defaults, reads a stored value, and tolerates a hostile storage", () => {
    const mem: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => {
        mem[k] = v;
      },
    } as unknown as Storage;
    expect(loadTheme(storage)).toBe(DEFAULT_THEME);
    saveTheme("g10", storage);
    expect(mem[THEME_STORAGE_KEY]).toBe("g10");
    expect(loadTheme(storage)).toBe("g10");
    // a junk stored value falls back to the default
    mem[THEME_STORAGE_KEY] = "purple";
    expect(loadTheme(storage)).toBe(DEFAULT_THEME);
    // hostile storage never throws
    expect(loadTheme(hostileStorage)).toBe(DEFAULT_THEME);
    expect(() => saveTheme("g10", hostileStorage)).not.toThrow();
  });

  it("useTheme starts at g100, toggles, and persists to localStorage", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe("g100");

    act(() => result.current[1]());
    expect(result.current[0]).toBe("g10");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("g10");

    act(() => result.current[1]());
    expect(result.current[0]).toBe("g100");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("g100");
  });

  it("brandTheme maps the Carbon theme onto the brand tokens' data-theme value", () => {
    expect(brandTheme("g100")).toBe("dark");
    expect(brandTheme("g10")).toBe("light");
  });

  it("applyBrandTheme stamps data-theme on the given root (defaulting to the document)", () => {
    const el = document.createElement("div");
    applyBrandTheme("g10", el);
    expect(el.dataset["theme"]).toBe("light");
    applyBrandTheme("g100", el);
    expect(el.dataset["theme"]).toBe("dark");

    applyBrandTheme("g10");
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });

  it("useTheme stamps data-theme on the document and keeps it in step with the toggle", () => {
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.dataset["theme"]).toBe("dark");

    act(() => result.current[1]());
    expect(document.documentElement.dataset["theme"]).toBe("light");

    act(() => result.current[1]());
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });
});
