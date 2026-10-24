import { useRef, useState } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome, isCommandError } from "./projectCommands";
import { jsonIdentity } from "./pluginToolChoices";
import { workPlanCommands, type TeamExecutionView, type WorkPlanStatusView, type WorkPlanTeamMessageRequest } from "./workPlanCommands";

interface GuidanceDraft { memberId: string; unitId: string; body: string; editSeq: number; dirty: boolean }
interface PendingGuidance {
  request: WorkPlanTeamMessageRequest; editSeq: number; phase: "sending" | "unknown" | "checking"; retryAllowed: boolean;
  destination: { name: string; role: string; endpoint: string; model: string };
}
interface GuidanceState {
  draft: GuidanceDraft; pending: PendingGuidance | null; creating: boolean; failure: CommandFailure | null;
  notice: "recorded" | "newer" | "absent" | "closed" | null;
}
const initial = (): GuidanceState => ({ draft: { memberId: "", unitId: "", body: "", editSeq: 0, dirty: false }, pending: null, creating: false, failure: null, notice: null });
export function teamGuidanceActive(status: WorkPlanStatusView, view: TeamExecutionView): boolean {
  return !!status.plan.options.teamExecution && !!status.plan.options.teamDiscussions && status.state === "active"
    && status.effects.includes("send-team-message") && view.planId === status.plan.planId
    && (view.stopReason === null || view.stopReason === "activation-limit")
    && jsonIdentity(view.effectiveVersion.lease) === jsonIdentity(status.lease)
    && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now() / 1000));
}

/** A local typed workflow in the original AI owner; query facts stay in Query. */
export function useTeamGuidanceSession(live: () => boolean, context: SessionRequest, available: () => boolean, changed: () => void) {
  const [plans, setPlans] = useState<Record<string, GuidanceState>>({}), ref = useRef(plans), revision = useRef(0);
  const liveRef = useRef(live), availableRef = useRef(available); liveRef.current = live; availableRef.current = available;
  const current = (planId: string) => ref.current[planId] ?? initial();
  function update(planId: string, change: (before: GuidanceState) => GuidanceState) {
    if (!liveRef.current()) return;
    ref.current = { ...ref.current, [planId]: change(current(planId)) }; revision.current++; setPlans(ref.current);
  }
  function recorded(planId: string, entry: PendingGuidance) {
    if (current(planId).pending?.request !== entry.request) return;
    update(planId, before => ({ ...before, pending: null, failure: null, notice: before.draft.editSeq === entry.editSeq ? "recorded" : "newer",
      draft: before.draft.editSeq === entry.editSeq ? { ...before.draft, body: "", dirty: false } : before.draft }));
    if (liveRef.current()) changed();
  }
  async function dispatch(planId: string, entry: PendingGuidance, retryingUnknown = false) {
    update(planId, before => ({ ...before, pending: { ...entry, phase: "sending", retryAllowed: false }, failure: null, notice: null }));
    try { await workPlanCommands.sendTeamMessage(entry.request); if (liveRef.current()) recorded(planId, entry); }
    catch (error) {
      if (current(planId).pending?.request !== entry.request) return;
      const closed = retryingUnknown && isCommandError(error) && error.code === "cancelled" && error.stage === "execution-recover"
        && error.outcome === "rejected" && error.reason === "team-human-message-lease-closed";
      update(planId, before => ({ ...before, failure: closed ? null : commandFailure(error), notice: closed ? "closed" : null,
        pending: !closed && (retryingUnknown || hasUnknownOutcome(error)) ? { ...entry, phase: "unknown", retryAllowed: false } : null }));
    }
  }
  async function send(status: WorkPlanStatusView, view: TeamExecutionView, writable: boolean, expectedEditSeq: number) {
    const planId = status.plan.planId, before = current(planId), draft = structuredClone(before.draft);
    const member = view.roster.find(value => value.memberId === draft.memberId);
    const target = status.plan.scope.find(unit => unit.unitId === draft.unitId && member?.unitIds.includes(unit.unitId));
    if (!liveRef.current() || !availableRef.current() || blocked() || !writable || !teamGuidanceActive(status, view)
      || draft.editSeq !== expectedEditSeq || !member || !target || !draft.body.trim()
      || new TextEncoder().encode(draft.body).length > view.messageLimits.maxBodyBytes) return;
    const lease = structuredClone(status.lease);
    update(planId, value => ({ ...value, creating: true, failure: null, notice: null }));
    try {
      const messageId = await executionCommands.identity(context);
      if (!liveRef.current()) return;
      if (!availableRef.current() || !teamGuidanceActive(status, view)) {
        update(planId, value => ({ ...value, creating: false })); return;
      }
      const request: WorkPlanTeamMessageRequest = { ...context, lease, message: { messageId, recipientMemberId: member.memberId,
        expectedRecipientRoleVersionId: member.roleVersionId, body: draft.body,
        target: { unitId: target.unitId, locale: status.plan.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId } } };
      const entry: PendingGuidance = { request, editSeq: draft.editSeq, phase: "sending", retryAllowed: false,
        destination: { name: member.displayName, role: member.role, endpoint: member.config.endpoint, model: member.config.model } };
      update(planId, value => ({ ...value, creating: false, pending: entry }));
      await dispatch(planId, entry);
    } catch (error) { update(planId, value => ({ ...value, creating: false, failure: commandFailure(error) })); }
  }
  async function check(planId: string) {
    const entry = current(planId).pending;
    if (!liveRef.current() || entry?.phase !== "unknown") return;
    update(planId, before => ({ ...before, failure: null, notice: null, pending: { ...entry, phase: "checking", retryAllowed: false } }));
    try {
      const value = await workPlanCommands.teamMessageAction(entry.request);
      if (!liveRef.current() || current(planId).pending?.request !== entry.request) return;
      if (value) recorded(planId, entry);
      else update(planId, before => ({ ...before, notice: "absent", pending: { ...entry, phase: "unknown", retryAllowed: true } }));
    } catch (error) {
      if (current(planId).pending?.request === entry.request) update(planId, before => ({ ...before, failure: commandFailure(error), pending: { ...entry, phase: "unknown", retryAllowed: false } }));
    }
  }
  function retryAllowed(planId: string): boolean {
    const pending = current(planId).pending;
    return !!pending && pending.phase === "unknown" && pending.retryAllowed && availableRef.current()
      && !Object.entries(ref.current).some(([id, value]) => id !== planId && (value.creating || !!value.pending));
  }
  const blocked = () => Object.values(ref.current).some(value => value.creating || !!value.pending);
  return { current, send, check, retryAllowed, blocked, canMutate: () => availableRef.current() && !blocked(),
    async retry(planId: string) {
      const pending = current(planId).pending;
      if (liveRef.current() && pending && retryAllowed(planId)) await dispatch(planId, pending, true);
    },
    edit(planId: string, change: Partial<Omit<GuidanceDraft, "editSeq" | "dirty">>) {
      update(planId, before => ({ ...before, notice: null, draft: { ...before.draft, ...change, dirty: true, editSeq: before.draft.editSeq + 1 } }));
    },
    hasDraft: () => Object.values(ref.current).some(value => value.draft.dirty), revision: () => revision.current,
    firstBlockedPlan: () => Object.entries(ref.current).find(([, value]) => value.creating || value.pending)?.[0] ?? null,
    discard() {
      if (!liveRef.current() || blocked()) return false;
      ref.current = {}; revision.current++; setPlans(ref.current); return true;
    },
  };
}
export type TeamGuidanceSession = ReturnType<typeof useTeamGuidanceSession>;
