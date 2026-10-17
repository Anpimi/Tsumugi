import { ReviewFindings } from "./ReviewFindings";
import { AiSemanticReview } from "./AiSemanticReview";
import { ReviewCheckerDetails, ReviewDiagnosticDetails, checkerIdentity, capturedRuleLabel, ruleIdentity } from "./ReviewCheckers";
import { TextReviewSelections } from "./TextReviewSelections";
import { reviewFindingLabel } from "./reviewLabels";
import { reviewReasonKey } from "./reviewLabels";
import { commandFailure, failureReason, CommandFailureDetails } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView, useWorkbenchState, useWorkbenchRef } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import { reviewCommands as commands, type Eligibility, type EligibilityReason,
  type ReviewHistoryPage, type ReviewSummaryPage, type ReviewTarget, type WorkPage } from "./reviewCommands";
import { reviewDraftKey, useReviewDraftSession } from "./ReviewDraftSession";
import { useWorkbenchCommands, type ReviewFallbackCommandPayload, type ReviewWaiverCommandPayload } from "./workbenchCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import type { ChangeScope } from "./sessionReads";
import type { ReviewHandoffPresentation } from "./sessionNavigation";
import { currentDiagnosticRun, diagnosticIntentMatchesTarget, type ReviewDiagnosticIntent, type ReviewEditorHandoff, type ReviewEditorReturn } from "./reviewDiagnosticNavigation";
import { semanticReviewKey } from "./aiSemanticReviewQueries";
import { reviewFindingsKey } from "./reviewQueries";
import type { AiSemanticReviewView } from "./aiSemanticReviewCommands";
import type { ReviewFindingView } from "./reviewCommands";

type Tab = "review" | "work" | "eligibility";
const MAX_BATCH = 100;
export interface ReviewHandle { allowLeave: (current?: () => boolean) => Promise<boolean>; allowNavigate: () => Promise<boolean>; showWork: () => void }

const errorReason = commandFailure;
const draftKey = reviewDraftKey;
const CURRENT_SCOPES: ChangeScope[] = ["source", "translation", "resources", "review"];
const summaryKey = (locale: string, scopeId: string, after: number) => ["review-summary", locale, scopeId, "", after, 50] as const;
const targetKey = (unitId: string, locale: string) => ["review-target", unitId, locale] as const;
function sameTargetBasis(left: ReviewTarget, right: ReviewTarget) {
  return left.unitId === right.unitId && left.locale === right.locale && left.basis === right.basis
    && left.sourceSnapshotId === right.sourceSnapshotId && left.sourceRevisionId === right.sourceRevisionId
    && left.selectionId === right.selectionId && left.revisionId === right.revisionId;
}
const HISTORY_FIRST_SCOPES: ChangeScope[] = ["source", "translation", "resources", "review"];
// A review change moves a later history page back to zero before it is read.
// Only the first-page query listens to review invalidation, so the old offset
// cannot refetch while that cursor transition is committing.
const HISTORY_LATER_SCOPES: ChangeScope[] = ["source", "translation", "resources"];

