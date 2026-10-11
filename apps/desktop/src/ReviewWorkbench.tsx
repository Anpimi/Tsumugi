import { reviewReasonKey } from "./reviewLabels";
import { commandFailure, failureReason, CommandFailureDetails } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import { reviewCommands as commands, type Eligibility, type EligibilityReason,
  type ReviewHistoryPage, type ReviewSummaryPage, type WorkPage } from "./reviewCommands";
import { reviewDraftKey, useReviewDraftSession } from "./ReviewDraftSession";
import { useWorkbenchCommands, type ReviewFallbackCommandPayload, type ReviewWaiverCommandPayload } from "./workbenchCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import type { ChangeScope } from "./sessionReads";

type Tab = "review" | "work" | "eligibility";
const MAX_BATCH = 100;
export interface ReviewHandle { allowLeave: () => Promise<boolean>; allowNavigate: () => Promise<boolean>; showWork: () => void }

const errorReason = commandFailure;
const draftKey = reviewDraftKey;
const HISTORY_FIRST_SCOPES: ChangeScope[] = ["source", "translation", "resources", "review"];
// A review change moves a later history page back to zero before it is read.
// Only the first-page query listens to review invalidation, so the old offset
// cannot refetch while that cursor transition is committing.
const HISTORY_LATER_SCOPES: ChangeScope[] = ["source", "translation", "resources"];

