import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceWorkbench, type SourceHandle } from "./SourceWorkbench";
import type { ContentPage, SourceChangePage, SourceAdoptRequest } from "./sourceCommands";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
import executionFixture from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceIntegrationFixture, captionIntegrationFixture, sourceAttemptFixture, sourceActionFixture, sourceReceiptFixture } from "./testSupport/sourceFixture";
import { useSourceDraftSession } from "./SourceDraftSession";
import { useWorkbenchCommands, type SourceBasisCommandPayload } from "./workbenchCommands";
import { validateRequestAdoptionAction } from "./generated/source.validators";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: executionFixture.session.projectId, displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const preview: ContentPage = { snapshotId: null, attemptId: executionFixture.detail.attemptId, resultId: executionFixture.prepare.resultIds[0], scope: { revision: "1", currentSnapshot: null }, confirmation: { ...sourcePageFixture().confirmation, resultDigest: sourcePageFixture().confirmation.resultDigest, identityPolicy: "smapi-native-key/1", expectedContentRevision: "1", sourceLanguage: "en-US" }, namespace: "Example.Mod", coverage: [{ artifactId: fixtureIdentity(101), logicalPath: "i18n/default.json", role: "source", sha256: sourcePageFixture().coverage[0].sha256 }], total: 2, nextOrdinal: 1, diagnostics: [], rows: [{ occurrenceId: null, unitId: null, sourceRevisionId: null, occurrence: { ordinal: 0, artifactId: fixtureIdentity(101), namespace: "Example.Mod", key: "hello", text: "Unchanged {{name}} 世界", keyByteRange: [1, 8], valueByteRange: [9, 30], identityBasis: "smapi-native-key/1" } }] };
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  let identities = 0;
  let prepared: SourceAdoptRequest | null = null;
  invoke.mockImplementation(async (command: string, args: { request?: Record<string, unknown> }) => {
    if (command === "read_source_integration") return sourceIntegrationFixture;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: null };
    if (command === "select_source") return { selectionId: fixtureIdentity(102), folderName: "Example Mod" };
    if (command === "preflight_source") return { namespace: "Example.Mod", count: 2, sourceLanguage: "en-US", diagnostics: [], files: [] };
    if (command === "create_execution_identity") return ++identities === 1 ? executionFixture.detail.attemptId : executionFixture.prepare.actionId;
    if (command === "start_source_import") return args.request!.attemptId;
    if (command === "read_execution_attempt") return sourceAttemptFixture(args.request!.attemptId as string, preview.resultId);
    if (command === "read_source_preview") return { ...preview, attemptId: args.request!.attemptId };
    if (command === "prepare_source_adoption") { prepared = args.request as unknown as SourceAdoptRequest; return sourceActionFixture(prepared); }
    if (command === "read_source_adoption_action") {
      if (!validateRequestAdoptionAction(args.request)) throw new Error("Invalid source action lookup request");
      expect(args.request.adoption).toEqual(prepared);
      return { action: sourceActionFixture(args.request.adoption, args.request.unitId), receipt: sourceReceiptFixture(args.request.adoption, args.request.unitId) };
    }
    if (command === "cancel_source_capture") return null;
    if (command === "read_execution_cancellation_action") return null;
    if (command === "adopt_execution" || command === "read_execution_receipt") return sourceReceiptFixture(prepared!);
    if (command === "read_source_content") return { ...preview, snapshotId: fixtureIdentity(100), scope: { revision: "2", currentSnapshot: fixtureIdentity(100) },
      rows: preview.rows.map(row => ({ ...row, occurrenceId: fixtureIdentity(151), unitId: fixtureIdentity(152), sourceRevisionId: fixtureIdentity(153) })),
      confirmation: { ...preview.confirmation, expectedContentRevision: "2", expectedCurrentSnapshot: fixtureIdentity(100) } };
    if (command === "read_source_impact") return { snapshotId: fixtureIdentity(100), summary: { locale: "zh-CN", preserved: 0, reassess: 0, unresolved: 2, total: 2 }, rows: [], nextOrdinal: null };
    throw new Error(command);
  });
});
afterEach(cleanup);
it("dispatches captured cancellation after Source hides during identity and recovers it even when current task reads fail", async () => {
  const user = userEvent.setup(), ref = createRef<SourceHandle>();
  const original = invoke.getMockImplementation()!;
  let cancellations = 0, cancellationReads = 0, readsFail = false, failedTaskReads = 0, identify!: (value: unknown) => void;
  invoke.mockImplementation(async (command: string, payload: { request?: Record<string, unknown> }) => {
    if (command === "read_execution_attempt") {
      if (readsFail) { failedTaskReads++; throw new Error("Task read unavailable"); }
      const value = sourceAttemptFixture(payload.request!.attemptId as string);
      return { ...value, progress: { ...value.progress, queued: 1, succeeded: 0 },
        items: value.items.map(item => ({ ...item, resultId: null, status: { ...item.status, execution: "queued", validation: "absent" } })) };
    }
    if (command === "create_execution_identity") return new Promise(resolve => { identify = resolve; });
    if (command === "cancel_execution_task") { if (++cancellations === 1) throw new Error("Disconnected"); return "6"; }
    if (command === "read_execution_cancellation_action") {if(++cancellationReads===1)throw new Error("Automatic check unavailable");return null;}
    return original(command, payload);
  });
  const view = render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  act(() => { ref.current!.showAttempt(executionFixture.detail.attemptId); });
  const cancel = await screen.findByRole("button", { name: "Cancel remaining work" });
  await waitFor(() => expect(cancel).toBeEnabled());
  await user.click(cancel);
  await waitFor(() => expect(identify).toBeTypeOf("function"));
  view.rerender(null, project);
  await act(async () => { identify(fixtureIdentity(204)); });
  expect(invoke.mock.calls.filter(([name]) => name === "cancel_execution_task")).toHaveLength(1);
  view.rerender(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  await screen.findByRole("button", { name: i18n.t("execution.checkCancellation") });
  expect(screen.queryByRole("button",{name:i18n.t("execution.retryCancellation")})).not.toBeInTheDocument();
  readsFail = true;
  view.rerender(null, project);
  view.rerender(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  await refreshWorkbenchReads(["execution"]);
  await waitFor(() => expect(failedTaskReads).toBeGreaterThan(0));
  await user.click(screen.getByRole("button",{name:i18n.t("execution.checkCancellation")}));
  await user.click(await screen.findByRole("button", { name: "Retry the original cancellation" }));
  await screen.findByText(/Cancellation request recorded/);
  const requests = invoke.mock.calls.filter(([name]) => name === "cancel_execution_task").map(([, payload]) => payload.request);
  expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toEqual({ sessionToken: project.sessionToken, projectId: project.metadata.projectId,
    taskId: sourceAttemptFixture(executionFixture.detail.attemptId).taskId, requestId: fixtureIdentity(204) });
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Retry the original cancellation" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(0);
});
it.each([["en-US", "Source content", "Source format", "Choose subtitle folder", "I confirm", "Check source files", "This subtitle does not match caption profile 1."], ["zh-CN", "源内容", "源格式", "选择字幕目录", "我确认", "检查源文件", "字幕不符合 profile 1。"]])("selects WebVTT explicitly and recovers from invalid captions in %s", async (locale, entry, format, choose, declaration, check, message) => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!;
  let invalid = true;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_webvtt_integration") return Promise.resolve(captionIntegrationFixture);
    if (command === "select_webvtt_source") return Promise.resolve({ selectionId: fixtureIdentity(103), folderName: "Captions" });
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
  expect(invoke).toHaveBeenCalledWith("select_webvtt_source", { request: { sessionToken: "session", projectId: executionFixture.session.projectId } });
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
  invoke.mockImplementation((command: string, args: unknown) => command === "read_content_scope" ? Promise.resolve({ revision: "2", currentSnapshot: fixtureIdentity(100) }) : original(command, args));
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
  await act(async () => complete(captionIntegrationFixture));
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
  expect(invoke).toHaveBeenCalledWith("prepare_source_adoption", { request: { sessionToken: "session", projectId: executionFixture.session.projectId, attemptId: executionFixture.detail.attemptId, resultId: executionFixture.prepare.resultIds[0], actionId: executionFixture.prepare.actionId, confirmation: preview.confirmation } });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});
it("keeps confirmed application separate from a failed content read and retries only the read", async () => {
  const original = invoke.getMockImplementation()!;
  let unreadable = true;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_source_content" && unreadable
    ? Promise.reject(new Error("Content read unavailable")) : original(command, args));
  const view = render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2 strings/ }));
  await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await screen.findByText("Source content was applied. If reading it fails, retry the read below.");
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Check recorded outcome" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply to project" })).not.toBeInTheDocument();
  view.rerender(null); view.rerender(<SourceWorkbench project={project} disabled={false} />);
  await screen.findByRole("alert");
  unreadable = false;
  await user.click(screen.getByRole("button", { name: "Read applied source content" }));
  await screen.findByRole("heading", { name: "Imported source content" });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption")).toHaveLength(1);
});

