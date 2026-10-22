import { useRef, useState } from "react";
import { useConnectionFacts, connectionConfigCurrent } from "./ApplicationReadProvider";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { connectionAiConfig, editedAiConfig, type AiConfig } from "./aiCommands";
import type { ConnectionReadView } from "./connectionCommands";
import { validateRequestWorkPlanTeamRecoveryPrepare } from "./generated/ai.validators";
import { jsonIdentity } from "./pluginToolChoices";
import { hasUnknownOutcome } from "./projectCommands";
import { workPlanCommands, type WorkPlanView, type TeamExecutionView } from "./workPlanCommands";
import type { WorkPlanTeamRecoveryPrepareRequest, WorkPlanTeamRecoveryAuthorizeRequest, WorkPlanStartRequest, AutomationEffect, TeamWorkReference } from "./generated/ai.requests";
import type { WorkPlanTeamRecoveryPreviewView, WorkPlanTeamRecoveryStateView, TeamRecoveryReceipt } from "./generated/ai.responses";
import { recoveryDraft, unchangedRecoveryMember, recoveryDraftProblem, type TeamRecoveryDraft } from "./TeamRecoveryDraft";

type Capture = { request: WorkPlanTeamRecoveryPrepareRequest; value: WorkPlanTeamRecoveryPreviewView; plan: WorkPlanView; effects: AutomationEffect[]; memberKeys: number[]; unresolvedWork: TeamWorkReference[]; editSeq: number };
type Pending = { kind: "authorize"; request: WorkPlanTeamRecoveryAuthorizeRequest; capture: Capture }
  | { kind: "close"; request: WorkPlanTeamRecoveryAuthorizeRequest; capture: Capture }
  | { kind: "start"; request: WorkPlanStartRequest; capture: Capture; receipt: TeamRecoveryReceipt };
