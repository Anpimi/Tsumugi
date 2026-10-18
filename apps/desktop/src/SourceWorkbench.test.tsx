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
import commandErrors from "../test/fixtures/commandErrors.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { sourcePageFixture, sourceRowFixture, sourceAttemptFixture, sourceActionFixture, sourceReceiptFixture, sourceHistoryFixture } from "./testSupport/sourceFixture";
import { hookObservation } from "./testSupport/sourceMaintenanceHookFixture";
import { pluginSourceView, pluginSourceWorkflow, pluginSourceRequest, pluginSourceInventory, pluginSourcePackage } from "./testSupport/pluginSourceFixture";
import { useSessionReads } from "./SessionReadProvider";
import { useSourceDraftSession } from "./SourceDraftSession";
import { useWorkbenchCommands, type SourceBasisCommandPayload } from "./workbenchCommands";
import { validateRequestAdoptionAction } from "./generated/source.validators";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: executionFixture.session.projectId, displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const preview: ContentPage = sourcePageFixture({ snapshotId: null, attemptId: executionFixture.detail.attemptId, resultId: executionFixture.prepare.resultIds[0], scope: { revision: "1", currentSnapshot: null }, confirmation: { ...sourcePageFixture().confirmation, resultDigest: sourcePageFixture().confirmation.resultDigest, identityPolicy: sourcePageFixture().confirmation.identityPolicy, expectedContentRevision: "1", sourceLanguage: "en-US" }, namespace: "Example.Mod", coverage: [{ artifactId: fixtureIdentity(101), logicalPath: "i18n/default.json", role: "source", sha256: sourcePageFixture().coverage[0].sha256 }], total: 2, nextOrdinal: 1, diagnostics: [], rows: [sourceRowFixture({}, { ordinal: 0, artifactId: fixtureIdentity(101), namespace: "Example.Mod", key: "hello", text: "Unchanged {{name}} 世界", source: { artifactId: fixtureIdentity(101), range: { encoding: "utf8-byte", start: 9, end: 30 } } })] });
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  let identities = 0;
  let prepared: SourceAdoptRequest | null = null;
  invoke.mockImplementation(async (command: string, args: { request?: Record<string, unknown> }) => {
    if (command === "read_plugin_inventory") return pluginSourceInventory;
    if (command === "read_plugin_package") return pluginSourcePackage;
    if (command === "read_plugin_source") return pluginSourceView;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: null };
    if (command === "select_plugin_source") return { ...pluginSourceWorkflow.selection, selectionId: fixtureIdentity(102), folderName: "Example Mod" };
    if (command === "preflight_plugin_source") return { ...pluginSourceWorkflow.preflight, attemptId: args.request!.attemptId, sourceLanguage: "en-US" };
    if (command === "create_execution_identity") return ++identities === 1 ? executionFixture.detail.attemptId : executionFixture.prepare.actionId;
    if (command === "start_plugin_source") return args.request!.attemptId;
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

it("discovers a saved notice by the canonical history action identity without enabling or rerunning it", async () => {
  const original = invoke.getMockImplementation()!, history = sourceHistoryFixture(), actionId = history.snapshots[0].actionId;
  const notice = hookObservation(actionId, undefined, "interrupted"); notice.view!.cause!.projectId = project.metadata.projectId;
  invoke.mockImplementation((command, args) => command === "read_source_history" ? Promise.resolve(history)
    : command === "read_source_maintenance_hook" ? Promise.resolve(notice) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false}/>); const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("source.title") }));
  await user.click(screen.getByRole("button", { name: i18n.t("source.history") }));
  await user.click((await screen.findAllByRole("button", { name: i18n.t("sourceHook.history") }))[0]);
  await screen.findByText(i18n.t("sourceHook.phase", { locale: "zh-CN", phase: i18n.t("sourceHook.phases.interrupted") }));
  expect(invoke).toHaveBeenCalledWith("read_source_maintenance_hook", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, sourceActionId: actionId } });
  expect(screen.getByRole("heading", { name: i18n.t("sourceHook.statusTitle") })).toHaveFocus();
  expect(invoke.mock.calls.some(([command]) => ["read_source_maintenance_hook_session", "prepare_source_adoption", "adopt_execution", "stop_source_maintenance_hook"].includes(command))).toBe(false);
});

it("shows bounded saved source failure detail as text and retries only its failed read", async () => {
  const original = invoke.getMockImplementation()!;
  const failed = sourceAttemptFixture(executionFixture.detail.attemptId, preview.resultId);
  failed.progress.succeeded = 0;
  failed.progress.failed = 1;
  failed.items[0].status.execution = "failed";
  failed.items[0].status.validation = "invalid";
  failed.items[0].status.diagnostic = "source-corrupt";
  failed.recovery.units[0].actions = [];
  const literalDetail = '<a href="https://example.invalid">bad source</a>';
  let reads = 0;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_execution_attempt") return Promise.resolve(failed);
    if (command === "read_execution_output") {
      reads++;
      return reads === 1 ? Promise.reject({ code: "busy", outcome: "rejected" }) : Promise.resolve({ ...executionFixture.output,
        projectId: project.metadata.projectId, attemptId: failed.attemptId, resultId: failed.items[0].resultId,
        itemId: failed.items[0].status.itemId, outcome: "failed", sourceFailure: { code: "invalid-source", artifactId: "captured-1", detail: literalDetail } });
    }
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("checkbox", { name: /I allow this exact plugin/ }));
  await user.click(screen.getByRole("button", { name: "Import for preview" }));
  expect(await screen.findByText(i18n.t("execution.failureReadFailed"))).toBeVisible();
  expect(screen.getByText(i18n.t("source.errors.invalid"))).toBeVisible();
  expect(screen.queryByText(literalDetail, { exact: false })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: i18n.t("source.retryRead") }));
  const diagnostic = await screen.findByText(i18n.t("execution.diagnostic"));
  await user.click(diagnostic);
  expect(screen.getByText(literalDetail, { exact: false })).toBeVisible();
  expect(screen.getByText("captured-1")).toBeVisible();
  expect(document.querySelector('a[href="https://example.invalid"]')).toBeNull();
  expect(reads).toBe(2);
  expect(invoke.mock.calls.some(([name]) => name === "prepare_source_adoption" || name === "adopt_execution")).toBe(false);
});