it("restores source selection, declaration and preflight when only the view remounts", async () => {
  const view = render(<SourceWorkbench project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await screen.findByRole("button", { name: "Import for preview" });
  view.rerender(null); view.rerender(<SourceWorkbench project={project} disabled={false} />);
  expect(await screen.findByText("Example Mod")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /I confirm/ })).toBeChecked();
  // Reopening verifies the cached current reads before allowing a fresh start.
  await waitFor(() => expect(screen.getByRole("button", { name: "Import for preview" })).toBeEnabled());
  expect(invoke.mock.calls.filter(([name]) => name === "preflight_source")).toHaveLength(1);
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
  expect(invoke).toHaveBeenCalledWith("cancel_source_capture", { request: { sessionToken: "session", projectId: executionFixture.session.projectId } });
});
it.each(["en-US", "zh-CN"])("automatically reads one lost acknowledgement and displays only the actual read phase (%s)", async language => {
  const original = invoke.getMockImplementation()!;
  let loseWrite!: () => void, finishRead!: (value: unknown) => void, applied = false;
  const write = new Promise((_, reject) => { loseWrite = () => reject(new Error("Original source acknowledgement lost")); });
  const lookup = new Promise(resolve => { finishRead = resolve; });
  invoke.mockImplementation((command: string, args: unknown) => command === "adopt_execution" ? write
    : command === "read_source_adoption_action" ? lookup
      : command === "read_content_scope" && applied ? Promise.resolve({ revision: "2", currentSnapshot: fixtureIdentity(100) }) : original(command, args));
  render(<><SourceProbe/><SourceWorkbench project={project} disabled={false}/></>, project);
  const user = await prepare();
  await act(async () => { await i18n.changeLanguage(language); });
  await user.click(screen.getByRole("checkbox", { name: i18n.t("source.confirm", { count: preview.total, language: preview.confirmation.sourceLanguage }) }));
  await user.click(screen.getByRole("button", { name: i18n.t("source.apply") }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1));
  expect(screen.queryByText(i18n.t("source.checkingReceipt"))).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_adoption_action")).toHaveLength(0);
  await act(async () => { loseWrite(); });
  await screen.findByText(i18n.t("source.checkingReceipt"));
  expect(screen.queryByText(i18n.t("source.applyUnknown"))).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: i18n.t("execution.checkReceipt") })).toBeDisabled();
  expect(draft.current()).toMatchObject({ busyMutation: true, failure: null, checkingReceipt: true });
  const request = draft.current().pendingApply!, unitId = draft.current().pendingApplyUnitId!;
  const pendingPayload = { kind: "source-pending" as const, pendingKind: "apply" as const, attemptId: request.attemptId, actionId: request.actionId };
  expect(registry.describe("source.check-receipt", sourceScope, pendingPayload)?.risk).toBe("reads-source");
  await act(async () => { applied = true; finishRead({ action: sourceActionFixture(request, unitId), receipt: sourceReceiptFixture(request, unitId) }); });
  await screen.findByRole("heading", { name: i18n.t("source.imported") });
  expect(draft.current()).toMatchObject({ pendingApply: null, pendingApplyUnitId: null, checkingReceipt: false, failure: null });
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_adoption_action").map(([, args]) => args.request)).toEqual([{ adoption: request, unitId }]);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
});
it("keeps failed automatic reads available for one explicit read without applying a second time", async () => {
  const original = invoke.getMockImplementation()!; let reads = 0;
  invoke.mockImplementation((command: string, args: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Original source acknowledgement lost"))
    : command === "read_source_adoption_action" && reads++ === 0 ? Promise.reject(new Error("Original receipt read unavailable"))
      : command === "read_content_scope" && reads > 1 ? Promise.resolve({ revision: "2", currentSnapshot: fixtureIdentity(100) }) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false}/>); const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2/ })); await user.click(screen.getByRole("button", { name: "Apply to project" }));
  expect(await screen.findByRole("alert")).toHaveFocus();
  expect(screen.getByRole("button", { name: "Keep output and return" })).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: "Check recorded outcome" }));
  await screen.findByRole("heading", { name: "Imported source content" });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "prepare_source_adoption")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_source_adoption_action")).toHaveLength(2);
});
it("checks each unknown retry before allowing another retry or return", async () => {
  const original = invoke.getMockImplementation()!; let reads = 0;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "adopt_execution") throw { code: "storage-failed" };
    if (command === "read_source_adoption_action") { if (++reads !== 2) throw new Error("Original action read temporarily unavailable"); return null; }
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
  await act(async () => { complete({ namespace: "STALE", sourceLanguage: "en", count: 1, files: [], diagnostics: [] }); });
  await waitFor(() => expect(screen.queryByText(/STALE/)).not.toBeInTheDocument());
});

