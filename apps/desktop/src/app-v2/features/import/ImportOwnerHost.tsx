import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext, type AttemptDetail } from "../../../executionCommands";
import { readCompleteAttempt } from "../../../executionRead";
import { isCommandError, type ProjectView } from "../../../projectCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { TranslationImportProvider, useTranslationImportSession } from "../../../TranslationImportSession";
import { translationCommands } from "../../../translationCommands";
import type { ProjectLifecycle, LeaveIntent } from "../../platform/projectLifecycle";
import type { TranslationDrafts } from "../editor/translationDrafts";
import type { ImportOwners } from "./importTypes";

interface Props {
  project: ProjectView;
  drafts: TranslationDrafts;
  lifecycle: ProjectLifecycle;
  onOwners: (value: ImportOwners | null) => void;
  onReveal: () => void;
}
interface ActivityObservation { identity: string; active: boolean; revision: string }
const leavesProject = (intent: LeaveIntent) => intent.kind === "open-project" || intent.kind === "close-project" || intent.kind === "close-window";

function ImportOwnerBridge({ project, lifecycle, onOwners, onReveal }: Omit<Props, "drafts">) {
  const imports = useTranslationImportSession(), tasks = useExecutionTaskSession(), reads = useSessionReads();
  const context = executionContext(project), state = imports.state, live = !reads.retired;
  const producerEnabled = live && !!state.extractionAttempt, checkerEnabled = live && !!state.checkAttempt, projectionEnabled = live && !!state.attempt;
  const producer = useSessionQuery({ key: ["translation-plugin-producer", state.extractionAttempt], scopes: ["execution"], enabled: producerEnabled,
    read: () => state.extractionAttempt ? readCompleteAttempt(context, state.extractionAttempt, "translation-extract") : Promise.resolve(null) });
  const checker = useSessionQuery({ key: ["translation-plugin-checker", state.checkAttempt], scopes: ["execution"], enabled: checkerEnabled,
    read: () => state.checkAttempt ? readCompleteAttempt(context, state.checkAttempt, "translation-semantic-check") : Promise.resolve(null) });
  const projection = useSessionQuery({ key: ["translation-plugin-projection", state.attempt], scopes: ["execution"], enabled: projectionEnabled,
    read: () => state.attempt ? readCompleteAttempt(context, state.attempt, "translation-import") : Promise.resolve(null) });
  const previewEnabled = projectionEnabled && !state.busy && !state.preview && projection.data?.attemptId === state.attempt
    && !projection.isFetching && !projection.error && projection.data.items.every(item => item.status.execution === "succeeded" && item.status.validation === "valid");
  const preview = useSessionQuery({ key: ["translation-import-preview", state.attempt, 0, 50, null], scopes: ["execution", "translation"], enabled: previewEnabled,
    read: async () => {
      if (!state.attempt) return null;
      try { return await translationCommands.preview({ ...context, attemptId: state.attempt, after: 0, limit: 50, basis: null }); }
      catch (error) { if (isCommandError(error) && (error.reason ?? error.field ?? error.code) === "translation-incomplete") return null; throw error; }
    } });
  useEffect(() => {
    if (live && preview.data && preview.data.attemptId === imports.current().attempt && !imports.current().preview) imports.ready(preview.data);
  }, [imports, live, preview.data]);

  const enabledReads = [[producerEnabled, producer], [checkerEnabled, checker], [projectionEnabled, projection], [previewEnabled, preview]] as const;
  const loading = enabledReads.some(([enabled, query]) => enabled && query.isFetching);
  const failure = enabledReads.find(([enabled, query]) => enabled && query.error)?.[1].error ?? null;
  const failedReads = useRef<(() => unknown)[]>([]);
  const retry = useCallback(() => { if (!reads.retired) failedReads.current.forEach(refetch => { void refetch(); }); }, [reads]);
  const callbacks = useRef({ onOwners, onReveal });
  const owners = useRef({ imports, tasks });
  const published = useRef<ImportOwners | null>(null);
  const lastActivity = useRef<ActivityObservation | null>(null);
  useLayoutEffect(() => {
    callbacks.current = { onOwners, onReveal }; owners.current = { imports, tasks };
    failedReads.current = enabledReads.flatMap(([enabled, query]) => enabled && query.error ? [query.refetch] : []);
    const previous = published.current;
    // Context methods read their owner's current refs. Publish only observable
    // changes, so a parent retaining this handle cannot feed itself rerenders.
    if (previous?.imports.state === state && previous.tasks.state === tasks.state && previous.tasks.activity === tasks.activity
      && previous.tasks.busy === tasks.busy && previous.observation.loading === loading && previous.observation.failure === failure) return;
    const next: ImportOwners = { imports, tasks, observation: { loading, failure, retry } };
    published.current = next; callbacks.current.onOwners(next);
  });
  useLayoutEffect(() => () => { published.current = null; callbacks.current.onOwners(null); }, []);
  useLayoutEffect(() => {
    function activity() {
      const owner = owners.current.imports, value = owner.current();
      const attempts: [string, string | null][] = [["translation-plugin-producer", value.extractionAttempt], ["translation-plugin-checker", value.checkAttempt],
        ["translation-plugin-projection", value.preview ? null : value.attempt]];
      const identity = JSON.stringify(attempts);
      // Core's checked close retires and clears reads before application drain.
      // Cache removal cannot turn a settled task into a newly active task.
      if (reads.retired && lastActivity.current?.identity === identity) return lastActivity.current;
      const observed = { identity, active: owner.hasActive(),
        revision: JSON.stringify(attempts.map(([key, id]) => {
          const detail = id ? reads.client.getQueryData<AttemptDetail | null>(reads.key([key, id])) : null;
          return [key, id, detail?.attemptId, detail?.items.map(item => [item.status.itemId, item.status.execution,
            item.status.validation, item.status.cancellationRequested, item.resultId])];
        })) };
      lastActivity.current = observed; return observed;
    }
    function inspect(intent: LeaveIntent) {
      if (!leavesProject(intent)) return { status: "ready" as const, revision: "retained-project-session" };
      const importer = owners.current.imports, value = importer.current(), observed = activity();
      const pending = importer.hasPending();
      return { status: value.busy || pending || observed.active ? "blocked" as const : "ready" as const,
        revision: JSON.stringify([value, pending, observed.active, observed.revision]) };
    }
    return lifecycle.register({ id: "translation-import", area: "translation", scope: { kind: "project", ...context }, inspect,
      prepareLeave: async (intent, proof, current) => proof() && current() && inspect(intent).status === "ready",
      reveal: () => callbacks.current.onReveal() });
  }, [lifecycle, reads, context.projectId, context.sessionToken]);
  return null;
}

function ImportTaskOwner(props: Props) {
  const tasks = useExecutionTaskSession();
  return <TranslationImportProvider project={props.project} mutations={props.drafts} tasks={tasks}>
    <ImportOwnerBridge project={props.project} lifecycle={props.lifecycle} onOwners={props.onOwners} onReveal={props.onReveal}/>
  </TranslationImportProvider>;
}

function ImportOwnerHost(props: Props) {
  return <ImportTaskOwner {...props}/>;
}
export default memo(ImportOwnerHost);
