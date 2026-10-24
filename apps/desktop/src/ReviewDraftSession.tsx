import { useSessionAlive, useSessionReads } from "./SessionReadProvider";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome, isCommandError, type ProjectView } from "./projectCommands";
import { confirmReviewFindingEvidence, confirmReviewFindingBasis, confirmReviewFinding, reviewCommands, type ReviewFindingWrite, type ReviewFindingDecision, type ReviewBasis, type AdvisoryFinding, type CheckRun, type FallbackDecision, type FallbackWrite, type ReviewDecision,
  type ReviewSummary, type ReviewTarget, type ReviewWrite, type Waiver, type WaiverWrite } from "./reviewCommands";

import type { ReviewCheckRequest, ReviewCheckStartRequest, ReviewPluginCheckView } from "./reviewCommands";
import type { PluginTextReviewSelection } from "./pluginCommands";
import { useAiSemanticReviewSession } from "./AiSemanticReviewSession";
type ReviewCheckPreparation = { request: ReviewCheckRequest; view: ReviewPluginCheckView };
export type ReviewHumanPending = (
  | { kind: "finding"; request: ReviewFindingWrite; basisEvidence: ReviewBasis; evidence: Pick<AdvisoryFinding, "requirement" | "finding" | "runId" | "purpose" | "aiOrigin">; submittedSeq: number }
  | { kind: "decision"; request: ReviewWrite; submittedSeq: number }
  | { kind: "waiver"; request: WaiverWrite; submittedSeq: number }
  | { kind: "fallback"; request: FallbackWrite; submittedSeq: number }) & { session: SessionRequest };
type ReviewCheckPending = (
  | { kind: "prepare-check"; request: ReviewCheckRequest; submittedSeq: null }
  | { kind: "check"; request: ReviewCheckRequest; executions: ReviewCheckStartRequest["executions"]; submittedSeq: null }
) & { previousRunId: string | null; basisEvidence: ReviewBasis };
export type ReviewPending = ReviewHumanPending | ReviewCheckPending;
export function isHumanReviewPending(action: ReviewPending): action is ReviewHumanPending {
  return action.kind !== "check" && action.kind !== "prepare-check";
}
type HumanReceipt = ReviewDecision | Waiver | FallbackDecision | ReviewFindingDecision;
type HumanOutcome = { kind: "saved"; receipt: HumanReceipt; checked: boolean }
  | { kind: "pending" } | { kind: "retired" } | { kind: "rejected"; error: unknown };
export type ReviewNotice = "saved" | "unknown" | "conflict" | "error" | "checkFailed" | "checkCancelled" | "checkUnknown" | "cancelRequested" | null;
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
  pendingUncertain: boolean;
  checkingAction: boolean;
  retryAllowed: boolean;
  notice: ReviewNotice;
  reasonValue: CommandFailure;
  busyMutation: boolean;
  activeCheckId: string | null;
  advisoryChecks: PluginTextReviewSelection[];
  checkReview: ReviewCheckPreparation | null;
  checkConsent: string[];
  batchRunning: boolean;
  batchStatus: ReviewBatchStatus | null;
  completionVersion: number;
}

