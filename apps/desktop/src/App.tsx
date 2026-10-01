import { WorkbenchNavigation, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { sourceCommands } from "./sourceCommands";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@radix-ui/react-dialog";
import { join as joinPath } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  useForm,
  type FieldErrors,
  type SubmitHandler,
} from "react-hook-form";
import { isLocale, localeOptions, type Locale } from "./i18n";
import { languageName } from "./i18n/languageNames";
import type { TranslationKey } from "./i18n/types";
import { ExecutionTasks, type TasksHandle } from "./ExecutionTasks";
import { SourceWorkbench, type SourceHandle } from "./SourceWorkbench";
import { TranslationWorkbench, type TranslationHandle } from "./TranslationWorkbench";
import { ResourceWorkbench, type ResourceHandle } from "./ResourceWorkbench";
import { ReviewWorkbench, type ReviewHandle } from "./ReviewWorkbench";
import { ReleaseWorkbench, type ReleaseHandle } from "./ReleaseWorkbench";
import { AiWorkbench, type AiHandle } from "./AiWorkbench";
import { ArenaWorkbench } from "./ArenaWorkbench";
import { executionCommands, executionContext } from "./executionCommands";
import {
  clearLastOpenProject,
  normalizeLocator,
  readLastOpenProject,
  readRecentProjects,
  rememberProject,
  recentProjectName,
  removeRecentProject,
  type RecentProject,
} from "./recentProjects";
import {
  projectCommands,
  type SetTargetLocalesRequest,
  type CloseProjectView,
  type CommandError,
  type CommandErrorCode,
  type CommandStage,
  type CreateProjectRequest,
  type MetadataMutationView,
  type ProjectMetadataView,
  type ProjectView,
} from "./projectCommands";

type ClosedPanel = "empty" | "create" | "open";
type FormKind = "rename" | "target";
type Operation = "idle" | "opening" | "saving" | "reconciling" | "closing";
type FeedbackTone = "info" | "success" | "warning" | "error";
type DirectoryPickerTarget = "create" | "open";

const iconComponents = {
  folder: Folder,
  "folder-open": FolderOpen,
  plus: Plus,
  save: Save,
  close: X,
  refresh: RefreshCw,
} satisfies Record<string, LucideIcon>;

type IconName = keyof typeof iconComponents;

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const IconComponent = iconComponents[name];
  return <IconComponent aria-hidden="true" className="icon" size={size} strokeWidth={1.75} />;
}

interface CreateFormValues {
  parentDirectory: string;
  directoryName: string;
  displayName: string;
  sourceLocale: string;
  targetLocales: string;
}

interface OpenFormValues {
  locator: string;
}

interface EditorFormValues {
  value: string;
  syncDirectoryName: boolean;
}

interface ActiveForm {
  kind: FormKind;
  expectedRevision: string;
}

type NavigationIntent =
  | { kind: "close" }
  | { kind: "window-close" }
  | { kind: "open"; locator: string }
  | { kind: "form"; formKind: FormKind }
  | { kind: "panel"; panel: ClosedPanel };

interface Feedback {
  tone: FeedbackTone;
  messageKey: TranslationKey;
  messageValues?: Record<string, string | number>;
  code?: CommandErrorCode;
  field?: string;
  action?: "refresh" | "retry-reconciliation";
}

interface SaveResult {
  ok: boolean;
  metadata?: ProjectMetadataView;
}

interface PendingSave {
  previous: ProjectView;
  form: ActiveForm;
  value: string;
  directoryName?: string;
}

function sameMetadata(left: ProjectMetadataView, right: ProjectMetadataView) {
  return left.projectId === right.projectId && left.displayName === right.displayName
    && left.sourceLocale === right.sourceLocale && left.metadataRevision === right.metadataRevision
    && [...left.targetLocales].sort().join("\n") === [...right.targetLocales].sort().join("\n");
}

function classifySave(view: ProjectView, pending: PendingSave): "committed" | "previous" | "unknown" {
  if (view.sessionToken !== pending.previous.sessionToken || view.metadata.projectId !== pending.previous.metadata.projectId) return "unknown";
  if (view.reconciliationState === "committed" || view.reconciliationState === "previous") return view.reconciliationState;
  if (sameMetadata(view.metadata, pending.previous.metadata) && normalizeLocator(view.locator) === normalizeLocator(pending.previous.locator)) return "previous";
  // Runtime reconciliation owns canonicalization and commit classification. A settled
  // read after transport loss must instead match the exact captured command and basis.
  const before = pending.previous.metadata;
  const after = view.metadata;
  if (BigInt(after.metadataRevision) !== BigInt(before.metadataRevision) + 1n || after.sourceLocale !== before.sourceLocale) return "unknown";
  const expectedLocator = pending.directoryName
    ? pending.previous.locator.replace(/[\\/][^\\/]+[\\/]?$/, `\\${pending.directoryName}`)
    : pending.previous.locator;
  if (normalizeLocator(view.locator) !== normalizeLocator(expectedLocator)) return "unknown";
  const targetsMatch = (left: string[], right: string[]) =>
    left.map((tag) => tag.toLowerCase()).sort().join("\n") === right.map((tag) => tag.toLowerCase()).sort().join("\n");
  const matches = pending.form.kind === "rename"
    ? after.displayName === pending.value && targetsMatch(after.targetLocales, before.targetLocales)
    : after.displayName === before.displayName && targetsMatch(after.targetLocales, parseTargetLocales(pending.value));
  return matches ? "committed" : "unknown";
}

const CREATE_DEFAULT_VALUES: CreateFormValues = {
  parentDirectory: "",
  directoryName: "",
  displayName: "",
  sourceLocale: "en-US",
  targetLocales: "zh-Hans",
};

const OPEN_DEFAULT_VALUES: OpenFormValues = { locator: "" };
const EDITOR_DEFAULT_VALUES: EditorFormValues = { value: "", syncDirectoryName: false };


const languagePresets = [
  { value: "en-US", labelKey: "localeNames.englishUnitedStates" },
  { value: "zh-Hans", labelKey: "localeNames.simplifiedChinese" },
  { value: "zh-Hant", labelKey: "localeNames.traditionalChinese" },
  { value: "ja-JP", labelKey: "localeNames.japaneseJapan" },
  { value: "ko-KR", labelKey: "localeNames.koreanKorea" },
  { value: "es-ES", labelKey: "localeNames.spanishSpain" },
  { value: "fr-FR", labelKey: "localeNames.frenchFrance" },
  { value: "de-DE", labelKey: "localeNames.germanGermany" },
  { value: "pt-BR", labelKey: "localeNames.portugueseBrazil" },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[];

function localeDisplayName(t: TFunction, value: string, uiLocale: string) {
  const preset = languagePresets.find((candidate) => candidate.value === value);
  return preset ? t(preset.labelKey) : languageName(value, uiLocale);
}

function localeLabel(t: TFunction, value: string, uiLocale: string) {
  const name = localeDisplayName(t, value, uiLocale);
  return <>{name}{name !== value ? <span className="locale-code"> ({value})</span> : null}</>;
}

function isPresetLocale(value: string): boolean {
  return languagePresets.some((preset) => preset.value === value);
}

function previewDestination(parentDirectory: string, directoryName: string): string {
  const parent = parentDirectory.trim().replace(/[\\/]+$/, "");
  const child = directoryName.trim();
  if (!parent || !child) return "";
  return `${parent}\\${child}`;
}

function isSafeChildDirectoryName(value: string): boolean {
  const child = value.trim();
  if (!child || child !== value || child === "." || child === "..") return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(child) || /[. ]$/.test(child)) return false;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(child);
}

function parseTargetLocales(raw: string) {
  return raw
    .split(/[,;\n]/)
    .map((locale) => locale.trim())
    .filter(Boolean);
}

function asCommandError(value: unknown, stage: CommandStage): CommandError {
  if (typeof value === "object" && value !== null && "code" in value && "stage" in value) {
    return value as CommandError;
  }
  const mutation = stage === "rename" || stage === "set-target-locales" || stage === "add-target-locale";
  return { code: mutation ? "outcome-unknown" : "storage-failed", stage, recoveryRequired: mutation };
}

