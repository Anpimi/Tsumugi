import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SessionReadProvider, SessionReadStatus, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TranslationDraftSession, useTranslationDraftSession } from "./TranslationDraftSession";
import { McpSharingSession, useMcpSharing } from "./McpSharingSession";
import { McpSharingPanel } from "./McpSharingPanel";
import { TranslationImportSession, useTranslationImportSession } from "./TranslationImportSession";
import { ExecutionTaskSession, useExecutionTaskSession } from "./ExecutionTaskSession";
import { ReviewDraftSession, useReviewDraftSession } from "./ReviewDraftSession";
import { ResourceDraftSession, useResourceDraftSession } from "./ResourceDraftSession";
import { SourceDraftSession, useSourceDraftSession } from "./SourceDraftSession";
import { ArenaDraftSession, useArenaDraftSession } from "./ArenaDraftSession";
import { ReleaseDraftSession, useReleaseDraftSession } from "./ReleaseDraftSession";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { SourceWorkbench } from "./SourceWorkbench";
import { TranslationWorkbench } from "./TranslationWorkbench";
import { ResourceWorkbench } from "./ResourceWorkbench";
import { ReviewWorkbench } from "./ReviewWorkbench";
import { ReleaseWorkbench } from "./ReleaseWorkbench";
import { AiWorkbench } from "./AiWorkbench";
import { ArenaWorkbench } from "./ArenaWorkbench";
import { ExecutionTasks } from "./ExecutionTasks";
import { TaskDock } from "./TaskDock";
import { useWorkspaceView, useWorkspaceViewChanges, useWorkbenchValue, type WorkspaceArea, type WorkbenchContextPresentation, type WorkbenchContextScope } from "./WorkbenchFrame";
import { executionContext } from "./executionCommands";
import { isCommandError, type ProjectView } from "./projectCommands";
import { reviewCommands, type ReviewEditorSnapshot, type ReviewTarget, type ReviewFindingView } from "./reviewCommands";
import type { AiView } from "./aiCommands";
import { translationCommands, type TranslationHistory, type TranslationRevision } from "./translationCommands";
import { sourceKeys, sourceReads } from "./sourceQueries";
import type { ContentScope } from "./sourceCommands";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { SessionNavigation, type AiReviewOrigin, type ReviewHandoffPresentation, type ExitDisposition, type SessionConsumer, type SessionExitPermit, type WorkspaceDestination, type TranslationFindFocusRequest } from "./sessionNavigation";
import { contentSelectionIds, type ContentSelection } from "./contentSelection";
import { resourceCommands, type CorrectionTermEvidence } from "./resourceCommands";
import type { ContextEditorTarget, CorrectionEditorTarget } from "./workbenchCommands";
import { sourceMaintenanceHookCommands } from "./sourceMaintenanceHookCommands";
import { sourceHookKey } from "./SourceMaintenanceHook";
import { StrategyDraftSession, useStrategyDraftSession } from "./StrategyDraftSession";
import { diagnosticLocationMatchesTarget, sameReviewBasis, type ReviewDiagnosticAnchor, type ReviewEditorHandoff, type ReviewEditorReturn } from "./reviewDiagnosticNavigation";
import { semanticReviewRead } from "./aiSemanticReviewQueries";
import { reviewFindingsRead } from "./reviewQueries";
import type { AiSemanticReviewView } from "./aiSemanticReviewCommands";

/** The same project owners are shared by production assembly and isolated consumer tests. */
export function ProjectSessionOwners({ project, children, bridge = true }: { project: ProjectView; children: ReactNode; bridge?: boolean }) {
  return <SessionReadProvider context={executionContext(project)} bridge={bridge}>
    <TranslationDraftSession project={project}><McpSharingSession project={project}><ExecutionTaskSession project={project}><TranslationImportSession project={project}>
      <ReviewDraftSession project={project}><ResourceDraftSession project={project}><SourceDraftSession project={project}>
        <ArenaDraftSession project={project}><ReleaseDraftSession project={project}>
          <StrategyDraftSession project={project}><ProjectAiPreparation project={project}>
            {children}
          </ProjectAiPreparation></StrategyDraftSession>
        </ReleaseDraftSession></ArenaDraftSession>
      </SourceDraftSession></ResourceDraftSession></ReviewDraftSession>
    </TranslationImportSession></ExecutionTaskSession></McpSharingSession></TranslationDraftSession>
  </SessionReadProvider>;
}
function ProjectAiPreparation({ project, children }: { project: ProjectView; children: ReactNode }) {
  const resources = useResourceDraftSession();
  return <AiPreparationSession initialLocale={project.metadata.targetLocales[0] ?? ""} targetLocales={project.metadata.targetLocales} mcp={resources.tool.mcp}>{children}</AiPreparationSession>;
}
export interface ProjectSessionHandle {
  navigate: (destination: WorkspaceDestination) => Promise<boolean>;
  prepareExit: () => Promise<SessionExitPermit | null>;
  retire: () => void;
}
export interface OverviewSourcePresentation {
  projectId: string;
  sessionToken: string;
  state: "loading" | "empty" | "ready" | "failed";
}
interface Props { project: ProjectView; disabled: boolean; onActivate: (area: WorkspaceArea) => void;
  onCoordinatingChange: (busy: boolean) => void; onSourceState?: (value: OverviewSourcePresentation) => void;
  onWorkContext?: (value: WorkbenchContextPresentation) => void;
  onOpenExtensions?: () => void; onOpenConnections?: () => void; retired?: boolean; ref?: Ref<ProjectSessionHandle> }
export function ProjectSessionWorkbench(props: Props) {
  return <ProjectSessionOwners project={props.project}><SessionWorkbench {...props} /></ProjectSessionOwners>;
}

function OverviewSourceObserver({ project, onSourceState }: Pick<Props, "project" | "onSourceState">) {
  const reads = useSessionReads();
  const source = useSessionQuery({ ...sourceReads.scope(executionContext(project)), enabled: !reads.retired });
  const queryKey = useMemo(() => reads.key(sourceKeys.scope), [reads]);
  const subscribe = useCallback((notify: () => void) => reads.client.getQueryCache().subscribe(event => {
    if (matchQuery({ queryKey, exact: true }, event.query)) notify();
  }), [reads, queryKey]);
  const snapshot = useCallback((): OverviewSourcePresentation["state"] => {
    const state = reads.client.getQueryState<ContentScope>(queryKey);
    if (!state || state.fetchStatus !== "idle" || state.status === "pending") return "loading";
    if (state.status === "error") return "failed";
    if (state.isInvalidated || !state.data) return "loading";
    return state.data.currentSnapshot ? "ready" : "empty";
  }, [reads, queryKey]);
  // Query observer notifications are batched. An exact cache reset or refetch
  // must revoke the current presentation in the same turn, before that batch.
  const currentState = useSyncExternalStore(subscribe, snapshot);
  const state = source.isFetching || source.isPending ? "loading" : currentState;
  useLayoutEffect(() => {
    if (!reads.retired && reads.context.projectId === project.metadata.projectId && reads.context.sessionToken === project.sessionToken) {
      onSourceState?.({ ...executionContext(project), state });
    }
  }, [reads, project.metadata.projectId, project.sessionToken, state, onSourceState]);
  return null;
}

