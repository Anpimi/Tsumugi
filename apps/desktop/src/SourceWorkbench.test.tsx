import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { createRef } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceWorkbench, type SourceHandle } from "./SourceWorkbench";
import type { ContentPage, SourceChangePage } from "./sourceCommands";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: "project", displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const preview: ContentPage = { snapshotId: null, attemptId: "attempt", resultId: "result", scope: { revision: "1", currentSnapshot: null }, confirmation: { resultDigest: "digest", identityPolicy: "native-key", expectedContentRevision: "1", sourceLanguage: "en-US" }, namespace: "Example.Mod", coverage: [{ artifactId: "file", logicalPath: "i18n/default.json", role: "source", sha256: "hash" }], total: 2, nextOrdinal: 1, diagnostics: [], rows: [{ occurrenceId: null, unitId: null, sourceRevisionId: null, occurrence: { ordinal: 0, artifactId: "file", namespace: "Example.Mod", key: "hello", text: "Unchanged {{name}} 世界", keyByteRange: [1, 8], valueByteRange: [9, 30], identityBasis: "native-key" } }] };
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_source_integration") return { id: "stardew-smapi", version: "0.1.0", available: true, formatProfiles: ["smapi-i18n-flat"] };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: null };
    if (command === "select_source") return { selectionId: "selection", folderName: "Example Mod" };
    if (command === "preflight_source") return { namespace: "Example.Mod", count: 2, sourceLanguage: "en-US", diagnostics: [], files: [] };
    if (command === "create_execution_identity") return executionFixture.prepare.actionId;
    if (command === "start_source_import") return "attempt";
    if (command === "read_execution_attempt") return { ...executionFixture.detail, items: [{ ...executionFixture.detail.items[0], resultId: executionFixture.prepare.resultIds[0], status: { ...executionFixture.detail.items[0].status, execution: "succeeded", validation: "valid" } }] };
    if (command === "read_source_preview") return preview;
    if (command === "prepare_source_adoption" || command === "cancel_source_capture") return {};
    if (command === "adopt_execution" || command === "read_execution_receipt") return { ...executionFixture.receipt, changes: [{ kind: "source-snapshot", id: "snapshot", revision: "2" }] };
    if (command === "read_source_content") return { ...preview, snapshotId: "snapshot", scope: { revision: "2", currentSnapshot: "snapshot" } };
    if (command === "read_source_impact") return { snapshotId: "snapshot", summary: { locale: "zh-CN", preserved: 0, reassess: 0, unresolved: 2, total: 2 }, rows: [], nextOrdinal: null };
    throw new Error(command);
  });
});
afterEach(cleanup);
it.each([["en-US", "Source content", "Source format", "Choose subtitle folder", "I confirm", "Check source files", "This subtitle does not match caption profile 1."], ["zh-CN", "源内容", "源格式", "选择字幕目录", "我确认", "检查源文件", "字幕不符合 profile 1。"]])("selects WebVTT explicitly and recovers from invalid captions in %s", async (locale, entry, format, choose, declaration, check, message) => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!;
  let invalid = true;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_webvtt_integration") return Promise.resolve({ id: "webvtt", version: "0.1.0", available: true, formatProfiles: ["webvtt-captions"] });
    if (command === "select_webvtt_source") return Promise.resolve({ selectionId: "captions", folderName: "Captions" });
    if (command === "preflight_source" && invalid) return Promise.reject({ code: "output-invalid", outcome: "rejected", reason: "vtt-timing" });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: entry }));
  await user.selectOptions(await screen.findByRole("combobox", { name: format }), "webvtt");
  await user.click(await screen.findByRole("button", { name: choose }));
  expect(screen.getByRole("region", { name: choose })).toBeInTheDocument();
  expect(screen.queryByText(/The name default\.json|default\.json 文件名/)).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("select_webvtt_source", { request: { sessionToken: "session", projectId: "project" } });
  await user.click(screen.getByRole("checkbox", { name: new RegExp(declaration) }));
  await user.click(screen.getByRole("button", { name: check }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  invalid = false;
  await user.click(screen.getByRole("button", { name: check }));
  await screen.findByText(/Example\.Mod[:：]/);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("retains an update selection when reopening an already imported project", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_content_scope" ? Promise.resolve({ revision: "2", currentSnapshot: "snapshot" }) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await user.click(await screen.findByRole("button", { name: "Update source content" }));
  await user.click(screen.getByRole("button", { name: "Choose Mod folder" }));
  await screen.findByText("Example Mod");
  const contentReads = invoke.mock.calls.filter(([name]) => name === "read_source_content").length;
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Source content" }));
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check source files" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "read_source_content")).toHaveLength(contentReads);
});

it("ignores a late domain descriptor after the user returns to SMAPI", async () => {
  let complete!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_webvtt_integration" ? new Promise(resolve => { complete = resolve; }) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  const format = await screen.findByRole("combobox", { name: "Source format" });
  await user.selectOptions(format, "webvtt");
  await user.selectOptions(format, "stardew-smapi");
  await act(async () => complete({ id: "webvtt", version: "0.1.0", available: true, formatProfiles: ["webvtt-captions"] }));
  expect(format).toHaveValue("stardew-smapi");
  expect(screen.getByRole("button", { name: "Choose Mod folder" })).toBeEnabled();
});
it.each([
  ["en-US", "Source content", "Choose Mod folder", "I confirm", "Check source files", "Every value in i18n/default.json must be a string."],
  ["zh-CN", "源内容", "选择 Mod 文件夹", "我确认", "检查源文件", "i18n/default.json 中的每个值都必须是字符串。"],
])("explains unsupported source values in %s and allows rechecking", async (locale, entry, choose, declaration, check, message) => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!;
  let invalid = true;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "preflight_source" && invalid) return Promise.reject({ code: "output-invalid", outcome: "rejected", reason: "source-value-not-string" });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: entry }));
  await user.click(await screen.findByRole("button", { name: choose }));
  await user.click(screen.getByRole("checkbox", { name: new RegExp(declaration) }));
  await user.click(screen.getByRole("button", { name: check }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  invalid = false;
  await user.click(screen.getByRole("button", { name: check }));
  await screen.findByText(/Example\.Mod[:：]/);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
async function select() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await user.click(await screen.findByRole("button", { name: "Choose Mod folder" }));
  await screen.findByText("Example Mod");
  return user;
}
async function prepare() {
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("button", { name: "Import for preview" }));
  await screen.findByRole("heading", { name: "Review imported strings" });
  return user;
}
it("requires a language declaration and full-range confirmation, retaining literal source text", async () => {
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  expect(screen.getByText("Unchanged {{name}} 世界")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply to project" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2 strings/ }));
  await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await screen.findByRole("heading", { name: "Imported source content" });
  expect(invoke).toHaveBeenCalledWith("prepare_source_adoption", { request: { sessionToken: "session", projectId: "project", attemptId: "attempt", resultId: "result", actionId: executionFixture.prepare.actionId, confirmation: preview.confirmation } });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});
it("keeps the selection across view changes and requires a decision before leaving the project", async () => {
  const ref = createRef<SourceHandle>();
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  const user = await select();
  expect(screen.getByRole("button", { name: "Check source files" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Source content" }));
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "Stay in project" }));
  expect(await decision).toBe(false);
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "Discard selection and continue" }));
  expect(await decision).toBe(true);
  expect(invoke).toHaveBeenCalledWith("cancel_source_capture", { request: { sessionToken: "session", projectId: "project" } });
});
it("queries a lost acknowledgement without applying a second time", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "adopt_execution") throw { code: "outcome-unknown" };
    if (command === "read_content_scope" && invoke.mock.calls.some(([name]) => name === "read_execution_receipt")) return { revision: "2", currentSnapshot: "snapshot" };
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2/ }));
  await user.click(screen.getByRole("button", { name: "Apply to project" }));
  expect(await screen.findByRole("alert")).toHaveFocus();
  expect(screen.getByRole("button", { name: "Keep output and return" })).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: "Check recorded outcome" }));
  await screen.findByRole("heading", { name: "Imported source content" });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});