interface ReviewSession {
  semantic: ReturnType<typeof useAiSemanticReviewSession>;
  state: ReviewDraftState;
  current: () => ReviewDraftState;
  inFlight: () => boolean;
  setLocale: (value: string) => void;
  setActor: (value: string) => void;
  setSelected: (target: ReviewTarget | null) => void;
  receiveTarget: (target: ReviewTarget, expected: ReviewDraftState) => boolean;
  observeProjection: (target: ReviewTarget, capture: { unitId: string; locale: string; basis: string; editSeq: number }) => void;
  editReason: (target: ReviewTarget, value: string) => void;
  adoptCurrent: () => boolean;
  toggleChosen: (target: ReviewSummary, checked: boolean) => void;
  clear: () => void;
  setNotice: (notice: ReviewNotice) => void;
  setReason: (reason: CommandFailure) => void;
  decide: (kind: ReviewWrite["kind"], currentRead: () => boolean) => Promise<void>;
  setAdvisoryChecks: (value: PluginTextReviewSelection[]) => void;
  observeSettingsRevision: (revision: string) => void;
  slotConsentKey: (slot: ReviewPluginCheckView["checkers"][number]) => string;
  setCheckerConsent: (attemptId: string, inputDigest: string, approved: boolean) => void;
  checkersConfirmed: () => boolean;
  prepareCheck: (currentRead: () => boolean) => Promise<void>;
  check: (currentRead: () => boolean) => Promise<void>;
  waive: (issueId: string, grant: boolean, expectedWaiverId: string | null, currentRead: () => boolean) => Promise<void>;
  finding: (capture: Pick<ReviewFindingWrite, "runId" | "issueId" | "expectedDecisionId" | "disposition"> & { evidence: Pick<AdvisoryFinding, "requirement" | "finding" | "runId" | "purpose" | "aiOrigin"> }, currentRead: () => boolean) => Promise<ReviewFindingDecision | null>;
  fallback: (allow: boolean, currentRead: () => boolean) => Promise<void>;
  retryPending: () => Promise<void>;
  checkPending: () => Promise<void>;
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
    pending: null, pendingUncertain: false, checkingAction: false, retryAllowed: false, notice: null, reasonValue: "", busyMutation: false, activeCheckId: null,
    batchRunning: false, batchStatus: null, completionVersion: 0, advisoryChecks: [], checkReview: null, checkConsent: [],
  }));
  const currentState = useRef(state);
  const semantic = useAiSemanticReviewSession(project, state.projection, Object.values(state.chosen), state.locale);
  const projectRef = useRef(project);
  const mounted = useSessionAlive(), reads = useSessionReads();
  useLayoutEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(scope => ["project","source","translation","resources","review"].includes(scope))) {
      update(before => before.checkReview ? { ...before, checkReview: null, checkConsent: [] } : before);
    }
  }), [reads]);
  const running = useRef(false);
  const cancelBatch = useRef(false);
  const targetScope = project.metadata.targetLocales.join("\u0000");
  useLayoutEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function update(change: (before: ReviewDraftState) => ReviewDraftState) {
    const before = currentState.current;
    if (!mounted.current || reads.retired) return before;
    const after = change(before);
    currentState.current = after;
    if (after !== before) setState(after);
    return after;
  }
  function current() { return currentState.current; }
  function localeAvailable(locale: string) { return locale !== "" && projectRef.current.metadata.targetLocales.includes(locale); }
  function setLocale(value: string) { update(before => ({ ...before, locale: value, selected: null, projection: null, checkReview: null, checkConsent: [] })); }
  function setActor(value: string) { update(before => ({ ...before, actor: value })); }
  function setSelected(target: ReviewTarget | null) {
    update(before => ({ ...before, selected: target ? before.draftTargets[reviewDraftKey(target)] ?? target : null,
      projection: target, checkReview: before.checkReview && target && before.checkReview.request.unitId === target.unitId
        && before.checkReview.request.locale === target.locale && before.checkReview.request.expectedBasis === target.basis ? before.checkReview : null,
      checkConsent: before.checkReview && target && before.checkReview.request.unitId === target.unitId && before.checkReview.request.locale === target.locale
        && before.checkReview.request.expectedBasis === target.basis ? before.checkConsent : [] }));
  }
  function receiveTarget(target: ReviewTarget, expected: ReviewDraftState) {
    const before = current();
    if (!mounted.current || reads.retired || before !== expected || running.current || before.busyMutation || before.pending
      || before.batchRunning || before.checkReview || before.checkConsent.length > 0 || !localeAvailable(target.locale)
      || !target.selectionId || !target.revisionId || target.translationText === null) return false;
    // A fresh query is the projection. A retained reason stays attached to its
    // earlier evidence until the human explicitly adopts the current basis.
    update(value => ({ ...value, locale: target.locale, selected: value.draftTargets[reviewDraftKey(target)] ?? target, projection: target }));
    return true;
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
    if (running.current || current().pending || !semantic.clear()) return;
    update(before => ({ ...before, drafts: {}, editSeq: {}, draftTargets: {}, chosen: {}, selected: null, projection: null, notice: null, reasonValue: "", checkReview: null, checkConsent: [], advisoryChecks: [] }));
  }
  function setNotice(notice: ReviewNotice) { update(before => ({ ...before, notice })); }
  function setReason(reasonValue: CommandFailure) { update(before => ({ ...before, reasonValue })); }
  function fail(error: unknown) {
    update(before => ({ ...before, notice: "error", reasonValue: commandFailure(error) }));
  }
  function reasonAfterReceipt(before: ReviewDraftState, action: ReviewPending) {
    if (action.kind === "check" || action.kind === "prepare-check") return { drafts: before.drafts, editSeq: before.editSeq, draftTargets: before.draftTargets };
    const key = reviewDraftKey(action.request);
    if (before.editSeq[key] !== action.submittedSeq || before.drafts[key] !== action.request.reason) {
      return { drafts: before.drafts, editSeq: before.editSeq, draftTargets: before.draftTargets };
    }
    const draftTargets = { ...before.draftTargets };
    delete draftTargets[key];
    return { drafts: { ...before.drafts, [key]: "" }, editSeq: { ...before.editSeq, [key]: action.submittedSeq + 1 }, draftTargets };
  }
  function matchingSelected(before: ReviewDraftState, action: Pick<ReviewPending, "request">) {
    return !!before.selected && before.selected.unitId === action.request.unitId
      && before.selected.locale === action.request.locale && before.selected.basis === action.request.expectedBasis;
  }
  function confirmed(action: Exclude<ReviewPending, { kind: "prepare-check" }>, receipt: ReviewDecision | CheckRun | Waiver | FallbackDecision | ReviewFindingDecision, pending: ReviewPending = action) {
    update(before => {
      if (before.pending !== pending) return before;
      function withReceipt(target: ReviewTarget): ReviewTarget {
        if (action.kind === "finding") return target;
        if (action.kind === "decision") {
          const decision = receipt as ReviewDecision, observed = target.currentDecision?.decisionId ?? null;
          return observed === action.request.expectedDecisionId || observed === decision.decisionId
            ? { ...target, currentDecision: decision } : target;
        }
        if (action.kind === "check") {
          const run = receipt as CheckRun, observed = target.currentCheck?.runId ?? null;
          return observed === action.previousRunId || observed === run.runId ? { ...target, currentCheck: run } : target;
        }
        if (action.kind === "waiver") {
          const waiver = receipt as Waiver;
          const observed = target.currentWaivers.find(value => value.issueId === action.request.issueId)?.waiverId ?? null;
          if (observed !== action.request.expectedWaiverId && observed !== waiver.waiverId) return target;
          return { ...target, currentWaivers: action.request.grant
            ? [...target.currentWaivers.filter(value => value.issueId !== waiver.issueId), waiver]
            : target.currentWaivers.filter(value => value.waiverId !== action.request.expectedWaiverId) };
        }
        const fallback = receipt as FallbackDecision, observed = target.currentFallback?.fallbackId ?? null;
        return observed === action.request.expectedFallbackId || observed === fallback.fallbackId
          ? { ...target, currentFallback: action.request.allow ? fallback : null } : target;
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
        const observed = chosen[key]?.currentDecision?.decisionId ?? null;
        if (chosen[key]?.basis === action.request.expectedBasis && (observed === action.request.expectedDecisionId
          || observed === (receipt as ReviewDecision).decisionId)) { chosen = { ...chosen }; delete chosen[key]; }
      }
      const nextReason = reasonAfterReceipt({ ...before, draftTargets }, action);
      const checkOutcome = action.kind === "check" ? (receipt as CheckRun).outcome : null;
      const batchStatus = action.kind === "decision" && action.submittedSeq === -1 && !before.batchRunning
        && before.batchStatus && before.batchStatus.failed > 0
        ? { ...before.batchStatus, applied: before.batchStatus.applied + 1, failed: before.batchStatus.failed - 1 } : before.batchStatus;
      return { ...before, ...nextReason, selected, projection, chosen, batchStatus, pending: null, pendingUncertain: false, checkingAction: false, retryAllowed: false,
        notice: checkOutcome === "failed" ? "checkFailed" : checkOutcome === "cancelled" ? "checkCancelled" : checkOutcome === "unknown" ? "checkUnknown" : "saved",
        reasonValue: "", checkReview: action.kind === "check" ? null : before.checkReview,
        checkConsent: action.kind === "check" ? [] : before.checkConsent,
        completionVersion: before.completionVersion + (before.batchRunning ? 0 : 1) };
    });
  }
  function matchesHuman(action: ReviewHumanPending) {
    return mounted.current && !reads.retired && current().pending === action;
  }
  async function lookupHuman(action: ReviewHumanPending, originalFailure: CommandFailure = current().reasonValue): Promise<HumanOutcome> {
    if (!matchesHuman(action)) return { kind: "retired" };
    update(before => ({ ...before, checkingAction: true, retryAllowed: false, pendingUncertain: true, notice: null, reasonValue: "" }));
    try {
      let receipt: HumanReceipt | null;
      if (action.kind === "finding") {
        receipt = await reviewCommands.findingAction({ ...action.session, actionId: action.request.actionId });
        if (receipt !== null) {
          confirmReviewFinding(receipt, action.request);
          confirmReviewFindingBasis(receipt, action.basisEvidence);
          confirmReviewFindingEvidence(receipt, action.evidence);
        }
      } else if (action.kind === "decision") {
        const found = await reviewCommands.decisionAction(action.session, action.request);
        receipt = found === null ? null : found.receipt;
      } else if (action.kind === "waiver") {
        const found = await reviewCommands.waiverAction(action.session, action.request);
        receipt = found === null ? null : found.receipt;
      } else {
        const found = await reviewCommands.fallbackAction(action.session, action.request);
        receipt = found === null ? null : found.receipt;
      }
      if (!matchesHuman(action)) return { kind: "retired" };
      if (receipt !== null) {
        confirmed(action, receipt);
        return { kind: "saved", receipt, checked: true };
      }
      update(before => ({ ...before, checkingAction: false, retryAllowed: true, pendingUncertain: true, notice: "unknown", reasonValue: originalFailure }));
    } catch (error) {
      if (!matchesHuman(action)) return { kind: "retired" };
      update(before => ({ ...before, checkingAction: false, retryAllowed: false, pendingUncertain: true, notice: "unknown", reasonValue: commandFailure(error) }));
    }
    return { kind: "pending" };
  }
  async function dispatchHuman(action: ReviewHumanPending): Promise<HumanOutcome> {
    if (!mounted.current || reads.retired) return { kind: "retired" };
    const uncertain = current().pending === action && current().pendingUncertain;
    update(before => ({ ...before, pending: action, checkingAction: false, retryAllowed: false, notice: null, reasonValue: "" }));
    let failed: { error: unknown } | null = null;
    let receipt: HumanReceipt | null = null;
    try {
      if (action.kind === "finding") {
        receipt = await reviewCommands.finding(action.session, action.request);
        confirmReviewFindingBasis(receipt, action.basisEvidence);
        confirmReviewFindingEvidence(receipt, action.evidence);
      } else if (action.kind === "decision") receipt = await reviewCommands.decide(action.session, action.request);
      else if (action.kind === "waiver") receipt = await reviewCommands.waive(action.session, action.request);
      else receipt = await reviewCommands.fallback(action.session, action.request);
    } catch (error) { failed = { error }; }
    if (!matchesHuman(action)) return { kind: "retired" };
    if (!failed && receipt !== null) {
      confirmed(action, receipt);
      return { kind: "saved", receipt, checked: false };
    }
    if (!failed) return { kind: "pending" };
    const error = failed.error;
    const unknown = hasUnknownOutcome(error);
    const failure = commandFailure(error);
    update(before => ({ ...before, pending: unknown || uncertain ? action : null, pendingUncertain: unknown || uncertain,
      retryAllowed: false, notice: unknown || uncertain ? "unknown" : isConflict(error) ? "conflict" : "error", reasonValue: failure }));
    // A failed lookup cannot enter this write-error branch and cause another read.
    if (unknown) return lookupHuman(action, failure);
    return uncertain ? { kind: "pending" } : { kind: "rejected", error };
  }
  async function lookupCheck(action: ReviewCheckPending, originalFailure: CommandFailure = current().reasonValue) {
    const matches = () => mounted.current && !reads.retired && current().pending === action;
    if (!matches()) return;
    update(before => ({ ...before, checkingAction: true, retryAllowed: false, pendingUncertain: true, notice: null, reasonValue: "" }));
    try {
      const found = await reviewCommands.checkAction(action.request);
      if (!matches()) return;
      if (found !== null) {
        confirmReviewFindingBasis(found.receipt, action.basisEvidence);
        confirmed({ ...action, kind: "check", executions: [] }, found.receipt, action);
        return;
      }
      // Absence of a final run does not prove preparation or execution stopped.
      update(before => ({ ...before, checkingAction: false, retryAllowed: true, pendingUncertain: true,
        notice: "unknown", reasonValue: originalFailure }));
    } catch (error) {
      if (!matches()) return;
      update(before => ({ ...before, checkingAction: false, retryAllowed: false, pendingUncertain: true,
        notice: "unknown", reasonValue: commandFailure(error) }));
    }
  }
  async function dispatch(action: ReviewPending) {
    if (!mounted.current || reads.retired) return;
    if (isHumanReviewPending(action)) {
      const outcome = await dispatchHuman(action);
      return action.kind === "finding" && outcome.kind === "saved" ? outcome.receipt as ReviewFindingDecision : undefined;
    }
    const uncertain = current().pending === action && current().pendingUncertain;
    update(before => ({ ...before, pending: action, checkingAction: false, retryAllowed: false, notice: null,
      activeCheckId: action.kind === "check" ? action.request.actionId : null }));
    try {
      const session = { sessionToken: action.request.sessionToken, projectId: action.request.projectId };
      if (action.kind === "prepare-check") {
        const preparation = await reviewCommands.prepareCheck(action.request);
        if (!mounted.current || reads.retired || current().pending !== action) return;
        if (preparation.kind === "recorded") {
          confirmReviewFindingBasis(preparation.run, action.basisEvidence);
          confirmed({ ...action, kind: "check", executions: [] }, preparation.run, action);
        }
        else update(before => {
          if (before.pending !== action) return before;
          const captureCurrent = matchingSelected(before, action) && localeAvailable(action.request.locale)
            && JSON.stringify(before.advisoryChecks) === JSON.stringify(action.request.advisoryChecks);
          return { ...before, pending: null, pendingUncertain: false, checkingAction: false, retryAllowed: false, checkReview: captureCurrent ? { request: action.request, view: preparation.view } : null,
            checkConsent: [], notice: null, completionVersion: before.completionVersion + 1 };
        });
      }
      if (action.kind === "check") {
        const receipt = await reviewCommands.check({ ...session, check: action.request, executions: action.executions });
        if (mounted.current && !reads.retired && current().pending === action) {
          confirmReviewFindingBasis(receipt, action.basisEvidence); confirmed(action, receipt);
        }
      }
    } catch (error) {
      if (!mounted.current || reads.retired || current().pending !== action) return;
      const unknown = hasUnknownOutcome(error), failure = commandFailure(error);
      update(before => ({ ...before, pending: unknown || uncertain ? action : null,
        pendingUncertain: unknown || uncertain, retryAllowed: false,
        notice: unknown || uncertain ? "unknown"
          : action.kind === "check" && isCommandError(error) && error.code === "cancelled" && error.reason === "review-check-cancelled" ? "checkCancelled"
          : isConflict(error) ? "conflict" : "error", reasonValue: failure }));
      if (unknown) await lookupCheck(action, failure);
    } finally { update(before => ({ ...before, activeCheckId: null })); }
  }
  async function fresh(target: ReviewTarget, currentRead: () => boolean,
    makeAction: (actionId: string, before: ReviewDraftState) => ReviewPending) {
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
      const action = makeAction(actionId, before);
      if (isHumanReviewPending(action)) action.session = structuredClone(session);
      return await dispatch(action);
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
    await fresh(target, currentRead, actionId => ({ kind: "decision", session: executionContext(projectRef.current), submittedSeq: before.editSeq[key] ?? 0,
      request: { projectId: projectRef.current.metadata.projectId, actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, expectedDecisionId: target.currentDecision?.decisionId ?? null,
        actor: before.actor.trim(), kind, reason } }));
  }
  function setAdvisoryChecks(value: PluginTextReviewSelection[]) {
    if (running.current || current().pending) return;
    update(before => ({ ...before, advisoryChecks: structuredClone(value), checkReview: null, checkConsent: [] }));
  }
  function observeSettingsRevision(revision: string) {
    update(before => before.checkReview?.view.checkers.some(slot => slot.plugin.plugin.settingsRevision !== revision)
      ? { ...before, checkReview: null, checkConsent: [] } : before);
  }
  function slotConsentKey(slot: ReviewPluginCheckView["checkers"][number]) {
    return JSON.stringify([current().checkReview?.request, slot]);
  }
  function setCheckerConsent(attemptId: string, inputDigest: string, approved: boolean) {
    const before = current(), slot = before.checkReview?.view.checkers.find(value => value.attemptId === attemptId && value.inputDigest === inputDigest);
    if (running.current || before.pending || !slot) return;
    const key = slotConsentKey(slot);
    update(value => ({ ...value, checkConsent: approved ? [...value.checkConsent.filter(item => item !== key), key] : value.checkConsent.filter(item => item !== key) }));
  }
  function checkersConfirmed() {
    const before = current(), capture = before.checkReview;
    return !!capture && capture.view.checkers.length > 0 && matchingSelected(before, { request: capture.request })
      && localeAvailable(capture.request.locale) && JSON.stringify(before.advisoryChecks) === JSON.stringify(capture.request.advisoryChecks)
      && capture.view.checkers.every(slot => before.checkConsent.includes(slotConsentKey(slot)));
  }
  async function prepareCheck(currentRead: () => boolean) {
    const before = current(), target = before.selected;
    if (!target) return;
    await fresh(target, () => currentRead() && JSON.stringify(current().advisoryChecks) === JSON.stringify(before.advisoryChecks), actionId => ({ kind: "prepare-check", submittedSeq: null, previousRunId: target.currentCheck?.runId ?? null, basisEvidence: structuredClone(target.basisEvidence),
      request: { ...executionContext(projectRef.current), actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, advisoryChecks: structuredClone(before.advisoryChecks) } }));
  }
  async function check(currentRead: () => boolean) {
    const capture = current().checkReview;
    if (!capture || !mounted.current || running.current || current().pending || !currentRead() || !checkersConfirmed()) return;
    running.current = true; update(value => ({ ...value, busyMutation: true }));
    try {
      const session = executionContext(projectRef.current), executions: ReviewCheckStartRequest["executions"] = [];
      for (const slot of capture.view.checkers) {
        const grantId = await executionCommands.identity(session);
        if (!mounted.current || current().checkReview !== capture || current().pending || !currentRead() || !checkersConfirmed()) return;
        executions.push({ ...session, grantId, attemptId: slot.attemptId, inputDigest: slot.inputDigest,
          expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true });
      }
      const action: ReviewPending = { kind: "check", request: capture.request, executions, submittedSeq: null, previousRunId: current().selected?.currentCheck?.runId ?? null,
        basisEvidence: structuredClone(current().selected!.basisEvidence) };
      update(value => ({ ...value, checkReview: null, checkConsent: [] }));
      await dispatch(action);
    } catch(error) { fail(error); }
    finally { running.current = false; update(value => ({ ...value, busyMutation: false, activeCheckId: null })); }
  }
  async function waive(issueId: string, grant: boolean, expectedWaiverId: string | null, currentRead: () => boolean) {
    const before = current(), target = before.selected;
    if (!target || !before.actor.trim() || !(before.drafts[reviewDraftKey(target)] ?? "").trim()) {
      update(value => ({ ...value, notice: "error", reasonValue: "reason-required" })); return;
    }
    const key = reviewDraftKey(target), reason = before.drafts[key];
    await fresh(target, currentRead, actionId => ({ kind: "waiver", session: executionContext(projectRef.current), submittedSeq: before.editSeq[key] ?? 0,
      request: { projectId: projectRef.current.metadata.projectId, actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, issueId, grant, expectedWaiverId, actor: before.actor.trim(), reason } }));
  }
  async function finding(capture: Pick<ReviewFindingWrite, "runId" | "issueId" | "expectedDecisionId" | "disposition"> & { evidence: Pick<AdvisoryFinding, "requirement" | "finding" | "runId" | "purpose" | "aiOrigin"> }, currentRead: () => boolean) {
    const before = current(), target = before.selected;
    if (!target || !before.actor.trim() || !(before.drafts[reviewDraftKey(target)] ?? "").trim()) {
      update(value => ({ ...value, notice: "error", reasonValue: "reason-required" })); return null;
    }
    const key = reviewDraftKey(target), reason = before.drafts[key];
    const { evidence, ...requestCapture } = capture;
    const receipt = await fresh(target, currentRead, actionId => ({ kind: "finding", session: executionContext(projectRef.current), evidence: structuredClone(evidence), basisEvidence: structuredClone(target.basisEvidence), submittedSeq: before.editSeq[key] ?? 0,
      request: { ...requestCapture, projectId: projectRef.current.metadata.projectId, actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, actor: before.actor.trim(), reason } }));
    return receipt ?? null;
  }
  async function fallback(allow: boolean, currentRead: () => boolean) {
    const before = current(), target = before.selected;
    if (!target || !before.actor.trim() || !(before.drafts[reviewDraftKey(target)] ?? "").trim()) {
      update(value => ({ ...value, notice: "error", reasonValue: "reason-required" })); return;
    }
    const key = reviewDraftKey(target), reason = before.drafts[key];
    await fresh(target, currentRead, actionId => ({ kind: "fallback", session: executionContext(projectRef.current), submittedSeq: before.editSeq[key] ?? 0,
      request: { projectId: projectRef.current.metadata.projectId, actionId, unitId: target.unitId, locale: target.locale,
        expectedBasis: target.basis, allow, expectedFallbackId: target.currentFallback?.fallbackId ?? null,
        actor: before.actor.trim(), reason } }));
  }
  async function retryPending() {
    const action = current().pending;
    if (!mounted.current || reads.retired || !action || running.current || !current().retryAllowed) return;
    running.current = true;
    update(before => ({ ...before, busyMutation: true, notice: null }));
    try {
      if (current().pending !== action) return;
      if (current().pending === action) await dispatch(action);
    }
    finally { running.current = false; update(before => ({ ...before, busyMutation: false, activeCheckId: null })); }
  }
  async function checkPending() {
    const action = current().pending;
    if (!mounted.current || reads.retired || running.current || !action) return;
    running.current = true;
    update(before => ({ ...before, busyMutation: true }));
    try { if (isHumanReviewPending(action)) await lookupHuman(action); else await lookupCheck(action); }
    finally { running.current = false; update(before => ({ ...before, busyMutation: false })); }
  }
  async function cancelCheck() {
    const before = current(), actionId = before.activeCheckId ?? (before.pending?.kind === "check" ? before.pending.request.actionId : null);
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
      try {
        const session = executionContext(projectRef.current);
        const actionId = await executionCommands.identity(session);
        if (cancelBatch.current || !mounted.current || current().pending || !localeAvailable(target.locale)) break;
        const request: ReviewWrite = { projectId: session.projectId, actionId,
          unitId: target.unitId, locale: target.locale, expectedBasis: target.basis,
          expectedDecisionId: target.currentDecision?.decisionId ?? null, actor: batchActor, kind: "approve", reason: "" };
        const action: ReviewHumanPending = { kind: "decision", session: structuredClone(session), request, submittedSeq: -1 };
        const outcome = await dispatchHuman(action);
        if (outcome.kind === "retired") break;
        if (outcome.kind === "saved") {
          result.applied++;
          // An uncertain batch action is checked once, never a reason to resume
          // the remaining batch after that recovery boundary.
          if (outcome.checked) { processed++; break; }
        } else if (outcome.kind === "pending") { result.failed++; processed++; break; }
        else if (isConflict(outcome.error)) result.conflicted++;
        else result.failed++;
      } catch (error) {
        if (hasUnknownOutcome(error)) { result.failed++; processed++; break; }
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
    if (localeAvailable(before.locale) || before.pending || before.busyMutation || before.checkReview
      || before.checkConsent.length > 0 || before.advisoryChecks.length > 0 || Object.keys(before.chosen).length > 0 || Object.values(before.drafts).some(value => value.length > 0)) return;
    const next = project.metadata.targetLocales[0] ?? "";
    if (next !== before.locale) update(value => ({ ...value, locale: next, selected: null, projection: null }));
  }, [targetScope, state.locale, state.pending, state.busyMutation, state.chosen, state.drafts]);

  const owner: ReviewSession = { state, current, semantic, inFlight: () => running.current || semantic.reserved(),
    setLocale, setActor, setSelected, receiveTarget, observeProjection, editReason, adoptCurrent, toggleChosen, clear, setNotice, setReason,
    decide, prepareCheck, check, setAdvisoryChecks, observeSettingsRevision, slotConsentKey, setCheckerConsent, checkersConfirmed, waive, finding, fallback, retryPending, checkPending, cancelCheck, approveBatch, stopBatch };
  return <ReviewContext.Provider value={owner}>{children}</ReviewContext.Provider>;
}
