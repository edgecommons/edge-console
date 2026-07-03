/**
 * jsdom gaps some Carbon components probe: matchMedia + ResizeObserver +
 * scrollIntoView. Stubbed here (vitest `setupFiles`) so component tests exercise
 * the real Carbon markup.
 */
if (typeof window !== "undefined") {
  if (window.matchMedia === undefined) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined, // legacy API some libs still call
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
  if (globalThis.ResizeObserver === undefined) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }
  if (typeof Element !== "undefined" && Element.prototype.scrollIntoView === undefined) {
    // jsdom ships no scrollIntoView; Carbon's Dropdown scrolls its highlighted item.
    Element.prototype.scrollIntoView = () => undefined;
  }
}