it("hides a late failed-source result after selecting another attempt", async () => {
  const original = invoke.getMockImplementation()!;
  const ref = createRef<SourceHandle>();
  const laterAttempt = fixtureIdentity(239);
  const failed = sourceAttemptFixture(executionFixture.detail.attemptId, preview.resultId);
  failed.progress.succeeded = 0; failed.progress.failed = 1;
  failed.items[0].status.execution = "failed";
  failed.items[0].status.diagnostic = "source-corrupt";
  let complete!: (value: unknown) => void;
  const late = new Promise(resolve => { complete = resolve; });
  invoke.mockImplementation((command: string, args: { request?: { attemptId?: string } }) => {
    if (command === "read_execution_attempt") {
      if (args.request?.attemptId === laterAttempt) {
        const next = sourceAttemptFixture(laterAttempt, preview.resultId);
        next.items[0].resultId = null; next.items[0].status.execution = "queued";
        return Promise.resolve(next);
      }
      return Promise.resolve(failed);
    }
    if (command === "read_execution_output") return late;
    return original(command, args);
  });
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("checkbox", { name: /I allow this exact plugin/ }));
  await user.click(screen.getByRole("button", { name: "Import for preview" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "read_execution_output")).toBe(true));
  act(() => ref.current!.showAttempt(laterAttempt));
  await act(async () => complete({ ...executionFixture.output, projectId: project.metadata.projectId,
    resultId: preview.resultId, itemId: failed.items[0].status.itemId,
    sourceFailure: { code: "invalid-source", artifactId: null, detail: "Previous attempt failure" } }));
  expect(screen.queryByText("Previous attempt failure", { exact: false })).not.toBeInTheDocument();
  expect(screen.queryByText("source-corrupt")).not.toBeInTheDocument();
});

