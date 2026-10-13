import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { createRef, useLayoutEffect, useRef } from "react";
import { ResourceWorkbench, type ResourceHandle } from "./ResourceWorkbench";
import { toolQueryInventory, toolQueryPackage, toolQueryView } from "./testSupport/pluginToolFixture";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationWorkbench, type TranslationHandle } from "./TranslationWorkbench";
import type { ProjectView } from "./projectCommands";
import type { TranslationHistory, TranslationPreview } from "./translationCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { translationActionFixture, translationAttemptFixture, translationReceiptFixture, translationRecoveryUnit } from "./testSupport/translationFixture";
import type { TranslationAdoptRequest } from "./translationCommands";
import { reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture } from "./testSupport/reviewFixture";
import { translationCapture, translationSelection, translationView, translationInventory, translationPackage, translationCheck, translationProjection } from "./testSupport/pluginTranslationFixture";
import type { AttemptDetail } from "./executionCommands";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import errorFixture from "../test/fixtures/commandErrors.contract.json";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { useSessionReads } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import type { ReviewSummaryPage } from "./reviewCommands";
import { useWorkbenchCommands, type WorkbenchCommands } from "./workbenchCommands";
import { useWorkspaceView } from "./WorkbenchFrame";

function CommandsProbe({ capture }: { capture: (commands: WorkbenchCommands) => void }) {
  const commands = useWorkbenchCommands();
  useLayoutEffect(() => { capture(commands); }, [commands, capture]);
  return null;
}

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: fixtureIdentity(900), displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const content = sourcePageFixture({ snapshotId: fixtureIdentity(200), attemptId: fixtureIdentity(201), resultId: fixtureIdentity(202), scope: { revision: "2", currentSnapshot: fixtureIdentity(200) }, confirmation: { ...sourcePageFixture().confirmation, resultDigest: "digest", identityPolicy: "native-key", expectedContentRevision: "1", sourceLanguage: "en" }, namespace: "Example.Mod", coverage: [], total: 1, nextOrdinal: null, diagnostics: [], rows: [sourceRowFixture({ occurrenceId: fixtureIdentity(203), unitId: fixtureIdentity(204), sourceRevisionId: fixtureIdentity(205) }, { ordinal: 0, artifactId: fixtureIdentity(206), namespace: "Example.Mod", key: "first", text: "Original", source: { artifactId: fixtureIdentity(206), range: { encoding: "utf8-byte", start: 9, end: 19 } } })] });
const preview: TranslationPreview = { attemptId: fixtureIdentity(210), bundleId: fixtureIdentity(211), fixedSourceSnapshotId: fixtureIdentity(200), currentSourceSnapshotId: fixtureIdentity(200), resultDigest: "all-results", fileDigest: "file-digest", logicalPath: "i18n/zh.json", declaredLocale: "zh", targetLocale: "zh-CN", basis: "basis", total: 1, unique: 1, unmatched: 0, ambiguous: 0, selectedConflicts: 0, sourceChanged: 0, applied: 0, nextOrdinal: null, rows: [{ entry: { ordinal: 0, artifactId: fixtureIdentity(212), nativeKey: "FIRST", text: "你好", keyByteRange: [1, 8], valueByteRange: [9, 19] }, itemId: fixtureIdentity(213), resultId: fixtureIdentity(214), resultDigest: "result-digest", unitId: fixtureIdentity(204), occurrenceId: fixtureIdentity(203), sourceRevisionId: fixtureIdentity(205), sourceText: "Original", currentSelection: null, currentText: null, status: "unique" }] };
const emptyHistory: TranslationHistory = { unitId: fixtureIdentity(204), locale: "zh-CN", total: "0", current: null, currentText: null, rows: [], nextOrdinal: null };
let history: TranslationHistory;
let pluginAttempts: Map<string, AttemptDetail>;
let applied: boolean;
let conflicting: boolean;
let identity: number;
let importActions: Map<string, TranslationAdoptRequest>;
let savedActions: Map<string, ReturnType<typeof saveReceipt>>;
let protection: Map<string, { unitId: string; locale: string; revision: string; protected: boolean }>;
let protectionActions: Map<string, { unitId: string; locale: string; revision: string; protected: boolean }>;
function saveReceipt(request: Record<string, unknown>) {
  const prior = history.current?.unitId === request.unitId ? history.current : null;
  const sequence = (BigInt(prior?.sequence ?? "0") + 1n).toString();
  const actionId = String(request.actionId), unitId = String(request.unitId), locale = String(request.locale);
  const selection = { eventId: fixtureIdentity(600 + Number(sequence)), unitId, locale, sequence,
    revisionId: fixtureIdentity(700 + Number(sequence)), actionId, previousEventId: typeof request.expectedSelectionId === "string" ? request.expectedSelectionId : null };
  const revision = { revisionId: selection.revisionId, unitId, locale, ordinal: sequence, text: String(request.text),
    sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: String(request.sourceRevisionId), originKind: "manual" as const,
    actionId, contributors: [], attemptId: null, resultId: null, itemId: null, artifactId: null,
    logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null };
  return { projectId: String(request.projectId), actionId, selection, revision,
    basis: { sourceSnapshotId: revision.sourceSnapshotId, sourceRevisionId: revision.sourceRevisionId, selectionId: selection.eventId } };
}
function seedSelectedTranslation(text = "Saved base") {
  const receipt = saveReceipt({ projectId: project.metadata.projectId, actionId: fixtureIdentity(601),
    unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), expectedSelectionId: null, text });
  history = { ...emptyHistory, total: receipt.revision.ordinal, current: receipt.selection,
    currentText: receipt.revision.text, rows: [receipt.revision] };
  return receipt;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset(); history = emptyHistory; applied = false; conflicting = false; identity = 0; savedActions = new Map(); importActions = new Map();
  listen.mockReset().mockResolvedValue(() => {});
  protection = new Map(); protectionActions = new Map(); pluginAttempts = new Map();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(200) };
    if (command === "read_source_content") return content;
    if (command === "read_review_summary_page") return reviewSummaryPageFixture(content.rows.map(row => reviewSummaryFor(reviewTargetFixture({ unitId: row.unitId!, locale: String(args.request.locale), nativeKey: row.occurrence.key, sourceText: row.occurrence.text, sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: row.sourceRevisionId!, selectionId: history.locale === args.request.locale ? history.current?.eventId ?? null : null, revisionId: history.locale === args.request.locale ? history.current?.revisionId ?? null : null, translationText: history.locale === args.request.locale ? history.currentText : null, basis: "basis" }))));
    if (command === "read_review_target") return reviewTargetFixture({ unitId: fixtureIdentity(204), nativeKey: "first", sourceText: "Original", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205), selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText, basis: "basis" });
    if (command === "read_review_editor_snapshot") {
      const scoped = history.unitId === args.request.unitId && history.locale === args.request.locale ? history
        : { ...emptyHistory, unitId: String(args.request.unitId), locale: String(args.request.locale) };
      return {
      target: reviewTargetFixture({ locale: String(args.request.locale), unitId: String(args.request.unitId), nativeKey: args.request.unitId === fixtureIdentity(217) ? "second" : "first", sourceText: "Original", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205), selectionId: scoped.current?.eventId ?? null, revisionId: scoped.current?.revisionId ?? null, translationText: scoped.currentText, basis: "basis" }),
      translations: scoped,
      terms: { unitId: args.request.unitId, locale: String(args.request.locale), sourceRevisionId: fixtureIdentity(205), entries: [{ source: "Original", selected: { revisionId: fixtureIdentity(224), termId: "term", locale: String(args.request.locale), source: "Original", aliases: [], target: "原文", protected: false, scopeUnitId: null, reason: "Project terminology", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false }, conflicting: [] }] },
      context: { revisionId: fixtureIdentity(225), unitId: args.request.unitId, locale: String(args.request.locale), text: "Used in the opening screen", reason: "Translator note", previousRevisionId: null },
      readVersion: "view",
    }; }
    if (command === "read_review_neighbor") return { unitId: fixtureIdentity(217), afterOrdinal: 1, sourceSnapshotId: fixtureIdentity(200) };
    if (command === "read_translation_history") return history.unitId === args.request.unitId && history.locale === args.request.locale ? history
      : { ...emptyHistory, unitId: String(args.request.unitId), locale: String(args.request.locale) };
    if (command === "read_work_protection") return protection.get(`${args.request.unitId}:${args.request.locale}`)
      ?? { unitId: args.request.unitId, locale: args.request.locale, revision: "1", protected: true };
    if (command === "set_work_protection") {
      const action = String(args.request.actionId), scope = `${args.request.unitId}:${args.request.locale}`;
      if (protectionActions.has(action)) return protectionActions.get(action);
      const current = protection.get(scope);
      if ((current?.revision ?? "1") !== args.request.expectedRevision) throw errorFixture.errors[1];
      const next = { unitId: String(args.request.unitId), locale: String(args.request.locale),
        revision: (BigInt(String(args.request.expectedRevision)) + 1n).toString(), protected: args.request.protected === true };
      protection.set(scope, next); protectionActions.set(action, next); return next;
    }
    if (command === "resolve_terms") return { unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), entries: [{ source: "Original", selected: { revisionId: fixtureIdentity(224), termId: "term", locale: "zh-CN", source: "Original", aliases: [], target: "原文", protected: false, scopeUnitId: null, reason: "Project terminology", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false }, conflicting: [] }] };
    if (command === "read_context_revision") return { revisionId: fixtureIdentity(225), unitId: fixtureIdentity(204), locale: "zh-CN", text: "Used in the opening screen", reason: "Translator note", previousRevisionId: null };
    if (command === "read_plugin_inventory") return translationInventory;
    if (command === "read_plugin_package") return translationPackage;
    if (command === "read_plugin_translation") return translationView;
    const source = { ...translationCapture.source, sourceSnapshotId: fixtureIdentity(200) };
    if (command === "read_plugin_translation_source") return source;
    if (command === "select_plugin_translation") return { ...translationSelection, source };
    if (command === "list_plugin_translation_files") return ["zh.json"];
    if (command === "preflight_plugin_translation") return { ...translationCapture, source, attemptId: args.request.attemptId };
    if (command === "create_execution_identity") return fixtureIdentity(++identity);
    if (command === "start_plugin_translation" || command === "start_translation_check" || command === "start_translation_projection") {
      const attemptId = String(args.request.attemptId), operation = command === "start_plugin_translation" ? "translation-extract" : command === "start_translation_check" ? "translation-semantic-check" : "translation-import";
      pluginAttempts.set(attemptId, { ...executionFixture.detail, attemptId, taskId: fixtureIdentity(230 + identity), operation,
        progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
        items: [{ scope: { kind: "translation-file", id: "i18n/zh.json", locale: "zh-CN" }, resultId: fixtureIdentity(240 + identity),
          status: { itemId: fixtureIdentity(250 + identity), execution: "succeeded", validation: "pending", adoption: "unapplied", retrySafe: false, cancellationRequested: false, diagnostic: null } }],
        recovery: { attemptId, units: [] }, nextOffset: null });
      return attemptId;
    }
    if (command === "read_execution_attempt") { const value = pluginAttempts.get(String(args.request.attemptId)); return value?.operation === "translation-import" ? translationAttemptFixture({ ...preview, attemptId: value.attemptId }) : structuredClone(value ?? null); }
    if (command === "prepare_translation_check") return { ...translationCheck, source, translation: translationView, attemptId: args.request.attemptId, translationAttemptId: args.request.translationAttemptId, translationResultId: args.request.translationResultId };
    if (command === "finish_translation_check") { pluginAttempts.get(String(args.request.translationAttemptId))!.items[0].status.validation = "valid"; return null; }
    if (command === "prepare_translation_projection") return { ...translationProjection, source, itemCount: 1, attemptId: args.request.attemptId, translationAttemptId: args.request.translationAttemptId, translationResultId: args.request.translationResultId };
    if (command === "read_translation_preview") { const result = applied ? { ...preview, unique: 0, applied: 1, rows: [{ ...preview.rows[0], status: "applied" as const }] } : conflicting ? { ...preview, unique: 0, selectedConflicts: 1, rows: [{ ...preview.rows[0], status: "selected-conflict" as const, currentText: "旧译文", currentSelection: { eventId: fixtureIdentity(221), unitId: fixtureIdentity(204), locale: "zh-CN", sequence: "1", revisionId: fixtureIdentity(222), actionId: fixtureIdentity(223), previousEventId: null } }] } : preview; return { ...result, attemptId: String(args.request.attemptId) }; }
    if (command === "prepare_translation_adoption") { const request = args.request as unknown as TranslationAdoptRequest; importActions.set(request.actionId, request); return translationActionFixture(request, translationRecoveryUnit(preview.rows[0])); }
    if (command === "adopt_execution") { applied = true; const request = importActions.get(String(args.request.actionId))!; return translationReceiptFixture(request, translationRecoveryUnit(preview.rows[0]), request.confirmation.expectedSelectionId ? "1" : null); }
    if (command === "save_translation_revision") {
      const existing = savedActions.get(String(args.request.actionId));
      if (existing) return existing;
      const receipt = saveReceipt(args.request);
      savedActions.set(receipt.actionId, receipt);
      history = { ...emptyHistory, total: receipt.revision.ordinal, current: receipt.selection,
        currentText: receipt.revision.text, rows: [receipt.revision] };
      return receipt;
    }
    if (command === "read_execution_receipt") return null;
    throw new Error(command);
  });
});
afterEach(cleanup);