export function ReviewWorkbench({ project, disabled, onOpenTranslation, onOpenExtensions, onOpenConnections, onReturnToAi, handoff, ref }: {
  project: ProjectView; disabled: boolean; onOpenTranslation: (target: EditorTarget, locale: string, handoff?: ReviewEditorHandoff) => boolean | Promise<boolean>;
  ref?: Ref<ReviewHandle>;
  onOpenExtensions?: () => void;
  onOpenConnections?: () => void;
  onReturnToAi?: () => Promise<boolean>;
  handoff?: ReviewHandoffPresentation;
}) {
  const { t } = useTranslation();
  const session = executionContext(project);
  const owner = useReviewDraftSession();
  const reads = useSessionReads();
  const commandRegistry = useWorkbenchCommands();
  const { locale, actor, drafts, selected, chosen, pending, notice, reasonValue,
    busyMutation, activeCheckId, batchRunning, batchStatus } = owner.state;
  const setLocale = owner.setLocale;
  const setActor = owner.setActor;
  const setSelected = owner.setSelected;
  const setNotice = owner.setNotice;
  const setReason = owner.setReason;
  const decide = owner.decide;
  const check = owner.check;
  const prepareCheck = owner.prepareCheck;
  const { advisoryChecks, checkReview: currentCheckReview, checkConsent } = owner.state;
  const slotConsentKey = owner.slotConsentKey;
  const checkersConfirmed = owner.checkersConfirmed();
  const cancelCheck = owner.cancelCheck;
  const [open, setOpen] = useWorkbenchView("review");
  const [tab, setTab] = useWorkbenchState<Tab>("review", "tab", "review");
  // The Host capture identity is a view input. Its mutable rows stay in Query.
  const [summaryScope, setSummaryScope] = useWorkbenchState<{ locale: string; scopeId: string } | null>("review", "summaryScope", null);
  const captureLocale = useWorkbenchRef<string | null>("review", "summaryCaptureLocale", null);
  const [pageAfter, setPageAfter] = useWorkbenchState("review", "pageAfter", 0);
  const [historyCursor, setHistoryCursor] = useWorkbenchState("review", "historyCursor", { unitId: "", locale: "", offset: 0 });
  const [workCursor, setWorkCursor] = useWorkbenchState("review", "workCursor", { locale, offset: 0 });
  const [editorOrigin, setEditorOrigin] = useWorkbenchState<ReviewEditorReturn | null>("review", "editorOrigin", null);
  const [editorReturned, setEditorReturned] = useWorkbenchState<ReviewEditorReturn | null>("review", "editorReturned", null);
  const returnFocus = useRef<HTMLButtonElement>(null), focusedReturn = useRef<ReviewEditorReturn | null>(null);
  const [languages, setLanguages] = useWorkbenchState<string[]>("review", "languages", project.metadata.targetLocales);
  const [assessment, setAssessment] = useWorkbenchState<{ projectId: string; sessionToken: string; reviewLocale: string; locales: string[] } | null>("review", "assessment", null);
  const reason = failureReason(reasonValue) ?? "";
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureFailure, setCaptureFailure] = useState<ReturnType<typeof commandFailure> | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionFailure, setSelectionFailure] = useState<ReturnType<typeof commandFailure> | null>(null);
  const [selectionIntent, setSelectionIntent] = useState<{ unitId: string; locale: string } | null>(null);
  const [comparisonIntent, setComparisonIntent] = useState<{ unitId: string; locale: string; basis: string;
    currentBasis: string; fallbackId: string | null } | null>(null);
  const [completedComparison, setCompletedComparison] = useState<{ unitId: string; locale: string; basis: string;
    ticket: number; completionVersion: number } | null>(null);
  const selecting = useRef(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [batchPrompt, setBatchPrompt] = useWorkbenchState("review", "batchPrompt", false);
  // This modal capture also blocks another dispatch before its open state commits.
  const batchConfirmation = useWorkbenchRef<{ chosen: typeof chosen; actor: string } | null>("review", "batchConfirmation", null);
  const alive = useRef(false);
  const generation = useRef(0);
  const semanticRevision = useRef(0);
  const leaveProof = useRef<(() => boolean) | null>(null);
  const leaveResolver = useRef<((allowed: boolean) => void) | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const hasDraft = Object.values(drafts).some(value => value.length > 0);
  const lastCompletion = useRef(owner.state.completionVersion);
  const targetScope = project.metadata.targetLocales.join("\u0000");
  const availableLocales = useRef(project.metadata.targetLocales);
  const selectedLocale = useRef(locale);
  useLayoutEffect(() => {
    availableLocales.current = project.metadata.targetLocales;
    selectedLocale.current = locale;
  }, [targetScope, locale]);
  const localeAvailable = (value: string) => value !== "" && availableLocales.current.includes(value);
  const currentLocale = (value: string) => selectedLocale.current === value && localeAvailable(value);
  const targetAvailable = locale !== "" && project.metadata.targetLocales.includes(locale);
  const targetRemoved = locale !== "" && !targetAvailable;
  const scopeId = summaryScope?.locale === locale ? summaryScope.scopeId : null;
  const summaryActive = open && tab === "review" && targetAvailable && scopeId !== null;
  const summaryRead = useSessionQuery<ReviewSummaryPage>({
    key: summaryKey(locale, scopeId ?? "", pageAfter), scopes: CURRENT_SCOPES, enabled: summaryActive,
    read: () => readSummary(scopeId!, pageAfter),
  });
  const summaryFailure = captureFailure ?? (summaryActive && summaryRead.error ? errorReason(summaryRead.error) : null);
  const page = summaryActive && !summaryFailure ? summaryRead.data ?? null : null;
  const summaryBusy = captureBusy || (summaryActive && (summaryRead.isFetching || owner.state.completionVersion !== lastCompletion.current));
  const targetActive = open && tab === "review" && targetAvailable && !!selected && selected.locale === locale;
  const targetRead = useSessionQuery<ReviewTarget>({
    key: targetKey(selected?.unitId ?? "", selected?.locale ?? ""), scopes: CURRENT_SCOPES, enabled: targetActive,
    read: () => readTarget(selected!.unitId, selected!.locale),
  });
  const targetFailure = selectionFailure ?? (targetActive && targetRead.error ? errorReason(targetRead.error) : null);
  // The cursor belongs to a language. An owner-driven language rebase must use
  // page zero even before the cursor reset effect commits.
  const workOffset = workCursor.locale === locale ? workCursor.offset : 0;
  const workActive = open && tab === "work" && targetAvailable;
  const workRead = useSessionQuery<WorkPage>({
    key: ["review-work", locale, workOffset, 50], scopes: ["source", "translation", "resources", "review"],
    enabled: workActive,
    read: () => commands.work({ ...session, locale, offset: workOffset, limit: 50 }),
  });
  const work = workActive ? workRead.data ?? null : null;
  const workLoading = workActive && workRead.isFetching && !work;
  const workFailure = workActive && workRead.error ? errorReason(workRead.error) : null;
  const workBusy = workActive && workRead.isFetching;
  const historyOffset = historyCursor.unitId === selected?.unitId && historyCursor.locale === selected?.locale
    ? historyCursor.offset : 0;
  const historyActive = open && tab === "review" && !!selected && targetAvailable && selected.locale === locale;
  const historyRead = useSessionQuery<ReviewHistoryPage>({
    key: ["review-history", selected?.unitId ?? "", selected?.locale ?? "", historyOffset, 20],
    scopes: historyOffset === 0 ? HISTORY_FIRST_SCOPES : HISTORY_LATER_SCOPES,
    enabled: historyActive,
    read: () => commands.history({ ...session, unitId: selected!.unitId, locale: selected!.locale,
      offset: historyOffset, limit: 20 }),
  });
  const historyFailure = historyActive && historyRead.error ? errorReason(historyRead.error) : null;
  const history = historyActive && !historyFailure ? historyRead.data ?? null : null;
  const historyLoading = historyActive && historyRead.isFetching && !history;
  const historyBusy = historyActive && historyRead.isFetching;
  const assessmentCurrent = !!assessment && assessment.projectId === session.projectId
    && assessment.sessionToken === session.sessionToken && assessment.reviewLocale === locale && assessment.locales.length > 0
    && assessment.locales.length === languages.length
    && assessment.locales.every((value, index) => value === languages[index] && project.metadata.targetLocales.includes(value));
  const eligibilityActive = open && tab === "eligibility" && assessmentCurrent;
  const assessedLocales = assessment?.locales ?? [];
  const eligibilityRead = useSessionQuery<Eligibility>({
    key: ["review-eligibility", assessedLocales], scopes: ["source", "translation", "resources", "review"],
    enabled: eligibilityActive,
    read: () => commands.eligibility({ ...session, locales: assessedLocales }),
  });
  const eligibilityBusy = eligibilityActive && eligibilityRead.isFetching;
  const eligibilityFailure = eligibilityActive && eligibilityRead.error ? errorReason(eligibilityRead.error) : null;
  // Readiness is current evidence: do not present an older verdict while its
  // dependencies are being checked again or the new read has failed.
  const eligibility = eligibilityActive && !eligibilityBusy && !eligibilityFailure ? eligibilityRead.data ?? null : null;
  const busy = busyMutation;
  const chosenCount = Object.keys(chosen).length;
  const invalidChosenLocale = Object.values(chosen).find(value => !project.metadata.targetLocales.includes(value.locale))?.locale;
  const invalidDraftKey = Object.keys(drafts).find(key => drafts[key].length > 0
    && !project.metadata.targetLocales.includes(key.slice(0, key.indexOf(":"))));
  const invalidDraftLocale = invalidDraftKey?.slice(0, invalidDraftKey.indexOf(":"));
  const invalidPendingLocale = pending && !project.metadata.targetLocales.includes(pending.request.locale) ? pending.request.locale : null;
  const removedLocale = targetRemoved ? locale : invalidChosenLocale ?? invalidDraftLocale ?? invalidPendingLocale;
  const retainedReview = hasDraft || chosenCount > 0 || !!pending || owner.inFlight() || batchRunning
    || !!currentCheckReview || checkConsent.length > 0 || advisoryChecks.length > 0 || owner.semantic.dirty();
  // The primary content belongs to the business capture, including its checked
  // receipts. Query can refresh the comparison without replacing that evidence.
  const displayTarget = selected;
  const currentFacts = targetActive && !targetRead.isFetching && !targetRead.isStale && !targetFailure
    && owner.state.completionVersion === lastCompletion.current ? targetRead.data ?? null : null;
  const selectedStale = !!selected && !!currentFacts && !sameTargetBasis(selected, currentFacts);
  const fallbackIdentityChanged = !!selected && !!currentFacts && !selected.selectionId
    && (selected.currentFallback?.fallbackId ?? null) !== (currentFacts.currentFallback?.fallbackId ?? null);
  const comparisonVisible = !!selected && !!currentFacts && comparisonIntent?.unitId === selected.unitId
    && comparisonIntent.locale === selected.locale && comparisonIntent.basis === selected.basis
    && comparisonIntent.currentBasis === currentFacts.basis && comparisonIntent.fallbackId === (currentFacts.currentFallback?.fallbackId ?? null);
  const checkTarget = currentFacts ?? displayTarget;
  const displayedCheck = checkTarget?.currentCheck;
  const commandScope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  function currentTarget() {
    const target = owner.current().selected;
    if (!open || tab !== "review" || !target || !currentLocale(target.locale) || reads.retired || selecting.current
      || owner.current().completionVersion !== lastCompletion.current) return null;
    const query = reads.client.getQueryCache().find({ queryKey: reads.key(targetKey(target.unitId, target.locale)), exact: true });
    const value = query?.state.data as ReviewTarget | undefined;
    return query?.state.status === "success" && query.state.fetchStatus === "idle" && query.state.error === null && !query.state.isInvalidated
      && value?.unitId === target.unitId && value.locale === target.locale ? value : null;
  }
  function freshReadProof() {
    const target = owner.current().selected, value = currentTarget(), ticket = generation.current;
    const query = target ? reads.client.getQueryCache().find({ queryKey: reads.key(targetKey(target.unitId, target.locale)), exact: true }) : undefined;
    const version = query?.state.dataUpdateCount;
    return () => alive.current && !reads.retired && generation.current === ticket && !!value && !!target
      && currentTarget() === value && query?.state.dataUpdateCount === version && sameTargetBasis(value, target);
  }
  function editorReturn(unitId: string): ReviewEditorReturn {
    if (tab === "review" && editorOrigin?.locale === locale && editorOrigin.unitId === unitId) return editorOrigin;
    return { ...session, locale, unitId, tab: tab === "work" ? "work" : "review", summaryScope, pageAfter, workOffset };
  }
  async function openEditor(target: ReviewTarget, diagnostic?: ReviewDiagnosticIntent, findingsOffset = 0) {
    if (!alive.current || reads.retired || disabled || !targetAvailable || owner.inFlight() || owner.current().pending) return false;
    if (diagnostic) {
      const latest = owner.current().selected;
      const semantic = diagnostic.source.purpose === "ai-semantic" ? (() => {
        const view = reads.client.getQueryState<AiSemanticReviewView | null>(reads.key(semanticReviewKey(diagnostic.source.origin.attemptId)));
        // Preflight belongs to the clicked page. Navigation acceptance still
        // rereads the first-page current-run identity before opening the editor.
        const findings = reads.client.getQueryState<ReviewFindingView>(reads.key(reviewFindingsKey(target.unitId, target.locale, findingsOffset)));
        const ready = (state: typeof view | typeof findings) => state?.status === "success" && state.fetchStatus === "idle" && !state.error && !state.isInvalidated;
        return { view: ready(view) ? view?.data : null, findings: ready(findings) ? findings?.data : null };
      })() : undefined;
      if (!latest || !sameTargetBasis(target, latest) || !diagnosticIntentMatchesTarget(diagnostic, target, semantic)) {
        setNotice("error"); setReason("diagnostic-stale"); return false;
      }
    }
    const opened = await onOpenTranslation({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, target.locale,
      { returnTo: editorReturn(target.unitId), ...(diagnostic ? { diagnostic: { ...diagnostic, basis: target.basis,
        basisEvidence: target.basisEvidence, translationText: target.translationText } } : {}) });
    if (!opened && alive.current && !reads.retired) { setNotice("error"); setReason("editor-unavailable"); }
    return opened;
  }
  function runFreshAction(run: (proof: () => boolean) => Promise<void>) {
    const before = owner.current(), target = before.selected, ticket = generation.current;
    void run(freshReadProof()).then(() => {
      const after = owner.current();
      // Only this explicitly requested action's checked completion can reveal
      // its comparison. Unknown/rejected actions grant no later viewing intent.
      if (alive.current && !reads.retired && generation.current === ticket && target && after.selected
        && !after.pending && after.completionVersion === before.completionVersion + 1 && sameTargetBasis(target, after.selected)) {
        setCompletedComparison({ unitId: target.unitId, locale: target.locale, basis: target.basis,
          ticket, completionVersion: after.completionVersion });
      }
    });
  }
  function reviewActionAvailability(requireSelection: boolean) {
    if (!open || tab !== "review" || leavePrompt || batchPrompt || batchConfirmation.current) return { enabled: false, reason: "hidden" as const };
    if (busy || owner.inFlight()) return { enabled: false, reason: "busy" as const };
    const current = owner.current();
    if (current.pending) return { enabled: false, reason: "pending-action" as const };
    const target = current.selected;
    const latest = currentTarget();
    if (!target || !latest || !targetAvailable || !sameTargetBasis(target, latest)
      || (requireSelection && (!target.selectionId || !current.actor.trim()))) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return { enabled: true };
  }
  const decisionAvailability = () => reviewActionAvailability(true);
  const prepareCheckAvailability = () => reviewActionAvailability(false);
  const checkAvailability = () => {
    const available = reviewActionAvailability(false);
    return available.enabled && !owner.checkersConfirmed() ? { enabled: false, reason: "unavailable" as const } : available;
  };
  function cancelAvailability() {
    if (!open || tab !== "review" || leavePrompt || batchPrompt || batchConfirmation.current) return { enabled: false, reason: "hidden" as const };
    const current = owner.current();
    if (!current.selected || !(current.activeCheckId ?? (current.pending?.kind === "check" ? current.pending.request.actionId : null))) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function retryAvailability() {
    if (!open || leavePrompt || batchPrompt || batchConfirmation.current) return { enabled: false, reason: "hidden" as const };
    if (busy || owner.inFlight()) return { enabled: false, reason: "busy" as const };
    if (!owner.current().pending) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function targetActionAvailability(payload: ReviewFallbackCommandPayload | ReviewWaiverCommandPayload | undefined) {
    const available = reviewActionAvailability(false);
    if (!available.enabled) return available;
    const current = owner.current(), target = current.selected;
    if (!payload || !target || !current.actor.trim() || !localeAvailable(target.locale)
      || payload.unitId !== target.unitId || payload.locale !== target.locale || payload.basis !== target.basis) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return { enabled: true };
  }
  function fallbackAvailability(payload: ReviewFallbackCommandPayload | undefined, allow: boolean) {
    const available = targetActionAvailability(payload);
    if (!available.enabled) return available;
    const current = owner.current(), target = current.selected;
    if (!target || !payload) return { enabled: false, reason: "unavailable" as const };
    const latest = currentTarget();
    if (!latest) return { enabled: false, reason: "unavailable" as const };
    if (target.selectionId || latest.selectionId
      || payload.expectedFallbackId !== (target.currentFallback?.fallbackId ?? null)
      || payload.expectedFallbackId !== (latest.currentFallback?.fallbackId ?? null)
      || (allow ? payload.expectedFallbackId !== null : payload.expectedFallbackId === null)) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return { enabled: true };
  }
  function waiverAvailability(payload: ReviewWaiverCommandPayload | undefined, grant: boolean) {
    const available = targetActionAvailability(payload);
    if (!available.enabled) return available;
    const current = owner.current(), selected = current.selected;
    if (!selected || !payload) return { enabled: false, reason: "unavailable" as const };
    const target = currentTarget();
    if (!target) return { enabled: false, reason: "unavailable" as const };
    const finding = target.currentCheck?.basis === target.basis
      ? target.currentCheck.rules.flatMap(rule => rule.findings).find(value => value.issueId === payload.issueId) : undefined;
    const waiver = target.currentWaivers.find(value => value.issueId === payload.issueId);
    if (!finding || (grant ? !finding.waivable || !!waiver || payload.expectedWaiverId !== null
      : !waiver || payload.expectedWaiverId !== waiver.waiverId)) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return { enabled: true };
  }
  function batchAvailability(confirming = false) {
    if (!open || tab !== "review" || leavePrompt || ((batchPrompt || batchConfirmation.current) && !confirming)) return { enabled: false, reason: "hidden" as const };
    if (busy || owner.inFlight()) return { enabled: false, reason: "busy" as const };
    const current = owner.current();
    if (current.pending) return { enabled: false, reason: "pending-action" as const };
    const confirmation = batchConfirmation.current;
    if (!current.actor.trim() || Object.keys(current.chosen).length === 0
      || Object.values(current.chosen).some(value => !localeAvailable(value.locale))
      || (confirming && (!batchPrompt || !confirmation || current.chosen !== confirmation.chosen
        || current.actor.trim() !== confirmation.actor))) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return { enabled: true };
  }
  function stopBatchAvailability() {
    if (!open || leavePrompt || batchPrompt || batchConfirmation.current) return { enabled: false, reason: "hidden" as const };
    if (!owner.current().batchRunning) return { enabled: false, reason: "unavailable" as const };
    return { enabled: true };
  }
  function closeBatchPrompt() { batchConfirmation.current = null; setBatchPrompt(false); }
  function confirmBatch() {
    if (!batchAvailability(true).enabled) return;
    closeBatchPrompt();
    void owner.approveBatch();
  }
  const fallbackPayload: ReviewFallbackCommandPayload | undefined = selected ? { kind: "review-fallback",
    unitId: selected.unitId, locale: selected.locale, basis: selected.basis,
    expectedFallbackId: selected.currentFallback?.fallbackId ?? null } : undefined;
  function waiverPayload(target: NonNullable<typeof selected>, issueId: string, expectedWaiverId: string | null): ReviewWaiverCommandPayload {
    return { kind: "review-waiver", unitId: target.unitId, locale: target.locale, basis: target.basis, issueId, expectedWaiverId };
  }
  useLayoutEffect(() => {
    const removeApprove = commandRegistry.register({
      id: "review.approve", nameKey: "review.approve", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", availability: decisionAvailability,
      handler: () => runFreshAction(proof => decide("approve", proof)),
    });
    const removeRequestChanges = commandRegistry.register({
      id: "review.request-changes", nameKey: "review.requestChanges", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", availability: decisionAvailability,
      handler: () => runFreshAction(proof => decide("request-changes", proof)),
    });
    const removeCheck = commandRegistry.register({
      id: "review.run-checks", nameKey: "review.check", category: "review", scope: commandScope,
      binding: null, risk: "runs-review-checks", confirmation: "none", availability: checkAvailability,
      handler: () => runFreshAction(check),
    });
    const removePrepareCheck = commandRegistry.register({
      id: "review.prepare-checks", nameKey: "review.prepareCheck", category: "review", scope: commandScope,
      binding: null, risk: "runs-review-checks", confirmation: "none", availability: prepareCheckAvailability,
      handler: () => runFreshAction(prepareCheck),
    });
    const removeCancel = commandRegistry.register({
      id: "review.cancel-checks", nameKey: "review.cancelCheck", category: "review", scope: commandScope,
      binding: null, risk: "cancels-review-checks", confirmation: "none", availability: cancelAvailability,
      handler: () => { void cancelCheck(); },
    });
    const removeRetry = commandRegistry.register({
      id: "review.retry-pending", nameKey: "review.retry", category: "review", scope: commandScope,
      binding: null, risk: "retries-review-action", confirmation: "none", availability: retryAvailability,
      handler: () => { void owner.retryPending(); },
    });
    const removeAllowFallback = commandRegistry.register({
      id: "review.allow-fallback", nameKey: "review.fallback", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-fallback",
      availability: payload => fallbackAvailability(payload, true), handler: () => runFreshAction(proof => owner.fallback(true, proof)),
    });
    const removeWithdrawFallback = commandRegistry.register({
      id: "review.withdraw-fallback", nameKey: "review.withdrawFallback", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-fallback",
      availability: payload => fallbackAvailability(payload, false), handler: () => runFreshAction(proof => owner.fallback(false, proof)),
    });
    const removeGrantWaiver = commandRegistry.register({
      id: "review.grant-waiver", nameKey: "review.waive", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-waiver",
      availability: payload => waiverAvailability(payload, true),
      handler: payload => runFreshAction(proof => owner.waive(payload.issueId, true, payload.expectedWaiverId, proof)),
    });
    const removeRevokeWaiver = commandRegistry.register({
      id: "review.revoke-waiver", nameKey: "review.revokeWaiver", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-waiver",
      availability: payload => waiverAvailability(payload, false),
      handler: payload => runFreshAction(proof => owner.waive(payload.issueId, false, payload.expectedWaiverId, proof)),
    });
    const removeBatch = commandRegistry.register({
      id: "review.approve-batch", nameKey: "review.batch", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "required", availability: () => batchAvailability(),
      handler: () => { const current = owner.current(); batchConfirmation.current = { chosen: current.chosen, actor: current.actor.trim() }; setBatchPrompt(true); },
    });
    const removeStop = commandRegistry.register({
      id: "review.stop-batch", nameKey: "review.batchCancel", category: "review", scope: commandScope,
      binding: null, risk: "stops-review-batch", confirmation: "none", availability: stopBatchAvailability,
      handler: owner.stopBatch,
    });
    return () => { removeStop(); removeBatch(); removeRevokeWaiver(); removeGrantWaiver(); removeWithdrawFallback(); removeAllowFallback();
      removeRetry(); removeCancel(); removeCheck(); removePrepareCheck(); removeRequestChanges(); removeApprove(); };
  });
  function captureSelected() {
    const current = owner.current(), target = current.selected;
    return target ? { unitId: target.unitId, locale: target.locale, basis: target.basis,
      editSeq: current.editSeq[draftKey(target)] ?? 0 } : null;
  }
  async function readTarget(unitId: string, targetLocale: string) {
    const value = await commands.target({ ...session, unitId, locale: targetLocale });
    if (value.unitId !== unitId || value.locale !== targetLocale) throw new Error("Invalid review target identity");
    return value;
  }
  async function readSummary(fixedScope: string, after: number) {
    return commands.summaryPage({ ...session, locale, query: "", scopeId: fixedScope, afterOrdinal: after, limit: 50 });
  }

  useEffect(() => {
    setLanguages(current => current.filter(value => availableLocales.current.includes(value)));
    setAssessment(current => current?.locales.some(value => !availableLocales.current.includes(value)) ? null : current);
  }, [targetScope]);
  useLayoutEffect(() => {
    generation.current++;
    selecting.current = false; setSelectionBusy(false); setSelectionFailure(null); setSelectionIntent(null);
    setCaptureBusy(false); setCaptureFailure(null);
  }, [open, tab, locale, targetScope]);
  useLayoutEffect(() => { setComparisonIntent(null); setCompletedComparison(null); }, [open, locale, targetScope]);
  useLayoutEffect(() => { if (tab !== "review") { setComparisonIntent(null); setCompletedComparison(null); } }, [tab]);
  useLayoutEffect(() => {
    const target = owner.current().selected;
    if (handoff && target?.unitId === handoff.unitId && target.locale === handoff.locale && target.basis === handoff.basis) {
      // This exact fresh comparison was explicitly requested from the AI row.
      // A later query basis still requires the original comparison action.
      setComparisonIntent(handoff);
    }
  }, [handoff]);
  useLayoutEffect(() => {
    setWorkCursor(current => current.locale === locale ? current : { locale, offset: 0 });
  }, [locale]);
  useLayoutEffect(() => {
    setHistoryCursor(current => current.unitId === selected?.unitId && current.locale === selected?.locale
      ? current : { unitId: selected?.unitId ?? "", locale: selected?.locale ?? "", offset: 0 });
  }, [selected?.unitId, selected?.locale]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; leaveResolver.current?.(false); };
  }, []);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.includes("project") || CURRENT_SCOPES.some(scope => scopes.includes(scope))) semanticRevision.current++;
  }), [reads]);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, tab]);
  useEffect(() => {
    if (!open || !editorReturned || editorReturned.locale !== locale || editorReturned.tab !== tab || focusedReturn.current === editorReturned
      || (tab === "work" ? workBusy : summaryBusy)) return;
    focusedReturn.current = editorReturned;
    (returnFocus.current ?? heading.current)?.focus();
  }, [open, tab, locale, editorReturned, workBusy, summaryBusy, work, page]);
  useEffect(() => {
    // First entry into a language retains the existing explicit capture boundary.
    // A failed/cancelled capture needs an explicit retry, including after remount.
    if (open && tab === "review" && targetAvailable && !scopeId && captureLocale.current !== locale) {
      void captureSummary();
    }
  }, [open, tab, locale, targetAvailable, scopeId]);
  useLayoutEffect(() => {
    setAssessment(current => current?.reviewLocale !== locale ? null : current);
    if (summaryScope && summaryScope.locale !== locale) setPageAfter(0);
  }, [locale]);
  useEffect(() => {
    if (lastCompletion.current === owner.state.completionVersion) return;
    lastCompletion.current = owner.state.completionVersion;
    if (scopeId) void reads.client.invalidateQueries({ queryKey: reads.key(summaryKey(locale, scopeId, pageAfter)), exact: true });
    const target = owner.current().selected;
    if (!target || !localeAvailable(target.locale)) return;
    refreshCurrentHistory();
    void reads.client.invalidateQueries({ queryKey: reads.key(targetKey(target.unitId, target.locale)), exact: true });
  }, [owner.state.completionVersion]);
  useEffect(() => {
    if (!completedComparison || !currentFacts || !selected || pending
      || generation.current !== completedComparison.ticket || owner.state.completionVersion !== completedComparison.completionVersion
      || selected.unitId !== completedComparison.unitId || selected.locale !== completedComparison.locale || selected.basis !== completedComparison.basis) return;
    setComparisonIntent({ unitId: selected.unitId, locale: selected.locale, basis: selected.basis,
      currentBasis: currentFacts.basis, fallbackId: currentFacts.currentFallback?.fallbackId ?? null });
    setCompletedComparison(null);
  }, [completedComparison, currentFacts, selected, pending, owner.state.completionVersion]);
  useImperativeHandle(ref, () => ({
    showWork() { setEditorOrigin(null); setEditorReturned(null); setTab("work"); setOpen(true); if (open && tab === "work" && targetAvailable) void workRead.refetch(); },
    allowLeave(current: () => boolean = () => true) {
      leaveProof.current = current;
      const currentOwner = owner.current();
      if (owner.inFlight() || currentOwner.batchRunning || currentOwner.pending) { setOpen(true); setNotice("unknown"); return Promise.resolve(false); }
      if (!Object.values(currentOwner.drafts).some(value => value.length > 0) && Object.keys(currentOwner.chosen).length === 0
        && !currentOwner.checkReview && currentOwner.checkConsent.length === 0 && currentOwner.advisoryChecks.length === 0 && !owner.semantic.dirty()) return Promise.resolve(true);
      setOpen(true); setLeavePrompt(true);
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
    allowNavigate() { if (owner.current().pending?.kind === "finding" || owner.semantic.reserved()) { setOpen(true); setNotice("unknown"); return Promise.resolve(false); } generation.current++; selecting.current = false; setSelectionBusy(false); setCaptureBusy(false); return Promise.resolve(true); },
  }));

  async function captureSummary(after = 0) {
    if (!currentLocale(locale) || reads.retired) return;
    const ticket = ++generation.current;
    const revision = semanticRevision.current;
    selecting.current = false; setSelectionBusy(false);
    captureLocale.current = locale;
    setCaptureBusy(true); setCaptureFailure(null);
    try {
      // Null allocates a Host capture slot and must never be a query function.
      const value = await commands.summaryPage({ ...session, locale, query: "", scopeId: null, afterOrdinal: after, limit: 50 });
      if (alive.current && !reads.retired && generation.current === ticket && currentLocale(locale)) {
        // Register dependencies before publishing the seed. A semantic change
        // during capture can only reread this fixed scope, never allocate another.
        const query = reads.client.getQueryCache().build(reads.client, {
          queryKey: reads.key(summaryKey(locale, value.scopeId, after)), meta: { scopes: CURRENT_SCOPES },
          queryFn: () => readSummary(value.scopeId, after),
        });
        query.setData(value);
        if (semanticRevision.current !== revision) query.invalidate();
        setPageAfter(after); setSummaryScope({ locale, scopeId: value.scopeId });
      }
    } catch (error) {
      if (alive.current && !reads.retired && generation.current === ticket && currentLocale(locale)) setCaptureFailure(errorReason(error));
    } finally { if (alive.current && generation.current === ticket) setCaptureBusy(false); }
  }
  function loadPage(after: number) {
    if (!currentLocale(locale) || !scopeId) return;
    void reads.client.invalidateQueries({ queryKey: reads.key(summaryKey(locale, scopeId, after)), exact: true, refetchType: "none" });
    setPageAfter(after);
  }
  function assess() {
    if (languages.length === 0 || languages.some(value => !localeAvailable(value))) return;
    if (eligibilityActive) { void eligibilityRead.refetch(); return; }
    const locales = [...languages];
    // A newly confirmed selection must read current evidence even if this
    // language set was assessed earlier in the same project session.
    void reads.client.invalidateQueries({ queryKey: reads.key(["review-eligibility", locales]),
      exact: true, refetchType: "none" });
    setAssessment({ ...session, reviewLocale: locale, locales });
  }
  async function selectUnit(unitId: string) {
    if (!currentLocale(locale) || reads.retired) return;
    const capture = captureSelected();
    const origin = tab === "work" ? editorReturn(unitId) : null;
    const ticket = ++generation.current;
    setCaptureBusy(false);
    selecting.current = true; setSelectionBusy(true); setSelectionFailure(null); setSelectionIntent({ unitId, locale });
    const queryKey = reads.key(targetKey(unitId, locale));
    try {
      // Every explicit pick waits for this fresh read; cached evidence is not
      // consent to capture a target again, even when its identity is unchanged.
      await reads.client.cancelQueries({ queryKey, exact: true });
      if (!alive.current || reads.retired || generation.current !== ticket || !currentLocale(locale)) return;
      await reads.client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
      const value = await reads.client.fetchQuery({ queryKey, meta: { scopes: CURRENT_SCOPES }, queryFn: async ({ signal }) => {
        const result = await readTarget(unitId, locale);
        if (signal.aborted) throw new Error("Read cancelled");
        return result;
      } });
      const state = reads.client.getQueryState<ReviewTarget>(queryKey);
      if (alive.current && !reads.retired && generation.current === ticket && currentLocale(locale)) {
        if (state?.status !== "success" || state.fetchStatus !== "idle" || state.error !== null || state.isInvalidated) throw new Error("Review evidence changed during capture");
        const now = owner.current();
        if (capture?.unitId === unitId && capture.locale === locale
          && (now.editSeq[draftKey(capture)] ?? 0) !== capture.editSeq) owner.observeProjection(value, capture);
        else setSelected(value);
        const selectedNow = owner.current().selected;
        setComparisonIntent(selectedNow ? { unitId: selectedNow.unitId, locale: selectedNow.locale, basis: selectedNow.basis,
          currentBasis: value.basis, fallbackId: value.currentFallback?.fallbackId ?? null } : null);
        setEditorOrigin(origin); setEditorReturned(null);
        setHistoryCursor({ unitId, locale, offset: 0 }); setTab("review");
      }
    } catch (error) {
      if (alive.current && !reads.retired && generation.current === ticket && currentLocale(locale)) setSelectionFailure(errorReason(error));
    } finally { if (alive.current && generation.current === ticket) { selecting.current = false; setSelectionBusy(false); } }
  }
  function loadHistory(offset: number) {
    if (selected && currentLocale(selected.locale)) setHistoryCursor({ unitId: selected.unitId, locale: selected.locale, offset });
  }
  function refreshCurrentHistory() {
    if (!selected || !localeAvailable(selected.locale)) return;
    if (historyActive && historyOffset === 0) { void historyRead.refetch(); return; }
    // The cached first page may have staleTime Infinity. Mark it stale before
    // changing the key or showing a hidden panel; its next observer must fetch.
    void reads.client.invalidateQueries({ queryKey: reads.key(["review-history", selected.unitId, selected.locale, 0, 20]),
      exact: true, refetchType: "none" });
    if (historyOffset !== 0) setHistoryCursor({ unitId: selected.unitId, locale: selected.locale, offset: 0 });
  }
  function refresh() {
    if (!currentLocale(locale)) return;
    refreshCurrentHistory();
    setSelectionFailure(null);
    void captureSummary(pageAfter);
    if (targetActive) void viewCurrentEvidence();
  }
  async function viewCurrentEvidence() {
    const target = owner.current().selected, ticket = generation.current;
    if (!targetActive || !target) return;
    setComparisonIntent(null);
    await targetRead.refetch();
    const latest = currentTarget(), now = owner.current().selected;
    if (alive.current && generation.current === ticket && latest && now && sameTargetBasis(now, target)) {
      setComparisonIntent({ unitId: target.unitId, locale: target.locale, basis: target.basis,
        currentBasis: latest.basis, fallbackId: latest.currentFallback?.fallbackId ?? null });
    }
  }
  function adoptCurrent() {
    const capture = captureSelected(), value = currentTarget();
    if (!capture || !value || !comparisonIntent || owner.inFlight() || owner.current().pending
      || capture.unitId !== comparisonIntent.unitId || capture.locale !== comparisonIntent.locale || capture.basis !== comparisonIntent.basis
      || value.basis !== comparisonIntent.currentBasis || (value.currentFallback?.fallbackId ?? null) !== comparisonIntent.fallbackId) return;
    owner.observeProjection(value, capture);
    owner.adoptCurrent();
  }

  function requestClose() {
    setOpen(false);
  }
  function finishLeave(discard: boolean) {
    if (discard && leaveProof.current && !leaveProof.current()) { setLeavePrompt(false); leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; leaveProof.current = null; return; }
    setLeavePrompt(false);
    if (discard && owner.semantic.reserved()) { leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; return; }
    if (discard) { owner.clear(); setOpen(false); }
    leaveResolver.current?.(discard); leaveResolver.current = null; leaveProof.current = null;
  }
  function queueReason(code: string) { return t(reviewReasonKey(code)); }
  function eligibilityReasonLabel(value: EligibilityReason) {
    if (value.code === "source-fallback") return t("review.fallbackActive");
    if (value.code === "issue-waiver") return t("review.waived");
    return queueReason(value.code);
  }
  function ruleStatusLabel(status: string) {
    return t(status === "passed" ? "review.passed" : status === "not-applicable" ? "review.notApplicable"
      : status === "findings" ? "review.findings" : status === "failed" ? "review.checkFailed"
      : status === "cancelled" ? "review.checkCancelled" : status === "unknown" ? "review.checkUnknown" : "review.qaUnavailable");
  }
  function ruleReasonLabel(status: string) {
    return t(status === "not-applicable" ? "review.noSelectedTranslationReason" : status === "failed" ? "review.checkFailedHelp"
      : status === "cancelled" ? "review.checkCancelledHelp" : status === "unknown" ? "review.checkUnknownHelp" : "review.incompleteCoverageHelp");
  }

  return <>
    <WorkbenchPanel open={open} title={t("review.title")} description={t("review.description")} className="source-dialog review-dialog" onBack={requestClose} backDisabled={disabled}>
        {onReturnToAi ? <><p>{t("ai.reviewHandoff.currentOnly")}</p><button className="secondary-button" disabled={disabled || owner.inFlight() || busyMutation || batchRunning || !!pending}
          onClick={() => { void onReturnToAi(); }}>{t("ai.workspace.returnToWork")}</button></> : null}
        {project.metadata.targetLocales.length === 0 ? <p>{t("review.noLocale")}</p> : null}
        {project.metadata.targetLocales.length > 0 || retainedReview ? <>
          <div className="review-header-fields">
            <label>{t("review.targetLocale")}<select value={locale} disabled={disabled || busyMutation} onChange={event => { setEditorOrigin(null); setEditorReturned(null); setLocale(event.target.value); setSelected(null); }}>
              {targetRemoved ? <option value={locale}>{locale}</option> : null}
              {project.metadata.targetLocales.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>
            <label>{t("review.reviewer")}<input value={actor} onChange={event => setActor(event.target.value)} maxLength={128} autoComplete="name" /></label>
          </div>
          <div className="form-actions" role="tablist" aria-label={t("review.title")}>
            {(["review", "work", "eligibility"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "primary-button" : "secondary-button"} onClick={() => { setEditorOrigin(null); setEditorReturned(null); setTab(value); }}>
              {t(value === "review" ? "review.reviewTab" : value === "work" ? "review.workTab" : "review.eligibilityTab")}
            </button>)}
          </div>
          {editorReturned?.locale === locale && editorReturned.tab === tab ? <><p role="status">{t("review.diagnosticNavigation.returned")}</p>
            {tab === "work" && work && !workBusy && !workFailure && !work.items.some(item => item.unitId === editorReturned.unitId)
              ? <p role="status">{t("review.diagnosticNavigation.returnedMissing")}</p> : null}</> : null}
          {removedLocale ? <p role="status">{t("review.removedTarget", { locale: removedLocale })}</p> : null}
          {notice ? <div role="status" className="execution-feedback">{notice === "saved" ? t("review.saved") : notice === "unknown" ? t("review.unknown") : notice === "conflict" ? t("review.conflict") : notice === "checkFailed" ? t("review.checkFailedHelp") : notice === "checkCancelled" ? t("review.checkCancelledHelp") : notice === "checkUnknown" ? t("review.checkUnknownHelp") : notice === "cancelRequested" ? t("review.cancelRequested") : reason === "reviewer-required" ? t("review.reviewerRequired") : reason === "reason-required" ? t("review.reasonRequired") : reason === "diagnostic-stale" ? t("review.diagnosticNavigation.stale") : reason === "editor-unavailable" ? t("review.editorUnavailable") : t("review.error", { reason })}</div> : null}
          {pending && !owner.inFlight() && notice !== "unknown" ? <p role="status">{t("review.unknown")}</p> : null}
          {notice ? <CommandFailureDetails failure={reasonValue} /> : null}
          {pending?.kind === "finding" ? <section aria-label={t("review.advisoryFindings.originalAction")}>
            <h4>{t("review.advisoryFindings.originalAction")}</h4><p>{t("review.advisoryFindings.originalHelp")}</p>
            <p>{pending.request.actor}: {pending.request.reason}</p>
            <p>{t(pending.request.disposition === "rejected" ? "review.advisoryFindings.reject" : pending.request.disposition === "restored" ? "review.advisoryFindings.restore" : "review.advisoryFindings.repairRecorded")}</p>
            <details><summary>{t("review.advisoryFindings.basis")}</summary><p>{pending.request.actionId}</p><p>{pending.request.runId}</p><p>{pending.request.issueId}</p><p>{pending.basisEvidence.sourceRevisionId}</p></details>
          </section> : null}
          {pending ? <button className="secondary-button" disabled={!retryAvailability().enabled} onClick={() => commandRegistry.dispatch("review.retry-pending", commandScope)}>{t("review.retry")}</button> : null}
          {batchStatus ? <p role="status">{t("review.batchResult", { ...batchStatus, defaultValue: "{{applied}} recorded, {{conflicted}} changed, {{failed}} failed." })}</p> : null}
          {batchStatus?.notStarted ? <p role="status">{t("review.batchRemaining", { count: batchStatus.notStarted })}</p> : null}
          {batchRunning ? <button className="secondary-button" disabled={!stopBatchAvailability().enabled} onClick={() => commandRegistry.dispatch("review.stop-batch", commandScope)}>{t("review.batchCancel")}</button> : null}
          {tab === "review" ? <AiSemanticReview project={project} active={open && tab === "review" && !leavePrompt} disabled={disabled || !!pending || busyMutation || batchRunning} currentTarget={currentTarget} onOpenConnections={onOpenConnections} /> : null}
          {tab === "review" ? <div className="review-columns">
            <section aria-label={t("review.reviewTab")} aria-busy={summaryBusy}>
              <div className="form-actions"><button className="secondary-button" disabled={busy || summaryBusy || !targetAvailable} onClick={refresh}>{t("review.refresh")}</button>
                <button className="secondary-button" disabled={!batchAvailability().enabled} onClick={() => commandRegistry.dispatch("review.approve-batch", commandScope)}>{t("review.batch")} ({chosenCount})</button></div>
              {summaryFailure && !summaryBusy ? <div role="alert">{t("review.currentUnavailable")}
                <CommandFailureDetails failure={summaryFailure} />
                {scopeId && !captureFailure ? <button className="secondary-button" onClick={() => void summaryRead.refetch()}>{t("review.currentRetry")}</button> : null}
              </div> : null}
              {summaryBusy ? <p role="status">{t("review.currentLoading")}</p> : null}
              {Object.keys(chosen).length >= MAX_BATCH ? <p role="status">{t("review.batchLimit", { count: MAX_BATCH })}</p> : null}
              {!page ? !summaryBusy && !summaryFailure ? <p>{t("review.noSource")}</p> : null : <><div className="review-list">{page.rows.map(target => <div className="review-list-row" key={target.unitId}>
                <input type="checkbox" aria-label={`${t("review.batch")}: ${target.nativeKey}`} checked={!!chosen[draftKey(target)]} disabled={busy || summaryBusy || !targetAvailable || !target.selectionId || (!chosen[draftKey(target)] && chosenCount >= MAX_BATCH)}
                  onChange={event => owner.toggleChosen(target, event.target.checked)} />
                <button ref={editorReturned?.unitId === target.unitId ? returnFocus : undefined} className="text-button" aria-current={selected?.unitId === target.unitId ? "true" : undefined} disabled={busy || !targetAvailable} onClick={() => void selectUnit(target.unitId)}>{target.nativeKey}</button>
              </div>)}</div></>}
              {page || pageAfter > 0 ? <div className="form-actions"><button className="secondary-button" disabled={busy || summaryBusy || !targetAvailable || pageAfter === 0} onClick={() => loadPage(0)}>{t("review.previousPage")}</button><button className="secondary-button" disabled={busy || summaryBusy || !targetAvailable || !page || page.nextOrdinal === null} onClick={() => { if (page?.nextOrdinal != null) loadPage(page.nextOrdinal); }}>{t("review.nextPage")}</button></div> : null}
            </section>
            <section aria-label={t("review.scope")} aria-busy={selectionBusy || (targetActive && targetRead.isFetching)}>
              {targetFailure && !selectionBusy && !targetRead.isFetching ? <div role="alert">{t("review.currentUnavailable")}
                <CommandFailureDetails failure={targetFailure} />
                {selectionFailure && selectionIntent && currentLocale(selectionIntent.locale)
                  ? <button className="secondary-button" disabled={busy} onClick={() => void selectUnit(selectionIntent.unitId)}>{t("review.currentRetry")}</button>
                  : targetActive ? <button className="secondary-button" onClick={() => void targetRead.refetch()}>{t("review.currentRetry")}</button> : null}
              </div> : null}
              {selectionBusy || (targetActive && targetRead.isFetching) ? <p role="status">{t("review.currentLoading")}</p> : null}
              {!selected || !displayTarget ? <p>{t("review.selectEntry")}</p> : <>
                {selectedStale || fallbackIdentityChanged ? <strong>{t("review.earlierContent")}</strong> : null}
                <h3>{displayTarget.nativeKey}</h3><p><strong>{t("review.source")}</strong> {displayTarget.sourceText}</p>
                <p><strong>{t("review.translation")}</strong> {displayTarget.translationText ?? t("review.missingTranslation")}</p>
                <button className="text-button" disabled={!targetAvailable} onClick={() => void openEditor(displayTarget)}>{t("review.openTranslation")}</button>
                <p>{displayTarget.currentDecision?.kind === "approve" ? t("review.currentApproval") : displayTarget.currentDecision?.kind === "request-changes" ? t("review.changesRequested") : t("review.approvalMissing")}</p>
                {displayTarget.currentFallback ? <p>{t("review.fallbackActive")}</p> : null}
                {selectedStale || fallbackIdentityChanged ? <div role="status" className="execution-feedback">
                  <p>{t("review.changedReasonBasis")}</p>
                  {comparisonVisible && currentFacts ? <>
                    <div><strong>{t("review.currentContent")}</strong><p>{currentFacts.sourceText}</p><p>{currentFacts.translationText ?? t("review.missingTranslation")}</p></div>
                    <button className="secondary-button" disabled={busy || !!pending || !targetAvailable || owner.inFlight() || !currentTarget()}
                      onClick={adoptCurrent}>{t("review.useCurrentKeepReason")}</button>
                  </> : <button className="secondary-button" disabled={!targetAvailable} onClick={viewCurrentEvidence}>{t("review.viewCurrentEvidence")}</button>}
                </div> : null}
                <label>{t("review.reason")}<textarea value={drafts[draftKey(selected)] ?? ""} onChange={event => owner.editReason(selected, event.target.value)} maxLength={4096} /></label>
                <div className="form-actions"><button className="primary-button" disabled={!decisionAvailability().enabled} onClick={() => commandRegistry.dispatch("review.approve", commandScope)}>{t("review.approve")}</button>
                  <button className="secondary-button" disabled={!decisionAvailability().enabled} onClick={() => commandRegistry.dispatch("review.request-changes", commandScope)}>{t("review.requestChanges")}</button>
                  {!selected.selectionId && fallbackPayload ? <button className="secondary-button" disabled={!fallbackAvailability(fallbackPayload, !selected.currentFallback).enabled} onClick={() => commandRegistry.dispatch(selected.currentFallback ? "review.withdraw-fallback" : "review.allow-fallback", commandScope, fallbackPayload)}>{t(selected.currentFallback ? "review.withdrawFallback" : "review.fallback")}</button> : null}</div>
                <p>{t("review.formatChecksRequired")}</p>
                <TextReviewSelections value={advisoryChecks} active={open} scopeKey={JSON.stringify([session, selected.unitId, selected.locale])}
                  disabled={busy || pending !== null || disabled} onOpenExtensions={onOpenExtensions}
                  onSnapshotRevision={owner.observeSettingsRevision} onChange={owner.setAdvisoryChecks} />
                {currentCheckReview ? currentCheckReview.view.checkers.map(slot => <fieldset key={checkerIdentity(slot.checker)}>
                  <legend>{t("review.checkerConsentScope", { plugin: `${slot.checker.provider.plugin.publisher}/${slot.checker.provider.plugin.id} ${slot.checker.provider.plugin.version}`, profile: slot.checker.profile.id })}</legend>
                  <ReviewCheckerDetails view={slot.plugin} />
                  <label className="source-check"><input type="checkbox" checked={checkConsent.includes(slotConsentKey(slot))} disabled={busy || disabled}
                    onChange={event => owner.setCheckerConsent(slot.attemptId, slot.inputDigest, event.target.checked)} />{t("review.checkConsent")}</label>
                </fieldset>) : null}
                <div className="form-actions">{currentCheckReview ? <button className="secondary-button" disabled={!checkAvailability().enabled || !checkersConfirmed} onClick={() => commandRegistry.dispatch("review.run-checks", commandScope)}>{busy ? t("review.checking") : t("review.check")}</button>
                  : <button className="secondary-button" disabled={!prepareCheckAvailability().enabled} onClick={() => commandRegistry.dispatch("review.prepare-checks", commandScope)}>{t("review.prepareCheck")}</button>}{activeCheckId || pending?.kind === "check" ? <button className="secondary-button" disabled={!cancelAvailability().enabled} onClick={() => commandRegistry.dispatch("review.cancel-checks", commandScope)}>{t("review.cancelCheck")}</button> : null}</div>
                <h4>{t("review.qaCurrent")}</h4>{!displayedCheck || !sameTargetBasis(displayTarget, checkTarget) || displayedCheck.basis !== checkTarget.basis ? <p>{t("review.qaMissing")}</p> : displayedCheck.rules.map(rule => <div key={ruleIdentity(rule.key)} className="review-rule"><strong>{capturedRuleLabel(t, displayedCheck, rule)}</strong> — {ruleStatusLabel(rule.status)}
                  {rule.reason ? <p>{ruleReasonLabel(rule.status)}</p> : null}
                  {rule.findings.map(finding => {
                    const waiver = checkTarget.currentWaivers.find(value => value.issueId === finding.issueId);
                    const payload = waiverPayload(selected, finding.issueId, waiver?.waiverId ?? null);
                    return <div key={finding.issueId}><p>{reviewFindingLabel(t, finding.rule, finding.code)}{finding.detail ? `: ${finding.detail}` : ""}</p><ReviewDiagnosticDetails run={displayedCheck} rule={rule} code={finding.code}
                      onLocate={currentTarget() && currentDiagnosticRun(displayTarget, displayedCheck) ? diagnostic => { void openEditor(displayTarget, { runId: displayedCheck.runId, source: { purpose: "qa" }, diagnostic }); } : undefined} />
                      {waiver ? <><p>{t("review.waived")}</p><button className="text-button" disabled={!waiverAvailability(payload, false).enabled} onClick={() => commandRegistry.dispatch("review.revoke-waiver", commandScope, payload)}>{t("review.revokeWaiver")}</button></> : finding.waivable ? <button className="text-button" disabled={!waiverAvailability(payload, true).enabled} onClick={() => commandRegistry.dispatch("review.grant-waiver", commandScope, payload)}>{t("review.waive")}</button> : null}</div>;
                  })}
                </div>)}
                <ReviewFindings project={project} target={displayTarget} active={open && tab === "review" && targetAvailable}
                  available={() => reviewActionAvailability(false)} currentTarget={currentTarget} freshReadProof={freshReadProof}
                  onOpenTranslation={() => openEditor(displayTarget)} onLocateDiagnostic={(target, intent, offset) => openEditor(target, intent, offset)} />
                <details><summary>{t("review.history")}</summary>
                  {historyLoading ? <p role="status">{t("review.historyLoading")}</p> : null}
                  {historyFailure && !historyRead.isFetching ? <div role="alert">{t("review.historyUnavailable")}
                    <CommandFailureDetails failure={historyFailure} />
                    <button className="secondary-button" disabled={historyBusy} onClick={() => void historyRead.refetch()}>{t("review.historyRetry")}</button>
                  </div> : null}
                  {history && !historyFailure && history.decisions.length + history.checks.length + history.waivers.length + history.fallbacks.length === 0 ? <p>{t("review.historyEmpty")}</p> : null}
                  {history?.decisions.map(item => <p key={item.decisionId}>{item.createdAt} · {item.actor} · {t(item.kind === "approve" ? "review.currentApproval" : "review.changesRequested")}{item.decisionId === displayTarget.currentDecision?.decisionId ? "" : ` · ${t("review.earlier")}`}{item.reason ? ` · ${item.reason}` : ""}</p>)}
                  {history?.checks.map(item => <div key={item.runId} className="review-history-check"><p>{item.createdAt} · {t("review.qaRun")} · {item.validatorVersion}{item.runId === displayTarget.currentCheck?.runId ? "" : ` · ${t("review.earlier")}`}</p>
                    <ul>{item.rules.map(rule => <li key={ruleIdentity(rule.key)}><strong>{capturedRuleLabel(t, item, rule)}</strong> — {ruleStatusLabel(rule.status)}
                      {rule.reason ? ` · ${ruleReasonLabel(rule.status)}` : ""}
                      {rule.findings.length > 0 ? <ul>{rule.findings.map(finding => <li key={finding.issueId}>{reviewFindingLabel(t, finding.rule, finding.code)}
                        {finding.detail ? <p>{finding.detail}</p> : null}<ReviewDiagnosticDetails run={item} rule={rule} code={finding.code} /></li>)}</ul> : null}
                    </li>)}</ul>
                  </div>)}
                  {history?.waivers.map(item => <p key={item.waiverId}>{item.createdAt} · {item.actor} · {t(item.grant ? "review.waived" : "review.revokeWaiver")}{displayTarget.currentWaivers.some(waiver => waiver.waiverId === item.waiverId) ? "" : ` · ${t("review.earlier")}`}{item.reason ? ` · ${item.reason}` : ""}</p>)}
                  {history?.fallbacks.map(item => <p key={item.fallbackId}>{item.createdAt} · {item.actor} · {t(item.allow ? "review.fallbackActive" : "review.withdrawFallback")}{item.fallbackId === displayTarget.currentFallback?.fallbackId ? "" : ` · ${t("review.earlier")}`}{item.reason ? ` · ${item.reason}` : ""}</p>)}
                  <div className="form-actions"><button className="secondary-button" disabled={busy || historyBusy || !targetAvailable || historyOffset === 0} onClick={() => loadHistory(0)}>{t("review.previousPage")}</button><button className="secondary-button" disabled={busy || historyBusy || !targetAvailable || !history || history.nextOffset === null} onClick={() => loadHistory(history!.nextOffset!)}>{t("review.historyMore")}</button></div>
                </details>
              </>}
            </section>
          </div> : null}
          {tab === "work" ? <section><div className="form-actions"><button className="secondary-button" disabled={busy || workBusy || !targetAvailable} onClick={() => void workRead.refetch()}>{t("review.refresh")}</button></div>
            {workLoading ? <p role="status">{t("review.workLoading")}</p> : null}
            {workFailure && !workRead.isFetching ? <div role="alert">{t("review.error", { reason: failureReason(workFailure) ?? "failed" })}<CommandFailureDetails failure={workFailure} /></div> : null}
            {work ? <><p>{t("review.workCount", { count: work.total })}</p>{work.items.length === 0 ? <p>{t("review.workEmpty")}</p> : work.items.map(item => <div key={item.unitId} className="review-work-item"><button ref={editorReturned?.unitId === item.unitId ? returnFocus : undefined} className="text-button" disabled={!targetAvailable} onClick={() => void selectUnit(item.unitId)}>{item.nativeKey}</button><ul>{[...new Set(item.reasons.map(queueReason))].map(value => <li key={value}>{value}</li>)}</ul></div>)}</> : targetAvailable && !workLoading && !workFailure ? <p>{t("review.selectEntry")}</p> : null}
            {work || workOffset > 0 ? <div className="form-actions"><button className="secondary-button" disabled={busy || workBusy || !targetAvailable || workOffset === 0} onClick={() => setWorkCursor({ locale, offset: 0 })}>{t("review.previousPage")}</button><button className="secondary-button" disabled={busy || workBusy || !targetAvailable || !work || work.nextOffset === null} onClick={() => { if (work?.nextOffset != null) setWorkCursor({ locale, offset: work.nextOffset }); }}>{t("review.nextPage")}</button></div> : null}
          </section> : null}
          {tab === "eligibility" ? <section><p>{t("review.policy")}</p><p>{t("review.buildWarning")}</p><fieldset><legend>{t("review.chooseLanguages")}</legend>{project.metadata.targetLocales.map(value => <label key={value}><input type="checkbox" checked={languages.includes(value)} onChange={event => { setAssessment(null); setLanguages(previous => event.target.checked ? [...previous, value] : previous.filter(item => item !== value)); }} />{value}</label>)}</fieldset>
            <button className="primary-button" disabled={busy || eligibilityBusy || languages.length === 0 || languages.some(value => !project.metadata.targetLocales.includes(value))} onClick={assess}>{t("review.assess")}</button>
            {eligibilityBusy ? <p role="status">{t("review.eligibilityLoading")}</p> : null}
            {eligibilityFailure && !eligibilityBusy ? <div role="alert">{t("review.eligibilityUnavailable")}
              <CommandFailureDetails failure={eligibilityFailure} />
              <button className="secondary-button" onClick={() => void eligibilityRead.refetch()}>{t("review.eligibilityRetry")}</button>
            </div> : null}
            {!assessmentCurrent ? <p>{t(languages.length === 0 ? "review.eligibilityChooseLanguages" : "review.eligibilityNotAssessed")}</p> : null}
            {eligibility ? <><h3>{t(eligibility.ready ? "review.ready" : "review.blocked")}</h3>{eligibility.locales.map(value => <div key={value.locale} className="review-eligibility"><h4>{value.locale}: {t(value.ready ? "review.ready" : "review.blocked")}</h4>
              <p>{t("review.blockers")}: {value.blockerCount}; {t("review.exceptions")}: {value.exceptionCount}</p>
              <ul>{value.blockers.map((item, index) => <li key={`${index}:${item.unitId}:${item.code}`}>{item.nativeKey}: {eligibilityReasonLabel(item)}</li>)}</ul>
              <ul>{value.exceptions.map((item, index) => <li key={`${index}:${item.unitId}:${item.code}`}>{item.nativeKey}: {eligibilityReasonLabel(item)}</li>)}</ul>
              {value.blockerCount > value.blockers.length || value.exceptionCount > value.exceptions.length ? <p>{t("review.moreReasons")}</p> : null}</div>)}</> : null}
          </section> : null}
        </> : null}
      </WorkbenchPanel>
    <Dialog.Root open={batchPrompt} onOpenChange={value => { if (!value) closeBatchPrompt(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog"><Dialog.Title>{t("review.batchConfirm")}</Dialog.Title><Dialog.Description>{t("review.batchCount", { count: Object.keys(batchConfirmation.current?.chosen ?? {}).length })}</Dialog.Description><ul className="review-batch-list">{Object.values(batchConfirmation.current?.chosen ?? {}).map(item => <li key={draftKey(item)}>{item.locale}: {item.nativeKey}</li>)}</ul>{invalidChosenLocale ? <p>{t("review.removedTarget", { locale: invalidChosenLocale })}</p> : null}<div className="form-actions"><button className="secondary-button" onClick={closeBatchPrompt}>{t("review.stay")}</button><button className="primary-button" disabled={!batchAvailability(true).enabled} onClick={confirmBatch}>{t("review.batchStart")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={leavePrompt} onOpenChange={value => { if (!value && !busy) finishLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}><Dialog.Title>{t("review.leaveTitle")}</Dialog.Title><Dialog.Description>{t("review.leaveHelp")}</Dialog.Description><div className="form-actions"><button className="secondary-button" onClick={() => finishLeave(false)}>{t("review.stay")}</button><button className="primary-button" onClick={() => finishLeave(true)}>{t("review.discard")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
