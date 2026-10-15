import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView, useWorkbenchState } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "./projectCommands";
import { executionContext } from "./executionCommands";
import { sourceCommands, type ContentPage, type ContentRow, type ContentScope } from "./sourceCommands";
import { resourceCommands as commands, type GlossaryCapture, type ImpactPage, type ResourcePreview, type TermResolution, type TermRevision, type TmSuggestion } from "./resourceCommands";
import { useResourceDraftSession } from "./ResourceDraftSession";
import { TmxExchangePreviewPanel } from "./TmxExchangePreviewPanel";
import { useSessionInfiniteQuery, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type ResourceTermCommandPayload, type ResourceContextCommandPayload,
  type ResourceCaptureCommandPayload, type ResourceDecisionCommandPayload, type ResourcePendingCommandPayload,
  type ResourceTranslationCommandPayload, type CommandAvailability } from "./workbenchCommands";
import type { QueryKey } from "@tanstack/react-query";
import type { EditorTarget } from "./TranslationWorkbench";
import { PluginToolQueries, type ToolQueryHandle, type ToolQueryState } from "./PluginToolQueries";

type Tab = "terms" | "updates" | "context" | "impact" | "queries";
export interface ResourceHandle { allowLeave: (current?: () => boolean, intentCurrent?: () => boolean) => Promise<boolean>; allowNavigate: () => Promise<boolean>; addQueryText: (text: string) => boolean }
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function ResourceWorkbench({ project, disabled, onOpenTranslation, ref }: {
  project: ProjectView; disabled: boolean;
  onOpenTranslation: (target: EditorTarget, locale: string, suggestedText?: string) => boolean | Promise<boolean>;
  ref?: Ref<ResourceHandle>;
}) {
  const { t } = useTranslation();
  const session = executionContext(project), owner = useResourceDraftSession(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const commandScope = { ...session, area: "resources" as const };
  const { locale, selectedTerm, termDraft, aliasInput, selectedUnit, contextDraft, contextReason,
    previewCapture, preview, previewNeedsRefresh, fixedContext, pending, notice, busyMutation, completionVersion } = owner.state;
  const pendingTerm = pending?.kind === "term" ? pending.request : null;
  const pendingContext = pending?.kind === "context" ? pending.request : null;
  const pendingDecision = pending?.kind === "decision" ? pending.request : null;
  const termDirty = owner.termDirty(), contextDirty = owner.contextDirty();
  const [open, setOpen] = useWorkbenchView("resources");
  const queryRef = useRef<ToolQueryHandle>(null);
  const [queryState, setQueryState] = useState<ToolQueryState>({ busy: false, pending: false, hasDraft: false });
  const [tab, setTab] = useWorkbenchState<Tab>("resources", "tab", "terms");
  const [sourceCursor, setSourceCursor] = useWorkbenchState("resources", "sourceCursor", { locale, snapshotId: "", revision: "", after: 0 });
  const [impactCursor, setImpactCursor] = useWorkbenchState("resources", "impactCursor", { locale, snapshotId: "", revision: "", offset: 0 });
  const [readBusy, setReadBusy] = useState(false);
  const [readFailure, setReadFailure] = useState<CommandFailure | null>(null);
  const failureValue = owner.state.failure, failure = failureReason(failureValue);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const leaveProof = useRef<(() => boolean) | null>(null);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null);
  const alive = useRef(false), generation = useRef(0), running = useRef(false);
  const committed = useRef({ open, locale, project, disabled, tab });
  const lastCompletion = useRef(completionVersion);
  const targetScope = project.metadata.targetLocales.join("\u0000");
  const targetAvailable = locale !== "" && project.metadata.targetLocales.includes(locale);
  const active = open && targetAvailable;
  const busy = readBusy || busyMutation;
  useLayoutEffect(() => {
    committed.current = { open, locale, project, disabled, tab };
    generation.current++; running.current = false; setReadBusy(false);
  }, [open, locale, project, targetScope, tab]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; leaveResolver.current?.(false); }; }, []);
  function currentLocale(value: string) { return alive.current && committed.current.open && committed.current.locale === value && committed.current.project.sessionToken === session.sessionToken
    && committed.current.project.metadata.projectId === session.projectId && owner.localeAvailable(value); }

  const sourceScopeKey = ["resource-source-scope"];
  const scopeRead = useSessionQuery<ContentScope>({ key: sourceScopeKey, scopes: ["source"], enabled: active, read: () => sourceCommands.scope(session) });
  const scope = scopeRead.data;
  const sourceAfter = sourceCursor.locale === locale && sourceCursor.snapshotId === scope?.currentSnapshot && sourceCursor.revision === scope?.revision ? sourceCursor.after : 0;
  const sourceKey = ["resource-source-content", scope?.revision ?? "", scope?.currentSnapshot ?? "", sourceAfter, 50];
  const sourceRead = useSessionQuery<ContentPage>({ key: sourceKey, scopes: ["source"], enabled: active && !!scope?.currentSnapshot && !scopeRead.error,
    read: async () => {
      const result = await sourceCommands.content({ ...session, snapshotId: scope!.currentSnapshot!, after: sourceAfter, limit: 50 });
      if (result.snapshotId !== scope!.currentSnapshot || result.scope.currentSnapshot !== scope!.currentSnapshot || result.scope.revision !== scope!.revision) throw { reason: "resource-basis" };
      return result;
    } });
  const sourcePage = active && !scopeRead.error && !sourceRead.error ? sourceRead.data ?? null : null;
  const sourceMissing = active && scopeRead.isSuccess && !scopeRead.isFetching && scope?.currentSnapshot === null;
  const termsKey = ["resource-terms", locale, 100];
  const termsRead = useSessionInfiniteQuery<TermRevision[], string | null>({ key: termsKey, scopes: ["resources"], enabled: active && tab === "terms", initialPageParam: null,
    nextPage: last => last.length === 100 ? last.at(-1)!.termId : undefined,
    read: afterTermId => commands.terms({ ...session, locale, afterTermId, limit: 100 }) });
  const terms = termsRead.data?.pages.flat() ?? [];
  const historyKey = ["resource-term-history", selectedTerm?.termId ?? "", 100];
  const historyRead = useSessionInfiniteQuery<TermRevision[], number>({ key: historyKey, scopes: ["resources"], enabled: active && tab === "terms" && !!selectedTerm, initialPageParam: 0,
    nextPage: (last, _pages, offset) => last.length === 100 ? offset + 100 : undefined,
    read: offset => commands.termHistory({ ...session, termId: selectedTerm!.termId, offset, limit: 100 }) });
  const termHistory = historyRead.data?.pages.flat() ?? [];
  const capturesRead = useSessionQuery<GlossaryCapture[]>({ key: ["resource-captures", 100], scopes: ["resources"], enabled: active && tab === "updates", read: () => commands.captures({ ...session, limit: 100 }) });
  const captures = capturesRead.data ?? [];
  const unitActive = active && tab === "context" && !!selectedUnit?.unitId && !!selectedUnit.sourceRevisionId;
  const resolutionKey = ["resource-resolution", selectedUnit?.unitId ?? "", locale, selectedUnit?.sourceRevisionId ?? ""];
  const resolutionRead = useSessionQuery<TermResolution>({ key: resolutionKey, scopes: ["source", "resources"], enabled: unitActive,
    read: async () => {
      const result = await commands.resolve({ ...session, unitId: selectedUnit!.unitId!, locale });
      if (result.unitId !== selectedUnit!.unitId || result.locale !== locale || result.sourceRevisionId !== selectedUnit!.sourceRevisionId) throw { reason: "context-source" };
      return result;
    } });
  const resolution = unitActive && !resolutionRead.error ? resolutionRead.data ?? null : null;
  const suggestionsKey = ["resource-tm", selectedUnit?.unitId ?? "", locale, selectedUnit?.sourceRevisionId ?? "", 0, 20];
  const suggestionsRead = useSessionQuery<TmSuggestion[]>({ key: suggestionsKey, scopes: ["source", "translation"], enabled: unitActive,
    read: () => commands.suggestions({ ...session, unitId: selectedUnit!.unitId!, locale, offset: 0, limit: 20 }) });
  const suggestions = unitActive && resolution && !resolutionRead.isFetching && !suggestionsRead.error ? (suggestionsRead.data ?? []).filter(item => item.targetLocale === locale) : [];
  const impactOffset = impactCursor.locale === locale && impactCursor.snapshotId === scope?.currentSnapshot && impactCursor.revision === scope?.revision ? impactCursor.offset : 0;
  const impactKey = ["resource-impact", locale, impactOffset, 50];
  const impactRead = useSessionQuery<ImpactPage>({ key: impactKey, scopes: ["source", "translation", "resources"], enabled: active && tab === "impact",
    read: () => commands.impacts({ ...session, locale, offset: impactOffset, limit: 50 }) });
  const impact = active && tab === "impact" && !impactRead.error ? impactRead.data ?? null : null;
  const previewKey = ["resource-preview-current", previewCapture?.captureId ?? ""];
  const previewActive = open && tab === "updates" && !!preview && !previewNeedsRefresh && !!previewCapture && owner.localeAvailable(previewCapture.targetLocale);
  const previewRead = useSessionQuery<ResourcePreview>({ key: previewKey, scopes: ["source", "resources"], enabled: previewActive,
    read: async () => {
      const result = await commands.preview({ ...session, captureId: previewCapture!.captureId });
      if (result.capture.captureId !== previewCapture!.captureId || result.capture.digest !== previewCapture!.digest || result.capture.targetLocale !== previewCapture!.targetLocale) throw { reason: "resource-basis" };
      return result;
    } });
  useEffect(() => {
    if (lastCompletion.current !== completionVersion) { lastCompletion.current = completionVersion; reads.invalidate(["resources"], false); }
  }, [completionVersion, reads]);
  useEffect(() => { setReadFailure(null); }, [locale, targetScope]);
  useEffect(() => open ? reads.subscribeChanges(scopes => {
    if (scopes.some(scope => scope === "source" || scope === "resources" || scope === "project")) {
      // Only invalidate the view wait. Captured drafts and pending business work
      // remain in the session owner while automatic reads refresh their projection.
      generation.current++; running.current = false; setReadBusy(false);
    }
  }) : undefined, [open, reads]);
  async function retrySourceRead() {
    const current = await scopeRead.refetch();
    if (!scopeRead.error && !current.error && current.data?.currentSnapshot === scope?.currentSnapshot && current.data?.revision === scope?.revision && current.data?.currentSnapshot) await sourceRead.refetch();
  }
  function sourcePageAt(after: number) {
    if (!scope?.currentSnapshot) return;
    if (after === 0) void reads.client.invalidateQueries({ queryKey: reads.key(["resource-source-content", scope.revision, scope.currentSnapshot, 0, 50]), exact: true, refetchType: "none" });
    if (sourceAfter === after) void sourceRead.refetch(); else setSourceCursor({ locale, snapshotId: scope.currentSnapshot, revision: scope.revision, after });
  }
  function refreshImpact() {
    void reads.client.invalidateQueries({ queryKey: reads.key(["resource-impact", locale, 0, 50]), exact: true, refetchType: "none" });
    if (impactOffset === 0) void impactRead.refetch(); else setImpactCursor({ locale, snapshotId: scope?.currentSnapshot ?? "", revision: scope?.revision ?? "", offset: 0 });
  }
  function allowNavigate() { generation.current++; running.current = false; setReadBusy(false); return Promise.resolve(true); }
  useImperativeHandle(ref, () => ({ allowNavigate, addQueryText(text) {
    if (disabled || owner.inFlight() || owner.current().pending || !owner.tool.addText(text)) return false;
    setOpen(true); setTab("queries"); return true;
  }, async allowLeave(current: () => boolean = () => true, intentCurrent: () => boolean = current) {
    if (!current()) return false;
    const original = owner.current();
    const resourceCurrent = () => intentCurrent() && alive.current && !reads.retired
      && committed.current.project.sessionToken === session.sessionToken && committed.current.project.metadata.projectId === session.projectId
      && owner.current().locale === original.locale && owner.current().termSeq === original.termSeq
      && owner.current().contextSeq === original.contextSeq && !owner.inFlight() && !owner.current().pending;
    if (owner.inFlight() || owner.current().pending) { setOpen(true); return Promise.resolve(false); }
    if (queryRef.current && !await queryRef.current.allowLeave(current, resourceCurrent)) return false;
    // The Tool confirmation may settle its own capture and advance its draft sequence.
    // Keep the original exit intent and untouched resource drafts, then inspect the settled Tool.
    if (!resourceCurrent() || owner.tool.blocked() || owner.tool.hasDraft()) return false;
    const toolSequence = owner.tool.draftSequence.current;
    leaveProof.current = () => resourceCurrent() && owner.tool.draftSequence.current === toolSequence
      && !owner.tool.blocked() && !owner.tool.hasDraft();
    if (!owner.termDirty() && !owner.contextDirty()) return Promise.resolve(true);
    setOpen(true); setLeavePrompt(true);
    return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
  } }));
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (running.current || !currentLocale(locale)) return;
    running.current = true; const ticket = ++generation.current;
    const current = () => alive.current && generation.current === ticket && currentLocale(locale);
    setReadBusy(true); setReadFailure(null);
    try { await work(current); } catch (error) { if (current()) setReadFailure(commandFailure(error)); }
    finally { if (generation.current === ticket) { running.current = false; if (alive.current) setReadBusy(false); } }
  }
  function currentView() { const ticket = generation.current; return () => generation.current === ticket && currentLocale(locale); }
  async function refreshDecision(work: () => Promise<void>) {
    const current = currentView(); await work();
    if (current() && !owner.current().pending && owner.current().notice === "decisionSaved") await owner.retryPreview(current);
  }
  function retryPending() { return owner.current().pending?.kind === "decision" ? refreshDecision(() => owner.retryPending()) : owner.retryPending(); }
  function requestClose() { void allowNavigate().then(() => setOpen(false)); }
  function finishLeave(discard: boolean) {
    if (owner.inFlight() || owner.current().pending) return;
    if (discard && leaveProof.current && !leaveProof.current()) { setLeavePrompt(false); leaveResolver.current?.(false); leaveResolver.current = null; leaveProof.current = null; leaveProof.current = null; return; }
    setLeavePrompt(false);
    if (discard) { owner.discard(); leaveResolver.current?.(true); } else leaveResolver.current?.(false);
    leaveResolver.current = null; leaveProof.current = null;
  }
  function switchLocale(next: string) { if (!owner.setLocale(next) && !owner.inFlight() && !owner.current().pending) setLeavePrompt(true); }
  function selectTerm(term: TermRevision | null) { if (!owner.beginTerm(term) && !owner.inFlight() && !owner.current().pending) setLeavePrompt(true); }
  async function selectUnit(row: ContentRow, current: () => boolean) {
    if (owner.contextDirty() || owner.inFlight() || owner.current().pending) { if (!owner.inFlight() && !owner.current().pending) setLeavePrompt(true); return; }
    if (!row.unitId || !row.sourceRevisionId) return;
    const key = reads.key(["resource-context", row.unitId, locale]);
    await reads.client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
    const manual = await reads.client.fetchQuery({ queryKey: key, meta: { scopes: ["resources"] }, queryFn: () => commands.context({ ...session, unitId: row.unitId!, locale }) });
    if (current()) {
      if (manual && (manual.unitId !== row.unitId || manual.locale !== locale)) throw new Error("Invalid context reference");
      owner.beginContext(row, manual);
    }
  }
  async function openTranslation(target: EditorTarget, suggestion?: string) {
    if (!owner.localeAvailable(locale) || owner.inFlight() || owner.current().pending) return;
    if (!await onOpenTranslation(target, locale, suggestion) && alive.current) setReadFailure("translation-draft");
  }
  function ready(key: QueryKey) { const value = reads.client.getQueryState(reads.key(key)); return value?.status === "success" && value.fetchStatus === "idle" && !value.isInvalidated; }
  function sourceReady() { return !!scope?.currentSnapshot && !!sourcePage && ready(sourceScopeKey) && ready(sourceKey); }
  function proof(keys: QueryKey[]) {
    const ticket = generation.current, evidence = keys.map(key => ({ key, data: reads.client.getQueryData(reads.key(key)) }));
    return () => generation.current === ticket && evidence.every(item => ready(item.key) && reads.client.getQueryData(reads.key(item.key)) === item.data);
  }
  function common(tabRequired?: Tab, fresh = true): CommandAvailability {
    if (!open || leavePrompt || (tabRequired && tab !== tabRequired)) return { enabled: false, reason: "hidden" };
    if (disabled || busyMutation || owner.inFlight()) return { enabled: false, reason: "busy" };
    if (fresh && owner.current().pending) return { enabled: false, reason: "pending-action" };
    return { enabled: true };
  }
  function termPayload(): ResourceTermCommandPayload { const value = owner.current(); return { kind: "resource-term", locale: value.locale, termId: value.selectedTerm?.termId ?? null, expectedRevisionId: value.selectedTerm?.revisionId ?? null, editSeq: value.termSeq }; }
  function contextPayload(): ResourceContextCommandPayload | null { const value = owner.current(); return value.selectedUnit?.unitId && value.selectedUnit.sourceRevisionId ? { kind: "resource-context", unitId: value.selectedUnit.unitId, locale: value.locale,
    sourceRevisionId: value.selectedUnit.sourceRevisionId, expectedRevisionId: value.contextRevision?.revisionId ?? null, editSeq: value.contextSeq } : null; }
  function capturePayload(capture: GlossaryCapture): ResourceCaptureCommandPayload { return { kind: "resource-capture", captureId: capture.captureId, digest: capture.digest, locale: capture.targetLocale }; }
  function pendingPayload(): ResourcePendingCommandPayload | null { const value = owner.current().pending; return value ? { kind: "resource-pending", pendingKind: value.kind, actionId: value.request.actionId } : null; }
  function termAvailability(input?: ResourceTermCommandPayload) {
    const allowed = common("terms"); if (!allowed.enabled) return allowed;
    const value = owner.current();
    return input && same(input, termPayload()) && owner.localeAvailable(input.locale) && sourceReady() && ready(termsKey)
      && !!value.termDraft.source.trim() && !!value.termDraft.target.trim() && !!value.termDraft.reason.trim() ? allowed : unavailable;
  }
  function contextAvailability(input: ResourceContextCommandPayload | undefined, capture = false) {
    const allowed = common("context"); if (!allowed.enabled) return allowed;
    return input && same(input, contextPayload()) && owner.localeAvailable(input.locale) && sourceReady() && ready(resolutionKey)
      && (capture || !!owner.current().contextReason.trim()) ? allowed : unavailable;
  }
  function captureAvailability(input: ResourceCaptureCommandPayload | undefined, refreshing = false) {
    const allowed = common("updates"); if (!allowed.enabled) return allowed;
    if (!input || !owner.localeAvailable(input.locale)) return unavailable;
    const capture = refreshing ? owner.current().previewCapture : captures.find(value => value.captureId === input.captureId);
    return capture && same(input, capturePayload(capture)) && (refreshing || ready(["resource-captures", 100])) ? allowed : unavailable;
  }
  function decisionPayload(entryId: string, revision: string | null, decision: ResourceDecisionCommandPayload["decision"], rowKind: ResourceDecisionCommandPayload["rowKind"], scopeUnitId: string | null): ResourceDecisionCommandPayload | null {
    const capture = owner.current().previewCapture; return capture ? { kind: "resource-decision", captureId: capture.captureId, digest: capture.digest, locale: capture.targetLocale, entryId, expectedRevisionId: revision, decision, rowKind, scopeUnitId } : null;
  }
  function matchesDecision(value: ResourcePreview | null | undefined, input: ResourceDecisionCommandPayload) {
    if (!value || value.capture.captureId !== input.captureId || value.capture.digest !== input.digest || value.capture.targetLocale !== input.locale) return false;
    if (input.rowKind === "removed") return value.removed.some(row => row.externalEntryId === input.entryId && row.revisionId === input.expectedRevisionId && (row.scopeUnitId ?? null) === input.scopeUnitId) && (input.decision === "adopt" || input.decision === "keep");
    const row = value.rows.find(item => item.entry.id === input.entryId);
    return !!row && row.kind === input.rowKind && (row.current?.revisionId ?? null) === input.expectedRevisionId && (row.scopeUnitId ?? null) === input.scopeUnitId
      && (input.decision !== "adopt" || (row.kind !== "unchanged" && row.kind !== "override")) && (input.decision !== "override" || row.kind === "override");
  }
  function sameDecisionRow(original: ResourcePreview | null | undefined, current: ResourcePreview | null | undefined, input: ResourceDecisionCommandPayload) {
    if (!original || !current) return false;
    return input.rowKind === "removed"
      ? same(original.removed.find(row => row.externalEntryId === input.entryId), current.removed.find(row => row.externalEntryId === input.entryId))
      : same(original.rows.find(row => row.entry.id === input.entryId), current.rows.find(row => row.entry.id === input.entryId));
  }
  function previewSourceCurrent() {
    const basis = owner.current().previewSourceBasis;
    return !!basis && !!scope && basis.revision === scope.revision && basis.snapshotId === scope.currentSnapshot;
  }
  function decisionAvailability(input?: ResourceDecisionCommandPayload) {
    const allowed = common("updates"); if (!allowed.enabled) return allowed;
    const value = owner.current(), current = reads.client.getQueryData<ResourcePreview>(reads.key(previewKey));
    return input && owner.localeAvailable(input.locale) && !value.previewNeedsRefresh && previewSourceCurrent() && sourceReady() && ready(previewKey)
      && matchesDecision(value.preview, input) && matchesDecision(current, input) && sameDecisionRow(value.preview, current, input) ? allowed : unavailable;
  }
  function translationPayload(target: EditorTarget, evidenceKind: "tm" | "impact", evidenceId: string, selectionId: string | null): ResourceTranslationCommandPayload {
    return { kind: "resource-translation", locale, target, evidenceKind, evidenceId, selectionId };
  }
  function translationAvailability(input?: ResourceTranslationCommandPayload) {
    const allowed = common(input?.evidenceKind === "tm" ? "context" : "impact"); if (!allowed.enabled) return allowed;
    if (!input || input.locale !== locale || !owner.localeAvailable(input.locale) || !sourceReady()) return unavailable;
    if (input.evidenceKind === "tm") {
      const row = owner.current().selectedUnit;
      return row?.unitId && row.sourceRevisionId && ready(resolutionKey) && ready(suggestionsKey) && input.selectionId === null
        && same(input.target, { unitId: row.unitId, sourceRevisionId: row.sourceRevisionId, key: row.occurrence.key, sourceText: row.occurrence.text })
        && suggestions.some(item => item.translationRevisionId === input.evidenceId && item.targetLocale === input.locale) ? allowed : unavailable;
    }
    const item = impact?.items.find(value => value.translationRevisionId === input.evidenceId && value.selectionEventId === input.selectionId);
    return item && ready(impactKey) && same(input.target, { unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText }) ? allowed : unavailable;
  }
  useLayoutEffect(() => {
    const metadata = { category: "resources" as const, binding: null, scope: commandScope, confirmation: "none" as const };
    const removals = [
      registry.register({ ...metadata, id: "resource.save-term", nameKey: "resource.save", risk: "writes-resources", payloadKind: "resource-term", availability: termAvailability,
        handler: () => { void owner.saveTerm(proof([sourceScopeKey, sourceKey, termsKey])); } }),
      registry.register({ ...metadata, id: "resource.save-context", nameKey: "resource.saveContext", risk: "writes-resources", payloadKind: "resource-context", availability: input => contextAvailability(input),
        handler: () => { void owner.saveContext(proof([sourceScopeKey, sourceKey, resolutionKey])); } }),
      registry.register({ ...metadata, id: "resource.capture-context", nameKey: "resource.fixInput", risk: "captures-resources", payloadKind: "resource-context", availability: input => contextAvailability(input, true),
        handler: () => { void owner.captureContext(proof([sourceScopeKey, sourceKey, resolutionKey])); } }),
      registry.register({ ...metadata, id: "resource.choose-file", nameKey: "resource.chooseFile", risk: "captures-resources", payloadKind: "resource-locale",
        availability: input => input?.locale === owner.current().locale ? chooseFileAvailability() : unavailable,
        handler: () => { void owner.chooseFile(currentView()); } }),
      registry.register({ ...metadata, id: "resource.open-preview", nameKey: "resource.previewReady", risk: "reads-resources", payloadKind: "resource-capture", availability: input => captureAvailability(input),
        handler: input => { const capture = captures.find(item => item.captureId === input.captureId); if (capture) void owner.openPreview(capture, currentView()); } }),
      registry.register({ ...metadata, id: "resource.refresh-preview", nameKey: "resource.retryPreview", risk: "reads-resources", payloadKind: "resource-capture", availability: input => captureAvailability(input, true),
        handler: () => { void owner.retryPreview(currentView()); } }),
      registry.register({ ...metadata, id: "resource.decide-entry", nameKey: "resource.actions", risk: "writes-resources", payloadKind: "resource-decision", availability: decisionAvailability,
        handler: input => { const current = proof([sourceScopeKey, sourceKey, previewKey]); void refreshDecision(() => owner.decide(input.entryId, input.expectedRevisionId, input.decision, () => current() && previewSourceCurrent() && matchesDecision(reads.client.getQueryData<ResourcePreview>(reads.key(previewKey)), input))); } }),
      registry.register({ ...metadata, id: "resource.retry-pending", nameKey: "resource.retry", risk: "retries-resource-action", payloadKind: "resource-pending",
        availability: input => { const allowed = common(undefined, false); return !allowed.enabled ? allowed : input && same(input, pendingPayload()) ? allowed : unavailable; }, handler: () => { void retryPending(); } }),
      registry.register({ ...metadata, id: "resource.open-translation", nameKey: "resource.openTranslation", risk: "opens-translation", payloadKind: "resource-translation", availability: translationAvailability,
        handler: input => openTranslation(input.target, input.evidenceKind === "tm" ? suggestions.find(item => item.translationRevisionId === input.evidenceId)?.translationText : undefined) }),
    ];
    return () => removals.forEach(remove => remove());
  });
  function chooseFileAvailability() {
    const allowed = common("updates"); return !allowed.enabled ? allowed : owner.localeAvailable(locale) && sourceReady() && !owner.termDirty() && !owner.contextDirty() ? allowed : unavailable;
  }
  function retryAvailable() { const input = pendingPayload(); return !!input && common(undefined, false).enabled; }
  function dispatchRetry() { const input = pendingPayload(); if (input) registry.dispatch("resource.retry-pending", commandScope, input); }
  function decideEntry(entryId: string, revision: string | null, decision: ResourceDecisionCommandPayload["decision"], rowKind: ResourceDecisionCommandPayload["rowKind"], scopeUnitId: string | null) {
    const input = decisionPayload(entryId, revision, decision, rowKind, scopeUnitId); if (input) registry.dispatch("resource.decide-entry", commandScope, input);
  }
  function canDecide(entryId: string, revision: string | null, decision: ResourceDecisionCommandPayload["decision"], rowKind: ResourceDecisionCommandPayload["rowKind"], scopeUnitId: string | null) {
    const input = decisionPayload(entryId, revision, decision, rowKind, scopeUnitId); return !!input && decisionAvailability(input).enabled;
  }
  function readStatus(error: unknown, fetching: boolean, retry: () => void) {
    return fetching ? <p role="status">{t("resource.loading")}</p> : error ? <div role="alert"><p>{t("resource.readFailed", { reason: t(`resource.errors.${failureReason(commandFailure(error))}`, { defaultValue: failureReason(commandFailure(error)) ?? "" }) })}</p><CommandFailureDetails failure={commandFailure(error)} /><button className="secondary-button" onClick={retry}>{t("resource.retryRead")}</button></div> : null;
  }
  const sourceRows = sourcePage?.rows ?? [];
  return <>
    <WorkbenchPanel open={open} title={t("resource.title")} description={t("resource.description")} className="source-dialog" onBack={requestClose} backDisabled={disabled}>
        <div className="execution-content" aria-busy={busy}>
          {failure ? <div role="alert"><p>{t("resource.error", { reason: t(`resource.errors.${failure}`, { defaultValue: failure }) })}</p><CommandFailureDetails failure={failureValue} /></div> : null}
          {notice ? <p role="status">{t(notice === "saved" ? "resource.saved" : notice === "savedNewer" ? "resource.saved" : notice === "decisionSaved" ? "resource.decisionSaved" : notice === "previewReady" ? "resource.previewReady" : notice === "captureSaved" ? "resource.captureSaved" : notice === "pickerUnknown" ? "resource.pickerUnknown" : notice === "unknown" ? "resource.uncertainAction" : "resource.actionFailed")}</p> : null}
          {notice === "savedNewer" ? <p role="status">{t("resource.savedNewer")}</p> : null}
          {readFailure ? <div role="alert"><p>{t("resource.readFailed", { reason: t(`resource.errors.${failureReason(readFailure)}`, { defaultValue: failureReason(readFailure) ?? "" }) })}</p><CommandFailureDetails failure={readFailure} /></div> : null}
          {!targetAvailable && locale ? <p role="status">{t("resource.removedTarget", { locale })} <button className="text-button" onClick={requestClose}>{t("resource.returnSettings")}</button></p> : null}
          {previewCapture && previewCapture.targetLocale !== locale && !owner.localeAvailable(previewCapture.targetLocale) ? <p role="status">{t("resource.removedPreviewTarget", { locale: previewCapture.targetLocale })} <button className="text-button" onClick={requestClose}>{t("resource.returnSettings")}</button></p> : null}
          {pending && (pending.kind === "capture" || (pending.kind === "term" && tab !== "terms") || (pending.kind === "context" && tab !== "context") || (pending.kind === "decision" && tab !== "updates")) ? <div role="status"><p>{t("resource.uncertainAction")}</p><button className="secondary-button" disabled={!retryAvailable()} onClick={dispatchRetry}>{t("resource.retry")}</button></div> : null}
          {busy ? <p role="status">{t("execution.working")}</p> : null}
          <label>{t("resource.targetLocale")}<select value={locale} disabled={busyMutation || !!pending} onChange={event => switchLocale(event.target.value)}>{!targetAvailable && locale ? <option value={locale} disabled>{t("resource.removedTargetOption", { locale })}</option> : null}{project.metadata.targetLocales.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          {!locale ? <p>{t("resource.noLocale")}</p> : null}
          {readStatus(scopeRead.error || sourceRead.error, scopeRead.isFetching || sourceRead.isFetching, () => { void retrySourceRead(); })}
          {sourceMissing ? <p>{t("resource.noSource")}</p> : null}
          <div className="execution-actions" role="tablist" aria-label={t("resource.title")}>
            {(["terms", "updates", "context", "impact", "queries"] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "primary-button" : "secondary-button"} onClick={() => setTab(value)}>{t(`resource.tabs.${value}`)}</button>)}
          </div>
          <PluginToolQueries ref={queryRef} project={project} session={owner.tool} disabled={disabled} open={open && tab === "queries"} onState={setQueryState} onAttention={() => { setOpen(true); setTab("queries"); }} />
          {tab === "terms" && locale ? <section>
            <div className="execution-section-heading"><h3>{t("resource.currentTerms")}</h3><button className="secondary-button" disabled={busy || !!pending || !targetAvailable || termDirty} onClick={() => selectTerm(null)}>{t("resource.newTerm")}</button></div>
            {readStatus(termsRead.error, termsRead.isFetching, () => { void (termsRead.isFetchNextPageError ? termsRead.fetchNextPage() : termsRead.refetch()); })}{terms.length ? <ul>{terms.filter(term => !term.removed).map(term => <li key={term.termId}><button className="text-button" disabled={busy || !!pending || !targetAvailable} onClick={() => selectTerm(term)}>{term.source} → {term.target}</button> <small>{term.scopeUnitId ? t("resource.unitScope") : t("resource.projectScope")} · {term.originKind === "manual" ? t("resource.manual") : t("resource.external")}</small></li>)}</ul> : active && termsRead.isSuccess && !termsRead.isFetching && !termsRead.error ? <p>{t("resource.noTerms")}</p> : null}
            {termsRead.hasNextPage ? <button className="secondary-button" disabled={busy || !targetAvailable || termsRead.isFetching} onClick={() => void termsRead.fetchNextPage()}>{t("execution.nextPage")}</button> : null}
            <div className="translation-editor">
              <h4>{selectedTerm ? t("resource.editTerm") : t("resource.newTerm")}</h4>
              <label>{t("resource.sourceTerm")}<input value={termDraft.source} onChange={event => owner.editTerm({ ...owner.current().termDraft, source: event.target.value })} /></label>
              <label>{t("resource.aliases")}<input value={aliasInput} onChange={event => { const value = event.target.value; owner.editTerm({ ...owner.current().termDraft, aliases: value.split(",").map(alias => alias.trim()).filter(Boolean) }, value); }} /></label>
              <label>{t("resource.targetTerm")}<input value={termDraft.target} onChange={event => owner.editTerm({ ...owner.current().termDraft, target: event.target.value })} /></label>
              <label>{t("resource.scope")}<select value={termDraft.scopeUnitId ?? ""} onChange={event => owner.editTerm({ ...owner.current().termDraft, scopeUnitId: event.target.value || null })}><option value="">{t("resource.projectScope")}</option>{termDraft.scopeUnitId && !sourceRows.some(row => row.unitId === termDraft.scopeUnitId) ? <option value={termDraft.scopeUnitId}>{t("resource.currentUnit")}</option> : null}{sourceRows.filter(row => row.unitId).map(row => <option key={row.unitId!} value={row.unitId!}>{row.occurrence.key}</option>)}</select></label>
              {sourcePage ? <div className="execution-actions"><button className="secondary-button" disabled={busy || !targetAvailable} onClick={() => sourcePageAt(0)}>{t("execution.firstPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || sourcePage.nextOrdinal === null} onClick={() => sourcePageAt(sourcePage.nextOrdinal!)}>{t("execution.nextPage")}</button></div> : null}
              <label className="source-check"><input type="checkbox" checked={termDraft.protected} onChange={event => owner.editTerm({ ...owner.current().termDraft, protected: event.target.checked })} />{t("resource.protected")}</label>
              <label>{t("resource.reason")}<input value={termDraft.reason} onChange={event => owner.editTerm({ ...owner.current().termDraft, reason: event.target.value })} /></label>
              <div className="execution-actions"><button className="primary-button" disabled={pendingTerm ? !retryAvailable() : !termAvailability(termPayload()).enabled} onClick={() => { if (pendingTerm) dispatchRetry(); else registry.dispatch("resource.save-term", commandScope, termPayload()); }}>{pendingTerm ? t("resource.retry") : t("resource.save")}</button><button className="secondary-button" disabled={busyMutation || !termDirty || !!pending} onClick={() => owner.discardTerm()}>{t("resource.discardDraft")}</button></div>
              {selectedTerm ? <><p>{t("resource.provenance")}: {selectedTerm.originKind} · {selectedTerm.reason}</p><details><summary>{t("resource.history")}</summary>{readStatus(historyRead.error, historyRead.isFetching, () => { void (historyRead.isFetchNextPageError ? historyRead.fetchNextPage() : historyRead.refetch()); })}<ul>{termHistory.map(revision => <li key={revision.revisionId}>{revision.source} → {revision.target} · {revision.reason}</li>)}</ul>{historyRead.hasNextPage ? <button className="secondary-button" disabled={busy || !targetAvailable || historyRead.isFetching} onClick={() => void historyRead.fetchNextPage()}>{t("execution.nextPage")}</button> : null}</details></> : null}
            </div>
          </section> : null}
          {tab === "updates" && locale ? <section><h3>{t("resource.resourceUpdates")}</h3><p>{t("resource.fileHelp")}</p><button className="primary-button" disabled={!chooseFileAvailability().enabled} onClick={() => registry.dispatch("resource.choose-file", commandScope, { kind: "resource-locale", locale })}>{t("resource.chooseFile")}</button>
            {readStatus(capturesRead.error, capturesRead.isFetching, () => { void capturesRead.refetch(); })}{captures.length ? <div><h4>{t("resource.savedCaptures")}</h4><ul>{captures.filter(item => item.targetLocale === locale).map(item => <li key={item.captureId}><button className="text-button" disabled={!captureAvailability(capturePayload(item)).enabled} onClick={() => registry.dispatch("resource.open-preview", commandScope, capturePayload(item))}>{item.resourceId} · {item.revision}</button></li>)}</ul></div> : null}
            {previewCapture && (!preview || previewNeedsRefresh || !previewSourceCurrent() || !same(preview, previewRead.data) || !!previewRead.error) ? <p>{t(preview && !previewNeedsRefresh && !previewRead.error ? "resource.previewChanged" : "resource.previewUnavailable")} <button className="secondary-button" disabled={!captureAvailability(capturePayload(previewCapture), true).enabled} onClick={() => registry.dispatch("resource.refresh-preview", commandScope, capturePayload(previewCapture))}>{t("resource.retryPreview")}</button></p> : null}
            {previewActive ? readStatus(previewRead.error, previewRead.isFetching, () => { void previewRead.refetch(); }) : null}
            {preview ? <><p>{preview.capture.resourceId} · {preview.capture.revision} · {preview.capture.license} · {preview.capture.targetLocale} · {preview.capture.count}</p><details><summary>{t("resource.evidence")}</summary><code>{preview.capture.digest}</code></details>
              <p>{t("resource.previewHelp")}</p>
              <div className="source-table-scroll"><table className="source-table"><thead><tr><th>{t("resource.sourceTerm")}</th><th>{t("resource.currentValue")}</th><th>{t("resource.newValue")}</th><th>{t("resource.change")}</th><th>{t("resource.actions")}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.entry.id}><th scope="row">{row.entry.source}<small> · {row.entry.nativeKey ?? t("resource.projectScope")}</small></th><td>{row.current?.target ?? "—"}</td><td>{row.entry.target}</td><td>{t(`resource.changeKind.${row.kind}`)}</td><td><button className="text-button" disabled={!canDecide(row.entry.id, row.current?.revisionId ?? null, row.kind === "override" ? "override" : "adopt", row.kind, row.scopeUnitId ?? null)} onClick={() => decideEntry(row.entry.id, row.current?.revisionId ?? null, row.kind === "override" ? "override" : "adopt", row.kind, row.scopeUnitId ?? null)}>{row.kind === "override" ? t("resource.setOverride") : t("resource.adopt")}</button><button className="text-button" disabled={!canDecide(row.entry.id, row.current?.revisionId ?? null, "keep", row.kind, row.scopeUnitId ?? null)} onClick={() => decideEntry(row.entry.id, row.current?.revisionId ?? null, "keep", row.kind, row.scopeUnitId ?? null)}>{t("resource.keep")}</button><button className="text-button" disabled={!canDecide(row.entry.id, row.current?.revisionId ?? null, "ignore", row.kind, row.scopeUnitId ?? null)} onClick={() => decideEntry(row.entry.id, row.current?.revisionId ?? null, "ignore", row.kind, row.scopeUnitId ?? null)}>{t("resource.ignore")}</button></td></tr>)}</tbody></table></div>
              {preview.removed.length ? <><h4>{t("resource.removed")}</h4><ul>{preview.removed.map(term => <li key={term.termId}>{term.source} → {term.target}<button className="text-button" disabled={!canDecide(term.externalEntryId!, term.revisionId, "adopt", "removed", term.scopeUnitId ?? null)} onClick={() => decideEntry(term.externalEntryId!, term.revisionId, "adopt", "removed", term.scopeUnitId ?? null)}>{t("resource.adoptRemoval")}</button><button className="text-button" disabled={!canDecide(term.externalEntryId!, term.revisionId, "keep", "removed", term.scopeUnitId ?? null)} onClick={() => decideEntry(term.externalEntryId!, term.revisionId, "keep", "removed", term.scopeUnitId ?? null)}>{t("resource.keep")}</button></li>)}</ul></> : null}
            </> : <p>{t("resource.noPreview")}</p>}
            {pendingDecision ? <div role="status"><p>{t("resource.uncertainAction")}</p><button className="secondary-button" disabled={!retryAvailable()} onClick={dispatchRetry}>{t("resource.retry")}</button></div> : null}
            <TmxExchangePreviewPanel context={session} sourceLocale={project.metadata.sourceLocale} locale={locale}
              enabled={open && tab === "updates" && targetAvailable && !disabled} />
          </section> : null}
          {tab === "context" && locale ? <section><h3>{t("resource.contextAndMemory")}</h3><p>{t("resource.chooseUnit")}</p>{sourcePage ? <><div className="source-table-scroll"><ul>{sourceRows.map(row => <li key={row.occurrence.ordinal}><button className="text-button" disabled={busy || !!pending || !targetAvailable || !row.unitId || !sourceReady()} onClick={() => void run(current => selectUnit(row, current))}>{row.occurrence.key}</button></li>)}</ul></div><button className="secondary-button" disabled={busy || !targetAvailable || sourcePage.nextOrdinal === null} onClick={() => sourcePageAt(sourcePage.nextOrdinal!)}>{t("execution.nextPage")}</button></> : null}
            {selectedUnit?.unitId && selectedUnit.sourceRevisionId ? <div className="translation-editor"><h4>{selectedUnit.occurrence.key}</h4><p>{selectedUnit.occurrence.text}</p>
              <label>{t("resource.manualContext")}<textarea value={contextDraft} onChange={event => owner.editContext(event.target.value)} /></label>
              <label>{t("resource.reason")}<input value={contextReason} onChange={event => owner.editContextReason(event.target.value)} /></label>
              <div className="execution-actions"><button className="primary-button" disabled={pendingContext ? !retryAvailable() : !contextAvailability(contextPayload() ?? undefined).enabled} onClick={() => { const input = contextPayload(); if (pendingContext) dispatchRetry(); else if (input) registry.dispatch("resource.save-context", commandScope, input); }}>{pendingContext ? t("resource.retry") : t("resource.saveContext")}</button><button className="secondary-button" disabled={busyMutation || !contextDirty || !!pending} onClick={() => owner.discardContext()}>{t("resource.discardDraft")}</button><button className="secondary-button" disabled={!contextAvailability(contextPayload() ?? undefined, true).enabled} onClick={() => { const input = contextPayload(); if (input) registry.dispatch("resource.capture-context", commandScope, input); }}>{t("resource.fixInput")}</button></div>
              {readStatus(resolutionRead.error, resolutionRead.isFetching, () => { void resolutionRead.refetch(); })}
              {resolution ? <><h4>{t("resource.applicableTerms")}</h4>{resolution.entries.length ? <ul>{resolution.entries.map(entry => <li key={entry.source}>{entry.source}: {entry.selected ? entry.selected.target : t("resource.conflict")}</li>)}</ul> : !resolutionRead.isFetching ? <p>{t("resource.noApplicableTerms")}</p> : null}</> : null}
              {fixedContext ? <><h4>{t("resource.fixedInput")}</h4><ul>{fixedContext.included.map(item => <li key={item.revisionId}>{item.kind}: {item.text}</li>)}</ul>{fixedContext.omitted.length ? <><h5>{t("resource.omitted")}</h5><ul>{fixedContext.omitted.map((item, index) => <li key={index}>{item.kind}: {item.reference} · {item.reason}</li>)}</ul></> : null}</> : null}
              <h4>{t("resource.tm")}</h4>{readStatus(suggestionsRead.error, suggestionsRead.isFetching, () => { void suggestionsRead.refetch(); })}<p>{t("resource.tmLimit")}</p>{suggestions.length ? <ul>{suggestions.map(item => <li key={item.translationRevisionId}><p>{item.sourceText} → {item.translationText}</p><p>{t(`resource.match.${item.matchKind}`)} · {item.scorePercent}% · {item.originKind === "manual" ? t("resource.manual") : t("resource.imported")} · {t("resource.noApproval")}</p><button className="secondary-button" disabled={!translationAvailability(translationPayload({ unitId: selectedUnit.unitId!, sourceRevisionId: selectedUnit.sourceRevisionId!, key: selectedUnit.occurrence.key, sourceText: selectedUnit.occurrence.text }, "tm", item.translationRevisionId, null)).enabled} onClick={() => registry.dispatch("resource.open-translation", commandScope, translationPayload({ unitId: selectedUnit.unitId!, sourceRevisionId: selectedUnit.sourceRevisionId!, key: selectedUnit.occurrence.key, sourceText: selectedUnit.occurrence.text }, "tm", item.translationRevisionId, null))}>{t("resource.useAsDraft")}</button></li>)}</ul> : suggestionsRead.isSuccess && !suggestionsRead.error && !suggestionsRead.isFetching && resolutionRead.isSuccess && !resolutionRead.isFetching && !resolutionRead.error ? <p>{t("resource.noSuggestions")}</p> : null}
            </div> : null}
          </section> : null}
          {tab === "impact" && locale ? <section><div className="execution-section-heading"><h3>{t("resource.affectedWork")}</h3><button className="secondary-button" disabled={busy || !targetAvailable} onClick={refreshImpact}>{t("resource.refresh")}</button></div>
            {readStatus(impactRead.error, impactRead.isFetching, () => { void impactRead.refetch(); })}
            {impact ? <><p>{t("resource.affectedCount", { count: impact.totalAffected })}</p><p>{t("resource.coverage")}</p>{impact.items.length ? <ul>{impact.items.map(item => <li key={item.unitId}><h4>{item.nativeKey}</h4><p>{t(`resource.impactStatus.${item.status}`)}</p><ul>{item.reasons.map(reason => <li key={reason.changeId}>{t(`resource.reasonKind.${reason.kind}`)} · {reason.oldValue ?? "—"} → {reason.newRemoved ? t("resource.removedValue") : reason.newValue} · {t(`resource.confidence.${reason.confidence}`)}</li>)}</ul><button className="secondary-button" disabled={!translationAvailability(translationPayload({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText }, "impact", item.translationRevisionId, item.selectionEventId)).enabled} onClick={() => registry.dispatch("resource.open-translation", commandScope, translationPayload({ unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, key: item.nativeKey, sourceText: item.sourceText }, "impact", item.translationRevisionId, item.selectionEventId))}>{t("resource.openTranslation")}</button></li>)}</ul> : !impactRead.isFetching ? <p>{t("resource.noImpacts")}</p> : null}<div className="execution-actions"><button className="secondary-button" disabled={busy || !targetAvailable || impactOffset === 0} onClick={refreshImpact}>{t("execution.firstPage")}</button><button className="secondary-button" disabled={busy || !targetAvailable || impact.nextOffset === null} onClick={() => setImpactCursor({ locale, snapshotId: scope?.currentSnapshot ?? "", revision: scope?.revision ?? "", offset: impact.nextOffset! })}>{t("execution.nextPage")}</button></div></> : !impactRead.isFetching && !impactRead.error ? <p>{t("resource.loadImpact")}</p> : null}
          </section> : null}
        </div>
      </WorkbenchPanel>
    <Dialog.Root open={leavePrompt} onOpenChange={value => { if (!value && !busy) finishLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()}><Dialog.Title>{t("resource.leaveTitle")}</Dialog.Title><Dialog.Description>{t("resource.leaveHelp")}</Dialog.Description><div className="form-actions"><button className="secondary-button" onClick={() => finishLeave(false)}>{t("resource.stay")}</button><button className="primary-button" onClick={() => finishLeave(true)}>{t("resource.discardAndLeave")}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