it.each(["completed", "unknown"] as const)("does not label incomplete selected QA as passed (%s)", async outcome => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const result = await original(command, args);
    if (command === "read_review_summary_page") result.rows[0].currentCheck = {
      runId: fixtureIdentity(940), basis: result.rows[0].basis, outcome, hasFindings: false, hasIncomplete: true,
    };
    return result;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  await userEvent.click(screen.getByRole("button", { name: "Translations" }));
  const label = i18n.t(outcome === "unknown" ? "review.checkUnknown" : "review.qaUnavailable");
  expect(await screen.findByText((_, element) => element?.className === "entry-status" && Boolean(element.textContent?.includes(label)))).toBeVisible();
  expect(screen.queryByText((_, element) => element?.className === "entry-status" && Boolean(element.textContent?.includes(i18n.t("review.passed"))))).not.toBeInTheDocument();
});
async function captureDeclaredTranslation(user: ReturnType<typeof userEvent.setup>, runtime = translationView.environmentDigest) {
  await user.selectOptions(await screen.findByRole("combobox", { name: i18n.t("translationPlugin.package") }), `${translationPackage.packageDigest}:${translationView.resourceId}`);
  await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") }), runtime);
  const choose = await screen.findByRole("button", { name: "Choose translation folder" });
  await waitFor(() => expect(choose).toBeEnabled()); await user.click(choose);
  await user.selectOptions(await screen.findByRole("combobox", { name: i18n.t("translation.file") }), "zh.json");
  await user.click(await screen.findByRole("checkbox", { name: /I confirm that zh.json belongs to zh-CN/ }));
  await user.click(screen.getByRole("button", { name: "Capture translation file" }));
  expect(await screen.findByRole("button", { name: "Import for review" })).toBeDisabled();
}

async function importDeclaredTranslation(user: ReturnType<typeof userEvent.setup>) {
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract this captured translation file/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  await user.click(await screen.findByRole("checkbox", { name: /I separately allow this exact checker/ }));
  await user.click(screen.getByRole("button", { name: "Run independent translation check" }));
  await user.click(await screen.findByRole("button", { name: "Record translation check" }));
  await user.click(await screen.findByRole("button", { name: "Prepare checked translation preview" }));
  await user.click(await screen.findByRole("button", { name: "Review checked translation matches" }));
}


it("keeps the fixed import preview after complete consumer removal and session query garbage collection", async () => {
  const user = userEvent.setup();
  const view = render(<TranslationWorkbench project={project} disabled={false} />, project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("heading", { name: "Review translation matches" });
  const reads = invoke.mock.calls.filter(([name]) => name === "read_translation_preview").length;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, payload: unknown) => command === "read_translation_preview"
    ? Promise.resolve({ ...preview, basis: "different current preview", rows: [] }) : original(command, payload));
  vi.useFakeTimers();
  try {
    view.rerender(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
  } finally { vi.useRealTimers(); }
  view.rerender(<TranslationWorkbench project={project} disabled={false} />);
  expect(await screen.findByRole("heading", { name: "Review translation matches" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "你好" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_preview")).toHaveLength(reads);
  expect(screen.getByRole("button", { name: "Apply 1 unique matches" })).toBeEnabled();
});

it("keeps a newer draft when the entire translation consumer unmounts before save A acknowledges", async () => {
  const originalSelection = seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let releaseSave!: () => void;
  let delayed = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && delayed) {
      delayed = false;
      return new Promise(resolve => { releaseSave = () => resolve(originalInvoke(command, args)); });
    }
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />, project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(releaseSave).toBeDefined());
  const firstSave = invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request;
  expect(firstSave).toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN",
    sourceRevisionId: fixtureIdentity(205), expectedSelectionId: originalSelection.selection.eventId, text: "Saved baseA" });
  await user.type(editor, "B");
  rerender(null);
  expect(screen.queryByRole("textbox", { name: "Your draft" })).not.toBeInTheDocument();
  await act(async () => releaseSave());
  const acknowledgedSelection = history.current!.eventId;
  rerender(<TranslationWorkbench project={project} disabled={false} />);
  expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Saved baseAB");
  expect(await screen.findByText(/Your newer draft is still here/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(2));
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")[1][1].request)
    .toMatchObject({ expectedSelectionId: acknowledgedSelection, text: "Saved baseAB" });
  expect(history.current!.eventId).not.toBe(acknowledgedSelection);
});

it("saves the captured dirty draft after consumer remount even when its reference snapshot read fails", async () => {
  const selected = seedSelectedTranslation();
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />, project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, " with a retained edit");
  expect(editor).toHaveValue("Saved base with a retained edit");
  rerender(null);

  const originalInvoke = invoke.getMockImplementation()!;
  const readsBeforeRemount = invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot").length;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) =>
    command === "read_review_editor_snapshot"
      ? Promise.reject(new Error("reference snapshot temporarily unavailable"))
      : originalInvoke(command, args));
  rerender(<TranslationWorkbench project={project} disabled={false} />);
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot")).toHaveLength(readsBeforeRemount + 1));
  await screen.findByRole("alert");
  const retained = screen.getByRole("textbox", { name: "Your draft" });
  expect(retained).toHaveValue("Saved base with a retained edit");
  expect(screen.getByText("Original", { selector: ".editor-source pre" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1));
  expect(invoke.mock.calls.find(([name]) => name === "save_translation_revision")?.[1].request)
    .toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205),
      expectedSelectionId: selected.selection.eventId, text: "Saved base with a retained edit" });
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_target")).toHaveLength(0);
  expect(retained).toHaveValue("Saved base with a retained edit");
});

it("keeps an unknown original action across translation consumer unmount and checks that exact request", async () => {
  seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let loseFirstResponse = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && loseFirstResponse) {
      loseFirstResponse = false;
      await originalInvoke(command, args);
      throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true };
    }
    if (command === "read_translation_action") return history.current;
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />, project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await screen.findByRole("alert");
  await user.type(editor, "B");
  const firstSave = invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request;
  const identitiesBeforeCheck = invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length;
  rerender(null);
  rerender(<TranslationWorkbench project={project} disabled={false} />);
  expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Saved baseAB");
  await user.click(screen.getByRole("button", { name: "Check saved result" }));
  expect(await screen.findByText(/The original save was confirmed/)).toBeInTheDocument();
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[1][1].request).toEqual(firstSave);
  expect(invoke.mock.calls.find(([name]) => name === "read_translation_action")?.[1].request)
    .toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN", actionId: firstSave.actionId });
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(identitiesBeforeCheck);
});

it("shows the original source and newer draft after an unknown save, unmount, and target removal", async () => {
  seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let loseFirstResponse = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && loseFirstResponse) {
      loseFirstResponse = false;
      await originalInvoke(command, args);
      throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true };
    }
    if (command === "read_translation_action") return history.current;
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />, project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await screen.findByRole("alert");
  await user.type(editor, "B");
  const originalSave = invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request;
  const identitiesBeforeCheck = invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length;
  const removed = { ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } };
  const invalidBusinessCalls = () => invoke.mock.calls.filter(([name, args]) =>
    ["read_review_editor_snapshot", "read_review_summary_page", "read_translation_history", "save_translation_revision"]
      .includes(name) && args?.request?.locale === "zh-CN").length;
  const beforeRemoval = invalidBusinessCalls();
  rerender(null, removed);
  rerender(<TranslationWorkbench project={removed} disabled={false} />, removed);
  expect(await screen.findByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(screen.getByText("Original", { selector: "pre" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Saved baseAB");
  expect(screen.getByRole("button", { name: "Retry the same action" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check saved result" })).toBeEnabled();
  expect(invalidBusinessCalls()).toBe(beforeRemoval);
  await user.click(screen.getByRole("button", { name: "Check saved result" }));
  expect(await screen.findByText(/The original save was confirmed/)).toBeInTheDocument();
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[1][1].request).toEqual(originalSave);
  expect(invoke.mock.calls.find(([name]) => name === "read_translation_action")?.[1].request)
    .toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN", actionId: originalSave.actionId });
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(identitiesBeforeCheck);
});

it("blocks retargeting and project leave after remount while the original save identity is pending", async () => {
  const selected = seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let releaseIdentity!: () => void;
  let delayed = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "create_execution_identity" && delayed) {
      delayed = false;
      return new Promise(resolve => { releaseIdentity = () => resolve(originalInvoke(command, args)); });
    }
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const ref = createRef<TranslationHandle>();
  const { rerender } = render(<TranslationWorkbench ref={ref} project={project} disabled={false} />, project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(releaseIdentity).toBeDefined());
  await user.type(editor, "{Backspace}");
  expect(editor).toHaveValue("Saved base");
  rerender(null);
  rerender(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  await act(async () => {});
  expect(await screen.findByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Saved base");
  let retargeted!: boolean;
  act(() => { retargeted = ref.current!.openUnit({ unitId: fixtureIdentity(217), sourceRevisionId: fixtureIdentity(218),
    key: "second", sourceText: "Second source" }, "zh-CN"); });
  expect(retargeted).toBe(false);
  let leave!: Promise<boolean>;
  act(() => { leave = ref.current!.allowLeave(); });
  expect(await leave).toBe(false);
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Saved base");
  await act(async () => releaseIdentity());
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
  expect(invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request)
    .toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205),
      expectedSelectionId: selected.selection.eventId, text: "Saved baseA" });
});

it("keeps the draft dirty when text changes after submission and returns to the same A", async () => {
  seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let releaseSave!: () => void;
  let delayed = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && delayed) {
      delayed = false;
      return new Promise(resolve => { releaseSave = () => resolve(originalInvoke(command, args)); });
    }
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(releaseSave).toBeDefined());
  await user.type(editor, "B{Backspace}");
  expect(editor).toHaveValue("Saved baseA");
  await act(async () => releaseSave());
  const acknowledgedSelection = history.current!.eventId;
  expect(await screen.findByText(/Your newer draft is still here/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(2));
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")[1][1].request)
    .toMatchObject({ expectedSelectionId: acknowledgedSelection, text: "Saved baseA" });
  expect(history.current!.eventId).not.toBe(acknowledgedSelection);
});

it("does not start a removed-language save after execution identity resolves", async () => {
  const selected = seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let releaseIdentity!: () => void;
  let delayed = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "create_execution_identity" && delayed) {
      delayed = false;
      return new Promise(resolve => { releaseIdentity = () => resolve(originalInvoke(command, args)); });
    }
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(releaseIdentity).toBeDefined());
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata,
    targetLocales: ["ja-JP"], metadataRevision: "2" } }} disabled={false} />);
  await act(async () => releaseIdentity());
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
  expect(editor).toHaveValue("Saved baseA");
  expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("zh-CN");
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata,
    targetLocales: ["zh-CN"], metadataRevision: "3" } }} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1));
  expect(invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request)
    .toMatchObject({ locale: "zh-CN", sourceRevisionId: fixtureIdentity(205),
      expectedSelectionId: selected.selection.eventId, text: "Saved baseA" });
});

it("keeps an unavailable-language draft and its save basis until the original target is restored", async () => {
  const originalSelection = seedSelectedTranslation();
  const user = userEvent.setup();
  const ref = createRef<TranslationHandle>();
  const { rerender } = render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  expect(editor).toHaveValue("Saved base");
  await user.type(editor, " with newer input");
  const callsBeforeRemoval = invoke.mock.calls.length;

  const withoutOriginal = { ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } };
  rerender(<TranslationWorkbench ref={ref} project={withoutOriginal} disabled={false} />);
  const recovery = await screen.findByRole("alert");
  expect(recovery).toHaveTextContent("zh-CN");
  expect(recovery).toHaveTextContent(/restore|add .*back|project settings/i);
  expect(editor).toHaveValue("Saved base with newer input");
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(screen.getByText("Original", { selector: ".editor-source pre" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled();
  await act(async () => ref.current!.saveCurrent());
  expect(invoke.mock.calls.slice(callsBeforeRemoval).filter(([, args]) => args?.request?.locale === "zh-CN")).toHaveLength(0);

  const restored = { ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP", "zh-CN"], metadataRevision: "3" } };
  rerender(<TranslationWorkbench ref={ref} project={restored} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  expect(editor).toHaveValue("Saved base with newer input");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1));
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves[0][1].request).toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN",
    sourceRevisionId: fixtureIdentity(205), expectedSelectionId: originalSelection.selection.eventId,
    text: "Saved base with newer input" });
});

it("keeps the original unavailable-language draft when Core rejects its restored save basis", async () => {
  const originalSelection = seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision") throw { ...errorFixture.errors[1], reason: "translation-selection" };
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, " with newer input");
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } }} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN"], metadataRevision: "3" } }} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(i18n.t("commandError.recovery.review-current")));
  expect(editor).toHaveValue("Saved base with newer input");
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")[0][1].request)
    .toMatchObject({ locale: "zh-CN", expectedSelectionId: originalSelection.selection.eventId,
      sourceRevisionId: fixtureIdentity(205), text: "Saved base with newer input" });
});