it("returns from failed extraction to current content without retaining failure or losing newer preparation text", async () => {
  const original = invoke.getMockImplementation()!, ref = createRef<SourceHandle>();
  const failed = sourceAttemptFixture(executionFixture.detail.attemptId, preview.resultId);
  failed.progress.succeeded = 0; failed.progress.failed = 1;
  failed.items[0].status.execution = "failed";
  failed.items[0].status.diagnostic = "plugin-failed";
  let complete!: (value: unknown) => void;
  const output = new Promise(resolve => { complete = resolve; });
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_content_scope") return Promise.resolve({ revision: "2", currentSnapshot: fixtureIdentity(100) });
    if (command === "read_execution_attempt") return Promise.resolve(failed);
    if (command === "read_execution_output") return output;
    return original(command, args);
  });
  render(<><SourceProbe/><SourceWorkbench ref={ref} project={project} disabled={false}/></>, project);
  act(() => ref.current!.showAttempt(failed.attemptId));
  expect(await screen.findByText(i18n.t("source.errors.failed"))).toBeVisible();
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "read_execution_output")).toBe(true));
  act(() => { draft.edit("actor", "Newer reviewer"); draft.edit("filter", "Retained search"); });
  await userEvent.setup().click(screen.getByRole("button", { name: "View current source content" }));
  await screen.findByText("Unchanged {{name}} 世界");
  expect(screen.queryByText(i18n.t("source.errors.failed"))).not.toBeInTheDocument();
  expect(draft.current().attempt).toBeNull();
  expect(draft.current().actor).toBe("Newer reviewer");
  expect(draft.current().filter).toBe("Retained search");
  await act(async () => complete({ ...executionFixture.output, projectId: project.metadata.projectId,
    attemptId: failed.attemptId, resultId: preview.resultId, itemId: failed.items[0].status.itemId,
    sourceFailure: { code: "invalid-source", artifactId: null, detail: "Old extraction reason" } }));
  expect(screen.queryByText("Old extraction reason", { exact: false })).not.toBeInTheDocument();
  expect(screen.queryByText(i18n.t("source.errors.failed"))).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([name]) => ["cancel_source_capture", "start_plugin_source", "prepare_source_adoption", "adopt_execution"].includes(name))).toBe(false);
});
it("discovers multiple enabled source packages without competing for the installed Store", async () => {
  const original = invoke.getMockImplementation()!;
  const second = { ...pluginSourcePackage, packageDigest: "d".repeat(64),
    manifest: { ...pluginSourcePackage.manifest, plugin: { ...pluginSourcePackage.manifest.plugin, id: "synthetic-caption" } } };
  const reference = { ...pluginSourcePackage, packageDigest: "c".repeat(64),
    manifest: { ...pluginSourcePackage.manifest, plugin: { ...pluginSourcePackage.manifest.plugin, id: "synthetic-reference" }, contributions: [] } };
  const packages = [pluginSourcePackage, second, reference];
  const inventory = { ...pluginSourceInventory,
    packages: packages.map(item => ({ ...pluginSourceInventory.packages[0], plugin: item.manifest.plugin, packageDigest: item.packageDigest })),
    packageDecisions: packages.map(item => ({ ...pluginSourceInventory.packageDecisions[0], plugin: item.manifest.plugin, packageDigest: item.packageDigest })) };
  let active = false;
  let release!: () => void;
  const firstRead = new Promise<void>(resolve => { release = resolve; });
  let releaseRefresh!: () => void;
  const refreshRead = new Promise<void>(resolve => { releaseRefresh = resolve; });
  let releaseReopen!: () => void;
  const reopenRead = new Promise<void>(resolve => { releaseReopen = resolve; });
  let reads = 0;
  let inventories = 0;
  let environments = 0;
  invoke.mockImplementation(async (command: string, args: { request?: { packageDigest?: string } }) => {
    if (!["read_plugin_inventory", "read_plugin_package", "read_plugin_source"].includes(command)) return original(command, args);
    if (active) throw { code: "busy", stage: "read", outcome: "rejected", recoveryRequired: false, reason: "plugin-store-busy" };
    active = true;
    try {
      if (command === "read_plugin_inventory") {
        if (++inventories === 2) await refreshRead;
        if (inventories === 3) await reopenRead;
        return inventory;
      }
      if (command === "read_plugin_source") { environments++; return pluginSourceView; }
      if (++reads === 1) await firstRead;
      const value = packages.find(item => item.packageDigest === args.request?.packageDigest);
      if (!value) throw new Error("Unexpected package read");
      return value;
    } finally { active = false; }
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await waitFor(() => expect(reads).toBe(1));
  await act(async () => { release(); });
  await chooseSourcePackage(user);
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose source folder" })).toBeEnabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const choices = within(screen.getByRole("combobox", { name: "Source format" })).getAllByRole("option");
  expect(choices.filter(option => { if (!(option instanceof HTMLOptionElement)) throw new Error("Expected a real source choice option"); return option.value !== ""; }).map(option => option.textContent)).toEqual(packages.slice(0, 2).map(item => `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${pluginSourceRequest.resourceId}`));
  expect(choices.some(option => option.textContent?.includes(reference.manifest.plugin.id))).toBe(false);
  expect(reads).toBe(3);
  expect(environments).toBe(1);
  await user.click(screen.getByRole("button", { name: "Refresh installed source choices" }));
  await waitFor(() => expect(inventories).toBe(2));
  expect(environments).toBe(1);
  expect(screen.getByRole("button", { name: "Choose source folder" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh installed source choices" })).toBeDisabled();
  await act(async () => { releaseRefresh(); });
  await waitFor(() => expect(reads).toBe(6));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose source folder" })).toBeEnabled());
  expect(environments).toBe(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await waitFor(() => expect(inventories).toBe(3));
  expect(environments).toBe(2);
  await act(async () => { releaseReopen(); });
  await waitFor(() => expect(reads).toBe(9));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose source folder" })).toBeEnabled());
  expect(environments).toBe(3);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
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
it.each([["en-US", "Source content", "Choose source folder", "I confirm", "Check source files"], ["zh-CN", "源内容", "选择源文件夹", "我确认", "检查源文件"]])("loads installed source declarations and recovers from a rejected capture in %s", async (locale, entry, choose, declaration, check) => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!;
  let invalid = true;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "preflight_plugin_source" && invalid) return Promise.reject({ code: "invalid-input", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "missing-companion" });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: entry }));
  await chooseSourcePackage(user);
  await waitFor(() => expect(screen.getByRole("button", { name: choose })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: choose }));
  expect(invoke).toHaveBeenCalledWith("select_plugin_source", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, source: pluginSourceRequest } });
  await user.click(screen.getByRole("checkbox", { name: new RegExp(declaration) }));
  await user.click(screen.getByRole("button", { name: check }));
  expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("source.errors.missing"));
  expect(screen.queryByRole("button", { name: i18n.t("sourcePlugin.retryOriginal") })).not.toBeInTheDocument();
  const failedRequest = invoke.mock.calls.find(([name]) => name === "preflight_plugin_source")![1];
  invalid = false;
  await user.click(screen.getByRole("button", { name: check }));
  await screen.findByRole("button", { name: locale === "zh-CN" ? "导入并预览" : "Import for preview" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "preflight_plugin_source")[1][1]).toEqual({ request: {
    ...failedRequest.request, attemptId: executionFixture.prepare.actionId,
  } });
  expect(failedRequest.request.attemptId).toBe(executionFixture.detail.attemptId);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(2);
});

it.each(["en-US", "zh-CN"])("reconciles an unknown capture with its complete original request in %s", async locale => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!; let unknown = true;
  invoke.mockImplementation((command: string, args: unknown) => command === "preflight_plugin_source" && unknown
    ? Promise.reject(new Error("Capture confirmation unavailable")) : original(command, args));
  render(<><SourceProbe /><SourceWorkbench project={project} disabled={false} /></>, project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("source.title") }));
  await chooseSourcePackage(user);
  const choose = screen.getByRole("button", { name: i18n.t("sourcePlugin.chooseFolder") });
  await waitFor(() => expect(choose).toBeEnabled()); await user.click(choose);
  await user.click(screen.getByRole("checkbox", { name: i18n.t("source.language", { language: project.metadata.sourceLocale }) }));
  await user.click(screen.getByRole("button", { name: i18n.t("source.preflight") }));
  expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("source.errors.failed"));
  expect(screen.getByText(i18n.t("sourcePlugin.operationUnknown"))).toBeVisible();
  expect(screen.getByRole("button", { name: i18n.t("source.preflight") })).toBeDisabled();
  expect(screen.getByRole("button", { name: i18n.t("source.discard") })).toBeDisabled();
  const request = invoke.mock.calls.find(([name]) => name === "preflight_plugin_source")![1];
  const pending = draft.current().pendingPlugin; expect(pending).not.toBeNull();
  const retry = screen.getByRole("button", { name: i18n.t("sourcePlugin.retryOriginal") });
  await waitFor(() => expect(retry).toBeEnabled()); expect(draft.current().pendingPlugin).toBe(pending);
  unknown = false;
  await user.click(retry);
  await waitFor(() => expect(draft.current().pendingPlugin).toBeNull());
  await screen.findByRole("button", { name: i18n.t("source.start") });
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(invoke.mock.calls.filter(([name]) => name === "preflight_plugin_source").map(([,args]) => args)).toEqual([request, request]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_execution_attempt")).toHaveLength(0);
});

