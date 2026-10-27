import type { ProjectLifecycle } from "./projectLifecycle";

export interface NativeCloseEvent { preventDefault: () => void }
export interface NativeWindowPort {
  onCloseRequested: (receive: (event: NativeCloseEvent) => void | Promise<void>) => Promise<() => void>;
  destroy: () => Promise<void>;
}

/** Registration may finish after a component disappears; its listener still belongs to this binding. */
export function bindNativeProjectClose(controller: ProjectLifecycle, window: NativeWindowPort, callbacks: {
  ready?: () => void;
  failed?: (cause: unknown) => void;
} = {}) {
  let disposed = false, unlisten: (() => void) | undefined;
  const receive = async (event: NativeCloseEvent) => {
    event.preventDefault();
    if (!disposed) await controller.closeWindow(() => window.destroy());
  };
  try {
    void window.onCloseRequested(receive).then(cleanup => {
      if (disposed) cleanup();
      else { unlisten = cleanup; callbacks.ready?.(); }
    }).catch(cause => { if (!disposed) callbacks.failed?.(cause); });
  } catch (cause) { if (!disposed) callbacks.failed?.(cause); }
  return () => { if (disposed) return; disposed = true; unlisten?.(); unlisten = undefined; };
}