it("returns to project settings with an unavailable-language draft while project leave still requires confirmation", async () => {
  const originalSelection = seedSelectedTranslation();
  const ref = createRef<TranslationHandle>();
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, " kept through settings");
  const removed = { ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } };
  rerender(<TranslationWorkbench ref={ref} project={removed} disabled={false} />);
  await user.click(await screen.findByRole("button", { name: "Back to project settings, keep this work" }));
  expect(screen.getByRole("button", { name: "Project overview" })).toHaveAttribute("aria-current", "page");
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);

  let leave!: Promise<boolean>;
  await act(async () => { leave = ref.current!.allowLeave(); });
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Leave with an unsaved translation?");
  await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(await leave).toBe(false);
  expect(editor).toHaveValue("Saved base kept through settings");
  await user.click(screen.getByRole("button", { name: "Back to project settings, keep this work" }));

  const restored = { ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP", "zh-CN"], metadataRevision: "3" } };
  rerender(<TranslationWorkbench ref={ref} project={restored} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Saved base kept through settings");
  expect(screen.getByText("Original", { selector: ".editor-source pre" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1));
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")[0][1].request)
    .toMatchObject({ locale: "zh-CN", unitId: fixtureIdentity(204), sourceRevisionId: fixtureIdentity(205),
      expectedSelectionId: originalSelection.selection.eventId, text: "Saved base kept through settings" });
});

it("ignores old list and editor reads that finish after the target language changes", async () => {
  const originalInvoke = invoke.getMockImplementation()!;
  const summary = (locale: string, nativeKey: string) => reviewSummaryPageFixture([
    reviewSummaryFor(reviewTargetFixture({ locale, nativeKey, unitId: fixtureIdentity(204),
      sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205),
      sourceText: "Original", selectionId: null, revisionId: null, translationText: null })),
  ]);
  let releaseOldSummary!: () => void;
  let releaseOldEditor!: () => void;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page" && args.request.locale === "zh-CN")
      return new Promise(resolve => { releaseOldSummary = () => resolve(summary("zh-CN", "old-entry")); });
    if (command === "read_review_summary_page" && args.request.locale === "ja-JP") return summary("ja-JP", "ja-entry");
    if (command === "read_review_summary_page" && args.request.locale === "fr-FR") return summary("fr-FR", "fr-entry");
    if (command === "read_review_editor_snapshot" && args.request.locale === "ja-JP")
      return new Promise(resolve => { releaseOldEditor = () => resolve(originalInvoke(command, args)); });
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await waitFor(() => expect(releaseOldSummary).toBeDefined());
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } }} disabled={false} />);
  await screen.findByRole("button", { name: "ja-entry" });
  await act(async () => releaseOldSummary());
  expect(screen.queryByRole("button", { name: "old-entry" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "ja-entry" }));
  await waitFor(() => expect(releaseOldEditor).toBeDefined());
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["fr-FR"], metadataRevision: "3" } }} disabled={false} />);
  await act(async () => releaseOldEditor());
  await screen.findByRole("button", { name: "fr-entry" });
  expect(screen.queryByRole("textbox", { name: "Your draft" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("fr-FR");
});

it("accepts an in-flight save acknowledgement after removal without overwriting newer input", async () => {
  seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let releaseSave!: () => void;
  let delayFirst = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && delayFirst) {
      delayFirst = false;
      return new Promise(resolve => { releaseSave = () => resolve(originalInvoke(command, args)); });
    }
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(releaseSave).toBeDefined());
  await user.type(editor, "B");
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } }} disabled={false} />);
  await act(async () => releaseSave());
  expect(editor).toHaveValue("Saved baseAB");
  expect(await screen.findByText(/Your newer draft is still here/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  const confirmedSelection = history.current!.eventId;

  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN"], metadataRevision: "3" } }} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(2));
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")[1][1].request)
    .toMatchObject({ locale: "zh-CN", expectedSelectionId: confirmedSelection, text: "Saved baseAB" });
});

it("checks an uncertain original save action after removal before accepting its exact replay", async () => {
  seedSelectedTranslation();
  const originalInvoke = invoke.getMockImplementation()!;
  let loseFirstResponse = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && loseFirstResponse) {
      loseFirstResponse = false;
      await originalInvoke(command, args);
      throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true };
    }
    if (command === "read_translation_action") return history.current;
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await screen.findByRole("alert");
  await user.type(editor, "B");
  const firstSave = invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request;
  const identitiesBeforeCheck = invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length;
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } }} disabled={false} />);
  expect(screen.getByRole("button", { name: i18n.t("translation.retryAction") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check saved result" }));
  expect(await screen.findByText(/The original save was confirmed/)).toBeInTheDocument();
  expect(editor).toHaveValue("Saved baseAB");
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[1][1].request).toEqual(firstSave);
  expect(invoke.mock.calls.find(([name]) => name === "read_translation_action")?.[1].request)
    .toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN", actionId: firstSave.actionId });
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(identitiesBeforeCheck);
});

it("keeps an in-flight import attempt and an uncertain adoption checkable after target removal", async () => {
  const originalInvoke = invoke.getMockImplementation()!;
  let releaseStart!: () => void;
  let delayStart = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "start_translation_projection" && delayStart) {
      delayStart = false;
      const accepted = Promise.resolve(originalInvoke(command, args));
      return new Promise(resolve => { releaseStart = () => { void accepted.then(resolve); }; });
    }
    if (command === "adopt_execution") return Promise.reject({ code: "outcome-unknown", outcome: "unknown", stage: "adopt", recoveryRequired: true });
    if (command === "read_execution_receipt") return null;
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await waitFor(() => expect(releaseStart).toBeDefined());
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } }} disabled={false} />);
  await act(async () => releaseStart());
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByRole("button", { name: "Apply 1 unique matches" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "start_translation_projection")).toHaveLength(1);

  const previewReads = invoke.mock.calls.filter(([name]) => name === "read_translation_preview").length;
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN"], metadataRevision: "3" } }} disabled={false} />);
  expect(screen.getByRole("button", { name: "Apply 1 unique matches" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_preview")).toHaveLength(previewReads);
  await user.click(screen.getByRole("button", { name: "Refresh matches" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Apply 1 unique matches" })).toBeEnabled());
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_preview").at(-1)?.[1].request)
    .toMatchObject({ attemptId: invoke.mock.calls.find(([name]) => name === "start_translation_projection")![1].request.attemptId, basis: null });
  await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
  const batchDialog = await screen.findByRole("dialog", { name: "Apply this complete file range?" });
  expect(batchDialog).toHaveTextContent("The complete file has 1 entries: 1 unique matches will be applied; 0 entries will remain unchanged.");
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_translation_adoption" || name === "adopt_execution")).toHaveLength(0);
  await user.click(within(batchDialog).getByRole("button", { name: "Confirm these matches" }));
  await screen.findByRole("button", { name: "Check the uncertain action's receipt" });
  const originalAction = invoke.mock.calls.find(([name]) => name === "adopt_execution")![1].request.actionId;
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "4" } }} disabled={false} />);
  expect(screen.getByRole("button", { name: "Retry the same action" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check the uncertain action's receipt" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "read_execution_receipt")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "read_execution_receipt")?.[1].request.actionId).toBe(originalAction);
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});

it("shows the removed target and recovery for a task-opened import after a clean target rebase", async () => {
  const user = userEvent.setup();
  const ref = createRef<TranslationHandle>();
  const { rerender } = render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await screen.findByRole("combobox", { name: "Target language" });

  rerender(<TranslationWorkbench ref={ref} project={{ ...project, metadata: {
    ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2",
  } }} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("ja-JP"));
  await user.click(screen.getByRole("button", { name: "Project overview" }));
  await act(async () => ref.current!.showAttempt(preview.attemptId));

  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(invoke.mock.calls.find(([name]) => name === "read_translation_preview")?.[1].request.attemptId)
    .toBe(preview.attemptId);
  expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("zh-CN");
  const returnToSettings = screen.getByRole("button", { name: "Back to project settings, keep this work" });
  const removedTargetAlert = returnToSettings.closest('[role="alert"]');
  expect(removedTargetAlert).toHaveTextContent("zh-CN");
  expect(removedTargetAlert).toHaveTextContent(/restore|project settings/i);
  expect(returnToSettings).toBeEnabled();
  expect(screen.getByText("This fixed preview needs an explicit refresh before making another decision. Saved results and original pending actions are kept.")).toHaveAttribute("role", "alert");
  expect(screen.getByRole("button", { name: "Apply 1 unique matches" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_translation_adoption" || name === "adopt_execution"))
    .toHaveLength(0);
});

it("keeps the rejecting basis beside newer input without replaying the save", async () => {
  const original = invoke.getMockImplementation()!;
  let rejectSave!: (error: unknown) => void;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision") return new Promise((_, reject) => { rejectSave = reject; });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Submitted draft");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(rejectSave).toBeDefined());
  await user.type(editor, " plus newer input");
  await act(async () => rejectSave({ ...errorFixture.errors[1], reason: "translation-selection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("commandError.recovery.review-current"));
  expect(editor).toHaveValue("Submitted draft plus newer input");
  await user.click(screen.getByText(i18n.t("execution.diagnostic")));
  expect(screen.getByText(errorFixture.errors[1].diagnosticId)).toBeVisible();
  expect(screen.getByText(errorFixture.errors[1].conflict!.current!)).toBeVisible();
  expect(screen.getByText(i18n.t("commandError.none"))).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
});

it("keeps a confirmed save and allows leaving when the list refresh fails", async () => {
  const ref = createRef<TranslationHandle>();
  const original = invoke.getMockImplementation()!;
  let summaries = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page" && ++summaries === 2) throw new Error("Read unavailable");
    return original(command, args);
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Committed draft");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your revision was saved, but the entry list could not refresh");
  expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  expect(await ref.current!.allowLeave()).toBe(true);
  await user.click(screen.getByRole("button", { name: "Find" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
});

it("confirms a save without a second editor or history read and preserves newer input", async () => {
  const original = invoke.getMockImplementation()!;
  let editorReads = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_editor_snapshot" && ++editorReads > 1) throw new Error("Later read unavailable");
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Confirmed draft");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
  expect(editor).toHaveValue("Confirmed draft");
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_history")).toHaveLength(0);
  await user.type(editor, " plus newer input");
  await user.click(screen.getByText("Terms, context and history"));
  await user.click(screen.getByRole("button", { name: "Refresh history" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "read_translation_history")).toHaveLength(2));
  expect(editor).toHaveValue("Confirmed draft plus newer input");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
});

it("retains the action when a committed save has a malformed acknowledgement", async () => {
  const original = invoke.getMockImplementation()!;
  let malformed = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    if (command === "save_translation_revision" && malformed) {
      malformed = false;
      return { ...value, actionId: "unrelated-action" };
    }
    return value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Saved once");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  const identitiesBeforeRetry = invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length;
  await user.click(await screen.findByRole("button", { name: "Retry the same action" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[1][1].request).toEqual(saves[0][1].request);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(identitiesBeforeRetry);
});

it("registers scoped save-and-next without a shortcut and dispatches the live command once", async () => {
  let commands!: WorkbenchCommands;
  const view = render(<><TranslationWorkbench project={project} disabled={false} />
    <CommandsProbe capture={value => { commands = value; }} /></>, project);
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "translation" as const };
  const command = () => commands.list(scope).find(value => value.id === "translation.save-and-next");
  expect(command()).toMatchObject({ id: "translation.save-and-next", nameKey: "workbench.saveAndNext",
    category: "translation", scope, binding: null, risk: "writes-translation", confirmation: "none",
    availability: { enabled: false, reason: "hidden" } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  expect(command()?.availability).toMatchObject({ enabled: false, reason: "no-changes" });
  await user.type(editor, "A");
  expect(command()?.availability.enabled).toBe(true);
  fireEvent.compositionStart(editor);
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, isComposing: true });
  fireEvent.compositionEnd(editor);
  fireEvent.keyDown(editor, { key: "Enter", isComposing: false });
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision" || name === "read_review_neighbor")).toHaveLength(0);
  expect(commands.dispatch("translation.save-and-next", { ...scope, area: "tasks" })).toBe(false);
  expect(commands.dispatch("translation.save-and-next", { ...scope, projectId: fixtureIdentity(901) })).toBe(false);
  expect(commands.dispatch("translation.save-and-next", { ...scope, sessionToken: "old-session" })).toBe(false);
  await act(async () => {
    expect(commands.dispatch("translation.save-and-next", scope)).toBe(true);
    expect(commands.dispatch("translation.save-and-next", scope)).toBe(false);
  });
  expect(await screen.findByRole("heading", { name: "second" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Project overview" }));
  expect(command()?.availability).toMatchObject({ enabled: false, reason: "hidden" });
  expect(commands.dispatch("translation.save-and-next", scope)).toBe(false);
  view.unmount();
  expect(commands.list(scope)).toHaveLength(0);
});

it.each([
  { acknowledgement: "unknown", newer: false },
  { acknowledgement: "unknown", newer: true },
  { acknowledgement: "malformed", newer: false },
  { acknowledgement: "malformed", newer: true },
])("retries the original save-and-next request before moving ($acknowledgement, newer=$newer)", async ({ acknowledgement, newer }) => {
  const original = invoke.getMockImplementation()!;
  let first = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    if (command === "save_translation_revision" && first) {
      first = false;
      if (acknowledgement === "unknown") throw { code: "outcome-unknown", outcome: "unknown", stage: "save", recoveryRequired: true };
      return { ...value, actionId: fixtureIdentity(999) };
    }
    return value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_neighbor")).toHaveLength(0);
  const originalRequest = invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request;
  const identities = invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length;
  if (newer) await user.type(editor, "B");
  expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => {
    if (newer) expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
    else expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  });
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[1][1].request).toEqual(originalRequest);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(identities);
  if (newer) {
    expect(editor).toHaveValue("AB");
    expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
    expect(screen.getByText(/Your newer draft is still here/)).toBeInTheDocument();
    expect(invoke.mock.calls.filter(([name]) => name === "read_review_neighbor")).toHaveLength(0);
  } else {
    expect(await screen.findByRole("heading", { name: "second" })).toBeInTheDocument();
    expect(invoke.mock.calls.filter(([name]) => name === "read_review_neighbor")).toHaveLength(1);
  }
});

it.each(["editor", "list"])("keeps save-and-next unavailable without a %s navigation basis while ordinary save remains available", async failedRead => {
  const user = userEvent.setup();
  let commands!: WorkbenchCommands;
  const consumer = () => <><TranslationWorkbench project={project} disabled={false} />
    <CommandsProbe capture={value => { commands = value; }} /></>;
  const { rerender } = render(consumer(), project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Retained draft");
  rerender(null);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) =>
    command === (failedRead === "editor" ? "read_review_editor_snapshot" : "read_review_summary_page")
      ? Promise.reject(new Error("Navigation reference temporarily unavailable")) : original(command, args));
  rerender(consumer());
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Retained draft");
  expect(screen.getByRole("button", { name: "Save and next" })).toBeDisabled();
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "translation" as const };
  expect(commands.list(scope).find(value => value.id === "translation.save-and-next")?.availability)
    .toMatchObject({ enabled: false, reason: "unavailable" });
  expect(commands.dispatch("translation.save-and-next", scope)).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
});

it("keeps a cached list from granting navigation while its fresh confirmation is pending or rejected", async () => {
  const user = userEvent.setup(); let commands!: WorkbenchCommands;
  const consumer = () => <><TranslationWorkbench project={project} disabled={false} />
    <CommandsProbe capture={value => { commands = value; }} /></>;
  const { rerender } = render(consumer(), project);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Retained draft");
  expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
  const capturedScope = invoke.mock.calls.find(([name]) => name === "read_review_summary_page")![1].request.scopeId;
  expect(capturedScope).toBeNull();
  rerender(null);
  const original = invoke.getMockImplementation()!;
  let rejectList!: (reason: unknown) => void;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return new Promise((_resolve, reject) => { rejectList = reject; });
    const result = await original(command, args);
    return command === "read_review_editor_snapshot" ? { ...result, context: { ...result.context, text: "Fresh editor reference confirmed" } } : result;
  });
  rerender(consumer());
  await waitFor(() => expect(rejectList).toBeDefined());
  await screen.findByText(/Fresh editor reference confirmed/);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "translation" as const };
  const assertBlocked = () => {
    expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Retained draft");
    expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save and next" })).toBeDisabled();
    expect(commands.list(scope).find(value => value.id === "translation.save-and-next")?.availability)
      .toMatchObject({ enabled: false, reason: "unavailable" });
    expect(commands.dispatch("translation.save-and-next", scope)).toBe(false);
  };
  assertBlocked();
  await act(async () => rejectList(new Error("Fresh fixed list unavailable")));
  await screen.findByRole("alert"); assertBlocked();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_summary_page").map(([, payload]) => payload.request.scopeId))
    .toEqual([null, fixtureIdentity(609)]);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "read_review_neighbor")).toBe(false);
});

it.each(["leave", "leave-and-return", "remove-and-restore", "import", "import-and-return"])("settles the original save without advancing after the committed view changes (%s)", async change => {
  const original = invoke.getMockImplementation()!;
  let releaseSave!: () => Promise<void>;
  let delayed = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && delayed) {
      delayed = false;
      return new Promise(resolve => { releaseSave = async () => { resolve(await original(command, args)); }; });
    }
    return original(command, args);
  });
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "A");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => expect(releaseSave).toBeDefined());
  if (change === "remove-and-restore") {
    rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: [], metadataRevision: "2" } }} disabled={false} />);
    await screen.findByText(i18n.t("translation.removedTargetDraft", { locale: "zh-CN" }));
    rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, metadataRevision: "3" } }} disabled={false} />);
  } else if (change === "import" || change === "import-and-return") {
    await user.click(screen.getByRole("button", { name: "Import file" }));
    expect(screen.getByRole("button", { name: "Import file" })).toHaveAttribute("aria-current", "page");
    if (change === "import-and-return") await user.click(screen.getByRole("button", { name: "Edit translations" }));
  } else {
    await user.click(screen.getByRole("button", { name: "Project overview" }));
    if (change === "leave-and-return") await user.click(screen.getByRole("button", { name: "Translations" }));
  }
  await act(async () => {});
  const summaries = invoke.mock.calls.filter(([name]) => name === "read_review_summary_page").length;
  const editorReads = invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot").length;
  await act(async () => releaseSave());
  await waitFor(() => expect(history.currentText).toBe("A"));
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_neighbor")).toHaveLength(0);
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_summary_page")).toHaveLength(summaries);
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot")).toHaveLength(editorReads);
  if (change === "leave") await user.click(screen.getByRole("button", { name: "Translations" }));
  if (change === "import") {
    expect(screen.getByRole("button", { name: "Import file" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("textbox", { name: "Your draft" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit translations" }));
  }
  expect(await screen.findByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("A");
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled());
});

it("keeps save-and-next on the original entry when newer input returns to the submitted text", async () => {
  const original = invoke.getMockImplementation()!;
  let releaseSave!: () => Promise<void>;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "save_translation_revision"
    ? new Promise(resolve => { releaseSave = async () => { resolve(await original(command, args)); }; }) : original(command, args));
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => expect(releaseSave).toBeDefined());
  await user.type(editor, "B{Backspace}");
  await act(async () => releaseSave());
  expect(await screen.findByText(/Your newer draft is still here/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(editor).toHaveValue("A");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_neighbor")).toHaveLength(0);
});

it("does not advance a replacement session from an old save-and-next acknowledgement", async () => {
  const original = invoke.getMockImplementation()!;
  let releaseSave!: () => Promise<void>;
  let delayed = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "save_translation_revision" && delayed) {
      delayed = false;
      return new Promise(resolve => { releaseSave = async () => { resolve(await original(command, args)); }; });
    }
    return original(command, args);
  });
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "A");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => expect(releaseSave).toBeDefined());
  const replacement = { ...project, sessionToken: "replacement-session", metadata: { ...project.metadata, projectId: fixtureIdentity(901) } };
  rerender(<TranslationWorkbench project={replacement} disabled={false} />);
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "B");
  await act(async () => releaseSave());
  expect(editor).toHaveValue("B");
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_neighbor")).toHaveLength(0);
  expect(invoke.mock.calls.find(([name]) => name === "save_translation_revision")![1].request)
    .toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, text: "A" });
});

