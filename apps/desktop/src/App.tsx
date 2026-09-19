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
import type { TranslationKey } from "./i18n/types";
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
  type AddTargetLocaleRequest,
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

const CREATE_DEFAULT_VALUES: CreateFormValues = {
  parentDirectory: "",
  directoryName: "",
  displayName: "",
  sourceLocale: "en-US",
  targetLocales: "zh-Hans",
};

const OPEN_DEFAULT_VALUES: OpenFormValues = { locator: "" };
const EDITOR_DEFAULT_VALUES: EditorFormValues = { value: "" };

const navigation = (t: TFunction) => [{ label: t("nav.workspace"), icon: "folder" as const, selected: true }];

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

function localeLabel(t: TFunction, value: string): string {
  const preset = languagePresets.find((candidate) => candidate.value === value);
  if (preset) return t(preset.labelKey);
  if (value === "zh-CN") return `${t("localeNames.simplifiedChinese")} (${value})`;
  if (value === "zh-TW" || value === "zh-HK") return `${t("localeNames.traditionalChinese")} (${value})`;
  return value;
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
  return { code: "storage-failed", stage, recoveryRequired: false };
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
  const allowWindowClose = useRef(false);
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
  const destinationPreview = previewDestination(createParentDirectory, createDirectoryName);
  const busy = operation !== "idle";
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

  function rememberOpenedProject(view: ProjectView) {
    const recent = rememberProject(view);
    setRecentProjects(recent);
    setRestoreCandidate(recent[0] ?? null);
  }

  function isSameProject(locator: string): boolean {
    return Boolean(project?.locator) && normalizeLocator(project?.locator ?? "") === normalizeLocator(locator);
  }

  async function copyProjectLocation() {
    if (!project?.locator) return;
    try {
      await navigator.clipboard.writeText(project.locator);
      setCopiedLocator(true);
      setFeedback({ tone: "success", messageKey: "feedback.locationCopied" });
      window.setTimeout(() => setCopiedLocator(false), 1600);
    } catch {
      setFeedback({ tone: "error", messageKey: "errors.copyFailed" });
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
    editorForm.reset({ value: kind === "rename" ? metadata.displayName : "" });
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

    setOperation("opening");
    setFeedback({ tone: "info", messageKey: "status.opening" });
    let destination: string;
    try {
      destination = await joinPath(values.parentDirectory, values.directoryName);
    } catch {
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
      setFeedback(feedbackFromFailure(asCommandError(value, "open")));
      return false;
    }
  }

  async function executeClose() {
    if (!project || busy) return false;
    setOperation("closing");
    setFeedback({ tone: "info", messageKey: "status.closing" });
    try {
      const result: CloseProjectView = await projectCommands.close({ sessionToken: project.sessionToken });
      if (!result.closed) throw new Error("close-not-confirmed");
      setProject(null);
      clearLastOpenProject();
      setRestoreCandidate(null);
      setActiveForm(null);
      editorForm.reset(EDITOR_DEFAULT_VALUES);
      setOpenPanel(false);
      setClosedPanel("empty");
      setOperation("idle");
      setFeedback({ tone: "success", messageKey: "feedback.closed" });
      return true;
    } catch (value) {
      setOperation("idle");
      setFeedback(feedbackFromFailure(asCommandError(value, "close")));
      return false;
    }
  }

  async function executeWindowClose() {
    if (!project) {
      try {
        allowWindowClose.current = true;
        await getCurrentWindow().close();
        return true;
      } catch {
        allowWindowClose.current = false;
        return false;
      }
    }
    const closed = await executeClose();
    if (!closed) return false;
    try {
      allowWindowClose.current = true;
      await getCurrentWindow().close();
      return true;
    } catch {
      allowWindowClose.current = false;
      return false;
    }
  }

  async function refreshAfterStale(form: ActiveForm, failure: CommandError): Promise<SaveResult> {
    if (!project) return { ok: false };
    setOperation("reconciling");
    try {
      const view = await projectCommands.read({ sessionToken: project.sessionToken });
      setProject(view);
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
    if (!project) return { ok: false };
    setOperation("reconciling");
    setFeedback({ tone: "warning", messageKey: "feedback.unknown", code: "outcome-unknown", action: "retry-reconciliation" });
    try {
      const view = await projectCommands.read({ sessionToken: project.sessionToken });
      setProject(view);
      setActiveForm((current) =>
        current && current.kind === form.kind ? { ...current, expectedRevision: view.metadata.metadataRevision } : current,
      );
      if (view.reconciliationState === "committed") {
        editorForm.reset(EDITOR_DEFAULT_VALUES);
        setActiveForm(null);
        setOperation("idle");
        setFeedback({ tone: "success", messageKey: "feedback.committed" });
        return { ok: true, metadata: view.metadata };
      }
      setOperation("idle");
      setFeedback({ tone: "warning", messageKey: "feedback.previous", code: "outcome-unknown", action: "retry-reconciliation" });
      return { ok: false, metadata: view.metadata };
    } catch {
      setOperation("reconciling");
      setFeedback({ tone: "error", messageKey: "feedback.reconcileFailed", code: "outcome-unknown", action: "retry-reconciliation" });
    }
    return { ok: false };
  }

  async function saveForm(form: ActiveForm, value = editorForm.getValues("value")): Promise<SaveResult> {
    if (!project || operation !== "idle") return { ok: false };
    if (!editorForm.formState.isDirty) {
      setActiveForm(null);
      return { ok: true, metadata: project.metadata };
    }

    setOperation("saving");
    setFeedback({ tone: "info", messageKey: "status.saving" });
    try {
      let result: MetadataMutationView;
      if (form.kind === "rename") {
        result = await projectCommands.rename({
          sessionToken: project.sessionToken,
          expectedRevision: form.expectedRevision,
          displayName: value,
        });
      } else {
        const request: AddTargetLocaleRequest = {
          sessionToken: project.sessionToken,
          expectedRevision: form.expectedRevision,
          locale: value,
        };
        result = await projectCommands.addTargetLocale(request);
      }
      setProject((current) => (current ? { ...current, metadata: result.metadata, reconciliationState: "settled" } : current));
      editorForm.reset(EDITOR_DEFAULT_VALUES);
      setActiveForm(null);
      setOperation("idle");
      setFeedback({
        tone: "success",
        messageKey: result.outcome === "unchanged" ? (form.kind === "target" ? "feedback.duplicateTarget" : "feedback.unchanged") : form.kind === "rename" ? "feedback.renamed" : "feedback.targetAdded",
        messageValues: result.outcome === "changed" ? { revision: result.metadata.metadataRevision } : undefined,
      });
      return { ok: true, metadata: result.metadata };
    } catch (value) {
      const failure = asCommandError(value, form.kind === "rename" ? "rename" : "add-target-locale");
      if (failure.code === "stale-revision") return refreshAfterStale(form, failure);
      if (failure.code === "outcome-unknown") return reconcileUnknown(form);
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
        setProject(view);
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
    if (!value) return;
    if (form === "create") {
      const current = parseTargetLocales(createForm.getValues("targetLocales"));
      if (!current.some((locale) => locale.toLowerCase() === value.toLowerCase())) {
        createForm.setValue("targetLocales", [...current, value].join(", "), { shouldDirty: true, shouldValidate: true });
      }
      return;
    }
    editorForm.setValue("value", value, { shouldDirty: true, shouldValidate: true });
  }

  function handleCreateInvalid(errors: FieldErrors<CreateFormValues>) {
    setFeedback(localValidation(firstErrorField(errors as FieldErrors<Record<string, unknown>>) ?? "parentDirectory"));
  }

  function handleEditorInvalid() {
    setFeedback(localValidation(activeForm?.kind === "rename" ? "displayName" : "locale"));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
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
  }, [activeForm, dirty, operation, navigationIntent, restorePromptOpen, closedPanel, createDraftDirty, openPanel]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      void getCurrentWindow()
        .onCloseRequested(async (event) => {
          if (allowWindowClose.current) return;
          event.preventDefault();
          if (disposed) return;
          if (busy) {
            setFeedback({ tone: "warning", messageKey: "status.reconciling" });
            return;
          }
           if (!project && createDraftDirty) {
             requestNavigation({ kind: "window-close" });
             return;
           }
           if (!project) {
             allowWindowClose.current = true;
             await getCurrentWindow().close();
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

  const navItems = navigation(t);
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
    <main className="shell">
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

        <nav className="navigation" aria-label={t("nav.workspace")}>
           {navItems.map((item) => (
             <button
               aria-current={item.selected ? "page" : undefined}
               className={`navigation-item${item.selected ? " is-selected" : ""}`}
               key={item.label}
               type="button"
             >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer" aria-live="polite">
          <span className={`status-dot status-dot-${operation}`} aria-hidden="true" />
          <span>{status}</span>
        </div>
      </aside>

      <section className="workspace" aria-label={t("nav.workspace")}>
        <header className="topbar">
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
          <div className={`workbench-content${project ? " is-project" : " is-closed"}`}>
            {renderFeedback}

            {!project ? (
              <section className="closed-state" aria-live="polite">
                {closedPanel === "empty" ? (
                  <>
                    <p className="eyebrow">{t("empty.title")}</p>
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
                  <form className="form-card" onSubmit={createForm.handleSubmit(executeCreate, handleCreateInvalid)}>
                    <div className="form-heading">
                      <p className="eyebrow">{t("empty.create")}</p>
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
                      <div className="field-grid">
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
                        <label className="field" htmlFor="create-target-locales">
                          <span>{t("create.targetLocales")}</span>
                          <select
                            aria-label={t("create.targetPreset")}
                            defaultValue=""
                            onChange={(event) => {
                              addTargetPreset("create", event.target.value);
                              event.currentTarget.value = "";
                            }}
                          >
                            <option value="">{t("create.choosePreset")}</option>
                            {languagePresets.map((preset) => <option key={preset.value} value={preset.value}>{t(preset.labelKey)}</option>)}
                          </select>
                          <input
                            id="create-target-locales"
                            aria-invalid={Boolean(createForm.formState.errors.targetLocales || fieldError(feedback, "targetLocales"))}
                            placeholder={t("create.targetLocalesPlaceholder")}
                            {...createForm.register("targetLocales", { required: true, validate: (value) => parseTargetLocales(value).length > 0 })}
                          />
                          <small>{t("create.targetLocalesHelp")}</small>
                          {createForm.formState.errors.targetLocales || fieldError(feedback, "targetLocales") ? <span className="field-error">{t("errors.targetLocales")}</span> : null}
                        </label>
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

                <dl className="metadata-grid" aria-label={t("accessibility.metadata")}>
                  <div className="metadata-item">
                    <dt>{t("project.source")}</dt>
                    <dd title={project.metadata.sourceLocale}>{localeLabel(t, project.metadata.sourceLocale)} <span className="locale-code">{project.metadata.sourceLocale}</span></dd>
                  </div>
                  <div className="metadata-item metadata-targets">
                    <dt>{t("project.targets")}</dt>
                    <dd>
                       {project.metadata.targetLocales.length > 0 ? project.metadata.targetLocales.map((target) => <span className="locale-chip" key={target}><span>{localeLabel(t, target)}</span><span className="locale-code">{target}</span></span>) : <span>{t("project.noTargets")}</span>}
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
                  <button className="primary-button" type="button" onClick={() => startEditor("rename")} disabled={busy}>
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
                  <form className="editor-card" onSubmit={editorForm.handleSubmit(({ value }) => handleSave(value), handleEditorInvalid)}>
                    <div className="editor-heading">
                      <div>
                        <p className="eyebrow">{activeForm.kind === "rename" ? t("project.rename") : t("project.addTarget")}</p>
                        <h2>{activeForm.kind === "rename" ? t("editor.renameTitle") : t("editor.targetTitle")}</h2>
                      </div>
                      <span className="basis-label">{t("editor.basis", { revision: activeForm.expectedRevision })}</span>
                    </div>
                    <label className="field" htmlFor="editor-value">
                      <span>{activeForm.kind === "rename" ? t("editor.renameLabel") : t("editor.targetLabel")}</span>
                      {activeForm.kind === "target" ? (
                        <select
                          aria-label={t("editor.targetPreset")}
                          defaultValue=""
                          onChange={(event) => {
                            addTargetPreset("editor", event.target.value);
                            event.currentTarget.value = "";
                          }}
                        >
                          <option value="">{t("create.choosePreset")}</option>
                          {languagePresets.map((preset) => <option key={preset.value} value={preset.value}>{t(preset.labelKey)}</option>)}
                        </select>
                      ) : null}
                      <input
                        id="editor-value"
                        aria-invalid={Boolean(editorForm.formState.errors.value || fieldError(feedback, activeForm.kind === "rename" ? "displayName" : "locale"))}
                        autoFocus
                        disabled={busy}
                        {...editorForm.register("value", { required: true, validate: (value) => Boolean(value.trim()) })}
                      />
                      <small>{activeForm.kind === "rename" ? t("editor.renameHelp") : t("editor.targetHelp")}</small>
                      {editorForm.formState.errors.value || fieldError(feedback, activeForm.kind === "rename" ? "displayName" : "locale") ? <span className="field-error">{t(activeForm.kind === "rename" ? "errors.displayName" : "errors.locale")}</span> : null}
                    </label>
                    <div className="form-actions">
                      <button className="secondary-button" type="button" onClick={cancelEditor} disabled={busy}>{t("editor.cancel")}</button>
                      <button className="primary-button" type="submit" disabled={busy || !dirty}>
                        <Icon name="save" size={17} />
                        {busy ? t("status.saving") : t("editor.save")}
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
            )}
          </div>
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
                {navigationIntent?.kind === "panel"
                  ? t("dialog.createMessage")
                  : navigationIntent?.kind === "close" || navigationIntent?.kind === "window-close"
                  ? t("dialog.closeMessage")
                  : navigationIntent?.kind === "open"
                    ? t("dialog.openMessage")
                    : t("dialog.formMessage")}
              </DialogDescription>
              <p className="dialog-supporting-copy">{createDraftDirty ? t("dialog.createSupporting") : t("dialog.message")}</p>
              {feedback && (feedback.tone === "error" || feedback.tone === "warning") ? (
                <div className={`dialog-feedback feedback-${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
                  <span>{renderFeedbackMessage(t, feedback)}</span>
                  {feedback.action === "refresh" ? <button className="text-button" type="button" onClick={handleRefresh} disabled={busy}>{t("action.refresh")}</button> : null}
                  {feedback.action === "retry-reconciliation" ? <button className="text-button" type="button" onClick={handleRetryReconciliation} disabled={operation !== "idle" && operation !== "reconciling"}>{t("action.retry")}</button> : null}
                </div>
              ) : null}
              <div className="dialog-actions">
                <button ref={cancelDialogButton} className="secondary-button" type="button" onClick={() => void resolveNavigation("cancel")} disabled={busy}>{createDraftDirty ? t("action.keepEditing") : t("action.cancel")}</button>
                <button className="danger-button" type="button" onClick={() => void resolveNavigation("discard")} disabled={busy}>{t("action.discard")}</button>
                {activeForm && !createDraftDirty ? <button className="primary-button" type="button" onClick={() => void resolveNavigation("save")} disabled={busy}>{t("action.saveAndContinue")}</button> : null}
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
    </main>
  );
}

export default App;
