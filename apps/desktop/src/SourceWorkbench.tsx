import { WorkbenchPanel, useWorkbenchView, useWorkbenchState, useWorkbenchRef } from "./WorkbenchFrame";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { QueryKey } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "./projectCommands";
import type { EditorTarget } from "./TranslationWorkbench";
import type { UiMessages } from "./i18n/types";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { useSourceDraftSession } from "./SourceDraftSession";
import { TaskCancellationFeedback, useExecutionTaskSession } from "./ExecutionTaskSession";
import { SourceHistoryPanel, SourceImpactPanel, SourceReadFeedback } from "./SourceMaintenance";
import { sourceReads } from "./sourceQueries";
import { useWorkbenchCommands, type CommandAvailability, type SourceSelectionCommandPayload, type SourceCaptureCommandPayload,
  type SourceBasisCommandPayload, type SourceComparisonCommandPayload, type SourcePendingCommandPayload,
  type SourceTaskCommandPayload, type SourcePageCommandPayload, type SourceHistoryContentCommandPayload } from "./workbenchCommands";
import { executionCommands as execution, executionContext } from "./executionCommands";
import { sourceCommands as commands, type ContentPage, type LineageChoice } from "./sourceCommands";

function cueTiming(basis: string): string | null {
  if (!basis.startsWith("{")) return null;
  try { const value = JSON.parse(basis) as { policy?: unknown; timing?: unknown }; return value.policy === "webvtt-cue/1" && typeof value.timing === "string" ? value.timing : null; } catch { return null; }
}
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
export interface SourceHandle { showAttempt: (id: string) => void; allowLeave: (current?: () => boolean) => Promise<boolean>; allowNavigate: () => Promise<boolean> }
export function SourceWorkbench({ project, disabled, onOpenWork, onOpenTranslation, ref }: { project: ProjectView; disabled: boolean; onOpenWork?: () => void; onOpenTranslation?: (target: EditorTarget, locale: string) => boolean | Promise<boolean>; ref?: Ref<SourceHandle> }) {
  const { t } = useTranslation(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const context = executionContext(project), commandScope = { ...context, area: "source" as const };
  const [open, setOpen] = useWorkbenchView("source");
  const owner = useSourceDraftSession(), tasks = useExecutionTaskSession();
  const { domain, selection, declared, preflight, attempt, comparison: fixedComparison, updating, lineage, actor, filter, appliedFilter,
    manualOrdinal, historicalQuery, estimate, confirmed, pendingStart, pendingApply, receiptChecked, checkingReceipt, busyMutation } = owner.state;
  const fixedPreview = owner.state.preview;
  const lastCompletion = useWorkbenchRef("source", "lastCompletion", owner.state.completionVersion);
  const [readIntent, setReadIntent] = useWorkbenchState<"auto" | "current" | "applied">("source", "readIntent", () => owner.current().receipt ? "applied" : "auto");
  const [contentCursor, setContentCursor] = useWorkbenchState<{ snapshotId: string; revision: string; after: number } | null>("source", "contentCursor", null);
  const [historyOffset, setHistoryOffset] = useWorkbenchState<number | null>("source", "historyOffset", null);
  const [captureBusy, setCaptureBusy] = useState(false), [captureFailure, setCaptureFailure] = useState<CommandFailure | null>(null);
  const [captureVersion, setCaptureVersion] = useState(0);
  const [leave, setLeave] = useState(false);
  const mounted = useRef(false), sequence = useRef(0), captureRunning = useRef(false);
  const committed = useRef({ open, disabled, leave, project });
  const leaveProof = useRef<(() => boolean) | null>(null);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const first = useRef<HTMLHeadingElement>(null), errorRegion = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; leaveResolver.current?.(false); }; }, []);
  useLayoutEffect(() => { committed.current = { open, disabled, leave, project }; });
  useLayoutEffect(() => { sequence.current++; captureRunning.current = false; setCaptureBusy(false); }, [open, project.sessionToken]);
  const integrationOptions = sourceReads.integration(context, domain);
  const integrationRead = useSessionQuery({ ...integrationOptions, enabled: open });
  const integration = !integrationRead.error ? integrationRead.data : undefined;
  const scopeOptions = sourceReads.scope(context), scopeRead = useSessionQuery({ ...scopeOptions, enabled: open });
  const scope = !scopeRead.error ? scopeRead.data : undefined;
  const snapshotId = readIntent === "applied" ? owner.state.receipt?.changes[0]?.id ?? null : scope?.currentSnapshot ?? null;
  const contentRevision = readIntent !== "applied" ? scope?.revision ?? "" : "";
  const contentAfter = contentCursor?.snapshotId === snapshotId && contentCursor.revision === contentRevision ? contentCursor.after : 0;
  const contentOptions = sourceReads.content(context, snapshotId ?? "", contentAfter, readIntent !== "applied" ? scope : undefined);
  const browsing = !attempt && !fixedPreview && !fixedComparison && !selection && !updating;
  // Explicit content reads coexist with newer fixed decisions retained after a delayed ACK.
  const contentVisible = browsing || readIntent !== "auto";
  const contentRead = useSessionQuery({ ...contentOptions, enabled: open && contentVisible && !!snapshotId && (readIntent === "applied" || !!scope) });
  const previewOptions = sourceReads.preview(context, fixedPreview, owner.state.previewAfter);
  const previewRead = useSessionQuery({ ...previewOptions, enabled: open && !!fixedPreview && owner.state.previewAfter > 0 });
  const comparisonOptions = sourceReads.comparison(context, fixedComparison, appliedFilter, owner.state.comparisonAfter);
  const comparisonRead = useSessionQuery({ ...comparisonOptions, enabled: open && !!fixedComparison });
  const comparison = fixedComparison;
  // A failed new filter/cursor must not impersonate the captured first page.
  const comparisonPage = comparisonRead.data ?? (owner.state.comparisonAfter === 0 && appliedFilter === "" ? fixedComparison : null);
  const previewPage = fixedPreview ? owner.state.previewAfter === 0 ? fixedPreview : previewRead.data ?? null : null;
  const contentPage = contentVisible && !contentRead.error ? contentRead.data ?? null : null;
  const page = previewPage ?? contentPage;
  const historyOptions = sourceReads.history(context, historyOffset ?? 0);
  const historyRead = useSessionQuery({ ...historyOptions, enabled: open && !!fixedComparison && historyOffset !== null });
  const history = !historyRead.error ? historyRead.data : undefined;
  const search = owner.state.historicalSearch;
  const matchesOptions = sourceReads.historyContent(context, search?.snapshotId ?? "", search?.query ?? "", search?.after ?? 0);
  const matchesEnabled = !!fixedComparison && !!search && search.snapshotId === fixedComparison.previousSnapshotId && search.newOrdinal === manualOrdinal;
  const matchesRead = useSessionQuery({ ...matchesOptions, enabled: open && matchesEnabled });
  const historicalMatches = matchesEnabled && !matchesRead.error ? matchesRead.data : undefined;
  const detailKey = ["source-attempt", attempt, 0, 100];
  const detailRead = useSessionQuery({ key: detailKey, scopes: ["execution"], enabled: open && !!attempt && !fixedPreview && !fixedComparison && !pendingStart,
    read: () => execution.attempt({ ...context, attemptId: attempt!, offset: 0, limit: 100 }) });
  const detail = detailRead.data ?? null;
  const busy = captureBusy || busyMutation;
  const failureValue = owner.state.failure ?? captureFailure ?? (open ? commandFailureOrNull(detailRead.error) : null);
  const failure = failureReason(failureValue);
  function commandFailureOrNull(error: unknown) { return error ? commandFailure(error) : null; }
  const setLineage = (value: Record<number, LineageChoice> | ((before: Record<number, LineageChoice>) => Record<number, LineageChoice>)) => owner.edit("lineage", value);
  const setActor = (value: string) => owner.edit("actor", value);
  const setFilter = (value: string) => owner.edit("filter", value);
  const setManualOrdinal = (value: number | null) => owner.edit("manualOrdinal", value);
  const setHistoricalQuery = (value: string) => owner.edit("historicalQuery", value);
  const setConfirmed = owner.confirm;
  function ready(key: QueryKey) { const state = reads.client.getQueryState(reads.key(key)); return state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated; }
  function viewCurrent() { const value = committed.current; return mounted.current && value.open && !value.leave && !value.disabled
    && value.project.sessionToken === context.sessionToken && value.project.metadata.projectId === context.projectId; }
  // Render uses reactive inputs; dispatched commands retain the committed-view guard.
  function common(pending = false, rendering = false): CommandAvailability {
    if (rendering ? !open || leave || disabled : !viewCurrent()) return { enabled: false, reason: "hidden" };
    if (captureRunning.current || owner.inFlight()) return { enabled: false, reason: "busy" };
    if (!pending && (owner.current().pendingApply || owner.current().pendingStart)) return { enabled: false, reason: "pending-action" };
    return { enabled: true };
  }
  // This proof excludes the command's own synchronous reservation.
  function proof(keys: QueryKey[]) {
    const ticket = sequence.current, locale = project.metadata.sourceLocale;
    const values = keys.map(key => reads.client.getQueryData(reads.key(key)));
    return () => viewCurrent() && sequence.current === ticket && committed.current.project.metadata.sourceLocale === locale
      && keys.every((key, index) => ready(key) && reads.client.getQueryData(reads.key(key)) === values[index]);
  }
  function selectionPayload(): SourceSelectionCommandPayload { return { kind: "source-selection", domain, integrationId: integration?.id ?? "", version: integration?.version ?? "" }; }
  function selectionAvailability(input?: SourceSelectionCommandPayload, rendering = false) {
    const allowed = common(false, rendering); return allowed.enabled && input && ready(scopeOptions.key) && (owner.current().updating || scope?.currentSnapshot === null)
      && ready(integrationOptions.key) && reads.client.getQueryData(reads.key(integrationOptions.key)) === integration && integration?.available && input.domain === owner.current().domain
      && input.integrationId === integration.id && input.version === integration.version && !attempt && !fixedPreview && !fixedComparison ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function capturePayload(): SourceCaptureCommandPayload { return { kind: "source-capture", selectionId: selection?.selectionId ?? "", sourceLanguage: project.metadata.sourceLocale }; }
  function captureAvailability(input?: SourceCaptureCommandPayload, start = false, rendering = false) {
    const allowed = common(false, rendering), value = owner.current(), currentProject = rendering ? project : committed.current.project;
    return allowed.enabled && input && ready(integrationOptions.key) && integration?.available && value.selection?.selectionId === input.selectionId && value.declared && value.sourceLanguage === input.sourceLanguage
      && currentProject.metadata.sourceLocale === input.sourceLanguage && (!start || (value.preflight && ready(scopeOptions.key))) ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function basisPayload(): SourceBasisCommandPayload { const value = owner.current(), basis = value.comparison ?? value.preview;
    return { kind: "source-basis", attemptId: basis?.attemptId ?? "", resultId: basis?.resultId ?? "", revision: basis?.scope.revision ?? "",
      currentSnapshot: basis?.scope.currentSnapshot ?? null, base: value.comparison?.previousSnapshotId ?? null, editSeq: value.editSeq }; }
  function matchingBasis(input?: SourceBasisCommandPayload) { const expected = basisPayload(); return !!input && input.attemptId === expected.attemptId && input.resultId === expected.resultId
    && input.revision === expected.revision && input.currentSnapshot === expected.currentSnapshot && input.base === expected.base && input.editSeq === expected.editSeq; }
  function basisAvailability(input?: SourceBasisCommandPayload, apply = false, rendering = false) {
    const allowed = common(false, rendering), value = owner.current(), basis = value.comparison ?? value.preview;
    const currentScope = reads.client.getQueryData<typeof scope>(reads.key(scopeOptions.key));
    return allowed.enabled && matchingBasis(input) && basis && !value.stale && !value.receipt && ready(scopeOptions.key)
      && currentScope?.revision === basis.scope.revision && currentScope?.currentSnapshot === basis.scope.currentSnapshot
      && (!value.comparison || ready(comparisonOptions.key)) && (!apply || (value.confirmed && (!value.comparison || (value.estimate
        && (!Object.keys(value.lineage).length || (value.actor.trim() && Object.values(value.lineage).every(choice => choice.reason.trim())))))))
      ? allowed : allowed.enabled ? unavailable : allowed;
  }
  function comparisonPayload(after = owner.state.comparisonAfter, query = appliedFilter, base: string | null = fixedComparison?.previousSnapshotId ?? null): SourceComparisonCommandPayload {
    const value = basisPayload(); return { ...value, kind: "source-comparison", originalBase: fixedComparison?.previousSnapshotId ?? "", base, filter: query, after };
  }
  function comparisonAvailability(input?: SourceComparisonCommandPayload, refresh = false, rendering = false) {
    const allowed = common(false, rendering);
    if (!allowed.enabled) return allowed;
    if (!fixedComparison || !input || !matchingBasis({ ...input, kind: "source-basis", base: input.originalBase }) || comparisonRead.isFetching || input.originalBase !== fixedComparison.previousSnapshotId) return unavailable;
    if (refresh) return input.after === 0 && ready(scopeOptions.key) && (input.base === null || input.base === fixedComparison.previousSnapshotId
      || (ready(historyOptions.key) && history?.snapshots.some(entry => entry.snapshotId === input.base))) ? allowed : unavailable;
    return input.base === fixedComparison.previousSnapshotId && (input.after === 0 || (input.filter === appliedFilter
      && (input.after === owner.current().comparisonAfter || (ready(comparisonOptions.key) && input.after === comparisonPage?.nextOrdinal)))) ? allowed : unavailable;
  }
  function pendingPayload(kind: "start" | "apply"): SourcePendingCommandPayload { const value = owner.current();
    return { kind: "source-pending", pendingKind: kind, attemptId: (kind === "start" ? value.pendingStart : value.pendingApply)?.attemptId ?? "",
      actionId: kind === "apply" ? value.pendingApply?.actionId ?? null : null, request: kind === "start" ? value.pendingStart : null }; }
  function pendingAvailability(input?: SourcePendingCommandPayload, checked = false, rendering = false) {
    const allowed = common(true, rendering); if (!allowed.enabled) return allowed;
    if (!input) return unavailable; const expected = pendingPayload(input.pendingKind);
    const actual = input.request, original = expected.request;
    const sameRequest = actual === null ? original === null : original !== null && actual.sessionToken === original.sessionToken
      && actual.projectId === original.projectId && actual.attemptId === original.attemptId
      && actual.selectionId === original.selectionId && actual.sourceLanguage === original.sourceLanguage;
    return expected.attemptId && input.attemptId === expected.attemptId && input.actionId === expected.actionId && sameRequest && (!checked || owner.current().receiptChecked) ? allowed : unavailable;
  }
  function taskPayload(): SourceTaskCommandPayload { return { kind: "source-task", attemptId: attempt ?? "", taskId: detail?.taskId ?? "" }; }
  function taskAvailability(input?: SourceTaskCommandPayload, rendering = false) { const allowed = common(false, rendering); return allowed.enabled && input && ready(detailKey)
    && input.attemptId === owner.current().attempt && input.taskId === detail?.taskId && !fixedPreview && !fixedComparison
    && tasks.canCancel({ taskId: input.taskId, attemptId: input.attemptId, origin: "source" }) ? allowed : allowed.enabled ? unavailable : allowed; }
  function pagePayload(page: ContentPage, after: number): SourcePageCommandPayload { return { kind: "source-page", snapshotId: page.snapshotId, attemptId: page.attemptId,
    resultId: page.resultId, after }; }
  function pageAvailability(input?: SourcePageCommandPayload, rendering = false) {
    const allowed = common(false, rendering); if (!allowed.enabled) return allowed;
    const preview = input?.snapshotId === null, basis = preview ? fixedPreview : contentVisible ? contentRead.data : null;
    if (!input || !basis || input.snapshotId !== basis.snapshotId || input.attemptId !== basis.attemptId || input.resultId !== basis.resultId
      || (!preview && input.snapshotId !== snapshotId) || (preview ? previewRead.isFetching : contentRead.isFetching)) return unavailable;
    const cursor = preview ? owner.current().previewAfter : contentAfter;
    const key = preview ? previewOptions.key : contentOptions.key, displayed = preview ? previewPage : contentPage;
    return input.after === 0 || input.after === cursor || (ready(key) && input.after === displayed?.nextOrdinal)
      || (preview && cursor === 0 && input.after === fixedPreview?.nextOrdinal) ? allowed : unavailable;
  }
  function historyPayload(after = 0, query = historicalQuery): SourceHistoryContentCommandPayload { return { kind: "source-history-content",
    snapshotId: fixedComparison?.previousSnapshotId ?? "", query, after, newOrdinal: manualOrdinal }; }
  function historyAvailability(input?: SourceHistoryContentCommandPayload, rendering = false) {
    const allowed = common(false, rendering); if (!allowed.enabled) return allowed;
    if (!fixedComparison || !input || input.snapshotId !== fixedComparison.previousSnapshotId || input.newOrdinal !== owner.current().manualOrdinal || input.newOrdinal === null || matchesRead.isFetching) return unavailable;
    return input.after === 0 || (search && input.query === search.query && (input.after === search.after || (ready(matchesOptions.key) && input.after === historicalMatches?.nextOrdinal))) ? allowed : unavailable;
  }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (!common().enabled) return;
    captureRunning.current = true;
    const ticket = ++sequence.current, current = () => viewCurrent() && sequence.current === ticket;
    setCaptureBusy(true); setCaptureFailure(null);
    try { await work(current); } catch (error) { if (current()) setCaptureFailure(commandFailure(error)); }
    finally { if (mounted.current && sequence.current === ticket) { captureRunning.current = false; setCaptureBusy(false); } }
  }
  function readCurrent(intent: "current" | "applied") {
    setReadIntent(intent); setContentCursor(null);
    if (readIntent === intent && snapshotId && contentAfter === 0) void contentRead.refetch();
    if (intent === "current") void scopeRead.refetch();
  }
  function setComparisonIntent(input: SourceComparisonCommandPayload) {
    if (owner.current().comparisonAfter === input.after && owner.current().appliedFilter === input.filter) void comparisonRead.refetch();
    else owner.pageIntent(input.after, input.filter);
  }
  async function refreshComparison(input: SourceComparisonCommandPayload) {
    const before = owner.current();
    await perform(async current => {
      const result = await scopeRead.refetch();
      if (result.error) throw result.error;
      const currentScope = result.data;
      if (!current() || owner.current().comparison !== before.comparison || owner.current().editSeq !== before.editSeq || !currentScope) return;
      const check = proof([scopeOptions.key]);
      const next = await commands.compare({ ...context, attemptId: input.attemptId, resultId: input.resultId, base: input.base, filter: input.filter, after: 0, limit: 50 });
      if (current() && check() && owner.current().comparison === before.comparison && owner.current().editSeq === before.editSeq
        && next.scope.revision === currentScope?.revision && next.scope.currentSnapshot === currentScope?.currentSnapshot) owner.page(next, input.filter, true);
    });
  }
  useLayoutEffect(() => {
    const meta = { category: "source" as const, binding: null, risk: "reads-source" as const, confirmation: "none" as const, scope: commandScope };
    const removals = [
      registry.register({ ...meta, id: "source.select", nameKey: "source.select", risk: "captures-source", payloadKind: "source-selection", availability: selectionAvailability, handler: () => { setReadIntent("auto"); setCaptureFailure(null); void owner.select(); } }),
      registry.register({ ...meta, id: "source.preflight", nameKey: "source.preflight", risk: "captures-source", payloadKind: "source-capture", availability: input => captureAvailability(input), handler: () => void owner.preflight() }),
      registry.register({ ...meta, id: "source.start", nameKey: "source.start", risk: "captures-source", payloadKind: "source-capture", availability: input => captureAvailability(input, true), handler: () => void owner.start(proof([scopeOptions.key, integrationOptions.key])) }),
      registry.register({ ...meta, id: "source.apply", nameKey: fixedComparison ? "source.applyUpdate" : "source.apply", risk: "writes-source", confirmation: "required", payloadKind: "source-basis", availability: input => basisAvailability(input, true), handler: () => void owner.apply(proof(fixedComparison ? [scopeOptions.key, comparisonOptions.key] : [scopeOptions.key])) }),
      registry.register({ ...meta, id: "source.estimate", nameKey: "source.reviewImpact", payloadKind: "source-basis", availability: input => fixedComparison ? basisAvailability(input) : unavailable, handler: () => void owner.estimate(proof([scopeOptions.key, comparisonOptions.key])) }),
      registry.register({ ...meta, id: "source.search-comparison", nameKey: "source.search", payloadKind: "source-comparison", availability: input => comparisonAvailability(input), handler: setComparisonIntent }),
      registry.register({ ...meta, id: "source.refresh-comparison", nameKey: "source.refreshComparison", payloadKind: "source-comparison", availability: input => comparisonAvailability(input, true), handler: input => void refreshComparison(input) }),
      registry.register({ ...meta, id: "source.check-start", nameKey: "source.checkStart", risk: "reads-source", payloadKind: "source-pending", availability: input => input?.pendingKind === "start" ? pendingAvailability(input) : unavailable, handler: () => void owner.checkStart() }),
      registry.register({ ...meta, id: "source.retry-start", nameKey: "source.retryStart", risk: "retries-source-action", payloadKind: "source-pending", availability: input => input?.pendingKind === "start" && owner.current().startRetryAllowed ? pendingAvailability(input) : unavailable, handler: () => void owner.retryStart() }),
      registry.register({ ...meta, id: "source.check-receipt", nameKey: "execution.checkReceipt", risk: "reads-source", payloadKind: "source-pending", availability: input => input?.pendingKind === "apply" ? pendingAvailability(input) : unavailable, handler: () => void owner.checkReceipt() }),
      registry.register({ ...meta, id: "source.retry-apply", nameKey: "execution.retryAdoption", risk: "retries-source-action", payloadKind: "source-pending", availability: input => input?.pendingKind === "apply" ? pendingAvailability(input, true) : unavailable, handler: () => void owner.retryApply() }),
      registry.register({ ...meta, id: "source.keep-output", nameKey: "execution.keepOutput", payloadKind: "source-pending", availability: input => input?.pendingKind === "apply" ? pendingAvailability(input, true) : unavailable, handler: owner.keepOutput }),
      registry.register({ ...meta, id: "source.cancel-task", nameKey: "execution.cancel", risk: "cancels-source-task", payloadKind: "source-task", availability: taskAvailability, handler: input => void owner.cancelTask(input.taskId, () => owner.current().attempt === input.attemptId) }),
      registry.register({ ...meta, id: "source.read-page", nameKey: "execution.nextPage", payloadKind: "source-page", availability: pageAvailability, handler: input => {
        if (input.snapshotId === null) { if (input.after === owner.current().previewAfter) void previewRead.refetch(); else owner.pageIntent(input.after); }
        else if (input.after === contentAfter) void contentRead.refetch(); else setContentCursor({ snapshotId: input.snapshotId!, revision: contentRevision, after: input.after });
      } }),
      registry.register({ ...meta, id: "source.find-lineage-candidates", nameKey: "source.search", payloadKind: "source-history-content", availability: historyAvailability, handler: input => {
        if (search?.after === input.after && search.query === input.query && search.newOrdinal === input.newOrdinal) void matchesRead.refetch(); else owner.historyIntent(input.query, input.after);
      } }),
      registry.register({ ...meta, id: "source.discard", nameKey: "source.discard", availability: common, handler: () => void owner.discard() }),
      registry.register({ ...meta, id: "source.begin-update", nameKey: "source.update", availability: () => {
        const allowed = common(); return allowed.enabled && browsing && contentPage?.snapshotId && contentPage.snapshotId === scope?.currentSnapshot && ready(contentOptions.key) && ready(integrationOptions.key) && integration?.available ? allowed : unavailable;
      }, handler: () => { sequence.current++; setReadIntent("auto"); owner.beginUpdate(); setCaptureFailure(null); } }),
      registry.register({ ...meta, id: "source.show-current", nameKey: "source.viewCurrent", availability: () => common().enabled && !Object.keys(owner.current().lineage).length ? common() : unavailable,
        handler: () => { owner.showCurrent(); readCurrent("current"); } }),
      registry.register({ ...meta, id: "source.read-current", nameKey: "source.viewCurrent", availability: common, handler: () => readCurrent("current") }),
      registry.register({ ...meta, id: "source.read-applied", nameKey: "source.readSaved", availability: () => common().enabled && owner.current().receipt ? common() : unavailable, handler: () => readCurrent("applied") }),
      registry.register({ ...meta, id: "source.refresh-attempt", nameKey: "execution.refresh", availability: () => common().enabled && !!attempt && !fixedPreview && !fixedComparison ? common() : unavailable, handler: () => { setCaptureFailure(null); void detailRead.refetch(); } }),
    ];
    return () => removals.forEach(remove => remove());
  });
  useImperativeHandle(ref, () => ({
    showAttempt(id) { if (owner.showAttempt(id)) { sequence.current++; captureRunning.current = false; setCaptureBusy(false); setReadIntent("auto"); setContentCursor(null); setCaptureFailure(null); } setOpen(true); },
    allowNavigate() { return Promise.resolve(!busy && !owner.inFlight() && !owner.current().pendingApply && !owner.current().pendingStart); },
    allowLeave(current: () => boolean = () => true) {
      leaveProof.current = current; const value = owner.current(); if (value.pendingApply || value.pendingStart) { setOpen(true); return Promise.resolve(false); }
      if (!value.selection && !Object.keys(value.lineage).length && !value.actor.trim() && !busy && !owner.inFlight()) return Promise.resolve(true);
      setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; }); },
  }));
  // Initial preparation is a deliberate fixed capture, never a query refresh.
  useEffect(() => {
    if (!open || busyMutation || !attempt || fixedPreview || fixedComparison || !detail || !ready(detailKey) || captureRunning.current) return;
    const ticket = ++sequence.current;
    let stopped = false;
    const current = () => !stopped && viewCurrent() && ticket === sequence.current && owner.current().attempt === attempt;
    const result = detail.items[0];
    if (result?.resultId && result.status.validation === "valid" && result.status.execution === "succeeded") {
      captureRunning.current = true; setCaptureBusy(true);
      void (async () => {
        try {
          const scopeResult = await scopeRead.refetch(); if (scopeResult.error) throw scopeResult.error;
          const currentScope = scopeResult.data; if (!current() || !currentScope) return;
          const next = currentScope.currentSnapshot
            ? await commands.compare({ ...context, attemptId: attempt, resultId: result.resultId!, after: 0, limit: 50 })
            : await commands.preview({ ...context, attemptId: attempt, resultId: result.resultId!, after: 0, limit: 50 });
          if (current()) { owner.ready(next, detail); setCaptureFailure(null); }
        } catch (error) { if (current()) setCaptureFailure(commandFailure(error)); }
        finally { if (mounted.current && ticket === sequence.current) {
          captureRunning.current = false; setCaptureBusy(false);
          // A newer attempt read can supersede preparation without losing its continuation.
          const value = owner.current();
          if (stopped && viewCurrent() && value.attempt === attempt && !value.preview && !value.comparison) setCaptureVersion(version => version + 1);
        } }
      })();
    } else if (result?.status.execution === "failed" || result?.status.validation === "invalid") setCaptureFailure(result.status.diagnostic ?? "output-invalid");
    else if (result?.status.execution === "unknown" || result?.status.execution === "cancelled-before-dispatch") setCaptureFailure(result.status.execution);
    return () => { stopped = true; };
  }, [open, busyMutation, attempt, fixedPreview, fixedComparison, detail, detailRead.fetchStatus, detailRead.error, captureVersion, project.sessionToken]);
  useEffect(() => {
    if (lastCompletion.current === owner.state.completionVersion) return;
    lastCompletion.current = owner.state.completionVersion;
    if (owner.state.receipt) { setReadIntent("applied"); setContentCursor(null); }
  }, [owner.state.completionVersion]);
  useEffect(() => { if (fixedPreview || fixedComparison) first.current?.focus(); }, [fixedPreview, fixedComparison]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  function requestBack() { if (!captureRunning.current && !owner.inFlight() && !owner.current().pendingApply && !owner.current().pendingStart) setOpen(false); }
  const knownErrors: Record<string, keyof UiMessages["source"]["errors"]> = {
    "unsupported-encoding": "encoding", "source-changed": "changed", "duplicate-native-key": "duplicate", "empty-source": "empty", "capture-timeout": "timeout", "extract-timeout": "unknown", "source-corrupt": "invalid", "stale-preview": "conflict", "language-required": "language",
    "vtt-header": "webvtt", "vtt-timing": "webvtt", "vtt-setting": "webvtt", "vtt-region": "webvtt", "vtt-block": "webvtt", "vtt-cue-id": "webvtt", "vtt-order": "webvtt", "vtt-payload": "webvtt", "unsupported-format": "format", "missing-companion": "missing", "language-conflict": "language", "limit-exceeded": "limit", "input-limit": "limit", "unauthorized-selection": "selection", "session-invalid": "selection", "input-busy": "busy", busy: "busy", "source-already-present": "conflict", "source-namespace": "namespace", "source-unchanged": "unchanged", "lineage-choice": "lineage", "lineage-split": "lineage", "dependency-conflict": "conflict", "output-invalid": "invalid", "invalid-structure": "invalid", "invalid-json": "invalid", "source-value-not-string": "stringValue", cancelled: "cancelled", "cancelled-before-dispatch": "cancelled", unknown: "unknown", "outcome-unknown": "unknown",
  };
  const locked = busy || pendingStart !== null || pendingApply !== null;
  const warnings = page?.diagnostics ?? preflight?.diagnostics ?? [];
  return <>
    <WorkbenchPanel open={open} title={t("source.title")} description={t("source.description")} className="source-dialog" onBack={() => void requestBack()} backDisabled={disabled || busy}>
        <div className="execution-content" aria-busy={busy}>
          {integration ? <><p>{t("source.profile", { version: integration.version, name: integration.id === "webvtt" ? "WebVTT" : "Stardew SMAPI", profile: integration.formatProfiles.join(", ") })}</p>{!integration.available ? <p role="alert">{t("source.unavailable")}</p> : null}</> : <p role="status">{t("source.loadingIntegration")}</p>}
          <TaskCancellationFeedback origin="source" taskId={detail?.taskId} disabled={busy} visible={open} />
          {failure ? <div ref={errorRegion} role="alert" tabIndex={-1}><p>{t(`source.errors.${knownErrors[failure] ?? "failed"}`)}</p><CommandFailureDetails failure={failureValue} />{typeof failureValue === "string" ? <details><summary>{t("execution.diagnostic")}</summary><code>{failure}</code></details> : null}</div> : null}
          {busy && !checkingReceipt ? <p role="status">{t("execution.working")}</p> : null}
          <SourceReadFeedback error={open ? integrationRead.error || scopeRead.error : null} fetching={open && (integrationRead.isFetching || scopeRead.isFetching)} messageKey="source.readFailed" retry={() => {
            if (integrationRead.error) void integrationRead.refetch(); if (scopeRead.error) void scopeRead.refetch();
          }} />
          <SourceReadFeedback error={contentVisible ? contentRead.error : null} fetching={open && contentVisible && contentRead.isFetching} messageKey="source.readFailed" retry={() => void contentRead.refetch()} />
          {contentVisible && contentAfter > 0 && !contentPage ? <button className="secondary-button" disabled={!common(false, true).enabled || contentRead.isFetching} onClick={() => registry.dispatch(readIntent === "applied" ? "source.read-applied" : "source.read-current", commandScope)}>{t("execution.firstPage")}</button> : null}
          {fixedPreview && owner.state.previewAfter > 0 ? <SourceReadFeedback error={previewRead.error} fetching={open && previewRead.isFetching} messageKey="source.readFailed" retry={() => void previewRead.refetch()} /> : null}
          {fixedPreview && owner.state.previewAfter > 0 && !previewPage ? <button className="secondary-button" disabled={!pageAvailability({ kind: "source-page", snapshotId: null, attemptId: fixedPreview.attemptId, resultId: fixedPreview.resultId, after: 0 }, true).enabled} onClick={() => registry.dispatch("source.read-page", commandScope, { kind: "source-page", snapshotId: null, attemptId: fixedPreview.attemptId, resultId: fixedPreview.resultId, after: 0 })}>{t("execution.firstPage")}</button> : null}
          {fixedComparison ? <SourceReadFeedback error={comparisonRead.error} fetching={open && comparisonRead.isFetching} messageKey="source.readFailed" retry={() => void comparisonRead.refetch()} /> : null}
          {owner.state.receipt ? <p role="status">{t(owner.state.stale ? "source.adoptionSavedNewer" : "source.adoptionSaved")} <button className="text-button" disabled={busy} onClick={() => registry.dispatch("source.read-applied", commandScope)}>{t("source.readSaved")}</button></p> : null}
          {owner.state.stale && (comparison || owner.state.preview) ? <p role="alert">{t("source.comparisonChanged")}</p> : null}
          {warnings.includes("source-template") ? <p role="status">{t("source.templateWarning")}</p> : null}
          {!page && !comparison && !attempt ? <section aria-label={t(domain === "webvtt" ? "source.webvttSelect" : "source.select")}>
            <label className="source-field">{t("source.integration")}<select disabled={locked || updating} value={domain} onChange={event => { sequence.current++; owner.setDomain(event.target.value); setCaptureFailure(null); }}><option value="stardew-smapi">Stardew SMAPI</option><option value="webvtt">WebVTT</option></select></label>
            {updating ? <p role="status">{t("source.updateIntro")}</p> : null}
            <p>{t(domain === "webvtt" ? "source.webvttSupport" : "source.support")}</p>
            <button className="secondary-button" disabled={!selectionAvailability(selectionPayload(), true).enabled} onClick={() => registry.dispatch("source.select", commandScope, selectionPayload())}>{t(domain === "webvtt" ? "source.webvttSelect" : "source.select")}</button>
            {selection ? <>
              <p>{selection.folderName}</p>
              <label className="source-check"><input type="checkbox" checked={declared} disabled={locked} onChange={event => { owner.declare(event.target.checked); }} />{t("source.language", { language: project.metadata.sourceLocale })}</label>
              <p>{t("source.languageHelp", { file: domain === "webvtt" ? "source.vtt" : "default.json" })}</p>
              <button className="secondary-button" disabled={!captureAvailability(capturePayload(), false, true).enabled} onClick={() => registry.dispatch("source.preflight", commandScope, capturePayload())}>{t("source.preflight")}</button>
              {preflight ? <><p>{t("source.preflightResult", { namespace: preflight.namespace, count: preflight.count })}</p>
                <button className="primary-button" disabled={!captureAvailability(capturePayload(), true, true).enabled} onClick={() => registry.dispatch("source.start", commandScope, capturePayload())}>{t("source.start")}</button></> : null}
              <button className="text-button" disabled={!common(false, true).enabled} onClick={() => registry.dispatch("source.discard", commandScope)}>{t("source.discard")}</button>
            </> : null}
          </section> : null}
          {pendingStart ? <section role="status"><p>{t(owner.state.checkingStart ? "execution.checkingStart" : "source.startUnknown")}</p><button className="secondary-button" disabled={!pendingAvailability(pendingPayload("start"), false, true).enabled} onClick={() => registry.dispatch("source.check-start", commandScope, pendingPayload("start"))}>{t("source.checkStart")}</button>{owner.state.startRetryAllowed ? <button className="secondary-button" disabled={!pendingAvailability(pendingPayload("start"), false, true).enabled} onClick={() => registry.dispatch("source.retry-start", commandScope, pendingPayload("start"))}>{t("source.retryStart")}</button> : null}</section> : null}
          {attempt && !page && !comparison ? <section><p role="status">{t("source.savedTask")}</p><p>{t("source.taskHelp")}</p>
            {detail ? <button className="secondary-button" disabled={!taskAvailability(taskPayload(), true).enabled} onClick={() => registry.dispatch("source.cancel-task", commandScope, taskPayload())}>{t("execution.cancel")}</button> : null}
            <button className="secondary-button" disabled={!common(false, true).enabled || detailRead.isFetching} onClick={() => registry.dispatch("source.refresh-attempt", commandScope)}>{t("execution.refresh")}</button>
          </section> : null}
          {[previewPage, contentPage].map(page => page ? <section key={page.snapshotId ?? "preview"}>
            <h3 ref={!page.snapshotId || !previewPage ? first : undefined} tabIndex={-1}>{t(page.snapshotId ? "source.imported" : "source.preview")}</h3>
            <p role="status">{t("source.range", { namespace: page.namespace, count: page.total, language: page.confirmation.sourceLanguage })}</p>
            <ul>{page.coverage.map(file => <li key={file.artifactId}>{file.logicalPath}<details><summary>{t("source.fingerprint")}</summary><code>{file.sha256}</code></details></li>)}</ul>
            <p>{t("source.identityHelp")}</p>
            <div className="source-table-scroll"><table className="source-table"><caption>{t("source.pageRange", { first: String((page.rows[0]?.occurrence.ordinal ?? 0) + 1), last: String((page.rows.at(-1)?.occurrence.ordinal ?? -1) + 1), total: String(page.total) })}</caption><thead><tr><th scope="col">{t("source.key")}</th><th scope="col">{t("source.text")}</th></tr></thead><tbody>{page.rows.map(row => <tr key={row.occurrence.ordinal}><th scope="row">{row.occurrence.key}{cueTiming(row.occurrence.identityBasis) ? <p>{cueTiming(row.occurrence.identityBasis)}</p> : null}<details><summary>{t("source.origin")}</summary><p>{row.occurrence.namespace}</p><p>{t("source.bytes", { start: String(row.occurrence.valueByteRange[0]), end: String(row.occurrence.valueByteRange[1]) })}</p>{row.unitId ? <code>{row.unitId}</code> : null}</details></th><td><pre>{row.occurrence.text || t("source.emptyText")}</pre></td></tr>)}</tbody></table></div>
            <div className="execution-actions">{[0, page.nextOrdinal].map((after, index) => after !== null ? <button className="secondary-button" key={index} disabled={!pageAvailability(pagePayload(page, after), true).enabled || (index === 0 && (page.snapshotId === null ? owner.state.previewAfter : contentAfter) === 0)} onClick={() => registry.dispatch("source.read-page", commandScope, pagePayload(page, after))}>{t(index === 0 ? "execution.firstPage" : "execution.nextPage")}</button> : null)}</div>
            {!page.snapshotId ? <>
              <label className="source-check"><input type="checkbox" disabled={!basisAvailability(basisPayload(), false, true).enabled || page.scope.currentSnapshot !== null} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("source.confirm", { count: page.total, language: page.confirmation.sourceLanguage })}</label>
              <p>{t("source.applyHelp")}</p>
              {page.scope.currentSnapshot ? <p>{t("source.errors.conflict")}</p> : null}
              <button className="primary-button" disabled={!basisAvailability(basisPayload(), true, true).enabled || page.scope.currentSnapshot !== null} onClick={() => registry.dispatch("source.apply", commandScope, basisPayload())}>{t("source.apply")}</button>
            </> : null}
            {page.snapshotId && browsing && page.snapshotId === page.scope.currentSnapshot ? <button className="primary-button" disabled={!common(false, true).enabled || !ready(contentOptions.key) || !ready(integrationOptions.key) || !integration?.available || page.snapshotId !== scope?.currentSnapshot} onClick={() => registry.dispatch("source.begin-update", commandScope)}>{t("source.update")}</button> : null}
          </section> : null)}
          {comparison ? <section>
            <h3 ref={first} tabIndex={-1}>{t("source.compareTitle")}</h3>
            <p role="status">{t("source.compareSummary", { unchanged: String(comparison.unchanged), moved: String(comparison.moved), changed: String(comparison.changed), added: String(comparison.added), ambiguous: String(comparison.ambiguous), removed: String(comparison.removed) })}</p>
            <p>{t(domain === "webvtt" ? "source.webvttCompareHelp" : "source.compareHelp")}</p>
            <label className="source-field">{t("source.mappingActor")}<input disabled={locked} value={actor} onChange={event => setActor(event.target.value)} maxLength={128} autoComplete="name" /></label>
            <label className="source-field">{t("source.comparisonFilter")}<input disabled={locked} value={filter} maxLength={256} onChange={event => setFilter(event.target.value)} /></label>
            <button className="secondary-button" disabled={!comparisonAvailability(comparisonPayload(0, filter), false, true).enabled} onClick={() => registry.dispatch("source.search-comparison", commandScope, comparisonPayload(0, filter))}>{t("source.search")}</button>
            <button className="secondary-button" disabled={!comparisonAvailability(comparisonPayload(0, filter, Object.keys(lineage).length ? fixedComparison!.previousSnapshotId : null), true, true).enabled} onClick={() => registry.dispatch("source.refresh-comparison", commandScope, comparisonPayload(0, filter, Object.keys(lineage).length ? fixedComparison!.previousSnapshotId : null))}>{t("source.refreshComparison")}</button>
            {comparisonPage ? <p>{t("source.filteredRange", { count: comparisonPage.filteredTotal, total: String(comparison.total) })}</p> : null}
            {history ? <label className="source-field">{t("source.comparisonBase")}<select disabled={locked} value={comparison.previousSnapshotId} onChange={event => registry.dispatch("source.refresh-comparison", commandScope, comparisonPayload(0, filter, event.target.value))}>
              {history.snapshots.map(entry => <option key={entry.snapshotId} value={entry.snapshotId}>{t("source.snapshotLabel", { revision: String(entry.revision) })} · {t(entry.current ? "source.currentSnapshot" : "source.historicalSnapshot")}</option>)}
            </select></label> : null}
            {comparisonPage ? <div className="source-table-scroll"><table className="source-table source-comparison-table"><caption>{t("source.changePage", { count: comparisonPage.rows.length, total: String(comparison.total) })}</caption><thead><tr><th scope="col">{t("source.changeKind")}</th><th scope="col">{t("source.previous")}</th><th scope="col">{t("source.next")}</th><th scope="col">{t("source.mapping")}</th></tr></thead><tbody>{comparisonPage.rows.map((row,index) => {
              const ordinal = row.new?.ordinal;
              const selected = ordinal === undefined ? undefined : lineage[ordinal];
              const defaultChoice = row.kind === "unchanged" || row.kind === "moved" ? "automatic" : "unresolved";
              return <tr key={`${row.new?.key ?? row.old?.occurrence.key}:${index}`}><th scope="row">{t(`source.change.${row.kind}`)}</th>
                <td>{row.old ? <><strong>{row.old.occurrence.key}</strong><pre>{row.old.occurrence.text || t("source.emptyText")}</pre><small>{cueTiming(row.old.occurrence.identityBasis) ?? "i18n/default.json"} · {row.old.occurrence.valueByteRange.join("–")}</small></> : row.candidates.length ? <ul>{row.candidates.map(candidate => <li key={candidate.occurrenceId}>{t("source.candidate", { key: candidate.occurrence.key, text: candidate.occurrence.text })}</li>)}</ul> : "—"}</td>
                <td>{row.new ? <><strong>{row.new.key}</strong><pre>{row.new.text || t("source.emptyText")}</pre><small>{cueTiming(row.new.identityBasis) ?? "i18n/default.json"} · {row.new.valueByteRange.join("–")}</small></> : "—"}</td>
                <td>{ordinal !== undefined ? <><label className="source-field">{t("source.mapping")}
                  <select disabled={locked} value={selected ? `${selected.decision}:${selected.oldOccurrenceId}` : defaultChoice} onChange={event => {
                    const [decision, oldOccurrenceId] = event.target.value.split(":");
                    setLineage(current => {
                      const next = { ...current };
                      if (decision === "automatic" || decision === "unresolved") delete next[ordinal];
                      else next[ordinal] = { newOrdinal: ordinal, oldOccurrenceId, decision: decision as "continue" | "reject", reason: "" };
                      return next;
                    });
                    setConfirmed(false);
                  }}>
                    <option value={defaultChoice}>{t(`source.mappingChoice.${defaultChoice}`)}</option>
                    {row.candidates.flatMap(candidate => candidate.occurrenceId ? [
                      <option key={`continue:${candidate.occurrenceId}`} value={`continue:${candidate.occurrenceId}`}>{t("source.mappingChoice.continue")} · {candidate.occurrence.key}</option>,
                      <option key={`reject:${candidate.occurrenceId}`} value={`reject:${candidate.occurrenceId}`}>{t("source.mappingChoice.reject")} · {candidate.occurrence.key}</option>,
                    ] : [])}
                    {selected && !row.candidates.some(candidate => candidate.occurrenceId === selected.oldOccurrenceId) ? <option value={`${selected.decision}:${selected.oldOccurrenceId}`}>{t(`source.mappingChoice.${selected.decision}`)} · {historicalMatches?.rows.find(item => item.occurrenceId === selected.oldOccurrenceId)?.occurrence.key ?? t("source.historicalSnapshot")}</option> : null}
                  </select></label>{selected ? <label className="source-field">{t("source.mappingReason")}<textarea disabled={locked} value={selected.reason} maxLength={4096} onChange={event => { setLineage(current => ({ ...current, [ordinal]: { ...current[ordinal], reason: event.target.value } })); setConfirmed(false); }} /></label> : null}
                  <button className="text-button" disabled={locked} onClick={() => { setManualOrdinal(ordinal); }}>{t("source.chooseHistorical")}</button>
                </> : t("source.noMapping")}</td></tr>;
            })}</tbody></table></div> : null}
            <div className="execution-actions">{[0,comparisonPage?.nextOrdinal ?? null].map((after,index) => after !== null ? <button className="secondary-button" key={index} disabled={!comparisonAvailability(comparisonPayload(after), false, true).enabled || (index === 0 && owner.state.comparisonAfter === 0)} onClick={() => registry.dispatch("source.search-comparison", commandScope, comparisonPayload(after))}>{t(index === 0 ? "execution.firstPage" : "execution.nextPage")}</button> : null)}</div>
            {manualOrdinal !== null ? <section className="source-maintenance-panel"><h4>{t("source.manualTarget", { key: comparisonPage?.rows.find(row => row.new?.ordinal === manualOrdinal)?.new?.key ?? String(manualOrdinal + 1) })}</h4>
              <label className="source-field">{t("source.searchHistory")}<input disabled={locked} maxLength={256} value={historicalQuery} onChange={event => setHistoricalQuery(event.target.value)} /></label>
              <button className="secondary-button" disabled={!historyAvailability(historyPayload(), true).enabled} onClick={() => registry.dispatch("source.find-lineage-candidates", commandScope, historyPayload())}>{t("source.search")}</button>
              {matchesEnabled ? <SourceReadFeedback error={matchesRead.error} fetching={open && matchesRead.isFetching} retry={() => registry.dispatch("source.find-lineage-candidates", commandScope, historyPayload(search!.after, search!.query))} /> : null}
              {matchesEnabled && search!.after > 0 ? <button className="secondary-button" disabled={!historyAvailability(historyPayload(0, search!.query), true).enabled} onClick={() => registry.dispatch("source.find-lineage-candidates", commandScope, historyPayload(0, search!.query))}>{t("execution.firstPage")}</button> : null}
              {historicalMatches ? <><p>{t("source.historyMatches", { count: historicalMatches.total })}</p><ul>{historicalMatches.rows.map(row => <li key={row.occurrenceId}><strong>{row.occurrence.key}</strong><pre>{row.occurrence.text}</pre>{(["continue", "reject"] as const).map(decision => <button className="text-button" key={decision} disabled={locked} onClick={() => { setLineage(current => ({ ...current, [manualOrdinal]: { newOrdinal: manualOrdinal, oldOccurrenceId: row.occurrenceId!, decision, reason: "" } })); setConfirmed(false); }}>{t(`source.mappingChoice.${decision}`)}</button>)}</li>)}</ul>{historicalMatches.nextOrdinal !== null ? <button className="secondary-button" disabled={!historyAvailability(historyPayload(historicalMatches.nextOrdinal!, search!.query), true).enabled} onClick={() => registry.dispatch("source.find-lineage-candidates", commandScope, historyPayload(historicalMatches.nextOrdinal!, search!.query))}>{t("execution.nextPage")}</button> : null}</> : null}
            </section> : null}
            <button className="secondary-button" disabled={!basisAvailability(basisPayload(), false, true).enabled} onClick={() => registry.dispatch("source.estimate", commandScope, basisPayload())}>{t("source.reviewImpact")}</button>
            <p>{t("source.estimateHelp")}</p>{estimate?.map(summary => <p key={summary.locale}>{t("source.impactSummary", { locale: summary.locale, preserved: String(summary.preserved), reassess: String(summary.reassess), unresolved: String(summary.unresolved), total: String(summary.total) })}</p>)}
            <label className="source-check"><input type="checkbox" disabled={!basisAvailability(basisPayload(), false, true).enabled || !estimate} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("source.updateConfirm", { count: comparison.total })}</label>
            <p>{t("source.updateImpact")}</p>
            <button className="primary-button" disabled={!basisAvailability(basisPayload(), true, true).enabled} onClick={() => registry.dispatch("source.apply", commandScope, basisPayload())}>{t("source.applyUpdate")}</button>
          </section> : null}
          {pendingApply && (!busy || checkingReceipt) ? <section><p role="status">{t(checkingReceipt ? "source.checkingReceipt" : "source.applyUnknown")}</p><button className="secondary-button" disabled={!pendingAvailability(pendingPayload("apply"), false, true).enabled} onClick={() => registry.dispatch("source.check-receipt", commandScope, pendingPayload("apply"))}>{t("execution.checkReceipt")}</button>{receiptChecked ? <button className="secondary-button" disabled={!pendingAvailability(pendingPayload("apply"), true, true).enabled} onClick={() => registry.dispatch("source.retry-apply", commandScope, pendingPayload("apply"))}>{t("execution.retryAdoption")}</button> : null}
            <button className="text-button" disabled={!pendingAvailability(pendingPayload("apply"), true, true).enabled} onClick={() => registry.dispatch("source.keep-output", commandScope, pendingPayload("apply"))}>{t("execution.keepOutput")}</button>
          </section> : null}
          <button className="text-button" disabled={!common(false, true).enabled || !!Object.keys(lineage).length} onClick={() => registry.dispatch("source.show-current", commandScope)}>{t("source.viewCurrent")}</button>
          {contentPage?.snapshotId && contentPage.snapshotId === contentPage.scope.currentSnapshot ? <SourceImpactPanel key={contentPage.snapshotId} project={project} snapshotId={contentPage.snapshotId} active={open} disabled={locked} onOpenTranslation={onOpenTranslation} onOpenWork={onOpenWork} /> : null}
          <p>{t("source.correctionHelp")}</p><SourceHistoryPanel project={project} disabled={locked} active={open} onHistoryCursor={setHistoryOffset} />
          <p>{t("source.draftHelp")}</p>
        </div>
      </WorkbenchPanel>
    <Dialog.Root open={leave} onOpenChange={next => { if (!next) { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; } }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}>
        <Dialog.Title>{t("source.leaveTitle")}</Dialog.Title><Dialog.Description>{t("source.leaveHelp")}</Dialog.Description>
        <div className="form-actions"><button className="secondary-button" onClick={() => { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; }}>{t("source.keep")}</button>
          <button className="primary-button" onClick={() => { if (leaveProof.current && !leaveProof.current()) { setLeave(false); leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; leaveProof.current = null; return; } sequence.current++; captureRunning.current = false; setCaptureBusy(false); void owner.discard().then(ok => { setLeave(false); if (!ok) setOpen(true); leaveResolver.current?.(ok); leaveResolver.current = null; leaveProof.current = null; }); }}>{t("source.leave")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