it.each(["unchanged focus refresh", "semantic notification", "changed projection"] as const)("retains navigation confirmation only for an unchanged focus refresh (%s)", async mode => {
  seedSelectedTranslation();
  const original = invoke.getMockImplementation()!;
  const page = reviewSummaryPageFixture([
    reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(204), nativeKey: "first", sourceText: "Original", translationText: "Saved base",
      sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205) })),
    reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(217), nativeKey: "second", sourceText: "Second source",
      sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205) })),
  ]);
  let changed = false;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_review_summary_page"
    ? Promise.resolve(changed ? { ...page, rows: page.rows.map(row => ({ ...row, translationPreview: "Different projection" })) } : page)
    : original(command, args));
  let reads!: ReturnType<typeof useSessionReads>;
  render(<><QueryProbe capture={value => { reads = value; }} /><TranslationWorkbench project={project} disabled={false} /></>, project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), " retained B");
  expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
  const query = reads.client.getQueryCache().findAll().find(value => value.queryKey[2] === "translation-list" && value.isActive());
  if (!query) throw new Error("Expected active fixed list Query");
  const before = query.state.dataUpdateCount;
  const confirmed = query.state.data;
  changed = mode === "changed projection";
  act(() => reads.invalidate(["project"], mode === "semantic notification"));
  await waitFor(() => {
    expect(query.state.dataUpdateCount).toBeGreaterThan(before);
    expect(query.state.fetchStatus).toBe("idle");
  });
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Saved base retained B");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  if (mode !== "unchanged focus refresh") {
    expect(screen.getByRole("button", { name: "Save and next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next entry" })).toBeDisabled();
    expect(invoke.mock.calls.some(([name]) => name === "save_translation_revision" || name === "read_review_neighbor")).toBe(false);
    return;
  }
  expect(query.state.data).toBe(confirmed);
  expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Next entry" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  expect(await screen.findByRole("heading", { name: "second" })).toBeInTheDocument();
  const saved = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saved).toHaveLength(1);
  expect(saved[0][1].request.text).toBe("Saved base retained B");
});

it.each(["before list read", "after editor read"] as const)("settles current change metadata before confirming post-save navigation (%s)", async delivery => {
  let stop = () => {};
  try {
    seedSelectedTranslation();
    const original = invoke.getMockImplementation()!;
    const epoch = fixtureIdentity(820);
    let sequence = "0", receive = (_event: { payload: unknown }) => {};
    const notification = () => receive({ payload: { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
      epoch, kind: "change", afterSequence: "0", sequence: "1", scopes: ["translation"] } });
    listen.mockImplementation(async (_name: string, callback: typeof receive) => { receive = callback; return () => {}; });
    invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
      if (command === "read_project_changes") return { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
        epoch, sequence, progressSequence: "0", scopes: ["translation"], runtime: { active: false, quiescing: false, queryCount: 0, error: null } };
      if (command === "read_review_summary_page") return reviewSummaryPageFixture([
        reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(204), nativeKey: "first", sourceText: "Original",
          sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205), translationText: history.currentText })),
        reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(217), nativeKey: "second", sourceText: "Second source",
          sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205) })),
      ]);
      const value = await original(command, args);
      if (command === "save_translation_revision") {
        sequence = "1";
        if (delivery === "before list read") notification();
      }
      if (command === "read_review_editor_snapshot" && args.request.unitId === fixtureIdentity(217)
        && delivery === "after editor read") notification();
      return value;
    });
    let reads!: ReturnType<typeof useSessionReads>;
    render(<><QueryProbe capture={value => { reads = value; }} /><TranslationWorkbench project={project} disabled={false} /></>, project);
    let semanticChanges = 0;
    const unsubscribe = reads.subscribeChanges(scopes => { if (scopes.includes("project") || scopes.includes("translation")) semanticChanges++; });
    await act(async () => { stop = reads.start(); });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await user.click(await screen.findByRole("button", { name: "first" }));
    await user.type(await screen.findByRole("textbox", { name: "Your draft" }), " saved A");
    await user.click(screen.getByRole("button", { name: "Save and next" }));
    expect(await screen.findByRole("heading", { name: "second" })).toBeInTheDocument();
    await waitFor(() => expect(semanticChanges).toBeGreaterThan(0));
    await user.type(screen.getByRole("textbox", { name: "Your draft" }), "Final B");
    expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
    expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1);
    unsubscribe();
  } finally {
    stop(); cleanup();
  }
});

it.each(["save-and-next", "save-and-continue"])("saves entry 50 and opens entry 51 without manual paging, then reports the end (%s)", async mode => {
  const original = invoke.getMockImplementation()!;
  const saved = new Map<string, string>();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") {
      const after = Number(args.request.afterOrdinal);
      return { rows: Array.from({ length: Math.min(50, 51 - after) }, (_, offset) => {
        const position = after + offset;
        return { unitId: fixtureIdentity(1000 + position), locale: "zh-CN", nativeKey: `entry-${position + 1}`,
          sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(1100 + position),
          sourcePreview: "Source preview", translationPreview: saved.get(fixtureIdentity(1000 + position)) ?? null,
          selectionId: null, revisionId: null, basis: "basis", currentDecision: null, currentCheck: null };
      }), total: 51, nextOrdinal: after + 50 < 51 ? after + 50 : null,
        scopeId: fixtureIdentity(226), sourceSnapshotId: fixtureIdentity(200), readVersion: "view" };
    }
    if (command === "read_review_editor_snapshot") {
      const value = await original(command, args);
      const unitId = String(args.request.unitId);
      const position = Number(unitId.slice(-12)) - 1000;
      const text = saved.get(unitId) ?? null;
      return { ...value, target: { ...value.target, unitId, nativeKey: `entry-${position + 1}`,
        sourceRevisionId: fixtureIdentity(1100 + position), sourceText: "Complete source for editing", translationText: text },
        translations: { ...emptyHistory, unitId, currentText: text } };
    }
    if (command === "save_translation_revision") {
      saved.set(String(args.request.unitId), String(args.request.text));
      return saveReceipt(args.request);
    }
    if (command === "read_review_neighbor") {
      const next = Number(String(args.request.unitId).slice(-12)) - 1000 + Number(args.request.direction);
      return { unitId: next >= 0 && next < 51 ? fixtureIdentity(1000 + next) : null,
        afterOrdinal: next >= 0 && next < 51 ? next : null, sourceSnapshotId: fixtureIdentity(200) };
    }
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "entry-50" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Fiftieth saved");
  if (mode === "save-and-next") await user.click(screen.getByRole("button", { name: "Save and next" }));
  else {
    await user.click(screen.getByRole("button", { name: "Next entry" }));
    await user.click(await screen.findByRole("button", { name: "Save and continue" }));
  }
  expect(await screen.findByRole("heading", { name: "entry-51" })).toBeInTheDocument();
  expect(saved.get(fixtureIdentity(1049))).toBe("Fiftieth saved");
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "entry-51" })).toHaveAttribute("aria-current", "true");
  await user.type(screen.getByRole("textbox", { name: "Your draft" }), "Final saved");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  expect(await screen.findByText("You have reached the last entry in this list.")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "entry-51" })).toBeInTheDocument();
  expect(saved.get(fixtureIdentity(1050))).toBe("Final saved");
});

