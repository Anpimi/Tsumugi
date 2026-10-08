import { reviewReasonKey } from "./reviewLabels";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { executionCommands, executionContext } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import { reviewCommands as commands, type Eligibility, type EligibilityReason, type FallbackWrite,
  type ReviewHistoryPage, type ReviewTarget, type ReviewSummary, type ReviewSummaryPage, type ReviewWrite, type WaiverWrite, type WorkPage } from "./reviewCommands";

type Tab = "review" | "work" | "eligibility";
type Pending = { kind: "decision"; request: ReviewWrite } | { kind: "check"; request: { unitId: string; locale: string; expectedBasis: string; actionId: string } }
  | { kind: "waiver"; request: WaiverWrite } | { kind: "fallback"; request: FallbackWrite };
type Notice = "saved" | "unknown" | "conflict" | "error" | "checkFailed" | "checkCancelled" | "cancelRequested" | null;
const MAX_BATCH = 100;
export interface ReviewHandle { allowLeave: () => Promise<boolean>; showWork: () => void }

const errorReason = commandFailure;
function isUncertain(error: unknown) {
  return hasUnknownOutcome(error);
}
function isConflict(error: unknown) {
  return (error as { code?: string } | null)?.code === "dependency-conflict";
}
function draftKey(target: Pick<ReviewTarget, "locale" | "unitId">) { return `${target.locale}:${target.unitId}`; }

