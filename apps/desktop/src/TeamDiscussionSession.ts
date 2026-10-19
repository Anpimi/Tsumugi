import { useRef, useState } from "react";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome } from "./projectCommands";
import { jsonIdentity } from "./pluginToolChoices";
import { workPlanCommands, type WorkPlanStatusView, type WorkPlanTeamPublishRequest } from "./workPlanCommands";

export interface TeamDiscussionDraft { unitId: string; body: string; replyTo: string | null; editSeq: number; dirty: boolean }
interface PendingPublication {
  request: WorkPlanTeamPublishRequest;
  editSeq: number;
  phase: "publishing" | "unknown" | "checking";
  retryAllowed: boolean;
}
interface PlanDiscussionState {
  draft: TeamDiscussionDraft;
  pending: PendingPublication | null;
  creating: boolean;
  after: string | null;
  focusedPost: string | null;
  lastPostId: string | null;
  failure: CommandFailure | null;
  notice: "recorded" | "absent" | "ended" | null;
}
const initial = (): PlanDiscussionState => ({ draft: { unitId: "", body: "", replyTo: null, editSeq: 0, dirty: false }, pending: null,
  creating: false, after: null, focusedPost: null, lastPostId: null, failure: null, notice: null });

export function teamPublicationActive(status: WorkPlanStatusView): boolean {
  return !!status.plan.options.teamDiscussions && !!status.plan.teamDiscussionLimits
    && status.state === "active" && status.effects.includes("publish-discussion")
    && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now() / 1000));
}
export function originalTeamPublicationClosed(status: WorkPlanStatusView, request: WorkPlanTeamPublishRequest): boolean {
  return status.plan.planId === request.lease.planId && (jsonIdentity(status.lease) !== jsonIdentity(request.lease)
    || status.state !== "active" || BigInt(status.expiresAt) <= BigInt(Math.floor(Date.now() / 1000)));
}