it("retains input entered while save-and-next waits for the neighboring entry", async () => {
  const original = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_neighbor"
    ? new Promise(resolve => { finish = resolve; }) : original(command, args));
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  await user.click(screen.getByRole("button", { name: "Save and next" }));
  await waitFor(() => expect(finish).toBeDefined());
  await user.type(editor, "B");
  await act(async () => finish({ unitId: fixtureIdentity(217), afterOrdinal: 1, sourceSnapshotId: fixtureIdentity(200) }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled());
  expect(editor).toHaveValue("AB");
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Your draft changed while the next entry was loading");
});

it.each([
  ["review-scope-expired", "This result list has expired"],
  ["review-scope-source-changed", "The source range changed"],
])("recovers a stale result scope through a fresh search without losing the draft (%s)", async (field, message) => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") {
      if (args.request.scopeId) throw { code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: field };
      return { ...await original(command, args), nextOrdinal: 1 };
    }
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Retained input");
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(editor).toHaveValue("Retained input");
  await user.click(screen.getByRole("button", { name: "Find" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(editor).toHaveValue("Retained input");
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_summary_page").at(-1)?.[1].request.scopeId).toBeNull();
});

it("keeps the editor but disables list navigation when a new search has no matches", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    return command === "read_review_summary_page" && args.request.query === "absent"
      ? { ...value, rows: [], total: 0, nextOrdinal: null } : value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Keep this input");
  await user.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "absent");
  await user.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByText("0 matching entries");
  expect(editor).toHaveValue("Keep this input");
  expect(screen.getByRole("button", { name: "Previous entry" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next entry" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save and next" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
});

it("requires language mapping and applies only the reviewed unique result", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByText("你好")).toBeInTheDocument();
  const identities = invoke.mock.calls.filter(([name]) => name === "create_execution_identity").length;
  await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
  const dialog = await screen.findByRole("dialog", { name: "Apply this complete file range?" });
  expect(dialog).toHaveTextContent("The complete file has 1 entries: 1 unique matches will be applied; 0 entries will remain unchanged.");
  expect(dialog).toHaveTextContent("Create candidates for these fixed matches. Current selections are kept.");
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(identities);
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_translation_adoption" || name === "adopt_execution")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Confirm these matches" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "prepare_translation_adoption")?.[1].request.confirmation).toMatchObject({ decision: "candidate-only", resultDigest: "result-digest", targetUnitId: fixtureIdentity(204) });
});

it.each(["escape", "continue"])("returns focus to the retained draft after %s cancels leaving", async (dismissal) => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(draft, "Keep this unsaved input");
  let leaving!: Promise<boolean>;
  act(() => { leaving = ref.current!.allowLeave(); });
  await screen.findByRole("dialog", { name: i18n.t("translation.leaveTitle") });
  if (dismissal === "escape") await user.keyboard("{Escape}");
  else await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(await leaving).toBe(false);
  expect(draft).toHaveValue("Keep this unsaved input");
  await waitFor(() => expect(draft).toHaveFocus());
  expect(invoke.mock.calls.some(([name]) => name === "save_translation_revision")).toBe(false);
});

it.each(["batch", "row"])("refreshes frozen editor summaries after %s import selection", async (mode) => {
  const original = invoke.getMockImplementation()!;
  let adopted = false;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page" && adopted) {
      return reviewSummaryPageFixture([reviewSummaryFor(reviewTargetFixture({
        unitId: fixtureIdentity(204), nativeKey: "first", sourceText: "Original",
        sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205),
        selectionId: fixtureIdentity(601), revisionId: fixtureIdentity(701),
        translationText: "你好", basis: "selected-basis",
      }))], typeof args.request.scopeId === "string" ? { scopeId: args.request.scopeId } : {});
    }
    const result = await original(command, args);
    if (command === "adopt_execution") adopted = true;
    return result;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  expect(await screen.findByRole("button", { name: "first" })).toHaveTextContent("No selected translation");
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("heading", { name: "Review translation matches" });
  if (mode === "batch") {
    await user.click(screen.getByRole("checkbox", { name: i18n.t("translation.selectIfEmpty") }));
    await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
    const dialog = await screen.findByRole("dialog", { name: i18n.t("translation.batchConfirm") });
    expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: i18n.t("translation.batchStart") }));
  } else {
    await user.click(screen.getByRole("button", { name: "Select imported translation" }));
    await user.click(within(screen.getByRole("dialog", { name: "Select imported translation" })).getByRole("button", { name: "Select imported translation" }));
  }
  await waitFor(() => expect(adopted).toBe(true));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "first" })).toHaveTextContent("你好"));
  expect(screen.getByRole("button", { name: "first" })).toHaveTextContent(i18n.t("workbench.selected"));
});

it("keeps text typed after an earlier save and checks the new selection before saving again", async () => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "A");
  let complete!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "save_translation_revision"
    ? new Promise(resolve => { complete = () => { const receipt = saveReceipt(args.request); history = { ...emptyHistory, total: "1", current: receipt.selection, currentText: "A", rows: [] }; resolve(receipt); }; })
    : original(command, args));
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  expect(editor).not.toHaveAttribute("readonly");
  await user.type(editor, "B");
  await act(async () => { complete(history.current); });
  await screen.findByText(/Your newer draft is still here/);
  expect(editor).toHaveValue("AB");
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(await decision).toBe(false);
  expect(editor).toHaveValue("AB");
  invoke.mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(2));
  expect(invoke.mock.calls.at(-3)?.[1]).toBeDefined();
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves[1][1].request).toMatchObject({ text: "AB", expectedSelectionId: fixtureIdentity(601) });
});

it("shows current adopted terms and context beside the editable translation", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByText("Terms, context and history"));
  const reference = await screen.findByRole("region", { name: "Terms and context for this translation" });
  expect(reference).toHaveTextContent("Original: 原文 · Manual · Project terminology");
  expect(reference).toHaveTextContent("Used in the opening screen · Translator note");
  expect(screen.getByRole("textbox", { name: "Your draft" })).toBeEnabled();
  expect(invoke.mock.calls.find(([name]) => name === "read_review_editor_snapshot")?.[1].request).toMatchObject({ unitId: fixtureIdentity(204), locale: "zh-CN" });
});

it("queries the complete current scope and retains a filtered position on return", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return Promise.resolve(reviewSummaryPageFixture([reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(218), nativeKey: args.request.query ? "later-needle" : "first", sourceText: "Source on page two", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(219), selectionId: null, revisionId: null, translationText: null, basis: "later-basis" }))], { total: args.request.query ? 1 : 60, nextOrdinal: args.request.query ? null : 50, scopeId: fixtureIdentity(227) }));
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await screen.findByRole("button", { name: "first" });
  await user.type(screen.getByRole("textbox", { name: "Find by key, source or translation" }), "needle");
  await user.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByRole("button", { name: "later-needle" });
  expect(invoke).toHaveBeenCalledWith("read_review_summary_page", { request: expect.objectContaining({ query: "needle", afterOrdinal: 0, limit: 50, locale: "zh-CN" }) });
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(await screen.findByRole("button", { name: "later-needle" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Find by key, source or translation" })).toHaveValue("needle");
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_history")).toHaveLength(0);
});

it("refreshes a clean retained editor against current source and selection on return", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await screen.findByRole("textbox", { name: "Your draft" });
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  history = { ...emptyHistory, total: "1", currentText: "External selection" };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    return command === "read_review_editor_snapshot" ? { ...value, target: reviewTargetFixture({ ...value.target, basisEvidence: undefined, sourceRevisionId: fixtureIdentity(228), sourceText: "Updated original" }) } : value;
  });
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("External selection"));
  expect(screen.getByText("Updated original")).toBeInTheDocument();
  await user.clear(screen.getByRole("textbox", { name: "Your draft" }));
  await user.type(screen.getByRole("textbox", { name: "Your draft" }), "New translation");
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_translation_revision", { request: expect.objectContaining({ sourceRevisionId: fixtureIdentity(228), text: "New translation" }) }));
});

it("preserves text entered while a retained editor refresh is awaiting current facts", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await screen.findByRole("textbox", { name: "Your draft" });
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  let complete!: () => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_editor_snapshot"
    ? new Promise(resolve => { complete = async () => resolve(await original(command, args)); }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await waitFor(() => expect(complete).toBeDefined());
  await user.type(screen.getByRole("textbox", { name: "Your draft" }), "Newer input");
  history = { ...emptyHistory, currentText: "External selection" };
  await act(async () => { complete(); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Back to overview" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Newer input");
});

it("keeps the current editor when a neighboring entry is requested with a dirty draft", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    if (command === "read_review_summary_page") return { ...value, rows: [value.rows[0], { ...value.rows[0], unitId: fixtureIdentity(217), nativeKey: "second", sourceRevisionId: fixtureIdentity(220) }], total: 2 };
    return value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(editor, "Unfinished");
  await user.click(screen.getByRole("button", { name: "Next entry" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("Leave with an unsaved translation?");
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(editor).toHaveValue("Unfinished");
  expect(screen.getByRole("button", { name: "first" })).toHaveAttribute("aria-current", "true");
});

it.each([
  { code: "outcome-unknown", outcome: "unknown", reason: "commit" },
  new Error("IPC response lost"),
  { code: "dependency-conflict", outcome: "rejected" },
  { code: "dependency-conflict", outcome: "rejected", stage: "execution-write", recoveryRequired: false },
])("saves before leaving and retains an uncertain action for a checked retry: %s", async (failure) => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Edit translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), "Draft");
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "save_translation_revision"
    ? Promise.reject(failure)
    : original(command, args));
  await user.click(screen.getByRole("button", { name: "Save and continue" }));
  expect(await screen.findByRole("button", { name: "Retry the same action" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Discard draft and continue" })).toBeDisabled();
  invoke.mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Retry the same action" }));
  expect(await decision).toBe(true);
  const saves = invoke.mock.calls.filter(([name]) => name === "save_translation_revision");
  expect(saves).toHaveLength(2);
  expect(saves[0][1].request.actionId).toBe(saves[1][1].request.actionId);
  expect(saves[1][1].request.text).toBe("Draft");
});

it("requires a separate comparison and confirmation before replacing a selected translation", async () => {
  conflicting = true;
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByRole("button", { name: "Apply 0 unique matches" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Replace current selection" }));
  const dialog = screen.getByRole("dialog", { name: "Replace current selection" });
  expect(dialog).toHaveTextContent("旧译文");
  expect(dialog).toHaveTextContent("你好");
  expect(invoke.mock.calls.some(([name]) => name === "prepare_translation_adoption")).toBe(false);
  await user.click(dialog.querySelector("button.primary-button")!);
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "prepare_translation_adoption")?.[1].request.confirmation).toMatchObject({ decision: "replace", expectedSelectionId: fixtureIdentity(221) });
});

it("reports a partial batch without treating an uncommitted conflict as applied", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_translation_preview" && !applied) return Promise.resolve({ ...preview, attemptId: String(args.request.attemptId), total: 2, unique: 2, rows: [preview.rows[0], { ...preview.rows[0], entry: { ...preview.rows[0].entry, ordinal: 1, nativeKey: "SECOND" }, itemId: fixtureIdentity(215), resultId: fixtureIdentity(216) }] });
    if (command === "read_execution_attempt" && pluginAttempts.get(String(args.request.attemptId))?.operation === "translation-import") return Promise.resolve(translationAttemptFixture({ ...preview, attemptId: String(args.request.attemptId), total: 2, unique: 2, rows: [preview.rows[0], { ...preview.rows[0], entry: { ...preview.rows[0].entry, ordinal: 1, nativeKey: "SECOND" }, itemId: fixtureIdentity(215), resultId: fixtureIdentity(216) }] }));
    if (command === "prepare_translation_adoption" && args.request.itemId === fixtureIdentity(215)) return Promise.reject({ code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "translation-selection" });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await importDeclaredTranslation(user);
  await screen.findByRole("button", { name: "Apply 2 unique matches" });
  await user.click(screen.getByRole("button", { name: "Apply 2 unique matches" }));
  expect(await screen.findByRole("dialog", { name: "Apply this complete file range?" })).toHaveTextContent("complete file has 2 entries");
  expect(invoke.mock.calls.some(([name]) => name === "prepare_translation_adoption")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Confirm these matches" }));
  expect(await screen.findByText(/Applied 1; conflicted 1; failed 0; outcome unknown 0/)).toBeInTheDocument();
  await user.click(screen.getByText("Entry results"));
  expect(screen.getByText("SECOND: Conflict; not applied")).toBeInTheDocument();
});

it("shows Chinese import labels and an actionable missing-source state", async () => {
  await i18n.changeLanguage("zh-CN");
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_content_scope" ? Promise.resolve({ revision: "1", currentSnapshot: null }) : original(command, args));
  render(<TranslationWorkbench project={project} disabled={false} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "译文" }));
  expect(await screen.findByText("请先导入源内容，再回来匹配译文。")) .toBeInTheDocument();
});