function SessionWorkbench({ project, disabled, onActivate, onCoordinatingChange, onSourceState, onWorkContext, onOpenExtensions, onOpenConnections, retired = false, ref }: Props) {
  const { t } = useTranslation(), view = useWorkspaceView(), reads = useSessionReads();
  useWorkspaceViewChanges();
  const translation = useTranslationDraftSession(), imports = useTranslationImportSession(), tasks = useExecutionTaskSession();
  const sharing = useMcpSharing();
  const source = useSourceDraftSession(), resources = useResourceDraftSession(), review = useReviewDraftSession();
  const release = useReleaseDraftSession(), ai = useAiPreparation(), arena = useArenaDraftSession();
  const strategy = useStrategyDraftSession();
  const translationTab = useWorkbenchValue<"edit" | "import">("translation", "tab");
  const translationLocale = useWorkbenchValue<string>("translation", "targetLocale");
  const contentSelection = useWorkbenchValue<ContentSelection | null>("translation", "contentSelection");
  const resourceTab = useWorkbenchValue<string>("resources", "tab");
  const reviewTab = useWorkbenchValue<string>("review", "tab");
  const reviewLanguages = useWorkbenchValue<string[]>("review", "languages");
  const reviewAssessment = useWorkbenchValue<{ projectId: string; sessionToken: string; reviewLocale: string; locales: string[] } | null>("review", "assessment");
  const comparisonEntry = useWorkbenchValue<{ unitId: string; locale: string; key: string } | null>("arena", "comparisonEntry");
  const taskId = useWorkbenchValue<string | null>("tasks", "taskId");
  let contextLocales: readonly string[] = project.metadata.targetLocales;
  let targetKind: WorkbenchContextPresentation["targetKind"] = "project";
  let contextScope: WorkbenchContextScope = { kind: "unselected" };
  switch (view.area) {
    case "overview": case "source": contextScope = { kind: "project" }; break;
    case "translation": {
      const imported = imports.state, draft = translation.draft;
      const tab = translationTab ?? (imported.attempt || imported.folder || imported.pendingStart || imported.pendingPlugin || imported.uncertain.length ? "import" : "edit");
      const locale = tab === "import" ? imported.targetLocale : translationLocale ?? draft?.locale ?? imported.targetLocale;
      contextLocales = locale ? [locale] : []; targetKind = "working";
      if (tab === "import") {
        if (imported.fileName) contextScope = { kind: "file", name: imported.fileName };
      } else {
        const entry = draft?.locale === locale ? draft.key : null;
        const selection = contentSelection && contentSelection.projectId === project.metadata.projectId
          && contentSelection.sessionToken === project.sessionToken && contentSelection.capture.locale === locale ? contentSelection : null;
        contextScope = selection ? entry !== null ? { kind: "entrySelection", name: entry, count: contentSelectionIds(selection).length }
          : { kind: "selection", count: contentSelectionIds(selection).length } : entry !== null ? { kind: "entry", name: entry } : { kind: "unselected" };
      }
      break;
    }
    case "resources": {
      const value = resources.state;
      contextLocales = value.locale ? [value.locale] : []; targetKind = "working";
      if ((resourceTab ?? "terms") === "terms" && value.selectedTerm) contextScope = { kind: "term", name: value.selectedTerm.source };
      else if (resourceTab === "context" && value.selectedUnit) contextScope = { kind: "entry", name: value.selectedUnit.occurrence.key };
      break;
    }
    case "review": {
      const value = review.state;
      targetKind = "working";
      if (reviewTab === "eligibility") {
        contextLocales = reviewLanguages ?? project.metadata.targetLocales;
        const assessed = reviewAssessment && reviewAssessment.projectId === project.metadata.projectId && reviewAssessment.sessionToken === project.sessionToken
          && reviewAssessment.reviewLocale === value.locale && reviewAssessment.locales.length > 0
          && reviewAssessment.locales.length === contextLocales.length
          && reviewAssessment.locales.every((locale, index) => locale === contextLocales[index] && project.metadata.targetLocales.includes(locale));
        contextScope = { kind: assessed ? "assessment" : "languages", count: contextLocales.length };
      } else {
        contextLocales = value.locale ? [value.locale] : [];
        const chosen = Object.values(value.chosen).filter(target => target.locale === value.locale);
        if ((reviewTab ?? "review") === "review" && value.selected?.locale === value.locale) contextScope = { kind: "entry", name: value.selected.nativeKey };
        else if (chosen.length) contextScope = { kind: "selection", count: chosen.length };
      }
      break;
    }
    case "release": {
      const value = release;
      if (value.chosen) {
        contextLocales = [...new Set(value.chosen.artifacts.map(artifact => artifact.locale))]; targetKind = "release";
        contextScope = { kind: "release", name: value.chosen.artifacts.map(artifact => artifact.fileName).join(" · ") };
      } else {
        contextLocales = value.languages; targetKind = "working";
        contextScope = { kind: "languages", count: value.languages.length };
      }
      break;
    }
    case "ai": {
      contextLocales = ai.locale ? [ai.locale] : []; targetKind = "working";
      const capture = ai.capture;
      contextScope = capture ? { kind: "preparation", count: capture.kind === "plan" ? capture.value.scope.length : capture.value.preview.items.length }
        : ai.selected.length ? { kind: "selection", count: ai.selected.length } : { kind: "unselected" };
      break;
    }
    case "arena": {
      contextLocales = arena.locale ? [arena.locale] : []; targetKind = "working";
      if (comparisonEntry && comparisonEntry.unitId === arena.unit && comparisonEntry.locale === arena.locale) contextScope = { kind: "entry", name: comparisonEntry.key };
      else if (arena.prepared) contextScope = { kind: "preparation", count: arena.prepared.preview.items.length };
      else if (arena.unit) contextScope = { kind: "selection", count: 1 };
      else if (arena.selected.length) contextScope = { kind: "selection", count: arena.selected.length };
      break;
    }
    case "tasks": if (taskId) contextScope = { kind: "task" }; break;
  }
  const contextPresentation: WorkbenchContextPresentation = { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
    metadataRevision: project.metadata.metadataRevision, area: view.area, targetKind, locales: contextLocales, scope: contextScope };
  const publishedContext = useRef<{ value: string; callback: Props["onWorkContext"] } | null>(null);
  useEffect(() => {
    if (retired || reads.retired || !onWorkContext) return;
    const value = JSON.stringify(contextPresentation);
    if (publishedContext.current?.value === value && publishedContext.current.callback === onWorkContext) return;
    publishedContext.current = { value, callback: onWorkContext };
    onWorkContext(contextPresentation);
  });
  const mounted = useRef(false), handles = useRef(new Map<WorkspaceArea, SessionConsumer>());
  const findFocus = useRef<TranslationFindFocusRequest | null>(null);
  const deliverFindFocus = useRef<(() => void) | null>(null);
  const waiting = useRef(new Map<WorkspaceArea, ((handle: SessionConsumer | null) => void)[]>());
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const [navigating, setNavigating] = useState(false);
  const committed = useRef({ project, disabled, view, onActivate, onCoordinatingChange });
  useLayoutEffect(() => { committed.current = { project, disabled, view, onActivate, onCoordinatingChange }; });
  const targetScope = project.metadata.targetLocales.join("\u0000");
  useLayoutEffect(() => {
    // Capture revocation belongs to the stable session, including while Review is unmounted.
    // Restoring a removed language must not revive a previous explicit assessment.
    const assessment = view.memory.read<{ projectId: string; sessionToken: string; reviewLocale: string; locales: string[] }>("review", "assessment");
    if (assessment && (assessment.projectId !== project.metadata.projectId || assessment.sessionToken !== project.sessionToken
      || assessment.reviewLocale !== review.current().locale || assessment.locales.some(locale => !project.metadata.targetLocales.includes(locale)))) {
      view.memory.write("review", "assessment", null);
    }
    const languages = view.memory.read<string[]>("review", "languages");
    if (languages?.some(locale => !project.metadata.targetLocales.includes(locale))) {
      view.memory.write("review", "languages", languages.filter(locale => project.metadata.targetLocales.includes(locale)));
    }
  }, [view.memory, project.metadata.projectId, project.sessionToken, targetScope, review.state.locale]);
  const [scope] = useState(() => ({ projectId: project.metadata.projectId, sessionToken: project.sessionToken }));
  function live() { return !reads.retired && mounted.current && committed.current.project.sessionToken === scope.sessionToken
    && committed.current.project.metadata.projectId === scope.projectId; }
  function cancelFindFocus(request = findFocus.current) {
    request?.cancel();
    if (request && view.memory.read("translation", "findFocus") === request) view.memory.write("translation", "findFocus", null);
    if (findFocus.current === request) { findFocus.current = null; deliverFindFocus.current = null; }
  }
  useLayoutEffect(() => {
    if (retired || findFocus.current && !findFocus.current.current()) cancelFindFocus();
  }, [view.area, project.metadata.metadataRevision, retired]);
  function inspect(): ExitDisposition[] {
    const manual = translation.current(), imported = imports.current(), src = source.current(), res = resources.current();
    const rev = review.current(), rel = release.current(), prepared = ai.current(), comparison = arena.current();
    const row = (area: WorkspaceArea, blocked: boolean, dirty: boolean, revision: unknown): ExitDisposition =>
      ({ area, status: blocked ? "blocked" : dirty ? "dirty" : "ready", revision: JSON.stringify(revision) });
    return [
      row("release", release.reserved(), rel.buildDirty || rel.deliveryDirty || !!rel.workflow,
        [rel.editSeq, rel.languages, rel.names, rel.buildChoice, rel.prepared?.review.inputDigest, rel.buildConsent, rel.checkReview?.inputDigest, rel.checkConsent, rel.checkAttempt, rel.savedAttempt, rel.chosen?.releaseId, rel.selection?.selectionId, rel.preview?.previewId, rel.overwrite,
          rel.workflow?.request, rel.workflow?.review?.materializationDigest, rel.workflow?.approved, rel.workflow?.start, rel.workflow?.stop,
          rel.workflow?.pending, rel.workflow?.stopPending, rel.workflow?.uncertain, rel.workflow?.stopUncertain, rel.workflow?.safety, rel.workflowControlBusy]),
      row("tasks", tasks.unresolved(), false, null),
      row("source", source.hasPending(),
        !!src.selection || Object.keys(src.lineage).length > 0 || !!src.actor.trim() || source.hook.hasDraft() || source.inFlight(), [src.editSeq, source.hook.revision()]),
      row("translation", sharing.blocked() || translation.candidates.blocked() || translation.protection.blocked() || !!manual?.saving || !!manual?.selecting || !!manual?.pending || !!manual?.pendingSelection
        || imported.busy || imports.hasPending() || imports.hasActive(),
        translation.candidates.hasDraft() || !!manual && (manual.text !== (manual.baseText ?? "") || manual.newerDraftSaved),
        [manual?.unitId, manual?.locale, manual?.editSeq, manual?.text, translation.protection.current().pending,
          translation.candidates.current().editSeq,translation.candidates.current().pending, sharing.revision()]),
      row("resources", resources.factBlocked() || resources.inFlight() || !!res.pending || resources.tool.blocked(), resources.factDirty() || resources.termDirty() || resources.contextDirty() || resources.correctionDirty() || resources.tool.hasDraft(),
        [res.termSeq, res.contextSeq, res.correctionDraft, res.factDraft, res.factPending, resources.tool.draftSequence.current, resources.tool.current().capture?.review.inputDigest, resources.tool.current().pending, resources.tool.mcp.revision()]),
      row("review", review.inFlight() || rev.batchRunning || !!rev.pending,
        Object.values(rev.drafts).some(value => value.length > 0) || Object.keys(rev.chosen).length > 0 || !!rev.checkReview || rev.checkConsent.length > 0 || rev.advisoryChecks.length > 0,
        [rev.locale, rev.actor, rev.editSeq, rev.checkReview?.request, rev.checkConsent, rev.advisoryChecks, Object.values(rev.chosen).map(value => [value.unitId, value.locale, value.basis]),
          Object.values(rev.draftTargets).map(value => [value.unitId, value.locale, value.basis])]),
      row("ai", ai.reserved() || ai.discussions.blocked() || ai.guidance.blocked() || strategy.reserved(), prepared.dirty || ai.discussions.hasDraft() || ai.recovery.hasDraft() || ai.guidance.hasDraft() || strategy.dirty(), [prepared.editSeq, prepared.consent, prepared.capture, strategy.current(), ai.discussions.revision(), ai.guidance.revision(), ai.recovery.current(), ai.planControl.current().pending, ai.agent.current().pending, ai.component.current().operation,
        ai.agent.current().child.editSeq,ai.agent.current().child.pending?.proposal,ai.agent.current().child.children.map(child=>[child.consumer.scope.scopeId,child.accepted,child.toolHandle,child.runs.map(action=>[action.prepared.attemptId,action.phase,action.retryAllowed])])]),
      row("arena", arena.reserved(), comparison.dirty || !!comparison.draft, [comparison.editSeq, comparison.draft?.editSeq, comparison.consent]),
    ];
  }
  function consumer(area: WorkspaceArea): Promise<SessionConsumer | null> {
    if (area === "overview" || !live()) return Promise.resolve(null);
    const handle = handles.current.get(area); if (handle) return Promise.resolve(handle);
    return new Promise(resolve => waiting.current.set(area, [...(waiting.current.get(area) ?? []), resolve]));
  }
  function register(area: WorkspaceArea, handle: SessionConsumer | null) {
    if (handle) {
      handles.current.set(area, handle);
      waiting.current.get(area)?.forEach(resolve => resolve(handle)); waiting.current.delete(area);
    } else handles.current.delete(area);
  }
  async function accept(destination: WorkspaceDestination, current: () => boolean) {
    if (!current()) return false;
    setFailure(null);
    if (destination.kind === "area") return true;
    if (destination.kind === "translation-find") return () => {
      const request = findFocus.current;
      if (!current() || !request?.current()) return false;
      const memory = committed.current.view.memory;
      memory.write("translation", "tab", "edit");
      memory.write("translation", "findOpen", true);
      deliverFindFocus.current?.();
      memory.write("translation", "findFocus", request);
      return true;
    };
    if (destination.kind === "task" || destination.kind === "task-list") {
      const pending = tasks.currentActivity();
      if (tasks.unresolved() || pending && pending.phase !== "recorded" && pending.phase !== "rejected") return false;
      if (destination.kind === "task") {
        const activity = reads.client.getQueryState<import("./executionCommands").TaskActivity>(reads.key(["task-activity", 12]));
        if (activity?.status !== "success" || activity.fetchStatus !== "idle" || activity.isInvalidated || !activity.data
          || !activity.data.rows.some(row => row.taskId === destination.taskId && row.attemptId === destination.attemptId)) return false;
      }
      const memory = committed.current.view.memory;
      memory.write("tasks", "taskId", destination.kind === "task" ? destination.taskId : null);
      memory.write("tasks", "attemptId", destination.kind === "task" ? destination.attemptId : null);
      memory.write("tasks", "cursor", "0");
      memory.write("tasks", "attemptCursor", "0"); memory.write("tasks", "offset", 0);
      memory.write("tasks", "continuationCursor", "0"); memory.write("tasks", "historySelection", null);
      memory.write("tasks", "outputSelection", null); memory.write("tasks", "savedOutput", null);
      memory.write("tasks", "receiptSelection", null); memory.write("tasks", "confirmation", null);
      return true;
    }
    if (destination.kind === "maintenance-notice") {
      const before = ai.current(), sourceBefore = source.current();
      const sameOwners = () => current() && !ai.reserved() && !source.hasPending() && !source.inFlight()
        && source.current().editSeq === destination.sourceEditSeq && source.current().editSeq === sourceBefore.editSeq
        && ai.current().editSeq === destination.aiEditSeq && ai.current().editSeq === before.editSeq
        && source.hook.current().sourceActionId === destination.sourceActionId;
      if (!sameOwners()) { setFailure("source-notice-handoff-blocked"); return false; }
      const key = reads.key(sourceHookKey(destination.sourceActionId));
      const observation = await reads.client.fetchQuery({ queryKey: key, staleTime: 0, meta: { scopes: ["source", "execution"] },
        queryFn: () => sourceMaintenanceHookCommands.read({ ...scope, sourceActionId: destination.sourceActionId }, source.hook.current().originalActivation) });
      const checked = () => { const query = reads.client.getQueryState(key); return sameOwners() && query?.status === "success" && query.fetchStatus === "idle"
        && !query.isInvalidated && query.error === null && query.data === observation && observation.state === "adopted"
        && observation.view?.phase === "observed" && !!observation.view.outcome?.assessment
        && committed.current.project.metadata.targetLocales.includes(observation.view.activation.locale); };
      if (!checked()) { setFailure("source-notice-handoff-changed"); return false; }
      return () => { if (!checked()) return false;
        committed.current.view.memory.write("ai", "maintenanceNotice", { sourceActionId: destination.sourceActionId, sourceEditSeq: destination.sourceEditSeq, aiEditSeq: destination.aiEditSeq });
        committed.current.view.memory.write("ai", "maintenanceOpen", true); return true; };
    }
    if (destination.kind === "ai-selection") {
      const selected = destination.selection, cached = reads.client.getQueryState<ContentScope>(reads.key(["translation-source-scope"]));
      if (committed.current.view.memory.read<ContentSelection>("translation", "contentSelection") !== selected
        || cached?.status !== "success" || cached.fetchStatus !== "idle" || cached.isInvalidated || cached.error !== null
        || cached.data?.currentSnapshot !== selected.capture.sourceSnapshotId
        || !committed.current.project.metadata.targetLocales.includes(selected.capture.locale)
        || !ai.receiveContentSelection(selected, destination.expectedEditSeq)) {
        setFailure("navigation-edited"); return false;
      }
      return true;
    }
    if (destination.kind === "ai-mcp-query") {
      const mcp = resources.tool.mcp, preview = destination.preview;
      const unit = resources.tool.current().retrievalUnit;
      const sourceCurrent = () => {
        const source = reads.client.getQueryState<ContentScope>(reads.key(["resource-source-scope"]));
        return source?.status === "success" && source.fetchStatus === "idle" && !source.isInvalidated && source.error === null
          && source.data?.currentSnapshot === preview.basis.sourceSnapshotId
          && committed.current.project.metadata.sourceLocale === preview.basis.sourceLocale;
      };
      if (!sourceCurrent() || !unit || unit.unitId !== preview.basis.unitId
        || unit.sourceRevisionId !== preview.basis.sourceRevisionId || unit.sourceSnapshotId !== preview.basis.sourceSnapshotId
        || !mcp.canUseInAi(preview, destination.querySequence) || !ai.canReceiveMcpQuery(preview, destination.expectedEditSeq)) {
        setFailure("navigation-edited"); return false;
      }
      return () => {
        if (!current() || !sourceCurrent() || !mcp.canUseInAi(preview, destination.querySequence)
          || !ai.canReceiveMcpQuery(preview, destination.expectedEditSeq)) return false;
        if (!ai.receiveMcpQuery(preview, destination.expectedEditSeq, unit.label)) return false;
        return mcp.handToAi(preview, destination.querySequence);
      };
    }
    if (destination.kind === "mcp-query") {
      if (resources.tool.current().mode !== "mcp" && !resources.tool.blocked() && !resources.tool.hasDraft()) resources.tool.setMode("mcp");
      committed.current.view.memory.write("resources", "tab", "queries"); return true;
    }
    if (destination.kind === "review-work") {
      const memory = committed.current.view.memory;
      memory.write("review", "tab", "work"); memory.write("review", "editorOrigin", null); memory.write("review", "editorReturned", null); return true;
    }
    if (destination.kind === "review-return") {
      const capture = destination.capture, memory = committed.current.view.memory;
      const original = memory.read<ReviewEditorReturn | null>("translation", "reviewReturn");
      if (!original || JSON.stringify(original) !== JSON.stringify(capture) || capture.projectId !== scope.projectId || capture.sessionToken !== scope.sessionToken
        || review.current().locale !== capture.locale || !committed.current.project.metadata.targetLocales.includes(capture.locale)) {
        setFailure("diagnostic-return-changed"); return false;
      }
      return () => {
        if (!current() || review.current().locale !== capture.locale || !committed.current.project.metadata.targetLocales.includes(capture.locale)) return false;
        memory.write("review", "tab", capture.tab); memory.write("review", "summaryScope", capture.summaryScope);
        memory.write("review", "pageAfter", capture.pageAfter); memory.write("review", "workCursor", { locale: capture.locale, offset: capture.workOffset });
        memory.write("review", "editorOrigin", capture); memory.write("review", "editorReturned", capture);
        void reads.client.invalidateQueries({ queryKey: reads.key(capture.tab === "work" ? ["review-work", capture.locale, capture.workOffset, 50]
          : ["review-summary", capture.locale, capture.summaryScope?.scopeId ?? "", "", capture.pageAfter, 50]), exact: true, refetchType: "none" });
        return true;
      };
    }
    if (destination.kind === "review-edit") {
      const originalProject = committed.current.project, draft = translation.current(), imported = imports.current(), capture = destination.handoff;
      const reviewSelection = review.current().selected;
      const fail = (reason: string) => { if (current()) setFailure(reason); return false; };
      const ownersCurrent = () => current() && live() && translation.current() === draft && imports.current() === imported
        && review.current().locale === destination.locale && review.current().selected === reviewSelection
        && !!reviewSelection && reviewSelection.unitId === destination.target.unitId && reviewSelection.locale === destination.locale
        && !translation.mutationReserved && !translation.protection.blocked() && !draft?.saving && !draft?.selecting && !draft?.pending && !draft?.pendingSelection
        && (!draft || draft.text === (draft.baseText ?? "") && !draft.newerDraftSaved) && !imported.busy && !imports.hasPending() && !imports.hasActive()
        && committed.current.project.metadata.metadataRevision === originalProject.metadata.metadataRevision
        && committed.current.project.metadata.targetLocales.includes(destination.locale);
      if (!ownersCurrent() || capture.returnTo.projectId !== scope.projectId || capture.returnTo.sessionToken !== scope.sessionToken
        || capture.returnTo.unitId !== destination.target.unitId || capture.returnTo.locale !== destination.locale) return fail("diagnostic-editor-blocked");
      await reads.synchronizeFresh();
      if (!ownersCurrent()) return fail("diagnostic-editor-blocked");
      const editorKey = reads.key(["editor-snapshot", destination.target.unitId, destination.locale]);
      const source = sourceReads.scope(scope), sourceKey = reads.key(source.key);
      const diagnostic = capture.diagnostic;
      const locationKey = reads.key(["review-diagnostic-location", destination.target.unitId, destination.locale, diagnostic?.runId, diagnostic?.diagnostic]);
      const semantic = diagnostic?.source.purpose === "ai-semantic" ? semanticReviewRead(scope, diagnostic.source.origin.attemptId) : null;
      const findings = semantic ? reviewFindingsRead(scope, destination.target.unitId, destination.locale) : null;
      let changed = false;
      const stop = reads.subscribeChanges(scopes => { if (scopes.some(value => ["project", "source", "translation", "resources", "review"].includes(value))) changed = true; });
      try {
        await reads.client.cancelQueries({ queryKey: editorKey, exact: true });
        if (!ownersCurrent()) return fail("diagnostic-editor-blocked");
        await Promise.all([
          reads.client.fetchQuery({ queryKey: editorKey, staleTime: 0, meta: { scopes: ["project", "source", "translation", "resources", "review"] },
            queryFn: () => reviewCommands.editorSnapshot({ ...scope, unitId: destination.target.unitId, locale: destination.locale }) }),
          reads.client.fetchQuery({ queryKey: sourceKey, staleTime: 0, meta: { scopes: ["project", "source"] }, queryFn: source.read }),
          diagnostic ? reads.client.fetchQuery({ queryKey: locationKey, staleTime: 0, meta: { scopes: ["project", "source", "translation", "resources", "review"] },
            queryFn: () => reviewCommands.diagnosticLocation({ ...scope, unitId: destination.target.unitId, locale: destination.locale, runId: diagnostic.runId, diagnostic: diagnostic.diagnostic }) }) : Promise.resolve(null),
          semantic ? reads.client.fetchQuery({ queryKey: reads.key(semantic.key), staleTime: 0, meta: { scopes: semantic.scopes }, queryFn: semantic.read }) : Promise.resolve(null),
          findings ? reads.client.fetchQuery({ queryKey: reads.key(findings.key), staleTime: 0, meta: { scopes: findings.scopes }, queryFn: findings.read }) : Promise.resolve(null),
        ]);
        const snapshot = reads.client.getQueryData<ReviewEditorSnapshot>(editorKey), sourceValue = reads.client.getQueryData<ContentScope>(sourceKey);
        const location = diagnostic ? reads.client.getQueryData<Awaited<ReturnType<typeof reviewCommands.diagnosticLocation>>>(locationKey) : null;
        const semanticFacts = { view: semantic ? reads.client.getQueryData<AiSemanticReviewView | null>(reads.key(semantic.key)) : null,
          findings: findings ? reads.client.getQueryData<ReviewFindingView>(reads.key(findings.key)) : null };
        const witnesses = [editorKey, sourceKey, ...(diagnostic ? [locationKey] : []), ...(semantic ? [reads.key(semantic.key)] : []), ...(findings ? [reads.key(findings.key)] : [])].map(key => ({ key, query: reads.client.getQueryCache().find({ queryKey: key, exact: true }), version: reads.client.getQueryState(key)?.dataUpdateCount }));
        const confirmed = () => ownersCurrent() && !changed && witnesses.every(({ key, query, version }) => {
          const latest = reads.client.getQueryCache().find({ queryKey: key, exact: true });
          return latest === query && latest?.state.status === "success" && latest.state.fetchStatus === "idle" && latest.state.error === null
            && !latest.state.isInvalidated && latest.state.dataUpdateCount === version;
        });
        if (!confirmed() || !snapshot || !sourceValue || snapshot.target.unitId !== destination.target.unitId || snapshot.target.locale !== destination.locale
          || snapshot.translations.unitId !== destination.target.unitId || snapshot.translations.locale !== destination.locale
          || snapshot.target.sourceSnapshotId !== sourceValue.currentSnapshot) return fail("diagnostic-location-changed");
        const target = snapshot.target;
        if (diagnostic && (!location || !diagnosticLocationMatchesTarget(location, diagnostic, target, semanticFacts) || location.basis !== diagnostic.basis
          || !sameReviewBasis(location.basisEvidence, diagnostic.basisEvidence) || target.sourceRevisionId !== destination.target.sourceRevisionId
          || target.sourceText !== destination.target.sourceText || target.translationText !== diagnostic.translationText
          || snapshot.translations.currentText !== diagnostic.translationText
          || (snapshot.translations.current?.eventId ?? null) !== location.basisEvidence.selectionId
          || (snapshot.translations.current?.revisionId ?? null) !== location.basisEvidence.revisionId)) return fail("diagnostic-location-changed");
        return () => {
          if (!confirmed()) return fail("diagnostic-location-changed");
          if (!translation.begin({ unitId: target.unitId, locale: target.locale, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, snapshot.translations.current, snapshot.translations.currentText)) return fail("diagnostic-editor-blocked");
          const memory = committed.current.view.memory;
          const anchor: ReviewDiagnosticAnchor | null = location && diagnostic ? { ...scope, value: location,
            diagnostic: { runId: diagnostic.runId, source: diagnostic.source, diagnostic: diagnostic.diagnostic }, sourceText: target.sourceText, translationText: target.translationText, editSeq: translation.current()!.editSeq } : null;
          memory.write("translation", "tab", "edit"); memory.write("translation", "targetLocale", destination.locale);
          memory.write("translation", "returnToAi", false); memory.write("translation", "reviewReturn", capture.returnTo);
          memory.write("translation", "diagnosticAnchor", anchor); return true;
        };
      } catch (error) { return fail(isCommandError(error) && error.reason === "review-diagnostic-current" ? "diagnostic-location-changed" : "diagnostic-location-read"); }
      finally { stop(); }
    }
    if (destination.kind === "review-target") {
      const before = review.current(), originalAi = ai.current(), originalProject = committed.current.project;
      const unavailable = () => review.inFlight() || review.current().busyMutation || !!review.current().pending
        || review.current().batchRunning || !!review.current().checkReview || review.current().checkConsent.length > 0;
      const fail = (reason: string) => { if (current()) setFailure(reason); return false; };
      if (unavailable()) return fail("review-handoff-blocked");
      if (!originalProject.metadata.targetLocales.includes(destination.locale)) return fail("review-handoff-unavailable");
      const aiKey = reads.key(["aiCommands", destination.origin.attemptId]);
      const aiQuery = reads.client.getQueryState<AiView | null>(aiKey), originalView = aiQuery?.data;
      const aiVersion = aiQuery?.dataUpdateCount;
      const aiCurrent = () => {
        const owner = ai.current(), query = reads.client.getQueryState<AiView | null>(aiKey), value = query?.data;
        const row = value?.rows.find(row => row.itemId === destination.origin.itemId);
        return !ai.reserved() && owner.editSeq === destination.origin.editSeq && owner.editSeq === originalAi.editSeq
          && owner.attempt === destination.origin.attemptId && query?.status === "success" && query.fetchStatus === "idle"
          && !query.isInvalidated && query.error === null && value === originalView && query.dataUpdateCount === aiVersion
          && value?.detail.attemptId === destination.origin.attemptId && value.detail.taskId === destination.origin.taskId
          && row?.item.unitId === destination.target.unitId && row.item.targetLocale === destination.locale
          && row.item.sourceRevisionId === destination.target.sourceRevisionId;
      };
      if (!aiCurrent()) return fail("review-handoff-changed");
      const targetKey = reads.key(["review-target", destination.target.unitId, destination.locale]);
      const source = sourceReads.scope(scope);
      let invalidated = false;
      const unsubscribe = reads.subscribeChanges(scopes => {
        if (scopes.some(value => ["project", "source", "translation", "resources", "review"].includes(value))) invalidated = true;
      });
      try {
        await reads.client.cancelQueries({ queryKey: targetKey, exact: true });
        if (!current() || !aiCurrent()) return fail("review-handoff-changed");
        await reads.client.invalidateQueries({ queryKey: targetKey, exact: true, refetchType: "none" });
        await Promise.all([
          reads.client.fetchQuery({ queryKey: targetKey, staleTime: 0, meta: { scopes: ["source", "translation", "resources", "review"] },
            queryFn: () => reviewCommands.target({ ...scope, unitId: destination.target.unitId, locale: destination.locale }) }),
          reads.client.fetchQuery({ queryKey: reads.key(source.key), staleTime: 0, meta: { scopes: ["project", "source"] },
            queryFn: source.read }),
        ]);
        // Successful fetches can structurally share earlier cache data rather
        // than keep the returned response object. Pin the canonical identities.
        const target = reads.client.getQueryData<ReviewTarget>(targetKey);
        const sourceValue = reads.client.getQueryData<ContentScope>(reads.key(source.key));
        if (!target || !sourceValue) return fail("review-handoff-changed");
        const targetVersion = reads.client.getQueryState(targetKey)?.dataUpdateCount;
        const sourceVersion = reads.client.getQueryState(reads.key(source.key))?.dataUpdateCount;
        const evidenceCurrent = () => {
          const query = reads.client.getQueryState(targetKey), sourceQuery = reads.client.getQueryState(reads.key(source.key));
          return current() && live() && !invalidated && aiCurrent() && review.current() === before && !unavailable()
            && committed.current.project.sessionToken === originalProject.sessionToken
            && committed.current.project.metadata.metadataRevision === originalProject.metadata.metadataRevision
            && committed.current.project.metadata.sourceLocale === originalProject.metadata.sourceLocale
            && committed.current.project.metadata.targetLocales.includes(destination.locale)
            && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null
            && query.data === target && query.dataUpdateCount === targetVersion
            && sourceQuery?.status === "success" && sourceQuery.fetchStatus === "idle" && !sourceQuery.isInvalidated && sourceQuery.error === null
            && sourceQuery.data === sourceValue && sourceQuery.dataUpdateCount === sourceVersion;
        };
        if (!evidenceCurrent()) return fail("review-handoff-changed");
        if (target.unitId !== destination.target.unitId || target.locale !== destination.locale
          || target.sourceRevisionId !== destination.target.sourceRevisionId || target.sourceSnapshotId !== sourceValue.currentSnapshot) return fail("review-handoff-source");
        if (!target.selectionId || !target.revisionId || target.translationText === null) return fail("review-handoff-no-selection");
        if (target.basisEvidence.sourceSnapshotId !== target.sourceSnapshotId || target.basisEvidence.sourceRevisionId !== target.sourceRevisionId
          || target.basisEvidence.selectionId !== target.selectionId || target.basisEvidence.revisionId !== target.revisionId) return fail("review-handoff-changed");
        return () => {
          if (!evidenceCurrent() || !review.receiveTarget(target, before)) return fail("review-handoff-changed");
          const selected = review.current().selected!;
          const presentation: ReviewHandoffPresentation = { unitId: selected.unitId, locale: selected.locale, basis: selected.basis,
            currentBasis: target.basis, fallbackId: target.currentFallback?.fallbackId ?? null };
          const memory = committed.current.view.memory;
          memory.write("review", "tab", "review"); memory.write("review", "aiHandoff", presentation);
          memory.write("review", "editorOrigin", null); memory.write("review", "editorReturned", null);
          memory.write("review", "returnToAi", true);
          return true;
        };
      } catch {
        return fail("review-handoff-read");
      } finally { unsubscribe(); }
    }
    if (destination.kind === "resource-correction-return") {
      const capture = destination.capture, original = committed.current.view.memory.read<CorrectionEditorTarget | null>("resources", "correctionEditorReturn"), draft = translation.current();
      if (!original || JSON.stringify(original) !== JSON.stringify(capture) || !draft || draft.unitId !== capture.target.unitId || draft.locale !== capture.locale
        || resources.inFlight() || resources.current().pending || resources.factBlocked() || resources.tool.blocked() || resources.tool.hasDraft()
        || translation.mutationReserved || translation.protection.blocked() || translation.candidates.blocked()) {
        setFailure("correction-editor-blocked"); return false;
      }
      committed.current.view.memory.write("translation", "tab", "edit");
      committed.current.view.memory.write("resources", "correctionEditorReturn", null);
      return true;
    }
    if (destination.kind === "resource-correction") {
      const capture = destination.capture, before = resources.current();
      const editorCurrent = () => {
        const draft = translation.current();
        return !!draft && draft.unitId === capture.target.unitId && draft.locale === capture.locale
          && draft.sourceRevisionId === capture.target.sourceRevisionId && draft.editSeq === capture.editSeq
          && draft.baseSelectionId === capture.selectionId && draft.baseRevisionId === capture.revisionId
          && !draft.pending && !draft.pendingSelection && !draft.saving && !draft.selecting
          && !translation.mutationReserved && !translation.protection.blocked() && !translation.candidates.blocked();
      };
      if (!editorCurrent() || !resources.canReceiveCorrection(capture.locale)) { setFailure("correction-editor-blocked"); return false; }
      const source = sourceReads.scope(scope), key = ["resource-correction-basis", capture.target.unitId, capture.locale, capture.selectionId];
      let invalidated = false;
      const exactKeys = [reads.key(source.key), reads.key(key)];
      const uncache = reads.client.getQueryCache().subscribe(event => {
        if (exactKeys.some(queryKey => matchQuery({ queryKey, exact: true }, event.query))
          && (event.type === "removed" || event.type === "updated" && event.action.type === "invalidate")) invalidated = true;
      });
      const unchange = reads.subscribeChanges(scopes => { if (scopes.some(value => ["project", "source", "translation"].includes(value))) invalidated = true; });
      try {
        await Promise.all([
          reads.client.fetchQuery({ queryKey: reads.key(source.key), staleTime: 0, meta: { scopes: source.scopes }, queryFn: source.read }),
          reads.client.fetchQuery({ queryKey: reads.key(key), staleTime: 0, meta: { scopes: ["source", "translation"] },
            queryFn: () => resourceCommands.correctionBasis({ ...scope, unitId: capture.target.unitId, locale: capture.locale, afterSelectionId: capture.selectionId }) }),
        ]);
        const evidence = reads.client.getQueryData<CorrectionTermEvidence>(reads.key(key)), sourceValue = reads.client.getQueryData<ContentScope>(reads.key(source.key));
        const checked = (queryKey: readonly unknown[], data: unknown) => { const query = reads.client.getQueryState(reads.key(queryKey));
          return query?.status === "success" && !query.error && query.fetchStatus === "idle" && !query.isInvalidated && query.data === data; };
        const fresh = () => current() && !invalidated && editorCurrent() && !!evidence && !!sourceValue && checked(key, evidence) && checked(source.key, sourceValue)
          && sourceValue.currentSnapshot === capture.sourceSnapshotId && evidence.current && evidence.basis.sourceSnapshotId === capture.sourceSnapshotId
          && evidence.basis.sourceRevisionId === capture.target.sourceRevisionId && evidence.basis.unitId === capture.target.unitId
          && evidence.basis.locale === capture.locale && evidence.basis.after.selectionId === capture.selectionId
          && evidence.basis.after.revisionId === capture.revisionId && evidence.sourceText === capture.target.sourceText;
        if (!evidence || !fresh() || !resources.receiveCorrection(evidence, before, fresh)) { setFailure("correction-editor-changed"); return false; }
        committed.current.view.memory.write("resources", "tab", "updates");
        committed.current.view.memory.write("resources", "correctionEditorReturn", structuredClone(capture));
        return true;
      } catch (error) {
        if (current() && invalidated) { setFailure("correction-editor-changed"); return false; }
        throw error;
      } finally { uncache(); unchange(); }
    }
    if (destination.kind === "resource-context-return") {
      const capture=destination.capture, original=committed.current.view.memory.read<ContextEditorTarget|null>("resources","contextEditorReturn"), draft=translation.current();
      if (!original || JSON.stringify(original)!==JSON.stringify(capture) || !draft || draft.unitId!==capture.target.unitId || draft.locale!==capture.locale
        || resources.inFlight() || resources.current().pending || resources.tool.blocked() || resources.tool.hasDraft()
        || translation.mutationReserved || translation.protection.blocked() || translation.candidates.blocked()) {
        setFailure("context-editor-blocked");return false;
      }
      // Return to the retained editor, including newer text or a source-change
      // warning. Never begin a replacement draft from the old navigation target.
      committed.current.view.memory.write("translation","tab","edit");
      committed.current.view.memory.write("resources","contextEditorReturn",null);
      return true;
    }
    if (destination.kind === "resource-context") {
      const capture=destination.capture, before=resources.current();
      const editorCurrent=()=>{const draft=translation.current();return !!draft && draft.unitId===capture.target.unitId && draft.locale===capture.locale
        && draft.sourceRevisionId===capture.target.sourceRevisionId && draft.editSeq===capture.editSeq
        && !translation.mutationReserved && !translation.protection.blocked() && !translation.candidates.blocked();};
      if (!editorCurrent() || !resources.canReceiveContext(capture.locale)) {setFailure("context-editor-blocked");return false;}
      const source=sourceReads.scope(scope), key=["editor-snapshot",capture.target.unitId,capture.locale];
      // A later successful response cannot erase an invalidation observed while
      // this explicit handoff was waiting. These witnesses own only this read.
      let invalidated=false;
      const exactKeys=[reads.key(source.key),reads.key(key)];
      const uncache=reads.client.getQueryCache().subscribe(event=>{
        if(exactKeys.some(queryKey=>matchQuery({queryKey,exact:true},event.query))
          && (event.type==="removed" || event.type==="updated" && event.action.type==="invalidate"))invalidated=true;
      });
      const unchange=reads.subscribeChanges(scopes=>{if(scopes.some(value=>["project","source","translation","resources","review"].includes(value)))invalidated=true;});
      try {
      await Promise.all([
        reads.client.fetchQuery({queryKey:reads.key(source.key),staleTime:0,meta:{scopes:source.scopes},queryFn:source.read}),
        reads.client.fetchQuery({queryKey:reads.key(key),staleTime:0,meta:{scopes:["source","translation","resources","review"]},
          queryFn:()=>reviewCommands.editorSnapshot({...scope,unitId:capture.target.unitId,locale:capture.locale})}),
      ]);
      const snapshot=reads.client.getQueryData<ReviewEditorSnapshot>(reads.key(key)), sourceValue=reads.client.getQueryData<ContentScope>(reads.key(source.key));
      const checked=(queryKey:readonly unknown[],data:unknown)=>{const query=reads.client.getQueryState(reads.key(queryKey));
        return query?.status==="success" && query.error===null && query.fetchStatus==="idle" && !query.isInvalidated && query.data===data;};
      const fresh=()=>current() && !invalidated && editorCurrent() && !!snapshot && !!sourceValue && checked(key,snapshot) && checked(source.key,sourceValue)
        && sourceValue.currentSnapshot===capture.sourceSnapshotId && snapshot.target.sourceSnapshotId===capture.sourceSnapshotId
        && snapshot.target.unitId===capture.target.unitId && snapshot.target.locale===capture.locale && snapshot.target.sourceRevisionId===capture.target.sourceRevisionId
        && snapshot.target.nativeKey===capture.target.key && snapshot.target.sourceText===capture.target.sourceText
        && snapshot.readVersion===capture.readVersion && (snapshot.context?.revisionId??null)===capture.contextRevisionId
        && (!snapshot.context || snapshot.context.unitId===capture.target.unitId && snapshot.context.locale===capture.locale);
      if (!snapshot || !fresh() || !resources.receiveContext({unitId:snapshot.target.unitId,sourceRevisionId:snapshot.target.sourceRevisionId,
        occurrence:{key:snapshot.target.nativeKey,text:snapshot.target.sourceText}},capture.locale,snapshot.context,before,fresh)) {
        setFailure("context-editor-changed");return false;
      }
      committed.current.view.memory.write("resources","tab","context");
      committed.current.view.memory.write("resources","contextEditorReturn",structuredClone(capture));return true;
      } finally {uncache();unchange();}
    }
    if (destination.kind === "tool-query") {
      if (resources.inFlight() || resources.current().pending || !resources.tool.addText(destination.text)) {
        setFailure("navigation-edited"); return false;
      }
      committed.current.view.memory.write("resources", "tab", "queries");
      return true;
    }
    if (destination.kind === "saved-build") {
      const accepted = release.showSavedBuild(destination.attemptId);
      if (!accepted) setFailure("navigation-edited");
      return accepted;
    }
    if (destination.kind === "arena-comparison") {
      const before = arena.current(), metadata = committed.current.project.metadata;
      if (arena.reserved() || before.draft || translation.candidates.blocked() || translation.mutationReserved || translation.protection.blocked()
        || translation.current()?.pending || translation.current()?.pendingSelection || translation.current()?.saving || translation.current()?.selecting
        || !metadata.targetLocales.includes(destination.locale)
        || !/^[1-9]\d{0,18}$/.test(destination.revisionOrdinal) || BigInt(destination.revisionOrdinal) > 9223372036854775807n) { setFailure("arena-context-blocked"); return false; }
      const source = sourceReads.scope(scope), editorKey = ["editor-snapshot", destination.target.unitId, destination.locale];
      const historyKey = ["arena-entry-history", destination.target.unitId, destination.locale, destination.revisionOrdinal];
      await Promise.all([
        reads.client.fetchQuery({ queryKey: reads.key(source.key), staleTime: 0, meta: { scopes: source.scopes }, queryFn: source.read }),
        reads.client.fetchQuery({ queryKey: reads.key(editorKey), staleTime: 0, meta: { scopes: ["source", "translation", "resources", "review"] },
          queryFn: () => reviewCommands.editorSnapshot({ ...scope, unitId: destination.target.unitId, locale: destination.locale }) }),
        reads.client.fetchQuery({ queryKey: reads.key(historyKey), staleTime: 0, meta: { scopes: ["source", "translation"] },
          queryFn: () => translationCommands.history({ ...scope, unitId: destination.target.unitId, locale: destination.locale,
            afterOrdinal: (BigInt(destination.revisionOrdinal) - 1n).toString(), limit: 1 }) }),
      ]);
      // Query retains canonical references when a fresh response is equal to
      // its cached value. Inspect those checked records, not fetchQuery's raw
      // response objects, so an unchanged editor remains a valid destination.
      const sourceValue = reads.client.getQueryData<ContentScope>(reads.key(source.key));
      const snapshot = reads.client.getQueryData<ReviewEditorSnapshot>(reads.key(editorKey));
      const history = reads.client.getQueryData<TranslationHistory>(reads.key(historyKey));
      const checked = (key: readonly unknown[], data: unknown) => {
        const value = reads.client.getQueryState(reads.key(key));
        return value?.status === "success" && value.error === null && value.fetchStatus === "idle" && !value.isInvalidated && value.data === data;
      };
      const revision = history?.rows[0];
      if (!current() || committed.current.project.metadata.sourceLocale !== metadata.sourceLocale
        || !sourceValue || !snapshot || !history
        || !checked(source.key, sourceValue) || !checked(editorKey, snapshot) || !checked(historyKey, history)
        || !sourceValue.currentSnapshot || snapshot.target.sourceSnapshotId !== sourceValue.currentSnapshot
        || snapshot.target.unitId !== destination.target.unitId || snapshot.target.locale !== destination.locale
        || snapshot.target.sourceRevisionId !== destination.target.sourceRevisionId
        || history.unitId !== destination.target.unitId || history.locale !== destination.locale
        || revision?.revisionId !== destination.revisionId || revision.ordinal !== destination.revisionOrdinal
        || revision.unitId !== destination.target.unitId || revision.locale !== destination.locale
        || !arena.receiveComparisonTarget(destination.target.unitId, destination.locale, destination.revisionId, before)) {
        setFailure("arena-context-blocked"); return false;
      }
      committed.current.view.memory.write("arena", "comparisonReturnTo", destination.returnTo);
      committed.current.view.memory.write("arena", "comparisonEntry", { ...destination.target, locale: destination.locale, revisionId: destination.revisionId, revisionOrdinal: destination.revisionOrdinal });
      return true;
    }
    if (destination.kind === "attempt") {
      let accepted = false;
      if (destination.area === "source") accepted = source.showAttempt(destination.attemptId);
      else if (destination.area === "ai") accepted = ai.showAttempt(destination.attemptId);
      else if (destination.area === "arena") accepted = arena.showAttempt(destination.attemptId);
      else {
        const draft = translation.current(), value = imports.current();
        if (!translation.protection.blocked() && !draft?.saving && !draft?.selecting && !draft?.pending && !draft?.pendingSelection
          && (!draft || (draft.text === (draft.baseText ?? "") && !draft.newerDraftSaved))
          && !value.busy && !imports.hasPending() && !imports.hasActive()) {
          accepted = imports.showAttempt(destination.attemptId);
          if (accepted) { translation.clear(); committed.current.view.memory.write("translation", "tab", "import");
            committed.current.view.memory.write("translation", "targetLocale", imports.current().targetLocale); }
        }
      }
      if (!accepted) setFailure("navigation-edited");
      return accepted;
    }
    const value = committed.current.project, draft = translation.current(), imported = imports.current();
    if (!value.metadata.targetLocales.includes(destination.locale) || translation.protection.blocked() || draft?.saving || draft?.selecting || draft?.pending || draft?.pendingSelection
      || (draft && (draft.text !== (draft.baseText ?? "") || draft.newerDraftSaved)) || imported.busy || imports.hasPending() || imports.hasActive()) {
      setFailure("navigation-edited"); return false;
    }
    const key = reads.key(["editor-snapshot", destination.target.unitId, destination.locale]);
    const snapshot = await reads.client.fetchQuery({ queryKey: key, staleTime: 0,
      meta: { scopes: ["source", "translation", "resources", "review"] },
      queryFn: () => reviewCommands.editorSnapshot({ ...scope, unitId: destination.target.unitId, locale: destination.locale }) });
    const checked = reads.client.getQueryState(key);
    if (!current() || !committed.current.project.metadata.targetLocales.includes(destination.locale)
      || committed.current.project.metadata.sourceLocale !== value.metadata.sourceLocale
      || checked?.status !== "success" || checked.fetchStatus !== "idle" || checked.isInvalidated || reads.client.getQueryData(key) !== snapshot
      || translation.protection.blocked() || translation.current()?.editSeq !== draft?.editSeq || translation.current()?.text !== draft?.text
      || imports.current().busy || imports.hasPending() || imports.hasActive()) return false;
    if (snapshot.target.unitId !== destination.target.unitId || snapshot.target.locale !== destination.locale
      || snapshot.translations.unitId !== destination.target.unitId || snapshot.translations.locale !== destination.locale) throw new Error("Invalid editor destination");
    const target = snapshot.target;
    if (destination.suggestedText !== undefined && target.sourceRevisionId !== destination.target.sourceRevisionId) {
      setFailure("source-changed"); return false;
    }
    if (!translation.begin({ unitId: target.unitId, locale: destination.locale, sourceRevisionId: target.sourceRevisionId,
      key: target.nativeKey, sourceText: target.sourceText }, snapshot.translations.current, snapshot.translations.currentText, destination.suggestedText)) return false;
    committed.current.view.memory.write("translation", "tab", "edit");
    committed.current.view.memory.write("translation", "targetLocale", destination.locale);
    committed.current.view.memory.write("translation", "returnToAi", destination.returnTo === "ai");
    committed.current.view.memory.write("translation", "reviewReturn", null);
    committed.current.view.memory.write("translation", "diagnosticAnchor", null);
    return true;
  }
  function blocked(area: WorkspaceArea) {
    const memory = committed.current.view.memory;
    if (area === "ai") {
      const originalPlan = ai.recovery.pendingPlan() ?? ai.discussions.firstBlockedPlan();
      if (originalPlan) ai.recordPlan(originalPlan);
    }
    if (area === "tasks") {
      memory.write("tasks", "showOwnerDialog", true);
      const activity = tasks.currentActivity();
      const unresolved = Object.values(tasks.state).find(value => value.phase === "preparing" || value.phase === "pending" || value.phase === "checking" || value.phase === "unknown");
      const target = activity && (tasks.busy || activity.phase === "unknown") ? activity.intent : unresolved?.target;
      if (target) { memory.write("tasks", "taskId", target.taskId); memory.write("tasks", "attemptId", target.attemptId);
        memory.write("tasks", "attemptCursor", "0"); memory.write("tasks", "offset", 0); }
    }
    if (area === "resources" && resources.tool.blocked()) memory.write("resources", "tab", "queries");
    if (area === "translation") {
      const draft = translation.current();
      memory.write("translation", "tab", sharing.blocked() || translation.candidates.blocked() || translation.candidates.hasDraft() || translation.protection.blocked() || draft && (draft.pending || draft.pendingSelection || draft.saving || draft.text !== (draft.baseText ?? "") || draft.newerDraftSaved) ? "edit" : "import");
    }
  }
  const ports = useRef({ live, inspect, consumer, accept, blocked });
  useLayoutEffect(() => { ports.current = { live, inspect, consumer, accept, blocked }; });
  const [navigation] = useState(() => new SessionNavigation({
    live: () => ports.current.live(), area: () => committed.current.view.area,
    show: area => committed.current.onActivate(area), consumer: area => ports.current.consumer(area),
    inspect: () => ports.current.inspect(), accept: (destination, current) => ports.current.accept(destination, current),
    blocked: area => ports.current.blocked(area),
    busy: (value, kind) => { setNavigating(value && kind === "navigation"); committed.current.onCoordinatingChange(value); },
    failure: value => setFailure(commandFailure(value)),
  }));
  async function navigate(destination: WorkspaceDestination) {
    if (disabled) return false;
    if (destination.kind !== "translation-find") { cancelFindFocus(); return navigation.navigate(destination); }
    cancelFindFocus();
    const project = committed.current.project, from = committed.current.view.area, trigger = document.activeElement;
    let finished = false, delivered = false;
    const activity = () => cancelFindFocus(request);
    const focus = (event: FocusEvent) => {
      const target = event.target;
      // Entering the existing workspace may focus its heading or retained editor.
      if (target !== trigger && target !== document.body && !(target instanceof Element
        && target.matches(".translation-workbench .workbench-heading h1, .translation-workbench .translation-draft-field textarea"))) activity();
    };
    function cleanup() {
      for (const type of ["pointerdown", "keydown", "input", "compositionstart"]) document.removeEventListener(type, activity, true);
      document.removeEventListener("focusin", focus, true);
    }
    const current = () => !finished && live() && !retired
      && committed.current.project.metadata.metadataRevision === project.metadata.metadataRevision
      && committed.current.view.area === (delivered ? "translation" : from);
    const request: TranslationFindFocusRequest = { ...scope, metadataRevision: project.metadata.metadataRevision, current,
      consume() { const accepted = current(); finished = true; cleanup();
        if (findFocus.current === request) { findFocus.current = null; deliverFindFocus.current = null; }
        return accepted; },
      cancel() { finished = true; cleanup(); } };
    for (const type of ["pointerdown", "keydown", "input", "compositionstart"]) document.addEventListener(type, activity, true);
    document.addEventListener("focusin", focus, true);
    findFocus.current = request;
    deliverFindFocus.current = () => { delivered = true; };
    const accepted = await navigation.navigate(destination);
    if (!accepted) { cancelFindFocus(request); if (live()) setFailure("navigation-edited"); }
    return accepted;
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelFindFocus(); navigation.dispose(); waiting.current.forEach(resolvers => resolvers.forEach(resolve => resolve(null))); waiting.current.clear(); handles.current.clear(); };
  }, [navigation]);
  useImperativeHandle(ref, () => ({ navigate,
    prepareExit: () => { cancelFindFocus(); return navigation.prepareExit(); }, retire: () => { cancelFindFocus(); reads.retire(); navigation.dispose(); } }), [navigation, disabled, reads]);
  const openTranslation = (target: import("./TranslationWorkbench").EditorTarget, locale: string, suggestedText?: string) =>
    navigation.navigate({ kind: "translation", target, locale, ...(suggestedText === undefined ? {} : { suggestedText }) });
  const openAiTranslation = (target: import("./TranslationWorkbench").EditorTarget, locale: string, suggestedText?: string) =>
    navigation.navigate({ kind: "translation", target, locale, returnTo: "ai", ...(suggestedText === undefined ? {} : { suggestedText }) });
  const openReviewTranslation = (target: import("./TranslationWorkbench").EditorTarget, locale: string, handoff?: ReviewEditorHandoff) =>
    handoff ? navigation.navigate({ kind: "review-edit", target, locale, handoff }) : openTranslation(target, locale);
  const openAiReview = (target: import("./TranslationWorkbench").EditorTarget, locale: string, origin: AiReviewOrigin) =>
    navigation.navigate({ kind: "review-target", target, locale, origin });
  const openComparison = (returnTo: "translation" | "ai") => (target: import("./TranslationWorkbench").EditorTarget, locale: string, revision: Pick<TranslationRevision, "revisionId" | "ordinal">) =>
    navigation.navigate({ kind: "arena-comparison", target, locale, revisionId: revision.revisionId, revisionOrdinal: revision.ordinal, returnTo });
  const attempt = (area: "source" | "translation" | "ai" | "arena", attemptId: string) => { void navigation.navigate({ kind: "attempt", area, attemptId }); };
  const locked = disabled || navigating;
  const sourceNoticeMessage = failureReason(failure) === "source-notice-handoff-blocked" || failureReason(failure) === "source-notice-handoff-changed" ? "sourceHook.captureBlocked" : null;
  const reviewMessage = failureReason(failure) === "review-handoff-no-selection" ? "ai.reviewHandoff.noSelection"
    : failureReason(failure) === "review-handoff-source" ? "ai.reviewHandoff.source"
    : failureReason(failure) === "review-handoff-unavailable" ? "ai.reviewHandoff.unavailable"
    : failureReason(failure) === "review-handoff-blocked" ? "ai.reviewHandoff.blocked"
    : failureReason(failure) === "review-handoff-changed" ? "ai.reviewHandoff.changed"
    : failureReason(failure) === "review-handoff-read" ? "ai.reviewHandoff.readFailed" : null;
  const comparisonReturnTo = view.memory.read<"translation" | "ai">("arena", "comparisonReturnTo");
  const reviewReturn = view.memory.read<ReviewEditorReturn | null>("translation", "reviewReturn");
  const diagnosticMessage = failureReason(failure) === "diagnostic-editor-blocked" ? "review.diagnosticNavigation.editorBlocked"
    : failureReason(failure) === "diagnostic-location-changed" ? "review.diagnosticNavigation.stale"
    : failureReason(failure) === "diagnostic-location-read" ? "review.diagnosticNavigation.readFailed"
    : failureReason(failure) === "diagnostic-return-changed" ? "review.diagnosticNavigation.returnChanged" : null;
  if (retired) return <section className="workbench-panel" aria-label={t("workbench.retiredDraftTitle")}>
    <h2>{t("workbench.retiredDraftTitle")}</h2><p>{t("workbench.retiredDraftHelp")}</p>
    <label className="field"><span>{t("workbench.retiredDraftData")}</span><textarea readOnly rows={18} value={JSON.stringify({
      translation: translation.current(), candidateDecision: translation.candidates.current(), translationImport: imports.current(), source: source.current(), sourceNotice: source.hook.current(), resources: resources.current(), resourceQueries: resources.tool.current(), mcpRetrieval: resources.tool.mcp.current(),
      review: review.current(), release: release.current(), ai: ai.current(), arena: arena.current(),
      tasks: { cancellation: tasks.state, adoption: tasks.currentActivity() },
    }, null, 2)} /></label>
  </section>;
  return <><SessionReadStatus />{navigating ? <p role="status">{t("workbench.openingDestination")}</p> : null}{failure ? <div role="alert" className="execution-feedback"><p>{t(diagnosticMessage ?? sourceNoticeMessage ?? reviewMessage ?? (failureReason(failure) === "session-exit-blocked" ? "workbench.exitBlocked" : failureReason(failure) === "arena-context-blocked" ? "arena.contextBlocked" : failureReason(failure)==="correction-editor-blocked" ? "correctionFeedback.blocked" : failureReason(failure)==="correction-editor-changed" ? "correctionFeedback.changed" : failureReason(failure)==="context-editor-blocked" ? "resource.contextEditorBlocked" : failureReason(failure)==="context-editor-changed" ? "resource.contextEditorChanged" : "workbench.navigationBlocked"))}</p><CommandFailureDetails failure={failure} />{diagnosticMessage ? <button className="secondary-button" disabled={locked} onClick={() => { void navigation.navigate({ kind: "area", area: "review" }); }}>{t("review.diagnosticNavigation.openReview")}</button> : null}{reviewMessage ? <button className="secondary-button" disabled={locked} onClick={() => { void navigation.navigate({ kind: "area", area: failureReason(failure) === "review-handoff-blocked" ? "review" : "translation" }); }}>{t(failureReason(failure) === "review-handoff-blocked" ? "ai.reviewHandoff.retained" : "ai.reviewHandoff.openCurrent")}</button> : null}</div> : null}
    <McpSharingPanel />
    {view.area === "overview" && !reads.retired ? <OverviewSourceObserver project={project} onSourceState={onSourceState} /> : null}
    {view.area === "source" ? <SourceWorkbench ref={handle => register("source", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenExtensions={onOpenExtensions}
      onOpenMaintenance={(sourceActionId, sourceEditSeq) => navigation.navigate({ kind: "maintenance-notice", sourceActionId, sourceEditSeq, aiEditSeq: ai.current().editSeq })}
      onOpenWork={() => { void navigation.navigate({ kind: "review-work" }); }} /> : null}
    {view.area === "translation" ? <TranslationWorkbench ref={handle => register("translation", handle)} project={project} disabled={locked} onOpenExtensions={onOpenExtensions}
      onOpenComparison={openComparison("translation")}
      onEditContext={capture=>navigation.navigate({kind:"resource-context",capture})}
      onProposeTerm={capture => navigation.navigate({ kind: "resource-correction", capture })}
      onQueryText={text => navigation.navigate({ kind: "tool-query", text })}
      onReturnToAi={view.memory.read<boolean>("translation", "returnToAi") ? () => { void navigation.navigate({ kind: "area", area: "ai" }); } : undefined}
      diagnosticAnchor={view.memory.read<ReviewDiagnosticAnchor | null>("translation", "diagnosticAnchor")}
      onReturnToReview={reviewReturn ? () => navigation.navigate({ kind: "review-return", capture: reviewReturn }) : undefined}
      aiSelection={{ count: ai.selected.length, locale: ai.locale, editSeq: ai.editSeq, available: ai.contentRangeAvailable }}
      onPrepareSelection={(selection, expectedEditSeq) => navigation.navigate({ kind: "ai-selection", selection, expectedEditSeq })} /> : null}
    {view.area === "resources" ? <ResourceWorkbench ref={handle => register("resources", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation}
      aiPreparation={{ editSeq: ai.editSeq, canReceive: preview => ai.canReceiveMcpQuery(preview, ai.editSeq),
        receive: (preview, querySequence, expectedEditSeq) => navigation.navigate({ kind: "ai-mcp-query", preview, querySequence, expectedEditSeq }) }}
      correctionEditorReturn={view.memory.read<CorrectionEditorTarget | null>("resources", "correctionEditorReturn")}
      onReturnFromCorrection={capture => navigation.navigate({ kind: "resource-correction-return", capture })}
      contextEditorReturn={view.memory.read<ContextEditorTarget|null>("resources","contextEditorReturn")}
      onReturnToEditor={capture=>navigation.navigate({kind:"resource-context-return",capture})} /> : null}
    {view.area === "review" ? <ReviewWorkbench ref={handle => register("review", handle)} project={project} disabled={locked} onOpenTranslation={openReviewTranslation} onOpenExtensions={onOpenExtensions} onOpenConnections={onOpenConnections}
      handoff={view.memory.read<ReviewHandoffPresentation>("review", "aiHandoff")}
      onReturnToAi={view.memory.read<boolean>("review", "returnToAi") ? () => navigation.navigate({ kind: "area", area: "ai" }) : undefined} /> : null}
    {view.area === "release" ? <ReleaseWorkbench ref={handle => register("release", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenExtensions={onOpenExtensions} /> : null}
    {view.area === "ai" ? <AiWorkbench ref={handle => register("ai", handle)} project={project} disabled={locked} onOpenComparison={openComparison("ai")} onOpenTranslation={openAiTranslation} onOpenReview={openAiReview} onOpenManual={area => navigation.navigate({ kind: "area", area })} onOpenMcpQuery={() => navigation.navigate({ kind: "mcp-query" })} onOpenTask={(taskId,attemptId)=>navigation.navigate({kind:"task",taskId,attemptId})} onOpenExtensions={onOpenExtensions} onOpenConnections={onOpenConnections} /> : null}
    {view.area === "arena" ? <ArenaWorkbench ref={handle => register("arena", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenConnections={onOpenConnections}
      onReturn={comparisonReturnTo ? () => { void navigation.navigate({ kind: "area", area: comparisonReturnTo }); } : undefined} /> : null}
    {view.area === "tasks" ? <ExecutionTasks ref={handle => register("tasks", handle)} project={project} disabled={locked}
      onSavedBuild={attemptId => navigation.navigate({ kind: "saved-build", attemptId })}
      onSourcePreview={id => attempt("source", id)} onTranslationPreview={id => attempt("translation", id)} onAiPreview={id => attempt("ai", id)} onArenaPreview={id => attempt("arena", id)} /> : null}
    <TaskDock project={project} disabled={locked} onOpen={row => {
      void navigation.navigate(row ? { kind: "task", taskId: row.taskId, attemptId: row.attemptId } : { kind: "task-list" });
    }} />
  </>;
}
