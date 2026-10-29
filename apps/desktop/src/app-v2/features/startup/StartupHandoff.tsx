import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import type { StartupClaimRequest } from "../../../startupCommands";
import type { SourceOwner } from "../source/sourceTypes";
import type { ProjectLifecycle } from "../../platform/projectLifecycle";
import type { InteractionGate } from "../../workspace/interactionGate";

export default function StartupHandoff({ request, owner, lifecycle, gate, disabled, onHandled, onOpen }: {
  request: StartupClaimRequest; owner: SourceOwner | null; lifecycle: ProjectLifecycle; gate: InteractionGate; disabled: boolean;
  onHandled: () => void; onOpen: () => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "startup" });
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), flight = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => {
    const state = lifecycle.getSnapshot(), project = state.session?.project;
    return mounted.current && !disabled && state.phase === "idle" && !state.pending && !state.cleanup && !state.retainedSession
      && project?.metadata.projectId === request.projectId && project.sessionToken === request.sessionToken;
  };
  async function continueImport() {
    if (!owner || flight.current || !current() || !gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button" })) return;
    flight.current = true; setBusy(true); setFailed(false);
    try {
      const accepted = await owner.claimStartup(request, current);
      if (!current()) return;
      if (accepted) onHandled(); else setFailed(true);
      if (gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button" })) onOpen();
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <Banner tone={failed ? "warning" : "info"} action={<>
    <Button disabled={disabled || !owner || owner.journal.hydration !== "ready" || busy} pending={busy} onClick={() => void continueImport()}>{t("continueImport")}</Button>
    <Button disabled={disabled || busy} onClick={onHandled}>{t("importLater")}</Button>
  </>}>{t(failed ? "handoffFailed" : "createdBeforeImport")}</Banner>;
}
