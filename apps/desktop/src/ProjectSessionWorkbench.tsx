import { useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { SessionReadProvider, SessionReadStatus, useSessionReads } from "./SessionReadProvider";
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
import { useWorkspaceView, useWorkspaceViewChanges, type WorkspaceArea } from "./WorkbenchFrame";
import { executionContext } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { reviewCommands } from "./reviewCommands";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { SessionNavigation, type ExitDisposition, type SessionConsumer, type SessionExitPermit, type WorkspaceDestination } from "./sessionNavigation";

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
interface Props { project: ProjectView; disabled: boolean; onActivate: (area: WorkspaceArea) => void;
  onCoordinatingChange: (busy: boolean) => void; retired?: boolean; ref?: Ref<ProjectSessionHandle> }
export function ProjectSessionWorkbench(props: Props) {
  return <ProjectSessionOwners project={props.project}><SessionWorkbench {...props} /></ProjectSessionOwners>;
}

function SessionWorkbench({ project, disabled, onActivate, onCoordinatingChange, retired = false, ref }: Props) {
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
        [rel.editSeq, rel.languages, rel.names, rel.chosen?.releaseId, rel.selection?.selectionId, rel.preview?.previewId, rel.overwrite]),
      row("tasks", tasks.unresolved(), false, null),
      row("source", !!src.pendingApply || !!src.pendingStart,
        !!src.selection || Object.keys(src.lineage).length > 0 || !!src.actor.trim() || source.inFlight(), src.editSeq),
      row("translation", !!manual?.saving || !!manual?.selecting || !!manual?.pending || !!manual?.pendingSelection
        || imported.busy || !!imported.pendingStart || imported.uncertain.length > 0,
        !!manual && (manual.text !== (manual.baseText ?? "") || manual.newerDraftSaved),
        [manual?.unitId, manual?.locale, manual?.editSeq, manual?.text]),
      row("resources", resources.inFlight() || !!res.pending, resources.termDirty() || resources.contextDirty(), [res.termSeq, res.contextSeq]),
      row("review", review.inFlight() || rev.batchRunning || !!rev.pending,
        Object.values(rev.drafts).some(value => value.length > 0) || Object.keys(rev.chosen).length > 0,
        [rev.locale, rev.actor, rev.editSeq, Object.values(rev.chosen).map(value => [value.unitId, value.locale, value.basis]),
          Object.values(rev.draftTargets).map(value => [value.unitId, value.locale, value.basis])]),
      row("ai", ai.reserved(), prepared.dirty, [prepared.editSeq, prepared.consent, prepared.prepared?.attemptId]),
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
    if (destination.kind === "review-work") { committed.current.view.memory.write("review", "tab", "work"); return true; }
    if (destination.kind === "attempt") {
      let accepted = false;
      if (destination.area === "source") accepted = source.showAttempt(destination.attemptId);
      else if (destination.area === "ai") accepted = ai.showAttempt(destination.attemptId);
      else if (destination.area === "arena") accepted = arena.showAttempt(destination.attemptId);
      else {
        const draft = translation.current(), value = imports.current();
        if (!draft?.saving && !draft?.selecting && !draft?.pending && !draft?.pendingSelection
          && (!draft || (draft.text === (draft.baseText ?? "") && !draft.newerDraftSaved))
          && !value.busy && !value.pendingStart && value.uncertain.length === 0) {
          accepted = imports.showAttempt(destination.attemptId);
          if (accepted) { translation.clear(); committed.current.view.memory.write("translation", "tab", "import");
            committed.current.view.memory.write("translation", "targetLocale", imports.current().targetLocale); }
        }
      }
      if (!accepted) setFailure("navigation-edited");
      return accepted;
    }
    const value = committed.current.project, draft = translation.current(), imported = imports.current();
    if (!value.metadata.targetLocales.includes(destination.locale) || draft?.saving || draft?.selecting || draft?.pending || draft?.pendingSelection
      || (draft && (draft.text !== (draft.baseText ?? "") || draft.newerDraftSaved)) || imported.busy || imported.pendingStart || imported.uncertain.length) {
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
      || translation.current()?.editSeq !== draft?.editSeq || translation.current()?.text !== draft?.text
      || imports.current().busy || imports.current().pendingStart || imports.current().uncertain.length) return false;
    if (snapshot.target.unitId !== destination.target.unitId || snapshot.target.locale !== destination.locale
      || snapshot.translations.unitId !== destination.target.unitId || snapshot.translations.locale !== destination.locale) throw new Error("Invalid editor destination");
    const target = snapshot.target;
    if (!translation.begin({ unitId: target.unitId, locale: destination.locale, sourceRevisionId: target.sourceRevisionId,
      key: target.nativeKey, sourceText: target.sourceText }, snapshot.translations.current, snapshot.translations.currentText, destination.suggestedText)) return false;
    committed.current.view.memory.write("translation", "tab", "edit");
    committed.current.view.memory.write("translation", "targetLocale", destination.locale);
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
    if (area === "translation") {
      const draft = translation.current();
      memory.write("translation", "tab", draft && (draft.pending || draft.pendingSelection || draft.saving || draft.text !== (draft.baseText ?? "") || draft.newerDraftSaved) ? "edit" : "import");
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
  return <><SessionReadStatus />{navigating ? <p role="status">{t("workbench.openingDestination")}</p> : null}{failure ? <div role="alert" className="execution-feedback"><p>{t("workbench.navigationBlocked")}</p><CommandFailureDetails failure={failure} /></div> : null}
    {view.area === "source" ? <SourceWorkbench ref={handle => register("source", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} onOpenWork={() => { void navigation.navigate({ kind: "review-work" }); }} /> : null}
    {view.area === "translation" ? <TranslationWorkbench ref={handle => register("translation", handle)} project={project} disabled={locked} /> : null}
    {view.area === "resources" ? <ResourceWorkbench ref={handle => register("resources", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} /> : null}
    {view.area === "review" ? <ReviewWorkbench ref={handle => register("review", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} /> : null}
    {view.area === "release" ? <ReleaseWorkbench ref={handle => register("release", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} /> : null}
    {view.area === "ai" ? <AiWorkbench ref={handle => register("ai", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} /> : null}
    {view.area === "arena" ? <ArenaWorkbench ref={handle => register("arena", handle)} project={project} disabled={locked} onOpenTranslation={openTranslation} /> : null}
    {view.area === "tasks" ? <ExecutionTasks ref={handle => register("tasks", handle)} project={project} disabled={locked}
      onSourcePreview={id => attempt("source", id)} onTranslationPreview={id => attempt("translation", id)} onAiPreview={id => attempt("ai", id)} onArenaPreview={id => attempt("arena", id)} /> : null}
  </>;
}