function updateComparison(): SourceChangePage {
  const old = { ...preview.rows[0], occurrenceId: fixtureIdentity(106), unitId: fixtureIdentity(107), sourceRevisionId: fixtureIdentity(108) };
  return { scope: { revision: "2", currentSnapshot: fixtureIdentity(105) }, attemptId: fixtureIdentity(104), resultId: executionFixture.prepare.resultIds[0], previousSnapshotId: fixtureIdentity(105), confirmation: { ...preview.confirmation, expectedContentRevision: "2", expectedCurrentSnapshot: fixtureIdentity(105), lineageBaseSnapshot: fixtureIdentity(105) }, total: 3, filteredTotal: 3, unchanged: 1, moved: 0, changed: 1, added: 0, ambiguous: 0, removed: 1, nextOrdinal: 1, rows: [{ kind: "changed", old, new: { ...old.occurrence, text: "New source {{name}} 世界" }, candidates: [old] }] };
}

it("keeps identity drafts across filtering and applies the whole range only after reviewing impact", async () => {
  const ref = createRef<SourceHandle>();
  const original = invoke.getMockImplementation()!;
  const comparison = updateComparison();
  invoke.mockImplementation(async (command: string, args: { request?: { filter?: string } }) => {
    if (command === "read_content_scope") return comparison.scope;
    if (command === "read_source_comparison") return { ...comparison, filteredTotal: args.request?.filter ? 1 : 3 };
    if (command === "estimate_source_update") return [{ locale: "zh-CN", preserved: 1, reassess: 1, unresolved: 0, total: 2 }];
    if (command === "adopt_execution") throw { code: "dependency-conflict", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false, reason: "stale-preview" };
    return original(command, args);
  });
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  act(() => ref.current!.showAttempt(fixtureIdentity(104)));
  await screen.findByRole("heading", { name: "Review upstream changes" });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Reviewer for identity decisions" }), "Maintainer");
  await user.selectOptions(screen.getByRole("combobox", { name: "Identity decision" }), `continue:${fixtureIdentity(106)}`);
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
  expect(invoke).toHaveBeenCalledWith("prepare_source_adoption", { request: expect.objectContaining({ confirmation: expect.objectContaining({ expectedCurrentSnapshot: fixtureIdentity(105), lineageBaseSnapshot: fixtureIdentity(105), lineage: [{ newOrdinal: 0, oldOccurrenceId: fixtureIdentity(106), decision: "continue", reason: "Same content identity with updated wording" }] }) }) });
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
  act(() => ref.current!.showAttempt(fixtureIdentity(104)));
  await screen.findByRole("heading", { name: "Review upstream changes" });
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole("combobox", { name: "Identity decision" }), `continue:${fixtureIdentity(106)}`);
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

let draft: ReturnType<typeof useSourceDraftSession>, registry: ReturnType<typeof useWorkbenchCommands>;
function SourceProbe() { const value = useSourceDraftSession(), commands = useWorkbenchCommands(); useLayoutEffect(() => { draft = value; registry = commands; }); return null; }
const sourceScope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "source" as const };

