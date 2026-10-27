import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { useStore } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { ArrowUp, BookOpen, ChevronDown, Circle, CircleDot, Command, Layers, PanelRight, Pin, Plus, Search, Settings, Sparkles, X } from "lucide-react";
import { ApplicationReadProvider } from "../ApplicationReadProvider";
import { SessionReadProvider } from "../SessionReadProvider";
import { executionContext } from "../executionCommands";
import { ExecutionTaskHandleProvider, type useExecutionTaskSession } from "../ExecutionTaskSession";
import { readRecentProjects, recentProjectName, rememberProject, type RecentProject } from "../recentProjects";
import { Button, IconButton } from "../design-system/Button";
import { Field, TextInput } from "../design-system/Field";
import { Banner, EmptyState, ErrorState, LoadingState } from "../design-system/Feedback";
import { Dialog, Sheet } from "../design-system/Dialog";
import { Menu } from "../design-system/Menu";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "../design-system/Tabs";
import { SplitView, SplitPanel, SplitHandle } from "../design-system/SplitView";
import { CommandPalette } from "../design-system/CommandPalette";
import { ProjectLifecycle, type ProjectSession } from "./platform/projectLifecycle";
import { useNativeProjectClose, useProjectLifecycle } from "./platform/useProjectLifecycle";
import type { EntryReviewEditorRequest } from "./features/review/navigationTypes";
import { createWorkspaceStore, type WorkspaceView } from "./workspace/workspaceStore";
import { createWorkspaceRouter } from "./workspace/workspaceRouter";
import { InteractionGate } from "./workspace/interactionGate";
import { registerWorkspaceCommands, createWorkspaceCommandDispatcher, workspaceCommandIds, type WorkspaceCommandId } from "./workspace/workspaceCommands";
import type { WorkbenchCommands } from "../workbenchCommands";
import type { EntriesHandle } from "./features/entries/EntriesView";
import type { DraftKey } from "../draftCommands";
import type { TranslationDrafts, TranslationDraftSnapshot } from "./features/editor/translationDrafts";
import type { EditorCommand, SegmentEditorHandle } from "./features/editor/SegmentEditor";
import type { LifecycleParticipant } from "./platform/projectLifecycle";
import type { ImportOwners } from "./features/import/importTypes";
import type { CandidateOwners } from "./features/candidates/candidateTypes";
import type { ReviewOwner } from "./features/review/reviewTypes";
import type { CandidateBatchSnapshot } from "./features/candidates/CandidateBatchSession";
import type { TranslationCandidateBatchPreviewCommandPayload } from "../workbenchCommands";
import type { WorkspaceSelection } from "./workspace/workspaceSelection";
import type { ComparisonSession } from "./features/comparison/ComparisonSession";
import type { ComparisonView } from "../arenaCommands";
import type { SegmentRow } from "../segmentCommands";
import { TokenizedText } from "../design-system/TokenizedText";
import { installWorkspaceMenu } from "./nativeMenu";
import { FeatureBoundary } from "./FeatureBoundary";
import styles from "./WorkbenchLayout.module.css";
import appStyles from "./WorkbenchApp.module.css";

const EntriesView = lazy(() => import("./features/entries/EntriesView"));
const EntryDetails = lazy(() => import("./features/entries/EntryDetails"));
const SegmentEditor = lazy(() => import("./features/editor/SegmentEditor"));
const ImportOwnerHost = lazy(() => import("./features/import/ImportOwnerHost"));
const ExecutionOwnerHost = lazy(() => import("./features/execution/ExecutionOwnerHost"));
const ReviewOwnerHost = lazy(() => import("./features/review/ReviewOwnerHost"));
const ReviewRecovery = lazy(() => import("./features/review/ReviewRecovery"));
const TranslationImportPanel = lazy(() => import("./features/import/TranslationImportPanel"));
const CandidateOwnerHost = lazy(() => import("./features/candidates/CandidateOwnerHost"));
const CandidateRecovery = lazy(() => import("./features/candidates/CandidateRecovery"));
const CandidateBatchPanel = lazy(() => import("./features/candidates/CandidateBatchPanel"));
const CandidateBatchRecovery = lazy(() => import("./features/candidates/CandidateBatchRecovery"));
const FocusedCandidate = lazy(() => import("./features/entries/FocusedCandidate"));
const ComparisonOwnerHost = lazy(() => import("./features/comparison/ComparisonOwnerHost"));
const ComparisonRecovery = lazy(() => import("./features/comparison/ComparisonRecovery"));
type Runtime = ReturnType<typeof createWorkspaceRouter>;
type ShellActions = { requestOpen: () => void; close: () => Promise<boolean>; refresh: () => void;
  openImport: () => Promise<void>; canOpenImport: () => boolean;
  confirm: (advance: boolean) => Promise<void>; exitEditor: () => Promise<void>; toggleFocus: () => Promise<void>; isEditing: () => boolean; canConfirm: () => boolean; canAdvance: () => boolean };
type SessionContext = { session: ProjectSession; lifecycle: ProjectLifecycle; runtime: Runtime; store: ReturnType<typeof createWorkspaceStore>; gate: InteractionGate; readOnly: boolean; requestOpen: () => void;
  drafts: TranslationDrafts | null; draftLoadFailed: boolean; retryDrafts: () => void; recoveryKey: DraftKey | null; revealDraft: (key: DraftKey | null) => void;
  importOwners: ImportOwners | null; importRecovery: boolean; requestImport: () => void; revealImport: () => void; hideImportRecovery: () => void;
  candidateOwners: CandidateOwners | null; requestCandidates: () => void; revealCandidates: () => void;
  reviewOwner: ReviewOwner | null; requestReview: () => void; revealReview: () => void; reviewRecovery: boolean; hideReviewRecovery: () => void;
  candidateBatchOpen: boolean; setCandidateBatchOpen: (open: boolean) => void;
  comparisonOwner: ComparisonSession | null; requestComparisons: () => void };
const WorkspaceContext = createContext<SessionContext | null>(null);
function useWorkspaceContext() { const value = useContext(WorkspaceContext); if (!value) throw new Error("A project workspace is required"); return value; }
function subscribeWidth(listener: () => void) { window.addEventListener("resize", listener); return () => window.removeEventListener("resize", listener); }
const noDraftState: TranslationDraftSnapshot = { hydration: "idle", revision: 0, failure: null, retired: false, mutationReserved: false, summaries: [] };
const noDraftSubscription = () => () => undefined;
const getNoDraftState = () => noDraftState;
const getNoCandidateBatchState = () => null;

