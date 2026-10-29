import { memo, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ReleaseDraftSession, useReleaseDraftSession } from "../../../ReleaseDraftSession";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Banner } from "../../../design-system/Feedback";
import type { LeaveIntent, LifecycleParticipant, ProjectLifecycle } from "../../platform/projectLifecycle";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { DeliveryOwnerHandle } from "./deliveryTypes";

export interface DeliveryOwnerHostProps {
  project: ProjectView;
  lifecycle: ProjectLifecycle;
  gate: InteractionGate;
  onOwner: (owner: DeliveryOwnerHandle | null) => void;
  onParticipant?: (participant: LifecycleParticipant | null) => void;
  onReveal: () => void;
}
type ReleaseState = ReturnType<DeliveryOwnerHandle["current"]>;
interface LeaveRequest {
  before: ReleaseState;
  proof: () => boolean;
  current: () => boolean;
  resolve: (allowed: boolean) => void;
}
const leavesProject = (intent: LeaveIntent) => ["create-project", "open-project", "close-project", "close-window"].includes(intent.kind);
function blocked(owner: DeliveryOwnerHandle) {
  const state = owner.current(), workflow = state.workflow;
  return owner.reserved() || state.busy || state.workflowControlBusy || state.checkingDelivery || state.checkingStart
    || !!workflow && !(workflow.safety?.admissionClosed && workflow.safety.callbacksDrained);
}
function dirty(state: ReleaseState) {
  return state.buildDirty || state.deliveryDirty || !!state.workflow || !!state.prepared && !state.attempt || !!state.checkReview && !state.checkAttempt;
}
function needsBuildDiscard(state: ReleaseState) {
  return state.buildDirty || !!state.prepared || !!state.checkReview || !!state.attempt || !!state.checkAttempt || !!state.workflow;
}
function sameDelivery(left: ReleaseState, right: ReleaseState) {
  return left.chosen === right.chosen && left.selection === right.selection && left.preview === right.preview
    && left.overwrite === right.overwrite && left.result === right.result && left.deliveryDirty === right.deliveryDirty;
}

function DeliveryOwnerBridge({ project, lifecycle, gate, onOwner, onParticipant, onReveal }: DeliveryOwnerHostProps) {
  const value = useReleaseDraftSession(), context = executionContext(project), { t } = useTranslation();
  const owner = useRef(value), callbacks = useRef({ onOwner, onReveal });
  const published = useRef<ReleaseState | null>(null), revision = useRef({ state: value.current(), sequence: 0 });
  const mounted = useRef(false), currentRequest = useRef<LeaveRequest | null>(null), discarding = useRef(false);
  const [request, setRequest] = useState<LeaveRequest | null>(null), [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLElement | null>(null), dialogId = useId();
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  useLayoutEffect(() => {
    owner.current = value; callbacks.current = { onOwner, onReveal };
    const state = value.current();
    if (published.current === state) return;
    published.current = state; callbacks.current.onOwner(value);
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; currentRequest.current?.resolve(false); currentRequest.current = null;
      published.current = null; callbacks.current.onOwner(null);
    };
  }, []);
  useLayoutEffect(() => request ? gate.pushDialog(dialogId) : undefined, [request, gate, dialogId]);

  function finish(allowed: boolean) {
    const pending = currentRequest.current; currentRequest.current = null;
    if (mounted.current) setRequest(null);
    pending?.resolve(allowed);
  }
  useLayoutEffect(() => {
    function inspect(intent: LeaveIntent) {
      if (!leavesProject(intent)) return { status: "ready" as const, revision: "retained-delivery-session" };
      const current = owner.current, state = current.current();
      if (revision.current.state !== state) revision.current = { state, sequence: revision.current.sequence + 1 };
      const reserved = blocked(current);
      return { status: reserved ? "blocked" as const : dirty(state) ? "dirty" as const : "ready" as const,
        revision: `${revision.current.sequence}:${reserved}` };
    }
    const participant: LifecycleParticipant = { id: "delivery-release", area: "release", scope: { kind: "project", ...context }, inspect,
      prepareLeave: async (intent, proof, current) => {
        if (!leavesProject(intent)) return proof() && current();
        if (!mounted.current || currentRequest.current || !proof() || !current()) return false;
        if (blocked(owner.current)) { callbacks.current.onReveal(); return false; }
        const before = owner.current.current();
        if (!dirty(before)) return true;
        if (gate.getSnapshot().composingOwners.length) return false;
        trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        callbacks.current.onReveal();
        return new Promise<boolean>(resolve => {
          const next = { before, proof, current, resolve }; currentRequest.current = next; setRequest(next);
        });
      }, reveal: () => callbacks.current.onReveal() };
    if (onParticipant) { onParticipant(participant); return () => onParticipant(null); }
    return lifecycle.register(participant);
  }, [lifecycle, gate, context.projectId, context.sessionToken, onParticipant]);

  function canAnswer() {
    return mounted.current && gate.canDispatch({ viewId: gate.getSnapshot().visibleViewId, source: "button", dialogId });
  }
  async function discardPreparation() {
    const pending = currentRequest.current, original = owner.current;
    if (!pending || discarding.current || !canAnswer()) return;
    if (!pending.proof() || !pending.current() || original.current() !== pending.before || blocked(original)) { finish(false); return; }
    discarding.current = true; setBusy(true);
    try {
      // Discard changes its own snapshot and running lock. The original proof
      // is checked before dispatch; the owner protects newer edits during it.
      const accepted = !needsBuildDiscard(pending.before) || await original.discardBuild(true);
      if (!mounted.current || currentRequest.current !== pending) return;
      const after = owner.current.current();
      if (!accepted || !pending.current() || after.editSeq !== pending.before.editSeq || !sameDelivery(pending.before, after) || blocked(owner.current)) {
        finish(false); callbacks.current.onReveal(); return;
      }
      finish(owner.current.reset());
    } finally {
      discarding.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const changed = request !== null && value.current() !== request.before;
  return <Dialog open={request !== null} title={t("release.unsaved")} description={t("release.unsavedHelp")}
    closeLabel={t("deliveryWorkbench.closeConfirmation")} closeDisabled={busy || interaction.composingOwners.length > 0}
    onOpenChange={open => { if (!open && !discarding.current && gate.getSnapshot().composingOwners.length === 0) finish(false); }}
    onPointerDownOutside={event => event.preventDefault()}
    onEscapeKeyDown={event => { if (busy || event.isComposing || event.keyCode === 229 || gate.getSnapshot().composingOwners.length) event.preventDefault(); }}
    onCloseAutoFocus={event => {
      event.preventDefault(); const target = trigger.current; trigger.current = null;
      if (target?.isConnected && !target.matches(":disabled") && !target.closest("[hidden]")) target.focus();
    }} footer={<><Button disabled={busy || !canAnswer()} onClick={() => finish(false)}>{t("release.stay")}</Button>
      <Button variant="danger" pending={busy} disabled={!canAnswer() || changed || !request?.proof() || !request.current() || blocked(value)}
        onClick={() => { void discardPreparation(); }}>{t("release.discard")}</Button></>}>
    {changed && !busy ? <Banner tone="warning" role="status">{t("deliveryWorkbench.leaveChanged")}</Banner> : null}
  </Dialog>;
}

/** One release owner is retained for the whole project, independently of the visible delivery tab. */
function DeliveryOwnerHost(props: DeliveryOwnerHostProps) {
  return <ReleaseDraftSession project={props.project}><DeliveryOwnerBridge {...props}/></ReleaseDraftSession>;
}
export default memo(DeliveryOwnerHost);
