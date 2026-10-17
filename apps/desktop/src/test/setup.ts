import "@testing-library/jest-dom/vitest";

// Geometry is supplied explicitly by layout tests; JSDOM does not measure boxes.
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

// JSDOM has no layout engine; rendered scroll visibility needs native coverage.
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