it("retains an uncertain protection action while guarding entry, language and project navigation", async () => {
  const original=invoke.getMockImplementation()!,ref=createRef<TranslationHandle>();let lost=true,protectedValue=false;
  invoke.mockImplementation(async(command:string,args:{request:Record<string,unknown>})=>{
    if(command==="read_review_summary_page"){const page=await original(command,args);return {...page,total:2,rows:[...page.rows,reviewSummaryFor(reviewTargetFixture({unitId:fixtureIdentity(217),sourceRevisionId:fixtureIdentity(218),sourceSnapshotId:fixtureIdentity(200),nativeKey:"second",sourceText:"Second"}))]};}
    if(command==="read_work_protection")return {unitId:args.request.unitId,locale:args.request.locale,revision:protectedValue?"1":"0",protected:protectedValue};
    if(command==="set_work_protection"){
      if(lost){lost=false;throw {code:"outcome-unknown"};}
      protectedValue=true;return {unitId:args.request.unitId,locale:args.request.locale,revision:"1",protected:true};
    }
    return original(command,args);
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false}/>);const user=userEvent.setup();
  await user.click(screen.getByRole("button",{name:"Translations"}));await user.click(await screen.findByRole("button",{name:"first"}));
  await screen.findByRole("button",{name:"Retry same protection action"});
  expect(screen.getByRole("button",{name:"Back to overview"})).toBeDisabled();
  expect(screen.getByRole("combobox",{name:"Target language"})).toBeDisabled();
  expect(screen.getByRole("button",{name:"second"})).toBeDisabled();
  let leave=true,opened=true;
  await act(async()=>{leave=await ref.current!.allowLeave();opened=ref.current!.openUnit({unitId:fixtureIdentity(217),sourceRevisionId:fixtureIdentity(218),key:"second",sourceText:"Second"},"zh-CN");});
  expect(leave).toBe(false);expect(opened).toBe(false);
  const draft=screen.getByRole("textbox",{name:"Your draft"});
  expect(draft).toHaveAttribute("readonly");await user.type(draft,"Unsafe input");expect(draft).toHaveValue("");
  await user.click(screen.getByRole("button",{name:"Retry same protection action"}));
  await screen.findByText("Protected from automatic selection");
  await waitFor(()=>expect(draft).not.toHaveAttribute("readonly"));await user.type(draft,"Retained manual input");expect(draft).toHaveValue("Retained manual input");
  const mutations=invoke.mock.calls.filter(([name])=>name==="set_work_protection");expect(mutations).toHaveLength(2);expect(mutations[1][1].request).toEqual(mutations[0][1].request);
});

it("accepts no editable draft before protection commits and confirms current state", async () => {
  protection.set(`${fixtureIdentity(204)}:zh-CN`, { unitId: fixtureIdentity(204), locale: "zh-CN", revision: "0", protected: false });
  const original = invoke.getMockImplementation()!;
  let finishProtection!: () => Promise<void>;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "set_work_protection") return new Promise(resolve => {
      finishProtection = async () => resolve(await original(command, args));
    });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(finishProtection).toBeDefined());
  expect(draft).toHaveAttribute("readonly");
  await user.type(draft, "Before protection");
  expect(draft).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  await act(finishProtection);
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "After protection");
  expect(draft).toHaveValue("After protection");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_work_protection")).toHaveLength(2);
});

it("keeps unreadable protection read-only and recovers through its existing refresh action", async () => {
  const original = invoke.getMockImplementation()!;
  let failedRead = true;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_work_protection" && failedRead) return Promise.reject(new Error("Read unavailable"));
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await screen.findByRole("button", { name: "Refresh protection" });
  expect(draft).toHaveAttribute("readonly");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(0);
  failedRead = false;
  await user.click(screen.getByRole("button", { name: "Refresh protection" }));
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "Recovered input");
  expect(draft).toHaveValue("Recovered input");
});

it("keeps a released entry read-only until explicit protection without re-protecting in a loop", async () => {
  protection.set(`${fixtureIdentity(204)}:zh-CN`, { unitId: fixtureIdentity(204), locale: "zh-CN", revision: "0", protected: false });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.click(screen.getByRole("button", { name: "Release protection" }));
  await user.click(await screen.findByRole("button", { name: "Release for this entry" }));
  await screen.findByText("Automatic selection is not protected");
  expect(draft).toHaveAttribute("readonly");
  await user.type(draft, "Unprotected input");
  expect(draft).toHaveValue("");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Protect from automation" }));
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "Protected input");
  expect(draft).toHaveValue("Protected input");
  expect(invoke.mock.calls.filter(([name]) => name === "set_work_protection")).toHaveLength(3);
});

it("refreshes a conflicting entry basis before protecting it and never saves a blocked suggested draft", async () => {
  protection.set(`${fixtureIdentity(204)}:zh-CN`, { unitId: fixtureIdentity(204), locale: "zh-CN", revision: "0", protected: false });
  const original = invoke.getMockImplementation()!, ref = createRef<TranslationHandle>();
  let firstWrite = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "set_work_protection" && firstWrite) {
      firstWrite = false;
      const receipt = saveReceipt({ ...args.request, text: "Another selection", expectedSelectionId: null });
      history = { ...emptyHistory, total: "1", current: receipt.selection, currentText: receipt.revision.text, rows: [receipt.revision] };
      throw errorFixture.errors[1];
    }
    return original(command, args);
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await act(async () => { ref.current!.openUnit({ unitId: fixtureIdentity(204), sourceRevisionId: fixtureIdentity(205), key: "first", sourceText: "Original" }, "zh-CN", "Suggested draft"); });
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await screen.findByRole("alert");
  expect(draft).toHaveAttribute("readonly");
  expect(draft).toHaveValue("Suggested draft");
  let leaving!: Promise<boolean>;
  await act(async () => { leaving = ref.current!.allowLeave(); });
  await screen.findByRole("dialog");
  expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: i18n.t("translation.stay") }));
  expect(await leaving).toBe(false);
  expect(draft).toHaveValue("Suggested draft");
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Discard draft" }));
  await user.click(screen.getByRole("button", { name: "Refresh current entry" }));
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  expect(draft).toHaveValue("Another selection");
  const writes = invoke.mock.calls.filter(([name]) => name === "set_work_protection");
  expect(writes).toHaveLength(2);
  expect(writes[1][1].request.selectionId).toBe(history.current!.eventId);
});

it("does not save or leave during composition and preserves the draft for the next ordinary save", async () => {
  const ref = createRef<TranslationHandle>();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.type(draft, "Draft");
  fireEvent.compositionStart(draft);
  fireEvent.keyDown(draft, { key: "s", metaKey: true, isComposing: true });
  expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(ref.current!.openUnit({ unitId: fixtureIdentity(217), sourceRevisionId: fixtureIdentity(218), key: "second", sourceText: "Second" }, "zh-CN")).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
  expect(draft).toHaveValue("Draft");
  fireEvent.compositionEnd(draft);
  fireEvent.keyDown(draft, { key: "s", metaKey: true, isComposing: true });
  expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Save revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "save_translation_revision")).toHaveLength(1));
  expect(draft).toHaveValue("Draft");
});

it.each(["newer-text", "composition"])("preserves %s when a manual selection acknowledgement arrives", async mode => {
  const revision = saveReceipt({ projectId: project.metadata.projectId, actionId: fixtureIdentity(3000),
    unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), text: "Older revision", expectedSelectionId: null }).revision;
  history = { ...emptyHistory, total: "1", rows: [revision] };
  const original = invoke.getMockImplementation()!;
  let complete!: () => void;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "select_translation_revision") return new Promise(resolve => {
      complete = () => {
        const selection = { eventId: fixtureIdentity(3001), unitId: revision.unitId, locale: revision.locale,
          sequence: "1", revisionId: revision.revisionId, actionId: String(args.request.actionId), previousEventId: null };
        history = { ...history, current: selection, currentText: revision.text };
        resolve(selection);
      };
    });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const draft = await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(draft).not.toHaveAttribute("readonly"));
  await user.click(screen.getByText("Terms, context and history"));
  await user.click(screen.getByRole("button", { name: "Select this revision" }));
  await waitFor(() => expect(complete).toBeDefined());
  if (mode === "newer-text") await user.type(draft, "Newer input");
  else fireEvent.compositionStart(draft);
  await act(async () => { complete(); });
  if (mode === "composition") {
    expect(screen.getByRole("button", { name: "Back to overview" })).toBeDisabled();
    expect(draft).toHaveValue("");
    fireEvent.compositionEnd(draft);
  }
  await waitFor(() => expect(screen.getByRole("button", { name: "Back to overview" })).toBeEnabled());
  expect(draft).not.toHaveAttribute("readonly");
  expect(draft).toHaveValue(mode === "newer-text" ? "Newer input" : "");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
});


it("reconciles an accepted translation start with the original attempt, grant and expiry", async () => {
  const original = invoke.getMockImplementation()!, ref = createRef<TranslationHandle>(); let lost = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    if (command === "start_plugin_translation" && lost) { lost = false; throw new Error("Lost accepted acknowledgement"); }
    return value;
  });
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract this captured translation file/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  const retry = await screen.findByRole("button", { name: i18n.t("translationPlugin.retryOriginal") });
  expect(await ref.current!.allowLeave()).toBe(false);
  expect(screen.getByRole("button", { name: "Choose new translation input" })).toBeDisabled();
  await user.click(retry);
  await screen.findByRole("button", { name: "Review independent translation check" });
  const starts = invoke.mock.calls.filter(([name]) => name === "start_plugin_translation");
  expect(starts).toHaveLength(2); expect(starts[1][1]).toEqual(starts[0][1]);
  expect(invoke.mock.calls.some(([name]) => name === "start_translation_check")).toBe(false);
  expect(invoke.mock.calls.some(([name]) => name === "prepare_translation_projection")).toBe(false);
});

it("retains translation preparation across views and explicitly protects project departure", async () => {
  const ref = createRef<TranslationHandle>(), user = userEvent.setup();
  render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible();
  let leaving!: Promise<boolean>; await act(async () => { leaving = ref.current!.allowLeave(); });
  await user.click(await screen.findByRole("button", { name: "Keep editing" }));
  expect(await leaving).toBe(false); expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible();
  expect(invoke.mock.calls.some(([name]) => name === "start_plugin_translation")).toBe(false);
});

it("blocks a rejected independent translation check and preserves the original proposal", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const value = await original(command, args);
    if (command === "finish_translation_check") pluginAttempts.get(String(args.request.translationAttemptId))!.items[0].status.validation = "invalid";
    return value;
  });
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract/ })); await user.click(screen.getByRole("button", { name: "Import for review" }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  expect(await screen.findByRole("button", { name: "Run independent translation check" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I separately allow this exact checker/ })); await user.click(screen.getByRole("button", { name: "Run independent translation check" }));
  await user.click(await screen.findByRole("button", { name: "Record translation check" }));
  await screen.findByText(/The mandatory translation check rejected/);
  expect(screen.queryByRole("button", { name: "Prepare checked translation preview" })).not.toBeInTheDocument();
  const producerStart = invoke.mock.calls.find(([name]) => name === "start_plugin_translation")![1].request;
  const checkerStart = invoke.mock.calls.find(([name]) => name === "start_translation_check")![1].request;
  expect(checkerStart.grantId).not.toBe(producerStart.grantId); expect(checkerStart.attemptId).not.toBe(producerStart.attemptId);
  expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible();
});

it("derives import availability from declared capabilities while preserving editing", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_source_content"
    ? Promise.resolve({ ...content, namespace: "webvtt:source" }) : command === "read_plugin_inventory"
    ? Promise.resolve({ ...translationInventory, packageDecisions: [] }) : original(command, args));
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" }));
  await screen.findByText(/Enable a translation package matching the current source profile/);
  expect(screen.getByRole("button", { name: "Choose translation folder" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Edit translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  expect(await screen.findByRole("textbox", { name: "Your draft" })).toBeEnabled();
  expect(invoke.mock.calls.some(([name]) => ["select_source", "preflight_translation", "start_translation_import"].includes(name))).toBe(false);
});


it("shows a qualified empty file without a misleading page range or adoption", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_translation_preview"
    ? Promise.resolve({ ...preview, attemptId: args.request.attemptId, total: 0, unique: 0, rows: [] }) : original(command, args));
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" })); await importDeclaredTranslation(user);
  expect(await screen.findByText(/The checked file contains no translation entries/)).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Apply 0 unique matches" })).toBeDisabled();
  expect(invoke.mock.calls.some(([name]) => name === "prepare_translation_adoption")).toBe(false);
});

it("reviews a new checker attempt after cancellation without recapturing the producer", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "cancel_execution_task") {
      const detail = [...pluginAttempts.values()].find(value => value.taskId === args.request.taskId)!;
      detail.items[0].status.execution = "cancelled-before-dispatch"; detail.items[0].status.cancellationRequested = true; detail.items[0].resultId = null;
      detail.progress.succeeded = 0; detail.progress.cancelled = 1; return "1";
    }
    const value = await original(command, args);
    if (command === "start_translation_check") {
      const detail = pluginAttempts.get(String(args.request.attemptId))!;
      detail.items[0].status.execution = "queued"; detail.items[0].status.validation = "absent"; detail.items[0].resultId = null;
      detail.progress.succeeded = 0; detail.progress.queued = 1;
    }
    return value;
  });
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" })); await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract/ })); await user.click(screen.getByRole("button", { name: "Import for review" }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  await user.click(await screen.findByRole("checkbox", { name: /I separately allow this exact checker/ })); await user.click(screen.getByRole("button", { name: "Run independent translation check" }));
  await user.click(await screen.findByRole("button", { name: i18n.t("execution.cancel") }));
  await user.click(await screen.findByRole("button", { name: "Review independent translation check" }));
  expect(await screen.findByRole("button", { name: "Run independent translation check" })).toBeDisabled();
  const checks = invoke.mock.calls.filter(([name]) => name === "prepare_translation_check");
  expect(checks).toHaveLength(2); expect(checks[1][1].request.attemptId).not.toBe(checks[0][1].request.attemptId);
  expect(checks[1][1].request.translationResultId).toEqual(checks[0][1].request.translationResultId);
  expect(invoke.mock.calls.filter(([name]) => name === "preflight_plugin_translation")).toHaveLength(1);
});


