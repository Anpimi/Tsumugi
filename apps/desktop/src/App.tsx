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
  BookOpen,
  CircleCheck,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Settings,
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
  file: FileText,
  book: BookOpen,
  check: CircleCheck,
  settings: Settings,
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
  | { kind: "form"; formKind: FormKind };

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
  targetLocales: "zh-CN",
};

const OPEN_DEFAULT_VALUES: OpenFormValues = { locator: "" };
const EDITOR_DEFAULT_VALUES: EditorFormValues = { value: "" };

const navigation = (t: TFunction) => [
  { label: t("nav.workspace"), icon: "folder" as const, selected: true },
  { label: t("nav.translations"), icon: "file" as const, selected: false },
  { label: t("nav.glossary"), icon: "book" as const, selected: false },
  { label: t("nav.quality"), icon: "check" as const, selected: false },
  { label: t("nav.settings"), icon: "settings" as const, selected: false },
];

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
    messageKey: failureMessageKey(failure),
    messageValues: failure.code === "stale-revision" ? { revision: failure.currentRevision ?? "?" } : undefined,
    code: failure.code,
    field: failure.field,
    action: failure.code === "outcome-unknown" ? "retry-reconciliation" : undefined,
  };
}

function localValidation(field: string): Feedback {
  return { tone: "error", messageKey: "errors.invalidInput", code: "invalid-input", field };
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
  const allowWindowClose = useRef(false);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  const cancelDialogButton = useRef<HTMLButtonElement | null>(null);
  const createForm = useForm<CreateFormValues>({ defaultValues: CREATE_DEFAULT_VALUES });
  const openForm = useForm<OpenFormValues>({ defaultValues: OPEN_DEFAULT_VALUES });
  const editorForm = useForm<EditorFormValues>({ defaultValues: EDITOR_DEFAULT_VALUES });
  const dirty = Boolean(activeForm && editorForm.formState.isDirty);
  const busy = operation !== "idle";
  const status = statusFor(t, operation, dirty);

  useEffect(() => {
    document.documentElement.lang = resolvedLanguage;
  }, [resolvedLanguage]);

  function clearFeedback() {
    setFeedback(null);
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
      setActiveForm(null);
      setClosedPanel("empty");
      setOperation("idle");
      createForm.reset(CREATE_DEFAULT_VALUES);
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

    setOperation("opening");
    setFeedback({ tone: "info", messageKey: "status.opening" });
    try {
      const view = await projectCommands.open({ locator });
      setProject(view);
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
    const closed = await executeClose();
    if (!closed) return;
    try {
      allowWindowClose.current = true;
      await getCurrentWindow().close();
    } catch {
      allowWindowClose.current = false;
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
      setFeedback({ tone: "warning", messageKey: "feedback.previous", code: "outcome-unknown" });
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
        messageKey: result.outcome === "unchanged" ? "feedback.unchanged" : form.kind === "rename" ? "feedback.renamed" : "feedback.targetAdded",
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
      editorForm.reset(EDITOR_DEFAULT_VALUES);
      setActiveForm(null);
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
      if (dirty) {
        requestNavigation({ kind: "open", locator });
        return;
      }
      void executeOpen(locator);
    }, () => setFeedback(localValidation("locator")))();
  }

  function handleSave(value = editorForm.getValues("value")) {
    if (activeForm && !busy) void saveForm(activeForm, value);
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
    if (activeForm && project && operation === "reconciling") void reconcileUnknown(activeForm);
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

  function handleCreateInvalid(errors: FieldErrors<CreateFormValues>) {
    setFeedback(localValidation(firstErrorField(errors as FieldErrors<Record<string, unknown>>) ?? "parentDirectory"));
  }

  function handleEditorInvalid() {
    setFeedback(localValidation(activeForm?.kind === "rename" ? "displayName" : "locale"));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && activeForm && dirty && operation === "idle") {
        event.preventDefault();
        handleSave();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeForm, dirty, operation]);

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
  }, [busy, dirty, project, resolvedLanguage]);

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
          <button className="text-button" type="button" onClick={handleRetryReconciliation} disabled={operation !== "reconciling"}>
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
              disabled={!item.selected}
              key={item.label}
              title={item.selected ? undefined : t("future", { label: item.label })}
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
          <nav className="menu-bar" aria-label={t("menu.file")}>
            <button type="button" disabled>{t("menu.file")}</button>
            <button type="button" disabled>{t("menu.edit")}</button>
            <button type="button" disabled>{t("menu.view")}</button>
            <button type="button" disabled>{t("menu.help")}</button>
          </nav>
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
            <button className="settings-link" type="button" disabled title={t("future", { label: t("nav.settings") })}>
              <Icon name="settings" size={18} />
              <span>{t("nav.settings")}</span>
            </button>
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
                  </>
                ) : closedPanel === "create" ? (
                  <form className="form-card" onSubmit={createForm.handleSubmit(executeCreate, handleCreateInvalid)}>
                    <div className="form-heading">
                      <p className="eyebrow">{t("empty.create")}</p>
                      <h1>{t("create.title")}</h1>
                      <p>{t("create.intro")}</p>
                    </div>
                    <div className="form-fields">
                      <label className="field" htmlFor="create-parent-directory">
                        <span>{t("create.parentDirectory")}</span>
                        <div className="field-picker">
                          <input
                            id="create-parent-directory"
                            aria-invalid={Boolean(createForm.formState.errors.parentDirectory || fieldError(feedback, "parentDirectory"))}
                            placeholder={t("create.parentDirectoryPlaceholder")}
                            {...createForm.register("parentDirectory", { required: true })}
                          />
                          <button className="secondary-button" type="button" onClick={() => void chooseDirectory("create")} disabled={busy}>
                            <Icon name="folder-open" size={16} />
                            {t("create.chooseFolder")}
                          </button>
                        </div>
                        <small>{t("create.parentDirectoryHelp")}</small>
                      </label>
                      <label className="field" htmlFor="create-directory-name">
                        <span>{t("create.directoryName")}</span>
                        <input
                          id="create-directory-name"
                          aria-invalid={Boolean(createForm.formState.errors.directoryName || fieldError(feedback, "directoryName"))}
                          placeholder={t("create.directoryNamePlaceholder")}
                          {...createForm.register("directoryName", { required: true })}
                        />
                      </label>
                      <label className="field" htmlFor="create-display-name">
                        <span>{t("create.displayName")}</span>
                        <input
                          id="create-display-name"
                          aria-invalid={Boolean(createForm.formState.errors.displayName || fieldError(feedback, "displayName"))}
                          placeholder={t("create.displayNamePlaceholder")}
                          {...createForm.register("displayName", { required: true })}
                        />
                      </label>
                      <div className="field-grid">
                        <label className="field" htmlFor="create-source-locale">
                          <span>{t("create.sourceLocale")}</span>
                          <input
                            id="create-source-locale"
                            aria-invalid={Boolean(createForm.formState.errors.sourceLocale || fieldError(feedback, "sourceLocale"))}
                            placeholder={t("create.sourceLocalePlaceholder")}
                            {...createForm.register("sourceLocale", { required: true })}
                          />
                        </label>
                        <label className="field" htmlFor="create-target-locales">
                          <span>{t("create.targetLocales")}</span>
                          <input
                            id="create-target-locales"
                            aria-invalid={Boolean(createForm.formState.errors.targetLocales || fieldError(feedback, "targetLocales"))}
                            placeholder={t("create.targetLocalesPlaceholder")}
                            {...createForm.register("targetLocales", { required: true })}
                          />
                        </label>
                      </div>
                      <small className="form-wide-help">{t("create.targetLocalesHelp")}</small>
                    </div>
                    <div className="form-actions">
                      <button className="secondary-button" type="button" onClick={() => { clearFeedback(); setClosedPanel("empty"); }} disabled={busy}>
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
                    <p className="project-identity">{t("project.identity")}: {project.metadata.projectId}</p>
                  </div>
                  <span className={`status-badge status-badge-${operation}`}>
                    <span className="status-dot" aria-hidden="true" />
                    {status}
                  </span>
                </div>

                <dl className="metadata-grid" aria-label={t("accessibility.metadata")}>
                  <div className="metadata-item">
                    <dt>{t("project.source")}</dt>
                    <dd>{project.metadata.sourceLocale}</dd>
                  </div>
                  <div className="metadata-item metadata-targets">
                    <dt>{t("project.targets")}</dt>
                    <dd>
                      {project.metadata.targetLocales.length > 0 ? project.metadata.targetLocales.map((target) => <span className="locale-chip" key={target}>{target}</span>) : <span>{t("project.noTargets")}</span>}
                    </dd>
                  </div>
                  <div className="metadata-item">
                    <dt>{t("project.revision")}</dt>
                    <dd>{project.metadata.metadataRevision}</dd>
                  </div>
                </dl>

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
                      <input
                        id="editor-value"
                        aria-invalid={Boolean(editorForm.formState.errors.value || fieldError(feedback, activeForm.kind === "rename" ? "displayName" : "locale"))}
                        autoFocus
                        {...editorForm.register("value", { required: true })}
                      />
                      <small>{activeForm.kind === "rename" ? t("editor.renameHelp") : t("editor.targetHelp")}</small>
                    </label>
                    <div className="form-actions">
                      <button className="secondary-button" type="button" onClick={() => { editorForm.reset(EDITOR_DEFAULT_VALUES); setActiveForm(null); clearFeedback(); }} disabled={busy}>{t("editor.cancel")}</button>
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
              onEscapeKeyDown={(event) => {
                if (busy) event.preventDefault();
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
              <p className="eyebrow">{t("status.unsaved")}</p>
              <DialogTitle>{t("dialog.title")}</DialogTitle>
              <DialogDescription>
                {navigationIntent?.kind === "close" || navigationIntent?.kind === "window-close"
                  ? t("dialog.closeMessage")
                  : navigationIntent?.kind === "open"
                    ? t("dialog.openMessage")
                    : t("dialog.formMessage")}
              </DialogDescription>
              <p className="dialog-supporting-copy">{t("dialog.message")}</p>
              <div className="dialog-actions">
                <button ref={cancelDialogButton} className="secondary-button" type="button" onClick={() => void resolveNavigation("cancel")} disabled={busy}>{t("action.cancel")}</button>
                <button className="danger-button" type="button" onClick={() => void resolveNavigation("discard")} disabled={busy}>{t("action.discard")}</button>
                <button className="primary-button" type="button" onClick={() => void resolveNavigation("save")} disabled={busy}>{t("action.saveAndContinue")}</button>
              </div>
            </DialogContent>
          </DialogPortal>
        </DialogRoot>
      </section>
    </main>
  );
}

export default App;