/** Part of the existing preparation workflow, retained across pane and plan switches. */
export function useTeamDiscussionSession(live: () => boolean, context: SessionRequest, changed: () => void) {
  const [plans, setPlans] = useState<Record<string, PlanDiscussionState>>({}), ref = useRef(plans), liveRef = useRef(live);
  const revision = useRef(0);
  liveRef.current = live;
  const current = (planId: string) => ref.current[planId] ?? initial();
  function update(planId: string, change: (before: PlanDiscussionState) => PlanDiscussionState) {
    if (!liveRef.current()) return;
    ref.current = { ...ref.current, [planId]: change(current(planId)) }; revision.current++; setPlans(ref.current);
  }
  function recorded(planId: string, postId: string, editSeq: number) {
    update(planId, before => ({ ...before, pending: null, creating: false, failure: null, notice: "recorded", lastPostId: postId,
      draft: before.draft.editSeq === editSeq ? { ...before.draft, body: "", replyTo: null, dirty: false } : before.draft }));
    if (liveRef.current()) changed();
  }
  async function send(planId: string, request: WorkPlanTeamPublishRequest, editSeq: number) {
    try {
      const post = await workPlanCommands.publishTeam(request);
      if (liveRef.current()) recorded(planId, post.publication.postId, editSeq);
    } catch (error) {
      update(planId, before => ({ ...before, creating: false, failure: commandFailure(error), notice: null,
        pending: hasUnknownOutcome(error) ? { request, editSeq, phase: "unknown", retryAllowed: false } : null }));
    }
  }
  async function publish(status: WorkPlanStatusView, writable: boolean, expectedEditSeq: number) {
    const planId = status.plan.planId, before = current(planId), draft = structuredClone(before.draft);
    const basis = status.plan.scope.find(unit => unit.unitId === (draft.unitId || status.plan.scope[0]?.unitId));
    if (!liveRef.current() || !writable || !teamPublicationActive(status) || before.pending || before.creating
      || draft.editSeq !== expectedEditSeq || !basis || !draft.body.trim()
      || new TextEncoder().encode(draft.body).length > status.plan.teamDiscussionLimits!.maxPostBytes) return;
    const lease = structuredClone(status.lease);
    update(planId, value => ({ ...value, creating: true, failure: null, notice: null }));
    try {
      const postId = await executionCommands.identity(context);
      if (!liveRef.current()) return;
      const request: WorkPlanTeamPublishRequest = { ...context, lease, publication: { postId,
        target: { unitId: basis.unitId, locale: status.plan.locale, sourceSnapshotId: basis.sourceSnapshotId, sourceRevisionId: basis.sourceRevisionId },
        kind: "note", body: draft.body, references: [], replyTo: draft.replyTo, supersedes: null } };
      update(planId, value => ({ ...value, creating: false, pending: { request, editSeq: draft.editSeq, phase: "publishing", retryAllowed: false } }));
      await send(planId, request, draft.editSeq);
    } catch (error) { update(planId, value => ({ ...value, creating: false, failure: commandFailure(error) })); }
  }
  async function check(planId: string) {
    const pending = current(planId).pending;
    if (!liveRef.current() || pending?.phase !== "unknown") return;
    update(planId, value => ({ ...value, failure: null, notice: null, pending: { ...pending, phase: "checking", retryAllowed: false } }));
    try {
      const post = await workPlanCommands.teamPublicationAction(pending.request);
      if (post) recorded(planId, post.publication.postId, pending.editSeq);
      else update(planId, value => ({ ...value, notice: "absent", pending: { ...pending, phase: "unknown", retryAllowed: true } }));
    } catch (error) {
      update(planId, value => ({ ...value, failure: commandFailure(error), pending: { ...pending, phase: "unknown", retryAllowed: false } }));
    }
  }
  async function retry(status: WorkPlanStatusView, writable: boolean) {
    const planId = status.plan.planId, pending = current(planId).pending;
    if (!liveRef.current() || !writable || !teamPublicationActive(status) || pending?.phase !== "unknown" || !pending.retryAllowed
      || jsonIdentity(pending.request.lease) !== jsonIdentity(status.lease)) return;
    update(planId, value => ({ ...value, failure: null, notice: null, pending: { ...pending, phase: "publishing", retryAllowed: false } }));
    await send(planId, pending.request, pending.editSeq);
  }
  const blocked = () => Object.values(ref.current).some(value => value.creating || !!value.pending);
  return { current, publish, check, retry, blocked,
    hasDraft: () => Object.values(ref.current).some(value => value.draft.dirty),
    revision: () => revision.current,
    firstBlockedPlan: () => Object.entries(ref.current).find(([, value]) => value.creating || value.pending)?.[0] ?? null,
    discard() {
      if (!liveRef.current() || blocked()) return false;
      ref.current = {}; revision.current++; setPlans(ref.current); return true;
    },
    endRetry(status: WorkPlanStatusView) {
      const planId = status.plan.planId, pending = current(planId).pending;
      if (pending?.phase !== "unknown" || !pending.retryAllowed || !originalTeamPublicationClosed(status, pending.request)) return;
      update(planId, value => ({ ...value, pending: null, failure: null, notice: "ended" }));
    },
    edit(planId: string, change: Partial<Omit<TeamDiscussionDraft, "editSeq" | "dirty">>) {
      update(planId, value => ({ ...value, draft: { ...value.draft, ...change, dirty: true, editSeq: value.draft.editSeq + 1 }, notice: null,
        failure: value.pending ? value.failure : null }));
    },
    page(planId: string, after: string | null) { update(planId, value => ({ ...value, after, focusedPost: null })); },
    focusPost(planId: string, focusedPost: string | null) { update(planId, value => ({ ...value, focusedPost })); },
  };
}
export type TeamDiscussionSession = ReturnType<typeof useTeamDiscussionSession>;