it("distinguishes current source from an earlier applied receipt without discarding its confirmed outcome", async () => {
  const original = invoke.getMockImplementation()!;
  let current: string | null = null, revision = "1";
  invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision, currentSnapshot: current };
    if (command === "read_source_content") { const id = payload.request.snapshotId as string; return { ...preview, snapshotId: id, scope: { revision, currentSnapshot: current },
      confirmation: { ...preview.confirmation, expectedContentRevision: revision, expectedCurrentSnapshot: current },
      rows: [{ ...preview.rows[0], occurrenceId: fixtureIdentity(151), unitId: fixtureIdentity(152), sourceRevisionId: fixtureIdentity(153),
        occurrence: { ...preview.rows[0].occurrence, text: id === fixtureIdentity(100) ? "Previously applied source" : "New current source" } }] }; }
    if (command === "read_source_impact") return { snapshotId: current, summary: { locale: "zh-CN", preserved: 0, reassess: 0, unresolved: 2, total: 2 }, rows: [], nextOrdinal: null };
    const result = await original(command, payload);
    if (command === "adopt_execution") { current = fixtureIdentity(100); revision = "2"; }
    return result;
  });
  render(<><SourceProbe/><SourceWorkbench project={project} disabled={false}/></>, project);
  const user = await prepare(); await user.click(screen.getByRole("checkbox", { name: /Apply all 2 strings/ })); await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await screen.findByText("Previously applied source"); const receipt = draft.current().receipt;
  current = fixtureIdentity(200); revision = "3"; await refreshWorkbenchReads(["source"]);
  await user.click(screen.getByRole("button", { name: "View current source content" }));
  await screen.findByText("New current source"); expect(screen.queryByText("Previously applied source")).not.toBeInTheDocument();
  expect(draft.current().receipt).toBe(receipt); expect(draft.current().pendingApply).toBeNull();
  await user.click(screen.getByRole("button", { name: "Read applied source content" })); await screen.findByText("Previously applied source");
  expect(draft.current().receipt).toBe(receipt); expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
});

