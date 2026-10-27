import { expect, it, vi } from "vitest";
import { bindNativeProjectClose, type NativeCloseEvent } from "./nativeLifecycle";
import { ProjectLifecycle } from "./projectLifecycle";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("Unexpected native request"); }) }));

it("prevents native close synchronously and releases a listener registered after disposal", async () => {
  const controller = new ProjectLifecycle(), close = vi.spyOn(controller, "closeWindow").mockResolvedValue(false);
  let receive!: (event: NativeCloseEvent) => void | Promise<void>, finish!: (cleanup: () => void) => void;
  const unlisten = vi.fn(), ready = vi.fn(), destroy = vi.fn(async () => {});
  const dispose = bindNativeProjectClose(controller, { onCloseRequested: callback => { receive = callback; return new Promise(resolve => { finish = resolve; }); }, destroy }, { ready });
  const event = { preventDefault: vi.fn() }, result = receive(event);
  expect(event.preventDefault).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); await result;
  dispose(); finish(unlisten); await Promise.resolve();
  expect(unlisten).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled();
  await receive(event); expect(close).toHaveBeenCalledOnce(); expect(destroy).not.toHaveBeenCalled(); controller.dispose();
});

it("reports failed native registration and removes an established listener exactly once", async () => {
  const controller = new ProjectLifecycle(), failed = vi.fn(), unlisten = vi.fn();
  const first = bindNativeProjectClose(controller, { onCloseRequested: async () => { throw new Error("Native event unavailable"); }, destroy: async () => {} }, { failed });
  await Promise.resolve(); await Promise.resolve(); expect(failed).toHaveBeenCalledOnce(); first();
  const second = bindNativeProjectClose(controller, { onCloseRequested: async () => unlisten, destroy: async () => {} });
  await Promise.resolve(); second(); second(); expect(unlisten).toHaveBeenCalledOnce(); controller.dispose();
});
