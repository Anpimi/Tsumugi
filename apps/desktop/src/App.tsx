import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { FormEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isLocale, localeOptions, type Locale } from "./i18n";
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

type IconName =
  | "folder"
  | "file"
  | "book"
  | "check"
  | "settings"
  | "folder-open"
  | "plus"
  | "save"
  | "close"
  | "refresh";

const iconPaths: Record<IconName, string> = {
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z",
  "folder-open": "M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v.8l-1.5 6.2a1.5 1.5 0 0 1-1.45 1.15H4.5A1.5 1.5 0 0 1 3 16.15z",
  file: "M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6M9 15.5h6",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 5.5v15M8 7h8M8 10.5h8",
  check: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Zm-3.5 8.7 2.3 2.3 4.8-5",
  settings: "M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7Zm0-5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18.01 5.99l-1.42 1.42M7.41 16.59l-1.42 1.42M18.01 18.01l-1.42-1.42M7.41 7.41 5.99 5.99",
  plus: "M12 5v14M5 12h14",
  save: "M5 4h12l2 2v14H5zM8 4v6h8V4M8 20v-6h8v6",
  close: "M6 6l12 12M18 6 6 18",
  refresh: "M20 11a8 8 0 1 0 1 4M20 5v6h-6",
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={iconPaths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
    </svg>
  );
}

interface CreateFormState {
  destination: string;
  displayName: string;
  sourceLocale: string;
  targetLocales: string;
}

interface ActiveForm {
  kind: FormKind;
  value: string;
  expectedRevision: string;
}

type NavigationIntent =
  | { kind: "close" }
  | { kind: "window-close" }
  | { kind: "open"; locator: string }
  | { kind: "form"; formKind: FormKind };

interface Feedback {
  tone: FeedbackTone;
  message: string;
  code?: CommandErrorCode;
  field?: string;
  action?: "refresh" | "retry-reconciliation";
}

interface SaveResult {
  ok: boolean;
  metadata?: ProjectMetadataView;
}

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

function formIsDirty(form: ActiveForm | null, metadata: ProjectMetadataView | undefined) {
  if (!form || !metadata) return false;
  return form.kind === "rename" ? form.value !== metadata.displayName : form.value.trim().length > 0;
}

function asCommandError(value: unknown, stage: CommandStage): CommandError {
  if (typeof value === "object" && value !== null && "code" in value && "stage" in value) {
    return value as CommandError;
  }
  return { code: "storage-failed", stage, recoveryRequired: false };
}

function failureText(t: TFunction, failure: CommandError) {
  switch (failure.code) {
    case "invalid-input":
      return t("errors.invalidInput");
    case "destination-conflict":
      return t("errors.destinationConflict");
    case "missing-project":
      return t("errors.missingProject");
    case "permission-denied":
      return t("errors.permissionDenied");
    case "unsupported-schema":
      return t("errors.unsupportedSchema");
    case "corrupt-project":
      return t("errors.corruptProject");
    case "stale-revision":
      return t("feedback.stale", { revision: failure.currentRevision ?? "?" });
    case "session-invalid":
      return t("errors.sessionInvalid");
    case "project-in-use":
      return t("errors.projectInUse");
    case "busy":
      return t("errors.busy");
    case "storage-failed":
      return t("errors.storageFailed");
    case "outcome-unknown":
      return t("errors.outcomeUnknown");
    default:
      return t("errors.unknown");
  }
}

function feedbackFromFailure(t: TFunction, failure: CommandError): Feedback {
  const warning = failure.code === "stale-revision" || failure.code === "outcome-unknown";
  return {
    tone: warning ? "warning" : "error",
    message: failureText(t, failure),
    code: failure.code,
    field: failure.field,
    action: failure.code === "outcome-unknown" ? "retry-reconciliation" : undefined,
  };
}