it.each(["comparison", "preview"] as const)("reads the applied snapshot beside a newer retained %s after a delayed ACK, with independent read recovery and paging", async kind => {
  const ref = createRef<SourceHandle>(), original = invoke.getMockImplementation()!, fixed = updateComparison();
  let scope = kind === "comparison" ? fixed.scope : preview.scope, submitted: SourceAdoptRequest | null = null;
  let finish!: (value: unknown) => void, failContent = true;
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return Promise.resolve(scope);
    if (command === "read_source_comparison") return Promise.resolve(fixed);
    if (command === "estimate_source_update") return Promise.resolve([{ locale: "zh-CN", preserved: 1, reassess: 1, unresolved: 0, total: 2 }]);
    if (command === "prepare_source_adoption") { submitted = payload.request as unknown as SourceAdoptRequest; return Promise.resolve(sourceActionFixture(submitted)); }
    if (command === "adopt_execution") return new Promise(resolve => { finish = resolve; });
    if (command === "read_source_preview") return Promise.resolve({ ...preview, attemptId: payload.request.attemptId, scope,
      confirmation: { ...preview.confirmation, expectedContentRevision: scope.revision, expectedCurrentSnapshot: scope.currentSnapshot },
      ...(payload.request.after ? { nextOrdinal: null, rows: [{ ...preview.rows[0], occurrence: { ...preview.rows[0].occurrence, ordinal: 1, text: "Preview next page" } }] } : {}) });
    if (command === "read_source_content") {
      if (failContent) return Promise.reject(new Error("Applied snapshot read unavailable"));
      return Promise.resolve({ ...preview, snapshotId: payload.request.snapshotId, scope,
        confirmation: { ...preview.confirmation, expectedContentRevision: scope.revision, expectedCurrentSnapshot: scope.currentSnapshot },
        nextOrdinal: payload.request.after ? null : 1, rows: [{ ...preview.rows[0], occurrenceId: fixtureIdentity(151), unitId: fixtureIdentity(152), sourceRevisionId: fixtureIdentity(153),
          occurrence: { ...preview.rows[0].occurrence, ordinal: payload.request.after ? 1 : 0, text: payload.request.after ? "Applied next page" : "Applied first page" } }] });
    }
    if (command === "read_source_impact") return Promise.resolve({ snapshotId: fixtureIdentity(100), summary: { locale: "zh-CN", preserved: 0, reassess: 0, unresolved: 2, total: 2 }, rows: [], nextOrdinal: null });
    return original(command, payload);
  });
  render(<><SourceProbe/><SourceWorkbench ref={ref} project={project} disabled={false}/></>, project);
  const user = userEvent.setup();
  if (kind === "comparison") {
    act(() => ref.current!.showAttempt(fixed.attemptId)); await screen.findByRole("heading", { name: "Review upstream changes" });
    await user.type(screen.getByRole("textbox", { name: "Reviewer for identity decisions" }), "Submitted reviewer");
    await user.selectOptions(screen.getByRole("combobox", { name: "Identity decision" }), `continue:${fixtureIdentity(106)}`);
    await user.type(screen.getByRole("textbox", { name: "Reason for this decision" }), "Submitted reason");
    await user.click(screen.getByRole("button", { name: "Review estimated impact" }));
    await user.click(screen.getByRole("checkbox", { name: /Apply all 3 compared/ }));
    await user.click(screen.getByRole("button", { name: "Apply new source snapshot" }));
  } else {
    await prepare(); await user.click(screen.getByRole("checkbox", { name: /Apply all 2 strings/ }));
    await user.click(screen.getByRole("button", { name: "Apply to project" }));
  }
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const basis = draft.current().comparison ?? draft.current().preview, request = structuredClone(submitted!);
  act(() => { draft.edit("actor", "Newer reviewer"); if (kind === "comparison") draft.edit("lineage", before => ({ ...before, 0: { ...before[0], reason: "Newer reason" } })); });
  if (kind === "comparison") { expect(request.confirmation.actor).toBe("Submitted reviewer"); expect(request.confirmation.lineage?.[0].reason).toBe("Submitted reason"); }
  scope = { revision: (BigInt(request.confirmation.expectedContentRevision) + 1n).toString(), currentSnapshot: fixtureIdentity(100) };
  await act(async () => { finish(sourceReceiptFixture(request)); });
  await screen.findByText("Source content could not be read. Retry this page; saved content and your identity decisions are kept.");
  const receipt = draft.current().receipt;
  expect(receipt?.changes[0].id).toBe(fixtureIdentity(100)); expect(draft.current().pendingApply).toBeNull();
  expect(draft.current().comparison ?? draft.current().preview).toBe(basis); expect(draft.current().actor).toBe("Newer reviewer");
  if (kind === "comparison") expect(draft.current().lineage[0].reason).toBe("Newer reason");
  await user.click(screen.getByRole("button", { name: "Read applied source content" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "read_source_content")).toHaveLength(2));
  const retry = screen.getByRole("button", { name: "Retry this read" }); await waitFor(() => expect(retry).toBeEnabled());
  failContent = false; await user.click(retry); await screen.findByText("Applied first page");
  expect(draft.current().receipt).toBe(receipt); expect(draft.current().comparison ?? draft.current().preview).toBe(basis);
  expect(draft.current().actor).toBe("Newer reviewer"); expect(draft.current().confirmed).toBe(false);
  if (kind === "comparison") expect(screen.getByRole("textbox", { name: "Reason for this decision" })).toHaveValue("Newer reason");
  expect(registry.dispatch("source.begin-update", sourceScope)).toBe(false);
  expect(screen.queryByRole("button", { name: "Update source content" })).not.toBeInTheDocument();
  let content = within(screen.getByRole("heading", { name: "Imported source content" }).closest("section")!);
  const nextContent = content.getByRole("button", { name: "Next page" }); await waitFor(() => expect(nextContent).toBeEnabled());
  await user.click(nextContent);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_source_content", { request: { projectId: project.metadata.projectId, sessionToken: project.sessionToken, snapshotId: fixtureIdentity(100), after: 1, limit: 50 } }));
  await screen.findByText("Applied next page");
  // Changing the exact query removes the empty projection and mounts its new result.
  content = within(screen.getByRole("heading", { name: "Imported source content" }).closest("section")!);
  expect(content.getByText("Applied next page")).toBeInTheDocument();
  expect(draft.current().previewAfter).toBe(0); expect(draft.current().comparisonAfter).toBe(0);
  if (kind === "preview") {
    const fixedView = within(screen.getByRole("heading", { name: "Review imported strings" }).closest("section")!);
    const nextPreview = fixedView.getByRole("button", { name: "Next page" }); await waitFor(() => expect(nextPreview).toBeEnabled());
    await user.click(nextPreview);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_source_preview", { request: { projectId: project.metadata.projectId, sessionToken: project.sessionToken, attemptId: preview.attemptId, resultId: preview.resultId, after: 1, limit: 50 } }));
    await screen.findByText("Source content could not be read. Retry this page; saved content and your identity decisions are kept.");
    content = within(screen.getByRole("heading", { name: "Imported source content" }).closest("section")!);
    expect(draft.current().previewAfter).toBe(1); expect(content.getByText("Applied next page")).toBeInTheDocument();
    expect(draft.current().preview).toBe(basis); expect(screen.queryByText("Preview next page")).not.toBeInTheDocument();
  }
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
});