it("retains an update selection when reopening an already imported project", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_content_scope" ? Promise.resolve({ revision: "2", currentSnapshot: fixtureIdentity(100) }) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await user.click(await screen.findByRole("button", { name: "Update source content" }));
  await chooseSourcePackage(user);
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose source folder" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Choose source folder" }));
  await screen.findByText("Example Mod");
  const contentReads = invoke.mock.calls.filter(([name]) => name === "read_source_content").length;
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Source content" }));
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check source files" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "read_source_content")).toHaveLength(contentReads);
});

it("prevents competing refresh and ignores an outdated source environment after leaving the view", async () => {
  let complete!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  let reads = 0;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_plugin_source" && reads++ === 0) return new Promise(resolve => { complete = resolve; });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await chooseSourcePackage(user);
  await waitFor(() => expect(reads).toBe(1));
  expect(screen.getByRole("button", { name: "Refresh installed source choices" })).toBeDisabled();
  expect(within(screen.getByRole("region", { name: i18n.t("sourcePlugin.importControls") })).getByText(i18n.t("execution.working"))).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await act(async () => complete({ ...pluginSourceView, declaration: { ...pluginSourceView.declaration, displayName: "STALE ENVIRONMENT" } }));
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose source folder" })).toBeEnabled());
  expect(screen.queryByText("STALE ENVIRONMENT")).not.toBeInTheDocument();
  expect(screen.queryByText(i18n.t("execution.working"))).not.toBeInTheDocument();
});
async function chooseSourcePackage(user: ReturnType<typeof userEvent.setup>, runtime = pluginSourceRequest.environmentDigest) {
  await user.selectOptions(await screen.findByRole("combobox", { name: i18n.t("source.integration") }), `${pluginSourceRequest.package.packageDigest}:${pluginSourceRequest.resourceId}`);
  await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") }), runtime);
}
async function select(runtime = pluginSourceRequest.environmentDigest, folderName = "Example Mod") {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await chooseSourcePackage(user, runtime);
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose source folder" })).toBeEnabled());
  await user.click(await screen.findByRole("button", { name: "Choose source folder" }));
  await screen.findByText(folderName);
  return user;
}
async function prepare() {
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("checkbox", { name: /I allow this exact plugin/ }));
  await user.click(screen.getByRole("button", { name: "Import for preview" }));
  await screen.findByRole("heading", { name: "Review imported strings" });
  return user;
}
it.each([
  ["utf8-byte", "UTF-8 bytes"], ["utf16", "UTF-16 code units"], ["grapheme", "Grapheme clusters"],
] as const)("shows the captured path and original %s range without interpreting domain metadata", async (encoding, label) => {
  const original = invoke.getMockImplementation()!;
  const page = sourcePageFixture({ ...preview, nextOrdinal: null, total: 1,
    coverage: [{ ...preview.coverage[0], logicalPath: "captions/episode-01.vtt" }],
    rows: [sourceRowFixture({}, { ...preview.rows[0].occurrence,
      key: "operation-label-123", identityBasis: JSON.stringify({ policy: "webvtt-cue/1", timing: "hidden-domain-timing" }),
      source: { artifactId: fixtureIdentity(101), range: { encoding, start: 8, end: 27 } },
      nativeIdentity: { namespace: "captions", value: "canonical-cue",
        policy: { id: "fixture-identity", schemaVersion: 1, behaviorVersion: 1 }, display: { value: "Original Cue", source: null } },
    })] });
  invoke.mockImplementation((command: string, args: unknown) => command === "read_source_preview" ? Promise.resolve(page) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  expect(screen.getByText("Original Cue")).toBeInTheDocument();
  expect(screen.queryByText("canonical-cue")).not.toBeInTheDocument();
  expect(screen.queryByText("operation-label-123")).not.toBeInTheDocument();
  expect(screen.queryByText("hidden-domain-timing")).not.toBeInTheDocument();
  await user.click(screen.getByText("Source location and identity"));
  expect(screen.getByText(`Original text · captions/episode-01.vtt · ${label} range [8, 27)`)).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command === "read_source_history_content")).toHaveLength(0);
});

it("labels an unnamed occurrence without displaying operation-local IDs or an invented file path", async () => {
  const original = invoke.getMockImplementation()!;
  const page = sourcePageFixture({ ...preview, nextOrdinal: null, total: 1, coverage: [],
    rows: [sourceRowFixture({}, { ...preview.rows[0].occurrence, ordinal: 1, key: "operation-label-123",
      operationOccurrenceId: "operation-occurrence-123", nativeIdentity: null,
      source: { artifactId: fixtureIdentity(101), range: { encoding: "utf16", start: 2, end: 11 } } })] });
  invoke.mockImplementation((command: string, args: unknown) => command === "read_source_preview" ? Promise.resolve(page) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  expect(screen.getByText("Source entry 2")).toBeInTheDocument();
  expect(screen.queryByText("operation-label-123")).not.toBeInTheDocument();
  expect(screen.queryByText("operation-occurrence-123")).not.toBeInTheDocument();
  await user.click(screen.getByText("Source location and identity"));
  expect(screen.getByText(/Source file details are unavailable\./)).toBeVisible();
  expect(screen.queryByText(/i18n\/default\.json/)).not.toBeInTheDocument();
});

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
  await user.click(screen.getByRole("checkbox", { name: i18n.t("sourcePlugin.producerConsent") }));
  // Reopening verifies the cached current reads before allowing a fresh start.
  await waitFor(() => expect(screen.getByRole("button", { name: "Import for preview" })).toBeEnabled());
  expect(invoke.mock.calls.filter(([name]) => name === "preflight_plugin_source")).toHaveLength(1);
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
  await chooseSourcePackage(user);
  await waitFor(() => expect(screen.getByRole("button", { name: "选择源文件夹" })).toBeEnabled());
  await user.click(await screen.findByRole("button", { name: "选择源文件夹" }));
  await user.click(screen.getByRole("checkbox", { name: /我确认/ }));
  let complete!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "preflight_plugin_source" ? new Promise(resolve => { complete = resolve; }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "检查源文件" }));
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "放弃选择并继续" }));
  expect(await decision).toBe(true);
  await act(async () => { complete({ ...pluginSourceWorkflow.preflight, sourceLanguage: "STALE" }); });
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