function ProjectWorkspace({ session, lifecycle, gate, readOnly, requestOpen }: { session: ProjectSession; lifecycle: ProjectLifecycle; gate: InteractionGate; readOnly: boolean; requestOpen: () => void }) {
  const [store] = useState(() => createWorkspaceStore({ initialLocale: session.project.metadata.targetLocales[0] ?? "" }));
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [navigationFailed, setNavigationFailed] = useState(false);
  const [drafts, setDrafts] = useState<TranslationDrafts | null>(null), [draftLoadFailed, setDraftLoadFailed] = useState(false), [draftAttempt, setDraftAttempt] = useState(0);
  const [recoveryKey, setRecoveryKey] = useState<DraftKey | null>(null);
  const [importRequested, setImportRequested] = useState(false), [importOwners, setImportOwners] = useState<ImportOwners | null>(null), [importRecovery, setImportRecovery] = useState(false);
  const importStatus = useRef({ requested: false, owners: null as ImportOwners | null });
  const requestImport = useCallback(() => { importStatus.current.requested = true; setImportRequested(true); }, []);
  const revealImport = useCallback(() => { requestImport(); setImportRecovery(true); }, [requestImport]);
  const hideImportRecovery = useCallback(() => { setImportRecovery(false); }, []);
  const publishImportOwners = useCallback((value: ImportOwners | null) => { importStatus.current.owners = value; setImportOwners(value); }, []);
  const [candidatesRequested, setCandidatesRequested] = useState(false), [candidateOwners, setCandidateOwners] = useState<CandidateOwners | null>(null);
  const candidateStatus = useRef({ requested: false, owners: null as CandidateOwners | null });
  const requestCandidates = useCallback(() => { candidateStatus.current.requested = true; setCandidatesRequested(true); }, []);
  const revealCandidates = requestCandidates;
  const publishCandidateOwners = useCallback((value: CandidateOwners | null) => { candidateStatus.current.owners = value; setCandidateOwners(value); }, []);
  const [reviewRequested, setReviewRequested] = useState(false), [reviewOwner, setReviewOwner] = useState<ReviewOwner | null>(null), [reviewRecovery, setReviewRecovery] = useState(false);
  const reviewStatus = useRef({ requested: false, owner: null as ReviewOwner | null });
  const requestReview = useCallback(() => { reviewStatus.current.requested = true; setReviewRequested(true); }, []);
  const revealReview = useCallback(() => { requestReview(); setReviewRecovery(true); }, [requestReview]);
  const hideReviewRecovery = useCallback(() => setReviewRecovery(false), []);
  const publishReviewOwner = useCallback((owner: ReviewOwner | null) => { reviewStatus.current.owner = owner; setReviewOwner(owner); }, []);
  const [executionTasks, setExecutionTasks] = useState<ReturnType<typeof useExecutionTaskSession> | null>(null);
  const publishExecutionTasks = useCallback((owner: ReturnType<typeof useExecutionTaskSession> | null) => setExecutionTasks(owner), []);
  const revealTask = useCallback((operation: string | null, attemptId: string | null) => {
    if (operation === "ai-semantic-review" || operation === null && attemptId !== null && reviewStatus.current.owner?.semantic.current().attempts.includes(attemptId)) revealReview(); else revealImport();
  }, [revealReview, revealImport]);
  const [candidateBatchOpen, setCandidateBatchOpen] = useState(false);
  const revealCandidateBatch = useCallback(() => { requestCandidates(); setCandidateBatchOpen(true); }, [requestCandidates]);
  const [comparisonsRequested, setComparisonsRequested] = useState(false), [comparisonOwner, setComparisonOwner] = useState<ComparisonSession | null>(null);
  const comparisonStatus = useRef({ requested: false, owner: null as ComparisonSession | null });
  const requestComparisons = useCallback(() => { comparisonStatus.current.requested = true; setComparisonsRequested(true); }, []);
  const publishComparisonOwner = useCallback((owner: ComparisonSession | null) => { comparisonStatus.current.owner = owner; setComparisonOwner(owner); }, []);
  const draftParticipant = useRef<LifecycleParticipant | null>(null), draftOwner = useRef<TranslationDrafts | null>(null), readonlyRef = useRef(readOnly);
  readonlyRef.current = readOnly;
  // A stable registration protects the gap before the heavy draft module loads.
  // Its restore projection stays stable while the real participant is attached.
  useLayoutEffect(() => lifecycle.register({ id: "translation-drafts", area: "translation", scope: { kind: "project", ...executionContext(session.project) },
    inspect: intent => intent.kind === "restore" ? { status: "ready", revision: "initial-presentation" }
      : draftParticipant.current?.inspect(intent) ?? { status: "blocked", revision: "draft-owner-loading" },
    prepareLeave: (intent, proof, current) => draftParticipant.current?.prepareLeave(intent, proof, current) ?? Promise.resolve(false),
    reveal: () => draftParticipant.current?.reveal?.(),
  }), [lifecycle, session.project.sessionToken, session.project.metadata.projectId]);
  useLayoutEffect(() => lifecycle.register({ id: "translation-import-loading", area: "translation", scope: { kind: "project", ...executionContext(session.project) },
    inspect: intent => ["navigate", "language", "close-view", "restore"].includes(intent.kind) ? { status: "ready", revision: "retained-import-presentation" }
      : { status: importStatus.current.requested && !importStatus.current.owners ? "blocked" : "ready",
        revision: importStatus.current.requested ? importStatus.current.owners ? "import-owner-ready" : "import-owner-loading" : "import-not-requested" },
    prepareLeave: async () => false, reveal: revealImport,
  }), [lifecycle, session.project.sessionToken, session.project.metadata.projectId, revealImport]);
  useLayoutEffect(() => lifecycle.register({ id: "candidate-decisions-loading", area: "translation", scope: { kind: "project", ...executionContext(session.project) },
    inspect: intent => ["navigate", "language", "close-view", "restore"].includes(intent.kind) ? { status: "ready", revision: "retained-candidate-presentation" }
      : { status: candidateStatus.current.requested && !candidateStatus.current.owners ? "blocked" : "ready",
        revision: candidateStatus.current.requested ? candidateStatus.current.owners ? "candidate-owner-ready" : "candidate-owner-loading" : "candidate-not-requested" },
    prepareLeave: async () => false, reveal: revealCandidates,
  }), [lifecycle, session.project.sessionToken, session.project.metadata.projectId, revealCandidates]);
  useLayoutEffect(() => lifecycle.register({ id: "entry-review-loading", area: "review", scope: { kind: "project", ...executionContext(session.project) },
    inspect: intent => ["navigate", "language", "close-view", "restore"].includes(intent.kind) ? { status: "ready", revision: "retained-review-presentation" }
      : { status: reviewStatus.current.requested && !reviewStatus.current.owner ? "blocked" : "ready",
        revision: reviewStatus.current.requested ? reviewStatus.current.owner ? "review-owner-ready" : "review-owner-loading" : "review-not-requested" },
    prepareLeave: async () => false, reveal: revealReview,
  }), [lifecycle, session.project.sessionToken, session.project.metadata.projectId, revealReview]);
  useLayoutEffect(() => lifecycle.register({ id: "saved-comparisons-loading", area: "translation", scope: { kind: "project", ...executionContext(session.project) },
    inspect: intent => ["navigate", "language", "close-view", "restore"].includes(intent.kind) ? { status: "ready", revision: "retained-comparison-presentation" }
      : { status: comparisonStatus.current.requested && !comparisonStatus.current.owner ? "blocked" : "ready",
        revision: comparisonStatus.current.requested ? comparisonStatus.current.owner ? "comparison-owner-ready" : "comparison-owner-loading" : "comparison-not-requested" },
    prepareLeave: async () => false, reveal: requestComparisons,
  }), [lifecycle, session.project.sessionToken, session.project.metadata.projectId, requestComparisons]);
  useEffect(() => {
    let alive = true, owner: TranslationDrafts | undefined;
    setDrafts(null); setDraftLoadFailed(false);
    void import("./features/editor/translationDrafts").then(({ TranslationDrafts: Owner }) => {
      if (!alive) return;
      owner = new Owner({ context: executionContext(session.project), reads: session.reads, onReveal: setRecoveryKey });
      draftOwner.current = owner; draftParticipant.current = owner.lifecycleParticipant(); setDrafts(owner);
      if (readonlyRef.current || session.reads.retired) owner.retire(); else void owner.initialize();
    }).catch(() => { if (alive) setDraftLoadFailed(true); });
    return () => {
      alive = false;
      if (draftOwner.current === owner) { draftOwner.current = null; draftParticipant.current = null; }
      owner?.retire();
    };
  }, [session.project.sessionToken, session.project.metadata.projectId, session.reads, draftAttempt]);
  useEffect(() => { if (readOnly || session.reads.retired) drafts?.retire(); }, [drafts, readOnly, session.reads]);
  useEffect(() => lifecycle.register({ id: "workspace-composition", area: "translation", scope: { kind: "project", ...executionContext(session.project) },
    inspect: () => ({ status: gate.getSnapshot().composingOwners.length ? "blocked" : "ready", revision: JSON.stringify(gate.getSnapshot().composingOwners) }), prepareLeave: async () => false,
  }), [gate, lifecycle, session.project.sessionToken]);
  useEffect(() => {
    let alive = true, next: Runtime | undefined;
    // Let participant registration and StrictMode cleanup settle before acquiring a leave permit.
    queueMicrotask(() => {
      if (!alive) return;
      next = createWorkspaceRouter({ store, gate, guard: (intent, current) => lifecycle.prepareLeave(intent, current), component: WorkspaceShell, onError: () => { if (alive) setNavigationFailed(true); } });
      setRuntime(next);
      void next.ready.then(accepted => { if (alive && !accepted) setNavigationFailed(true); }).catch(() => { if (alive) setNavigationFailed(true); });
    });
    return () => { alive = false; next?.dispose(); };
  }, [store, gate, lifecycle]);
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  if (!runtime) return <LoadingState label={t("loadingEntries")} />;
  return <WorkspaceContext.Provider value={{ session, lifecycle, runtime, store, gate, readOnly, requestOpen, drafts, draftLoadFailed,
    retryDrafts: () => { if (draftOwner.current) void draftOwner.current.initialize(); else setDraftAttempt(attempt => attempt + 1); }, recoveryKey, revealDraft: setRecoveryKey,
    importOwners, importRecovery, requestImport, revealImport, hideImportRecovery,
    candidateOwners, requestCandidates, revealCandidates, candidateBatchOpen, setCandidateBatchOpen, comparisonOwner, requestComparisons,
    reviewOwner: executionTasks ? reviewOwner : null, requestReview, revealReview, reviewRecovery, hideReviewRecovery }}>
    {(importRequested || reviewRequested) && drafts ? <FeatureBoundary fallback={<ErrorState title={t("reviewUnavailable")} />}><Suspense fallback={null}>
      <ExecutionOwnerHost project={session.project} drafts={drafts} lifecycle={lifecycle} onReveal={revealTask} onOwner={publishExecutionTasks}>
        {importRequested ? <FeatureBoundary fallback={<ErrorState title={t("importUnavailable")} description={t("importHelp")} />}><Suspense fallback={null}>
          <ImportOwnerHost project={session.project} drafts={drafts} lifecycle={lifecycle} onOwners={publishImportOwners} onReveal={revealImport}/>
        </Suspense></FeatureBoundary> : null}
        {reviewRequested ? <FeatureBoundary fallback={<ErrorState title={t("reviewUnavailable")} />}><Suspense fallback={null}>
          <ReviewOwnerHost project={session.project} drafts={drafts} lifecycle={lifecycle} onOwner={publishReviewOwner} onReveal={revealReview}/>
        </Suspense></FeatureBoundary> : null}
      </ExecutionOwnerHost>
    </Suspense></FeatureBoundary> : null}
    {candidatesRequested && drafts ? <FeatureBoundary fallback={<ErrorState title={t("candidateUnavailable")} description={t("candidateUnavailableHelp")} />}><Suspense fallback={null}>
      <CandidateOwnerHost project={session.project} drafts={drafts} lifecycle={lifecycle} onOwners={publishCandidateOwners} onReveal={revealCandidates} onRevealBatch={revealCandidateBatch}/>
    </Suspense></FeatureBoundary> : null}
    {comparisonsRequested && drafts ? <FeatureBoundary fallback={<ErrorState title={t("comparisonUnavailable")} description={t("comparisonUnavailableHelp")} />}><Suspense fallback={null}>
      <ComparisonOwnerHost project={session.project} drafts={drafts} lifecycle={lifecycle} onOwner={publishComparisonOwner} onReveal={requestComparisons}/>
    </Suspense></FeatureBoundary> : null}
    {navigationFailed ? <Banner tone="error">{t("leaveChanged")}</Banner> : null}
    <ExecutionTaskHandleProvider value={executionTasks}><RouterProvider router={runtime.router} /></ExecutionTaskHandleProvider>
  </WorkspaceContext.Provider>;
}