it("shows no captured first-page rows when a new exact comparison cursor fails, while retaining decisions and typed search", async () => {
  const ref = createRef<SourceHandle>(), original = invoke.getMockImplementation()!, fixed = updateComparison(); let fail = true;
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return Promise.resolve(fixed.scope);
    if (command === "read_source_comparison") {
      const after = payload.request.after as number, query = payload.request.filter;
      if (query === "A" && after === 1 && fail) return Promise.reject(new Error("Next comparison page unavailable"));
      return Promise.resolve(query ? { ...fixed, filteredTotal: 2, nextOrdinal: after ? null : 1, rows: [{ ...fixed.rows[0], new: { ...fixed.rows[0].new!, ordinal: after ? 70 : 0, key: after ? "A-next" : "A-first" } }] } : fixed);
    }
    return original(command, payload);
  });
  render(<><SourceProbe/><SourceWorkbench ref={ref} project={project} disabled={false}/></>, project); act(() => ref.current!.showAttempt(fixed.attemptId));
  await screen.findByRole("heading", { name: "Review upstream changes" }); const user = userEvent.setup();
  await user.selectOptions(screen.getByRole("combobox", { name: "Identity decision" }), `continue:${fixtureIdentity(106)}`);
  await user.type(screen.getByRole("textbox", { name: "Reason for this decision" }), "Keep my reason");
  const basis = draft.current().comparison, input = screen.getByRole("textbox", { name: "Find a key, text or change type" });
  await user.type(input, "A"); await user.click(screen.getByRole("button", { name: "Search" })); await screen.findByText("A-first");
  await user.clear(input); await user.type(input, "B"); await user.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("alert"); expect(screen.queryByText("A-first")).not.toBeInTheDocument(); expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(draft.current().comparison).toBe(basis); expect(draft.current().lineage[0].reason).toBe("Keep my reason"); expect(input).toHaveValue("B");
  fail = false; await user.click(screen.getByRole("button", { name: "Retry this read" })); await screen.findByText("A-next");
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_comparison").slice(-2).map(([, payload]) => payload.request)).toEqual([
    expect.objectContaining({ base: fixed.previousSnapshotId, filter: "A", after: 1, limit: 50 }), expect.objectContaining({ base: fixed.previousSnapshotId, filter: "A", after: 1, limit: 50 })]);
  expect(draft.current().comparison).toBe(basis); expect(draft.current().confirmed).toBe(false);
});

