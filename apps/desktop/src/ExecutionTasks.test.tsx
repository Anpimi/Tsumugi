import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionTasks, type TasksHandle } from "./ExecutionTasks";
import { i18n } from "./i18n";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import type { ProjectView } from "./projectCommands";
import { createRef, type RefObject } from "react";
import type { AttemptDetail, ContinuationRequest, ContinuationReceipt } from "./executionCommands";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session-1", locator: "C:\\isolated\\project", metadata: { projectId: fixture.session.projectId, displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" }, reconciliationState: "settled" };
const task = { taskId: fixture.detail.taskId, projectId: fixture.session.projectId, operation: "sample-update", sequence: "1", cancellationRevision: "0" };
function detail(): AttemptDetail { return structuredClone(fixture.detail) as AttemptDetail; }
function continuationResult(request: ContinuationRequest): ContinuationReceipt {
  return { ...fixture.continuationReceipt, sequence: "2", action: { ...request.action, itemIds: [...request.action.itemIds].sort() }, attemptId: fixtureIdentity(3), taskId: task.taskId, operation: task.operation };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function mountTasks(value = detail(), ref?: RefObject<TasksHandle | null>) {
  invoke.mockImplementation(async (command: string, args: { request: { attemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [{ ...task, taskId: value.taskId, operation: value.operation }];
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return { ...value, attemptId: args.request.attemptId, recovery: { ...value.recovery, attemptId: args.request.attemptId } };
    if (command === "read_execution_task_view") return { ...task, taskId: value.taskId, operation: value.operation };
    if (command === "read_execution_continuations") return { receipts: [], next: null };
    throw new Error(`Unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<ExecutionTasks project={project} disabled={false} ref={ref} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Task 1/ }));
  await screen.findByRole("region", { name: "Execution summary" });
  return { user, view };
}
async function openTasks(value = detail(), ref?: RefObject<TasksHandle | null>) { return (await mountTasks(value,ref)).user; }
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
  fresh.taskId = fixtureIdentity(2); fresh.recovery.attemptId = fresh.attemptId;
  fresh.recovery.units[0].scopes[0].id = "New selection";
  invoke.mockImplementation(async (command: string, args: { request: { taskId?: string; attemptId?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [task, { ...task, taskId: fixtureIdentity(2), sequence: "2" }];
    if (command === "read_execution_task") return [{ attemptId: args.request.taskId === fixtureIdentity(2) ? fresh.attemptId : fixture.detail.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return args.request.attemptId === fresh.attemptId ? fresh : old;
    if (command === "read_execution_task_view") return { ...task, taskId: args.request.taskId };
    if (command === "read_execution_continuations") return { receipts: [], next: null };
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
  invoke.mockResolvedValueOnce(fixtureIdentity(6)).mockImplementationOnce(async (_command, args: { request: ContinuationRequest }) => continuationResult(args.request));
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

it("keeps the complete original recovery after lost ACK, wrong lookup and later rejection", async () => {
  const value = detail();
  value.recovery.units[0].actions = ["resume-undispatched"];
  value.recovery.units[0].blockedReason = null;
  value.progress.unknown = 0; value.progress.queued = 1;
  value.items[0].status.execution = "queued";
  const user = await openTasks(value);
  await user.click(screen.getByRole("button", { name: "Continue remaining work" }));
  invoke.mockResolvedValueOnce(fixtureIdentity(6)).mockRejectedValueOnce(new Error("lost ACK"));
  await user.click(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" }));
  const check = await screen.findByRole("button", { name: "Check original recovery request" });
  const original = invoke.mock.calls.find(([command]) => command === "continue_execution")![1].request as ContinuationRequest;
  expect(original.action).toMatchObject({ kind: "resume-undispatched", expectedCancellationRevision: "0", itemIds: value.recovery.units[0].remainingItemIds });
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  // A shaped but unrelated receipt cannot acknowledge the pending original intent.
  invoke.mockResolvedValueOnce({ ...continuationResult(original), action: { ...original.action, unitId: fixtureIdentity(8) } });
  await user.click(check);
  expect(await screen.findByText(/original recovery request is still unconfirmed/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  invoke.mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Check original recovery request" }));
  const retry = await screen.findByRole("button", { name: "Retry the same recovery request" });
  invoke.mockRejectedValueOnce({ code: "cancelled", outcome: "rejected", stage: "execution-recover", recoveryRequired: false, reason: "continuation-cancellation-basis" });
  await user.click(retry);
  expect(await screen.findByText(/original recovery request is still unconfirmed/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument();
  const writes = invoke.mock.calls.filter(([command]) => command === "continue_execution");
  expect(writes).toHaveLength(2); expect(writes[1][1]).toEqual(writes[0][1]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  invoke.mockResolvedValueOnce(continuationResult(original));
  await user.click(screen.getByRole("button", { name: "Check original recovery request" }));
  await waitFor(() => expect(screen.queryByText(/original recovery request is still unconfirmed/)).not.toBeInTheDocument());
  expect(invoke.mock.calls.filter(([command]) => command === "continue_execution")).toHaveLength(2);
  expect(invoke.mock.calls.some(([command]) => command === "recover_execution")).toBe(false);
});

it("resets replay permission after a second unknown and keeps deferred request on return", async () => {
  const value = detail(); value.recovery.units[0].actions = ["resume-undispatched"];
  const handle = createRef<TasksHandle>();
  const user = await openTasks(value, handle);
  await user.click(screen.getByRole("button", { name: "Continue remaining work" }));
  invoke.mockResolvedValueOnce(fixtureIdentity(6)).mockRejectedValueOnce(new Error("lost ACK"));
  await user.click(within(screen.getByRole("dialog", { name: "Continue remaining work" })).getByRole("button", { name: "Continue remaining work" }));
  invoke.mockResolvedValueOnce(null);
  await user.click(await screen.findByRole("button", { name: "Check original recovery request" }));
  invoke.mockRejectedValueOnce(new Error("second ACK lost"));
  await user.click(await screen.findByRole("button", { name: "Retry the same recovery request" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry the same recovery request" })).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "Keep request and return" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check original recovery request" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue remaining work" })).toBeDisabled();
  expect(await handle.current!.allowLeave()).toBe(false);
  const writes = invoke.mock.calls.filter(([command]) => command === "continue_execution");
  expect(writes[1][1]).toEqual(writes[0][1]);
});

it("finds a saved original continuation after reopening without resubmitting it", async () => {
  const value = detail();
  value.recovery.units[0].actions = []; value.recovery.units[0].blockedReason = "continued-in-new-attempt";
  const original: ContinuationRequest = { ...fixture.continuation, action: { ...fixture.continuation.action, kind: "resume-undispatched", expectedCancellationRevision: "0" } };
  const saved = continuationResult(original);
  invoke.mockImplementation(async (command: string, args: { request: { attemptId?: string; sourceAttemptId?: string; after?: string } }) => {
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks" || command === "read_execution_task_view") return command === "list_execution_tasks" ? [task] : task;
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_attempt") return args.request.attemptId === saved.attemptId ? { ...value, attemptId: saved.attemptId, recovery: { ...value.recovery, attemptId: saved.attemptId } } : value;
    if (command === "read_execution_continuations") return args.request.after === "0" && args.request.sourceAttemptId === saved.action.sourceAttemptId ? { receipts: [saved], next: null } : { receipts: [], next: null };
    if (command === "read_execution_continuation") return saved;
    throw new Error(`Unexpected command: ${command}`);
  });
  const handle = createRef<TasksHandle>();
  const user = userEvent.setup(); render(<ExecutionTasks project={project} disabled={false} ref={handle} />);
  await user.click(screen.getByRole("button", { name: "Tasks" }));
  await user.click(await screen.findByRole("button", { name: /Sample update/ }));
  await user.click(await screen.findByRole("button", { name: "View continued work" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_execution_attempt", { request: { ...fixture.session, attemptId: saved.attemptId, offset: 0, limit: 100 } }));
  expect(invoke.mock.calls.some(([command]) => command === "continue_execution" || command === "create_execution_identity")).toBe(false);
  expect(await handle.current!.allowLeave()).toBe(true);
});

function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (reason:unknown)=>void;
  const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};
}
function continuationDetail() {
  const value=detail();value.recovery.units[0].actions=["resume-undispatched"];value.recovery.units[0].blockedReason=null;
  value.items[0].status.execution="queued";value.progress.queued=1;value.progress.unknown=0;return value;
}
function applicationDetail() {
  const value=detail();value.recovery.units[0].actions=["adopt-result"];value.recovery.units[0].blockedReason=null;
  value.recovery.units[0].resultIds=[...fixture.prepare.resultIds];value.items[0].resultId=fixture.prepare.resultIds[0];
  value.items[0].status.execution="succeeded";value.items[0].status.validation="valid";value.progress.succeeded=1;value.progress.unknown=0;return value;
}

it("locks synchronously and keeps the confirmed revision-zero scope after current Task facts change before identity completes", async () => {
  const value=continuationDetail(),handle=createRef<TasksHandle>(),{user}=await mountTasks(value,handle),originalUnit=structuredClone(value.recovery.units[0]);
  await user.click(screen.getByRole("button",{name:"Continue remaining work"}));
  const original=invoke.getMockImplementation()!,identity=deferred<string>();
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?identity.promise
    :command==="read_execution_task_view"?Promise.resolve({...task,cancellationRevision:"2"})
    :command==="continue_execution"?Promise.reject({code:"cancelled",outcome:"rejected",stage:"execution-recover",recoveryRequired:false,reason:"continuation-cancellation-basis"})
    :original(command,payload));
  await refreshWorkbenchReads();await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name==="read_execution_task_view").length).toBeGreaterThan(1));
  value.recovery.units[0].unitId=fixtureIdentity(60);value.recovery.units[0].remainingItemIds=[fixtureIdentity(61)];
  const submit=within(screen.getByRole("dialog",{name:"Continue remaining work"})).getByRole("button",{name:"Continue remaining work"});
  act(()=>{submit.click();submit.click();});
  expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);
  expect(await handle.current!.allowLeave()).toBe(false);
  await act(async()=>{identity.resolve(fixtureIdentity(62));});
  await screen.findByRole("alert");
  const requests=invoke.mock.calls.filter(([name])=>name==="continue_execution").map(([,args])=>args.request);
  expect(requests).toEqual([{...fixture.session,action:{actionId:fixtureIdentity(62),projectId:fixture.session.projectId,
    sourceAttemptId:fixture.detail.attemptId,unitId:originalUnit.unitId,kind:"resume-undispatched",itemIds:originalUnit.remainingItemIds,expectedCancellationRevision:"0"}}]);
  expect(invoke.mock.calls.some(([name])=>name==="recover_execution")).toBe(false);
});

it.each(["identity","prepare","ack"] as const)("blocks the next adoption write and late owner updates when the session is replaced during %s", async stage => {
  const value=applicationDetail(),handle=createRef<TasksHandle>(),{user,view}=await mountTasks(value,handle),response=deferred<unknown>(),original=invoke.getMockImplementation()!;
  await user.click(screen.getByRole("button",{name:"Apply saved results"}));
  const waiting=stage==="identity"?"create_execution_identity":stage==="prepare"?"prepare_execution_adoption":"adopt_execution";
  invoke.mockImplementation((command:string,payload:unknown)=>command===waiting?response.promise
    :command==="create_execution_identity"?Promise.resolve(fixture.prepare.actionId):command==="prepare_execution_adoption"?Promise.resolve(fixture.action):original(command,payload));
  act(()=>within(screen.getByRole("dialog",{name:"Apply saved results"})).getByRole("button",{name:"Apply saved results"}).click());
  await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name===waiting)).toHaveLength(1));
  expect(await handle.current!.allowLeave()).toBe(false);
  const replacement={...project,sessionToken:"replacement-session"};view.rerender(<ExecutionTasks project={replacement} disabled={false} ref={handle}/>);
  await act(async()=>{response.resolve(stage==="identity"?fixture.prepare.actionId:stage==="prepare"?fixture.action:fixture.receipt);});
  expect(invoke.mock.calls.filter(([name])=>name==="adopt_execution")).toHaveLength(stage==="ack"?1:0);
  expect(invoke.mock.calls.filter(([name])=>name==="prepare_execution_adoption")).toHaveLength(stage==="identity"?0:1);
  expect(screen.queryByRole("heading",{name:"Recorded changes"})).not.toBeInTheDocument();
  expect(await handle.current!.allowLeave()).toBe(true);
});

it("keeps an uncertain application across Keep output and requires actual absence before an exact replay whose rejection remains unknown", async () => {
  const handle=createRef<TasksHandle>(),{user}=await mountTasks(applicationDetail(),handle);
  await user.click(screen.getByRole("button",{name:"Apply saved results"}));
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce(new Error("Preparation ACK lost"));
  await user.click(within(screen.getByRole("dialog",{name:"Apply saved results"})).getByRole("button",{name:"Apply saved results"}));
  await screen.findByRole("button",{name:"Check recorded outcome"});
  await user.click(screen.getByRole("button",{name:"Keep output and return"}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:i18n.t("workbench.backOverview")}));
  let leaveAllowed!:boolean;await act(async()=>{leaveAllowed=await handle.current!.allowLeave();});expect(leaveAllowed).toBe(false);
  const check=await screen.findByRole("button",{name:"Check recorded outcome"});
  invoke.mockResolvedValueOnce(project).mockResolvedValueOnce({...fixture.receipt,unitId:fixtureIdentity(70)});
  await user.click(check);await screen.findByRole("alert");
  expect(screen.queryByRole("button",{name:"Retry the same application"})).not.toBeInTheDocument();
  invoke.mockResolvedValueOnce(project).mockResolvedValueOnce(null);await user.click(check);
  const retry=await screen.findByRole("button",{name:"Retry the same application"});
  invoke.mockRejectedValueOnce({code:"cancelled",outcome:"rejected",stage:"execution-adopt",recoveryRequired:false,reason:"action-cancellation-basis"});
  await user.click(retry);await screen.findByText(i18n.t("execution.adoptionUnconfirmed"));
  expect(screen.queryByRole("button",{name:"Retry the same application"})).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:"All tasks"})).toBeDisabled();expect(await handle.current!.allowLeave()).toBe(false);
  const requests=invoke.mock.calls.filter(([name])=>name==="prepare_execution_adoption").map(([,args])=>args.request);
  expect(requests).toEqual([fixture.prepare,fixture.prepare]);expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);
});

it.each(["sequence","task","operation","null","rejected"] as const)("performs a new exact history lookup after a successful earlier choice and rejects a deferred %s", async outcome => {
  const value=detail();value.recovery.units[0].actions=[];
  const {user}=await mountTasks(value),original=invoke.getMockImplementation()!;
  const request:ContinuationRequest={...fixture.continuation,action:{...fixture.continuation.action,kind:"resume-undispatched",expectedCancellationRevision:"0"}},record=continuationResult(request);
  invoke.mockImplementation((command:string,payload:{request:{sourceAttemptId?:string}})=>command==="read_execution_continuations"?
    Promise.resolve({receipts:payload.request.sourceAttemptId===value.attemptId?[record]:[],next:null}):command==="read_execution_continuation"?Promise.resolve(record):original(command,payload));
  await refreshWorkbenchReads();await user.click(await screen.findByRole("button",{name:"View continued work"}));
  await waitFor(()=>expect(screen.getByRole("combobox")).toHaveValue(record.attemptId));
  await user.selectOptions(screen.getByRole("combobox"),value.attemptId);
  const choose=await screen.findByRole("button",{name:"View continued work"});await waitFor(()=>expect(choose).toBeEnabled());
  const pending=deferred<ContinuationReceipt|null>(),before=invoke.mock.calls.filter(([name])=>name==="read_execution_continuation").length,withHistory=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="read_execution_continuation"?pending.promise:withHistory(command,payload));
  await user.click(choose);await waitFor(()=>expect(invoke.mock.calls.filter(([name])=>name==="read_execution_continuation")).toHaveLength(before+1));
  await act(async()=>{
    if(outcome==="null")pending.resolve(null);else if(outcome==="rejected")pending.reject(new Error("Exact lookup failed"));
    else pending.resolve({...record,...(outcome==="sequence"?{sequence:"3"}:outcome==="task"?{taskId:fixtureIdentity(80)}:{operation:"other-operation"})});
  });
  await screen.findByRole("alert");expect(screen.getByRole("combobox")).toHaveValue(value.attemptId);
  expect(invoke.mock.calls.some(([name])=>name==="continue_execution"||name==="create_execution_identity")).toBe(false);
});

it("keeps the history cursor separate from item paging and reads a bounded empty terminal page without false absence", async () => {
  const value=detail();value.recovery.units[0].actions=[];const{user}=await mountTasks(value),original=invoke.getMockImplementation()!;
  const records=Array.from({length:50},(_,index)=>({...fixture.continuationReceipt,sequence:String(index+2),attemptId:fixtureIdentity(200+index),
    action:{...fixture.continuationReceipt.action,kind:"resume-undispatched" as const,actionId:fixtureIdentity(100+index),expectedCancellationRevision:"0"}}));
  invoke.mockImplementation((command:string,payload:{request:{after?:string}})=>command==="read_execution_continuations"?Promise.resolve(payload.request.after==="0"?
    {receipts:records,next:records.at(-1)!.sequence}:{receipts:[],next:null}):original(command,payload));
  await refreshWorkbenchReads();const history=screen.getByRole("heading",{name:"Recorded recovery requests"}).closest("section")!;
  await waitFor(()=>expect(within(history).getAllByRole("button",{name:"View continued work"})).toHaveLength(50));
  await user.click(within(history).getByRole("button",{name:"Next page"}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("read_execution_continuations",{request:{...fixture.session,sourceAttemptId:value.attemptId,after:records.at(-1)!.sequence,limit:50}}));
  await waitFor(()=>expect(within(history).queryByRole("button",{name:"View continued work"})).not.toBeInTheDocument());
  expect(within(history).getByRole("button",{name:"First page"})).toBeEnabled();
  expect(within(history).queryByText(i18n.t("execution.noContinuationHistory"))).not.toBeInTheDocument();
  const offsets=invoke.mock.calls.filter(([name])=>name==="read_execution_attempt").map(([,args])=>args.request.offset);
  expect(offsets.length).toBeGreaterThan(0);expect(offsets.every(offset=>offset===0)).toBe(true);
});

it.each(["source-import","translation-import","ai-translation","arena-translation"] as const)("routes %s application to its original preview owner without an execution adoption", async operation => {
  const value=applicationDetail();value.operation=operation;const{user,view}=await mountTasks(value);
  const source=vi.fn(),translation=vi.fn(),ai=vi.fn(),arena=vi.fn();
  view.rerender(<ExecutionTasks project={project} disabled={false} onSourcePreview={source} onTranslationPreview={translation} onAiPreview={ai} onArenaPreview={arena}/>);
  const label=operation==="source-import"?i18n.t("source.preview"):operation==="translation-import"?i18n.t("translation.preview"):i18n.t("execution.actions.adopt-result");
  await user.click(screen.getAllByRole("button",{name:label})[0]);
  const expected=operation==="source-import"?source:operation==="translation-import"?translation:operation==="ai-translation"?ai:arena;
  expect(expected).toHaveBeenCalledExactlyOnceWith(value.attemptId);
  expect([source,translation,ai,arena].filter(callback=>callback!==expected).every(callback=>callback.mock.calls.length===0)).toBe(true);
  expect(invoke.mock.calls.some(([name])=>name==="create_execution_identity"||name==="prepare_execution_adoption"||name==="adopt_execution")).toBe(false);
});

it("retains an authorized reused output while keeping an unknown original application for later recovery", async () => {
  const{user}=await mountTasks(applicationDetail());
  invoke.mockResolvedValueOnce({...fixture.output,attemptId:fixtureIdentity(90),outcome:"succeeded",output:{saved:"Original output"},diagnostic:null});
  await user.click(screen.getByRole("button",{name:"View saved output"}));
  const result=await screen.findByRole("region",{name:"Result for Sample A"});expect(within(result).getByText(/Original output/)).toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Apply saved results"}));
  invoke.mockResolvedValueOnce(fixture.prepare.actionId).mockRejectedValueOnce(new Error("Preparation ACK lost"));
  await user.click(within(screen.getByRole("dialog",{name:"Apply saved results"})).getByRole("button",{name:"Apply saved results"}));
  await user.click(await screen.findByRole("button",{name:"Keep output and return"}));
  expect(screen.getByRole("button",{name:"Check recorded outcome"})).toBeInTheDocument();
  expect(within(screen.getByRole("region",{name:"Result for Sample A"})).getByText(/Original output/)).toBeInTheDocument();
  expect(invoke.mock.calls.find(([name])=>name==="read_execution_output")![1].request).toEqual(fixture.outputRequest);
});

it("preserves the original unknown cancellation through malformed ACK and later rejection and only replays that request", async () => {
  const handle=createRef<TasksHandle>(),{user}=await mountTasks(detail(),handle),original=invoke.getMockImplementation()!;let sent=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?Promise.resolve(fixtureIdentity(95))
    :command==="cancel_execution_task"?++sent===1?Promise.reject(new Error("Cancel ACK lost")):sent===2?Promise.resolve("0")
    :sent===3?Promise.reject({code:"busy",outcome:"rejected",stage:"execution-cancel",recoveryRequired:false,reason:"execution-storage"}):Promise.resolve("1")
    :original(command,payload));
  await user.click(screen.getByRole("button",{name:"Cancel remaining work"}));
  await user.click(within(screen.getByRole("dialog",{name:"Cancel remaining work"})).getByRole("button",{name:"Cancel remaining work"}));
  await screen.findByRole("button",{name:"Retry the original cancellation"});
  await user.click(screen.getByRole("button",{name:"Keep request and return"}));
  expect(screen.getByRole("button",{name:"Cancel remaining work"})).toBeDisabled();expect(screen.getByRole("button",{name:"All tasks"})).toBeDisabled();
  expect(await handle.current!.allowLeave()).toBe(false);
  await user.click(screen.getByRole("button",{name:"Retry the original cancellation"}));
  await waitFor(()=>expect(sent).toBe(2));await waitFor(()=>expect(screen.getByRole("button",{name:"Retry the original cancellation"})).toBeEnabled());
  expect(screen.getByText(i18n.t("execution.cancellationUnconfirmed"))).toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"Retry the original cancellation"}));
  await waitFor(()=>expect(sent).toBe(3));await waitFor(()=>expect(screen.getByRole("button",{name:"Retry the original cancellation"})).toBeEnabled());
  expect(await handle.current!.allowLeave()).toBe(false);expect(screen.getByRole("button",{name:"Cancel remaining work"})).toBeDisabled();
  await user.click(screen.getByRole("button",{name:"Retry the original cancellation"}));
  await waitFor(()=>expect(screen.queryByRole("button",{name:"Retry the original cancellation"})).not.toBeInTheDocument());
  const request={...fixture.session,taskId:fixture.detail.taskId,requestId:fixtureIdentity(95)};
  expect(invoke.mock.calls.filter(([name])=>name==="cancel_execution_task").map(([,args])=>args.request)).toEqual([request,request,request,request]);
  expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);expect(await handle.current!.allowLeave()).toBe(true);
});

it("blocks close and ignores a late original cancellation ACK after an actual session replacement", async () => {
  const handle=createRef<TasksHandle>(),{user,view}=await mountTasks(detail(),handle),original=invoke.getMockImplementation()!,ack=deferred<string>();let sent=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?Promise.resolve(fixtureIdentity(96))
    :command==="cancel_execution_task"?++sent===1?Promise.reject(new Error("Cancel ACK lost")):ack.promise:original(command,payload));
  await user.click(screen.getByRole("button",{name:"Cancel remaining work"}));
  await user.click(within(screen.getByRole("dialog",{name:"Cancel remaining work"})).getByRole("button",{name:"Cancel remaining work"}));
  await user.click(await screen.findByRole("button",{name:"Keep request and return"}));
  const retry=screen.getByRole("button",{name:"Retry the original cancellation"});
  act(()=>{retry.click();retry.click();});await waitFor(()=>expect(sent).toBe(2));expect(await handle.current!.allowLeave()).toBe(false);
  const replacement={...project,sessionToken:"new-cancellation-session"};view.rerender(<ExecutionTasks project={replacement} disabled={false} ref={handle}/>);
  await act(async()=>{ack.resolve("1");});
  expect(screen.queryByText(i18n.t("execution.cancellationUnconfirmed"))).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name])=>name==="create_execution_identity")).toHaveLength(1);
  const requests=invoke.mock.calls.filter(([name])=>name==="cancel_execution_task").map(([,args])=>args.request);
  expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(await handle.current!.allowLeave()).toBe(true);
});