it("requires producer consent after capture and never executes through built-in source routes", async () => {
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  expect(await screen.findByRole("button", { name: "Import for preview" })).toBeDisabled();
  expect(screen.getByText(/No plugin has run/)).toBeInTheDocument();
  expect(invoke.mock.calls.some(([name]) => name === "start_plugin_source")).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: /I allow this exact plugin/ }));
  await user.click(screen.getByRole("button", { name: "Import for preview" }));
  await screen.findByRole("heading", { name: "Review imported strings" });
  expect(invoke.mock.calls.some(([name]) => ["read_source_integration", "read_webvtt_integration", "preflight_source", "start_source_import"].includes(name))).toBe(false);
});

it("clears producer consent on a fresh material capture after a rejected grant", async () => {
  const original = invoke.getMockImplementation()!;
  let captures = 0;
  invoke.mockImplementation((command: string, args: { request: { attemptId: string } }) => {
    if (command === "preflight_plugin_source") return Promise.resolve({ ...pluginSourceWorkflow.preflight, attemptId: args.request.attemptId, inputDigest: ++captures === 1 ? "a".repeat(64) : "d".repeat(64) });
    if (command === "start_plugin_source") return Promise.reject({ code: "permission-denied", stage: "execution-recover", outcome: "rejected", recoveryRequired: false, reason: "plugin-grant-expired" });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("checkbox", { name: /I allow this exact plugin/ }));
  await user.click(screen.getByRole("button", { name: "Import for preview" }));
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /I allow this exact plugin/ })).not.toBeChecked());
  expect(screen.getByRole("button", { name: "Import for preview" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "start_plugin_source")).toHaveLength(1);
});

it("reconciles an uncertain producer start with its original input, grant and expiry", async () => {
  const ref = createRef<SourceHandle>();
  const original = invoke.getMockImplementation()!;
  let rejected = false, reads = 0;
  invoke.mockImplementation((command, args) => {
    if (command === "start_plugin_source" && !rejected) { rejected = true; return Promise.reject({ code: "outcome-unknown" }); }
    if (command === "read_plugin_execution_start") return ++reads === 1 ? Promise.reject(new Error("Original read unavailable"))
      : Promise.resolve({ projectId: args.request.projectId, taskId: fixtureIdentity(888), attemptId: args.request.attemptId, inputDigest: args.request.inputDigest, operation: args.request.operation });
    return original(command, args);
  });
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("checkbox", { name: /I allow this exact plugin/ }));
  await user.click(screen.getByRole("button", { name: "Import for preview" }));
  await screen.findByRole("alert");
  expect(await ref.current!.allowNavigate()).toBe(false);
  expect(await ref.current!.allowLeave()).toBe(false);
  const first = invoke.mock.calls.find(([name]) => name === "start_plugin_source")![1];
  await user.click(screen.getByRole("button", { name: i18n.t("execution.checkPluginStart") }));
  await screen.findByRole("heading", { name: "Review imported strings" });
  expect(invoke.mock.calls.filter(([name]) => name === "start_plugin_source")).toEqual([["start_plugin_source",first]]);
  expect(reads).toBe(2);
});

