import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { createRef } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationWorkbench, type TranslationHandle } from "./TranslationWorkbench";
import type { ProjectView } from "./projectCommands";
import type { TranslationHistory, TranslationPreview } from "./translationCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture } from "./testSupport/reviewFixture";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import errorFixture from "../test/fixtures/commandErrors.contract.json";
import { sourcePageFixture } from "./testSupport/sourceFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: fixtureIdentity(900), displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const content = sourcePageFixture({ snapshotId: fixtureIdentity(200), attemptId: fixtureIdentity(201), resultId: fixtureIdentity(202), scope: { revision: "2", currentSnapshot: fixtureIdentity(200) }, confirmation: { ...sourcePageFixture().confirmation, resultDigest: "digest", identityPolicy: "native-key", expectedContentRevision: "1", sourceLanguage: "en" }, namespace: "Example.Mod", coverage: [], total: 1, nextOrdinal: null, diagnostics: [], rows: [{ occurrenceId: fixtureIdentity(203), unitId: fixtureIdentity(204), sourceRevisionId: fixtureIdentity(205), occurrence: { ordinal: 0, artifactId: fixtureIdentity(206), namespace: "Example.Mod", key: "first", text: "Original", keyByteRange: [1, 8], valueByteRange: [9, 19], identityBasis: "native-key" } }] });
const preview: TranslationPreview = { attemptId: fixtureIdentity(210), bundleId: fixtureIdentity(211), fixedSourceSnapshotId: fixtureIdentity(200), currentSourceSnapshotId: fixtureIdentity(200), resultDigest: "all-results", fileDigest: "file-digest", logicalPath: "i18n/zh.json", declaredLocale: "zh", targetLocale: "zh-CN", basis: "basis", total: 1, unique: 1, unmatched: 0, ambiguous: 0, selectedConflicts: 0, sourceChanged: 0, applied: 0, nextOrdinal: null, rows: [{ entry: { ordinal: 0, artifactId: fixtureIdentity(212), nativeKey: "FIRST", text: "你好", keyByteRange: [1, 8], valueByteRange: [9, 19] }, itemId: fixtureIdentity(213), resultId: fixtureIdentity(214), resultDigest: "result-digest", unitId: fixtureIdentity(204), occurrenceId: fixtureIdentity(203), sourceRevisionId: fixtureIdentity(205), sourceText: "Original", currentSelection: null, currentText: null, status: "unique" }] };
const emptyHistory: TranslationHistory = { unitId: fixtureIdentity(204), locale: "zh-CN", total: "0", current: null, currentText: null, rows: [], nextOrdinal: null };
let history: TranslationHistory;
let applied: boolean;
let conflicting: boolean;
let identity: number;
let savedActions: Map<string, ReturnType<typeof saveReceipt>>;
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
  invoke.mockReset(); history = emptyHistory; applied = false; conflicting = false; identity = 0; savedActions = new Map();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(200) };
    if (command === "read_source_content") return content;
    if (command === "read_review_summary_page") return reviewSummaryPageFixture(content.rows.map(row => reviewSummaryFor(reviewTargetFixture({ unitId: row.unitId!, nativeKey: row.occurrence.key, sourceText: row.occurrence.text, sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: row.sourceRevisionId!, selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText, basis: "basis" }))));
    if (command === "read_review_target") return reviewTargetFixture({ unitId: fixtureIdentity(204), nativeKey: "first", sourceText: "Original", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205), selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText, basis: "basis" });
    if (command === "read_review_editor_snapshot") return {
      target: reviewTargetFixture({ unitId: String(args.request.unitId), nativeKey: args.request.unitId === fixtureIdentity(217) ? "second" : "first", sourceText: "Original", sourceSnapshotId: fixtureIdentity(200), sourceRevisionId: fixtureIdentity(205), selectionId: history.current?.eventId ?? null, revisionId: history.current?.revisionId ?? null, translationText: history.currentText, basis: "basis" }),
      translations: history,
      terms: { unitId: args.request.unitId, locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), entries: [{ source: "Original", selected: { revisionId: fixtureIdentity(224), termId: "term", locale: "zh-CN", source: "Original", aliases: [], target: "原文", protected: false, scopeUnitId: null, reason: "Project terminology", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false }, conflicting: [] }] },
      context: { revisionId: fixtureIdentity(225), unitId: args.request.unitId, locale: "zh-CN", text: "Used in the opening screen", reason: "Translator note", previousRevisionId: null },
      readVersion: "view",
    };
    if (command === "read_review_neighbor") return { unitId: fixtureIdentity(217), afterOrdinal: 1, sourceSnapshotId: fixtureIdentity(200) };
    if (command === "read_translation_history") return history;
    if (command === "resolve_terms") return { unitId: fixtureIdentity(204), locale: "zh-CN", sourceRevisionId: fixtureIdentity(205), entries: [{ source: "Original", selected: { revisionId: fixtureIdentity(224), termId: "term", locale: "zh-CN", source: "Original", aliases: [], target: "原文", protected: false, scopeUnitId: null, reason: "Project terminology", originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: null, removed: false }, conflicting: [] }] };
    if (command === "read_context_revision") return { revisionId: fixtureIdentity(225), unitId: fixtureIdentity(204), locale: "zh-CN", text: "Used in the opening screen", reason: "Translator note", previousRevisionId: null };
    if (command === "select_source") return { selectionId: fixtureIdentity(207), folderName: "Example Mod" };
    if (command === "list_translation_files") return ["zh.json"];
    if (command === "preflight_translation") return { fileName: "zh.json", fileDigest: "file-digest", declaredLocale: "zh", targetLocale: "zh-CN", count: 1, sourceSnapshotId: fixtureIdentity(200) };
    if (command === "create_execution_identity") return fixtureIdentity(++identity);
    if (command === "start_translation_import") return fixtureIdentity(210);
    if (command === "read_translation_preview") return applied ? { ...preview, unique: 0, applied: 1, rows: [{ ...preview.rows[0], status: "applied" }] } : conflicting ? { ...preview, unique: 0, selectedConflicts: 1, rows: [{ ...preview.rows[0], status: "selected-conflict", currentText: "旧译文", currentSelection: { eventId: fixtureIdentity(221), unitId: fixtureIdentity(204), locale: "zh-CN", sequence: "1", revisionId: fixtureIdentity(222), actionId: fixtureIdentity(223), previousEventId: null } }] } : preview;
    if (command === "prepare_translation_adoption") return { ...executionFixture.action, projectId: args.request.projectId, actionId: args.request.actionId, attemptId: args.request.attemptId, resultIds: [args.request.resultId], unitId: (args.request.confirmation as { targetUnitId: string }).targetUnitId };
    if (command === "adopt_execution") { applied = true; return { ...executionFixture.receipt, actionId: args.request.actionId, changes: [{ kind: "translation-revision", id: "revision", revision: "1" }] }; }
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
    if (command === "start_translation_import" && delayStart) {
      delayStart = false;
      return new Promise(resolve => { releaseStart = () => resolve(fixtureIdentity(210)); });
    }
    if (command === "adopt_execution") return Promise.reject({ code: "outcome-unknown", outcome: "unknown", stage: "adopt", recoveryRequired: true });
    if (command === "read_execution_receipt") return null;
    return originalInvoke(command, args);
  });
  const user = userEvent.setup();
  const { rerender } = render(<TranslationWorkbench project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await user.click(await screen.findByRole("button", { name: "Choose Mod folder" }));
  await user.click(await screen.findByRole("button", { name: "Check file" }));
  await user.click(screen.getByRole("checkbox", { name: /I confirm that zh.json belongs to zh-CN/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  await waitFor(() => expect(releaseStart).toBeDefined());
  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["ja-JP"], metadataRevision: "2" } }} disabled={false} />);
  await act(async () => releaseStart());
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByRole("button", { name: "Apply 1 unique matches" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "start_translation_import")).toHaveLength(1);

  rerender(<TranslationWorkbench project={{ ...project, metadata: { ...project.metadata, targetLocales: ["zh-CN"], metadataRevision: "3" } }} disabled={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Apply 1 unique matches" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
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
  expect(screen.getByRole("alert")).toHaveTextContent("zh-CN");
  expect(screen.getByRole("alert")).toHaveTextContent(/restore|project settings/i);
  expect(screen.getByRole("button", { name: "Back to project settings, keep this work" })).toBeEnabled();
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
  await user.click(await screen.findByRole("button", { name: "Choose Mod folder" }));
  await user.click(await screen.findByRole("button", { name: "Check file" }));
  expect(await screen.findByRole("button", { name: "Import for review" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I confirm that zh.json belongs to zh-CN/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByText("你好")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "prepare_translation_adoption")?.[1].request.confirmation).toMatchObject({ decision: "candidate-only", resultDigest: "result-digest", targetUnitId: fixtureIdentity(204) });
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
  await user.click(await screen.findByRole("button", { name: "Choose Mod folder" }));
  await user.click(await screen.findByRole("button", { name: "Check file" }));
  await user.click(screen.getByRole("checkbox", { name: /I confirm that zh.json/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
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
    if (command === "read_translation_preview" && !applied) return Promise.resolve({ ...preview, total: 2, unique: 2, rows: [preview.rows[0], { ...preview.rows[0], entry: { ...preview.rows[0].entry, ordinal: 1, nativeKey: "SECOND" }, itemId: fixtureIdentity(215), resultId: fixtureIdentity(216) }] });
    if (command === "prepare_translation_adoption" && args.request.itemId === fixtureIdentity(215)) return Promise.reject({ code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "translation-selection" });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await user.click(await screen.findByRole("button", { name: "Choose Mod folder" }));
  await user.click(await screen.findByRole("button", { name: "Check file" }));
  await user.click(screen.getByRole("checkbox", { name: /I confirm that zh.json/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  await screen.findByRole("button", { name: "Apply 2 unique matches" });
  await user.click(screen.getByRole("button", { name: "Apply 2 unique matches" }));
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