function localValidation(t: TFunction, field: string, value: string): Feedback | null {
  if (value.trim().length > 0) return null;
  return { tone: "error", message: t("errors.invalidInput"), code: "invalid-input", field };
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

function App() {
  const { t, i18n: translation } = useTranslation();
  const resolvedLocale = translation.resolvedLanguage ?? "en-US";
  const locale: Locale = isLocale(resolvedLocale) ? resolvedLocale : "en-US";
  const [project, setProject] = useState<ProjectView | null>(null);
  const [operation, setOperation] = useState<Operation>("idle");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [closedPanel, setClosedPanel] = useState<ClosedPanel>("empty");
  const [openPanel, setOpenPanel] = useState(false);
  const [openLocator, setOpenLocator] = useState("");
  const [createForm, setCreateForm] = useState<CreateFormState>({
    destination: "",
    displayName: "",
    sourceLocale: "en-US",
    targetLocales: "zh-CN",
  });
  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null);
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent | null>(null);
  const allowWindowClose = useRef(false);
  const dirty = useMemo(() => formIsDirty(activeForm, project?.metadata), [activeForm, project]);
  const busy = operation !== "idle";
  const status = statusFor(t, operation, dirty);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem("tsumugi.uiLocale", locale);
    } catch {
      // The UI still works when the host does not expose local storage.
    }
  }, [locale]);

  function clearFeedback() {
    setFeedback(null);
  }

  function startEditor(kind: FormKind, metadata = project?.metadata) {
    if (!metadata || busy) return;
    if (activeForm) {
      if (activeForm.kind === kind) return;
      if (dirty) {
        setNavigationIntent({ kind: "form", formKind: kind });
        return;
      }
    }
    clearFeedback();
    setActiveForm({
      kind,
      value: kind === "rename" ? metadata.displayName : "",
      expectedRevision: metadata.metadataRevision,
    });
  }

  async function executeCreate() {
    const destinationError = localValidation(t, "destination", createForm.destination);
    if (destinationError) return setFeedback(destinationError);
    const displayNameError = localValidation(t, "displayName", createForm.displayName);
    if (displayNameError) return setFeedback(displayNameError);
    const sourceError = localValidation(t, "sourceLocale", createForm.sourceLocale);
    if (sourceError) return setFeedback(sourceError);
    const targetLocales = parseTargetLocales(createForm.targetLocales);
    if (targetLocales.length === 0) {
      return setFeedback({ tone: "error", message: t("errors.invalidInput"), code: "invalid-input", field: "targetLocales" });
    }

    setOperation("opening");
    setFeedback({ tone: "info", message: t("status.opening") });
    try {
      const request: CreateProjectRequest = {
        destination: createForm.destination,
        displayName: createForm.displayName,
        sourceLocale: createForm.sourceLocale,
        targetLocales,
      };
      const view = await projectCommands.create(request);
      setProject(view);
      setActiveForm(null);
      setClosedPanel("empty");
      setOperation("idle");
      setFeedback({ tone: "success", message: t("feedback.created") });
    } catch (value) {
      setOperation("idle");
      setFeedback(feedbackFromFailure(t, asCommandError(value, "create")));
    }
  }

  async function executeOpen(locator: string) {
    const locatorError = localValidation(t, "locator", locator);
    if (locatorError) {
      setFeedback(locatorError);
      return false;
    }

    setOperation("opening");
    setFeedback({ tone: "info", message: t("status.opening") });
    try {
      const view = await projectCommands.open({ locator });
      setProject(view);
      setActiveForm(null);
      setOpenPanel(false);
      setOpenLocator("");
      setClosedPanel("empty");
      setOperation("idle");
      setFeedback({ tone: "success", message: t("feedback.opened") });
      return true;
    } catch (value) {
      setOperation("idle");
      setFeedback(feedbackFromFailure(t, asCommandError(value, "open")));
      return false;
    }
  }

  async function executeClose() {
    if (!project || busy) return false;
    setOperation("closing");
    setFeedback({ tone: "info", message: t("status.closing") });
    try {
      const result: CloseProjectView = await projectCommands.close({ sessionToken: project.sessionToken });
      if (!result.closed) throw new Error("close-not-confirmed");
      setProject(null);
      setActiveForm(null);
      setOpenPanel(false);
      setClosedPanel("empty");
      setOperation("idle");
      setFeedback({ tone: "success", message: t("feedback.closed") });
      return true;
    } catch (value) {
      setOperation("idle");
      setFeedback(feedbackFromFailure(t, asCommandError(value, "close")));
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
        message: t("feedback.stale", { revision: failure.currentRevision ?? view.metadata.metadataRevision }),
        code: "stale-revision",
      });
    } catch {
      setOperation("idle");
      setFeedback({ tone: "error", message: t("feedback.staleRefreshFailed"), code: "storage-failed", action: "refresh" });
    }
    return { ok: false };
  }

  async function reconcileUnknown(form: ActiveForm): Promise<SaveResult> {
    if (!project) return { ok: false };
    setOperation("reconciling");
    setFeedback({ tone: "warning", message: t("feedback.unknown"), code: "outcome-unknown", action: "retry-reconciliation" });
    try {
      const view = await projectCommands.read({ sessionToken: project.sessionToken });
      setProject(view);
      setActiveForm((current) =>
        current && current.kind === form.kind ? { ...current, expectedRevision: view.metadata.metadataRevision } : current,
      );
      if (view.reconciliationState === "committed") {
        setActiveForm(null);
        setOperation("idle");
        setFeedback({ tone: "success", message: t("feedback.committed") });
        return { ok: true, metadata: view.metadata };
      }
      if (view.reconciliationState === "previous" || view.reconciliationState === "settled") {
        setOperation("idle");
        setFeedback({ tone: "warning", message: t("feedback.previous"), code: "outcome-unknown" });
        return { ok: false, metadata: view.metadata };
      }
    } catch {
      setOperation("reconciling");
      setFeedback({ tone: "error", message: t("feedback.reconcileFailed"), code: "outcome-unknown", action: "retry-reconciliation" });
    }
    return { ok: false };
  }

  async function saveForm(form: ActiveForm): Promise<SaveResult> {
    if (!project || operation !== "idle") return { ok: false };
    if (!formIsDirty(form, project.metadata)) {
      setActiveForm(null);
      return { ok: true, metadata: project.metadata };
    }

    setOperation("saving");
    setFeedback({ tone: "info", message: t("status.saving") });
    try {
      let result: MetadataMutationView;
      if (form.kind === "rename") {
        result = await projectCommands.rename({
          sessionToken: project.sessionToken,
          expectedRevision: form.expectedRevision,
          displayName: form.value,
        });
      } else {
        const request: AddTargetLocaleRequest = {
          sessionToken: project.sessionToken,
          expectedRevision: form.expectedRevision,
          locale: form.value,
        };
        result = await projectCommands.addTargetLocale(request);
      }
      setProject((current) => (current ? { ...current, metadata: result.metadata, reconciliationState: "settled" } : current));
      setActiveForm(null);
      setOperation("idle");
      setFeedback({
        tone: "success",
        message:
          result.outcome === "unchanged"
            ? t("feedback.unchanged")
            : t(form.kind === "rename" ? "feedback.renamed" : "feedback.targetAdded", {
                revision: result.metadata.metadataRevision,
              }),
      });
      return { ok: true, metadata: result.metadata };
    } catch (value) {
      const failure = asCommandError(value, form.kind === "rename" ? "rename" : "add-target-locale");
      if (failure.code === "stale-revision") return refreshAfterStale(form, failure);
      if (failure.code === "outcome-unknown") return reconcileUnknown(form);
      setOperation("idle");
      setFeedback(feedbackFromFailure(t, failure));
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
    startEditor(intent.formKind, metadata);
  }

  async function resolveNavigation(choice: "save" | "discard" | "cancel") {
    if (!navigationIntent) return;
    if (choice === "cancel") {
      setNavigationIntent(null);
      return;
    }
    const intent = navigationIntent;
    if (choice === "discard") {
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
    const result = await saveForm(activeForm);
    if (!result.ok) return;
    setNavigationIntent(null);
    setFeedback({ tone: "success", message: t("feedback.savedBeforeContinue") });
    await continueNavigation(intent, result.metadata);
  }

  function handleCloseRequest() {
    if (!project || busy) return;
    if (dirty) {
      setNavigationIntent({ kind: "close" });
      return;
    }
    void executeClose();
  }

  function handleOpenSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const locator = openLocator;
    const locatorError = localValidation(t, "locator", locator);
    if (locatorError) {
      setFeedback(locatorError);
      return;
    }
    if (dirty) {
      setNavigationIntent({ kind: "open", locator });
      return;
    }
    void executeOpen(locator);
  }

  function handleSave() {
    if (activeForm && !busy) void saveForm(activeForm);
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
        setFeedback({ tone: "info", message: t("feedback.opened") });
      })
      .catch((value) => {
        setOperation("idle");
        setFeedback(feedbackFromFailure(t, asCommandError(value, "read")));
      });
  }

  function handleRetryReconciliation() {
    if (activeForm && project && operation === "reconciling") void reconcileUnknown(activeForm);
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
            setFeedback({ tone: "warning", message: t("status.reconciling") });
            return;
          }
          if (!project) {
            allowWindowClose.current = true;
            await getCurrentWindow().close();
            return;
          }
          if (dirty) {
            setNavigationIntent({ kind: "window-close" });
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
  }, [busy, dirty, project, locale]);

  const navItems = navigation(t);
  const renderFeedback = feedback ? (
    <div className={`feedback feedback-${feedback.tone}`} aria-live="polite" role={feedback.tone === "error" ? "alert" : "status"}>
      <div className="feedback-copy">
        <strong>{feedback.tone === "success" ? "✓" : feedback.tone === "warning" ? "!" : "·"}</strong>
        <span>{feedback.message}</span>
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
                    <div className="empty-state-icon" aria-hidden="true">
                      <Icon name="folder-open" size={54} />
                    </div>
                    <p className="eyebrow">Tsumugi</p>
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
                  <form className="form-card" onSubmit={(event) => { event.preventDefault(); void executeCreate(); }}>
                    <div className="form-heading">
                      <p className="eyebrow">{t("empty.create")}</p>
                      <h1>{t("create.title")}</h1>
                      <p>{t("create.intro")}</p>
                    </div>
                    <div className="form-fields">
                      <label className="field">
                        <span>{t("create.destination")}</span>
                        <input
                          aria-invalid={fieldError(feedback, "destination")}
                          autoFocus
                          placeholder={t("create.destinationPlaceholder")}
                          value={createForm.destination}
                          onChange={(event) => setCreateForm((current) => ({ ...current, destination: event.target.value }))}
                        />
                        <small>{t("create.destinationHelp")}</small>
                      </label>
                      <label className="field">
                        <span>{t("create.displayName")}</span>
                        <input
                          aria-invalid={fieldError(feedback, "displayName")}
                          placeholder={t("create.displayNamePlaceholder")}
                          value={createForm.displayName}
                          onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))}
                        />
                      </label>
                      <div className="field-grid">
                        <label className="field">
                          <span>{t("create.sourceLocale")}</span>
                          <input
                            aria-invalid={fieldError(feedback, "sourceLocale")}
                            placeholder={t("create.sourceLocalePlaceholder")}
                            value={createForm.sourceLocale}
                            onChange={(event) => setCreateForm((current) => ({ ...current, sourceLocale: event.target.value }))}
                          />
                        </label>
                        <label className="field">
                          <span>{t("create.targetLocales")}</span>
                          <input
                            aria-invalid={fieldError(feedback, "targetLocales")}
                            placeholder={t("create.targetLocalesPlaceholder")}
                            value={createForm.targetLocales}
                            onChange={(event) => setCreateForm((current) => ({ ...current, targetLocales: event.target.value }))}
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
                    <label className="field">
                      <span>{t("open.destination")}</span>
                      <input
                        aria-invalid={fieldError(feedback, "locator")}
                        autoFocus
                        placeholder={t("open.destinationPlaceholder")}
                        value={openLocator}
                        onChange={(event) => setOpenLocator(event.target.value)}
                      />
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
                      <label className="field field-grow">
                        <span>{t("open.destination")}</span>
                        <input
                          aria-invalid={fieldError(feedback, "locator")}
                          autoFocus
                          placeholder={t("open.destinationPlaceholder")}
                          value={openLocator}
                          onChange={(event) => setOpenLocator(event.target.value)}
                        />
                      </label>
                      <button className="primary-button" type="submit" disabled={busy}>{t("open.submit")}</button>
                      <button className="secondary-button" type="button" onClick={() => setOpenPanel(false)} disabled={busy}>{t("action.cancel")}</button>
                    </div>
                  </form>
                ) : null}

                {activeForm ? (
                  <form className="editor-card" onSubmit={(event) => { event.preventDefault(); handleSave(); }}>
                    <div className="editor-heading">
                      <div>
                        <p className="eyebrow">{activeForm.kind === "rename" ? t("project.rename") : t("project.addTarget")}</p>
                        <h2>{activeForm.kind === "rename" ? t("editor.renameTitle") : t("editor.targetTitle")}</h2>
                      </div>
                      <span className="basis-label">{t("editor.basis", { revision: activeForm.expectedRevision })}</span>
                    </div>
                    <label className="field">
                      <span>{activeForm.kind === "rename" ? t("editor.renameLabel") : t("editor.targetLabel")}</span>
                      <input
                        aria-invalid={fieldError(feedback, activeForm.kind === "rename" ? "displayName" : "locale")}
                        autoFocus
                        value={activeForm.value}
                        onChange={(event) => setActiveForm((current) => current ? { ...current, value: event.target.value } : current)}
                      />
                      <small>{activeForm.kind === "rename" ? t("editor.renameHelp") : t("editor.targetHelp")}</small>
                    </label>
                    <div className="form-actions">
                      <button className="secondary-button" type="button" onClick={() => { setActiveForm(null); clearFeedback(); }} disabled={busy}>{t("editor.cancel")}</button>
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

        {navigationIntent ? (
          <div className="dialog-backdrop">
            <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="unsaved-dialog-title">
              <p className="eyebrow">{t("status.unsaved")}</p>
              <h2 id="unsaved-dialog-title">{t("dialog.title")}</h2>
              <p>{navigationIntent.kind === "close" || navigationIntent.kind === "window-close" ? t("dialog.closeMessage") : navigationIntent.kind === "open" ? t("dialog.openMessage") : t("dialog.formMessage")}</p>
              <p className="dialog-supporting-copy">{t("dialog.message")}</p>
              <div className="dialog-actions">
                <button className="secondary-button" type="button" onClick={() => void resolveNavigation("cancel")} disabled={busy}>{t("action.cancel")}</button>
                <button className="danger-button" type="button" onClick={() => void resolveNavigation("discard")} disabled={busy}>{t("action.discard")}</button>
                <button className="primary-button" type="button" onClick={() => void resolveNavigation("save")} disabled={busy}>{t("action.saveAndContinue")}</button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default App;