it("does not recapture an automatically refreshed comparison until the user explicitly refreshes the same lineage base", async () => {
  const ref = createRef<SourceHandle>(), original = invoke.getMockImplementation()!, fixed = updateComparison(); let revision = "2";
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    const current = revision === "2" ? fixed.scope.currentSnapshot : fixtureIdentity(200);
    if (command === "read_content_scope") return Promise.resolve({ revision, currentSnapshot: current });
    if (command === "read_source_comparison") return Promise.resolve({ ...fixed, scope: { revision, currentSnapshot: current }, previousSnapshotId: payload.request.base ?? fixed.previousSnapshotId,
      confirmation: { ...fixed.confirmation, expectedContentRevision: revision, expectedCurrentSnapshot: current, lineageBaseSnapshot: payload.request.base ?? fixed.previousSnapshotId } });
    if (command === "estimate_source_update") return Promise.resolve([{ locale: "zh-CN", preserved: 1, reassess: 1, unresolved: 0, total: 2 }]);
    return original(command, payload);
  });
  render(<><SourceProbe/><SourceWorkbench ref={ref} project={project} disabled={false}/></>, project); act(() => ref.current!.showAttempt(fixed.attemptId));
  await screen.findByRole("heading", { name: "Review upstream changes" }); const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Reviewer for identity decisions" }), "Maintainer");
  await user.selectOptions(screen.getByRole("combobox", { name: "Identity decision" }), `continue:${fixtureIdentity(106)}`);
  await user.type(screen.getByRole("textbox", { name: "Reason for this decision" }), "Fixed lineage reason");
  await user.click(screen.getByRole("button", { name: "Review estimated impact" })); await user.click(screen.getByRole("checkbox", { name: /Apply all 3 compared/ }));
  const basis = draft.current().comparison; revision = "3"; await refreshWorkbenchReads(["source"]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh comparison against current source" })).toBeEnabled());
  expect(draft.current().comparison).toBe(basis); expect(draft.current().confirmed).toBe(false); expect(draft.current().estimate).toBeNull();
  expect(screen.getByRole("textbox", { name: "Reason for this decision" })).toHaveValue("Fixed lineage reason");
  await user.click(screen.getByRole("button", { name: "Refresh comparison against current source" }));
  await waitFor(() => expect(draft.current().comparison?.scope.revision).toBe("3"));
  expect(draft.current().comparison?.previousSnapshotId).toBe(fixed.previousSnapshotId); expect(draft.current().lineage[0].reason).toBe("Fixed lineage reason");
  expect(draft.current().actor).toBe("Maintainer"); expect(draft.current().estimate).toBeNull(); expect(draft.current().confirmed).toBe(false);
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption" || command === "adopt_execution")).toHaveLength(0);
});

