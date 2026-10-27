import { useEffect, useState, useSyncExternalStore } from "react";
import { bindNativeProjectClose } from "./nativeLifecycle";
import type { ProjectLifecycle } from "./projectLifecycle";

/** The application owns this controller; an effect cleanup must not retire it during StrictMode replay. */
export function useProjectLifecycle(controller: ProjectLifecycle) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function useNativeProjectClose(controller: ProjectLifecycle, enabled: boolean) {
  const [status, setStatus] = useState<{ state: "inactive" | "registering" | "ready" | "failed"; cause?: unknown }>({ state: "inactive" });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, unbind: (() => void) | undefined;
    setStatus({ state: "registering" });
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (disposed) return;
      unbind = bindNativeProjectClose(controller, getCurrentWindow(), {
        ready: () => { if (!disposed) setStatus({ state: "ready" }); },
        failed: cause => { if (!disposed) setStatus({ state: "failed", cause }); },
      });
    }).catch(cause => { if (!disposed) setStatus({ state: "failed", cause }); });
    return () => { disposed = true; unbind?.(); };
  }, [controller, enabled]);
  return enabled ? status : { state: "inactive" as const };
}