export function ReviewWorkbench({ project, disabled, onOpenTranslation, ref }: {
  project: ProjectView; disabled: boolean; onOpenTranslation: (target: EditorTarget, locale: string) => boolean;
  ref?: Ref<ReviewHandle>;
}) {
  const { t } = useTranslation();
  const session = executionContext(project);
  const owner = useReviewDraftSession();
  const reads = useSessionReads();
  const commandRegistry = useWorkbenchCommands();
  const { locale, actor, drafts, selected, projection, chosen, pending, notice, reasonValue,
    busyMutation, activeCheckId, batchRunning, batchStatus } = owner.state;
  const setLocale = owner.setLocale;
  const setActor = owner.setActor;
  const setSelected = owner.setSelected;
  const setNotice = owner.setNotice;
  const setReason = owner.setReason;
  const decide = owner.decide;
  const check = owner.check;
  const cancelCheck = owner.cancelCheck;
  const [open, setOpen] = useWorkbenchView("review");
  const [tab, setTab] = useState<Tab>("review");
  const [page, setPage] = useState<ReviewSummaryPage | null>(null);
  const [pageAfter, setPageAfter] = useState(0);
  const [historyCursor, setHistoryCursor] = useState({ unitId: "", locale: "", offset: 0 });
  const [workCursor, setWorkCursor] = useState({ locale, offset: 0 });
  const [languages, setLanguages] = useState<string[]>(project.metadata.targetLocales);
  const [assessment, setAssessment] = useState<{ projectId: string; sessionToken: string; reviewLocale: string; locales: string[] } | null>(null);
  const reason = failureReason(reasonValue) ?? "";
  const [readBusy, setReadBusy] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [batchPrompt, setBatchPrompt] = useState(false);
  // This modal capture also blocks another dispatch before its open state commits.
  const batchConfirmation = useRef<{ chosen: typeof chosen; actor: string } | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const leaveResolver = useRef<((allowed: boolean) => void) | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const hasDraft = Object.values(drafts).some(value => value.length > 0);
  const lastCompletion = useRef(owner.state.completionVersion);
  const previousLocale = useRef(locale);
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
  const busy = readBusy || busyMutation;
  const chosenCount = Object.keys(chosen).length;
  const invalidChosenLocale = Object.values(chosen).find(value => !project.metadata.targetLocales.includes(value.locale))?.locale;
  const invalidDraftKey = Object.keys(drafts).find(key => drafts[key].length > 0
    && !project.metadata.targetLocales.includes(key.slice(0, key.indexOf(":"))));
  const invalidDraftLocale = invalidDraftKey?.slice(0, invalidDraftKey.indexOf(":"));
  const invalidPendingLocale = pending && !project.metadata.targetLocales.includes(pending.request.locale) ? pending.request.locale : null;
  const removedLocale = targetRemoved ? locale : invalidChosenLocale ?? invalidDraftLocale ?? invalidPendingLocale;
  const retainedReview = hasDraft || chosenCount > 0 || !!pending || owner.inFlight() || batchRunning;
  const displayTarget = selected && projection?.unitId === selected.unitId && projection.locale === selected.locale
    ? projection : selected;
  const selectedStale = !!selected && !!displayTarget && selected.basis !== displayTarget.basis;
  const fallbackIdentityChanged = !!selected && !!displayTarget && !selected.selectionId
    && (selected.currentFallback?.fallbackId ?? null) !== (displayTarget.currentFallback?.fallbackId ?? null);
  const commandScope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  function reviewActionAvailability(requireSelection: boolean) {
    if (!open || tab !== "review" || leavePrompt || batchPrompt || batchConfirmation.current) return { enabled: false, reason: "hidden" as const };
    if (busy || owner.inFlight()) return { enabled: false, reason: "busy" as const };
    const current = owner.current();
    if (current.pending) return { enabled: false, reason: "pending-action" as const };
    const target = current.selected;
    const projection = current.projection && current.projection.unitId === target?.unitId && current.projection.locale === target?.locale
      ? current.projection : target;
    if (!target || !targetAvailable || target.basis !== projection?.basis
      || (requireSelection && (!target.selectionId || !current.actor.trim()))) {
      return { enabled: false, reason: "unavailable" as const };
    }
    return { enabled: true };
  }
  const decisionAvailability = () => reviewActionAvailability(true);
  const checkAvailability = () => reviewActionAvailability(false);
  function cancelAvailability() {
    if (!open || tab !== "review" || leavePrompt || batchPrompt || batchConfirmation.current) return { enabled: false, reason: "hidden" as const };
    const current = owner.current();
    if (!current.selected || !current.activeCheckId) return { enabled: false, reason: "unavailable" as const };
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
    const latest = current.projection?.unitId === target.unitId && current.projection.locale === target.locale ? current.projection : target;
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
    const target = current.projection?.unitId === selected.unitId && current.projection.locale === selected.locale ? current.projection : selected;
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
      handler: () => { void decide("approve"); },
    });
    const removeRequestChanges = commandRegistry.register({
      id: "review.request-changes", nameKey: "review.requestChanges", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", availability: decisionAvailability,
      handler: () => { void decide("request-changes"); },
    });
    const removeCheck = commandRegistry.register({
      id: "review.run-checks", nameKey: "review.check", category: "review", scope: commandScope,
      binding: null, risk: "runs-review-checks", confirmation: "none", availability: checkAvailability,
      handler: () => { void check(); },
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
      availability: payload => fallbackAvailability(payload, true), handler: () => { void owner.fallback(true); },
    });
    const removeWithdrawFallback = commandRegistry.register({
      id: "review.withdraw-fallback", nameKey: "review.withdrawFallback", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-fallback",
      availability: payload => fallbackAvailability(payload, false), handler: () => { void owner.fallback(false); },
    });
    const removeGrantWaiver = commandRegistry.register({
      id: "review.grant-waiver", nameKey: "review.waive", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-waiver",
      availability: payload => waiverAvailability(payload, true),
      handler: payload => { void owner.waive(payload.issueId, true, payload.expectedWaiverId); },
    });
    const removeRevokeWaiver = commandRegistry.register({
      id: "review.revoke-waiver", nameKey: "review.revokeWaiver", category: "review", scope: commandScope,
      binding: null, risk: "writes-review", confirmation: "none", payloadKind: "review-waiver",
      availability: payload => waiverAvailability(payload, false),
      handler: payload => { void owner.waive(payload.issueId, false, payload.expectedWaiverId); },
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
      removeRetry(); removeCancel(); removeCheck(); removeRequestChanges(); removeApprove(); };
  });
  function beginViewRead(showBusy: boolean) {
    const ticket = ++generation.current;
    setReadBusy(showBusy);
    return ticket;
  }
  function captureSelected() {
    const current = owner.current(), target = current.selected;
    return target ? { unitId: target.unitId, locale: target.locale, basis: target.basis,
      editSeq: current.editSeq[draftKey(target)] ?? 0 } : null;
  }

  useEffect(() => {
    setLanguages(current => current.filter(value => availableLocales.current.includes(value)));
    setAssessment(current => current?.locales.some(value => !availableLocales.current.includes(value)) ? null : current);
    setReadBusy(false);
  }, [targetScope]);
  useLayoutEffect(() => {
    setWorkCursor(current => current.locale === locale ? current : { locale, offset: 0 });
  }, [locale]);
  useLayoutEffect(() => {
    setHistoryCursor(current => current.unitId === selected?.unitId && current.locale === selected?.locale
      ? current : { unitId: selected?.unitId ?? "", locale: selected?.locale ?? "", offset: 0 });
  }, [selected?.unitId, selected?.locale]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.includes("review") || scopes.includes("project")) setHistoryCursor(current => current.offset === 0 ? current : { ...current, offset: 0 });
  }), [reads]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; leaveResolver.current?.(false); };
  }, []);
  useEffect(() => {
    if (!open) { generation.current++; setReadBusy(false); }
  }, [open]);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, tab]);
  useEffect(() => {
    if (!open || !targetAvailable) return;
    const ticket = beginViewRead(false);
    const localeChanged = previousLocale.current !== locale;
    previousLocale.current = locale;
    if (localeChanged) { setSelected(null); setPage(null); setAssessment(null); setPageAfter(0); }
    const after = localeChanged ? 0 : pageAfter;
    void commands.summaryPage({ ...session, locale, query: "", scopeId: null, afterOrdinal: after, limit: 50 })
      .then(async value => { if (alive.current && generation.current === ticket && currentLocale(locale)) {
        setPage(value);
        if (selected && !localeChanged && tab !== "work") await selectUnit(selected.unitId, retainedReview);
      } })
      .catch(error => { if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); } });
    return () => { generation.current++; };
  }, [open, locale, targetScope, project.sessionToken]);
  useEffect(() => {
    if (lastCompletion.current === owner.state.completionVersion) return;
    lastCompletion.current = owner.state.completionVersion;
    const target = owner.current().selected;
    if (!target || !localeAvailable(target.locale)) return;
    refreshCurrentHistory();
    if (!open) return;
    const capture = captureSelected();
    if (!capture) return;
    const ticket = beginViewRead(false);
    void commands.target({ ...session, unitId: target.unitId, locale: target.locale }).then(latest => {
      if (!alive.current || generation.current !== ticket || !currentLocale(target.locale)) return;
      owner.observeProjection(latest, capture);
    }).catch(error => {
      if (alive.current && generation.current === ticket && currentLocale(target.locale)) setReason(errorReason(error));
    });
  }, [owner.state.completionVersion]);
  useImperativeHandle(ref, () => ({
    showWork() { setTab("work"); setOpen(true); if (open && tab === "work" && targetAvailable) void workRead.refetch(); },
    allowLeave() {
      if (owner.inFlight() || batchRunning || pending) { setOpen(true); setNotice("unknown"); return Promise.resolve(false); }
      if (!hasDraft && Object.keys(chosen).length === 0) return Promise.resolve(true);
      setOpen(true); setLeavePrompt(true);
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
    allowNavigate() { generation.current++; setReadBusy(false); return Promise.resolve(true); },
  }));

  async function loadPage(after: number) {
    if (!currentLocale(locale)) return;
    const ticket = beginViewRead(true);
    setNotice(null);
    try {
      const value = await commands.summaryPage({ ...session, locale, query: "",
        scopeId: after === 0 ? null : page?.scopeId ?? null, afterOrdinal: after, limit: 50 });
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setPage(value); setPageAfter(after); }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setReadBusy(false); }
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
  async function selectUnit(unitId: string, observe = false) {
    if (!currentLocale(locale)) return;
    const capture = captureSelected();
    const ticket = beginViewRead(true);
    setNotice(null);
    try {
      const value = await commands.target({ ...session, unitId, locale });
      if (alive.current && generation.current === ticket && currentLocale(locale)) {
        const now = owner.current();
        if (capture?.unitId === unitId && capture.locale === locale
          && (observe || (now.editSeq[draftKey(capture)] ?? 0) !== capture.editSeq)) owner.observeProjection(value, capture);
        else setSelected(value);
        setHistoryCursor({ unitId, locale, offset: 0 }); setTab("review");
      }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setReadBusy(false); }
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
  async function refresh() {
    if (!currentLocale(locale)) return;
    const current = selected;
    const capture = captureSelected();
    const ticket = beginViewRead(true);
    setNotice(null);
    refreshCurrentHistory();
    try {
      const [newPage, newSelected] = await Promise.all([
        commands.summaryPage({ ...session, locale, query: "", scopeId: null, afterOrdinal: pageAfter, limit: 50 }),
        current ? commands.target({ ...session, unitId: current.unitId, locale }) : Promise.resolve(null),
      ]);
      if (alive.current && generation.current === ticket && currentLocale(locale)) {
        setPage(newPage);
        if (newSelected && capture) owner.observeProjection(newSelected, capture);
      }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setReadBusy(false); }
  }

  function requestClose() {
    setOpen(false);
  }
  function finishLeave(discard: boolean) {
    setLeavePrompt(false);
    if (discard) { owner.clear(); setOpen(false); }
    leaveResolver.current?.(discard); leaveResolver.current = null;
  }
  function queueReason(code: string) { return t(reviewReasonKey(code)); }
  function eligibilityReasonLabel(value: EligibilityReason) {
    if (value.code === "source-fallback") return t("review.fallbackActive");
    if (value.code === "issue-waiver") return t("review.waived");
    return queueReason(value.code);
  }
  function findingLabel(rule: string, code: string) {
    if (rule === "required-translation") return t(code === "empty" ? "review.issueEmpty" : "review.issueMissing");
    if (rule === "placeholders") return t("review.issueMarker");
    if (rule === "format") return t("review.issueFormat");
    return t(code === "conflict" ? "review.issueConflict" : "review.issueTerm");
  }
  function ruleLabel(rule: string) {
    if (rule === "required-translation") return t("review.ruleRequired");
    if (rule === "placeholders") return t("review.rulePlaceholders");
    if (rule === "format") return t("review.ruleFormat");
    return t("review.ruleTerminology");
  }
  function ruleStatusLabel(status: string) {
    return t(status === "passed" ? "review.passed" : status === "not-applicable" ? "review.notApplicable"
      : status === "findings" ? "review.findings" : status === "failed" ? "review.checkFailed"
      : status === "cancelled" ? "review.checkCancelled" : "review.qaUnavailable");
  }
  function ruleReasonLabel(status: string) {
    return t(status === "not-applicable" ? "review.noSelectedTranslationReason" : status === "failed" ? "review.checkFailedHelp"
      : status === "cancelled" ? "review.checkCancelledHelp" : "review.placeholderUnavailable");
  }

  return <>
    <WorkbenchPanel open={open} title={t("review.title")} description={t("review.description")} className="source-dialog review-dialog" onBack={requestClose} backDisabled={disabled}>
        {project.metadata.targetLocales.length === 0 ? <p>{t("review.noLocale")}</p> : null}
        {project.metadata.targetLocales.length > 0 || retainedReview ? <>
          <div className="review-header-fields">
            <label>{t("review.targetLocale")}<select value={locale} disabled={readBusy || busyMutation} onChange={event => { setLocale(event.target.value); setSelected(null); }}>
              {targetRemoved ? <option value={locale}>{locale}</option> : null}
              {project.metadata.targetLocales.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>
            <label>{t("review.reviewer")}<input value={actor} onChange={event => setActor(event.target.value)} maxLength={128} autoComplete="name" /></label>
          </div>
          <div className="form-actions" role="tablist" aria-label={t("review.title")}>
            {(["review", "work", "eligibility"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "primary-button" : "secondary-button"} onClick={() => setTab(value)}>
              {t(value === "review" ? "review.reviewTab" : value === "work" ? "review.workTab" : "review.eligibilityTab")}
            </button>)}
          </div>
          {removedLocale ? <p role="status">{t("review.removedTarget", { locale: removedLocale })}</p> : null}
          {notice ? <div role="status" className="execution-feedback">{notice === "saved" ? t("review.saved") : notice === "unknown" ? t("review.unknown") : notice === "conflict" ? t("review.conflict") : notice === "checkFailed" ? t("review.checkFailedHelp") : notice === "checkCancelled" ? t("review.checkCancelledHelp") : notice === "cancelRequested" ? t("review.cancelRequested") : reason === "reviewer-required" ? t("review.reviewerRequired") : reason === "reason-required" ? t("review.reasonRequired") : reason === "editor-unavailable" ? t("review.editorUnavailable") : t("review.error", { reason })}</div> : null}
          {pending && !owner.inFlight() && notice !== "unknown" ? <p role="status">{t("review.unknown")}</p> : null}
          {notice ? <CommandFailureDetails failure={reasonValue} /> : null}
          {pending ? <button className="secondary-button" disabled={!retryAvailability().enabled} onClick={() => commandRegistry.dispatch("review.retry-pending", commandScope)}>{t("review.retry")}</button> : null}
          {batchStatus ? <p role="status">{t("review.batchResult", { ...batchStatus, defaultValue: "{{applied}} recorded, {{conflicted}} changed, {{failed}} failed." })}</p> : null}
          {batchStatus?.notStarted ? <p role="status">{t("review.batchRemaining", { count: batchStatus.notStarted })}</p> : null}
          {batchRunning ? <button className="secondary-button" disabled={!stopBatchAvailability().enabled} onClick={() => commandRegistry.dispatch("review.stop-batch", commandScope)}>{t("review.batchCancel")}</button> : null}
          {tab === "review" ? <div className="review-columns">
            <section aria-label={t("review.reviewTab")}>
              <div className="form-actions"><button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void refresh()}>{t("review.refresh")}</button>
                <button className="secondary-button" disabled={!batchAvailability().enabled} onClick={() => commandRegistry.dispatch("review.approve-batch", commandScope)}>{t("review.batch")} ({chosenCount})</button></div>
              {Object.keys(chosen).length >= MAX_BATCH ? <p role="status">{t("review.batchLimit", { count: MAX_BATCH })}</p> : null}
              {!page ? <p>{t("review.noSource")}</p> : <><div className="review-list">{page.rows.map(target => <div className="review-list-row" key={target.unitId}>
                <input type="checkbox" aria-label={`${t("review.batch")}: ${target.nativeKey}`} checked={!!chosen[draftKey(target)]} disabled={busy || !targetAvailable || !target.selectionId || (!chosen[draftKey(target)] && chosenCount >= MAX_BATCH)}
                  onChange={event => owner.toggleChosen(target, event.target.checked)} />
                <button className="text-button" aria-current={selected?.unitId === target.unitId ? "true" : undefined} disabled={busy || !targetAvailable} onClick={() => void selectUnit(target.unitId)}>{target.nativeKey}</button>
              </div>)}</div><div className="form-actions"><button className="secondary-button" disabled={busy || !targetAvailable || pageAfter === 0} onClick={() => void loadPage(0)}>{t("review.previousPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || page.nextOrdinal === null} onClick={() => void loadPage(page.nextOrdinal!)}>{t("review.nextPage")}</button></div></>}
            </section>
            <section aria-label={t("review.scope")}>
              {!selected || !displayTarget ? <p>{t("review.selectEntry")}</p> : <>
                {selectedStale ? <strong>{t("review.currentContent")}</strong> : null}
                <h3>{displayTarget.nativeKey}</h3><p><strong>{t("review.source")}</strong> {displayTarget.sourceText}</p>
                <p><strong>{t("review.translation")}</strong> {displayTarget.translationText ?? t("review.missingTranslation")}</p>
                <button className="text-button" disabled={!targetAvailable} onClick={() => {
                  const destination = { target: { unitId: displayTarget.unitId, sourceRevisionId: displayTarget.sourceRevisionId, key: displayTarget.nativeKey, sourceText: displayTarget.sourceText }, locale: displayTarget.locale };
                  if (onOpenTranslation(destination.target, destination.locale)) setOpen(false);
                  else { setNotice("error"); setReason("editor-unavailable"); }
                }}>{t("review.openTranslation")}</button>
                <p>{displayTarget.currentDecision?.kind === "approve" ? t("review.currentApproval") : displayTarget.currentDecision?.kind === "request-changes" ? t("review.changesRequested") : t("review.approvalMissing")}</p>
                {displayTarget.currentFallback ? <p>{t("review.fallbackActive")}</p> : null}
                {selectedStale || fallbackIdentityChanged ? <div role="status" className="execution-feedback">
                  <p>{t("review.changedReasonBasis")}</p>
                  <div><strong>{t("review.earlierContent")}</strong><p>{selected.sourceText}</p><p>{selected.translationText ?? t("review.missingTranslation")}</p></div>
                  <button className="secondary-button" disabled={busy || !!pending || !targetAvailable || owner.inFlight()}
                    onClick={() => owner.adoptCurrent()}>{t("review.useCurrentKeepReason")}</button>
                </div> : null}
                <label>{t("review.reason")}<textarea value={drafts[draftKey(selected)] ?? ""} onChange={event => owner.editReason(selected, event.target.value)} maxLength={4096} /></label>
                <div className="form-actions"><button className="primary-button" disabled={!decisionAvailability().enabled} onClick={() => commandRegistry.dispatch("review.approve", commandScope)}>{t("review.approve")}</button>
                  <button className="secondary-button" disabled={!decisionAvailability().enabled} onClick={() => commandRegistry.dispatch("review.request-changes", commandScope)}>{t("review.requestChanges")}</button>
                  {!selected.selectionId && fallbackPayload ? <button className="secondary-button" disabled={!fallbackAvailability(fallbackPayload, !selected.currentFallback).enabled} onClick={() => commandRegistry.dispatch(selected.currentFallback ? "review.withdraw-fallback" : "review.allow-fallback", commandScope, fallbackPayload)}>{t(selected.currentFallback ? "review.withdrawFallback" : "review.fallback")}</button> : null}</div>
                <div className="form-actions"><button className="secondary-button" disabled={!checkAvailability().enabled} onClick={() => commandRegistry.dispatch("review.run-checks", commandScope)}>{busy ? t("review.checking") : t("review.check")}</button>{activeCheckId ? <button className="secondary-button" disabled={!cancelAvailability().enabled} onClick={() => commandRegistry.dispatch("review.cancel-checks", commandScope)}>{t("review.cancelCheck")}</button> : null}</div>
                <h4>{t("review.qaCurrent")}</h4>{!displayTarget.currentCheck || displayTarget.currentCheck.basis !== displayTarget.basis ? <p>{t("review.qaMissing")}</p> : displayTarget.currentCheck.rules.map(rule => <div key={rule.rule} className="review-rule"><strong>{ruleLabel(rule.rule)}</strong> — {ruleStatusLabel(rule.status)}
                  {rule.reason ? <p>{ruleReasonLabel(rule.status)}</p> : null}
                  {rule.findings.map(finding => {
                    const waiver = displayTarget.currentWaivers.find(value => value.issueId === finding.issueId);
                    const payload = waiverPayload(selected, finding.issueId, waiver?.waiverId ?? null);
                    return <div key={finding.issueId}><p>{findingLabel(finding.rule, finding.code)}{finding.rule === "terminology" ? `: ${finding.detail}` : ""}</p>
                      {waiver ? <><p>{t("review.waived")}</p><button className="text-button" disabled={!waiverAvailability(payload, false).enabled} onClick={() => commandRegistry.dispatch("review.revoke-waiver", commandScope, payload)}>{t("review.revokeWaiver")}</button></> : finding.waivable ? <button className="text-button" disabled={!waiverAvailability(payload, true).enabled} onClick={() => commandRegistry.dispatch("review.grant-waiver", commandScope, payload)}>{t("review.waive")}</button> : null}</div>;
                  })}
                </div>)}
                <details><summary>{t("review.history")}</summary>
                  {historyLoading ? <p role="status">{t("review.historyLoading")}</p> : null}
                  {historyFailure && !historyRead.isFetching ? <div role="alert">{t("review.historyUnavailable")}
                    <CommandFailureDetails failure={historyFailure} />
                    <button className="secondary-button" disabled={historyBusy} onClick={() => void historyRead.refetch()}>{t("review.historyRetry")}</button>
                  </div> : null}
                  {history && !historyFailure && history.decisions.length + history.checks.length + history.waivers.length + history.fallbacks.length === 0 ? <p>{t("review.historyEmpty")}</p> : null}
                  {history?.decisions.map(item => <p key={item.decisionId}>{item.createdAt} · {item.actor} · {t(item.kind === "approve" ? "review.currentApproval" : "review.changesRequested")}{item.decisionId === displayTarget.currentDecision?.decisionId ? "" : ` · ${t("review.earlier")}`}{item.reason ? ` · ${item.reason}` : ""}</p>)}
                  {history?.checks.map(item => <div key={item.runId} className="review-history-check"><p>{item.createdAt} · {t("review.qaRun")} · {item.validatorVersion}{item.runId === displayTarget.currentCheck?.runId ? "" : ` · ${t("review.earlier")}`}</p>
                    <ul>{item.rules.map(rule => <li key={rule.rule}><strong>{ruleLabel(rule.rule)}</strong> — {ruleStatusLabel(rule.status)}
                      {rule.reason ? ` · ${ruleReasonLabel(rule.status)}` : ""}
                      {rule.findings.length > 0 ? <ul>{rule.findings.map(finding => <li key={finding.issueId}>{findingLabel(finding.rule, finding.code)}{finding.rule === "terminology" ? `: ${finding.detail}` : ""}</li>)}</ul> : null}
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
            {work ? <><p>{t("review.workCount", { count: work.total })}</p>{work.items.length === 0 ? <p>{t("review.workEmpty")}</p> : work.items.map(item => <div key={item.unitId} className="review-work-item"><button className="text-button" disabled={!targetAvailable} onClick={() => void selectUnit(item.unitId)}>{item.nativeKey}</button><ul>{[...new Set(item.reasons.map(queueReason))].map(value => <li key={value}>{value}</li>)}</ul></div>)}</> : targetAvailable && !workLoading && !workFailure ? <p>{t("review.selectEntry")}</p> : null}
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
