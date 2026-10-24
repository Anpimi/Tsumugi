import { useSessionAlive } from "./SessionReadProvider";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { reviewCommands, type CheckRun, type FallbackDecision, type FallbackWrite, type ReviewDecision,
  type ReviewSummary, type ReviewTarget, type ReviewWrite, type Waiver, type WaiverWrite } from "./reviewCommands";

type CheckRequest = { unitId: string; locale: string; expectedBasis: string; actionId: string };
type ReviewAction =
  | { kind: "decision"; request: ReviewWrite; submittedSeq: number }
  | { kind: "check"; request: CheckRequest; submittedSeq: null; expectedCheckId: string | null }
  | { kind: "waiver"; request: WaiverWrite; submittedSeq: number }
  | { kind: "fallback"; request: FallbackWrite; submittedSeq: number };
export type ReviewPending = ReviewAction & { session: SessionRequest };
export type ReviewNotice = "saved" | "unknown" | "conflict" | "error" | "checkFailed" | "checkCancelled" | "cancelRequested" | null;
export interface ReviewBatchStatus { applied: number; conflicted: number; failed: number; notStarted: number }

export interface ReviewDraftState {
  locale: string;
  actor: string;
  drafts: Record<string, string>;
  editSeq: Record<string, number>;
  /** Each nonempty reason remains attached to the evidence seen when it was first written. */
  draftTargets: Record<string, ReviewTarget>;
  /** Captured review evidence for a draft, not a second source of Core truth. */
  selected: ReviewTarget | null;
  /** Explicitly captured evidence and checked business receipts; current reads belong to Query. */
  projection: ReviewTarget | null;
  chosen: Record<string, ReviewSummary>;
  pending: ReviewPending | null;
  pendingCheckedMissing: boolean;
  checkingAction: boolean;
  notice: ReviewNotice;
  reasonValue: CommandFailure;
  busyMutation: boolean;
  activeCheckId: string | null;
  batchRunning: boolean;
  batchStatus: ReviewBatchStatus | null;
  completionVersion: number;
}

interface ReviewSession {
  state: ReviewDraftState;
  current: () => ReviewDraftState;
  inFlight: () => boolean;
  setLocale: (value: string) => void;
  setActor: (value: string) => void;
  setSelected: (target: ReviewTarget | null) => void;
  observeProjection: (target: ReviewTarget, capture: { unitId: string; locale: string; basis: string; editSeq: number }) => void;
  editReason: (target: ReviewTarget, value: string) => void;
  adoptCurrent: () => boolean;
  toggleChosen: (target: ReviewSummary, checked: boolean) => void;
  clear: () => void;
  setNotice: (notice: ReviewNotice) => void;
  setReason: (reason: CommandFailure) => void;
  decide: (kind: ReviewWrite["kind"], currentRead: () => boolean) => Promise<void>;
  check: (currentRead: () => boolean) => Promise<void>;
  waive: (issueId: string, grant: boolean, expectedWaiverId: string | null, currentRead: () => boolean) => Promise<void>;
  fallback: (allow: boolean, currentRead: () => boolean) => Promise<void>;
  checkPending: () => Promise<void>;
  retryPending: () => Promise<void>;
  cancelCheck: () => Promise<void>;
  approveBatch: () => Promise<void>;
  stopBatch: () => void;
}

const ReviewContext = createContext<ReviewSession | null>(null);
export function useReviewDraftSession() {
  const owner = useContext(ReviewContext);
  if (!owner) throw new Error("Review drafts require a project session owner");
  return owner;
}

export function reviewDraftKey(target: Pick<ReviewTarget, "locale" | "unitId">) { return `${target.locale}:${target.unitId}`; }
function isConflict(error: unknown) { return (error as { code?: string } | null)?.code === "dependency-conflict"; }

