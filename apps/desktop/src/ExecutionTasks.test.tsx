import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTasks } from "./ExecutionTasks";
import { i18n } from "./i18n";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";
import type { AttemptDetail } from "./executionCommands";
import { savedPluginBuild } from "./testSupport/pluginBuildFixture";
import type { SavedPluginBuildView } from "./releaseCommands";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session-1", locator: "C:\\isolated\\project", metadata: { projectId: fixture.session.projectId, displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" }, reconciliationState: "settled" };
const task = { taskId: fixture.detail.taskId, projectId: fixture.session.projectId, operation: "sample-update", sequence: "1", cancellationRevision: "0" };
function detail(): AttemptDetail { return structuredClone(fixture.detail) as AttemptDetail; }
function savedBuildDetail(saved: SavedPluginBuildView): AttemptDetail {
  return { attemptId: saved.attemptId, taskId: saved.taskId, operation: "locale-build", nextOffset: null,
    items: saved.locales.map(locale => ({ scope: { kind: "locale", id: locale.choice.locale, locale: locale.choice.locale }, status: locale.status, resultId: locale.result?.resultId ?? null })),
    progress: { total: saved.locales.length, queued: 0, running: 0, succeeded: saved.locales.length, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
    recovery: { attemptId: saved.attemptId, units: [{ unitId: fixtureIdentity(830), itemIds: saved.locales.map(locale => locale.itemId), scopes: saved.locales.map(locale => ({ kind: "locale", id: locale.choice.locale, locale: locale.choice.locale })),
      resultIds: saved.locales.flatMap(locale => locale.result ? [locale.result.resultId] : []), remainingItemIds: [], actions: [], blockedReason: "external-new-consent", receiptId: null }] } };
}
async function openSavedBuild(options: { saved?: SavedPluginBuildView; onSavedBuild?: (id: string) => boolean; read?: () => Promise<SavedPluginBuildView> } = {}) {
  const saved = { ...structuredClone(options.saved ?? savedPluginBuild), projectId: project.metadata.projectId };
  const value = savedBuildDetail(saved);
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [{ ...task, taskId: saved.taskId, operation: "locale-build" }];
    if (command === "read_execution_task") return [{ attemptId: saved.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return value;
    if (command === "read_saved_plugin_build") return options.read ? options.read() : saved;
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<ExecutionTasks project={project} disabled={false} onSavedBuild={options.onSavedBuild} />);
  await user.click(screen.getByRole("button", { name: i18n.t("execution.title") }));
  await user.click(await screen.findByRole("button", { name: `${i18n.t("release.title")} · ${i18n.t("execution.taskNumber", { number: "1" })}` }));
  await screen.findByRole("button", { name: i18n.t("execution.output") });
  return { user, saved };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function openTasks(value = detail()) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task];
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return value;
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await screen.findByText(/0 of 1 outputs/);
  return user;
}
it("offers only evidence-backed actions for an unknown result and confirms the exact item", async () => {
  const user = await openTasks();
  expect(screen.queryByRole("button", { name: "Retry eligible failures" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply saved results" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  const dialog = screen.getByRole("dialog", { name: "Check earlier request" });
  expect(within(dialog).getByText(/Sample A/)).toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
  invoke.mockResolvedValueOnce({ attemptId: fixture.detail.attemptId, queryStarted: true });
  await user.click(within(dialog).getByRole("button", { name: "Check earlier request" }));
  expect(invoke).toHaveBeenCalledWith("recover_execution", { request: fixture.recover });
  await screen.findByText(/Outcome check requested/);
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  expect(within(screen.getByRole("dialog", { name: "Check earlier request" })).queryByText(/Outcome check requested/)).not.toBeInTheDocument();
});
it("keeps an uncertain adoption recoverable inside the confirmation dialog without regenerating", async () => {
  const value = detail(); value.items[0].status.execution = "succeeded"; value.items[0].status.validation = "valid"; value.items[0].resultId = fixture.prepare.resultIds[0];
  value.recovery.units[0].actions = ["adopt-result"]; value.recovery.units[0].resultIds = fixture.prepare.resultIds; value.recovery.units[0].blockedReason = null;
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Apply saved results" }));
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockResolvedValueOnce(fixture.action).mockRejectedValueOnce({ code: "outcome-unknown", outcome: "unknown", stage: "execution-adopt", recoveryRequired: true });
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  const check = await screen.findByRole("button", { name: "Check recorded outcome" });
  invoke.mockResolvedValueOnce(project).mockResolvedValueOnce(fixture.receipt);
  await user.click(check);
  await screen.findByRole("heading", { name: "Recorded changes" });
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
  const prepared = invoke.mock.calls.find(([command]) => command === "prepare_execution_adoption")![1].request;
  expect(invoke).toHaveBeenCalledWith("read_execution_receipt", { request: { ...fixture.session, actionId: prepared.actionId } });
});
it("discards a previous selection's late detail response", async () => {
  let resolveOld!: (value: AttemptDetail) => void;
  const old = new Promise<AttemptDetail>(resolve => { resolveOld = resolve; });
  const fresh = detail(); fresh.attemptId = fixtureIdentity(1); fresh.items[0].scope.id = "New selection";
  fresh.recovery.units[0].scopes[0].id = "New selection";
  invoke.mockImplementation(async (command: string, args: { request: { taskId?: string; attemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task, { ...task, taskId: fixtureIdentity(2), sequence: "2" }];
    if (command === "read_execution_task") return [{ attemptId: args.request.taskId === fixtureIdentity(2) ? fresh.attemptId : fixture.detail.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return args.request.attemptId === fresh.attemptId ? fresh : old;
  });
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 1" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_execution_attempt")).toBe(true));
  await user.click(screen.getByRole("button", { name: "All tasks" }));
  await user.click(await screen.findByRole("button", { name: "Sample update · Task 2" }));
  await screen.findByText("New selection · zh-CN", { selector: "strong" });
  await act(async () => { resolveOld(detail()); await old; });
  expect(screen.getByText("New selection · zh-CN", { selector: "strong" })).toBeInTheDocument();
  expect(screen.queryByText("Sample A · zh-CN")).not.toBeInTheDocument();
});
it("preserves keyboard return focus and Chinese task messages", async () => {
  await i18n.changeLanguage("zh-CN");
  invoke.mockImplementation(async command => command === "execution_status" ? fixture.status : []);
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} />);
  const trigger = screen.getByRole("button", { name: "任务" }); trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByText(/此项目暂无任务/);
  await user.click(screen.getByRole("button", { name: "返回概览" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "项目概览" })).toHaveFocus());
});

it("retries uncertain preparation with the original request after checking its receipt", async () => {
  const value = detail();
  value.recovery.units[0].actions = ["adopt-result"];
  value.recovery.units[0].resultIds = fixture.prepare.resultIds;
  value.recovery.units[0].blockedReason = null;
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Apply saved results" }));
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce({ code: "outcome-unknown" });
  await user.click(within(screen.getByRole("dialog", { name: "Apply saved results" })).getByRole("button", { name: "Apply saved results" }));
  const check = await screen.findByRole("button", { name: "Check recorded outcome" });
  invoke.mockResolvedValueOnce(project).mockResolvedValueOnce(null);
  await user.click(check);
  const retry = await screen.findByRole("button", { name: "Retry the same application" });
  invoke.mockResolvedValueOnce(fixture.action).mockResolvedValueOnce(fixture.receipt);
  await user.click(retry);
  await screen.findByRole("heading", { name: "Recorded changes" });
  const preparations = invoke.mock.calls.filter(([command]) => command === "prepare_execution_adoption");
  expect(preparations).toHaveLength(2);
  expect(preparations[1][1]).toEqual(preparations[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "adopt_execution")).toHaveLength(1);
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
});

it("shows named failure details beside the item and focuses the readable result", async () => {
  const value = detail();
  value.items[0].status.execution = "failed";
  value.items[0].status.retrySafe = true;
  value.items[0].resultId = fixture.prepare.resultIds[0];
  value.progress.failed = 1; value.progress.unknown = 0;
  value.recovery.units[0].actions = ["retry-safe-failure"];
  value.recovery.units[0].blockedReason = null;
  const user = await openTasks(value);
  expect(screen.getByRole("region", { name: "Available actions" }).compareDocumentPosition(screen.getByRole("heading", { name: "Item results" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  invoke.mockResolvedValueOnce(fixture.output);
  await user.click(screen.getByRole("button", { name: "View failure details" }));
  const result = await screen.findByRole("region", { name: "Result for Sample A" });
  expect(within(result).getByText(/did not generate usable output/)).toBeInTheDocument();
  expect(within(result).queryByText("null")).not.toBeInTheDocument();
  expect(result).toHaveFocus();
  expect(result.closest("li")).toContainElement(screen.getByText("Sample A · zh-CN", { selector: "strong" }));
  await user.click(screen.getByRole("button", { name: "Retry eligible failures" }));
  invoke.mockResolvedValueOnce({ attemptId: fixtureIdentity(3), queryStarted: false });
  await user.click(within(screen.getByRole("dialog", { name: "Retry eligible failures" })).getByRole("button", { name: "Retry eligible failures" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Result for Sample A" })).not.toBeInTheDocument());
});

it("keeps a successful output's warning separate from failure retry guidance", async () => {
  const value = detail();
  value.items[0].status.execution = "succeeded";
  value.items[0].status.validation = "valid";
  value.items[0].resultId = fixture.prepare.resultIds[0];
  const user = await openTasks(value);
  invoke.mockResolvedValueOnce({ ...fixture.output, outcome: "succeeded", output: { complete: true }, diagnostic: { code: "source-template", retrySafe: false } });
  await user.click(screen.getByRole("button", { name: "View saved output" }));
  const result = await screen.findByRole("region", { name: "Result for Sample A" });
  expect(within(result).getByText(/"complete": true/)).toBeInTheDocument();
  expect(within(result).queryByText(i18n.t("execution.unsafeFailure"))).not.toBeInTheDocument();
  await user.click(within(result).getByText("Technical details"));
  expect(within(result).getByText("source-template")).toBeVisible();
});

it("confirms only the selected unknown item and describes checking without generation", async () => {
  const value = detail();
  value.recovery.units[0].itemIds.push(fixtureIdentity(4));
  value.recovery.units[0].scopes.push({ kind: "sample", id: "Other item", locale: "zh-CN" });
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: /Check earlier request ·/ }));
  const dialog = screen.getByRole("dialog", { name: "Check earlier request" });
  expect(within(dialog).getByText(/these 1 selected items/)).toBeInTheDocument();
  expect(within(dialog).getByText(/does not generate results again/)).toBeInTheDocument();
  expect(within(dialog).queryByText("Other item")).not.toBeInTheDocument();
});

it.each(["en-US", "zh-CN"])("shows every saved plugin artifact and original target count without generic checking in %s", async language => {
  await i18n.changeLanguage(language);
  const { user, saved } = await openSavedBuild();
  await user.click(screen.getByRole("button", { name: i18n.t("execution.output") }));
  const summary = await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  expect(within(summary).getByText(i18n.t("releasePlugin.savedTargets", { count: 2 }))).toBeInTheDocument();
  expect(within(summary).getByText(i18n.t("releasePlugin.savedReadOnly"))).toBeInTheDocument();
  const artifacts = within(summary).getByRole("list", { name: i18n.t("releasePlugin.savedArtifacts", { locale: "zh-CN" }) });
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(2);
  for (const artifact of saved.locales[0].result!.artifacts) {
    expect(within(artifacts).getByText(artifact.logicalPath, { selector: "strong" })).toBeInTheDocument();
    expect(within(artifacts).getByText(`${i18n.t("releasePlugin.savedRole", { role: artifact.role })} · ${i18n.t("releasePlugin.bytes", { count: artifact.byteLength })}`)).toBeInTheDocument();
    expect(within(artifacts).getByLabelText(i18n.t("releasePlugin.savedSha", { path: artifact.logicalPath }))).toHaveTextContent(artifact.sha256);
  }
  expect(screen.queryByRole("button", { name: i18n.t("execution.actions.validate-output") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.every(([command]) => ["execution_status", "list_execution_tasks", "read_execution_task", "read_execution_attempt", "read_saved_plugin_build"].includes(command))).toBe(true);
  expect(invoke).toHaveBeenCalledWith("read_saved_plugin_build", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, attemptId: saved.attemptId } });
});

it.each(["task", "item", "result"] as const)("refuses a saved build with a different %s and recovers by reading the same selection", async mismatch => {
  const correct = { ...structuredClone(savedPluginBuild), projectId: project.metadata.projectId };
  const wrong = structuredClone(correct);
  if (mismatch === "task") wrong.taskId = fixtureIdentity(888);
  if (mismatch === "item") { wrong.locales[0].itemId = fixtureIdentity(888); wrong.locales[0].status.itemId = fixtureIdentity(888); }
  if (mismatch === "result") wrong.locales[0].result!.resultId = fixtureIdentity(888);
  let response = wrong;
  const { user } = await openSavedBuild({ read: async () => response });
  await user.click(screen.getByRole("button", { name: i18n.t("execution.output") }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(i18n.t("releasePlugin.savedReadFailed"));
  expect(screen.queryByRole("region", { name: i18n.t("releasePlugin.savedTitle") })).not.toBeInTheDocument();
  expect(screen.getByText("zh-CN · zh-CN", { selector: "strong" })).toBeInTheDocument();
  response = correct;
  await user.click(within(alert).getByRole("button", { name: i18n.t("releasePlugin.savedRefresh") }));
  await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  expect(invoke.mock.calls.filter(([command]) => command === "read_saved_plugin_build").map(([, args]) => args.request.attemptId)).toEqual([correct.attemptId, correct.attemptId]);
});

it("shows a continued build's reused result through its logical saved attempt without requiring a rewritten output frame", async () => {
  const continued = { ...structuredClone(savedPluginBuild), attemptId: fixtureIdentity(891) };
  const originalResult = continued.locales[0].result!.resultId;
  const { user, saved } = await openSavedBuild({ saved: continued });
  await user.click(screen.getByRole("button", { name: i18n.t("execution.output") }));
  const summary = await screen.findByRole("region", { name: i18n.t("releasePlugin.savedTitle") });
  const artifacts = within(summary).getByRole("list", { name: i18n.t("releasePlugin.savedArtifacts", { locale: "zh-CN" }) });
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(2);
  for (const artifact of saved.locales[0].result!.artifacts) {
    expect(within(artifacts).getByLabelText(i18n.t("releasePlugin.savedSha", { path: artifact.logicalPath }))).toHaveTextContent(artifact.sha256);
  }
  expect(saved.locales[0].result!.resultId).toBe(originalResult);
  expect(invoke).toHaveBeenCalledWith("read_saved_plugin_build", { request: { sessionToken: project.sessionToken, projectId: project.metadata.projectId, attemptId: continued.attemptId } });
  expect(invoke.mock.calls.some(([command]) => command === "read_execution_output" || command === "start_plugin_build" || command === "create_execution_identity")).toBe(false);
});

it("keeps Tasks open when the saved-build owner refuses navigation and forwards the exact attempt on acceptance", async () => {
  const navigate = vi.fn<(id: string) => boolean>().mockReturnValue(false);
  const { user, saved } = await openSavedBuild({ onSavedBuild: navigate });
  const route = screen.getByRole("button", { name: i18n.t("releasePlugin.savedOpen") });
  await user.click(route);
  expect(navigate).toHaveBeenLastCalledWith(saved.attemptId);
  expect(await screen.findByText(i18n.t("execution.savedBuildBlocked"))).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: i18n.t("execution.title") })).toBeVisible();
  navigate.mockReturnValue(true);
  await user.click(route);
  expect(navigate.mock.calls).toEqual([[saved.attemptId], [saved.attemptId]]);
  expect(screen.queryByRole("heading", { name: i18n.t("execution.title") })).not.toBeInTheDocument();
  expect(invoke.mock.calls.every(([command]) => command.startsWith("read_") || command === "execution_status" || command === "list_execution_tasks")).toBe(true);
});