it("preserves captured input when installed settings change and blocks new authorization", async () => {
  const original = invoke.getMockImplementation()!; let revision = "1";
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_plugin_translation"
    ? Promise.resolve({ ...translationView, settingsRevision: revision }) : original(command, args));
  const user = userEvent.setup(), view = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(screen.getByRole("button", { name: "Import file" })); await captureDeclaredTranslation(user);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin to extract/ }));
  revision = "2"; view.rerender(<TranslationWorkbench project={project} disabled />); view.rerender(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Refresh installed translation choices" }));
  await screen.findByText(/Extension settings changed after capture/);
  expect(screen.getByText(/Captured i18n\/zh.json/)).toBeVisible(); expect(screen.getByRole("button", { name: "Import for review" })).toBeDisabled();
  expect(invoke.mock.calls.some(([name]) => name === "start_plugin_translation")).toBe(false);
});


it("prepares Native translation input with the approved Host and unchecked separate consent", async () => {
  const { nativeInventory, nativePackage, nativeEnvironment, nativeDigest, nativeOrigin } = await import("./testSupport/pluginNativeFixture");
  const base = invoke.getMockImplementation()!;
  const nativeView = { ...translationView, environment: nativeEnvironment, environmentDigest: nativeDigest, runtimeOrigin: nativeOrigin };
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_plugin_inventory") return nativeInventory(translationInventory);
    if (command === "read_plugin_package") return nativePackage(translationPackage);
    if (command === "read_plugin_translation") return nativeView;
    const value = await base(command, args);
    return command === "select_plugin_translation" || command === "preflight_plugin_translation" ? { ...value, translation: nativeView } : value;
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await captureDeclaredTranslation(user, nativeDigest);
  expect(screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") })).toHaveValue(nativeDigest);
  expect(screen.queryByRole("option", { name: /^Node / })).not.toBeInTheDocument();
  expect(screen.getByText(i18n.t("sourcePlugin.nativeRuntimeDetails", { version: nativeEnvironment.hostVersion, system: "macos", architecture: "aarch64" }))).toBeVisible();
  expect(screen.getByRole("checkbox", { name: i18n.t("translationPlugin.producerConsent") })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Import for review" })).toBeDisabled();
  expect(invoke.mock.calls.find(([command]) => command === "read_plugin_translation")![1].request.environmentDigest).toBe(nativeDigest);
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_translation")).toBe(false);
});

function QueryEditor({ project }: { project: ProjectView }) {
  const resources = useRef<ResourceHandle>(null);
  return <><TranslationWorkbench project={project} disabled={false} onQueryText={text => resources.current?.addQueryText(text) ?? false} />
    <ResourceWorkbench ref={resources} project={project} disabled={false} onOpenTranslation={() => false} /></>;
}

it("adds source and exact draft selection to shared query inputs while retaining unsaved editor text", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_plugin_inventory") return Promise.resolve(toolQueryInventory);
    if (command === "read_plugin_package") return Promise.resolve(toolQueryPackage);
    if (command === "read_plugin_tool") return Promise.resolve(toolQueryView);
    if (command === "read_terms" || command === "list_resource_captures") return Promise.resolve([]);
    return original(command, args);
  });
  render(<QueryEditor project={project} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const input = await screen.findByRole("textbox", { name: "Your draft" });
  const text = "prefix 👩🏽‍💻\ne\u0301 suffix", selected = "👩🏽‍💻\ne\u0301";
  await user.type(input, text);
  await user.click(screen.getByRole("button", { name: "Look up source text" }));
  expect(await screen.findByRole("textbox", { name: "Query text 1" })).toHaveValue("Original");
  expect(invoke.mock.calls.some(([command]) => ["prepare_plugin_tool", "start_plugin_tool", "save_translation_revision"].includes(command))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue(text);
  const currentInput = screen.getByRole("textbox", { name: "Your draft" });
  await user.click(currentInput);
  if (!(currentInput instanceof HTMLTextAreaElement)) throw new Error("Expected the real draft textarea");
  currentInput.setSelectionRange(text.indexOf(selected), text.indexOf(selected) + selected.length);
  fireEvent.select(currentInput);
  await user.click(screen.getByRole("button", { name: "Look up selected draft text" }));
  expect(await screen.findByRole("textbox", { name: "Query text 2" })).toHaveValue(selected);
  expect(screen.getByRole("textbox", { name: "Query text 1" })).toHaveValue("Original");
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue(text);
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  expect(invoke.mock.calls.some(([command]) => ["prepare_plugin_tool", "start_plugin_tool", "save_translation_revision"].includes(command))).toBe(false);
});

it("keeps the editor and its draft when a query route is unavailable and blocks routing during composition", async () => {
  const query = vi.fn(() => false);
  render(<TranslationWorkbench project={project} disabled={false} onQueryText={query} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const input = await screen.findByRole("textbox", { name: "Your draft" });
  await user.type(input, "new input retained");
  fireEvent.compositionStart(input);
  expect(screen.getByRole("button", { name: "Look up source text" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Look up source text" }));
  expect(query).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await user.click(screen.getByRole("button", { name: "Look up source text" }));
  expect(query).toHaveBeenCalledExactlyOnceWith("Original");
  expect(await screen.findByText("Reference queries could not open. Your draft is kept. Finish or check the pending action in Resources, then retry.")).toBeVisible();
  expect(input).toHaveValue("new input retained");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
});

function QueryProbe({ capture }: { capture: (reads: ReturnType<typeof useSessionReads>, owner: ReturnType<typeof useTranslationDraftSession>) => void }) {
  const reads = useSessionReads(), owner = useTranslationDraftSession();
  useLayoutEffect(() => { capture(reads, owner); });
  return null;
}

it.each(["read_content_scope", "read_source_content"])("recovers a failed %s through an explicit source refresh without dispatching a business write", async failedCommand => {
  const original = invoke.getMockImplementation()!;
  let fail = true;
  invoke.mockImplementation((command: string, args: unknown) => command === failedCommand && fail
    ? Promise.reject(new Error("Source read unavailable")) : original(command, args));
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "first" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Back to overview" })).toBeEnabled();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", { name: "first" });
  expect(invoke.mock.calls.filter(([name, payload]) => name === "read_review_summary_page" && payload.request.scopeId === null)).toHaveLength(1);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "select_translation_revision")).toBe(false);
});

it.each(["wrong-unit", "null", "rejected"] as const)("requires a fresh same-unit editor read despite cached success and keeps newer input after %s", async result => {
  seedSelectedTranslation();
  let reads!: ReturnType<typeof useSessionReads>, owner!: ReturnType<typeof useTranslationDraftSession>;
  const ref = createRef<TranslationHandle>(), user = userEvent.setup();
  render(<><QueryProbe capture={(value, draft) => { reads = value; owner = draft; }} /><TranslationWorkbench ref={ref} project={project} disabled={false} /></>, project);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" });
  expect(editor).toHaveValue("Saved base");
  const cached = reads.client.getQueryCache().findAll({ queryKey: reads.key(["translation-editor"]) }).find(query => query.state.status === "success");
  expect(cached?.state.data).toBeDefined();
  const savedCache = cached!.state.data, captured = owner.current()!;
  let finish!: (value: unknown) => void, reject!: (value: unknown) => void;
  const deferred = new Promise<unknown>((resolve, fail) => { finish = resolve; reject = fail; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_editor_snapshot" ? deferred : original(command, args));
  act(() => { expect(ref.current!.openUnit({ unitId: captured.unitId, sourceRevisionId: captured.sourceRevisionId, key: captured.key, sourceText: captured.sourceText }, captured.locale, "Unconfirmed suggestion")).toBe(true); });
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot")).toHaveLength(2));
  expect(editor).toHaveValue("Saved base");
  await user.type(editor, " newer B");
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save and next" })).toBeDisabled();
  const newer = owner.current();
  await act(async () => {
    if (result === "wrong-unit") {
      const response = await original("read_review_editor_snapshot", { request: { unitId: captured.unitId, locale: captured.locale } });
      finish({ ...response, target: { ...response.target, unitId: fixtureIdentity(1800) } });
    } else if (result === "null") finish(null);
    else reject({ code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false });
    await deferred.catch(() => {});
  });
  await screen.findByRole("alert");
  expect(editor).toHaveValue("Saved base newer B"); expect(owner.current()).toBe(newer);
  expect(reads.client.getQueryData(cached!.queryKey)).toEqual(savedCache);
  expect(screen.getByText("Original", { selector: ".editor-source pre" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_editor_snapshot").map(([, payload]) => payload.request))
    .toEqual(Array(2).fill({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: captured.unitId, locale: captured.locale }));
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision")).toBe(false);
});

it("refreshes resource and translation projections on semantic invalidation without rebasing the dirty owner", async () => {
  seedSelectedTranslation();
  let owner!: ReturnType<typeof useTranslationDraftSession>;
  const user = userEvent.setup();
  render(<><QueryProbe capture={(_reads, draft) => { owner = draft; }} /><TranslationWorkbench project={project} disabled={false} /></>, project);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" }); await user.type(editor, " local B");
  const originalDraft = owner.current();
  await user.click(screen.getByText("Terms, context and history"));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    const value = await original(command, args);
    return command === "read_review_editor_snapshot" ? { ...value, context: { ...value.context, text: "Current resource context" } } : value;
  });
  await refreshWorkbenchReads(["resources"]);
  expect(await screen.findByText(/Current resource context/)).toBeVisible();
  seedSelectedTranslation("External selection C");
  await refreshWorkbenchReads(["translation"]);
  await waitFor(() => expect(screen.getByRole("button", { name: "first" })).toHaveTextContent("External selection C"));
  expect(await screen.findByText(i18n.t("translation.historyStale"))).toBeVisible();
  expect(editor).toHaveValue("Saved base local B"); expect(owner.current()).toBe(originalDraft);
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "select_translation_revision")).toBe(false);
});

it("keeps the fixed list scope and draft through a hidden semantic source change until an explicit recapture", async () => {
  seedSelectedTranslation();
  let reads!: ReturnType<typeof useSessionReads>, owner!: ReturnType<typeof useTranslationDraftSession>;
  const ui = <><QueryProbe capture={(value, draft) => { reads = value; owner = draft; }} /><TranslationWorkbench project={project} disabled={false} /></>;
  const user = userEvent.setup(), view = render(ui, project);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), " hidden B");
  const captured = owner.current();
  const captures = invoke.mock.calls.filter(([name, payload]) => name === "read_review_summary_page" && payload.request.scopeId === null).length;
  const original = invoke.getMockImplementation()!, nextSnapshot = fixtureIdentity(1810), nextScope = fixtureIdentity(1811);
  view.rerender(null, project);
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "3", currentSnapshot: nextSnapshot };
    if (command === "read_source_content") return { ...content, snapshotId: nextSnapshot, scope: { revision: "3", currentSnapshot: nextSnapshot } };
    if (command === "read_review_summary_page") {
      if (args.request.scopeId !== null && args.request.scopeId !== nextScope) throw { code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "review-scope-source-changed" };
      return reviewSummaryPageFixture([reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(204), nativeKey: "current entry", sourceText: "Current source",
        sourceSnapshotId: nextSnapshot, sourceRevisionId: fixtureIdentity(1812), translationText: "External fact" }))], { scopeId: nextScope, sourceSnapshotId: nextSnapshot });
    }
    const value = await original(command, args);
    return command === "read_review_editor_snapshot" ? { ...value, target: reviewTargetFixture({ ...value.target, sourceRevisionId: fixtureIdentity(1812), sourceSnapshotId: nextSnapshot, sourceText: "Current source", basisEvidence: undefined }),
      context: { ...value.context, text: "Current hidden resource" } } : value;
  });
  await act(async () => { reads.invalidate(["source", "translation", "resources"]); });
  view.rerender(ui, project);
  await screen.findByRole("alert");
  await user.click(screen.getByText("Terms, context and history"));
  expect(await screen.findByText(/Current hidden resource/)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Saved base hidden B"); expect(owner.current()).toBe(captured);
  expect(screen.getByText("Original", { selector: ".editor-source pre" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name, payload]) => name === "read_review_summary_page" && payload.request.scopeId === null)).toHaveLength(captures);
  await waitFor(() => expect(screen.getByRole("button", { name: "Find" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByRole("button", { name: "current entry" })).toBeVisible();
  expect(owner.current()).toBe(captured);
  expect(invoke.mock.calls.filter(([name, payload]) => name === "read_review_summary_page" && payload.request.scopeId === null)).toHaveLength(captures + 1);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "select_translation_revision")).toBe(false);
});

it("keeps pure neighbor waiting separate from save availability and cancels only its view continuation on return", async () => {
  const original = invoke.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "read_review_summary_page") {
      const page = await original(command, args);
      return { ...page, rows: [...page.rows, { ...page.rows[0], unitId: fixtureIdentity(217), nativeKey: "second" }], total: 2 };
    }
    if (command === "read_review_neighbor") return new Promise(resolve => { finish = resolve; });
    return original(command, args);
  });
  const ref = createRef<TranslationHandle>(), user = userEvent.setup(); render(<TranslationWorkbench ref={ref} project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" }); await user.type(editor, "Local B");
  await user.click(screen.getByRole("button", { name: "Next entry" })); await waitFor(() => expect(finish).toBeDefined());
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled(); expect(await ref.current!.allowNavigate()).toBe(true);
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await act(async () => { finish({ unitId: fixtureIdentity(217), afterOrdinal: 1, sourceSnapshotId: fixtureIdentity(200) }); });
  await user.click(screen.getByRole("button", { name: "Translations" }));
  expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Local B");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "first" })).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_neighbor")).toHaveLength(1);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision")).toBe(false);
});