it("retains pending proposals and requires separate checker consent and recorded proof before adoption", async () => {
  const original = invoke.getMockImplementation()!;
  const checkAttempt = fixtureIdentity(225), checkResult = fixtureIdentity(226);
  let recorded = false;
  let checkIdentity = 0;
  invoke.mockImplementation((command: string, args: { request?: { attemptId?: string } }) => {
    if (command === "create_execution_identity") return Promise.resolve([executionFixture.detail.attemptId, executionFixture.prepare.actionId, checkAttempt, fixtureIdentity(290), fixtureIdentity(232)][checkIdentity++] ?? fixtureIdentity(400 + checkIdentity));
    if (command === "read_execution_attempt") return Promise.resolve({ ...sourceAttemptFixture(String(args.request!.attemptId), executionFixture.prepare.resultIds[0]), attemptId: args.request!.attemptId, operation: args.request!.attemptId === checkAttempt ? "source-semantic-check" : "source-import",
      items: [{ ...sourceAttemptFixture().items[0], resultId: args.request!.attemptId === checkAttempt ? checkResult : executionFixture.prepare.resultIds[0], status: { ...sourceAttemptFixture().items[0].status, execution: "succeeded", validation: args.request!.attemptId === checkAttempt || recorded ? "valid" : "pending" } }] });
    if (command === "prepare_source_check") return Promise.resolve({ ...pluginSourceWorkflow.checkReview, attemptId: checkAttempt, sourceAttemptId: executionFixture.detail.attemptId, sourceResultId: executionFixture.prepare.resultIds[0] });
    if (command === "start_source_check") return Promise.resolve(checkAttempt);
    if (command === "finish_source_check") { recorded = true; return Promise.resolve(null); }
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  expect(screen.getByText("Unchanged {{name}} 世界")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Apply all 2/ })).toBeDisabled();
  expect(invoke.mock.calls.some(([name]) => name === "start_source_check")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Review independent check execution" }));
  expect(await screen.findByRole("button", { name: "Run independent source checks" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /I separately allow/ }));
  await user.click(screen.getByRole("button", { name: "Run independent source checks" }));
  await screen.findByRole("button", { name: "Record fixed check validation" });
  expect(screen.getByRole("button", { name: "Apply to project" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Record fixed check validation" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: /Apply all 2/ })).toBeEnabled());
  expect(screen.getByText("Unchanged {{name}} 世界")).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2/ }));
  await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await screen.findByRole("heading", { name: "Imported source content" });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});

it("shows the independent checker failure from its own saved result without changing the source proposal", async () => {
  const original = invoke.getMockImplementation()!;
  const checkAttempt = fixtureIdentity(235), checkResult = fixtureIdentity(236);
  let identity = 0;
  invoke.mockImplementation((command: string, args: { request?: { attemptId?: string; resultId?: string } }) => {
    if (command === "create_execution_identity") return Promise.resolve([executionFixture.detail.attemptId, executionFixture.prepare.actionId, checkAttempt][identity++] ?? fixtureIdentity(400 + identity));
    if (command === "read_execution_attempt") {
      const isCheck = args.request!.attemptId === checkAttempt;
      const value = sourceAttemptFixture(String(args.request!.attemptId), isCheck ? checkResult : executionFixture.prepare.resultIds[0]);
      value.operation = isCheck ? "source-semantic-check" : "source-import";
      value.items[0].status.validation = "pending";
      if (isCheck) {
        value.progress.succeeded = 0; value.progress.failed = 1;
        value.items[0].status.execution = "failed";
        value.items[0].status.diagnostic = "plugin-failed";
        value.recovery.units[0].actions = [];
      }
      return Promise.resolve(value);
    }
    if (command === "prepare_source_check") return Promise.resolve({ ...pluginSourceWorkflow.checkReview, attemptId: checkAttempt,
      sourceAttemptId: executionFixture.detail.attemptId, sourceResultId: executionFixture.prepare.resultIds[0] });
    if (command === "start_source_check") return Promise.resolve(checkAttempt);
    if (command === "read_execution_output") {
      expect(args.request).toMatchObject({ attemptId: checkAttempt, resultId: checkResult });
      return Promise.resolve({ ...executionFixture.output, projectId: project.metadata.projectId, attemptId: checkAttempt,
        resultId: checkResult, itemId: sourceAttemptFixture().items[0].status.itemId,
        sourceFailure: { code: "unsupported-structure", artifactId: "captured-check", detail: "Required manifest Name is missing." } });
    }
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "Review independent check execution" }));
  await user.click(await screen.findByRole("checkbox", { name: /I separately allow/ }));
  await user.click(screen.getByRole("button", { name: "Run independent source checks" }));
  await screen.findByText(/Independent checks did not complete successfully/);
  await user.click(screen.getByText(i18n.t("execution.diagnostic")));
  expect(screen.getByText("Required manifest Name is missing.", { exact: false })).toBeVisible();
  expect(screen.getByText("captured-check")).toBeVisible();
  expect(screen.getByText("Unchanged {{name}} 世界")).toBeInTheDocument();
  expect(invoke.mock.calls.some(([name]) => name === "finish_source_check" || name === "adopt_execution")).toBe(false);
});