export function ReviewDraftSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const [state, setState] = useState<ReviewDraftState>(() => ({
    locale: project.metadata.targetLocales[0] ?? "", actor: "", drafts: {}, editSeq: {}, draftTargets: {}, selected: null, projection: null, chosen: {},
    pending: null, pendingCheckedMissing: false, checkingAction: false, notice: null, reasonValue: "", busyMutation: false, activeCheckId: null,
    batchRunning: false, batchStatus: null, completionVersion: 0,
  }));
  const currentState = useRef(state);
  const projectRef = useRef(project);
  const mounted = useSessionAlive();
  const running = useRef(false);
  const cancelBatch = useRef(false);
  const targetScope = project.metadata.targetLocales.join("\u0000");
  useLayoutEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function update(change: (before: ReviewDraftState) => ReviewDraftState) {
    const before = currentState.current;
    if (!mounted.current) return before;
    const after = change(before);
    currentState.current = after;
    if (after !== before) setState(after);
    return after;
  }
  function current() { return currentState.current; }
  function localeAvailable(locale: string) { return locale !== "" && projectRef.current.metadata.targetLocales.includes(locale); }
  function setLocale(value: string) { update(before => ({ ...before, locale: value, selected: null, projection: null })); }
  function setActor(value: string) { update(before => ({ ...before, actor: value })); }
  function setSelected(target: ReviewTarget | null) {
    update(before => ({ ...before, selected: target ? before.draftTargets[reviewDraftKey(target)] ?? target : null,
      projection: target }));
  }
  function observeProjection(target: ReviewTarget, capture: { unitId: string; locale: string; basis: string; editSeq: number }) {
    update(before => {
      const selected = before.selected;
      if (!selected || selected.unitId !== capture.unitId || selected.locale !== capture.locale
        || selected.basis !== capture.basis || target.unitId !== capture.unitId || target.locale !== capture.locale) return before;
      const key = reviewDraftKey(selected);
      const cleanAtResponse = (before.editSeq[key] ?? 0) === capture.editSeq && !before.draftTargets[key]
        && !(before.drafts[key] ?? "")
        && !before.pending && !before.chosen[key];
      return { ...before, projection: target, selected: cleanAtResponse ? target : selected };
    });
  }
  function editReason(target: ReviewTarget, value: string) {
    const key = reviewDraftKey(target);
    update(before => {
      const draftTargets = { ...before.draftTargets };
      if (value) draftTargets[key] ??= target;
      else delete draftTargets[key];
      return { ...before, drafts: { ...before.drafts, [key]: value }, draftTargets,
        editSeq: { ...before.editSeq, [key]: (before.editSeq[key] ?? 0) + 1 } };
    });
  }
  function adoptCurrent() {
    const before = current(), selected = before.selected, projection = before.projection;
    if (running.current || before.pending || !selected || !projection || !localeAvailable(selected.locale)
      || selected.unitId !== projection.unitId || selected.locale !== projection.locale) return false;
    const key = reviewDraftKey(selected);
    update(value => ({ ...value, selected: projection,
      draftTargets: value.drafts[key] ? { ...value.draftTargets, [key]: projection } : value.draftTargets,
      editSeq: { ...value.editSeq, [key]: (value.editSeq[key] ?? 0) + 1 } }));
    return true;
  }
  function toggleChosen(target: ReviewSummary, checked: boolean) {
    update(before => {
      const chosen = { ...before.chosen };
      if (checked) chosen[reviewDraftKey(target)] = target;
      else delete chosen[reviewDraftKey(target)];
      return { ...before, chosen };
    });
  }
  function clear() {
    if (running.current || current().pending) return;
    update(before => ({ ...before, drafts: {}, editSeq: {}, draftTargets: {}, chosen: {}, selected: null, projection: null, notice: null, reasonValue: "" }));
  }
  function setNotice(notice: ReviewNotice) { update(before => ({ ...before, notice })); }
  function setReason(reasonValue: CommandFailure) { update(before => ({ ...before, reasonValue })); }
  function fail(error: unknown) {
    update(before => ({ ...before, notice: "error", reasonValue: commandFailure(error) }));
  }
  function reasonAfterReceipt(before: ReviewDraftState, action: ReviewPending) {
    if (action.kind === "check") return { drafts: before.drafts, editSeq: before.editSeq, draftTargets: before.draftTargets };
    const key = reviewDraftKey(action.request);
    if (before.editSeq[key] !== action.submittedSeq || before.drafts[key] !== action.request.reason) {
      return { drafts: before.drafts, editSeq: before.editSeq, draftTargets: before.draftTargets };
    }
    const draftTargets = { ...before.draftTargets };
    delete draftTargets[key];
    return { drafts: { ...before.drafts, [key]: "" }, editSeq: { ...before.editSeq, [key]: action.submittedSeq + 1 }, draftTargets };
  }
  function matchingSelected(before: ReviewDraftState, action: ReviewPending) {
    return !!before.selected && before.selected.unitId === action.request.unitId
      && before.selected.locale === action.request.locale && before.selected.basis === action.request.expectedBasis;
  }
  function confirmed(action: ReviewPending, receipt: ReviewDecision | CheckRun | Waiver | FallbackDecision) {
    update(before => {
      if (before.pending !== action) return before;
      function withReceipt(target: ReviewTarget): ReviewTarget {
        if (action.kind === "decision") return target.currentDecision && target.currentDecision.decisionId !== action.request.expectedDecisionId
          && target.currentDecision.decisionId !== (receipt as ReviewDecision).decisionId ? target : { ...target, currentDecision: receipt as ReviewDecision };
        if (action.kind === "check") return target.currentCheck && target.currentCheck.runId !== action.expectedCheckId
          && target.currentCheck.runId !== (receipt as CheckRun).runId ? target : { ...target, currentCheck: receipt as CheckRun };
        if (action.kind === "waiver") {
          const waiver = receipt as Waiver;
          if (target.currentWaivers.some(value => value.issueId === waiver.issueId
            && value.waiverId !== action.request.expectedWaiverId && value.waiverId !== waiver.waiverId)) return target;
          return { ...target, currentWaivers: action.request.grant
            ? [...target.currentWaivers.filter(value => value.issueId !== waiver.issueId), waiver]
            : target.currentWaivers.filter(value => value.waiverId !== action.request.expectedWaiverId) };
        }
        if (action.kind === "fallback" && target.currentFallback && target.currentFallback.fallbackId !== action.request.expectedFallbackId
          && target.currentFallback.fallbackId !== (receipt as FallbackDecision).fallbackId) return target;
        return { ...target, currentFallback: action.request.allow ? receipt as FallbackDecision : null };
      }
      const selected = matchingSelected(before, action) && before.selected ? withReceipt(before.selected) : before.selected;
      const projection = before.projection?.unitId === action.request.unitId && before.projection.locale === action.request.locale
        && before.projection.basis === action.request.expectedBasis ? withReceipt(before.projection) : before.projection;
      const key = reviewDraftKey(action.request);
      const captured = before.draftTargets[key];
      const draftTargets = captured?.basis === action.request.expectedBasis
        ? { ...before.draftTargets, [key]: withReceipt(captured) } : before.draftTargets;
      let chosen = before.chosen;
      if (action.kind === "decision") {
        const key = reviewDraftKey(action.request);
        if (chosen[key]?.basis === action.request.expectedBasis) { chosen = { ...chosen }; delete chosen[key]; }
      }
      const nextReason = reasonAfterReceipt({ ...before, draftTargets }, action);
      const checkOutcome = action.kind === "check" ? (receipt as CheckRun).outcome : null;
      return { ...before, ...nextReason, selected, projection, chosen, pending: null, pendingCheckedMissing: false, checkingAction: false,
        notice: checkOutcome === "failed" ? "checkFailed" : checkOutcome === "cancelled" ? "checkCancelled" : "saved",
        reasonValue: "", completionVersion: before.completionVersion + 1 };
    });
  }
  async function lookupPending(action: ReviewPending) {
    if (!mounted.current || current().pending !== action) return;
    update(before => ({ ...before, checkingAction: true, pendingCheckedMissing: false, notice: null, reasonValue: "" }));
    try {
      const receipt = action.kind === "decision" ? await reviewCommands.decisionAction(action.session, action.request)
        : action.kind === "waiver" ? await reviewCommands.waiverAction(action.session, action.request)
        : action.kind === "fallback" ? await reviewCommands.fallbackAction(action.session, action.request)
        : await reviewCommands.checkAction({ ...action.session, ...action.request });
      if (!mounted.current || current().pending !== action) return;
      if (receipt === null) update(before => ({ ...before, pendingCheckedMissing: true, notice: "unknown" }));
      else confirmed(action, receipt);
    } finally { update(before => before.pending === action ? { ...before, checkingAction: false } : before); }
  }
  async function checkPending() {
    const action = current().pending, previousFailure = current().reasonValue;
    if (!mounted.current || !action || running.current) return;
    running.current = true; update(before => ({ ...before, busyMutation: true }));
    try { await lookupPending(action); if (current().pending === action) update(before => ({ ...before, notice: "unknown", reasonValue: previousFailure })); }
    catch (error) { if (current().pending === action) update(before => ({ ...before, notice: "unknown", reasonValue: commandFailure(error) })); }
    finally { running.current = false; update(before => ({ ...before, busyMutation: false })); }
  }
  async function dispatch(action: ReviewPending, recovering = false) {
    if (!mounted.current) return;
    update(before => ({ ...before, pending: action, pendingCheckedMissing: false, notice: null,
      activeCheckId: action.kind === "check" ? action.request.actionId : null }));
    let writeFailure: CommandFailure = "";
    try {
      const session = action.session;
      if (action.kind === "decision") confirmed(action, await reviewCommands.decide(session, action.request));
      if (action.kind === "check") confirmed(action, await reviewCommands.check({ ...session, ...action.request }));
      if (action.kind === "waiver") confirmed(action, await reviewCommands.waive(session, action.request));
      if (action.kind === "fallback") confirmed(action, await reviewCommands.fallback(session, action.request));
      return;
    } catch (error) {
      const unknown = hasUnknownOutcome(error); writeFailure = commandFailure(error);
      update(before => before.pending !== action ? before : { ...before,
        pending: unknown || recovering ? action : null,
        notice: unknown || recovering ? "unknown" : isConflict(error) ? "conflict" : "error",
        reasonValue: writeFailure });
      if (!unknown) return;
    } finally { update(before => ({ ...before, activeCheckId: null })); }
    try { await lookupPending(action); if (current().pending === action) update(before => ({ ...before, reasonValue: writeFailure, notice: "unknown" })); }
    catch (error) { if (current().pending === action) update(before => ({ ...before, reasonValue: commandFailure(error), notice: "unknown" })); }
  }
  async function fresh(target: ReviewTarget, currentRead: () => boolean,
    makeAction: (actionId: string, before: ReviewDraftState) => ReviewAction) {
    const before = current();
    if (!mounted.current || running.current || before.pending || !localeAvailable(target.locale) || !currentRead()
      || (before.projection?.unitId === target.unitId && before.projection.locale === target.locale
        && before.projection.basis !== target.basis)) return;
    running.current = true;
    update(value => ({ ...value, busyMutation: true, notice: null, reasonValue: "" }));
    try {
      const session = executionContext(projectRef.current);
      const actionId = await executionCommands.identity(session);
      const latest = current();
      if (!mounted.current || latest.pending || !localeAvailable(target.locale) || !currentRead()
        || latest.selected?.unitId !== target.unitId || latest.selected.locale !== target.locale
        || latest.selected.basis !== target.basis
        || (latest.projection?.unitId === target.unitId && latest.projection.locale === target.locale
          && latest.projection.basis !== target.basis)) return;
      await dispatch({ ...makeAction(actionId, before), session });
    } catch (error) { fail(error); }
    finally {
      running.current = false;
      update(value => ({ ...value, busyMutation: false, activeCheckId: null }));
    }
  }
  async function decide(kind: ReviewWrite["kind"], currentRead: () => boolean) {
    const before = current();
    const target = before.selected;
    if (!target || !before.actor.trim()) { update(value => ({ ...value, notice: "error", reasonValue: "reviewer-required" })); return; }
    const key = reviewDraftKey(target), reason = before.drafts[key] ?? "";
    if (kind === "request-changes" && !reason.trim()) { update(value => ({ ...value, notice: "error", reasonValue: "reason-required" })); return; }
    await fresh(target, currentRead, actionId => ({ kind: "decision", submittedSeq: before.editSeq[key] ?? 0,
      request: { projectId: projectRef.current.metadata.projectId, actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, expectedDecisionId: target.currentDecision?.decisionId ?? null,
        actor: before.actor.trim(), kind, reason } }));
  }
  async function check(currentRead: () => boolean) {
    const target = current().selected;
    if (!target) return;
    await fresh(target, currentRead, actionId => ({ kind: "check", submittedSeq: null, expectedCheckId: target.currentCheck?.runId ?? null,
      request: { actionId, unitId: target.unitId, locale: target.locale, expectedBasis: target.basis } }));
  }
  async function waive(issueId: string, grant: boolean, expectedWaiverId: string | null, currentRead: () => boolean) {
    const before = current(), target = before.selected;
    if (!target || !before.actor.trim() || !(before.drafts[reviewDraftKey(target)] ?? "").trim()) {
      update(value => ({ ...value, notice: "error", reasonValue: "reason-required" })); return;
    }
    const key = reviewDraftKey(target), reason = before.drafts[key];
    await fresh(target, currentRead, actionId => ({ kind: "waiver", submittedSeq: before.editSeq[key] ?? 0,
      request: { projectId: projectRef.current.metadata.projectId, actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, issueId, grant, expectedWaiverId, actor: before.actor.trim(), reason } }));
  }
  async function fallback(allow: boolean, currentRead: () => boolean) {
    const before = current(), target = before.selected;
    if (!target || !before.actor.trim() || !(before.drafts[reviewDraftKey(target)] ?? "").trim()) {
      update(value => ({ ...value, notice: "error", reasonValue: "reason-required" })); return;
    }
    const key = reviewDraftKey(target), reason = before.drafts[key];
    await fresh(target, currentRead, actionId => ({ kind: "fallback", submittedSeq: before.editSeq[key] ?? 0,
      request: { projectId: projectRef.current.metadata.projectId, actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, allow, expectedFallbackId: target.currentFallback?.fallbackId ?? null,
        actor: before.actor.trim(), reason } }));
  }
  async function retryPending() {
    const action = current().pending;
    if (!mounted.current || !action || running.current || !current().pendingCheckedMissing) return;
    running.current = true;
    update(before => ({ ...before, busyMutation: true, notice: null }));
    try { if (current().pending === action) await dispatch(action, true); }
    finally { running.current = false; update(before => ({ ...before, busyMutation: false, activeCheckId: null })); }
  }
  async function cancelCheck() {
    const actionId = current().activeCheckId;
    if (!mounted.current || !actionId) return;
    try {
      if (await reviewCommands.cancelCheck({ ...executionContext(projectRef.current), actionId })) setNotice("cancelRequested");
    } catch (error) { fail(error); }
  }
  async function approveBatch() {
    const before = current();
    const frozen = Object.values(before.chosen), batchActor = before.actor.trim();
    if (!mounted.current || running.current || before.pending || !batchActor || frozen.length === 0) return;
    running.current = true; cancelBatch.current = false;
    update(value => ({ ...value, busyMutation: true, batchRunning: true, batchStatus: null, notice: null }));
    const result = { applied: 0, conflicted: 0, failed: 0 };
    let processed = 0;
    for (const target of frozen) {
      if (cancelBatch.current || !mounted.current || current().pending || !localeAvailable(target.locale)) break;
      let action: ReviewPending | null = null;
      try {
        const session = executionContext(projectRef.current);
        const actionId = await executionCommands.identity(session);
        if (cancelBatch.current || !mounted.current || current().pending || !localeAvailable(target.locale)) break;
        const request: ReviewWrite = { projectId: session.projectId, actionId,
          unitId: target.unitId, locale: target.locale, expectedBasis: target.basis,
          expectedDecisionId: target.currentDecision?.decisionId ?? null, actor: batchActor, kind: "approve", reason: "" };
        action = { kind: "decision", request, submittedSeq: -1, session };
        const receipt = await reviewCommands.decide(session, request);
        update(value => {
          const chosen = { ...value.chosen };
          if (chosen[reviewDraftKey(target)]?.basis === request.expectedBasis) delete chosen[reviewDraftKey(target)];
          const selected = value.selected?.unitId === target.unitId && value.selected.locale === target.locale
            && value.selected.basis === request.expectedBasis ? { ...value.selected, currentDecision: receipt } : value.selected;
          const projection = value.projection?.unitId === target.unitId && value.projection.locale === target.locale
            && value.projection.basis === request.expectedBasis ? { ...value.projection, currentDecision: receipt } : value.projection;
          const key = reviewDraftKey(target);
          const captured = value.draftTargets[key];
          const draftTargets = captured?.basis === request.expectedBasis
            ? { ...value.draftTargets, [key]: { ...captured, currentDecision: receipt } } : value.draftTargets;
          return { ...value, chosen, selected, projection, draftTargets };
        });
        result.applied++;
      } catch (error) {
        if (hasUnknownOutcome(error)) {
          if (action) {
            const original = action;
            update(value => ({ ...value, pending: original, pendingCheckedMissing: false, notice: "unknown", reasonValue: commandFailure(error) }));
            try { await lookupPending(original); }
            catch (readError) { update(value => ({ ...value, notice: "unknown", reasonValue: commandFailure(readError) })); }
            if (current().pending === original) { result.failed++; update(value => ({ ...value, notice: "unknown", reasonValue: value.reasonValue || commandFailure(error) })); }
            else result.applied++;
          } else result.failed++;
          processed++; break;
        }
        if (isConflict(error)) result.conflicted++; else result.failed++;
      }
      processed++;
    }
    running.current = false;
    update(value => ({ ...value, busyMutation: false, batchRunning: false,
      batchStatus: { ...result, notStarted: frozen.length - processed },
      completionVersion: value.completionVersion + (result.applied > 0 ? 1 : 0) }));
  }
  function stopBatch() { cancelBatch.current = true; }

  useEffect(() => {
    const before = current();
    if (localeAvailable(before.locale) || before.pending || before.busyMutation
      || Object.keys(before.chosen).length > 0 || Object.values(before.drafts).some(value => value.length > 0)) return;
    const next = project.metadata.targetLocales[0] ?? "";
    if (next !== before.locale) update(value => ({ ...value, locale: next, selected: null, projection: null }));
  }, [targetScope, state.locale, state.pending, state.busyMutation, state.chosen, state.drafts]);

  const owner: ReviewSession = { state, current, inFlight: () => running.current,
    setLocale, setActor, setSelected, observeProjection, editReason, adoptCurrent, toggleChosen, clear, setNotice, setReason,
    decide, check, waive, fallback, checkPending, retryPending, cancelCheck, approveBatch, stopBatch };
  return <ReviewContext.Provider value={owner}>{children}</ReviewContext.Provider>;
}