function WorkspaceShell() {
  const { session, lifecycle, runtime, store, gate, readOnly, requestOpen, drafts, draftLoadFailed, retryDrafts, recoveryKey, revealDraft,
    importOwners, importRecovery, requestImport, revealImport, hideImportRecovery,
    candidateOwners, requestCandidates, revealCandidates, candidateBatchOpen, setCandidateBatchOpen, comparisonOwner, requestComparisons,
    reviewOwner, requestReview, revealReview, reviewRecovery, hideReviewRecovery } = useWorkspaceContext();
  const { t, i18n } = useTranslation();
  const message = useTranslation(undefined, { keyPrefix: "workbenchV2" }).t;
  const state = useStore(store), view = state.activeViewId ? state.views[state.activeViewId] : null;
  const lifecycleState = useProjectLifecycle(lifecycle);
  const interaction = useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  const draftState = useSyncExternalStore(drafts?.subscribe ?? noDraftSubscription, drafts?.getSnapshot ?? getNoDraftState, drafts?.getSnapshot ?? getNoDraftState);
  const candidateBatchState = useSyncExternalStore<CandidateBatchSnapshot | null>(candidateOwners?.batch.subscribe ?? noDraftSubscription,
    candidateOwners?.batch.getSnapshot ?? getNoCandidateBatchState, candidateOwners?.batch.getSnapshot ?? getNoCandidateBatchState);
  const narrow = useSyncExternalStore(subscribeWidth, () => innerWidth <= 1100, () => false);
  const wide = useSyncExternalStore(subscribeWidth, () => innerWidth >= 1440, () => false);
  const [registries, setRegistries] = useState<Map<string | null, WorkbenchCommands>>(new Map());
  const [registeredCommands, setRegisteredCommands] = useState<WorkbenchCommands | null>(null);
  const [palette, setPalette] = useState(false), [drawer, setDrawer] = useState(false);
  const drawerEditorClose = useRef(false);
  const paletteRelease = useRef<(() => void) | null>(null), drawerRelease = useRef<(() => void) | null>(null);
  const [commandFailed, setCommandFailed] = useState(false);
  const [presented, setPresented] = useState<{ candidates: string | null; protection: string | null; comparison: string | null; review: string | null }>({ candidates: null, protection: null, comparison: null, review: null });
  const reportPresented = useCallback((viewId: string, kind: "candidates" | "protection" | "comparison" | "review", visible: boolean) => setPresented(before => {
    const next = visible ? viewId : before[kind] === viewId ? null : before[kind];
    return next === before[kind] ? before : { ...before, [kind]: next };
  }), []);
  const [pendingImport, setPendingImport] = useState<{ viewId: string | null; locale: string | null } | null>(null);
  const entries = useRef<EntriesHandle>(null), dock = useRef<HTMLDivElement>(null);
  const candidateBatchTrigger = useRef<HTMLButtonElement>(null);
  const candidateBatchRecoveryTrigger = useRef<HTMLButtonElement>(null);
  const candidateBatchReturnFocus = useMemo(() => ({ get current() {
    const trigger = candidateBatchTrigger.current;
    return trigger?.isConnected && !trigger.disabled ? trigger : candidateBatchRecoveryTrigger.current;
  } }), []);
  const recoveryEditor = useRef<SegmentEditorHandle>(null);
  const split = useRef<HTMLDivElement>(null), splitHandle = useRef<HTMLDivElement>(null);
  const currentId = state.activeViewId;
  const importVisible = importRecovery || view?.kind === "entries" && view.entryMode === "import";
  const revealedImportFailure = useRef<typeof lifecycleState.failure>(null);
  const revealedReviewFailure = useRef<typeof lifecycleState.failure>(null);
  const recoveryEntry = recoveryKey ? drafts?.getEntry(recoveryKey) : undefined;
  const pendingDrafts = draftState.summaries.filter(summary => summary.hasPending);
  const disabled = readOnly || lifecycleState.phase !== "idle" || !!lifecycleState.pending;
  useEffect(() => { if (view?.kind === "entries" && (view.focus || view.selection) && !importVisible) requestCandidates(); }, [view?.kind, view?.focus, view?.selection !== null, importVisible, requestCandidates]);
  useEffect(() => {
    if (view?.kind === "entries" && view.focus && view.dock === "details" && ["detail", "issues"].includes(view.detailTab)
      && !importVisible && (!narrow || drawer)) requestReview();
  }, [view?.kind, view?.focus, view?.dock, view?.detailTab, importVisible, narrow, drawer, requestReview]);
  useEffect(() => {
    const failure = lifecycleState.failure;
    if (!failure || failure === revealedReviewFailure.current || failure.code !== "leave-blocked" || failure.ownerId !== "translation-drafts" || !reviewOwner) return;
    if (reviewOwner.current().pending || reviewOwner.inFlight()) { revealedReviewFailure.current = failure; revealReview(); }
  }, [lifecycleState.failure, reviewOwner, revealReview]);
  useEffect(() => {
    const failure = lifecycleState.failure;
    if (failure?.code === "leave-blocked" && failure.ownerId === "translation-drafts" && candidateOwners
      && (candidateOwners.decisions.blocked() || candidateOwners.protection.blocked())) revealCandidates();
  }, [lifecycleState.failure, candidateOwners, revealCandidates]);
  useEffect(() => {
    const failure = lifecycleState.failure, importer = importOwners?.imports;
    if (!failure || revealedImportFailure.current === failure || failure.code !== "leave-blocked" || failure.ownerId !== "translation-drafts" || !importer) return;
    // The shared draft coordinator may be the first blocked owner while the
    // import owns its reservation. Reveal that original request without routing.
    if (importer.hasPending() || importer.current().busy && draftState.mutationReserved && !draftState.summaries.some(summary => summary.hasPending)) {
      revealedImportFailure.current = failure; revealImport();
    }
  }, [lifecycleState.failure, importOwners, draftState.mutationReserved, draftState.summaries, revealImport]);
  const currentScope = () => {
    const current = lifecycle.getSnapshot();
    return !readOnly && current.phase === "idle" && !current.pending && current.session?.project.sessionToken === session.project.sessionToken
      ? { ...executionContext(session.project), area: "translation" as const } : null;
  };
  function closePalette() { paletteRelease.current?.(); paletteRelease.current = null; setPalette(false); }
  function openPalette() { if (paletteRelease.current) return; paletteRelease.current = gate.pushDialog("workspace-palette"); setPalette(true); }
  function closeDrawer() { drawerRelease.current?.(); drawerRelease.current = null; setDrawer(false); }
  useLayoutEffect(() => recoveryKey ? gate.pushDialog("draft-recovery") : undefined, [gate, recoveryKey !== null]);
  function showDock() {
    if (narrow && !drawerRelease.current) { drawerRelease.current = gate.pushDialog("workspace-dock"); setDrawer(true); }
    else requestAnimationFrame(() => dock.current?.focus());
  }
  const ids = state.viewOrder.join("|");
  useEffect(() => {
    let alive = true;
    void import("../workbenchCommands").then(({ WorkbenchCommands: Owner }) => {
      if (!alive) return;
      setRegistries(previous => {
        const next = new Map(previous);
        for (const id of [...store.getState().viewOrder, null]) if (!next.has(id)) next.set(id, new Owner());
        for (const id of next.keys()) if (id !== null && !store.getState().views[id]) next.delete(id);
        return next;
      });
    }).catch(() => { if (alive) setCommandFailed(true); });
    return () => { alive = false; };
  }, [ids, store]);
  const commands = registries.get(currentId);
  const commandsReady = !!commands && registeredCommands === commands;
  const scope = useMemo(() => ({ ...executionContext(session.project), area: "translation" as const }), [session.project.sessionToken, session.project.metadata.projectId]);
  useLayoutEffect(() => {
    if (!commands || !candidateOwners) return;
    return commands.register({ id: "translation.preview-candidate-batch", nameKey: "workbenchV2.candidateBatchMenu", category: "translation", scope,
      binding: null, risk: "reads-review", confirmation: "none", payloadKind: "translation-candidate-batch-preview",
      availability: input => {
        const current = store.getState(), active = current.activeViewId ? current.views[current.activeViewId] : null, batch = candidateOwners.batch.current();
        return !disabled && !candidateBatchOpen && current.activeViewId === currentId && active?.kind === "entries" && !!active.selection
          && JSON.stringify(input?.selection) === JSON.stringify(active.selection) && !!currentScope()
          && (batch.phase === "idle" || batch.phase === "complete" || batch.ended) && gate.canDispatch({ viewId: currentId, source: "button" }) ? { enabled: true } : { enabled: false, reason: "unavailable" };
      }, handler: input => {
        setCandidateBatchOpen(true);
        void candidateOwners.batch.capture(input.selection, input.mode, () => !!currentScope() && store.getState().activeViewId === currentId).catch(() => setCommandFailed(true));
      } });
  }, [commands, candidateOwners, scope, disabled, currentId, gate, store, candidateBatchOpen]);
  function previewCandidateBatch(mode: "stage" | "reject" | "restore", selection: WorkspaceSelection) {
    const payload: TranslationCandidateBatchPreviewCommandPayload = { kind: "translation-candidate-batch-preview", mode, selection };
    if (commandsReady && commands) commands.dispatch("translation.preview-candidate-batch", scope, payload);
  }
  const actions = useRef<ShellActions>({ requestOpen, close: () => lifecycle.close(), refresh: () => { void lifecycle.refresh(); entries.current?.refresh(); },
    openImport: async () => {}, canOpenImport: () => false,
    confirm: async (_advance: boolean) => {}, exitEditor: async () => {}, toggleFocus: async () => {}, isEditing: () => false, canConfirm: () => false, canAdvance: () => false });
  actions.current = { requestOpen, close: () => lifecycle.close(), refresh: () => { void lifecycle.refresh(); entries.current?.refresh(); },
    openImport: async () => {
      requestImport();
      if (!importOwners) {
        const current = store.getState(), active = current.activeViewId ? current.views[current.activeViewId] : null;
        setPendingImport({ viewId: current.activeViewId, locale: active?.locale ?? null }); return;
      }
      if (importOwners && (importOwners.imports.current().busy || importOwners.imports.hasPending() || importOwners.imports.hasActive() || importOwners.tasks.unresolved())) { revealImport(); return; }
      const current = store.getState(), active = current.activeViewId ? current.views[current.activeViewId] : null;
      const accepted = active?.kind === "entries" ? await runtime.navigation.update(active.id, { entryMode: "import", focusMode: false })
        : await runtime.navigation.open({ kind: "entries", locale: active?.locale ?? session.project.metadata.targetLocales[0] ?? "", entryMode: "import", focusMode: false });
      if (accepted) hideImportRecovery();
    },
    canOpenImport: () => !!drafts && draftState.hydration === "ready" && !draftState.retired && !pendingImport,
    confirm: async advance => { if (recoveryKey && drafts) await drafts.confirm(recoveryKey); else await entries.current?.confirm(advance); },
    exitEditor: async () => { if (recoveryKey) revealDraft(null); else await entries.current?.exitEditor(); },
    toggleFocus: async () => { if (!recoveryKey) await entries.current?.toggleFocus(); },
    isEditing: () => recoveryKey !== null || !importVisible && !!entries.current?.isEditing(),
    canAdvance: () => recoveryKey === null && !!entries.current?.isEditing(),
    canConfirm: () => recoveryKey ? !!drafts && !readOnly && !lifecycleState.pending && draftState.hydration === "ready" && !draftState.retired && !draftState.mutationReserved
      && !!recoveryEntry?.value && !recoveryEntry.value.pending && !recoveryEntry.busy && recoveryEntry.basisCurrent && recoveryEntry.currentFailure === null
      && !(recoveryEntry.value.merge && recoveryEntry.failure?.kind === "basis-conflict") && recoveryEntry.failure?.kind !== "journal" && recoveryEntry.failure?.kind !== "journal-conflict" : !!entries.current?.canConfirm(),
  };
  useEffect(() => {
    if (!pendingImport || !importOwners) return;
    setPendingImport(null);
    const current = store.getState(), active = current.activeViewId ? current.views[current.activeViewId] : null;
    // Lazy owners must finish registering before a navigation permit captures
    // the participant set. A later tab/language choice cancels this presentation.
    if (disabled || current.activeViewId !== pendingImport.viewId || (active?.locale ?? null) !== pendingImport.locale
      || !gate.canDispatch({ viewId: pendingImport.viewId, source: "button" })) return;
    void actions.current.openImport().catch(() => setCommandFailed(true));
  }, [pendingImport, importOwners, disabled, store, gate]);
  useLayoutEffect(() => {
    if (!commands) { setRegisteredCommands(null); return; }
    const remove = registerWorkspaceCommands({ commands, store, gate, viewId: currentId, defaultLocale: session.project.metadata.targetLocales[0], scope, getCurrentScope: currentScope, navigation: runtime.navigation,
      actions: { openProject: () => actions.current.requestOpen(), closeProject: () => actions.current.close(), closeWindow: async () => {
        if (isTauri()) { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await lifecycle.closeWindow(() => getCurrentWindow().destroy()); }
      }, refresh: () => actions.current.refresh(), focusSearch: () => entries.current?.focusSearch(), focusAgent: showDock, focusDetails: showDock, openCommands: openPalette,
      openImport: () => actions.current.openImport(), canOpenImport: () => actions.current.canOpenImport(),
      confirm: advance => actions.current.confirm(advance), exitEditor: () => actions.current.exitEditor(), toggleFocus: () => actions.current.toggleFocus(),
      isEditing: () => actions.current.isEditing(), canConfirm: () => actions.current.canConfirm(), canAdvance: () => actions.current.canAdvance() }, onError: () => setCommandFailed(true) });
    setRegisteredCommands(commands); return remove;
  }, [commands, currentId, gate, store, runtime, lifecycle, scope, narrow, readOnly]);
  const dispatcher = useMemo(() => createWorkspaceCommandDispatcher({ gate, modifier: navigator.platform.includes("Mac") ? "meta" : "ctrl", getContext: () => {
    const id = store.getState().activeViewId, owner = registries.get(id), actualScope = currentScope();
    return owner && owner === registeredCommands && actualScope ? { viewId: id, scope: actualScope, commands: owner } : null;
  } }), [gate, store, registries, registeredCommands, scope, readOnly]);
  const dispatch = (id: WorkspaceCommandId) => dispatcher.dispatch(id, { source: "button", viewId: currentId });
  const dispatchEditor = (id: EditorCommand, source: "button" | "keyboard", inputOwner?: string) => dispatcher.dispatch(id, { source, viewId: currentId, inputOwner });
  const dispatchRecoveryEditor = (id: EditorCommand, source: "button" | "keyboard", inputOwner?: string) => dispatcher.dispatch(id, { source, viewId: currentId, inputOwner, dialogId: "draft-recovery" });
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key) && gate.canDispatch({ viewId: currentId, source: "keyboard" })) {
        const id = store.getState().viewOrder[Number(event.key) - 1];
        if (id) { event.preventDefault(); void runtime.navigation.activate(id); } return;
      }
      const current = gate.getSnapshot();
      dispatcher.handleKeyDown(event, currentId, current.inputOwner?.ownerId, current.dialogs.at(-1) === "draft-recovery" ? "draft-recovery" : undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatcher, currentId, gate, store, runtime]);
  useEffect(() => {
    if (!isTauri() || !commandsReady) return;
    return installWorkspaceMenu(dispatcher.list({ source: "native-menu" }), key => t(key), id => dispatcher.dispatch(id, { source: "native-menu", viewId: currentId }), () => setCommandFailed(true));
  }, [dispatcher, commandsReady, currentId, i18n.resolvedLanguage, disabled, interaction.intentOwner, draftState.hydration, draftState.mutationReserved, view?.editing, recoveryKey !== null, actions.current.canConfirm()]);
  useEffect(() => () => { paletteRelease.current?.(); drawerRelease.current?.(); }, [gate]);
  const activeLocale = view?.locale ?? session.project.metadata.targetLocales[0] ?? "";
  const importNeedsAttention = !!importOwners && (importOwners.imports.current().busy || importOwners.imports.hasPending()
    || !session.reads.retired && importOwners.imports.hasActive() || importOwners.tasks.unresolved());
  const candidatePanelVisible = currentId !== null && presented.candidates === currentId;
  const protectionPanelVisible = currentId !== null && presented.protection === currentId;
  const comparisonPanelVisible = currentId !== null && presented.comparison === currentId;
  const reviewPanelVisible = currentId !== null && presented.review === currentId;
  const candidateBatchOwnsPending = !!candidateOwners?.decisions.state.pending && !!candidateBatchState?.items.some(item => item.request === candidateOwners.decisions.state.pending);
  const candidateBatchBlocked = !!candidateBatchState && !candidateBatchState.ended && !["idle", "complete"].includes(candidateBatchState.phase);
  async function openCandidateEditor(unitId: string, locale: string, parentDialogId?: string): Promise<boolean> {
    if (!gate.canDispatch({ viewId: currentId, source: "button", dialogId: parentDialogId })) return false;
    if (parentDialogId === "workspace-dock" && narrow && drawer) closeDrawer();
    const target = { entryMode: "table" as const, locale, focus: unitId, editing: true, queueActive: true, queueAnchor: unitId, focusMode: false };
    try {
      return view?.kind === "entries" ? await runtime.navigation.update(view.id, target)
        : await runtime.navigation.open({ kind: "entries", ...target });
    } catch { setCommandFailed(true); return false; }
  }
  async function openReviewEditor(request: EntryReviewEditorRequest, proof: () => boolean) {
    const parentDialogId = narrow && drawer ? "workspace-dock" : undefined;
    if (!gate.canDispatch({ viewId: currentId, source: "button", dialogId: parentDialogId }) || !proof()) return false;
    return await entries.current?.openReviewEditor(request, proof, () => { if (parentDialogId) { drawerEditorClose.current = true; closeDrawer(); } }) ?? false;
  }
  async function openSavedComparison(comparison: ComparisonView, parentDialogId?: string): Promise<boolean> {
    if (!comparison.comparisonId || !gate.canDispatch({ viewId: currentId, source: "button", dialogId: parentDialogId })) return false;
    const target = { entryMode: "table" as const, locale: comparison.locale, focus: comparison.unitId, dock: "details" as const,
      detailTab: "candidates" as const, candidateCompareOpen: true, candidateComparisonId: comparison.comparisonId, focusMode: false };
    try {
      // This only changes presentation in the same entity. Keep its parent Sheet open.
      if (view?.kind === "entries" && view.focus === comparison.unitId && view.locale === comparison.locale) {
        store.getState().patch(view.id, target); return true;
      }
      if (parentDialogId === "workspace-dock" && narrow && drawer) closeDrawer();
      const accepted = view?.kind === "entries" ? await runtime.navigation.update(view.id, target)
        : await runtime.navigation.open({ kind: "entries", ...target, editing: false, queueActive: false });
      if (accepted && narrow) showDock();
      return accepted;
    } catch { setCommandFailed(true); return false; }
  }
  async function inspectCandidate(unitId: string, locale: string, revisionId: string | null) {
    const target = { entryMode: "table" as const, locale, focus: unitId, dock: "details" as const, detailTab: "candidates" as const,
      candidateAfterOrdinal: "0", candidateInitialRevisionId: revisionId };
    const accepted = view?.kind === "entries" ? await runtime.navigation.update(view.id, target)
      : await runtime.navigation.open({ kind: "entries", ...target, editing: false, queueActive: false });
    if (accepted && narrow) showDock();
  }
  async function inspectReview(unitId: string, locale: string) {
    const target = { entryMode: "table" as const, locale, focus: unitId, dock: "details" as const, detailTab: "detail" as const, editing: false, focusMode: false };
    const accepted = view?.kind === "entries" ? await runtime.navigation.update(view.id, target)
      : await runtime.navigation.open({ kind: "entries", ...target, queueActive: false });
    if (accepted) { hideReviewRecovery(); if (narrow) showDock(); }
  }
  function renderCandidate(row: SegmentRow) {
    if (row.content.unitId !== view?.focus || !row.aiCandidateCount || !drafts || !candidateOwners || !commandsReady || !commands) return null;
    return <Suspense fallback={null}><FocusedCandidate project={session.project} unitId={row.content.unitId} locale={activeLocale} drafts={drafts} owners={candidateOwners}
      commands={commands} gate={gate} viewId={currentId} disabled={disabled} visible={!importVisible} aiCandidateCount={row.aiCandidateCount}
      onEdit={openCandidateEditor} onInspect={revisionId => { void inspectCandidate(row.content.unitId, activeLocale, revisionId).catch(() => setCommandFailed(true)); }}/></Suspense>;
  }
  async function backFromImport() {
    if (!gate.canDispatch({ viewId: currentId, source: "button" })) return;
    if (importRecovery) { hideImportRecovery(); return; }
    if (view) await runtime.navigation.update(view.id, { entryMode: "table", focusMode: false });
  }
  async function openImportedEntry(unitId: string, locale: string) {
    const target = { entryMode: "table" as const, locale, focus: unitId, query: "", searchInput: "", preset: "all", queueScopeId: null,
      queueAnchor: unitId, queueActive: true, editing: true, focusMode: false, cursor: null, afterOrdinal: 0, scroll: { top: 0, left: 0 } };
    const accepted = view?.kind === "entries" ? await runtime.navigation.update(view.id, target)
      : await runtime.navigation.open({ kind: "entries", ...target });
    if (accepted) hideImportRecovery();
  }
  function importPanel() {
    return <FeatureBoundary key="translation-import-presentation" fallback={<ErrorState title={message("importUnavailable")} description={message("importHelp")} />}>
      <Suspense fallback={<LoadingState label={message("importLoading")} />}>
        {drafts && importOwners && commandsReady && commands ? <TranslationImportPanel project={session.project} owners={importOwners} drafts={drafts} commands={commands} gate={gate} viewId={currentId}
          disabled={disabled || draftState.hydration !== "ready" || draftState.retired} visible={importVisible}
          onBack={() => { void backFromImport().catch(() => setCommandFailed(true)); }} onOpenEntry={(unitId, locale) => { void openImportedEntry(unitId, locale).catch(() => setCommandFailed(true)); }}/>
          : draftLoadFailed || draftState.hydration === "failed" ? <ErrorState title={message("importUnavailable")} description={message("draftIndexFailed")} />
            : <LoadingState label={message("importLoading")} />}
      </Suspense>
    </FeatureBoundary>;
  }
  function panel() {
    return <TabsRoot value={view?.dock ?? "agent"} onValueChange={value => { if (view && (value === "agent" || value === "details")) store.getState().patch(view.id, { dock: value }); }} className={styles.dockTabs}>
      <TabsList aria-label={message("dockTabs")}><TabsTrigger value="agent"><Sparkles />{message("agent")}</TabsTrigger><TabsTrigger value="details">{message("detail")}</TabsTrigger></TabsList>
      <TabsContent value="agent" className={styles.dockContent}><EmptyState icon={<Sparkles />} title={message("agent")} description={message("agentHelp")} /></TabsContent>
      <TabsContent value="details" className={styles.dockContent}><FeatureBoundary key={currentId} fallback={<ErrorState title={message("featureFailed")} description={message("featureFailedHelp")} />}><Suspense fallback={<LoadingState label={message("loadingDetails")} />}><EntryDetails project={session.project} view={view} locale={activeLocale} disabled={disabled}
        visible={!importVisible && (!narrow || drawer)} drafts={drafts} owners={candidateOwners} commands={commandsReady ? commands ?? null : null} gate={gate}
        patch={patch => { if (view) store.getState().patch(view.id, patch); }} onReviewEdit={openReviewEditor} onEdit={(unitId, locale) => openCandidateEditor(unitId, locale, narrow && drawer ? "workspace-dock" : undefined)}
        comparisonOwner={comparisonOwner} requestComparisons={requestComparisons} onOpenComparison={comparison => openSavedComparison(comparison, narrow && drawer ? "workspace-dock" : undefined)}
        reviewOwner={reviewOwner}
        parentDialogId={narrow && drawer ? "workspace-dock" : undefined} onPresented={reportPresented}/></Suspense></FeatureBoundary></TabsContent>
    </TabsRoot>;
  }
  return <div className={styles.frame} data-focus-mode={!importVisible && view?.focusMode || undefined} onCompositionStartCapture={() => gate.setComposing("workspace", true)} onCompositionEndCapture={() => gate.setComposing("workspace", false)}>
    <header className={styles.titlebar} data-tauri-drag-region>
      <span className={styles.wordmark}>紡</span><Menu label={message("projectCommands")} trigger={<Button size="sm"><span className={styles.project}>{session.project.metadata.displayName}</span><ChevronDown /></Button>} items={[
        { id: "open", label: message("openProject"), onSelect: () => dispatch("workspace.open-project"), disabled: disabled || !commandsReady }, { id: "close", label: message("closeProject"), onSelect: () => dispatch("workspace.close-project"), disabled: disabled || !commandsReady },
      ]} />
      <span className={styles.breadcrumb}>›</span><Menu label={message("language")} trigger={<Button size="sm" disabled={disabled}>{activeLocale}<ChevronDown /></Button>} items={session.project.metadata.targetLocales.map(locale => ({ id: locale, label: locale, onSelect: () => { if (view) void runtime.navigation.update(view.id, { locale }); } }))} />
      <Button size="sm" disabled={!drafts || draftState.summaries.length === 0} onClick={() => { const first = draftState.summaries[0]; if (first) revealDraft(first.key); }}>{message("draftRecoveryTitle")}</Button>
      <Button className={styles.commandSearch} size="sm" disabled={!commandsReady || disabled} onClick={() => dispatch("workspace.commands")}><Search />{message("commandPlaceholder")}</Button>
      <IconButton className={styles.dockToggle} label={message("openAgent")} disabled={disabled || !commandsReady} onClick={() => dispatch("workspace.agent")}><PanelRight /></IconButton>
    </header>
    {commandFailed ? <Banner tone="error">{message("actionFailed")}</Banner> : null}
    {pendingImport && !importOwners ? <Banner>{message("importLoading")}</Banner> : null}
    {draftLoadFailed || draftState.hydration === "failed" ? <Banner tone="error" action={<Button onClick={retryDrafts}>{message("draftIndexRetry")}</Button>}>{message("draftIndexFailed")}</Banner>
      : !drafts || draftState.hydration === "idle" || draftState.hydration === "loading" ? <Banner>{message("draftIndexLoading")}</Banner> : null}
    {pendingDrafts.length ? <Banner tone="warning" action={<Button onClick={() => revealDraft(pendingDrafts[0].key)}>{message("draftRecoveryOpen")}</Button>}>{message("draftPendingSummary", { count: pendingDrafts.length })}</Banner> : null}
    {importNeedsAttention && !importVisible ? <Banner tone="warning" action={<Button onClick={revealImport}>{message("importOpen")}</Button>}>{message("importPendingNotice")}</Banner> : null}
    {reviewOwner && commandsReady && commands ? <Suspense fallback={null}><ReviewRecovery project={session.project} owner={reviewOwner} commands={commands} gate={gate} viewId={currentId}
      disabled={disabled} visible={reviewRecovery || !reviewPanelVisible} semanticVisible={!reviewPanelVisible || view?.detailTab !== "issues"} onOpen={(unitId, locale) => { void inspectReview(unitId, locale).catch(() => setCommandFailed(true)); }}/></Suspense> : null}
    {candidateOwners && commandsReady && commands ? <Suspense fallback={null}><CandidateRecovery project={session.project} owners={candidateOwners} commands={commands} gate={gate} viewId={currentId}
      disabled={disabled} visible showDecisions={!candidatePanelVisible && !candidateBatchOwnsPending} showProtection={!protectionPanelVisible} onOpen={(unitId, locale) => { void inspectCandidate(unitId, locale, null).catch(() => setCommandFailed(true)); }}/></Suspense> : null}
    {comparisonOwner && commandsReady && commands ? <Suspense fallback={null}><ComparisonRecovery project={session.project} owner={comparisonOwner} commands={commands} gate={gate} viewId={currentId}
      disabled={disabled} visible={!comparisonPanelVisible} onOpenComparison={comparison => openSavedComparison(comparison)}/></Suspense> : null}
    {candidateOwners && commandsReady && commands ? <Suspense fallback={null}>
      <CandidateBatchPanel project={session.project} owner={candidateOwners.batch} owners={candidateOwners} commands={commands} gate={gate} viewId={currentId}
        disabled={disabled} open={candidateBatchOpen} onOpenChange={setCandidateBatchOpen} parentDialogId={narrow && drawer ? "workspace-dock" : undefined}
        onEdit={openCandidateEditor} returnFocusRef={candidateBatchReturnFocus}/>
      <CandidateBatchRecovery project={session.project} owner={candidateOwners.batch} owners={candidateOwners} commands={commands} gate={gate} viewId={currentId}
        disabled={disabled} visible={!candidateBatchOpen} onOpen={() => setCandidateBatchOpen(true)} triggerRef={candidateBatchRecoveryTrigger}/>
    </Suspense> : null}
    <div className={styles.body}>
      <nav className={styles.activity} aria-label={message("activity")}>
        {[{ id: "entries", icon: <Layers /> }, { id: "knowledge", icon: <BookOpen /> }, { id: "runs", icon: <Sparkles /> }, { id: "delivery", icon: <ArrowUp /> }, { id: "decisions", icon: <CircleDot /> }].map(({ id, icon }) => <div key={id} className={styles.activityItem} data-active={view?.kind === id || undefined}><IconButton label={message(id === "entries" ? "entries" : id === "knowledge" ? "knowledge" : id === "runs" ? "runs" : id === "delivery" ? "delivery" : "decisions")} disabled={id !== "entries" || disabled} title={id !== "entries" ? message("comingLater") : undefined} onClick={event => {
          const existing = store.getState().viewOrder.find(key => store.getState().views[key].kind === "entries");
          if (!(event.metaKey || event.ctrlKey) && existing) void runtime.navigation.activate(existing); else dispatch("workspace.new-view");
        }}>{icon}</IconButton></div>)}
        <div className={styles.activityBottom}><IconButton label={message("extensions")} disabled title={message("comingLater")}><Command /></IconButton><IconButton label={message("settings")} disabled title={message("comingLater")}><Settings /></IconButton></div>
      </nav>
      <SplitView key={currentId} className={styles.workspaceSplit} elementRef={split} disabled={disabled} onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction || !view || narrow) return;
        const available = (split.current?.clientWidth ?? 0) - (splitHandle.current?.getBoundingClientRect().width ?? 0);
        const percentage = (meta.requestedLayout ?? layout)["workspace-dock"];
        if (available > 0 && percentage !== undefined) {
          const pixels = Math.round(percentage / 100 * available);
          if (pixels !== view.dockSize) store.getState().patch(view.id, { dockSize: pixels });
        }
      }}>
        <SplitPanel minSize={0} className={styles.mainPanel}><main className={styles.main}>
          <div className={styles.viewTabs} aria-label={message("views")} role="navigation">{state.viewOrder.map(id => {
            const item = state.views[id], name = message("viewName", { locale: item.locale });
            return <div key={id} className={appStyles.viewTab} data-active={id === currentId || undefined}>
              <Button size="sm" aria-current={id === currentId ? "page" : undefined} onClick={() => { if (!disabled) void runtime.navigation.activate(id); }}>{item.pinned ? <Pin /> : null}{name}</Button>
              {!item.pinned ? <IconButton size="xs" label={message("closeView", { name })} disabled={disabled} onClick={() => void runtime.navigation.close(id)}><X /></IconButton> : null}
            </div>;
          })}<IconButton size="xs" label={message("newView")} disabled={disabled || !commandsReady} onClick={() => dispatch("workspace.new-view")}><Plus /></IconButton>
            {view ? <IconButton size="xs" label={message(view.pinned ? "unpinView" : "pinView")} disabled={disabled || !commandsReady} onClick={() => dispatch("workspace.pin-view")}><Pin /></IconButton> : null}
          </div>
          {importVisible ? importPanel() : view ? view.kind === "entries" ? <FeatureBoundary key={view.id} fallback={<ErrorState title={message("featureFailed")} description={message("featureFailedHelp")} />}><Suspense fallback={<LoadingState label={message("loadingEntries")} />}><EntriesView ref={entries} commands={commandsReady ? commands : null} project={session.project} view={view} drafts={commandsReady ? drafts : null} gate={gate} dispatch={dispatchEditor} onRevealDraft={revealDraft} onImport={() => dispatch("translation.import")} onCandidateBatch={candidateOwners && commandsReady ? previewCandidateBatch : undefined} candidateBatchTriggerRef={candidateBatchTrigger} candidateBatchBlocked={candidateBatchBlocked} renderCandidate={renderCandidate} disabled={readOnly || !!lifecycleState.pending} patch={patch => store.getState().patch(view.id, patch)} navigate={async patch => {
            const accepted = await runtime.navigation.update(view.id, patch);
            if (accepted && patch.dock === "details" && narrow) showDock();
            return accepted;
          }} /></Suspense></FeatureBoundary> : <EmptyState title={message(view.kind)} description={message("comingLater")} /> : <EmptyState icon={<Layers />} title={message("noViews")} action={<Button disabled={disabled || !commandsReady} onClick={() => dispatch("workspace.new-view")}>{message("openEntries")}</Button>} />}
        </main></SplitPanel>
        {!narrow ? <><SplitHandle label={message("resizeDock")} elementRef={splitHandle} /><SplitPanel id="workspace-dock" key={wide ? "wide" : "compact"} groupResizeBehavior="preserve-pixel-size" defaultSize={view?.dockSize ?? (wide ? 380 : 340)} minSize={300} maxSize="45%"><aside className={styles.dock} ref={dock} tabIndex={-1} aria-label={message("agent")}>{panel()}</aside></SplitPanel></> : null}
      </SplitView>
    </div>
    <footer className={styles.statusbar}><span><Circle />{message(readOnly ? "retired" : "liveProject")}</span><span className={styles.statusEnd}>{message("language")} · {activeLocale}</span></footer>
    <Sheet open={drawer && narrow} onCloseAutoFocus={event => { if (drawerEditorClose.current) { event.preventDefault(); drawerEditorClose.current = false; } }} onOpenChange={open => { if (!open) closeDrawer(); }} title={message("agent")} description={session.project.metadata.displayName} closeLabel={message("close")}>{panel()}</Sheet>
    <Sheet open={recoveryKey !== null} onOpenChange={open => { if (!open) revealDraft(null); }} title={message("draftRecoveryTitle")} description={message("draftRecoveryHelp")} closeLabel={message("close")}
      onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => recoveryEditor.current?.focus()); }}
      onEscapeKeyDown={event => {
        const current = gate.getSnapshot();
        if (event.isComposing || event.keyCode === 229 || current.composingOwners.length) { event.preventDefault(); return; }
        dispatcher.handleKeyDown(event, currentId, current.inputOwner?.ownerId, "draft-recovery");
      }}>
      {drafts && recoveryKey ? <>
        {draftState.summaries.length ? <div className={styles.actions}>{draftState.summaries.map(summary => {
          const entry = drafts.getEntry(summary.key);
          const shortId = `${summary.key.unitId.slice(0, 8)}…${summary.key.unitId.slice(-6)}`;
          return <Button key={JSON.stringify(summary.key)} title={summary.key.unitId} aria-current={summary.key.unitId === recoveryKey.unitId && summary.key.locale === recoveryKey.locale ? "true" : undefined}
            onClick={() => revealDraft(summary.key)}>{entry?.current.kind === "current" ? entry.current.nativeKey : message("draftRecoveryFallback", { locale: summary.key.locale, id: shortId })}</Button>;
        })}</div> : null}
        {recoveryEntry?.current.kind === "current" ? <div className={styles.source}><span className={styles.key}>{recoveryEntry.current.nativeKey}</span><p><TokenizedText text={recoveryEntry.current.sourceText} /></p></div> : null}
        <div className={styles.target}>{commands ? <Suspense fallback={<LoadingState label={message("editorLoading")} />}><SegmentEditor key={JSON.stringify(recoveryKey)} ref={recoveryEditor} drafts={drafts} draftKey={recoveryKey} viewId={currentId} gate={gate} disabled={readOnly || !!lifecycleState.pending} allowAdvance={false} dispatch={dispatchRecoveryEditor} /></Suspense> : <LoadingState label={message("editorLoading")} />}</div>
      </> : <LoadingState label={message("draftIndexLoading")} />}
    </Sheet>
    <CommandPalette open={palette} onOpenChange={open => { if (!open) closePalette(); }} title={message("commands")} placeholder={message("commandPlaceholder")} emptyLabel={message("noCommands")} closeLabel={message("close")} groups={[{ label: message("viewCommands"), commands: dispatcher.list({ source: "palette", dialogId: "workspace-palette" }).flatMap(command => {
      const id = workspaceCommandIds.find(value => value === command.id);
      return id ? [{ id, label: t(command.nameKey), disabled: !command.availability.enabled, kbd: command.binding?.replace("Mod", navigator.platform.includes("Mac") ? "⌘" : "Ctrl"), onSelect: () => { closePalette(); dispatcher.dispatch(id, { source: "palette", viewId: currentId }); } }] : [];
    }) }]} />
  </div>;
}