interface RecoveryState {
  draft: TeamRecoveryDraft | null; editSeq: number; dirty: boolean; preparing: boolean; capture: Capture | null; consent: boolean;
  pending: (Pending & { phase: "sending" | "unknown" | "checking"; retryAllowed: boolean }) | null;
  ready: { capture: Capture; receipt: TeamRecoveryReceipt } | null;
  failure: CommandFailure | null; notice: "authorized" | "started" | "absent" | "newer" | "ended" | "closed" | "closeAbsent" | null;
}
const initial = (): RecoveryState => ({ draft: null, editSeq: 0, dirty: false, preparing: false, capture: null, consent: false, pending: null, ready: null, failure: null, notice: null });
export function teamRecoveryAvailable(value: WorkPlanTeamRecoveryStateView): boolean {
  return (value.state.state === "paused" || value.state.state === "taken-over") && value.runtime?.originalDeadlineAvailable === true
    && value.runtime.producersDrained && value.hostCallbacksDrained && BigInt(value.state.expiresAtMs) > BigInt(Date.now());
}
function sameBasis(value: WorkPlanTeamRecoveryStateView, capture: Capture): boolean {
  const preview = capture.value.preview;
  return value.state.planId === preview.planId && jsonIdentity(value.state.lease) === jsonIdentity(preview.baseLease)
    && jsonIdentity(value.state.effectiveVersion) === jsonIdentity(preview.baseEffectiveVersion);
}
/** One local workflow, owned by the original AI preparation session. */
export function useTeamRecoverySession(live: () => boolean, context: SessionRequest, available: () => boolean,
  changed: () => void, started: (capture: WorkPlanView, receipt: TeamRecoveryReceipt, unitId: string) => void) {
  const [state, setState] = useState(initial), ref = useRef(state), liveRef = useRef(live), captureGeneration = useRef(0), connections = useConnectionFacts();
  liveRef.current = live;
  function update(change: (before: RecoveryState) => RecoveryState) { if (!liveRef.current()) return; ref.current = change(ref.current); setState(ref.current); }
  const current = () => ref.current;
  const blocked = () => current().preparing || !!current().pending || !!current().ready;
  function edit(change: (before: TeamRecoveryDraft) => TeamRecoveryDraft) {
    if (!liveRef.current() || !current().draft) return;
    update(before => ({ ...before, draft: change(before.draft!), editSeq: before.editSeq + 1, dirty: true, capture: null, consent: false, failure: null, notice: null }));
  }
  function begin(plan: WorkPlanView, view: TeamExecutionView) {
    if (!liveRef.current() || blocked() || !available() || view.planId !== plan.planId) return;
    if (current().draft && (current().dirty || current().draft?.planId === plan.planId)) return;
    update(before => ({ ...initial(), draft: recoveryDraft(plan, view), editSeq: before.editSeq + 1 }));
  }
  function connectionCurrent(capture = current().capture): boolean {
    return !!capture && capture.value.preview.members.every(member => connectionConfigCurrent(connections.current(), member.config));
  }
  function invalidateCapture() { captureGeneration.current++; if (current().capture) update(before => ({ ...before, capture: null, consent: false })); }
  function selectConnection(key: number, view: ConnectionReadView | null, id: string, editSeq: number) {
    if (!liveRef.current() || current().editSeq !== editSeq || !current().draft?.members.some(member => member.key === key)) return false;
    const profile = view?.snapshot.profiles.find(profile => profile.id === id && !profile.archived), reference = view?.references.find(reference => reference.profileId === id);
    if (id && (!profile || !reference || view !== connections.current())) return false;
    edit(before => ({ ...before, members: before.members.map(member => member.key !== key ? member : { ...member,
      config: id && profile && reference ? connectionAiConfig(member.config, profile.connection, reference) : { ...member.config, connectionProfile: null } }) }));
    return true;
  }
  function editConfig(key: number, change: AiConfig | ((before: AiConfig) => AiConfig)) {
    edit(before => ({ ...before, members: before.members.map(member => member.key !== key ? member : { ...member,
      config: editedAiConfig(member.config, typeof change === "function" ? change(member.config) : change) }) }));
  }
  async function prepare(plan: WorkPlanView, view: TeamExecutionView, observation: WorkPlanTeamRecoveryStateView, effects: AutomationEffect[]) {
    const before = current(), draft = before.draft && structuredClone(before.draft), editSeq = before.editSeq, generation = captureGeneration.current;
    if (!liveRef.current() || !available() || blocked() || !draft || draft.planId !== plan.planId || !teamRecoveryAvailable(observation)
      || recoveryDraftProblem(draft, plan, view) || observation.state.unresolvedWork.length > 16
      || observation.state.unresolvedWork.some(reference => !draft.priorWork.some(value => jsonIdentity(value) === jsonIdentity(reference))) || draft.members.some(member => !connectionConfigCurrent(connections.current(), member.config))) return;
    update(value => ({ ...value, preparing: true, capture: null, consent: false, failure: null, notice: null }));
    try {
      const members = await Promise.all(draft.members.map(async member => {
        const toolHandles = member.toolRowIds.map(id => plan.tools!.entries[id].handle), same = unchangedRecoveryMember(member, toolHandles);
        const [memberId, roleVersionId] = await Promise.all([member.original?.memberId ?? executionCommands.identity(context),
          same ? member.original!.roleVersionId : executionCommands.identity(context)]);
        return { memberId, roleVersionId, displayName: member.displayName, role: member.role, config: member.config, unitIds: member.unitIds, toolHandles, kinds: member.kinds };
      }));
      const [preparationId, workId] = await Promise.all([executionCommands.identity(context), executionCommands.identity(context)]);
      const basis = plan.scope.find(unit => unit.unitId === draft.unitId)!;
      const request = { ...context, preparationId, recovery: {
        projectId: context.projectId, planId: plan.planId, expectedLease: structuredClone(observation.state.lease),
        expectedEffectiveVersion: structuredClone(observation.state.effectiveVersion), members,
        work: { workId, memberId: members[draft.members.findIndex(member => member.key === draft.recipientKey)].memberId,
          kind: draft.kind, instructions: draft.instructions, postIds: draft.postIds, priorWork: draft.priorWork,
          target: { unitId: basis.unitId, locale: plan.locale, sourceSnapshotId: basis.sourceSnapshotId, sourceRevisionId: basis.sourceRevisionId } } } };
      if (!validateRequestWorkPlanTeamRecoveryPrepare(request)) throw new Error("Invalid team recovery draft");
      if (!liveRef.current() || current().editSeq !== editSeq || captureGeneration.current !== generation) return;
      const value = await workPlanCommands.prepareTeamRecovery(request, plan, observation);
      if (!liveRef.current() || current().editSeq !== editSeq || captureGeneration.current !== generation) return;
      if (value.preview.members.some(member => !connectionConfigCurrent(connections.current(), member.config))) return;
      const capture = { request: structuredClone(request), value, plan: structuredClone(plan), effects: [...effects], memberKeys: draft.members.map(member => member.key), unresolvedWork: structuredClone(observation.state.unresolvedWork), editSeq };
      update(value => ({ ...value, capture, consent: false }));
    } catch (error) { if (current().editSeq === editSeq) update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { update(value => ({ ...value, preparing: false })); }
  }
  function authorized(capture: Capture, receipt: TeamRecoveryReceipt) {
    if (!liveRef.current()) return;
    update(before => ({ ...before, pending: null, ready: { capture, receipt }, failure: null, consent: false,
      draft: before.draft?.planId === capture.plan.planId ? { ...before.draft, members: before.draft.members.map(member => {
        const index = capture.memberKeys.indexOf(member.key);
        return index < 0 ? member : { ...member, original: structuredClone(capture.value.preview.members[index]) };
      }) } : before.draft,
      notice: before.editSeq === capture.editSeq ? "authorized" : "newer", dirty: before.editSeq === capture.editSeq ? false : before.dirty,
      capture: before.editSeq === capture.editSeq ? null : before.capture })); changed();
  }
  function settled(capture: Capture, receipt: TeamRecoveryReceipt) {
    if (!liveRef.current()) return;
    update(before => ({ ...before, pending: null, ready: null, failure: null, draft: before.editSeq === capture.editSeq ? null : before.draft, notice: before.editSeq === capture.editSeq ? "started" : "newer" }));
    started(capture.plan, receipt, capture.value.preview.work.target.unitId); changed();
  }
  async function send(entry: Exclude<Pending, { kind: "close" }>, retryingUnknown = false) {
    let dispatched = false;
    update(before => ({ ...before, pending: { ...entry, phase: "sending", retryAllowed: false }, failure: null }));
    try {
      if (entry.kind === "authorize") authorized(entry.capture, await workPlanCommands.authorizeTeamRecovery(entry.request, entry.capture.value));
      else {
        await workPlanCommands.start(entry.request, entry.receipt.attemptId);
        dispatched = true;
        const result = await workPlanCommands.startAction(entry.request);
        if (!result || result.taskId !== entry.receipt.taskId || result.attemptId !== entry.receipt.attemptId) throw { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };
        settled(entry.capture, entry.receipt);
      }
    } catch (error) {
      update(before => ({ ...before, failure: commandFailure(error), pending: retryingUnknown || dispatched || hasUnknownOutcome(error)
        ? { ...entry, phase: "unknown", retryAllowed: false } : null }));
    }
  }
  async function authorize(permissions: Pick<WorkPlanTeamRecoveryAuthorizeRequest, "checkerExecutions" | "toolExecution" | "applicationToolExecutions">) {
    const before = current(), capture = before.capture;
    if (!liveRef.current() || blocked() || !available() || !capture || !before.consent || !connectionCurrent(capture)) return;
    update(value => ({ ...value, preparing: true, failure: null }));
    try {
      const actionId = await executionCommands.identity(context);
      if (!liveRef.current() || current().capture !== capture || current().editSeq !== capture.editSeq || !current().consent || !connectionCurrent(capture)) return;
      const request: WorkPlanTeamRecoveryAuthorizeRequest = { ...context, preparationId: capture.value.preparationId, planId: capture.value.preview.planId,
        recovery: { actionId, digest: capture.value.preview.digest, confirmed: true, effects: [...capture.effects] }, ...structuredClone(permissions) };
      await send({ kind: "authorize", request, capture });
    } catch (error) { update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { update(value => ({ ...value, preparing: false })); }
  }
  async function start() {
    const ready = current().ready;
    if (!liveRef.current() || current().pending || current().preparing || !ready || !available()) return;
    const receipt = ready.receipt;
    await send({ kind: "start", capture: ready.capture, receipt, request: { ...context, planId: receipt.effectiveVersion.lease.planId,
      actionId: receipt.actionId, expectedGeneration: receipt.effectiveVersion.lease.generation } });
  }
  async function check() {
    const pending = current().pending;
    if (!liveRef.current() || pending?.phase !== "unknown") return;
    update(before => ({ ...before, pending: { ...pending, phase: "checking", retryAllowed: false }, failure: null }));
    try {
      if (pending.kind !== "start") {
        const result = await workPlanCommands.teamRecoveryAction(pending.request, pending.capture.value);
        if (result) { authorized(pending.capture, result.receipt); return; }
      } else {
        const result = await workPlanCommands.startAction(pending.request);
        if (result) {
          if (result.attemptId !== pending.receipt.attemptId || result.taskId !== pending.receipt.taskId) throw { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };
          settled(pending.capture, pending.receipt); return;
        }
      }
      update(before => ({ ...before, pending: { ...pending, phase: "unknown", retryAllowed: true }, notice: pending.kind === "close" ? "closeAbsent" : "absent" }));
    } catch (error) { update(before => ({ ...before, pending: { ...pending, phase: "unknown", retryAllowed: false }, failure: commandFailure(error) })); }
  }
  function originalClosed(observation: WorkPlanTeamRecoveryStateView) {
    const action = current().pending ?? current().ready;
    if (!action) return false;
    const receipt = "receipt" in action ? action.receipt : null;
    return observation.state.planId === action.capture.value.preview.planId && (observation.runtime === null || !observation.runtime.originalDeadlineAvailable || BigInt(observation.state.expiresAtMs) <= BigInt(Date.now())
      || (receipt ? jsonIdentity(observation.state.lease) !== jsonIdentity(receipt.effectiveVersion.lease) || observation.state.state !== "active"
        : !sameBasis(observation, action.capture) || observation.state.state === "stopped"));
  }
  async function retry(observation?: WorkPlanTeamRecoveryStateView) {
    const pending = current().pending;
    if (!liveRef.current() || pending?.phase !== "unknown") return;
    if (pending.kind === "close") await close(pending);
    else if (pending.retryAllowed && observation && !originalClosed(observation)) await send(pending, true);
  }
  async function close(entry: Extract<Pending, { kind: "authorize" | "close" }>) {
    const pending = { ...entry, kind: "close" as const };
    update(before => ({ ...before, pending: { ...pending, phase: "sending", retryAllowed: false }, failure: null }));
    try {
      const result = await workPlanCommands.endTeamRecovery(pending.request, pending.capture.value);
      if (result.kind === "authorization-recorded") authorized(pending.capture, result.action.receipt);
      else update(before => ({ ...before, pending: null, capture: null, consent: false, failure: null, notice: "closed" }));
    } catch (error) {
      // A rejected or lost close cannot disprove the original unknown authorization.
      update(before => ({ ...before, pending: { ...pending, phase: "unknown", retryAllowed: false }, failure: commandFailure(error) }));
    }
  }
  async function end(observation?: WorkPlanTeamRecoveryStateView) {
    const before = current(), pending = before.pending;
    if (!liveRef.current()) return;
    if (pending?.kind === "authorize" && pending.phase === "unknown" && pending.retryAllowed) { await close(pending); return; }
    if (pending && (pending.kind !== "start" || pending.phase !== "unknown" || !pending.retryAllowed)
      || !observation || !originalClosed(observation)) return;
    update(value => ({ ...value, pending: null, ready: null, consent: false, notice: "ended" }));
  }
  function discard() {
    if (blocked()) return false;
    update(before => ({ ...initial(), editSeq: before.editSeq + 1 })); return true;
  }
  return { state, current, edit, editConfig, selectConnection, begin, prepare, authorize, start, check, retry, end, originalClosed, connectionCurrent, invalidateCapture,
    setConsent: (consent: boolean) => { if (!blocked() && current().capture && (!consent || connectionCurrent())) update(before => ({ ...before, consent })); },
    taskReferences: () => [...(current().draft?.priorWork ?? []), ...(current().pending?.capture.value.preview.work.priorWork ?? []), ...(current().ready?.capture.value.preview.work.priorWork ?? [])],
    blocked, hasDraft: () => current().dirty, pendingPlan: () => (current().pending?.capture ?? current().ready?.capture)?.value.preview.planId ?? null, discard };
}
export type TeamRecoverySession = ReturnType<typeof useTeamRecoverySession>;
