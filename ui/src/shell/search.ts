/**
 * The shared global-search filter state (R0). The app-bar search box writes it; the
 * screens (R1-R6) read it to filter their content — a single cross-screen query so the
 * mockup's "Search components, things, signals…" box is one of the four paths to a
 * component. R0 wires the input + the shared state; the actual per-screen filtering
 * lands with each screen (which is why nothing filters yet — the plumbing is the point).
 */
import { createContext, useContext } from "react";

/** The shared search state exposed through {@link SearchContext}. */
export interface SearchState {
  /** The current query (verbatim; screens lower-case/normalize as they see fit). */
  query: string;
  /** Set the query (the app-bar input's onChange). */
  setQuery: (query: string) => void;
}

/** The default (no query; a no-op setter) — used when a screen renders outside the shell (tests). */
export const SearchContext = createContext<SearchState>({
  query: "",
  setQuery: () => undefined,
});

/** Read the shared search state (query + setter). */
export function useSearch(): SearchState {
  return useContext(SearchContext);
}