export function ReviewWorkbench({ project, disabled, onOpenTranslation, ref }: {
  project: ProjectView; disabled: boolean; onOpenTranslation: (target: EditorTarget, locale: string) => boolean;
  ref?: Ref<ReviewHandle>;
}) {
  const { t } = useTranslation();
  const session = executionContext(project);
  const [open, setOpen] = useWorkbenchView("review");
  const [tab, setTab] = useState<Tab>("review");
  const [locale, setLocale] = useState(project.metadata.targetLocales[0] ?? "");
  const [page, setPage] = useState<ReviewSummaryPage | null>(null);
  const [pageAfter, setPageAfter] = useState(0);
  const [selected, setSelected] = useState<ReviewTarget | null>(null);
  const [history, setHistory] = useState<ReviewHistoryPage | null>(null);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [work, setWork] = useState<WorkPage | null>(null);
  const [workOffset, setWorkOffset] = useState(0);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [languages, setLanguages] = useState<string[]>(project.metadata.targetLocales);
  const [actor, setActor] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Record<string, ReviewSummary>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [reasonValue, setReason] = useState<CommandFailure>("");
  const reason = failureReason(reasonValue) ?? "";
  const [busy, setBusy] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [batchPrompt, setBatchPrompt] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [activeCheckId, setActiveCheckId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<{ applied: number; conflicted: number; failed: number; notStarted: number } | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const running = useRef(false);
  const pendingAction = useRef<Pending | null>(null);
  const cancelBatch = useRef(false);
  const leaveResolver = useRef<((allowed: boolean) => void) | null>(null);
  const leaveToTranslation = useRef<{ target: EditorTarget; locale: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const hasDraft = Object.values(drafts).some(value => value.length > 0);
  const requestedWork = useRef(false);
  const previousLocale = useRef(locale);
  const targetScope = project.metadata.targetLocales.join("\u0000");
  const availableLocales = useRef(project.metadata.targetLocales);
  const selectedLocale = useRef(locale);
  const selectedTarget = useRef(selected);
  useLayoutEffect(() => {
    availableLocales.current = project.metadata.targetLocales;
    selectedLocale.current = locale;
    selectedTarget.current = selected;
  }, [targetScope, locale, selected]);
  const localeAvailable = (value: string) => value !== "" && availableLocales.current.includes(value);
  const currentLocale = (value: string) => selectedLocale.current === value && localeAvailable(value);
  const targetAvailable = locale !== "" && project.metadata.targetLocales.includes(locale);
  const targetRemoved = locale !== "" && !targetAvailable;
  const chosenCount = Object.keys(chosen).length;
  const invalidChosenLocale = Object.values(chosen).find(value => !project.metadata.targetLocales.includes(value.locale))?.locale;
  const invalidDraftKey = Object.keys(drafts).find(key => drafts[key].length > 0
    && !project.metadata.targetLocales.includes(key.slice(0, key.indexOf(":"))));
  const invalidDraftLocale = invalidDraftKey?.slice(0, invalidDraftKey.indexOf(":"));
  const invalidPendingLocale = pending && !project.metadata.targetLocales.includes(pending.request.locale) ? pending.request.locale : null;
  const removedLocale = targetRemoved ? locale : invalidChosenLocale ?? invalidDraftLocale ?? invalidPendingLocale;
  const retainedReview = hasDraft || chosenCount > 0 || !!pending || running.current || batchRunning;
  function keepPending(next: Pending | null) { pendingAction.current = next; setPending(next); }

  useEffect(() => {
    setLanguages(current => current.filter(value => availableLocales.current.includes(value)));
    setEligibility(null);
    if (!running.current && !batchRunning) setBusy(false);
  }, [targetScope]);
  useEffect(() => {
    if (targetAvailable || hasDraft || chosenCount > 0 || pending || running.current || batchRunning) return;
    const next = project.metadata.targetLocales[0] ?? "";
    if (next === locale) return;
    setLocale(next); setSelected(null); setHistory(null); setPage(null); setWork(null); setEligibility(null);
    setPageAfter(0); setWorkOffset(0);
  }, [targetScope, targetAvailable, hasDraft, chosenCount, pending, batchRunning, locale]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; leaveResolver.current?.(false); };
  }, []);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, tab]);
  useEffect(() => {
    if (!open || !targetAvailable) return;
    const ticket = ++generation.current;
    const localeChanged = previousLocale.current !== locale;
    previousLocale.current = locale;
    if (localeChanged) { setSelected(null); setHistory(null); setPage(null); setWork(null); setEligibility(null); setPageAfter(0); setWorkOffset(0); }
    const after = localeChanged ? 0 : pageAfter;
    void commands.summaryPage({ ...session, locale, query: "", scopeId: null, afterOrdinal: after, limit: 50 })
      .then(async value => { if (alive.current && generation.current === ticket && currentLocale(locale)) {
        setPage(value);
        if (requestedWork.current || tab === "work") { requestedWork.current = false; await loadWork(localeChanged ? 0 : workOffset); }
        else if (selected && !localeChanged) await selectUnit(selected.unitId);
      } })
      .catch(error => { if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); } });
    return () => { generation.current++; };
  }, [open, locale, targetScope, project.sessionToken]);
  useImperativeHandle(ref, () => ({
    showWork() { requestedWork.current = true; setTab("work"); setOpen(true); if (open) { requestedWork.current = false; void loadWork(workOffset); } },
    allowLeave() {
      if (running.current || batchRunning || pending) { setOpen(true); setNotice("unknown"); return Promise.resolve(false); }
      if (!hasDraft && Object.keys(chosen).length === 0) return Promise.resolve(true);
      leaveToTranslation.current = null;
      setOpen(true); setLeavePrompt(true);
      return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
    },
  }));

  async function loadPage(after: number) {
    if (!currentLocale(locale)) return;
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const value = await commands.summaryPage({ ...session, locale, query: "",
        scopeId: after === 0 ? null : page?.scopeId ?? null, afterOrdinal: after, limit: 50 });
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setPage(value); setPageAfter(after); }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setBusy(false); }
  }
  async function loadWork(offset: number) {
    if (!currentLocale(locale)) return;
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const value = await commands.work({ ...session, locale, offset, limit: 50 });
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setWork(value); setWorkOffset(offset); }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setBusy(false); }
  }
  async function assess() {
    if (languages.length === 0 || languages.some(value => !localeAvailable(value))) return;
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const value = await commands.eligibility({ ...session, locales: languages });
      if (alive.current && generation.current === ticket && languages.every(localeAvailable)) setEligibility(value);
    } catch (error) {
      if (alive.current && generation.current === ticket && languages.every(localeAvailable)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setBusy(false); }
  }
  async function selectUnit(unitId: string) {
    if (!currentLocale(locale)) return;
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const [value, previous] = await Promise.all([
        commands.target({ ...session, unitId, locale }),
        commands.history({ ...session, unitId, locale, offset: 0, limit: 20 }),
      ]);
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setSelected(value); setHistory(previous); setHistoryOffset(0); setTab("review"); }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setBusy(false); }
  }
  async function loadHistory(offset: number) {
    if (!selected || !currentLocale(selected.locale)) return;
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const value = await commands.history({ ...session, unitId: selected.unitId, locale: selected.locale, offset, limit: 20 });
      if (alive.current && generation.current === ticket && currentLocale(selected.locale)) { setHistory(value); setHistoryOffset(offset); }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(selected.locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setBusy(false); }
  }
  async function refresh() {
    if (!currentLocale(locale)) return;
    const current = selected;
    const ticket = ++generation.current;
    setBusy(true); setNotice(null);
    try {
      const [newPage, newSelected, newHistory] = await Promise.all([
        commands.summaryPage({ ...session, locale, query: "", scopeId: null, afterOrdinal: pageAfter, limit: 50 }),
        current ? commands.target({ ...session, unitId: current.unitId, locale }) : Promise.resolve(null),
        current ? commands.history({ ...session, unitId: current.unitId, locale, offset: 0, limit: 20 }) : Promise.resolve(null),
      ]);
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setPage(newPage); setSelected(newSelected); setHistory(newHistory); setHistoryOffset(0); setWork(null); setEligibility(null); }
    } catch (error) {
      if (alive.current && generation.current === ticket && currentLocale(locale)) { setNotice("error"); setReason(errorReason(error)); }
    } finally { if (alive.current && generation.current === ticket) setBusy(false); }
  }

  async function execute(action: Pending, sameActionRetry = false) {
    if (running.current) return;
    if (sameActionRetry ? pendingAction.current !== action : pendingAction.current !== null) return;
    if (!sameActionRetry && !localeAvailable(action.request.locale)) return;
    running.current = true; setBusy(true); keepPending(action); setNotice(null);
    if (action.kind === "check") setActiveCheckId(action.request.actionId);
    try {
      let checkOutcome: "completed" | "failed" | "cancelled" | null = null;
      if (action.kind === "decision") await commands.decide(session, action.request);
      if (action.kind === "check") checkOutcome = (await commands.check({ ...session, ...action.request })).outcome;
      if (action.kind === "waiver") await commands.waive(session, action.request);
      if (action.kind === "fallback") await commands.fallback(session, action.request);
      keepPending(null); setNotice(checkOutcome === "failed" ? "checkFailed" : checkOutcome === "cancelled" ? "checkCancelled" : "saved"); setWork(null); setEligibility(null);
      if (action.kind === "decision") {
        setChosen(previous => {
          const key = `${action.request.locale}:${action.request.unitId}`;
          if (previous[key]?.basis !== action.request.expectedBasis) return previous;
          const next = { ...previous }; delete next[key]; return next;
        });
      }
      if (action.kind === "decision" || action.kind === "waiver" || action.kind === "fallback") {
        const key = `${action.request.locale}:${action.request.unitId}`;
        setDrafts(previous => previous[key] === action.request.reason ? { ...previous, [key]: "" } : previous);
      }
      if (currentLocale(action.request.locale) && selectedTarget.current?.unitId === action.request.unitId) {
        try {
          const [target, previous] = await Promise.all([
            commands.target({ ...session, unitId: action.request.unitId, locale: action.request.locale }),
            commands.history({ ...session, unitId: action.request.unitId, locale: action.request.locale, offset: 0, limit: 20 }),
          ]);
          const currentTarget = selectedTarget.current;
          if (alive.current && currentLocale(action.request.locale)
            && currentTarget && currentTarget.unitId === target.unitId && currentTarget.locale === target.locale) {
            setSelected(target); setHistory(previous); setHistoryOffset(0);
          }
        } catch (error) { if (alive.current && currentLocale(action.request.locale)) setReason(errorReason(error)); }
      }
    } catch (error) {
      const uncertain = isUncertain(error);
      keepPending(uncertain ? action : null);
      setNotice(uncertain ? "unknown" : isConflict(error) ? "conflict" : "error");
      setReason(errorReason(error));
    } finally { running.current = false; if (alive.current) { setBusy(false); setActiveCheckId(null); } }
  }
  async function decide(kind: ReviewWrite["kind"]) {
    if (pendingAction.current || running.current) return;
    if (!selected || !actor.trim()) { setNotice("error"); setReason("reviewer-required"); return; }
    if (!currentLocale(selected.locale)) return;
    const reasonDraft = drafts[draftKey(selected)] ?? "";
    if (kind === "request-changes" && !reasonDraft.trim()) { setNotice("error"); setReason("reason-required"); return; }
    try {
      const actionId = await executionCommands.identity(session);
      if (!alive.current || pendingAction.current || !currentLocale(selected.locale)) return;
      await execute({ kind: "decision", request: { projectId: session.projectId, actionId,
        unitId: selected.unitId, locale: selected.locale, expectedBasis: selected.basis,
        expectedDecisionId: selected.currentDecision?.decisionId ?? null, actor: actor.trim(), kind, reason: reasonDraft } });
    } catch (error) { setNotice("error"); setReason(errorReason(error)); }
  }
  async function check() {
    if (pendingAction.current || running.current || !selected || !currentLocale(selected.locale)) return;
    try {
      const actionId = await executionCommands.identity(session);
      if (!alive.current || pendingAction.current || !currentLocale(selected.locale)) return;
      await execute({ kind: "check", request: { actionId, unitId: selected.unitId, locale: selected.locale, expectedBasis: selected.basis } });
    } catch (error) { setNotice("error"); setReason(errorReason(error)); }
  }
  async function cancelCheck() {
    if (!activeCheckId) return;
    try {
      if (await commands.cancelCheck({ ...session, actionId: activeCheckId })) setNotice("cancelRequested");
    } catch (error) { setNotice("error"); setReason(errorReason(error)); }
  }
  async function waive(issueId: string, grant: boolean, expectedWaiverId: string | null) {
    if (pendingAction.current || running.current) return;
    if (!selected || !actor.trim() || !(drafts[draftKey(selected)] ?? "").trim()) {
      setNotice("error"); setReason("reason-required"); return;
    }
    if (!currentLocale(selected.locale)) return;
    try {
      const actionId = await executionCommands.identity(session);
      if (!alive.current || pendingAction.current || !currentLocale(selected.locale)) return;
      await execute({ kind: "waiver", request: { projectId: session.projectId, actionId, unitId: selected.unitId,
        locale: selected.locale, expectedBasis: selected.basis, issueId, grant, expectedWaiverId,
        actor: actor.trim(), reason: drafts[draftKey(selected)] } });
    } catch (error) { setNotice("error"); setReason(errorReason(error)); }
  }
  async function fallback(allow: boolean) {
    if (pendingAction.current || running.current) return;
    if (!selected || !actor.trim() || !(drafts[draftKey(selected)] ?? "").trim()) {
      setNotice("error"); setReason("reason-required"); return;
    }
    if (!currentLocale(selected.locale)) return;
    try {
      const actionId = await executionCommands.identity(session);
      if (!alive.current || pendingAction.current || !currentLocale(selected.locale)) return;
      await execute({ kind: "fallback", request: { projectId: session.projectId, actionId, unitId: selected.unitId,
        locale: selected.locale, expectedBasis: selected.basis, allow,
        expectedFallbackId: selected.currentFallback?.fallbackId ?? null,
        actor: actor.trim(), reason: drafts[draftKey(selected)] } });
    } catch (error) { setNotice("error"); setReason(errorReason(error)); }
  }
  async function approveBatch() {
    if (pendingAction.current || running.current) return;
    const frozen = Object.values(chosen);
    const batchActor = actor.trim();
    if (!batchActor || frozen.length === 0) return;
    cancelBatch.current = false; setBatchPrompt(false); setBatchStatus(null); setBusy(true); setBatchRunning(true); running.current = true;
    const result = { applied: 0, conflicted: 0, failed: 0 };
    let processed = 0;
    for (const target of frozen) {
      if (cancelBatch.current) break;
      if (pendingAction.current) break;
      if (!localeAvailable(target.locale)) break;
      let request: ReviewWrite | null = null;
      try {
        const actionId = await executionCommands.identity(session);
        if (!alive.current || pendingAction.current || !localeAvailable(target.locale)) break;
        request = { projectId: session.projectId, actionId,
          unitId: target.unitId, locale: target.locale, expectedBasis: target.basis,
          expectedDecisionId: target.currentDecision?.decisionId ?? null, actor: batchActor, kind: "approve", reason: "" };
        await commands.decide(session, request);
        result.applied++;
        setChosen(previous => { const next = { ...previous }; delete next[draftKey(target)]; return next; });
      } catch (error) {
        if (isUncertain(error)) { if (request) keepPending({ kind: "decision", request }); result.failed++; processed++; setNotice("unknown"); break; }
        if (isConflict(error)) result.conflicted++; else result.failed++;
      }
      processed++;
    }
    running.current = false; setBatchStatus({ ...result, notStarted: frozen.length - processed }); setBusy(false); setBatchRunning(false); setWork(null); setEligibility(null);
    if (selected && currentLocale(selected.locale)) void selectUnit(selected.unitId);
  }
  function requestClose() {
    if (running.current || batchRunning || pending) { setNotice("unknown"); return; }
    if (hasDraft || Object.keys(chosen).length > 0) { leaveToTranslation.current = null; setLeavePrompt(true); return; }
    setOpen(false);
  }
  function finishLeave(discard: boolean) {
    setLeavePrompt(false);
    const destination = leaveToTranslation.current;
    leaveToTranslation.current = null;
    if (discard && destination && (!localeAvailable(destination.locale) || !onOpenTranslation(destination.target, destination.locale))) {
      setNotice("error"); setReason("editor-unavailable");
      leaveResolver.current?.(false); leaveResolver.current = null;
      return;
    }
    if (discard) { setDrafts({}); setChosen({}); setOpen(false); }
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
    <WorkbenchPanel open={open} title={t("review.title")} description={t("review.description")} className="source-dialog review-dialog" onBack={requestClose} backDisabled={disabled || busy}>
        {project.metadata.targetLocales.length === 0 ? <p>{t("review.noLocale")}</p> : null}
        {project.metadata.targetLocales.length > 0 || retainedReview ? <>
          <div className="review-header-fields">
            <label>{t("review.targetLocale")}<select value={locale} disabled={busy} onChange={event => { setLocale(event.target.value); setSelected(null); }}>
              {targetRemoved ? <option value={locale}>{locale}</option> : null}
              {project.metadata.targetLocales.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>
            <label>{t("review.reviewer")}<input value={actor} onChange={event => setActor(event.target.value)} maxLength={128} autoComplete="name" /></label>
          </div>
          <div className="form-actions" role="tablist" aria-label={t("review.title")}>
            {(["review", "work", "eligibility"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "primary-button" : "secondary-button"} onClick={() => { setTab(value); if (value === "work" && !work) void loadWork(0); }}>
              {t(value === "review" ? "review.reviewTab" : value === "work" ? "review.workTab" : "review.eligibilityTab")}
            </button>)}
          </div>
          {removedLocale ? <p role="status">{t("review.removedTarget", { locale: removedLocale })}</p> : null}
          {notice ? <div role="status" className="execution-feedback">{notice === "saved" ? t("review.saved") : notice === "unknown" ? t("review.unknown") : notice === "conflict" ? t("review.conflict") : notice === "checkFailed" ? t("review.checkFailedHelp") : notice === "checkCancelled" ? t("review.checkCancelledHelp") : notice === "cancelRequested" ? t("review.cancelRequested") : reason === "reviewer-required" ? t("review.reviewerRequired") : reason === "reason-required" ? t("review.reasonRequired") : reason === "editor-unavailable" ? t("review.editorUnavailable") : t("review.error", { reason })}</div> : null}
          {pending && !running.current && notice !== "unknown" ? <p role="status">{t("review.unknown")}</p> : null}
          {notice ? <CommandFailureDetails failure={reasonValue} /> : null}
          {pending ? <button className="secondary-button" disabled={busy} onClick={() => void execute(pending, true)}>{t("review.retry")}</button> : null}
          {batchStatus ? <p role="status">{t("review.batchResult", { ...batchStatus, defaultValue: "{{applied}} recorded, {{conflicted}} changed, {{failed}} failed." })}</p> : null}
          {batchStatus?.notStarted ? <p role="status">{t("review.batchRemaining", { count: batchStatus.notStarted })}</p> : null}
          {batchRunning ? <button className="secondary-button" onClick={() => { cancelBatch.current = true; }}>{t("review.batchCancel")}</button> : null}
          {tab === "review" ? <div className="review-columns">
            <section aria-label={t("review.reviewTab")}>
              <div className="form-actions"><button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void refresh()}>{t("review.refresh")}</button>
                <button className="secondary-button" disabled={busy || !!pending || !actor.trim() || chosenCount === 0 || !!invalidChosenLocale} onClick={() => setBatchPrompt(true)}>{t("review.batch")} ({chosenCount})</button></div>
              {Object.keys(chosen).length >= MAX_BATCH ? <p role="status">{t("review.batchLimit", { count: MAX_BATCH })}</p> : null}
              {!page ? <p>{t("review.noSource")}</p> : <><div className="review-list">{page.rows.map(target => <div className="review-list-row" key={target.unitId}>
                <input type="checkbox" aria-label={`${t("review.batch")}: ${target.nativeKey}`} checked={!!chosen[draftKey(target)]} disabled={busy || !targetAvailable || !target.selectionId || (!chosen[draftKey(target)] && chosenCount >= MAX_BATCH)}
                  onChange={event => setChosen(previous => { const next = { ...previous }; if (event.target.checked) next[draftKey(target)] = target; else delete next[draftKey(target)]; return next; })} />
                <button className="text-button" aria-current={selected?.unitId === target.unitId ? "true" : undefined} disabled={busy || !targetAvailable} onClick={() => void selectUnit(target.unitId)}>{target.nativeKey}</button>
              </div>)}</div><div className="form-actions"><button className="secondary-button" disabled={busy || !targetAvailable || pageAfter === 0} onClick={() => void loadPage(0)}>{t("review.previousPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || page.nextOrdinal === null} onClick={() => void loadPage(page.nextOrdinal!)}>{t("review.nextPage")}</button></div></>}
            </section>
            <section aria-label={t("review.scope")}>
              {!selected ? <p>{t("review.selectEntry")}</p> : <>
                <h3>{selected.nativeKey}</h3><p><strong>{t("review.source")}</strong> {selected.sourceText}</p>
                <p><strong>{t("review.translation")}</strong> {selected.translationText ?? t("review.missingTranslation")}</p>
                <button className="text-button" disabled={!targetAvailable} onClick={() => {
                  if (busy || pending || running.current) { setNotice("unknown"); return; }
                  const destination = { target: { unitId: selected.unitId, sourceRevisionId: selected.sourceRevisionId, key: selected.nativeKey, sourceText: selected.sourceText }, locale: selected.locale };
                  if (hasDraft || Object.keys(chosen).length > 0) { leaveToTranslation.current = destination; setLeavePrompt(true); return; }
                  if (onOpenTranslation(destination.target, destination.locale)) setOpen(false);
                  else { setNotice("error"); setReason("editor-unavailable"); }
                }}>{t("review.openTranslation")}</button>
                <p>{selected.currentDecision?.kind === "approve" ? t("review.currentApproval") : selected.currentDecision?.kind === "request-changes" ? t("review.changesRequested") : t("review.approvalMissing")}</p>
                {selected.currentFallback ? <p>{t("review.fallbackActive")}</p> : null}
                <label>{t("review.reason")}<textarea value={drafts[draftKey(selected)] ?? ""} onChange={event => setDrafts(previous => ({ ...previous, [draftKey(selected)]: event.target.value }))} maxLength={4096} /></label>
                <div className="form-actions"><button className="primary-button" disabled={busy || !!pending || !targetAvailable || !selected.selectionId || !actor.trim()} onClick={() => void decide("approve")}>{t("review.approve")}</button>
                  <button className="secondary-button" disabled={busy || !!pending || !targetAvailable || !selected.selectionId || !actor.trim()} onClick={() => void decide("request-changes")}>{t("review.requestChanges")}</button>
                  {!selected.selectionId ? <button className="secondary-button" disabled={busy || !!pending || !targetAvailable || !actor.trim()} onClick={() => void fallback(!selected.currentFallback)}>{t(selected.currentFallback ? "review.withdrawFallback" : "review.fallback")}</button> : null}</div>
                <div className="form-actions"><button className="secondary-button" disabled={busy || !!pending || !targetAvailable} onClick={() => void check()}>{busy ? t("review.checking") : t("review.check")}</button>{activeCheckId ? <button className="secondary-button" onClick={() => void cancelCheck()}>{t("review.cancelCheck")}</button> : null}</div>
                <h4>{t("review.qaCurrent")}</h4>{!selected.currentCheck ? <p>{t("review.qaMissing")}</p> : selected.currentCheck.rules.map(rule => <div key={rule.rule} className="review-rule"><strong>{ruleLabel(rule.rule)}</strong> — {ruleStatusLabel(rule.status)}
                  {rule.reason ? <p>{ruleReasonLabel(rule.status)}</p> : null}
                  {rule.findings.map(finding => <div key={finding.issueId}><p>{findingLabel(finding.rule, finding.code)}{finding.rule === "terminology" ? `: ${finding.detail}` : ""}</p>
                    {selected.currentWaivers.some(waiver => waiver.issueId === finding.issueId) ? <><p>{t("review.waived")}</p><button className="text-button" disabled={busy || !!pending || !targetAvailable || !actor.trim()} onClick={() => void waive(finding.issueId, false, selected.currentWaivers.find(waiver => waiver.issueId === finding.issueId)!.waiverId)}>{t("review.revokeWaiver")}</button></> : finding.waivable ? <button className="text-button" disabled={busy || !!pending || !targetAvailable || !actor.trim()} onClick={() => void waive(finding.issueId, true, null)}>{t("review.waive")}</button> : null}</div>)}
                </div>)}
                <details><summary>{t("review.history")}</summary>{history && history.decisions.length + history.checks.length + history.waivers.length + history.fallbacks.length === 0 ? <p>{t("review.historyEmpty")}</p> : null}
                  {history?.decisions.map(item => <p key={item.decisionId}>{item.createdAt} · {item.actor} · {t(item.kind === "approve" ? "review.currentApproval" : "review.changesRequested")}{item.decisionId === selected.currentDecision?.decisionId ? "" : ` · ${t("review.earlier")}`}{item.reason ? ` · ${item.reason}` : ""}</p>)}
                  {history?.checks.map(item => <div key={item.runId} className="review-history-check"><p>{item.createdAt} · {t("review.qaRun")} · {item.validatorVersion}{item.runId === selected.currentCheck?.runId ? "" : ` · ${t("review.earlier")}`}</p>
                    <ul>{item.rules.map(rule => <li key={rule.rule}><strong>{ruleLabel(rule.rule)}</strong> — {ruleStatusLabel(rule.status)}
                      {rule.reason ? ` · ${ruleReasonLabel(rule.status)}` : ""}
                      {rule.findings.length > 0 ? <ul>{rule.findings.map(finding => <li key={finding.issueId}>{findingLabel(finding.rule, finding.code)}{finding.rule === "terminology" ? `: ${finding.detail}` : ""}</li>)}</ul> : null}
                    </li>)}</ul>
                  </div>)}
                  {history?.waivers.map(item => <p key={item.waiverId}>{item.createdAt} · {item.actor} · {t(item.grant ? "review.waived" : "review.revokeWaiver")}{selected.currentWaivers.some(waiver => waiver.waiverId === item.waiverId) ? "" : ` · ${t("review.earlier")}`}{item.reason ? ` · ${item.reason}` : ""}</p>)}
                  {history?.fallbacks.map(item => <p key={item.fallbackId}>{item.createdAt} · {item.actor} · {t(item.allow ? "review.fallbackActive" : "review.withdrawFallback")}{item.fallbackId === selected.currentFallback?.fallbackId ? "" : ` · ${t("review.earlier")}`}{item.reason ? ` · ${item.reason}` : ""}</p>)}
                  <div className="form-actions"><button className="secondary-button" disabled={busy || !targetAvailable || historyOffset === 0} onClick={() => void loadHistory(0)}>{t("review.previousPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || !history || history.nextOffset === null} onClick={() => void loadHistory(history!.nextOffset!)}>{t("review.historyMore")}</button></div>
                </details>
              </>}
            </section>
          </div> : null}
          {tab === "work" ? <section><div className="form-actions"><button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => void loadWork(0)}>{t("review.refresh")}</button></div>
            {!work ? <p>{t("review.selectEntry")}</p> : <><p>{t("review.workCount", { count: work.total })}</p>{work.items.length === 0 ? <p>{t("review.workEmpty")}</p> : work.items.map(item => <div key={item.unitId} className="review-work-item"><button className="text-button" disabled={!targetAvailable} onClick={() => void selectUnit(item.unitId)}>{item.nativeKey}</button><ul>{[...new Set(item.reasons.map(queueReason))].map(value => <li key={value}>{value}</li>)}</ul></div>)}
              <div className="form-actions"><button className="secondary-button" disabled={busy || !targetAvailable || workOffset === 0} onClick={() => void loadWork(0)}>{t("review.previousPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || work.nextOffset === null} onClick={() => void loadWork(work.nextOffset!)}>{t("review.nextPage")}</button></div></>}
          </section> : null}
          {tab === "eligibility" ? <section><p>{t("review.policy")}</p><p>{t("review.buildWarning")}</p><fieldset><legend>{t("review.chooseLanguages")}</legend>{project.metadata.targetLocales.map(value => <label key={value}><input type="checkbox" checked={languages.includes(value)} onChange={event => { setEligibility(null); setLanguages(previous => event.target.checked ? [...previous, value] : previous.filter(item => item !== value)); }} />{value}</label>)}</fieldset>
            <button className="primary-button" disabled={busy || languages.length === 0 || languages.some(value => !project.metadata.targetLocales.includes(value))} onClick={() => void assess()}>{t("review.assess")}</button>
            {eligibility ? <><h3>{t(eligibility.ready ? "review.ready" : "review.blocked")}</h3>{eligibility.locales.map(value => <div key={value.locale} className="review-eligibility"><h4>{value.locale}: {t(value.ready ? "review.ready" : "review.blocked")}</h4>
              <p>{t("review.blockers")}: {value.blockerCount}; {t("review.exceptions")}: {value.exceptionCount}</p>
              <ul>{value.blockers.map((item, index) => <li key={`${index}:${item.unitId}:${item.code}`}>{item.nativeKey}: {eligibilityReasonLabel(item)}</li>)}</ul>
              <ul>{value.exceptions.map((item, index) => <li key={`${index}:${item.unitId}:${item.code}`}>{item.nativeKey}: {eligibilityReasonLabel(item)}</li>)}</ul>
              {value.blockerCount > value.blockers.length || value.exceptionCount > value.exceptions.length ? <p>{t("review.moreReasons")}</p> : null}</div>)}</> : null}
          </section> : null}
        </> : null}
      </WorkbenchPanel>
    <Dialog.Root open={batchPrompt} onOpenChange={setBatchPrompt}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog"><Dialog.Title>{t("review.batchConfirm")}</Dialog.Title><Dialog.Description>{t("review.batchCount", { count: chosenCount })}</Dialog.Description><ul className="review-batch-list">{Object.values(chosen).map(item => <li key={draftKey(item)}>{item.locale}: {item.nativeKey}</li>)}</ul>{invalidChosenLocale ? <p>{t("review.removedTarget", { locale: invalidChosenLocale })}</p> : null}<div className="form-actions"><button className="secondary-button" onClick={() => setBatchPrompt(false)}>{t("review.stay")}</button><button className="primary-button" disabled={!!pending || !!invalidChosenLocale} onClick={() => void approveBatch()}>{t("review.batchStart")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={leavePrompt} onOpenChange={value => { if (!value && !busy) finishLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}><Dialog.Title>{t("review.leaveTitle")}</Dialog.Title><Dialog.Description>{t("review.leaveHelp")}</Dialog.Description><div className="form-actions"><button className="secondary-button" onClick={() => finishLeave(false)}>{t("review.stay")}</button><button className="primary-button" onClick={() => finishLeave(true)}>{t("review.discard")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