function failureMessageKey(failure: CommandError): TranslationKey {
  switch (failure.code) {
    case "invalid-input":
      return "errors.invalidInput";
    case "destination-conflict":
      return "errors.destinationConflict";
    case "missing-project":
      return "errors.missingProject";
    case "permission-denied":
      return "errors.permissionDenied";
    case "unsupported-schema":
      return "errors.unsupportedSchema";
    case "corrupt-project":
      return "errors.corruptProject";
    case "stale-revision":
      return "feedback.stale";
    case "session-invalid":
      return "errors.sessionInvalid";
    case "project-in-use":
      return "errors.projectInUse";
    case "busy":
      return "errors.busy";
    case "storage-failed":
      return "errors.storageFailed";
    case "outcome-unknown":
      return "errors.outcomeUnknown";
    default:
      return "errors.unknown";
  }
}

function feedbackFromFailure(failure: CommandError): Feedback {
  const warning = failure.code === "stale-revision" || failure.code === "outcome-unknown";
  return {
    tone: warning ? "warning" : "error",
    messageKey: failure.code === "invalid-input" ? fieldMessageKey(failure.field) : failureMessageKey(failure),
    messageValues: failure.code === "stale-revision" ? { revision: failure.currentRevision ?? "?" } : undefined,
    code: failure.code,
    field: failure.field,
    action: failure.code === "outcome-unknown" ? "retry-reconciliation" : undefined,
  };
}

function localValidation(field: string): Feedback {
  return { tone: "error", messageKey: fieldMessageKey(field), code: "invalid-input", field };
}

function fieldMessageKey(field: string | undefined): TranslationKey {
  switch (field) {
    case "parentDirectory":
      return "errors.parentDirectory";
    case "directoryName":
      return "errors.directoryName";
    case "displayName":
      return "errors.displayName";
    case "sourceLocale":
      return "errors.sourceLocale";
    case "targetLocales":
      return "errors.targetLocales";
    case "locator":
      return "errors.locator";
    case "locale":
      return "errors.locale";
    default:
      return "errors.invalidInput";
  }
}

function statusFor(t: TFunction, operation: Operation, dirty: boolean): string {
  if (operation === "opening") return t("status.opening");
  if (operation === "saving") return t("status.saving");
  if (operation === "reconciling") return t("status.reconciling");
  if (operation === "closing") return t("status.closing");
  if (dirty) return t("status.unsaved");
  return t("status.ready");
}

function fieldError(feedback: Feedback | null, field: string) {
  return feedback?.code === "invalid-input" && feedback.field === field;
}

function firstErrorField(errors: FieldErrors<Record<string, unknown>>) {
  return Object.keys(errors)[0];
}

function renderFeedbackMessage(t: TFunction, feedback: Feedback) {
  return t(feedback.messageKey, {
    ...(feedback.messageValues ?? {}),
    defaultValue: feedback.messageKey,
  });
}