export default function WorkbenchApp({ controller: suppliedController, native = isTauri() }: { controller?: ProjectLifecycle; native?: boolean } = {}) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const [stop, setStop] = useState<{ resolve: (allow: boolean) => void; current: () => boolean } | null>(null);
  const [gate] = useState(() => new InteractionGate());
  const [controller] = useState(() => suppliedController ?? new ProjectLifecycle({ confirmStop: (_project, _status, current) => new Promise(resolve => setStop({ resolve, current })) }));
  const state = useProjectLifecycle(controller), nativeClose = useNativeProjectClose(controller, native);
  const [locator, setLocator] = useState(""), [openPanel, setOpenPanel] = useState(false), [discard, setDiscard] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>(readRecentProjects), [pickerFailed, setPickerFailed] = useState(false);
  const [closeActionFailed, setCloseActionFailed] = useState(false);
  const busy = state.phase !== "idle", blocked = busy || !!state.pending || !!state.retainedSession || !!state.cleanup;
  const presentation = state.retainedSession ?? state.closingSession ?? state.session;
  const pathSequence = useRef(0);
  useLayoutEffect(() => openPanel ? gate.pushDialog("project-open") : undefined, [gate, openPanel]);
  useLayoutEffect(() => stop ? gate.pushDialog("stop-running") : undefined, [gate, stop]);
  useLayoutEffect(() => discard ? gate.pushDialog("discard-workspace") : undefined, [gate, discard]);
  useEffect(() => controller.register({ id: "application-input", area: "overview", scope: { kind: "application" },
    inspect: intent => ({ status: gate.getSnapshot().composingOwners.length || discard || openPanel && intent.kind !== "open-project" ? "blocked" : "ready", revision: `${pathSequence.current}:${discard}:${openPanel}:${gate.getSnapshot().composingOwners.join(",")}` }),
    prepareLeave: async () => false,
  }), [controller, gate, discard, openPanel]);
  async function open(path: string) {
    const sequence = pathSequence.current;
    const success = await controller.open(path);
    const project = controller.getSnapshot().session?.project;
    if (project) setRecent(rememberProject(project));
    if (success && sequence === pathSequence.current) setOpenPanel(false);
    else if (project && sequence !== pathSequence.current) setOpenPanel(true);
  }
  async function chooseFolder() {
    try { const chosen = await pickDirectory({ directory: true, multiple: false }); if (typeof chosen === "string") { pathSequence.current++; setLocator(chosen); setPickerFailed(false); } }
    catch { setPickerFailed(true); }
  }
  async function continueClosing() {
    const original = controller.getSnapshot().cleanup?.request;
    if (!original || controller.getSnapshot().cleanup?.state !== "stopping") return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const current = controller.getSnapshot();
    if (current.cleanup?.request !== original || current.cleanup.state !== "stopping" || current.pending) return;
    await controller.closeWindow(() => getCurrentWindow().destroy());
  }
  const openForm = <form className={appStyles.openForm} onSubmit={event => { event.preventDefault(); if (!blocked && native) void open(locator); }}>
    <Field id="workbench-project-folder" label={t("projectFolder")}><TextInput id="workbench-project-folder" placeholder={t("folderPlaceholder")} value={locator} onChange={event => { pathSequence.current++; setLocator(event.target.value); }} /></Field>
    <div className={styles.actions}><Button disabled={!native || blocked} onClick={() => void chooseFolder()}>{t("chooseFolder")}</Button><Button variant="primary" type="submit" pending={busy} disabled={!native || blocked || !locator.trim()}>{t("openProject")}</Button></div>
  </form>;
  const error = state.failure;
  const errorText = error?.code === "unknown-lifecycle" || error?.code === "recovery-unavailable" ? t("unknown") : error?.code === "leave-blocked" ? t("leaveBlocked") : error?.code === "leave-changed" ? t("leaveChanged")
    : error?.code === "application-stopping" || error?.code === "application-unknown" || error?.code === "runtime-pending" ? t("cleanupPending") : error?.code === "read-failed" ? t("readFailed") : error?.code === "destroy-failed" ? t("windowCloseFailed") : t("actionFailed");
  return <ApplicationReadProvider>
    <div className={appStyles.app}>
      {!native ? <Banner>{t("desktopRequired")}</Banner> : null}
      {nativeClose.state === "failed" ? <Banner tone="error">{t("nativeCloseFailed")}</Banner> : null}
      {pickerFailed ? <Banner tone="error">{t("pickFailed")}</Banner> : null}
      {closeActionFailed ? <Banner tone="error">{t("actionFailed")}</Banner> : null}
      {state.cleanup?.state === "stopped" ? <Banner action={<Button disabled={busy || !!state.pending || !!state.retainedSession} onClick={() => void controller.resumeApplication()}>{t("resumeWork")}</Button>}>{t("workStopped")}</Banner> : null}
      {state.cleanup?.state === "stopping" ? <Banner action={<Button disabled={busy || !!state.pending || !!state.retainedSession || !native} onClick={() => void continueClosing().catch(() => setCloseActionFailed(true))}>{t("continueClosing")}</Button>}>{t("cleanupPending")}</Banner> : null}
      {error ? <Banner tone="error" action={state.pending?.kind === "runtime" || state.pending?.session && (state.pending.kind === "open" || state.pending.kind === "close") ? <Button disabled={busy} onClick={() => void controller.checkPending()}>{t("checkResult")}</Button> : undefined}>{errorText}</Banner> : null}
      {state.retainedSession ? <Banner tone="warning" action={<Button onClick={() => setDiscard(true)}>{t("discardRetained")}</Button>}>{t("retained")}</Banner> : null}
      {presentation ? <SessionReadProvider key={`${presentation.project.metadata.projectId}:${presentation.project.sessionToken}`} context={executionContext(presentation.project)} reads={presentation.reads} bridge={!presentation.reads.retired}>
        <ProjectWorkspace session={presentation} lifecycle={controller} gate={gate} readOnly={presentation !== state.session || !!state.retainedSession} requestOpen={() => setOpenPanel(true)} />
      </SessionReadProvider> : <main className={appStyles.welcome}><span className={appStyles.brand}>紡 Tsumugi</span><h1>{t("welcome")}</h1><p>{t("welcomeHelp")}</p>{openForm}
        {recent.length ? <section className={appStyles.recent}><h2>{t("recent")}</h2>{recent.map(item => <Button key={item.locator} disabled={!native || blocked} onClick={() => void open(item.locator)}>{recentProjectName(item.locator)}</Button>)}</section> : null}
      </main>}
      <Dialog open={openPanel && !!presentation} onOpenChange={setOpenPanel} title={t("openProject")} description={t("welcomeHelp")} closeLabel={t("close")}>{openForm}</Dialog>
      <Dialog open={!!stop} onOpenChange={value => { if (!value && stop) { stop.resolve(false); setStop(null); } }} title={t("stopTitle")} description={t("stopHelp")} closeLabel={t("stay")} footer={<><Button onClick={() => { stop?.resolve(false); setStop(null); }}>{t("stay")}</Button><Button variant="danger" onClick={() => { if (stop) stop.resolve(stop.current()); setStop(null); }}>{t("stopAndLeave")}</Button></>}>{t("stopHelp")}</Dialog>
      <Dialog open={discard} onOpenChange={setDiscard} title={t("discardRetained")} description={t("discardHelp")} closeLabel={t("stay")} footer={<><Button onClick={() => setDiscard(false)}>{t("stay")}</Button><Button variant="danger" onClick={() => { controller.discardRetained(); setDiscard(false); }}>{t("discardRetained")}</Button></>}>{t("discardHelp")}</Dialog>
    </div>
  </ApplicationReadProvider>;
}