it("checks each unknown retry before allowing another retry or return", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "adopt_execution") throw { code: "storage-failed" };
    if (command === "read_execution_receipt") return null;
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2/ }));
  await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await user.click(await screen.findByRole("button", { name: "Check recorded outcome" }));
  await user.click(await screen.findByRole("button", { name: "Retry the same application" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Check recorded outcome" })).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Retry the same application" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Keep output and return" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(2);
});
it("ignores a preflight response invalidated by leaving, and supports Chinese labels", async () => {
  await i18n.changeLanguage("zh-CN");
  const ref = createRef<SourceHandle>();
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "源内容" }));
  await user.click(await screen.findByRole("button", { name: "选择 Mod 文件夹" }));
  await user.click(screen.getByRole("checkbox", { name: /我确认/ }));
  let complete!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "preflight_source" ? new Promise(resolve => { complete = resolve; }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "检查源文件" }));
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "放弃选择并继续" }));
  expect(await decision).toBe(true);
  await act(async () => { complete({ namespace: "STALE", count: 1, diagnostics: [] }); });
  await waitFor(() => expect(screen.queryByText(/STALE/)).not.toBeInTheDocument());
});

function updateComparison(): SourceChangePage {
  const old = { ...preview.rows[0], occurrenceId: "old", unitId: "unit", sourceRevisionId: "source-revision" };
  return { scope: { revision: "2", currentSnapshot: "s1" }, attemptId: "update", resultId: "result", previousSnapshotId: "s1", confirmation: { ...preview.confirmation, expectedContentRevision: "2", expectedCurrentSnapshot: "s1", lineageBaseSnapshot: "s1" }, total: 3, filteredTotal: 3, unchanged: 1, moved: 0, changed: 1, added: 0, ambiguous: 0, removed: 1, nextOrdinal: 1, rows: [{ kind: "changed", old, new: { ...old.occurrence, text: "New source {{name}} 世界" }, candidates: [old] }] };
}

