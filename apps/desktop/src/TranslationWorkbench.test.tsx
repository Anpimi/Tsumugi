import { createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationWorkbench, type TranslationHandle } from "./TranslationWorkbench";
import type { ProjectView } from "./projectCommands";
import type { TranslationHistory, TranslationPreview } from "./translationCommands";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: "project", displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const content = { snapshotId: "snapshot", attemptId: "source-attempt", resultId: "source-result", scope: { revision: "2", currentSnapshot: "snapshot" }, confirmation: { resultDigest: "digest", identityPolicy: "native-key", expectedContentRevision: "1", sourceLanguage: "en" }, namespace: "Example.Mod", coverage: [], total: 1, nextOrdinal: null, diagnostics: [], rows: [{ occurrenceId: "occurrence", unitId: "unit", sourceRevisionId: "source-revision", occurrence: { ordinal: 0, artifactId: "source-file", namespace: "Example.Mod", key: "first", text: "Original", keyByteRange: [1, 8], valueByteRange: [9, 19], identityBasis: "native-key" } }] };
const preview: TranslationPreview = { attemptId: "attempt", bundleId: "bundle", fixedSourceSnapshotId: "snapshot", currentSourceSnapshotId: "snapshot", resultDigest: "all-results", fileDigest: "file-digest", logicalPath: "i18n/zh.json", declaredLocale: "zh", targetLocale: "zh-CN", basis: "basis", total: 1, unique: 1, unmatched: 0, ambiguous: 0, selectedConflicts: 0, sourceChanged: 0, applied: 0, nextOrdinal: null, rows: [{ entry: { ordinal: 0, artifactId: "file", nativeKey: "FIRST", text: "你好", keyByteRange: [1, 8], valueByteRange: [9, 19] }, itemId: "item", resultId: "result", resultDigest: "result-digest", unitId: "unit", occurrenceId: "occurrence", sourceRevisionId: "source-revision", sourceText: "Original", currentSelection: null, currentText: null, status: "unique" }] };
const emptyHistory: TranslationHistory = { unitId: "unit", locale: "zh-CN", total: 0, current: null, currentText: null, rows: [], nextOrdinal: null };
let history: TranslationHistory;
let applied: boolean;
let conflicting: boolean;
let identity: number;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset(); history = emptyHistory; applied = false; conflicting = false; identity = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: "snapshot" };
    if (command === "read_source_content") return content;
    if (command === "read_translation_history") return history;
    if (command === "select_source") return { selectionId: "selection", folderName: "Example Mod" };
    if (command === "list_translation_files") return ["zh.json"];
    if (command === "preflight_translation") return { fileName: "zh.json", fileDigest: "file-digest", declaredLocale: "zh", targetLocale: "zh-CN", count: 1, sourceSnapshotId: "snapshot" };
    if (command === "create_execution_identity") return `action-${++identity}`;
    if (command === "start_translation_import") return "attempt";
    if (command === "read_translation_preview") return applied ? { ...preview, unique: 0, applied: 1, rows: [{ ...preview.rows[0], status: "applied" }] } : conflicting ? { ...preview, unique: 0, selectedConflicts: 1, rows: [{ ...preview.rows[0], status: "selected-conflict", currentText: "旧译文", currentSelection: { eventId: "old-selection", unitId: "unit", locale: "zh-CN", sequence: 1, revisionId: "old-revision", actionId: "old-action", previousEventId: null } }] } : preview;
    if (command === "prepare_translation_adoption") return {};
    if (command === "adopt_execution") { applied = true; return { changes: [{ kind: "translation-revision", id: "revision", revision: "1" }] }; }
    if (command === "save_translation_revision") {
      history = { ...emptyHistory, total: 1, current: { eventId: "selected", unitId: "unit", locale: "zh-CN", sequence: 1, revisionId: "manual", actionId: args.request.actionId as string, previousEventId: null }, currentText: args.request.text as string, rows: [{ revisionId: "manual", unitId: "unit", locale: "zh-CN", ordinal: 1, text: args.request.text as string, sourceSnapshotId: "snapshot", sourceRevisionId: "source-revision", originKind: "manual", actionId: args.request.actionId as string, attemptId: null, resultId: null, itemId: null, artifactId: null, logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null }] };
      return history.current;
    }
    if (command === "read_execution_receipt") return null;
    throw new Error(command);
  });
});
afterEach(cleanup);

it("requires language mapping and applies only the reviewed unique result", async () => {
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
  await user.click(await screen.findByRole("button", { name: "Choose Mod folder" }));
  await user.click(await screen.findByRole("button", { name: "Check file" }));
  expect(await screen.findByRole("button", { name: "Import for review" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I confirm that zh.json belongs to zh-CN/ }));
  await user.click(screen.getByRole("button", { name: "Import for review" }));
  await screen.findByRole("heading", { name: "Review translation matches" });
  expect(screen.getByText("你好")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply 1 unique matches" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "prepare_translation_adoption")?.[1].request.confirmation).toMatchObject({ decision: "candidate-only", resultDigest: "result-digest", targetUnitId: "unit" });
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
    ? new Promise(resolve => { complete = value => { history = { ...emptyHistory, total: 1, current: { eventId: "selected", unitId: "unit", locale: "zh-CN", sequence: 1, revisionId: "manual", actionId: args.request.actionId as string, previousEventId: null }, currentText: "A", rows: [] }; resolve(value); }; })
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
  expect(saves[1][1].request).toMatchObject({ text: "AB", expectedSelectionId: "selected" });
});

it("requires a separate comparison and confirmation before replacing a selected translation", async () => {
  conflicting = true;
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
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
  expect(invoke.mock.calls.find(([name]) => name === "prepare_translation_adoption")?.[1].request.confirmation).toMatchObject({ decision: "replace", expectedSelectionId: "old-selection" });
});

it("reports a partial batch without treating an uncommitted conflict as applied", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_translation_preview" && !applied) return Promise.resolve({ ...preview, total: 2, unique: 2, rows: [preview.rows[0], { ...preview.rows[0], entry: { ...preview.rows[0].entry, ordinal: 1, nativeKey: "SECOND" }, itemId: "item-2", resultId: "result-2" }] });
    if (command === "prepare_translation_adoption" && args.request.itemId === "item-2") return Promise.reject({ code: "dependency-conflict", field: "translation-selection" });
    return original(command, args);
  });
  render(<TranslationWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Translations" }));
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