it("keeps manual candidate pagination on its applied query and assigns the captured new ordinal", async () => {
  const ref = createRef<SourceHandle>(), original = invoke.getMockImplementation()!, fixed = updateComparison();
  invoke.mockImplementation((command: string, payload: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return Promise.resolve(fixed.scope);
    if (command === "read_source_comparison") return Promise.resolve(fixed);
    if (command === "read_source_history_content") return Promise.resolve({ ...preview, snapshotId: fixed.previousSnapshotId, scope: fixed.scope,
      confirmation: fixed.confirmation, total: 2, nextOrdinal: payload.request.after ? null : 1, rows: [{ ...fixed.rows[0].old!, occurrence: { ...fixed.rows[0].old!.occurrence, ordinal: 73, key: "Historical candidate" } }] });
    return original(command, payload);
  });
  render(<><SourceProbe/><SourceWorkbench ref={ref} project={project} disabled={false}/></>, project); act(() => ref.current!.showAttempt(fixed.attemptId));
  await screen.findByRole("heading", { name: "Review upstream changes" }); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Choose another historical item" }));
  const panel = within(screen.getByRole("heading", { name: /Choose correspondence for/ }).closest("section")!);
  const input = panel.getByRole("textbox", { name: "Search historical keys or text" });
  await user.type(input, "A"); await user.click(panel.getByRole("button", { name: "Search" })); await panel.findByText("Historical candidate");
  await user.clear(input); await user.type(input, "B"); await user.click(panel.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_source_history_content", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, snapshotId: fixed.previousSnapshotId, query: "A", after: 1, limit: 20 } }));
  await user.click(await panel.findByRole("button", { name: "Continue content identity" }));
  expect(draft.current().lineage[0]).toMatchObject({ newOrdinal: 0, oldOccurrenceId: fixtureIdentity(106), reason: "" });
  expect(draft.current().lineage[73]).toBeUndefined(); expect(input).toHaveValue("B");
});

it("allows leaving a pure content read and ignores its hidden late result", async () => {
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void, first = true;
  invoke.mockImplementation((command: string, payload: unknown) => {
    if (command === "read_content_scope") return Promise.resolve({ revision: "2", currentSnapshot: fixtureIdentity(100) });
    if (command === "read_source_content" && first) { first = false; return new Promise(resolve => { finish = resolve; }); }
    return original(command, payload);
  });
  render(<SourceWorkbench project={project} disabled={false}/>); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Source content" }));
  await waitFor(() => expect(finish).toBeTypeOf("function")); await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await act(async () => { const page = await original("read_source_content", {}); finish({ ...page, rows: [{ ...page.rows[0], occurrence: { ...page.rows[0].occurrence, text: "Hidden stale text" } }] }); });
  await user.click(screen.getByRole("button", { name: "Source content" })); await screen.findByRole("heading", { name: "Imported source content" });
  expect(screen.queryByText("Hidden stale text")).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_content")).toHaveLength(2);
});

it("rejects stale registry inputs and prevents a fresh application after its consumer unmounts during identity preparation", async () => {
  const view = render(<><SourceProbe/><SourceWorkbench project={project} disabled={false}/></>, project); const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2 strings/ }));
  const basis = draft.current().preview!, payload: SourceBasisCommandPayload = { kind: "source-basis", attemptId: basis.attemptId, resultId: basis.resultId,
    revision: basis.scope.revision, currentSnapshot: basis.scope.currentSnapshot, base: null, editSeq: draft.current().editSeq };
  expect(registry.dispatch("source.apply", sourceScope, { ...payload, resultId: fixtureIdentity(201) })).toBe(false);
  expect(registry.dispatch("source.apply", sourceScope, { ...payload, editSeq: payload.editSeq + 1 })).toBe(false);
  const original = invoke.getMockImplementation()!; let finish!: (value: unknown) => void;
  invoke.mockImplementation((command: string, args: unknown) => command === "create_execution_identity" ? new Promise(resolve => { finish = resolve; }) : original(command, args));
  act(() => { expect(registry.dispatch("source.apply", sourceScope, payload)).toBe(true); expect(registry.dispatch("source.apply", sourceScope, payload)).toBe(false); });
  await waitFor(() => expect(finish).toBeTypeOf("function")); view.rerender(<SourceProbe/>);
  await act(async () => { finish(fixtureIdentity(202)); });
  await waitFor(() => expect(draft.inFlight()).toBe(false));
  expect(draft.current().preview).toBe(basis); expect(draft.current().pendingApply).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "prepare_source_adoption" || command === "adopt_execution")).toHaveLength(0);
});

it("checks the original pending application even when current scope queries fail", async () => {
  const original = invoke.getMockImplementation()!; let reads = 0;
  invoke.mockImplementation((command: string, payload: unknown) => command === "adopt_execution" ? Promise.reject(new Error("Unknown adoption"))
    : command === "read_source_adoption_action" && reads++ === 0 ? Promise.reject(new Error("Original receipt read unavailable"))
    : command === "read_content_scope" && invoke.mock.calls.some(([name]) => name === "adopt_execution") ? Promise.reject(new Error("Current scope unavailable")) : original(command, payload));
  render(<><SourceProbe/><SourceWorkbench project={project} disabled={false}/></>, project); const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2 strings/ })); await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await screen.findByRole("button", { name: "Check recorded outcome" }); const request = draft.current().pendingApply;
  await refreshWorkbenchReads(["source"]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Check recorded outcome" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Check recorded outcome" }));
  await screen.findByText("Source content was applied. If reading it fails, retry the read below.");
  expect(draft.current().pendingApply).toBeNull(); expect(draft.current().receipt?.actionId).toBe(request?.actionId);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
});
