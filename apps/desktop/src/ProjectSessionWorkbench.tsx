import { useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { matchQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SessionReadProvider, SessionReadStatus, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TranslationDraftSession, useTranslationDraftSession } from "./TranslationDraftSession";
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
import { useWorkspaceView, useWorkspaceViewChanges, type WorkspaceArea } from "./WorkbenchFrame";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { reviewCommands } from "./reviewCommands";
import { sourceKeys, sourceReads } from "./sourceQueries";
import type { ContentScope } from "./sourceCommands";
import { commandFailure, failureReason, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { SessionNavigation, type ExitDisposition, type SessionConsumer, type SessionExitPermit, type WorkspaceDestination } from "./sessionNavigation";
import type { ContentSelection } from "./contentSelection";

/** The same project owners are shared by production assembly and isolated consumer tests. */
export function ProjectSessionOwners({ project, children, bridge = true }: { project: ProjectView; children: ReactNode; bridge?: boolean }) {
  return <SessionReadProvider context={executionContext(project)} bridge={bridge}>
    <TranslationDraftSession project={project}><ExecutionTaskSession project={project}><TranslationImportSession project={project}>
      <ReviewDraftSession project={project}><ResourceDraftSession project={project}><SourceDraftSession project={project}>
        <ArenaDraftSession project={project}><ReleaseDraftSession project={project}>
          <AiPreparationSession initialLocale={project.metadata.targetLocales[0] ?? ""} targetLocales={project.metadata.targetLocales}>
            {children}
          </AiPreparationSession>
        </ReleaseDraftSession></ArenaDraftSession>
      </SourceDraftSession></ResourceDraftSession></ReviewDraftSession>
    </TranslationImportSession></ExecutionTaskSession></TranslationDraftSession>
  </SessionReadProvider>;
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

function SessionWorkbench({ project, disabled, onActivate, onCoordinatingChange, onSourceState, onOpenExtensions, onOpenConnections, retired = false, ref }: Props) {
  const { t } = useTranslation(), view = useWorkspaceView(), reads = useSessionReads();
  useWorkspaceViewChanges();
  const translation = useTranslationDraftSession(), imports = useTranslationImportSession(), tasks = useExecutionTaskSession();
  const source = useSourceDraftSession(), resources = useResourceDraftSession(), review = useReviewDraftSession();
  const release = useReleaseDraftSession(), ai = useAiPreparation(), arena = useArenaDraftSession();
  const mounted = useRef(false), handles = useRef(new Map<WorkspaceArea, SessionConsumer>());
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
  function inspect(): ExitDisposition[] {
    const manual = translation.current(), imported = imports.current(), src = source.current(), res = resources.current();
    const rev = review.current(), rel = release.current(), prepared = ai.current(), comparison = arena.current();
    const row = (area: WorkspaceArea, blocked: boolean, dirty: boolean, revision: unknown): ExitDisposition =>
      ({ area, status: blocked ? "blocked" : dirty ? "dirty" : "ready", revision: JSON.stringify(revision) });
    return [
      row("release", release.reserved(), rel.buildDirty || rel.deliveryDirty,
        [rel.editSeq, rel.languages, rel.names, rel.buildChoice, rel.prepared?.review.inputDigest, rel.buildConsent, rel.checkReview?.inputDigest, rel.checkConsent, rel.checkAttempt, rel.savedAttempt, rel.chosen?.releaseId, rel.selection?.selectionId, rel.preview?.previewId, rel.overwrite]),
      row("tasks", tasks.unresolved(), false, null),
      row("source", source.hasPending(),
        !!src.selection || Object.keys(src.lineage).length > 0 || !!src.actor.trim() || source.inFlight(), src.editSeq),
      row("translation", translation.candidates.blocked() || translation.protection.blocked() || !!manual?.saving || !!manual?.selecting || !!manual?.pending || !!manual?.pendingSelection
        || imported.busy || imports.hasPending() || imports.hasActive(),
        translation.candidates.hasDraft() || !!manual && (manual.text !== (manual.baseText ?? "") || manual.newerDraftSaved),
        [manual?.unitId, manual?.locale, manual?.editSeq, manual?.text, translation.protection.current().pending,
          translation.candidates.current().editSeq,translation.candidates.current().pending]),
      row("resources", resources.inFlight() || !!res.pending || resources.tool.blocked(), resources.termDirty() || resources.contextDirty() || resources.tool.hasDraft(),
        [res.termSeq, res.contextSeq, resources.tool.draftSequence.current, resources.tool.current().capture?.review.inputDigest, resources.tool.current().pending]),
      row("review", review.inFlight() || rev.batchRunning || !!rev.pending,
        Object.values(rev.drafts).some(value => value.length > 0) || Object.keys(rev.chosen).length > 0 || !!rev.checkReview || rev.checkConsent.length > 0 || rev.advisoryChecks.length > 0,
        [rev.locale, rev.actor, rev.editSeq, rev.checkReview?.request, rev.checkConsent, rev.advisoryChecks, Object.values(rev.chosen).map(value => [value.unitId, value.locale, value.basis]),
          Object.values(rev.draftTargets).map(value => [value.unitId, value.locale, value.basis])]),
      row("ai", ai.reserved(), prepared.dirty, [prepared.editSeq, prepared.consent, prepared.capture, ai.planControl.current().pending, ai.agent.current().pending, ai.component.current().operation]),
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
    if (destination.kind === "review-work") { committed.current.view.memory.write("review", "tab", "work"); return true; }
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
    return true;
  }
  function blocked(area: WorkspaceArea) {
    const memory = committed.current.view.memory;
    if (area === "tasks") {
      memory.write("tasks", "showOwnerDialog", true);
      const activity = tasks.currentActivity();
      const unresolved = Object.values(tasks.state).find(value => value.phase === "preparing" || value.phase === "pending" || value.phase === "unknown");
      const target = activity && (tasks.busy || activity.phase === "unknown") ? activity.intent : unresolved?.target;
      if (target) { memory.write("tasks", "taskId", target.taskId); memory.write("tasks", "attemptId", target.attemptId);
        memory.write("tasks", "attemptCursor", "0"); memory.write("tasks", "offset", 0); }
    }
    if (area === "resources" && resources.tool.blocked()) memory.write("resources", "tab", "queries");
    if (area === "translation") {
      const draft = translation.current();
      memory.write("translation", "tab", translation.protection.blocked() || draft && (draft.pending || draft.pendingSelection || draft.saving || draft.text !== (draft.baseText ?? "") || draft.newerDraftSaved) ? "edit" : "import");
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
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; navigation.dispose(); waiting.current.forEach(resolvers => resolvers.forEach(resolve => resolve(null))); waiting.current.clear(); handles.current.clear(); };
  }, [navigation]);
  useImperativeHandle(ref, () => ({ navigate: destination => disabled ? Promise.resolve(false) : navigation.navigate(destination),
    prepareExit: () => navigation.prepareExit(), retire: () => { reads.retire(); navigation.dispose(); } }), [navigation, disabled, reads]);
  const openTranslation = (target: import("./TranslationWorkbench").EditorTarget, locale: string, suggestedText?: string) =>
    navigation.navigate({ kind: "translation", target, locale, ...(suggestedText === undefined ? {} : { suggestedText }) });
  const openAiTranslation = (target: import("./TranslationWorkbench").EditorTarget, locale: string, suggestedText?: string) =>
    navigation.navigate({ kind: "translation", target, locale, returnTo: "ai", ...(suggestedText === undefined ? {} : { suggestedText }) });
  const attempt = (area: "source" | "translation" | "ai" | "arena", attemptId: string) => { void navigation.navigate({ kind: "attempt", area, attemptId }); };
  const locked = disabled || navigating;
  if (retired) return <section className="workbench-panel" aria-label={t("workbench.retiredDraftTitle")}>
    <h2>{t("workbench.retiredDraftTitle")}</h2><p>{t("workbench.retiredDraftHelp")}</p>
    <label className="field"><span>{t("workbench.retiredDraftData")}</span><textarea readOnly rows={18} value={JSON.stringify({
      translation: translation.current(), translationImport: imports.current(), source: source.current(), resources: resources.current(),
      review: review.current(), release: release.current(), ai: ai.current(), arena: arena.current(),
      tasks: { cancellation: tasks.state, adoption: tasks.currentActivity() },
    }, null, 2)} /></label>
  </section>;
  return <><SessionReadStatus />{navigating ? <p role="status">{t("workbench.openingDestination")}</p> : null}{failure ? <div role="alert" className="execution-feedback"><p>{t(failureReason(failure) === "session-exit-blocked" ? "workbench.exitBlocked" : "workbench.navigationBlocked")}</p><CommandFailureDetails failure={failure} /></div> : null}
    {view.area === "overview" && !reads.retired ? <OverviewSourceObserver project={project} onSourceState={onSourceState} /> : null}
    {view.area === "source" ? <SourceWorkbench ref={handle => register("source", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenExtensions={onOpenExtensions} onOpenWork={() => { void navigation.navigate({ kind: "review-work" }); }} /> : null}
    {view.area === "translation" ? <TranslationWorkbench ref={handle => register("translation", handle)} project={project} disabled={locked} onOpenExtensions={onOpenExtensions}
      onQueryText={text => navigation.navigate({ kind: "tool-query", text })}
      onReturnToAi={view.memory.read<boolean>("translation", "returnToAi") ? () => { void navigation.navigate({ kind: "area", area: "ai" }); } : undefined}
      aiSelection={{ count: ai.selected.length, locale: ai.locale, editSeq: ai.editSeq, available: ai.contentRangeAvailable }}
      onPrepareSelection={(selection, expectedEditSeq) => navigation.navigate({ kind: "ai-selection", selection, expectedEditSeq })} /> : null}
    {view.area === "resources" ? <ResourceWorkbench ref={handle => register("resources", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} /> : null}
    {view.area === "review" ? <ReviewWorkbench ref={handle => register("review", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenExtensions={onOpenExtensions} /> : null}
    {view.area === "release" ? <ReleaseWorkbench ref={handle => register("release", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenExtensions={onOpenExtensions} /> : null}
    {view.area === "ai" ? <AiWorkbench ref={handle => register("ai", handle)} project={project} disabled={locked} onOpenTranslation={openAiTranslation} onOpenManual={area => navigation.navigate({ kind: "area", area })} onOpenExtensions={onOpenExtensions} onOpenConnections={onOpenConnections} /> : null}
    {view.area === "arena" ? <ArenaWorkbench ref={handle => register("arena", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenConnections={onOpenConnections} /> : null}
    {view.area === "tasks" ? <ExecutionTasks ref={handle => register("tasks", handle)} project={project} disabled={locked}
      onSavedBuild={attemptId => navigation.navigate({ kind: "saved-build", attemptId })}
      onSourcePreview={id => attempt("source", id)} onTranslationPreview={id => attempt("translation", id)} onAiPreview={id => attempt("ai", id)} onArenaPreview={id => attempt("arena", id)} /> : null}
    <TaskDock project={project} disabled={locked} onOpen={row => {
      void navigation.navigate(row ? { kind: "task", taskId: row.taskId, attemptId: row.attemptId } : { kind: "task-list" });
    }} />
  </>;
}