it("retries a failed history range at its exact cursor while keeping ordinary draft save available", async () => {
  const selected = seedSelectedTranslation(), original = invoke.getMockImplementation()!;
  const revisions = Array.from({ length: 201 }, (_, index) => ({ ...selected.revision, ordinal: String(index + 1),
    revisionId: fixtureIdentity(2000 + index), actionId: fixtureIdentity(2300 + index), text: `Revision ${index + 1}` }));
  let failEarlier = true;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command !== "read_translation_history") return original(command, args);
    const after = Number(args.request.afterOrdinal), limit = Number(args.request.limit);
    if (after === 1 && failEarlier) throw new Error("Earlier history range unavailable");
    const rows = revisions.slice(after, after + limit);
    return { ...history, total: "201", rows, nextOrdinal: after + rows.length < revisions.length ? rows.at(-1)!.ordinal : null };
  });
  let owner!: ReturnType<typeof useTranslationDraftSession>;
  const user = userEvent.setup();
  render(<><QueryProbe capture={(_reads, draft) => { owner = draft; }} /><TranslationWorkbench project={project} disabled={false} /></>, project);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  const editor = await screen.findByRole("textbox", { name: "Your draft" }); await user.type(editor, " retained B");
  const captured = owner.current();
  await user.click(screen.getByText("Terms, context and history"));
  await user.click(screen.getByRole("button", { name: "Refresh history" }));
  const region = screen.getByRole("region", { name: i18n.t("translation.history") });
  await within(region).findByText("201: Revision 201");
  await user.click(within(region).getByRole("button", { name: i18n.t("translation.earlier") }));
  await screen.findByRole("alert");
  expect(editor).toHaveValue("Saved base retained B"); expect(owner.current()).toBe(captured);
  expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  failEarlier = false;
  await user.click(within(region).getByRole("button", { name: "Refresh" }));
  expect(await within(region).findByText("2: Revision 2")).toBeVisible();
  expect(owner.current()).toBe(captured); expect(editor).toHaveValue("Saved base retained B");
  expect(invoke.mock.calls.filter(([name]) => name === "read_translation_history").map(([, payload]) => payload.request))
    .toEqual(["0", "101", "1", "1"].map((afterOrdinal, index) => ({ sessionToken: project.sessionToken, projectId: project.metadata.projectId,
      unitId: selected.revision.unitId, locale: selected.revision.locale, afterOrdinal, limit: index === 0 ? 1 : 100 })));
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "select_translation_revision")).toBe(false);
});

it.each(["translation", "source"] as const)("rechecks the original fixed scope when %s changes before a null-scope capture returns", async changed => {
  const original = invoke.getMockImplementation()!;
  const captured: ReviewSummaryPage = await original("read_review_summary_page", { request: { locale: "zh-CN", query: "", scopeId: null } });
  const stale = { ...captured, rows: captured.rows.map((row: typeof captured.rows[number]) => ({ ...row, translationPreview: "Stale captured translation" })) };
  const current = { ...captured, rows: captured.rows.map((row: typeof captured.rows[number]) => ({ ...row, translationPreview: "Current fixed translation" })) };
  let releaseCapture!: (value: unknown) => void, releaseRead!: (value: unknown) => void, rejectRead!: (reason: unknown) => void;
  const capture = new Promise<unknown>(resolve => { releaseCapture = resolve; });
  const fixedRead = new Promise<unknown>((resolve, reject) => { releaseRead = resolve; rejectRead = reject; });
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_review_summary_page"
    ? args.request.scopeId === null ? capture : fixedRead : original(command, args));
  const user = userEvent.setup(); render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "read_review_summary_page")).toHaveLength(1));
  await refreshWorkbenchReads([changed]);
  await act(async () => { releaseCapture(stale); await capture; });
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "read_review_summary_page")).toHaveLength(2));
  expect(screen.queryByRole("button", { name: "first" })).not.toBeInTheDocument();
  expect(screen.queryByText("Stale captured translation")).not.toBeInTheDocument();
  await act(async () => {
    if (changed === "source") rejectRead({ code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "review-scope-source-changed" });
    else releaseRead(current);
    await fixedRead.catch(() => {});
  });
  if (changed === "source") {
    expect(await screen.findByRole("alert")).toHaveTextContent("The source range changed");
    expect(screen.queryByRole("button", { name: "first" })).not.toBeInTheDocument();
  } else expect(await screen.findByRole("button", { name: "first" })).toHaveTextContent("Current fixed translation");
  expect(screen.queryByText("Stale captured translation")).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_summary_page").map(([, payload]) => payload.request.scopeId)).toEqual([null, captured.scopeId]);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "select_translation_revision")).toBe(false);
});

it("rereads the fixed scope when a semantic change follows its seed before observer subscription without granting navigation from the seed", async () => {
  seedSelectedTranslation(); const original = invoke.getMockImplementation()!;
  const initial: ReviewSummaryPage = await original("read_review_summary_page", { request: { locale: "zh-CN", query: "", scopeId: null } });
  const second = reviewSummaryFor(reviewTargetFixture({ unitId: fixtureIdentity(217), nativeKey: "second", sourceText: "Second source",
    sourceSnapshotId: initial.sourceSnapshotId, sourceRevisionId: fixtureIdentity(218), selectionId: null, revisionId: null, translationText: null }));
  const page = { ...initial, total: 2, rows: [...initial.rows, second] };
  const stale = { ...page, scopeId: fixtureIdentity(810), rows: page.rows.map(row => ({ ...row, translationPreview: "Seed before notification" })) };
  const current = { ...stale, rows: stale.rows.map(row => ({ ...row, translationPreview: "Current fixed scope projection" })) };
  let recapturing = false, releaseCapture!: (value: ReviewSummaryPage) => void, releaseFixed!: (value: ReviewSummaryPage) => void;
  const capture = new Promise<ReviewSummaryPage>(resolve => { releaseCapture = resolve; });
  const fixed = new Promise<ReviewSummaryPage>(resolve => { releaseFixed = resolve; });
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command !== "read_review_summary_page") return original(command, args);
    if (recapturing && args.request.scopeId === null) return capture;
    if (args.request.scopeId === stale.scopeId) return fixed;
    return Promise.resolve(page);
  });
  let reads!: ReturnType<typeof useSessionReads>, owner!: ReturnType<typeof useTranslationDraftSession>, commands!: WorkbenchCommands;
  let notified = false, observersAtNotification = -1, registeredScopes: unknown;
  function SeedWindowProbe() {
    const { memory } = useWorkspaceView();
    useLayoutEffect(() => memory.subscribe("translation", "listReadIntent", () => {
      const intent = memory.read<{ scopeId: string }>("translation", "listReadIntent");
      if (notified || intent?.scopeId !== stale.scopeId) return;
      const seeded = reads.client.getQueryCache().find({ queryKey: reads.key(["translation-list", intent]), exact: true });
      if (!seeded) throw new Error("Published fixed scope has no Query owner");
      notified = true; observersAtNotification = seeded.getObserversCount(); registeredScopes = seeded.meta?.scopes;
      // Publishing the view input follows seeding but precedes observer
      // subscription. Deliver a real semantic invalidation at that boundary.
      reads.invalidate(["translation"]);
    }), [memory]);
    return null;
  }
  const user = userEvent.setup();
  render(<><QueryProbe capture={(value, draft) => { reads = value; owner = draft; }} />
    <SeedWindowProbe /><TranslationWorkbench project={project} disabled={false} /><CommandsProbe capture={value => { commands = value; }} /></>, project);
  await user.click(screen.getByRole("button", { name: "Translations" })); await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(await screen.findByRole("textbox", { name: "Your draft" }), " retained B");
  expect(screen.getByRole("button", { name: "Save and next" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Next entry" })).toBeEnabled();
  const retained = owner.current();
  recapturing = true; await user.click(screen.getByRole("button", { name: "Find" }));
  await act(async () => { releaseCapture(stale); await capture; });
  await waitFor(() => expect(invoke.mock.calls.some(([name, payload]) => name === "read_review_summary_page" && payload.request.scopeId === stale.scopeId)).toBe(true));
  expect(observersAtNotification).toBe(0);
  expect(registeredScopes).toEqual(["source", "translation", "resources", "review"]);
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "translation" as const };
  const assertRetainedAndBlocked = () => {
    expect(owner.current()).toBe(retained);
    expect(screen.getByRole("textbox", { name: "Your draft" })).toHaveValue("Saved base retained B");
    expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save and next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next entry" })).toBeDisabled();
    expect(commands.dispatch("translation.save-and-next", scope)).toBe(false);
  };
  assertRetainedAndBlocked();
  await act(async () => { releaseFixed(current); await fixed; });
  await waitFor(() => expect(screen.getByRole("button", { name: "first" })).toHaveTextContent("Current fixed scope projection"));
  assertRetainedAndBlocked();
  expect(invoke.mock.calls.filter(([name, payload]) => name === "read_review_summary_page" && payload.request.scopeId === stale.scopeId).map(([, payload]) => payload.request))
    .toEqual([{ sessionToken: project.sessionToken, projectId: project.metadata.projectId, locale: "zh-CN", query: "", afterOrdinal: 0, limit: 50, scopeId: stale.scopeId }]);
  expect(invoke.mock.calls.filter(([name, payload]) => name === "read_review_summary_page" && payload.request.scopeId === null)).toHaveLength(2);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "select_translation_revision" || name === "read_review_neighbor")).toBe(false);
});

it.each(["hidden", "import", "different locale"] as const)("confirms an explicit editor activation from %s only after its committed view and fresh read", async from => {
  const original = invoke.getMockImplementation()!, locale = from === "different locale" ? "ja" : "zh-CN";
  const expanded = { ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN", "ja"] } };
  let releaseEditor!: () => void;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_review_editor_snapshot" && args.request.unitId === fixtureIdentity(217)
    ? new Promise(resolve => { releaseEditor = () => resolve(original(command, args)); }) : original(command, args));
  const ref = createRef<TranslationHandle>(); let owner!: ReturnType<typeof useTranslationDraftSession>;
  const user = userEvent.setup();
  render(<><QueryProbe capture={(_reads, draft) => { owner = draft; }} /><TranslationWorkbench ref={ref} project={expanded} disabled={false} /></>, expanded);
  if (from !== "hidden") {
    await user.click(screen.getByRole("button", { name: "Translations" }));
    await screen.findByRole("button", { name: "first" });
    if (from === "import") await user.click(screen.getByRole("button", { name: "Import file" }));
    else { await user.click(screen.getByRole("button", { name: "first" })); await screen.findByRole("textbox", { name: "Your draft" }); }
  }
  const target = { unitId: fixtureIdentity(217), sourceRevisionId: fixtureIdentity(218), key: "Requested entry", sourceText: "Unconfirmed source" };
  act(() => {
    expect(ref.current!.openUnit(target, locale, "Explicit suggested draft")).toBe(true);
    expect(ref.current!.openUnit(target, locale, "Duplicate suggestion")).toBe(false);
  });
  await waitFor(() => expect(releaseEditor).toBeDefined());
  expect(screen.queryByRole("textbox", { name: "Your draft" })).not.toBeInTheDocument();
  expect(owner.current()?.unitId).not.toBe(target.unitId);
  await act(async () => releaseEditor());
  expect(await screen.findByRole("textbox", { name: "Your draft" })).toHaveValue("Explicit suggested draft");
  expect(screen.getByRole("heading", { name: "second" })).toBeInTheDocument();
  expect(owner.current()).toMatchObject({ unitId: target.unitId, locale, sourceRevisionId: fixtureIdentity(205), key: "second", sourceText: "Original", text: "Explicit suggested draft" });
  expect(invoke.mock.calls.filter(([name, payload]) => name === "read_review_editor_snapshot" && payload.request.unitId === target.unitId).map(([, payload]) => payload.request))
    .toEqual([{ sessionToken: expanded.sessionToken, projectId: expanded.metadata.projectId, unitId: target.unitId, locale }]);
  expect(invoke.mock.calls.some(([name]) => name === "create_execution_identity" || name === "save_translation_revision" || name === "select_translation_revision")).toBe(false);
});

it("awaits a failed query destination and preserves newer editor B without leaving", async () => {
  let finish!: (value: boolean) => void;
  const query = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  render(<TranslationWorkbench project={project} disabled={false} onQueryText={query}/>);
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const input = await screen.findByRole("textbox", { name: "Your draft" }); await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
  await user.type(input, "A"); await user.click(screen.getByRole("button", { name: "Look up source text" }));
  await user.type(input, "B"); await act(async () => { finish(false); });
  expect(query).toHaveBeenCalledExactlyOnceWith("Original"); expect(input).toHaveValue("AB");
  expect(screen.getByText(i18n.t("toolQuery.editorUnavailable"))).toBeVisible(); expect(screen.getByRole("button", { name: "Save revision" })).toBeEnabled();
  expect(invoke.mock.calls.some(([name]) => name === "save_translation_revision" || name === "start_plugin_tool")).toBe(false);
});
