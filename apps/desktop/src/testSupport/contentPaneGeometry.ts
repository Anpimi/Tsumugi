import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";

/** Explicit synthetic container geometry, without claiming JSDOM measured layout. */
export function controlContentPaneGeometry() {
  const observers = new Set<ControlledObserver>();
  class ControlledObserver implements ResizeObserver {
    targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); observers.delete(this); }
  }
  vi.stubGlobal("ResizeObserver", ControlledObserver);
  return (element: Element, width: number, height = 600) => {
    act(() => {
      for (const observer of observers) {
        if (!observer.targets.has(element)) continue;
        const box = [{ inlineSize: width, blockSize: height }];
        observer.callback([{ target: element, contentRect: new DOMRect(0, 0, width, height),
          borderBoxSize: box, contentBoxSize: box, devicePixelContentBoxSize: box }], observer);
      }
    });
  };
}

export function pointerCaptureFor(element: HTMLElement) {
  const captured = new Set<number>();
  const set = vi.fn((pointer: number) => { captured.add(pointer); });
  const release = vi.fn((pointer: number) => { captured.delete(pointer); });
  Object.defineProperties(element, { setPointerCapture: { configurable: true, value: set },
    releasePointerCapture: { configurable: true, value: release }, hasPointerCapture: { configurable: true, value: (pointer: number) => captured.has(pointer) } });
  return { set, release };
}

export function panePointer(element: HTMLElement, type: string, x: number, y = 0, pointer = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: pointer }, isPrimary: { value: true } });
  fireEvent(element, event);
}

/** Product geometry notifications commit on the next animation frame. */
export async function paintContentPanes() {
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
}