it("keeps identity drafts across filtering and applies the whole range only after reviewing impact", async () => {
  const ref = createRef<SourceHandle>();
  const original = invoke.getMockImplementation()!;
  const comparison = updateComparison();
  invoke.mockImplementation(async (command: string, args: { request?: { filter?: string } }) => {
    if (command === "read_content_scope") return comparison.scope;
    if (command === "read_source_comparison") return { ...comparison, filteredTotal: args.request?.filter ? 1 : 3 };
    if (command === "estimate_source_update") return [{ locale: "zh-CN", preserved: 1, reassess: 1, unresolved: 0, total: 2 }];
    if (command === "adopt_execution") throw { code: "dependency-conflict", outcome: "rejected", reason: "stale-preview" };
    return original(command, args);
  });
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  act(() => ref.current!.showAttempt("update"));
  await screen.findByRole("heading", { name: "Review upstream changes" });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Reviewer for identity decisions" }), "Maintainer");
  await user.selectOptions(screen.getByRole("combobox", { name: "Identity decision" }), "continue:old");
  await user.type(screen.getByRole("textbox", { name: "Reason for this decision" }), "Same content identity with updated wording");
  await user.type(screen.getByRole("textbox", { name: "Find a key, text or change type" }), "hello");
  await user.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText(/1 matching entries; confirmation still covers all 3/)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Reason for this decision" })).toHaveValue("Same content identity with updated wording");
  expect(screen.getByRole("checkbox", { name: /Apply all 3 compared/ })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Review estimated impact" }));
  await user.click(await screen.findByRole("checkbox", { name: /Apply all 3 compared/ }));
  await user.click(screen.getByRole("button", { name: "Apply new source snapshot" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox", { name: "Reason for this decision" })).toHaveValue("Same content identity with updated wording");
  expect(screen.getByRole("button", { name: "Refresh comparison against current source" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Check recorded outcome" })).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("prepare_source_adoption", { request: expect.objectContaining({ confirmation: expect.objectContaining({ expectedCurrentSnapshot: "s1", lineageBaseSnapshot: "s1", lineage: [{ newOrdinal: 0, oldOccurrenceId: "old", decision: "continue", reason: "Same content identity with updated wording" }] }) }) });
});

it("does not overwrite a newer identity draft after a delayed estimate or project leave", async () => {
  const ref = createRef<SourceHandle>();
  const original = invoke.getMockImplementation()!;
  let complete!: (value: unknown) => void;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "read_content_scope") return updateComparison().scope;
    if (command === "read_source_comparison") return updateComparison();
    if (command === "estimate_source_update") return new Promise(resolve => { complete = resolve; });
    return original(command, args);
  });
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  act(() => ref.current!.showAttempt("update"));
  await screen.findByRole("heading", { name: "Review upstream changes" });
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole("combobox", { name: "Identity decision" }), "continue:old");
  await user.type(screen.getByRole("textbox", { name: "Reason for this decision" }), "Preserved draft");
  await user.click(screen.getByRole("button", { name: "Review estimated impact" }));
  expect(screen.getByRole("textbox", { name: "Reason for this decision" })).toBeDisabled();
  let leave!: Promise<boolean>;
  act(() => { leave = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "Stay in project" }));
  expect(await leave).toBe(false);
  await act(async () => complete([{ locale: "zh-CN", preserved: 1, reassess: 1, unresolved: 0, total: 2 }]));
  expect(screen.getByRole("textbox", { name: "Reason for this decision" })).toHaveValue("Preserved draft");
});