function App() {
  const { t, i18n: translation } = useTranslation();
  const resolvedLanguage = translation.resolvedLanguage ?? translation.language ?? "en-US";
  const locale: Locale = isLocale(resolvedLanguage) ? resolvedLanguage : "en-US";
  const [project, setProject] = useState<ProjectView | null>(null);
  const [area, setArea] = useState<WorkspaceArea>("overview");
  const [sourceState, setSourceState] = useState<"loading" | "empty" | "ready" | "failed">("loading");
  const areaNavigation = useRef(false);
  const currentSession = useRef<string | null>(null);
  currentSession.current = project?.sessionToken ?? null;
  const releaseWorkbench = useRef<ReleaseHandle>(null);
  const tasksWorkbench = useRef<TasksHandle>(null);
  const [operation, setOperation] = useState<Operation>("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [closedPanel, setClosedPanel] = useState<ClosedPanel>("empty");
  const [openPanel, setOpenPanel] = useState(false);
  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null);
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() => readRecentProjects());
  const [restoreCandidate, setRestoreCandidate] = useState<RecentProject | null>(() => readLastOpenProject());
  const [restorePromptOpen, setRestorePromptOpen] = useState(false);
  const [copiedLocator, setCopiedLocator] = useState(false);
  const [stopIntent, setStopIntent] = useState<{ kind: "close" | "window-close" | "rename" } | { kind: "open"; locator: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stoppedSession, setStoppedSession] = useState<string | null>(null);
  const pendingSave = useRef<PendingSave | null>(null);
  const sourceWorkbench = useRef<SourceHandle>(null);
  const resourceWorkbench = useRef<ResourceHandle>(null);
  const reviewWorkbench = useRef<ReviewHandle>(null);
  const aiWorkbench = useRef<AiHandle>(null);
  const arenaWorkbench = useRef<AiHandle>(null);
  const translationWorkbench = useRef<TranslationHandle>(null);
  const createInFlight = useRef(false);
  const reconciliationInFlight = useRef(false);
  const folderNameEdited = useRef(false);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const cancelDialogButton = useRef<HTMLButtonElement | null>(null);
  const createForm = useForm<CreateFormValues>({ defaultValues: CREATE_DEFAULT_VALUES });
  const openForm = useForm<OpenFormValues>({ defaultValues: OPEN_DEFAULT_VALUES });
  const editorForm = useForm<EditorFormValues>({ defaultValues: EDITOR_DEFAULT_VALUES });
  const editorDirty = Boolean(activeForm && editorForm.formState.isDirty);
  const createDraftDirty = closedPanel === "create" && createForm.formState.isDirty;
  const dirty = editorDirty;
  const createParentDirectory = createForm.watch("parentDirectory");
  const createDirectoryName = createForm.watch("directoryName");
  const createSourceLocale = createForm.watch("sourceLocale");
  const createTargetLocales = createForm.watch("targetLocales");
  const editorValue = editorForm.watch("value");
  const syncDirectoryName = editorForm.watch("syncDirectoryName");
  const editorDirectoryError = Boolean(
    activeForm?.kind === "rename" && syncDirectoryName && editorValue.trim() && !isSafeChildDirectoryName(editorValue),
  );
  const editorErrorField = activeForm?.kind === "rename" && editorDirectoryError
    ? "directoryName"
    : activeForm?.kind === "rename"
      ? "displayName"
      : "targetLocales";
  const destinationPreview = previewDestination(createParentDirectory, createDirectoryName);
  const busy = operation !== "idle" || stopping || stopIntent !== null;
  const status = statusFor(t, operation, dirty || createDraftDirty);

  useEffect(() => {
    document.documentElement.lang = resolvedLanguage;
  }, [resolvedLanguage]);

  useEffect(() => {
    if (!project && restoreCandidate) setRestorePromptOpen(true);
  }, [project, restoreCandidate]);

  function clearFeedback() {
    setFeedback(null);
  }

  function clearFieldFeedback(field: string) {
    setFeedback((current) => current?.code === "invalid-input" && current.field === field ? null : current);
  }

  function clearEditorFeedback() {
    setFeedback((current) => {
      if (current?.code === "invalid-input" && (current.field === editorErrorField || (activeForm?.kind === "rename" && current.field === "directoryName"))) return null;
      if (activeForm?.kind === "rename" && current?.code === "destination-conflict") return null;
      return current;
    });
  }

  function rememberOpenedProject(view: ProjectView, replacedLocator?: string) {
    const recent = rememberProject(view, replacedLocator);
    setRecentProjects(recent);
    setRestoreCandidate(recent[0] ?? null);
  }

  function isSameProject(locator: string): boolean {
    return Boolean(project?.locator) && normalizeLocator(project?.locator ?? "") === normalizeLocator(locator);
  }

  async function copyProjectLocation() {
    if (!project?.locator || busy) return;
    try {
      await navigator.clipboard.writeText(project.locator);
      setCopiedLocator(true);
      setFeedback((current) => pendingSave.current ? current : { tone: "success", messageKey: "feedback.locationCopied" });
      window.setTimeout(() => setCopiedLocator(false), 1600);
    } catch {
      setFeedback((current) => pendingSave.current ? current : { tone: "error", messageKey: "errors.copyFailed" });
    }
  }

  async function restoreLastProject() {
    const candidate = restoreCandidate;
    if (!candidate) return;
    setRestorePromptOpen(false);
    const opened = await executeOpen(candidate.locator);
    if (!opened) {
      clearLastOpenProject();
      setRestoreCandidate(null);
    }
  }

  function declineRestore() {
    clearLastOpenProject();
    setRestoreCandidate(null);
    setRestorePromptOpen(false);
  }

  function forgetRecentProject(locator: string) {
    setRecentProjects(removeRecentProject(locator));
    if (restoreCandidate && normalizeLocator(restoreCandidate.locator) === normalizeLocator(locator)) {
      clearLastOpenProject();
      setRestoreCandidate(null);
      setRestorePromptOpen(false);
    }
  }

  function requestNavigation(intent: NavigationIntent) {
    const focused = document.activeElement;
    dialogReturnFocus.current = focused instanceof HTMLElement ? focused : null;
    setNavigationIntent(intent);
  }

  function beginEditor(kind: FormKind, metadata: ProjectMetadataView) {
    editorForm.reset({
      value: kind === "rename" ? metadata.displayName : metadata.targetLocales.join(", "),
      syncDirectoryName: false,
    });
    setActiveForm({ kind, expectedRevision: metadata.metadataRevision });
    clearFeedback();
  }

  function startEditor(kind: FormKind, metadata = project?.metadata) {
    if (!metadata || busy) return;
    if (activeForm) {
      if (activeForm.kind === kind) return;
      if (dirty) {
        requestNavigation({ kind: "form", formKind: kind });
        return;
      }
    }
    beginEditor(kind, metadata);
  }

  const executeCreate: SubmitHandler<CreateFormValues> = async (values) => {
    if (createInFlight.current || busy) return;
    if (!values.parentDirectory.trim()) {
      createForm.setError("parentDirectory", { type: "required" });
      setFeedback(localValidation("parentDirectory"));
      return;
    }
    if (!isSafeChildDirectoryName(values.directoryName)) {
      createForm.setError("directoryName", { type: "validate" });
      setFeedback(localValidation("directoryName"));
      return;
    }
    if (!values.displayName.trim()) {
      createForm.setError("displayName", { type: "required" });
      setFeedback(localValidation("displayName"));
      return;
    }
    if (!values.sourceLocale.trim()) {
      createForm.setError("sourceLocale", { type: "required" });
      setFeedback(localValidation("sourceLocale"));
      return;
    }
    const targetLocales = parseTargetLocales(values.targetLocales);
    if (targetLocales.length === 0) {
      createForm.setError("targetLocales", { type: "required" });
      setFeedback(localValidation("targetLocales"));
      return;
    }

    createInFlight.current = true;
    setOperation("opening");
    setFeedback({ tone: "info", messageKey: "status.opening" });
    let destination: string;
    try {
      destination = await joinPath(values.parentDirectory, values.directoryName);
    } catch {
      createInFlight.current = false;
      setOperation("idle");
      setFeedback({ tone: "error", messageKey: "errors.directoryPickerUnavailable" });
      return;
    }

    try {
      const request: CreateProjectRequest = {
        destination,
        displayName: values.displayName,
        sourceLocale: values.sourceLocale,
        targetLocales,
      };
      const view = await projectCommands.create(request);
      setProject(view);
      rememberOpenedProject(view);
      setActiveForm(null);
      setClosedPanel("empty");
      setOperation("idle");
      createForm.reset(CREATE_DEFAULT_VALUES);
      folderNameEdited.current = false;
      setFeedback({ tone: "success", messageKey: "feedback.created" });
    } catch (value) {
      setOperation("idle");
      setFeedback(feedbackFromFailure(asCommandError(value, "create")));
    } finally {
      createInFlight.current = false;
    }
  };

  async function executeOpen(locator: string) {
    if (!locator.trim()) {
      setFeedback(localValidation("locator"));
      return false;
    }

    if (isSameProject(locator)) {
      setOpenPanel(false);
      openForm.reset(OPEN_DEFAULT_VALUES);
      setRestorePromptOpen(false);
      setFeedback({ tone: "info", messageKey: "feedback.alreadyOpen" });
      if (project) rememberOpenedProject(project);
      return true;
    }

    if (releaseWorkbench.current && !await releaseWorkbench.current.allowLeave()) return false;
    if (tasksWorkbench.current && !await tasksWorkbench.current.allowLeave()) return false;
    if (sourceWorkbench.current && !await sourceWorkbench.current.allowLeave()) return false;
    if (translationWorkbench.current && !await translationWorkbench.current.allowLeave()) return false;
    if (resourceWorkbench.current && !await resourceWorkbench.current.allowLeave()) return false;
    if (reviewWorkbench.current && !await reviewWorkbench.current.allowLeave()) return false;
    if (aiWorkbench.current && !await aiWorkbench.current.allowLeave()) return false;
    if (arenaWorkbench.current && !await arenaWorkbench.current.allowLeave()) return false;
    setOperation("opening");
    setFeedback({ tone: "info", messageKey: "status.opening" });
    try {
      const view = await projectCommands.open({ locator });
      const sameSession = project?.sessionToken === view.sessionToken;
      setProject(view);
      rememberOpenedProject(view);
      setRestorePromptOpen(false);
      if (sameSession) {
        setOpenPanel(false);
        openForm.reset(OPEN_DEFAULT_VALUES);
        setOperation("idle");
        setFeedback({ tone: "info", messageKey: "feedback.alreadyOpen" });
        return true;
      }
      setActiveForm(null);
      editorForm.reset(EDITOR_DEFAULT_VALUES);
      setOpenPanel(false);
      openForm.reset(OPEN_DEFAULT_VALUES);
      setClosedPanel("empty");
      setOperation("idle");
      setFeedback({ tone: "success", messageKey: "feedback.opened" });
      return true;
    } catch (value) {
      setOperation("idle");
      if (asCommandError(value, "open").code === "busy" && project) {
        setStopIntent({ kind: "open", locator });
        setFeedback(null);
        return false;
      }
      setFeedback(feedbackFromFailure(asCommandError(value, "open")));
      return false;
    }
  }

  async function executeClose(preserveRestoreCandidate = false, coordinated = false) {
    if (releaseWorkbench.current && !await releaseWorkbench.current.allowLeave()) return false;
    if (tasksWorkbench.current && !await tasksWorkbench.current.allowLeave()) return false;
    if (sourceWorkbench.current && !await sourceWorkbench.current.allowLeave()) return false;
    if (translationWorkbench.current && !await translationWorkbench.current.allowLeave()) return false;
    if (resourceWorkbench.current && !await resourceWorkbench.current.allowLeave()) return false;
    if (reviewWorkbench.current && !await reviewWorkbench.current.allowLeave()) return false;
    if (aiWorkbench.current && !await aiWorkbench.current.allowLeave()) return false;
    if (arenaWorkbench.current && !await arenaWorkbench.current.allowLeave()) return false;
    if (!project || (busy && !coordinated)) return false;
    setOperation("closing");
    setFeedback({ tone: "info", messageKey: "status.closing" });
    try {
      const result: CloseProjectView = await projectCommands.close({ sessionToken: project.sessionToken });
      if (!result.closed) throw new Error("close-not-confirmed");
      setProject(null);
      if (!preserveRestoreCandidate) {
        clearLastOpenProject();
        setRestoreCandidate(null);
      }
      setActiveForm(null);
      editorForm.reset(EDITOR_DEFAULT_VALUES);
      setOpenPanel(false);
      setClosedPanel("empty");
      setOperation("idle");
      setFeedback({ tone: "success", messageKey: "feedback.closed" });
      return true;
    } catch (value) {
      setOperation("idle");
      if (asCommandError(value, "close").code === "busy") {
        setStopIntent({ kind: preserveRestoreCandidate ? "window-close" : "close" });
        setFeedback(null);
        return false;
      }
      setFeedback(feedbackFromFailure(asCommandError(value, "close")));
      return false;
    }
  }

  async function executeWindowClose(coordinated = false) {
    if (!project) {
      try {
        await getCurrentWindow().destroy();
        return true;
      } catch {
        setFeedback({ tone: "error", messageKey: "errors.windowCloseFailed" });
        return false;
      }
    }
    const closed = await executeClose(true, coordinated);
    if (!closed) return false;
    try {
      await getCurrentWindow().destroy();
      return true;
    } catch {
      setFeedback({ tone: "error", messageKey: "errors.windowCloseFailed" });
      return false;
    }
  }

  async function stopAndContinue() {
    if (!project || !stopIntent || stopping) return;
    const intent = stopIntent;
    setStopping(true); setFeedback(null);
    try {
      const deadline = performance.now() + 6500;
      let result = await executionCommands.quiesce(executionContext(project));
      while (result.quiescing) {
        if (performance.now() >= deadline) throw { code: "busy", stage: "execution-quiesce", recoveryRequired: false };
        await new Promise(resolve => setTimeout(resolve, 100));
        result = await executionCommands.quiesce(executionContext(project));
      }
      setStoppedSession(project.sessionToken);
      setStopIntent(null);
      if (intent.kind === "open") await executeOpen(intent.locator);
      else if (intent.kind === "window-close") await executeWindowClose(true);
      else if (intent.kind === "close") await executeClose(false, true);
      else setFeedback({ tone: "info", messageKey: "execution.stopped" });
    } catch (value) { setFeedback(feedbackFromFailure(asCommandError(value, "execution-quiesce"))); }
    finally { setStopping(false); }
  }

  async function refreshAfterStale(form: ActiveForm, failure: CommandError): Promise<SaveResult> {
    if (!project) return { ok: false };
    setOperation("reconciling");
    try {
      const view = await projectCommands.read({ sessionToken: project.sessionToken });
      const locatorChanged = normalizeLocator(view.locator) !== normalizeLocator(project.locator);
      setProject(view);
      if (locatorChanged) rememberOpenedProject(view, project.locator);
      setActiveForm((current) =>
        current && current.kind === form.kind ? { ...current, expectedRevision: view.metadata.metadataRevision } : current,
      );
      setOperation("idle");
      setFeedback({
        tone: "warning",
        messageKey: "feedback.stale",
        messageValues: { revision: failure.currentRevision ?? view.metadata.metadataRevision },
        code: "stale-revision",
      });
    } catch {
      setOperation("idle");
      setFeedback({ tone: "error", messageKey: "feedback.staleRefreshFailed", code: "storage-failed", action: "refresh" });
    }
    return { ok: false };
  }

  async function reconcileUnknown(form: ActiveForm): Promise<SaveResult> {
    if (!project || !pendingSave.current || reconciliationInFlight.current) return { ok: false };
    reconciliationInFlight.current = true;
    setOperation("reconciling");
    setFeedback({ tone: "warning", messageKey: "feedback.unknown", code: "outcome-unknown", action: "retry-reconciliation" });
    try {
      const view = await projectCommands.read({ sessionToken: project.sessionToken, expectedRevision: pendingSave.current.form.expectedRevision });
      const outcome = classifySave(view, pendingSave.current);
      if (outcome === "unknown") {
        setFeedback({ tone: "warning", messageKey: "feedback.unknown", code: "outcome-unknown", action: "retry-reconciliation" });
        return { ok: false };
      }
      const locatorChanged = normalizeLocator(view.locator) !== normalizeLocator(project.locator);
      setProject(view);
      if (locatorChanged) rememberOpenedProject(view, project.locator);
      setActiveForm((current) =>
        current && current.kind === form.kind ? { ...current, expectedRevision: view.metadata.metadataRevision } : current,
      );
      pendingSave.current = null;
      if (outcome === "committed") {
        editorForm.reset(EDITOR_DEFAULT_VALUES);
        setActiveForm(null);
        setOperation("idle");
        setFeedback({ tone: "success", messageKey: "feedback.committed" });
        return { ok: true, metadata: view.metadata };
      }
      setOperation("idle");
      setFeedback({ tone: "warning", messageKey: "feedback.previous" });
      return { ok: false, metadata: view.metadata };
    } catch {
      setOperation("reconciling");
      setFeedback({ tone: "error", messageKey: "feedback.reconcileFailed", code: "outcome-unknown", action: "retry-reconciliation" });
    } finally {
      reconciliationInFlight.current = false;
    }
    return { ok: false };
  }

  async function saveForm(form: ActiveForm, value = editorForm.getValues("value")): Promise<SaveResult> {
    if (!project || operation !== "idle" || pendingSave.current) return { ok: false };
    if (!editorForm.formState.isDirty) {
      setActiveForm(null);
      return { ok: true, metadata: project.metadata };
    }

    setOperation("saving");
    pendingSave.current = { previous: project, form, value, ...(form.kind === "rename" && editorForm.getValues("syncDirectoryName") ? { directoryName: value } : {}) };
    setFeedback({ tone: "info", messageKey: "status.saving" });
    try {
      let result: MetadataMutationView;
      if (form.kind === "rename") {
        const shouldSyncDirectoryName = editorForm.getValues("syncDirectoryName");
        if (shouldSyncDirectoryName && !isSafeChildDirectoryName(value)) {
          editorForm.setError("value", { type: "validate" });
          setOperation("idle");
          pendingSave.current = null;
          setFeedback(localValidation(value.trim() ? "directoryName" : "displayName"));
          return { ok: false };
        }
        result = await projectCommands.rename({
          sessionToken: project.sessionToken,
          expectedRevision: form.expectedRevision,
          displayName: value,
          ...(shouldSyncDirectoryName ? { directoryName: value } : {}),
        });
      } else {
        const request: SetTargetLocalesRequest = {
          sessionToken: project.sessionToken,
          expectedRevision: form.expectedRevision,
          targetLocales: parseTargetLocales(value),
        };
        result = await projectCommands.setTargetLocales(request);
      }
      const nextProject = project
        ? {
            ...project,
            locator: result.locator || project.locator,
            metadata: result.metadata,
            reconciliationState: "settled" as const,
          }
        : null;
      setProject(nextProject);
      pendingSave.current = null;
      if (nextProject && form.kind === "rename" && result.directoryChanged) rememberOpenedProject(nextProject, project.locator);
      editorForm.reset(EDITOR_DEFAULT_VALUES);
      setActiveForm(null);
      setOperation("idle");
      setFeedback({
        tone: "success",
        messageKey: form.kind === "rename"
          ? result.directoryChanged
            ? "feedback.renamedWithFolder"
            : result.outcome === "unchanged"
              ? "feedback.unchanged"
              : "feedback.renamed"
          : result.outcome === "unchanged"
            ? "feedback.unchanged"
            : "feedback.targetAdded",
        messageValues: result.outcome === "changed" ? { revision: result.metadata.metadataRevision } : undefined,
      });
      return { ok: true, metadata: result.metadata };
    } catch (value) {
      const failure = asCommandError(value, form.kind === "rename" ? "rename" : "set-target-locales");
      if (failure.code === "busy" && form.kind === "rename" && editorForm.getValues("syncDirectoryName")) setStopIntent({ kind: "rename" });
      if (failure.code === "outcome-unknown") return reconcileUnknown(form);
      pendingSave.current = null;
      if (failure.code === "stale-revision") return refreshAfterStale(form, failure);
      setOperation("idle");
      setFeedback(feedbackFromFailure(failure));
      return { ok: false };
    }
  }

  async function continueNavigation(intent: NavigationIntent, metadata?: ProjectMetadataView) {
    if (intent.kind === "window-close") {
      await executeWindowClose();
      return;
    }
    if (intent.kind === "close") {
      await executeClose();
      return;
    }
    if (intent.kind === "open") {
      await executeOpen(intent.locator);
      return;
    }
    if (intent.kind === "panel") {
      clearFeedback();
      setClosedPanel(intent.panel);
      createForm.reset(CREATE_DEFAULT_VALUES);
      folderNameEdited.current = false;
      openForm.reset(OPEN_DEFAULT_VALUES);
      return;
    }
    const nextMetadata = metadata ?? project?.metadata;
    if (nextMetadata) beginEditor(intent.formKind, nextMetadata);
  }

  async function resolveNavigation(choice: "save" | "discard" | "cancel") {
    if (!navigationIntent) return;
    if (choice === "cancel") {
      setNavigationIntent(null);
      return;
    }
    const intent = navigationIntent;
    if (choice === "discard") {
      if (createDraftDirty) {
        createForm.reset(CREATE_DEFAULT_VALUES);
        folderNameEdited.current = false;
      } else {
        editorForm.reset(EDITOR_DEFAULT_VALUES);
        setActiveForm(null);
      }
      setNavigationIntent(null);
      await continueNavigation(intent);
      return;
    }
    if (!activeForm) {
      setNavigationIntent(null);
      await continueNavigation(intent);
      return;
    }
    const result = await saveForm(activeForm, editorForm.getValues("value"));
    if (!result.ok) return;
    setNavigationIntent(null);
    setFeedback({ tone: "success", messageKey: "feedback.savedBeforeContinue" });
    await continueNavigation(intent, result.metadata);
  }

  function handleCloseRequest() {
    if (!project || busy) return;
    if (dirty) {
      requestNavigation({ kind: "close" });
      return;
    }
    void executeClose();
  }

  function handleOpenSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    void openForm.handleSubmit(({ locator }) => {
      if (dirty && !isSameProject(locator)) {
        requestNavigation({ kind: "open", locator });
        return;
      }
      void executeOpen(locator);
    }, () => setFeedback(localValidation("locator")))();
  }

  function handleCreateCancel() {
    if (busy) return;
    if (createDraftDirty) {
      requestNavigation({ kind: "panel", panel: "empty" });
      return;
    }
    createForm.reset(CREATE_DEFAULT_VALUES);
    folderNameEdited.current = false;
    clearFeedback();
    setClosedPanel("empty");
  }

  function handleSave(value = editorForm.getValues("value")) {
    if (activeForm && !busy) void saveForm(activeForm, value);
  }

  function cancelEditor() {
    editorForm.reset(EDITOR_DEFAULT_VALUES);
    setActiveForm(null);
    clearFeedback();
  }

  function handleRefresh() {
    if (!project || busy) return;
    setOperation("reconciling");
    void projectCommands
      .read({ sessionToken: project.sessionToken })
      .then((view) => {
        const locatorChanged = normalizeLocator(view.locator) !== normalizeLocator(project.locator);
        setProject(view);
        if (locatorChanged) rememberOpenedProject(view, project.locator);
        setActiveForm((current) => (current ? { ...current, expectedRevision: view.metadata.metadataRevision } : current));
        setOperation("idle");
        setFeedback({ tone: "info", messageKey: "feedback.opened" });
      })
      .catch((value) => {
        setOperation("idle");
        setFeedback(feedbackFromFailure(asCommandError(value, "read")));
      });
  }

  function handleRetryReconciliation() {
    if (activeForm && project && (operation === "idle" || operation === "reconciling")) void reconcileUnknown(activeForm);
  }

  async function chooseDirectory(target: DirectoryPickerTarget) {
    if (busy) return;
    try {
      const selected = await pickDirectory({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      if (target === "create") {
        createForm.setValue("parentDirectory", selected, { shouldDirty: true, shouldValidate: true });
      } else {
        openForm.setValue("locator", selected, { shouldDirty: true, shouldValidate: true });
      }
    } catch {
      setFeedback({ tone: "error", messageKey: "errors.directoryPickerUnavailable" });
    }
  }

  function addTargetPreset(form: "create" | "editor", value: string) {
    if (!value || busy) return;
    clearFieldFeedback("targetLocales");
    if (form === "create") {
      const current = parseTargetLocales(createForm.getValues("targetLocales"));
      if (!current.some((locale) => locale.toLowerCase() === value.toLowerCase())) {
        createForm.setValue("targetLocales", [...current, value].join(", "), { shouldDirty: true, shouldValidate: true });
      }
      return;
    }
    const current = parseTargetLocales(editorForm.getValues("value"));
    if (current.some((locale) => locale.toLowerCase() === value.toLowerCase())) {
      setFeedback({ tone: "warning", messageKey: "feedback.duplicateTarget" });
      return;
    }
    editorForm.setValue("value", [...current, value].join(", "), { shouldDirty: true, shouldValidate: true });
  }

  function renderTargetSelection(form: "create" | "editor", raw: string) {
    const values = parseTargetLocales(raw);
    return (
      <ul className="target-selection" aria-label={t("create.selectedTargets")}>
        {values.map((value, index) => {
          const name = localeDisplayName(t, value, locale);
          return (
            <li key={`${index}:${value}`}>
              <span>{localeLabel(t, value, locale)}</span>
              <button type="button" disabled={busy}
                aria-label={t("create.removeTarget", { language: name === value ? value : `${name} (${value})` })}
                onClick={() => {
                  const next = values.filter((_, candidate) => candidate !== index).join(", ");
                  if (form === "create") createForm.setValue("targetLocales", next, { shouldDirty: true, shouldValidate: true });
                  else editorForm.setValue("value", next, { shouldDirty: true, shouldValidate: true });
                  clearFieldFeedback("targetLocales");
                  document.getElementById(form === "create" ? "create-target-locales" : "editor-value")?.focus();
                }}>
                <Icon name="close" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  function handleCreateInvalid(errors: FieldErrors<CreateFormValues>) {
    setFeedback(localValidation(firstErrorField(errors as FieldErrors<Record<string, unknown>>) ?? "parentDirectory"));
  }

  function handleEditorInvalid() {
    const value = editorForm.getValues("value");
    const field = activeForm?.kind === "rename"
      ? editorForm.getValues("syncDirectoryName") && value.trim() && !isSafeChildDirectoryName(value)
        ? "directoryName"
        : "displayName"
      : "targetLocales";
    setFeedback(localValidation(field));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (area !== "overview") return;
      if (event.key === "Escape" && !event.defaultPrevented && !busy && !navigationIntent && !restorePromptOpen) {
        event.preventDefault();
        if (openPanel) {
          setOpenPanel(false);
        } else if (activeForm) {
          cancelEditor();
        } else if (closedPanel === "create") {
          handleCreateCancel();
        } else if (closedPanel === "open") {
          setClosedPanel("empty");
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && activeForm && dirty && operation === "idle") {
        event.preventDefault();
        handleSave();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeForm, dirty, operation, navigationIntent, restorePromptOpen, closedPanel, createDraftDirty, openPanel, area]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          event.preventDefault();
          if (disposed) return;
          if (busy) {
            return;
          }
           if (!project && createDraftDirty) {
             requestNavigation({ kind: "window-close" });
             return;
           }
           if (!project) {
             await executeWindowClose();
            return;
          }
          if (dirty) {
            requestNavigation({ kind: "window-close" });
            return;
          }
          await executeWindowClose();
        })
        .then((cleanup) => {
          if (disposed) cleanup();
          else unlisten = cleanup;
        })
        .catch(() => {
          // Browser preview does not expose the native close event.
        });
    } catch {
      // Browser preview does not expose the native window API.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [busy, createDraftDirty, dirty, project, resolvedLanguage]);

  useEffect(() => { setArea("overview"); }, [project?.sessionToken]);
  useEffect(() => {
    if (!project || area !== "overview") return;
    let stale = false;
    setSourceState("loading");
    void sourceCommands.scope(executionContext(project)).then(scope => {
      if (!stale) setSourceState(scope.currentSnapshot ? "ready" : "empty");
    }).catch(() => { if (!stale) setSourceState("failed"); });
    return () => { stale = true; };
  }, [project?.sessionToken, area]);
  async function navigateArea(next: WorkspaceArea) {
    if (next === area || busy || stopping || areaNavigation.current) return;
    const handles = { source: sourceWorkbench, translation: translationWorkbench, resources: resourceWorkbench,
      review: reviewWorkbench, ai: aiWorkbench, arena: arenaWorkbench, release: releaseWorkbench, tasks: tasksWorkbench };
    const session = currentSession.current;
    areaNavigation.current = true;
    try {
      if (area === "source") { if (sourceWorkbench.current && !await sourceWorkbench.current.allowNavigate()) return; }
      else if (area !== "overview" && handles[area].current && !await handles[area].current!.allowLeave()) return;
      if (currentSession.current === session) setArea(next);
    } finally { areaNavigation.current = false; }
  }
  const viewOwner = { area, activate: setArea, deactivate: (closing: WorkspaceArea) => setArea(current => current === closing ? "overview" : current) };
  const renderFeedback = feedback ? (
    <div className={`feedback feedback-${feedback.tone}`} aria-live="polite" role={feedback.tone === "error" ? "alert" : "status"}>
      <div className="feedback-copy">
        <strong>{feedback.tone === "success" ? "✓" : feedback.tone === "warning" ? "!" : "·"}</strong>
        <span>{renderFeedbackMessage(t, feedback)}</span>
      </div>
      <div className="feedback-actions">
        {feedback.action === "refresh" ? (
          <button className="text-button" type="button" onClick={handleRefresh} disabled={busy}>
            <Icon name="refresh" size={16} />
            {t("action.refresh")}
          </button>
        ) : null}
        {feedback.action === "retry-reconciliation" ? (
          <button className="text-button" type="button" onClick={handleRetryReconciliation} disabled={operation !== "idle" && operation !== "reconciling"}>
            <Icon name="refresh" size={16} />
            {t("action.retry")}
          </button>
        ) : null}
        {feedback.tone === "success" ? (
          <button className="feedback-dismiss" type="button" aria-label={t("action.dismiss")} onClick={clearFeedback}>
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <WorkspaceViewProvider value={viewOwner}><main className="shell">
      <DialogRoot open={stopIntent !== null} onOpenChange={open => { if (!open && !stopping) setStopIntent(null); }}>
        <DialogPortal><DialogOverlay className="dialog-backdrop lifecycle-confirm-backdrop" /><DialogContent className="confirm-dialog lifecycle-confirm-dialog" onEscapeKeyDown={event => { if (stopping) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
          <DialogTitle>{t("execution.stopTitle")}</DialogTitle><DialogDescription>{t("execution.stopHelp")}</DialogDescription>
          {renderFeedback}
          <div className="form-actions"><button className="secondary-button" disabled={stopping} onClick={() => setStopIntent(null)}>{t("execution.back")}</button><button className="primary-button" disabled={stopping} onClick={() => void stopAndContinue()}>{stopping ? t("execution.working") : t("execution.stop")}</button></div>
        </DialogContent></DialogPortal>
      </DialogRoot>
      <aside className="sidebar" aria-label={t("nav.workspace")}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <div>
            <p className="brand-name">Tsumugi</p>
            <p className="brand-description">{t("brandDescription")}</p>
          </div>
        </div>

        <WorkbenchNavigation area={area} hasProject={Boolean(project)} disabled={busy || stopping} onNavigate={next => void navigateArea(next)} />

        <div className="sidebar-footer" aria-live="polite">
          <span className={`status-dot status-dot-${operation}`} aria-hidden="true" />
          <span>{status}</span>
        </div>
      </aside>

      <section className="workspace" aria-label={t("nav.workspace")}>
        <header className="topbar">
          <div className="workspace-caption">
            <Icon name="folder-open" size={16} />
            <span>{project?.metadata.displayName ?? t("nav.workspace")}</span>
          </div>
           <div className="topbar-actions">
            <label className="language-control">
              <span>{t("language")}</span>
              <select
                aria-label={t("language")}
                value={locale}
                onChange={(event) => {
                  const nextLocale = event.target.value;
                  if (isLocale(nextLocale)) void translation.changeLanguage(nextLocale);
                }}
              >
                {localeOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
              </select>
            </label>
           </div>
        </header>

        <div className="workspace-body">
          <div hidden={area !== "overview"} className={`workbench-content${project ? " is-project" : " is-closed"}`}>
            {stopIntent ? null : renderFeedback}
            {project && stoppedSession === project.sessionToken ? <p role="status">{t("execution.stopped")}</p> : null}

            {!project ? (
              <section className="closed-state" aria-live="polite">
                {closedPanel === "empty" ? (
                  <>
                    <h1>{t("empty.title")}</h1>
                    <p className="empty-lede">{t("empty.body")}</p>
                    <p className="empty-detail">{t("empty.detail")}</p>
                    <div className="empty-actions">
                      <button className="primary-button" type="button" onClick={() => { clearFeedback(); setClosedPanel("create"); }} disabled={busy}>
                        <Icon name="plus" size={18} />
                        {t("empty.create")}
                      </button>
                      <button className="secondary-button" type="button" onClick={() => { clearFeedback(); setClosedPanel("open"); }} disabled={busy}>
                        <Icon name="folder-open" size={18} />
                        {t("empty.open")}
                      </button>
                    </div>
                    {recentProjects.length > 0 ? (
                      <section className="recent-projects" aria-labelledby="recent-projects-title">
                        <h2 id="recent-projects-title">{t("recent.title")}</h2>
                        <ul>
                          {recentProjects.map((recent) => (
                            <li key={normalizeLocator(recent.locator)}>
                              <button className="recent-project" type="button" onClick={() => void executeOpen(recent.locator)} disabled={busy}>
                                <span className="recent-project-copy">
                                  <strong>{recentProjectName(recent.locator)}</strong>
                                  <small>{recent.locator}</small>
                                </span>
                                <Icon name="folder-open" size={16} />
                              </button>
                              <button
                                className="recent-project-remove"
                                type="button"
                                aria-label={t("recent.remove", { name: recentProjectName(recent.locator) })}
                                onClick={() => forgetRecentProject(recent.locator)}
                                disabled={busy}
                              >
                                <Icon name="close" size={15} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </>
                ) : closedPanel === "create" ? (
                  <form className="form-card create-form" onChange={(event) => {
                    const target = event.target;
                    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) clearFieldFeedback(target.name);
                  }} onSubmit={createForm.handleSubmit(executeCreate, handleCreateInvalid)}>
                    <fieldset className="form-body" disabled={busy}>
                    <div className="form-heading">
                      <h1>{t("create.title")}</h1>
                      <p>{t("create.intro")}</p>
                    </div>
                    <div className="form-fields">
                      <label className="field" htmlFor="create-display-name">
                        <span>{t("create.displayName")}</span>
                        <input
                          id="create-display-name"
                          aria-invalid={Boolean(createForm.formState.errors.displayName || fieldError(feedback, "displayName"))}
                          placeholder={t("create.displayNamePlaceholder")}
                          {...createForm.register("displayName", {
                            required: true,
                            validate: (value) => Boolean(value.trim()),
                            onChange: (event) => {
                              if (!folderNameEdited.current) {
                                createForm.setValue("directoryName", event.target.value, { shouldValidate: true });
                              }
                            },
                          })}
                        />
                        <small>{t("create.displayNameHelp")}</small>
                        {createForm.formState.errors.displayName || fieldError(feedback, "displayName") ? <span className="field-error">{t("errors.displayName")}</span> : null}
                      </label>
                      <label className="field" htmlFor="create-parent-directory">
                        <span>{t("create.parentDirectory")}</span>
                        <div className="field-picker">
                          <input
                            id="create-parent-directory"
                            aria-invalid={Boolean(createForm.formState.errors.parentDirectory || fieldError(feedback, "parentDirectory"))}
                            placeholder={t("create.parentDirectoryPlaceholder")}
                            {...createForm.register("parentDirectory", { required: true, validate: (value) => Boolean(value.trim()) })}
                          />
                          <button className="secondary-button" type="button" onClick={() => void chooseDirectory("create")} disabled={busy}>
                            <Icon name="folder-open" size={16} />
                            {t("create.chooseFolder")}
                          </button>
                        </div>
                        <small>{t("create.parentDirectoryHelp")}</small>
                        {createForm.formState.errors.parentDirectory || fieldError(feedback, "parentDirectory") ? <span className="field-error">{t("errors.parentDirectory")}</span> : null}
                      </label>
                      <label className="field" htmlFor="create-directory-name">
                        <span>{t("create.directoryName")}</span>
                        <input
                          id="create-directory-name"
                          aria-invalid={Boolean(createForm.formState.errors.directoryName || fieldError(feedback, "directoryName"))}
                          placeholder={t("create.directoryNamePlaceholder")}
                          {...createForm.register("directoryName", {
                            required: true,
                            validate: isSafeChildDirectoryName,
                            onChange: () => { folderNameEdited.current = true; },
                          })}
                        />
                        <small>{t("create.directoryNameHelp")}</small>
                        {createForm.formState.errors.directoryName || fieldError(feedback, "directoryName") ? <span className="field-error">{t("errors.directoryName")}</span> : null}
                      </label>
                      <div className="field-grid language-fields">
                        <label className="field" htmlFor="create-source-locale">
                          <span>{t("create.sourceLocale")}</span>
                          <div className="locale-picker">
                            <select
                              aria-label={t("create.sourcePreset")}
                              value={isPresetLocale(createSourceLocale) ? createSourceLocale : ""}
                              onChange={(event) => {
                                if (event.target.value) createForm.setValue("sourceLocale", event.target.value, { shouldDirty: true, shouldValidate: true });
                              }}
                            >
                              <option value="">{t("create.choosePreset")}</option>
                              {languagePresets.map((preset) => <option key={preset.value} value={preset.value}>{t(preset.labelKey)}</option>)}
                            </select>
                            <input
                              id="create-source-locale"
                              aria-invalid={Boolean(createForm.formState.errors.sourceLocale || fieldError(feedback, "sourceLocale"))}
                              placeholder={t("create.sourceLocalePlaceholder")}
                              {...createForm.register("sourceLocale", { required: true, validate: (value) => Boolean(value.trim()) })}
                            />
                          </div>
                          <small>{t("create.sourceLocaleHelp")}</small>
                          {createForm.formState.errors.sourceLocale || fieldError(feedback, "sourceLocale") ? <span className="field-error">{t("errors.sourceLocale")}</span> : null}
                        </label>
                        <div className="field">
                          <label htmlFor="create-target-locales">{t("create.targetLocales")}</label>
                          <select
                            aria-label={t("create.targetPreset")}
                            defaultValue=""
                            onChange={(event) => {
                              addTargetPreset("create", event.target.value);
                              event.currentTarget.value = "";
                            }}
                          >
                            <option value="">{t("create.addTarget")}</option>
                            {languagePresets.map((preset) => <option key={preset.value} value={preset.value}>{t(preset.labelKey)}</option>)}
                          </select>
                          {renderTargetSelection("create", createTargetLocales)}
                          <input
                            id="create-target-locales"
                            aria-invalid={Boolean(createForm.formState.errors.targetLocales || fieldError(feedback, "targetLocales"))}
                            placeholder={t("create.targetLocalesPlaceholder")}
                            {...createForm.register("targetLocales", { required: true, validate: (value) => parseTargetLocales(value).length > 0 })}
                          />
                          <small>{t("create.targetLocalesHelp")}</small>
                          {createForm.formState.errors.targetLocales || fieldError(feedback, "targetLocales") ? <span className="field-error">{t("errors.targetLocales")}</span> : null}
                        </div>
                      </div>
                      <div className="destination-preview" aria-live="polite">
                        <span>{t("create.destinationPreview")}</span>
                        <code>{destinationPreview || t("create.destinationPreviewEmpty")}</code>
                      </div>
                    </div>
                    <div className="form-actions">
                      <button className="secondary-button" type="button" onClick={handleCreateCancel} disabled={busy}>
                        {t("action.cancel")}
                      </button>
                      <button className="primary-button" type="submit" disabled={busy}>
                        <Icon name="folder-open" size={18} />
                        {busy ? t("status.opening") : t("create.submit")}
                      </button>
                    </div>
                    </fieldset>
                  </form>
                ) : (
                  <form className="form-card compact-form-card" onSubmit={handleOpenSubmit}>
                    <div className="form-heading">
                      <p className="eyebrow">{t("empty.open")}</p>
                      <h1>{t("open.title")}</h1>
                      <p>{t("open.intro")}</p>
                    </div>
                    <label className="field" htmlFor="open-locator">
                      <span>{t("open.destination")}</span>
                      <div className="field-picker">
                        <input
                          id="open-locator"
                          aria-invalid={Boolean(openForm.formState.errors.locator || fieldError(feedback, "locator"))}
                          placeholder={t("open.destinationPlaceholder")}
                          {...openForm.register("locator", { required: true })}
                        />
                        <button className="secondary-button" type="button" onClick={() => void chooseDirectory("open")} disabled={busy}>
                          <Icon name="folder-open" size={16} />
                          {t("open.chooseFolder")}
                        </button>
                      </div>
                      <small>{t("open.destinationHelp")}</small>
                      {openForm.formState.errors.locator || fieldError(feedback, "locator") ? <span className="field-error">{t("errors.locator")}</span> : null}
                    </label>
                    <div className="form-actions">
                      <button className="secondary-button" type="button" onClick={() => { clearFeedback(); setClosedPanel("empty"); }} disabled={busy}>
                        {t("action.cancel")}
                      </button>
                      <button className="primary-button" type="submit" disabled={busy}>
                        <Icon name="folder-open" size={18} />
                        {busy ? t("status.opening") : t("open.submit")}
                      </button>
                    </div>
                  </form>
                )}
              </section>
            ) : (
              <section className="project-state" aria-live="polite">
                <div className="project-heading">
                  <div>
                    <p className="eyebrow">{t("project.eyebrow")}</p>
                    <h1>{project.metadata.displayName}</h1>
                    <div className="project-location">
                      <span title={project.locator}>{project.locator}</span>
                      <button className="text-button" type="button" onClick={() => void copyProjectLocation()} disabled={busy}>
                        {copiedLocator ? t("project.locationCopied") : t("project.copyLocation")}
                      </button>
                    </div>
                  </div>
                  <span className={`status-badge status-badge-${operation}`}>
                    <span className="status-dot" aria-hidden="true" />
                    {status}
                  </span>
                </div>

                <section className="project-next-step" aria-label={t("workbench.nextStep")}>
                  <div><h2>{t(sourceState === "ready" ? "workbench.continueTitle" : "workbench.importTitle")}</h2>
                  <p>{t(sourceState === "ready" ? "workbench.continueHelp" : sourceState === "failed" ? "workbench.sourceFailed" : "workbench.importHelp")}</p></div>
                  <button type="button" className="primary-button" disabled={busy || sourceState === "loading"} onClick={() => void navigateArea(sourceState === "ready" ? "translation" : "source")}>{t(sourceState === "ready" ? "workbench.continue" : "workbench.import")}</button>
                  {sourceState === "ready" ? <div className="execution-actions"><button type="button" className="secondary-button" onClick={() => void navigateArea("review")}>{t("review.title")}</button><button type="button" className="secondary-button" onClick={() => void navigateArea("release")}>{t("release.title")}</button></div> : null}
                </section>
                <dl className="metadata-grid" aria-label={t("accessibility.metadata")}>
                  <div className="metadata-item">
                    <dt>{t("project.source")}</dt>
                    <dd title={project.metadata.sourceLocale}>{localeLabel(t, project.metadata.sourceLocale, translation.resolvedLanguage ?? "en-US")}</dd>
                  </div>
                  <div className="metadata-item metadata-targets">
                    <dt>{t("project.targets")}</dt>
                    <dd>
                       {project.metadata.targetLocales.length > 0 ? project.metadata.targetLocales.map((target) => <span className="locale-chip" key={target}>{localeLabel(t, target, translation.resolvedLanguage ?? "en-US")}</span>) : <span>{t("project.noTargets")}</span>}
                    </dd>
                  </div>
                </dl>

                <details className="project-details">
                  <summary>{t("project.showDetails")}</summary>
                  <dl>
                    <div><dt>{t("project.identity")}</dt><dd>{project.metadata.projectId}</dd></div>
                    <div><dt>{t("project.revision")}</dt><dd>{project.metadata.metadataRevision}</dd></div>
                  </dl>
                </details>

                <div className="action-bar" aria-label={t("accessibility.projectActions")}>
                  <button className="secondary-button" type="button" onClick={() => startEditor("rename")} disabled={busy}>
                    {t("project.rename")}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => startEditor("target")} disabled={busy}>
                    <Icon name="plus" size={17} />
                    {t("project.addTarget")}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => { clearFeedback(); setOpenPanel((current) => !current); }} disabled={busy}>
                    <Icon name="folder-open" size={17} />
                    {t("project.openAnother")}
                  </button>
                  <button className="danger-button" type="button" onClick={handleCloseRequest} disabled={busy}>
                    <Icon name="close" size={17} />
                    {t("project.close")}
                  </button>
                </div>

                {openPanel ? (
                  <form className="inline-card" onSubmit={handleOpenSubmit}>
                    <div>
                      <h2>{t("open.title")}</h2>
                      <p>{t("project.showOpen")}</p>
                    </div>
                    <div className="inline-form-row">
                      <label className="field field-grow" htmlFor="open-locator-inline">
                        <span>{t("open.destination")}</span>
                        <div className="field-picker">
                          <input
                            id="open-locator-inline"
                            aria-invalid={Boolean(openForm.formState.errors.locator || fieldError(feedback, "locator"))}
                            autoFocus
                            placeholder={t("open.destinationPlaceholder")}
                            {...openForm.register("locator", { required: true })}
                          />
                          <button className="secondary-button" type="button" onClick={() => void chooseDirectory("open")} disabled={busy}>
                            <Icon name="folder-open" size={16} />
                            {t("open.chooseFolder")}
                          </button>
                        </div>
                        <small>{t("open.destinationHelp")}</small>
                        {openForm.formState.errors.locator || fieldError(feedback, "locator") ? <span className="field-error">{t("errors.locator")}</span> : null}
                      </label>
                      <button className="primary-button" type="submit" disabled={busy}>{t("open.submit")}</button>
                      <button className="secondary-button" type="button" onClick={() => setOpenPanel(false)} disabled={busy}>{t("action.cancel")}</button>
                    </div>
                  </form>
                ) : null}

                {activeForm ? (
                  <form className="editor-card" onChange={clearEditorFeedback} onSubmit={editorForm.handleSubmit(({ value }) => handleSave(value), handleEditorInvalid)}>
                    <fieldset className="editor-fields" disabled={busy}>
                    <div className="editor-heading">
                      <div>
                        <p className="eyebrow">{activeForm.kind === "rename" ? t("project.rename") : t("project.addTarget")}</p>
                        <h2>{activeForm.kind === "rename" ? t("editor.renameTitle") : t("editor.targetTitle")}</h2>
                      </div>
                      <span className="basis-label">{t("editor.basis", { revision: activeForm.expectedRevision })}</span>
                    </div>
                    <div className="field">
                      <label htmlFor="editor-value">{activeForm.kind === "rename" ? t("editor.renameLabel") : t("editor.targetLabel")}</label>
                      {activeForm.kind === "target" ? (
                        <select
                          aria-label={t("editor.targetPreset")}
                          disabled={busy}
                          defaultValue=""
                          onChange={(event) => {
                            addTargetPreset("editor", event.target.value);
                            event.currentTarget.value = "";
                          }}
                        >
                          <option value="">{t("create.addTarget")}</option>
                          {languagePresets.map((preset) => <option key={preset.value} value={preset.value}>{t(preset.labelKey)}</option>)}
                        </select>
                      ) : null}
                      {activeForm.kind === "target" ? renderTargetSelection("editor", editorValue) : null}
                      <input
                        id="editor-value"
                        aria-label={activeForm.kind === "rename" ? t("editor.renameLabel") : t("editor.targetLabel")}
                        aria-invalid={Boolean(editorForm.formState.errors.value || fieldError(feedback, editorErrorField))}
                        autoFocus
                        {...editorForm.register("value", { required: true, validate: (value) => Boolean(value.trim()) })}
                      />
                      <small>{activeForm.kind === "rename" ? t("editor.renameHelp") : t("editor.targetHelp")}</small>
                      {editorForm.formState.errors.value || fieldError(feedback, editorErrorField) ? (
                        <span className="field-error">
                          {activeForm.kind === "rename"
                            ? t(editorDirectoryError ? "errors.directoryName" : "errors.displayName")
                            : t("errors.targetLocales")}
                        </span>
                      ) : null}
                    </div>
                    {activeForm.kind === "rename" ? (
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          aria-label={t("editor.syncDirectoryName")}
                          {...editorForm.register("syncDirectoryName")}
                        />
                        <span>
                          <strong>{t("editor.syncDirectoryName")}</strong>
                          <small>{t("editor.syncDirectoryNameHelp")}</small>
                        </span>
                      </label>
                    ) : null}
                    <div className="form-actions">
                      <button className="secondary-button" type="button" onClick={cancelEditor} disabled={busy}>{t("editor.cancel")}</button>
                      <button className="primary-button" type="submit" disabled={busy || !dirty}>
                        <Icon name="save" size={17} />
                        {busy ? t("status.saving") : t("editor.save")}
                      </button>
                    </div>
                    </fieldset>
                  </form>
                ) : null}
              </section>
            )}
          </div>
          {project ? <><SourceWorkbench key={project.sessionToken} ref={sourceWorkbench} project={project} disabled={busy || stopping} onOpenTranslation={(target, locale) => translationWorkbench.current?.openUnit(target, locale) ?? false} onOpenWork={() => reviewWorkbench.current?.showWork()} /><TranslationWorkbench key={`translations:${project.sessionToken}`} ref={translationWorkbench} project={project} disabled={busy || stopping} /><ResourceWorkbench key={`resources:${project.sessionToken}`} ref={resourceWorkbench} project={project} disabled={busy || stopping} onOpenTranslation={(target, locale, suggestion) => translationWorkbench.current?.openUnit(target, locale, suggestion) ?? false} /><ReviewWorkbench key={`review:${project.sessionToken}`} ref={reviewWorkbench} project={project} disabled={busy || stopping} onOpenTranslation={(target, locale) => translationWorkbench.current?.openUnit(target, locale) ?? false} /><ReleaseWorkbench ref={releaseWorkbench} onOpenTranslation={(target, locale) => translationWorkbench.current?.openUnit(target, locale) ?? false} key={`release:${project.sessionToken}`} project={project} disabled={busy || stopping} /><AiWorkbench key={`ai:${project.sessionToken}`} ref={aiWorkbench} project={project} disabled={busy || stopping} onOpenTranslation={(target, locale) => translationWorkbench.current?.openUnit(target, locale) ?? false} /><ArenaWorkbench key={`arena:${project.sessionToken}`} ref={arenaWorkbench} project={project} disabled={busy || stopping} onOpenTranslation={(target, locale) => translationWorkbench.current?.openUnit(target, locale) ?? false} /><ExecutionTasks ref={tasksWorkbench} onArenaPreview={id => arenaWorkbench.current?.showAttempt(id)} onAiPreview={id => aiWorkbench.current?.showAttempt(id)} key={`tasks:${project.sessionToken}`} project={project} disabled={busy || stopping} onSourcePreview={id => sourceWorkbench.current?.showAttempt(id)} onTranslationPreview={id => translationWorkbench.current?.showAttempt(id)} /></> : null}
        </div>

        <DialogRoot
          open={Boolean(navigationIntent)}
          onOpenChange={(open) => {
            if (!open && !busy) setNavigationIntent(null);
          }}
        >
          <DialogPortal>
            <DialogOverlay className="dialog-backdrop" />
            <DialogContent
              className="confirm-dialog"
              aria-busy={busy}
              onEscapeKeyDown={(event) => {
                event.preventDefault();
                if (!busy) void resolveNavigation("cancel");
              }}
              onInteractOutside={(event) => {
                if (busy) event.preventDefault();
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                cancelDialogButton.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const target = dialogReturnFocus.current;
                dialogReturnFocus.current = null;
                if (target?.isConnected) target.focus();
              }}
            >
              <p className="eyebrow">{createDraftDirty ? t("empty.create") : t("status.unsaved")}</p>
              <DialogTitle>{createDraftDirty ? t("dialog.createTitle") : t("dialog.title")}</DialogTitle>
              <DialogDescription>
                {createDraftDirty && navigationIntent?.kind === "window-close"
                  ? t("dialog.createWindowCloseMessage")
                  : navigationIntent?.kind === "panel"
                  ? t("dialog.createMessage")
                  : navigationIntent?.kind === "close" || navigationIntent?.kind === "window-close"
                  ? t("dialog.closeMessage")
                  : navigationIntent?.kind === "open"
                    ? t("dialog.openMessage")
                    : t("dialog.formMessage")}
              </DialogDescription>
              <p className="dialog-supporting-copy">{createDraftDirty
                ? t(navigationIntent?.kind === "window-close" ? "dialog.createWindowCloseSupporting" : "dialog.createSupporting")
                : t("dialog.message")}</p>
              {!createDraftDirty && feedback && (feedback.tone === "error" || feedback.tone === "warning") ? (
                <div className={`dialog-feedback feedback-${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
                  <span>{renderFeedbackMessage(t, feedback)}</span>
                  {feedback.action === "refresh" ? <button className="text-button" type="button" onClick={handleRefresh} disabled={busy}>{t("action.refresh")}</button> : null}
                  {feedback.action === "retry-reconciliation" ? <button className="text-button" type="button" onClick={handleRetryReconciliation} disabled={operation !== "idle" && operation !== "reconciling"}>{t("action.retry")}</button> : null}
                </div>
              ) : null}
              <div className="dialog-actions">
                <button ref={cancelDialogButton} className="secondary-button" type="button" onClick={() => void resolveNavigation("cancel")} disabled={busy}>{createDraftDirty ? t("action.keepEditing") : t("action.cancel")}</button>
                {activeForm || createDraftDirty ? <button className="danger-button" type="button" onClick={() => void resolveNavigation("discard")} disabled={busy}>{t("action.discard")}</button> : null}
                {activeForm && !createDraftDirty ? <button className="primary-button" type="button" onClick={() => void resolveNavigation("save")} disabled={busy}>{t("action.saveAndContinue")}</button> : null}
                {!activeForm && !createDraftDirty ? <button className="primary-button" type="button" disabled={busy} onClick={() => {
                  const intent = navigationIntent;
                  setNavigationIntent(null);
                  if (intent) void continueNavigation(intent);
                }}>{t("action.continue")}</button> : null}
              </div>
            </DialogContent>
          </DialogPortal>
        </DialogRoot>

        <DialogRoot
          open={restorePromptOpen && Boolean(restoreCandidate) && !Boolean(navigationIntent) && !project}
          onOpenChange={(open) => {
            if (!open) declineRestore();
          }}
        >
          <DialogPortal>
            <DialogOverlay className="dialog-backdrop" />
            <DialogContent className="confirm-dialog restore-dialog">
              <p className="eyebrow">{t("recent.title")}</p>
              <DialogTitle>{t("restore.title")}</DialogTitle>
              <DialogDescription>
                {t("restore.message", { name: restoreCandidate ? recentProjectName(restoreCandidate.locator) : "" })}
              </DialogDescription>
              <p className="dialog-supporting-copy restore-location">{restoreCandidate?.locator}</p>
              <div className="dialog-actions">
                <button className="secondary-button" type="button" onClick={declineRestore}>{t("restore.startFresh")}</button>
                <button className="primary-button" type="button" onClick={() => void restoreLastProject()}>{t("restore.open")}</button>
              </div>
            </DialogContent>
          </DialogPortal>
        </DialogRoot>
      </section>
    </main></WorkspaceViewProvider>
  );
}

export default App;