it.each([[1, 1], [1, 2], [2, 1], [3, 2], [2, 3]])("keeps unsupported source declaration %s/%s unavailable", async (schemaVersion, behaviorVersion) => {
  const original = invoke.getMockImplementation()!;
  const unsupported = structuredClone(pluginSourcePackage);
  const contribution = unsupported.manifest.contributions[0].contribution;
  if (contribution.kind !== "resource") throw new Error("Source resource fixture required");
  contribution.schema = { ...contribution.schema, schemaVersion, behaviorVersion };
  invoke.mockImplementation((command: string, args: unknown) => command === "read_plugin_package" ? Promise.resolve(unsupported) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await screen.findByText(i18n.t("sourcePlugin.unavailable"));
  expect(screen.getByRole("button", { name: "Choose source folder" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "read_plugin_source" || name === "select_plugin_source")).toHaveLength(0);
});

it("keeps source controls unavailable without an independently approved installed runtime", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_plugin_inventory" ? Promise.resolve({ ...pluginSourceInventory, runtimeDecisions: [] }) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await screen.findByText(i18n.t("sourcePlugin.unavailable"));
  expect(screen.getByRole("button", { name: "Choose source folder" })).toBeDisabled();
  expect(invoke.mock.calls.some(([name]) => name === "select_plugin_source")).toBe(false);
});


it("allows a fresh independent check after cancellation before dispatch", async () => {
  const original = invoke.getMockImplementation()!;
  const checkAttempt = fixtureIdentity(231);
  let prepared = 0;
  let checkIdentity = 0;
  invoke.mockImplementation((command: string, args: { request?: { attemptId?: string } }) => {
    if (command === "create_execution_identity") return Promise.resolve([executionFixture.detail.attemptId, executionFixture.prepare.actionId, checkAttempt, fixtureIdentity(290), fixtureIdentity(232)][checkIdentity++] ?? fixtureIdentity(400 + checkIdentity));
    if (command === "read_execution_attempt") return Promise.resolve({ ...sourceAttemptFixture(String(args.request!.attemptId), executionFixture.prepare.resultIds[0]), attemptId: args.request!.attemptId, operation: args.request!.attemptId === checkAttempt ? "source-semantic-check" : "source-import",
      items: [{ ...sourceAttemptFixture().items[0], resultId: args.request!.attemptId === checkAttempt ? null : executionFixture.prepare.resultIds[0], status: { ...sourceAttemptFixture().items[0].status, execution: args.request!.attemptId === checkAttempt ? "cancelled-before-dispatch" : "succeeded", validation: "pending" } }] });
    if (command === "prepare_source_check") { prepared++; return Promise.resolve({ ...pluginSourceWorkflow.checkReview, attemptId: prepared === 1 ? checkAttempt : fixtureIdentity(232), sourceAttemptId: executionFixture.detail.attemptId, sourceResultId: executionFixture.prepare.resultIds[0] }); }
    if (command === "start_source_check") return Promise.resolve(checkAttempt);
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "Review independent check execution" }));
  await user.click(await screen.findByRole("checkbox", { name: /I separately allow/ }));
  await user.click(screen.getByRole("button", { name: "Run independent source checks" }));
  await screen.findByText(/Independent checks did not complete successfully/);
  await user.click(screen.getByRole("button", { name: "Review independent check execution" }));
  expect(await screen.findByRole("checkbox", { name: /I separately allow/ })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Run independent source checks" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([name]) => name === "start_source_check")).toHaveLength(1);
  expect(screen.getByText("Unchanged {{name}} 世界")).toBeInTheDocument();
});

it("reconciles uncertain validation with the original result and keeps a failed proposal blocked", async () => {
  const ref = createRef<SourceHandle>();
  const original = invoke.getMockImplementation()!;
  const checkAttempt = fixtureIdentity(233), checkResult = fixtureIdentity(234);
  let recorded = false, acknowledged = false;
  let checkIdentity = 0;
  invoke.mockImplementation((command: string, args: { request?: { attemptId?: string } }) => {
    if (command === "create_execution_identity") return Promise.resolve([executionFixture.detail.attemptId, executionFixture.prepare.actionId, checkAttempt, fixtureIdentity(290), fixtureIdentity(232)][checkIdentity++] ?? fixtureIdentity(400 + checkIdentity));
    if (command === "read_execution_attempt") return Promise.resolve({ ...sourceAttemptFixture(String(args.request!.attemptId), executionFixture.prepare.resultIds[0]), attemptId: args.request!.attemptId, operation: args.request!.attemptId === checkAttempt ? "source-semantic-check" : "source-import",
      items: [{ ...sourceAttemptFixture().items[0], resultId: args.request!.attemptId === checkAttempt ? checkResult : executionFixture.prepare.resultIds[0], status: { ...sourceAttemptFixture().items[0].status, execution: "succeeded", validation: args.request!.attemptId === checkAttempt ? "valid" : recorded ? "invalid" : "pending" } }] });
    if (command === "prepare_source_check") return Promise.resolve({ ...pluginSourceWorkflow.checkReview, attemptId: checkAttempt, sourceAttemptId: executionFixture.detail.attemptId, sourceResultId: executionFixture.prepare.resultIds[0] });
    if (command === "start_source_check") return Promise.resolve(checkAttempt);
    if (command === "finish_source_check") { recorded = true; if (!acknowledged) { acknowledged = true; return Promise.reject({ code: "outcome-unknown" }); } return Promise.resolve(null); }
    return original(command, args);
  });
  render(<><SourceProbe /><SourceWorkbench ref={ref} project={project} disabled={false} /></>, project);
  const user = await prepare();
  await user.click(screen.getByRole("button", { name: "Review independent check execution" }));
  await user.click(await screen.findByRole("checkbox", { name: /I separately allow/ }));
  await user.click(screen.getByRole("button", { name: "Run independent source checks" }));
  await user.click(await screen.findByRole("button", { name: "Record fixed check validation" }));
  await screen.findByRole("alert");
  expect(await ref.current!.allowNavigate()).toBe(false);
  expect(await ref.current!.allowLeave()).toBe(false);
  const first = invoke.mock.calls.find(([name]) => name === "finish_source_check")![1];
  const pending = draft.current().pendingPlugin; expect(pending?.pendingKind).toBe("finish-check");
  const retry = screen.getByRole("button", { name: "Reconcile recorded check validation" });
  await waitFor(() => expect(retry).toBeEnabled()); expect(draft.current().pendingPlugin).toBe(pending);
  await user.click(retry);
  await waitFor(() => expect(draft.current().pendingPlugin).toBeNull());
  await screen.findByText(/The proposal failed its mandatory source checks/);
  expect(invoke.mock.calls.filter(([name]) => name === "finish_source_check")[1][1]).toEqual(first);
  expect(screen.getByRole("checkbox", { name: /Apply all 2/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Apply to project" })).toBeDisabled();
  expect(screen.getByText("Unchanged {{name}} 世界")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose new source input" })).toBeEnabled();
  expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(false);
});

it("keeps capture consent and material while an installed-choice refresh is unavailable", async () => {
  const original = invoke.getMockImplementation()!;
  let unavailable = false;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_plugin_inventory" && unavailable) return Promise.reject({ code: "busy", outcome: "rejected" });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("checkbox", { name: /I allow this exact plugin/ }));
  unavailable = true;
  await user.click(screen.getByRole("button", { name: "Refresh installed source choices" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /I allow this exact plugin/ })).toBeChecked();
  expect(screen.getByRole("button", { name: "Import for preview" })).toBeDisabled();
  unavailable = false;
  await user.click(screen.getByRole("button", { name: "Refresh installed source choices" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Import for preview" })).toBeEnabled());
  expect(invoke.mock.calls.some(([name]) => name === "start_plugin_source")).toBe(false);
});

it("reports a rejected capture discard and retains the selected material", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "cancel_source_capture" ? Promise.reject({ code: "busy", outcome: "rejected" }) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await select();
  await user.click(screen.getByRole("button", { name: "Discard selection" }));
  await screen.findByRole("alert");
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
});


it.each(["en-US", "zh-CN"].flatMap(locale => ["vtt-header", "vtt-payload", "catalog.invalid-line", "invalid-json", "source-value-not-string"].map(diagnostic => [locale, diagnostic])))("keeps plugin diagnostics opaque during source preview failure in %s: %s", async (locale, diagnostic) => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_source_preview") return Promise.reject({ ...commandErrors.errors[0], reason: diagnostic });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("source.title") }));
  await chooseSourcePackage(user);
  await user.click(await screen.findByRole("button", { name: i18n.t("sourcePlugin.chooseFolder") }));
  await user.click(await screen.findByRole("checkbox", { name: i18n.t("source.language", { language: project.metadata.sourceLocale }) }));
  await user.click(screen.getByRole("button", { name: i18n.t("source.preflight") }));
  await user.click(await screen.findByRole("checkbox", { name: i18n.t("sourcePlugin.producerConsent") }));
  await user.click(screen.getByRole("button", { name: i18n.t("source.start") }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(i18n.t("source.errors.failed"));
  await user.click(within(alert).getByText(i18n.t("execution.diagnostic")));
  expect(within(alert).getByText(diagnostic)).toBeVisible();
  expect(invoke.mock.calls.some(([name]) => name === "prepare_source_adoption" || name === "adopt_execution")).toBe(false);
});


it("shows every captured source diagnostic without interpreting a domain profile", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_source_preview"
    ? Promise.resolve({ ...preview, diagnostics: ["source-template", "catalog.incomplete-metadata"] }) : original(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  const summary = screen.getByText(i18n.t("source.diagnostics", { count: 2 }));
  expect(summary.closest("details")).not.toHaveAttribute("open");
  await user.click(summary);
  expect(screen.getByText("source-template")).toBeVisible();
  expect(screen.getByText("catalog.incomplete-metadata")).toBeVisible();
  expect(invoke.mock.calls.some(([name]) => name === "adopt_execution")).toBe(false);
});


it("selects the approved current Native Host for a Native source without borrowing Node", async () => {
  const { nativeInventory, nativePackage, nativeEnvironment, nativeDigest, nativeOrigin } = await import("./testSupport/pluginNativeFixture");
  const base = invoke.getMockImplementation()!;
  const nativeView = { ...pluginSourceView, environment: nativeEnvironment, environmentDigest: nativeDigest, runtimeOrigin: nativeOrigin };
  invoke.mockImplementation(async (command, args) => {
    if (command === "read_plugin_inventory") return nativeInventory(pluginSourceInventory);
    if (command === "read_plugin_package") return nativePackage(pluginSourcePackage);
    if (command === "read_plugin_source") return nativeView;
    if (command === "select_plugin_source") return { ...pluginSourceWorkflow.selection, source: nativeView };
    const value = await base(command, args);
    return command === "preflight_plugin_source" ? { ...value, source: nativeView } : value;
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  if (!pluginSourceWorkflow.selection) throw new Error("Expected the canonical selected Native source folder");
  const user = await select(nativeDigest, pluginSourceWorkflow.selection.folderName);
  expect(screen.getByRole("combobox", { name: i18n.t("sourcePlugin.runtime") })).toHaveValue(nativeDigest);
  expect(screen.queryByRole("option", { name: /^Node / })).not.toBeInTheDocument();
  expect(invoke.mock.calls.find(([command]) => command === "read_plugin_source")![1].request.environmentDigest).toBe(nativeDigest);
  await user.click(screen.getByRole("checkbox", { name: /^I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  expect(await screen.findByText(i18n.t("sourcePlugin.nativeRuntimeDetails", { version: nativeEnvironment.hostVersion, system: "macos", architecture: "aarch64" }))).toBeVisible();
  expect(screen.getByRole("checkbox", { name: i18n.t("sourcePlugin.producerConsent") })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Import for preview" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "start_plugin_source")).toBe(false);
});
it("keeps a Native source unavailable while only Node has an approval", async () => {
  const { nativeInventory, nativePackage } = await import("./testSupport/pluginNativeFixture");
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "read_plugin_inventory" ? Promise.resolve(nativeInventory(pluginSourceInventory, false)) : command === "read_plugin_package" ? Promise.resolve(nativePackage(pluginSourcePackage)) : base(command, args));
  render(<SourceWorkbench project={project} disabled={false} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Source content" }));
  await screen.findByText(i18n.t("sourcePlugin.unavailable"));
  expect(screen.getByRole("button", { name: "Choose source folder" })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "read_plugin_source" || command === "start_plugin_source")).toBe(false);

});

let draft: ReturnType<typeof useSourceDraftSession>, registry: ReturnType<typeof useWorkbenchCommands>, sourceSessionReads: ReturnType<typeof useSessionReads>;
function SourceProbe() { const value = useSourceDraftSession(), commands = useWorkbenchCommands(), reads = useSessionReads(); useLayoutEffect(() => { draft = value; registry = commands; sourceSessionReads = reads; }); return null; }
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
      const key = after ? "A-next" : "A-first", occurrence = fixed.rows[0].new!;
      if (!occurrence.nativeIdentity) throw new Error("Expected the fixed source's native display identity");
      return Promise.resolve(query ? { ...fixed, filteredTotal: 2, nextOrdinal: after ? null : 1, rows: [{ ...fixed.rows[0], new: { ...occurrence,
        ordinal: after ? 70 : 0, key, nativeIdentity: { ...occurrence.nativeIdentity, display: { ...occurrence.nativeIdentity.display, value: key } } } }] } : fixed);
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

it("binds both Source start recovery commands to the full original request and refuses a retired session", async () => {
  render(<><SourceProbe/><SourceWorkbench project={project} disabled={false}/></>,project);
  await userEvent.setup().click(screen.getByRole("button",{name:"Source content"}));
  await act(async()=>{draft.setSource(pluginSourceRequest);await draft.select();draft.declare(true);await draft.preflight();draft.consentProducer(true);});
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((name,args)=>name==="start_plugin_source"?Promise.reject(new Error("Lost ACK")):name==="read_plugin_execution_start"?Promise.resolve(null):original(name,args));
  await act(async()=>{await draft.start();});
  const request=draft.current().pendingStart!;expect(request).not.toBeNull();
  const payload={kind:"source-pending" as const,pendingKind:"start" as const,attemptId:request.attemptId,actionId:null,request};
  for(const id of ["source.check-start","source.retry-start"] as const){
    expect(registry.describe(id,sourceScope,payload)?.availability.enabled).toBe(true);
    expect(registry.dispatch(id,sourceScope,{...payload,request:{...request,inputDigest:"b".repeat(64)}})).toBe(false);
  }
  act(()=>sourceSessionReads.retire());
  expect(registry.dispatch("source.check-start",sourceScope,payload)).toBe(false);expect(registry.dispatch("source.retry-start",sourceScope,payload)).toBe(false);
  expect(invoke.mock.calls.filter(([name])=>name==="start_plugin_source")).toHaveLength(1);expect(draft.current().pendingStart).toBe(request);
});
