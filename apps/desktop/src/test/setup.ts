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

// JSDOM puts every unmeasured box at (0, 0), also user-event's default click.
// A splitter's expanded hit target would then intercept unrelated form input.
// Keep only these zero-size hit targets offscreen; explicit geometry tests and
// real browser layout remain responsible for resizing, bounds and accessibility.
const unmeasuredRect = HTMLElement.prototype.getBoundingClientRect;
Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
  configurable: true,
  writable: true,
  value: function (this: HTMLElement) {
    const rect = unmeasuredRect.call(this);
    return this.hasAttribute("data-separator") && rect.width === 0 && rect.height === 0
      ? new DOMRect(-10000, -10000, 0, 0) : rect;
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
