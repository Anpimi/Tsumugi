import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/executionCommands.contract.json";
import { ExecutionTasks } from "./ExecutionTasks";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type TaskActionCommandPayload, type TaskConfirmedCommandPayload, type TaskPendingCommandPayload, type TaskHistoryCommandPayload, type TaskSavedBuildCommandPayload } from "./workbenchCommands";
import type { AttemptDetail, PrepareRequest, ContinuationRequest, ContinuationReceipt, AdoptionAction, Receipt } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { validateResponseAttempt } from "./generated/execution.validators";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: fixture.session.sessionToken, locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: fixture.session.projectId, displayName: "Tasks commands", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "tasks" as const };
let owner: ReturnType<typeof useExecutionTaskSession>, reads: ReturnType<typeof useSessionReads>, registry: ReturnType<typeof useWorkbenchCommands>;
let value: AttemptDetail, records: ContinuationReceipt[], pendingPrepare: PrepareRequest;
const preview = vi.fn();
const savedRoute = vi.fn<(attemptId:string)=>Promise<boolean>>();
function Probe() { const tasks = useExecutionTaskSession(), queries = useSessionReads(), commands = useWorkbenchCommands();
  useLayoutEffect(() => { owner = tasks; reads = queries; registry = commands; }); return null; }
function Harness({ mounted = true, project: current = project }: { mounted?: boolean; project?: ProjectView }) {
  return <><Probe />{mounted ? <ExecutionTasks project={current} disabled={false} onSourcePreview={preview} onTranslationPreview={preview} onAiPreview={preview} onArenaPreview={preview} onSavedBuild={savedRoute} /> : null}</>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function payloads(command: string) { return calls(command).map(([, payload]) => payload.request); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done,fail) => { resolve=done;reject=fail; }); return { promise,resolve,reject }; }
function makeDetail(action: TaskActionCommandPayload["action"] = "adopt-result") {
  const detail: unknown = structuredClone(fixture.detail);
  if (!validateResponseAttempt(detail)) throw new Error("Invalid initial Tasks fixture");
  Object.assign(detail.items[0].status, { execution: "succeeded", validation: "valid", cancellationRequested: false, diagnostic: null });
  detail.items[0].resultId = fixture.prepare.resultIds[0]; Object.assign(detail.progress, { succeeded: 1, unknown: 0 });
  Object.assign(detail.recovery.units[0], { actions: [action], blockedReason: null, resultIds: [...fixture.prepare.resultIds], remainingItemIds: action === "adopt-result" ? [] : [detail.items[0].status.itemId] });
  if (!validateResponseAttempt(detail)) throw new Error("Invalid Tasks command fixture"); return detail;
}
function actionPayload(action = value.recovery.units[0].actions[0] as TaskActionCommandPayload["action"]): TaskActionCommandPayload {
  const unit = value.recovery.units[0]; return { kind: "task-action", taskId: value.taskId, attemptId: value.attemptId, operation: value.operation, unitId: unit.unitId,
    action, itemIds: [...unit.itemIds], remainingItemIds: [...unit.remainingItemIds], resultIds: [...unit.resultIds], itemId: action === "query-outcome" ? unit.remainingItemIds[0] : null, offset: 0 };
}
function confirmedPayload(): TaskConfirmedCommandPayload {
  const intent = owner.currentActivity()!.intent; return { kind: "task-confirmed", taskId: intent.taskId, attemptId: intent.attemptId, operation: intent.operation, unitId: intent.unit.unitId,
    action: intent.action, itemIds: [...intent.unit.itemIds], remainingItemIds: [...intent.unit.remainingItemIds], resultIds: [...intent.unit.resultIds], itemId: intent.itemId ?? null, cancellationRevision: intent.cancellationRevision };
}
function pendingPayload(): TaskPendingCommandPayload {
  const entry = owner.currentActivity()!, target = { taskId: entry.intent.taskId, attemptId: entry.intent.attemptId, operation: entry.intent.operation, unitId: entry.intent.unit.unitId };
  if (entry.prepare) return { kind: "task-pending", ...target, requestKind: "adoption", actionId: entry.prepare.actionId, resultIds: [...entry.prepare.resultIds] };
  if (!entry.continuationRequest) throw new Error("No original continuation request"); const action = entry.continuationRequest.action;
  return { kind: "task-pending", ...target, requestKind: "continuation", actionId: action.actionId, action: action.kind, itemIds: [...action.itemIds], expectedCancellationRevision: action.expectedCancellationRevision };
}
function continuationFor(request: ContinuationRequest): ContinuationReceipt { return { ...fixture.continuationReceipt, action: structuredClone(request.action), taskId: value.taskId,
  operation: value.operation, attemptId: fixtureIdentity(980), sequence: "2" }; }
function actionFor(request: PrepareRequest): AdoptionAction { return {...fixture.action,projectId:request.projectId,attemptId:request.attemptId,
  actionId:request.actionId,unitId:request.unitId,resultIds:[...request.resultIds],operation:value.operation,cancellationRevision:"0",parameters:null}; }
function receiptFor(request: PrepareRequest): Receipt { return {...fixture.receipt,projectId:request.projectId,attemptId:request.attemptId,actionId:request.actionId,unitId:request.unitId}; }
function historyPayload(record: ContinuationReceipt): TaskHistoryCommandPayload { const action = record.action; return { kind: "task-history", taskId: record.taskId, sourceAttemptId: action.sourceAttemptId,
  operation: record.operation, actionId: action.actionId, unitId: action.unitId, action: action.kind, itemIds: [...action.itemIds], expectedCancellationRevision: action.expectedCancellationRevision,
  attemptId: record.attemptId, sequence: record.sequence, requestDigest: record.requestDigest, sourceInputDigest: record.sourceInputDigest, inputDigest: record.inputDigest, cursor: "0" }; }
function queryKey() { return reads.key(["tasks",value.taskId,null,"0","0",0]); }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); preview.mockReset();savedRoute.mockReset();savedRoute.mockResolvedValue(false); value = makeDetail(); records = []; pendingPrepare = {...fixture.prepare};
  let identity = 910;
  invoke.mockReset(); invoke.mockImplementation(async (command: string, payload: { request: Record<string, unknown> }) => {
    const request = payload.request;
    if (command === "execution_status") return fixture.status;
    if (command === "list_execution_tasks") return [{ ...fixture.task, taskId: value.taskId, operation: value.operation, sequence: "1", cancellationRevision: "0" }];
    if (command === "read_execution_task") return [{ attemptId: value.attemptId, sequence: "1" }];
    if (command === "read_execution_task_view") return { ...fixture.task, taskId: value.taskId, operation: value.operation, cancellationRevision: "0" };
    if (command === "read_execution_attempt") return { ...structuredClone(value), attemptId: request.attemptId, recovery: { ...structuredClone(value.recovery), attemptId: request.attemptId } };
    if (command === "read_execution_continuations") return { receipts: records.filter(record => record.action.sourceAttemptId === request.sourceAttemptId), next: null };
    if (command === "read_execution_continuation") return records.find(record => record.action.actionId === request.actionId) ?? null;
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "prepare_execution_adoption") { pendingPrepare = request as unknown as PrepareRequest; return actionFor(pendingPrepare); }
    if (command === "adopt_execution" || command === "read_execution_receipt") return receiptFor(pendingPrepare);
    if (command === "continue_execution") return continuationFor(request as unknown as ContinuationRequest);
    if (command === "recover_execution") return { attemptId: request.attemptId, queryStarted: request.action === "query-outcome" };
    if (command === "cancel_execution_task") return "1";
    if (command === "read_execution_cancellation_action") return null;
    if (command === "read_execution_output") return { ...fixture.output, outcome: "succeeded", output: { saved: "A" }, diagnostic: null };
    throw new Error(command);
  });
});
afterEach(cleanup);
async function open() {
  const user = userEvent.setup(), rendered = render(<Harness project={project} />, project);
  await user.click(screen.getByRole("button", { name: "Tasks" })); await user.click(await screen.findByRole("button", { name: /Task 1/ }));
  await waitFor(() => expect(registry.describe("tasks.adopt-result", scope, actionPayload("adopt-result"))).toBeDefined());
  await waitFor(() => expect(reads.client.getQueryState(queryKey())?.fetchStatus).toBe("idle"));
  await waitFor(() => expect(reads.client.getQueryState(queryKey())?.status).toBe("success"));
  return { user,rendered };
}
async function capture(action: TaskActionCommandPayload["action"] = "adopt-result") {
  const id = `tasks.${action}` as const;
  await waitFor(() => expect(registry.describe(id,scope,actionPayload(action))?.availability.enabled).toBe(true));
  await act(async () => { expect(registry.dispatch(id,scope,actionPayload(action))).toBe(true); });
  await waitFor(() => expect(owner.currentActivity()?.phase).toBe("confirming"));
  await waitFor(() => expect(registry.describe("tasks.submit-action",scope,confirmedPayload())?.availability.enabled).toBe(true));
}

it("registers the scoped Tasks commands and routes a fixed adoption through the real confirmation buttons", async () => {
  const { user } = await open(), dispatch = vi.spyOn(registry,"dispatch");
  expect(registry.list(scope).filter(command=>command.category==="tasks").map(command=>command.id).sort()).toEqual([
    "tasks.adopt-result","tasks.cancel-task","tasks.check-cancellation","tasks.confirm-cancellation","tasks.open-preview","tasks.open-saved-build","tasks.query-outcome","tasks.reconcile-adoption","tasks.reconcile-continuation",
    "tasks.resume-undispatched","tasks.retry-adoption","tasks.retry-cancellation","tasks.retry-continuation","tasks.retry-safe-failure","tasks.submit-action","tasks.validate-output",
    "tasks.view-continuation","tasks.view-output","tasks.view-receipt",
  ]);
  expect(registry.list(scope).filter(command=>command.category==="tasks").every(command=>command.binding===null)).toBe(true);
  await user.click(screen.getByRole("button",{name:"Apply saved results"}));
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("confirming"));
  expect(owner.currentActivity()?.intent.items.map(item=>item.status.itemId)).toEqual(value.recovery.units[0].itemIds);
  expect(registry.describe("tasks.submit-action",scope,confirmedPayload())?.confirmation).toBe("required");
  await user.click(within(screen.getByRole("dialog",{name:"Apply saved results"})).getByRole("button",{name:"Apply saved results"}));
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("recorded"));
  expect(payloads("prepare_execution_adoption")[0]).toMatchObject({attemptId:value.attemptId,unitId:value.recovery.units[0].unitId,resultIds:value.recovery.units[0].resultIds});
  expect(calls("create_execution_identity")).toHaveLength(1); expect(calls("adopt_execution")).toHaveLength(1);
  expect(dispatch.mock.calls.map(([id])=>id)).toEqual(expect.arrayContaining(["tasks.adopt-result","tasks.submit-action"]));
});

it("rejects wrong, hidden, retired, errored and fetching fresh scopes without allocating a business identity", async () => {
  const { rendered } = await open(), payload = actionPayload();
  expect(registry.dispatch("tasks.adopt-result",scope,{...payload,unitId:fixtureIdentity(990)})).toBe(false);
  expect(registry.dispatch("tasks.adopt-result",scope,{...payload,remainingItemIds:[payload.itemIds[0]]})).toBe(false);
  expect(registry.dispatch("tasks.adopt-result",{...scope,sessionToken:"old"},payload)).toBe(false);
  const query = reads.client.getQueryCache().find({queryKey:queryKey(),exact:true})!;
  act(()=>query.setState({fetchStatus:"fetching"})); expect(registry.dispatch("tasks.adopt-result",scope,payload)).toBe(false);
  act(()=>query.setState({fetchStatus:"idle",status:"error",error:new Error("Read failed")})); expect(registry.describe("tasks.adopt-result",scope,payload)?.availability.enabled).toBe(false);
  act(()=>query.setState({status:"success",error:null,isInvalidated:true})); expect(registry.dispatch("tasks.adopt-result",scope,payload)).toBe(false);
  rendered.rerender(<Harness mounted={false} project={project} />,project); expect(registry.describe("tasks.adopt-result",scope,payload)).toBeUndefined();
  act(()=>reads.retire()); expect(calls("create_execution_identity")).toHaveLength(0); expect(owner.currentActivity()).toBeNull();
});

it.each(["resume-undispatched","retry-safe-failure","validate-output","query-outcome"] as const)("routes %s through the original owner without conflating continuation and outcome-query scope", async action => {
  value = makeDetail(action); await open(); await capture(action);
  expect(owner.currentActivity()?.intent.itemId).toBe(action==="query-outcome"?value.recovery.units[0].remainingItemIds[0]:undefined);
  expect(owner.currentActivity()?.intent.cancellationRevision).toBe(action==="resume-undispatched"||action==="retry-safe-failure"?"0":null);
  await act(async()=>{expect(registry.dispatch("tasks.submit-action",scope,confirmedPayload())).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("recorded"));
  if(action==="resume-undispatched"||action==="retry-safe-failure")expect(payloads("continue_execution")[0].action).toMatchObject({kind:action,itemIds:value.recovery.units[0].remainingItemIds,expectedCancellationRevision:"0"});
  else { expect(payloads("recover_execution")[0]).toMatchObject({action,itemIds:value.recovery.units[0].remainingItemIds});expect(calls("create_execution_identity")).toHaveLength(0); }
});

it("confirms the owner's original request through Registry after the live latest selector moves to a different attempt", async () => {
  const {user}=await open();await capture();const captured=owner.currentActivity()!.intent,payload=confirmedPayload(),fresh=structuredClone(value),original=invoke.getMockImplementation()!;
  fresh.attemptId=fixtureIdentity(997);fresh.recovery.attemptId=fresh.attemptId;fresh.recovery.units[0].unitId=fixtureIdentity(998);
  fresh.recovery.units[0].scopes[0].id="Newer group";fresh.items[0].scope.id="Newer group";
  invoke.mockImplementation((command:string,request:unknown)=>command==="read_execution_task"?Promise.resolve([{attemptId:fresh.attemptId,sequence:"2"}])
    :command==="read_execution_attempt"?Promise.resolve(fresh):command==="create_execution_identity"?Promise.resolve(fixture.prepare.actionId)
    :command==="adopt_execution"?Promise.reject({code:"permission-denied",outcome:"rejected",stage:"execution-adopt",recoveryRequired:false,reason:"continued-in-new-attempt"})
    :original(command,request));
  act(()=>reads.invalidate(["execution"]));
  await waitFor(()=>expect((reads.client.getQueryData<{detail:AttemptDetail}>(queryKey()))?.detail.attemptId).toBe(fresh.attemptId));
  const dialog=screen.getByRole("dialog",{name:"Apply saved results"});
  expect(within(dialog).getByText(`${captured.unit.scopes[0].id} · zh-CN`,{selector:"li"})).toBeInTheDocument();
  expect(within(dialog).queryByText("Newer group · zh-CN")).not.toBeInTheDocument();
  expect(owner.currentActivity()?.intent).toBe(captured);expect(registry.describe("tasks.submit-action",scope,payload)?.availability.enabled).toBe(true);
  const dispatch=vi.spyOn(registry,"dispatch");await user.click(within(dialog).getByRole("button",{name:"Apply saved results"}));
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("rejected"));
  expect(dispatch).toHaveBeenCalledWith("tasks.submit-action",scope,payload);
  expect(payloads("prepare_execution_adoption")).toEqual([fixture.prepare]);expect(payloads("adopt_execution")).toEqual([fixture.adopt]);
  expect(owner.currentActivity()?.intent).toBe(captured);expect(owner.currentActivity()?.failure).toMatchObject({reason:"continued-in-new-attempt"});
});

it("reserves submission synchronously and preserves the captured owner through full consumer unmount and Query eviction", async () => {
  const { rendered } = await open(); await capture();
  const response = deferred<string>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?response.promise:original(command,payload));
  const originalWatch=reads.watchExactQuery.bind(reads),dispose=vi.fn();
  vi.spyOn(reads,"watchExactQuery").mockImplementation(key=>{const witness=originalWatch(key);return{current:witness.current,dispose:()=>{dispose();witness.dispose();}};});
  const payload=confirmedPayload();
  act(()=>{expect(registry.dispatch("tasks.submit-action",scope,payload)).toBe(true);expect(registry.dispatch("tasks.submit-action",scope,payload)).toBe(false);});
  rendered.rerender(<Harness mounted={false} project={project} />,project);
  act(()=>reads.client.removeQueries({queryKey:queryKey(),exact:true}));
  await act(async()=>{response.resolve(fixtureIdentity(990));});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("recorded"));
  expect(calls("create_execution_identity")).toHaveLength(1);expect(calls("adopt_execution")).toHaveLength(1);expect(dispose).toHaveBeenCalledTimes(1);
  rendered.rerender(<Harness project={project} />,project);expect(await screen.findByText(i18n.t("execution.adoptionRecorded"))).toBeInTheDocument();
});

it.each([["identity","error"],["identity","contradiction"],["prepare","error"]] as const)("rejects a removed replacement Query during %s with %s and disposes the business-flight listener", async (stage,change) => {
  const { rendered } = await open(); await capture();
  const response=deferred<unknown>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,payload:unknown)=>{
    if(command===(stage==="identity"?"create_execution_identity":"prepare_execution_adoption")){
      if(stage==="prepare")await original(command,payload);return response.promise;
    }return original(command,payload);
  });
  const originalWatch=reads.watchExactQuery.bind(reads),dispose=vi.fn();
  vi.spyOn(reads,"watchExactQuery").mockImplementation(key=>{const witness=originalWatch(key);return{current:witness.current,dispose:()=>{dispose();witness.dispose();}};});
  act(()=>{expect(registry.dispatch("tasks.submit-action",scope,confirmedPayload())).toBe(true);});
  await waitFor(()=>expect(calls(stage==="identity"?"create_execution_identity":"prepare_execution_adoption")).toHaveLength(1));
  rendered.rerender(<Harness mounted={false} project={project} />,project);
  const key=queryKey(),replacement=structuredClone(value);
  if(change==="contradiction"){replacement.items[0].scope.id="Changed scope";replacement.recovery.units[0].scopes[0].id="Changed scope";}
  act(()=>{
    reads.client.removeQueries({queryKey:key,exact:true});reads.client.setQueryData(key,{runtime:fixture.status,tasks:[],attempts:[{attemptId:value.attemptId,sequence:"1"}],detail:replacement});
    if(change==="error")reads.client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:"error",error:new Error("Replacement failed")});
    reads.client.removeQueries({queryKey:key,exact:true});
  });
  await act(async()=>{response.resolve(stage==="identity"?fixtureIdentity(990):actionFor(pendingPrepare));});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe(stage==="identity"?"rejected":"unknown"));
  expect(calls("adopt_execution")).toHaveLength(0);expect(dispose).toHaveBeenCalledTimes(1);
  if(stage==="prepare"){expect(owner.currentActivity()?.prepare).toEqual(pendingPrepare);expect(owner.currentActivity()?.proof).toEqual(actionFor(pendingPrepare));}
});

it("preserves an unknown continuation's exact original scope through mismatched lookup, actual null and later rejected replay", async () => {
  value=makeDetail("resume-undispatched");await open();await capture("resume-undispatched");
  const original=invoke.getMockImplementation()!;let sent=0,lookups=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="continue_execution"?Promise.reject(++sent===1?new Error("Lost ACK"):
    {code:"cancelled",outcome:"rejected",stage:"execution-recover",recoveryRequired:false,reason:"continuation-cancellation-basis"}):
    command==="read_execution_continuation"&&++lookups===1?Promise.reject(new Error("Automatic lookup unavailable")):original(command,payload));
  await act(async()=>{expect(registry.dispatch("tasks.submit-action",scope,confirmedPayload())).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("unknown"));
  const payload=pendingPayload(),request=payloads("continue_execution")[0] as ContinuationRequest;
  expect(calls("read_execution_continuation")).toHaveLength(1);
  expect(registry.dispatch("tasks.retry-continuation",scope,payload)).toBe(false);
  expect(registry.dispatch("tasks.reconcile-continuation",scope,{...payload,actionId:fixtureIdentity(999)})).toBe(false);
  records=[{...continuationFor(request),action:{...request.action,unitId:fixtureIdentity(999)}}];
  await act(async()=>{expect(registry.dispatch("tasks.reconcile-continuation",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("unknown"));expect(owner.currentActivity()?.retryAllowed).toBe(false);
  records=[]; await act(async()=>{expect(registry.dispatch("tasks.reconcile-continuation",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.retryAllowed).toBe(true));
  act(()=>reads.client.removeQueries({queryKey:queryKey(),exact:true}));
  await act(async()=>{expect(registry.dispatch("tasks.retry-continuation",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("unknown"));expect(owner.currentActivity()?.retryAllowed).toBe(false);
  expect(payloads("continue_execution")).toEqual([request,request]);expect(calls("create_execution_identity")).toHaveLength(1);
});

it("cancels a retained checked Task during read failure and retries the original cross-origin cancellation through feedback", async () => {
  const {user}=await open(),query=reads.client.getQueryCache().find({queryKey:queryKey(),exact:true})!;
  act(()=>query.setState({status:"error",error:new Error("Background read failed")}));
  const target={kind:"execution-cancellation" as const,taskId:value.taskId,attemptId:value.attemptId,origin:"tasks" as const};
  expect(registry.describe("tasks.confirm-cancellation",scope,target)?.availability.enabled).toBe(true);
  expect(registry.dispatch("tasks.confirm-cancellation",scope,{...target,taskId:fixtureIdentity(999)})).toBe(false);
  expect(registry.dispatch("tasks.confirm-cancellation",scope,{...target,attemptId:fixtureIdentity(999)})).toBe(false);
  expect(registry.dispatch("tasks.confirm-cancellation",scope,{...target,origin:"ai"})).toBe(false);
  const original=invoke.getMockImplementation()!;let count=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="cancel_execution_task"&&++count===1?Promise.reject(new Error("Lost cancel ACK")):original(command,payload));
  await user.click(screen.getByRole("button",{name:"Cancel remaining work"}));
  await user.click(within(screen.getByRole("dialog",{name:"Cancel remaining work"})).getByRole("button",{name:"Cancel remaining work"}));
  await screen.findByRole("button",{name:"Retry the original cancellation"});
  const entry=owner.current(value.taskId);if(entry?.phase!=="unknown")throw new Error("Expected original unknown cancellation");
  expect(owner.canBegin(value.taskId)).toBe(false);
  const wrong={kind:"execution-cancellation-retry" as const,...entry.target,requestId:fixtureIdentity(999)};
  expect(registry.dispatch("tasks.retry-cancellation",scope,wrong)).toBe(false);
  await user.click(screen.getByRole("button",{name:"Retry the original cancellation"}));
  await waitFor(()=>expect(owner.current(value.taskId)?.phase).toBe("recorded"));
  expect(payloads("cancel_execution_task")[0]).toEqual(payloads("cancel_execution_task")[1]);
  const other={taskId:fixtureIdentity(995),attemptId:fixtureIdentity(996),origin:"arena" as const};
  invoke.mockImplementation((command:string,payload:unknown)=>command==="cancel_execution_task"?Promise.reject(new Error("Other ACK lost")):original(command,payload));
  await act(async()=>{await owner.cancel(other);});
  const otherEntry=owner.current(other.taskId);if(otherEntry?.phase!=="unknown")throw new Error("Expected original cross-origin cancellation");
  const intent={kind:"execution-cancellation-retry" as const,...otherEntry.target,requestId:otherEntry.request.requestId};
  expect(registry.describe("tasks.retry-cancellation",scope,intent)?.availability.enabled).toBe(true);
  invoke.mockImplementation(original); await act(async()=>{expect(registry.dispatch("tasks.retry-cancellation",scope,intent)).toBe(true);});
  await waitFor(()=>expect(owner.current(other.taskId)?.phase).toBe("recorded"));
});

it("keeps another Task's original cancellation feedback recoverable while the current adoption remains unknown", async () => {
  const {user}=await open();await capture();const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="adopt_execution"||command==="cancel_execution_task"
    ?Promise.reject(new Error("Lost original ACK")):original(command,payload));
  await act(async()=>{expect(registry.dispatch("tasks.submit-action",scope,confirmedPayload())).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("unknown"));
  const activity=owner.currentActivity(),target={taskId:fixtureIdentity(995),attemptId:fixtureIdentity(996),origin:"source" as const};
  await act(async()=>{await owner.cancel(target);});
  const entry=owner.current(target.taskId);if(entry?.phase!=="unknown")throw new Error("Expected the other original cancellation");
  const payload={kind:"execution-cancellation-retry" as const,...entry.target,requestId:entry.request.requestId};
  act(()=>reads.client.removeQueries({queryKey:queryKey(),exact:true}));
  expect(registry.describe("tasks.retry-cancellation",scope,payload)?.availability.enabled).toBe(true);
  const button=screen.getByRole("button",{name:"Retry the original cancellation"});expect(button).toBeEnabled();
  invoke.mockImplementation(original);await user.click(button);
  await waitFor(()=>expect(owner.current(target.taskId)?.phase).toBe("recorded"));
  expect(owner.currentActivity()).toBe(activity);
  const requests=payloads("cancel_execution_task");expect(requests).toEqual([entry.request,entry.request]);
  expect(calls("create_execution_identity")).toHaveLength(2);
});

it("routes a pure cancellation check through Registry only for the complete original pending identity",async()=>{
  await open();const original=invoke.getMockImplementation()!;let lookups=0;
  invoke.mockImplementation((command:string,args:unknown)=>command==="cancel_execution_task"?Promise.reject(new Error("Lost ACK"))
    :command==="read_execution_cancellation_action"?++lookups===1?Promise.reject(new Error("Automatic check unavailable")):Promise.resolve(null):original(command,args));
  await act(async()=>{await owner.cancel({taskId:value.taskId,attemptId:value.attemptId,origin:"tasks"});});
  const entry=owner.current(value.taskId);if(entry?.phase!=="unknown")throw new Error("Missing original cancellation");
  const payload={kind:"execution-cancellation-retry" as const,...entry.target,requestId:entry.request.requestId};
  expect(registry.describe("tasks.check-cancellation",scope,payload)).toMatchObject({risk:"reads-execution",availability:{enabled:true}});
  expect(registry.dispatch("tasks.retry-cancellation",scope,payload)).toBe(false);
  for(const patch of [{taskId:fixtureIdentity(999)},{attemptId:fixtureIdentity(999)},{origin:"source" as const},{requestId:fixtureIdentity(999)}]){
    expect(registry.dispatch("tasks.check-cancellation",scope,{...payload,...patch})).toBe(false);
  }
  await act(async()=>{expect(registry.dispatch("tasks.check-cancellation",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.current(value.taskId)).toMatchObject({phase:"unknown",retryAllowed:true}));
  expect(payloads("read_execution_cancellation_action")).toEqual([entry.request,entry.request]);expect(calls("cancel_execution_task")).toHaveLength(1);expect(calls("create_execution_identity")).toHaveLength(1);
});

it("routes current source preview and checked output/receipt reads using exact targets", async () => {
  value.operation="source-import";const {user}=await open();
  const payload={kind:"task-preview" as const,taskId:value.taskId,attemptId:value.attemptId,operation:value.operation,area:"source" as const,unitId:value.recovery.units[0].unitId};
  expect(registry.dispatch("tasks.open-preview",scope,{...payload,area:"ai"})).toBe(false);
  await act(async()=>{expect(registry.dispatch("tasks.open-preview",scope,payload)).toBe(true);});expect(preview).toHaveBeenCalledWith(value.attemptId);
  const item=value.items[0],output={kind:"task-output" as const,taskId:value.taskId,attemptId:value.attemptId,operation:value.operation,itemId:item.status.itemId,resultId:item.resultId!};
  expect(registry.dispatch("tasks.view-output",scope,{...output,itemId:fixtureIdentity(999)})).toBe(false);
  await user.click(screen.getByRole("button",{name:"View saved output"}));await screen.findByText(/"saved": "A"/);
  value=makeDetail();value.recovery.units[0].actions=["view-receipt"];value.recovery.units[0].receiptId=fixture.prepare.actionId;
  pendingPrepare={...fixture.prepare};act(()=>reads.client.setQueryData(queryKey(),{runtime:fixture.status,tasks:[],task:{...fixture.task,taskId:value.taskId,operation:value.operation,cancellationRevision:"0"},attempts:[{attemptId:value.attemptId,sequence:"1"}],detail:structuredClone(value)}));
  const receipt={kind:"task-receipt" as const,taskId:value.taskId,attemptId:value.attemptId,operation:value.operation,unitId:value.recovery.units[0].unitId,actionId:fixture.prepare.actionId};
  await waitFor(()=>expect(registry.describe("tasks.view-receipt",scope,receipt)?.availability.enabled).toBe(true));
  expect(registry.dispatch("tasks.view-receipt",scope,{...receipt,actionId:fixtureIdentity(999)})).toBe(false);
  await act(async()=>{expect(registry.dispatch("tasks.view-receipt",scope,receipt)).toBe(true);});await screen.findByText("9007199254740993",{exact:false});
});

it("starts a new exact history intent for every repeated choice and cannot navigate on a later removed or mismatched receipt", async () => {
  const originalRequest:ContinuationRequest={...fixture.continuation,action:{...fixture.continuation.action,kind:"resume-undispatched",expectedCancellationRevision:"0"}};
  records=[continuationFor(originalRequest)];value.recovery.units[0].actions=[];
  const {user}=await open(),record=records[0];
  await waitFor(()=>expect(registry.describe("tasks.view-continuation",scope,historyPayload(record))?.availability.enabled).toBe(true));
  expect(registry.dispatch("tasks.view-continuation",scope,{...historyPayload(record),inputDigest:"d".repeat(64)})).toBe(false);
  await act(async()=>{expect(registry.dispatch("tasks.view-continuation",scope,historyPayload(record))).toBe(true);});
  await waitFor(()=>expect(screen.getByRole("combobox")).toHaveValue(record.attemptId));
  await user.selectOptions(screen.getByRole("combobox"),value.attemptId);
  await waitFor(()=>expect(registry.describe("tasks.view-continuation",scope,historyPayload(record))?.availability.enabled).toBe(true));
  const response=deferred<ContinuationReceipt|null>(),original=invoke.getMockImplementation()!,before=calls("read_execution_continuation").length;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="read_execution_continuation"?response.promise:original(command,payload));
  await act(async()=>{expect(registry.dispatch("tasks.view-continuation",scope,historyPayload(record))).toBe(true);});
  await waitFor(()=>expect(calls("read_execution_continuation")).toHaveLength(before+1));
  await act(async()=>{response.resolve(null);});await screen.findByRole("alert");
  expect(screen.getByRole("combobox")).toHaveValue(value.attemptId);expect(calls("continue_execution")).toHaveLength(0);
});

it.each(["retire","replace"] as const)("does not dispatch after the original session %s during identity and releases its Query listener", async mode => {
  const {rendered}=await open();await capture();const response=deferred<string>(),original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="create_execution_identity"?response.promise:original(command,payload));
  const cache=reads.client.getQueryCache(),subscribe=cache.subscribe.bind(cache),disposed=vi.fn();
  vi.spyOn(cache,"subscribe").mockImplementation(listener=>{const stop=subscribe(listener);return()=>{disposed();stop();};});
  const payload=confirmedPayload();act(()=>{expect(registry.dispatch("tasks.submit-action",scope,payload)).toBe(true);});
  if(mode==="retire")act(()=>reads.retire());
  else {const replacement={...project,sessionToken:"replacement-session"};rendered.rerender(<Harness project={replacement}/>,replacement);expect(owner.currentActivity()).toBeNull();}
  await act(async()=>{response.resolve(fixtureIdentity(990));});
  expect(calls("prepare_execution_adoption")).toHaveLength(0);expect(calls("adopt_execution")).toHaveLength(0);
  expect(disposed).toHaveBeenCalledTimes(1);expect(calls("create_execution_identity")).toHaveLength(1);
  expect(registry.dispatch("tasks.submit-action",scope,payload)).toBe(false);
});

it("checks actual receipt absence before replaying an unknown adoption and keeps its original scope independently of Query", async () => {
  await open();await capture();const original=invoke.getMockImplementation()!;let count=0,lookups=0;
  invoke.mockImplementation((command:string,payload:unknown)=>command==="adopt_execution"&&++count===1?Promise.reject(new Error("Adoption ACK lost")):
    command==="read_execution_adoption_action"?++lookups===1?Promise.reject(new Error("Automatic lookup unavailable")):Promise.resolve(null):original(command,payload));
  await act(async()=>{expect(registry.dispatch("tasks.submit-action",scope,confirmedPayload())).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("unknown"));const payload=pendingPayload(),request=pendingPrepare;
  if(payload.requestKind!=="adoption")throw new Error("Expected original adoption");
  expect(registry.dispatch("tasks.retry-adoption",scope,payload)).toBe(false);
  expect(registry.dispatch("tasks.reconcile-adoption",scope,{...payload,resultIds:[fixtureIdentity(999)]})).toBe(false);
  act(()=>reads.client.removeQueries({queryKey:queryKey(),exact:true}));
  await act(async()=>{expect(registry.dispatch("tasks.reconcile-adoption",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.retryAllowed).toBe(true));
  await act(async()=>{expect(registry.dispatch("tasks.retry-adoption",scope,payload)).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("recorded"));
  expect(payloads("prepare_execution_adoption")).toEqual([request,request]);expect(calls("create_execution_identity")).toHaveLength(1);
  expect(owner.currentActivity()?.receipt).toEqual(receiptFor(request));
});

it("keeps the fixed revision-zero capture when the complete Tasks consumer remounts before confirmation", async () => {
  value=makeDetail("resume-undispatched");const{rendered,user}=await open();
  const original=invoke.getMockImplementation()!,captureReads:unknown[]=[];
  invoke.mockImplementation((command:string,payload:unknown)=>{
    if(command==="read_execution_task_view"&&owner.currentActivity()?.phase==="capturing")captureReads.push(structuredClone(payload));
    return original(command,payload);
  });
  await capture("resume-undispatched");
  const captured=owner.currentActivity()?.intent;expect(captured?.cancellationRevision).toBe("0");
  rendered.rerender(<Harness mounted={false} project={project} />,project);
  rendered.rerender(<Harness project={project} />,project);
  await screen.findByRole("dialog",{name:"Continue remaining work"});
  expect(owner.currentActivity()?.intent).toBe(captured);
  await user.click(within(screen.getByRole("dialog",{name:"Continue remaining work"})).getByRole("button",{name:"Continue remaining work"}));
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("recorded"));
  expect(payloads("continue_execution")[0].action).toMatchObject({expectedCancellationRevision:"0",unitId:captured?.unit.unitId,itemIds:captured?.unit.remainingItemIds});
  expect(captureReads).toEqual([{request:{...fixture.session,taskId:captured?.taskId}}]);
  expect(payloads("read_execution_task_view").every(request=>request.projectId===fixture.session.projectId&&request.sessionToken===fixture.session.sessionToken&&request.taskId===captured?.taskId)).toBe(true);
  expect(calls("create_execution_identity")).toHaveLength(1);
  expect(calls("continue_execution")).toHaveLength(1);
});


it("awaits an exact saved-build route and keeps its current Task when the destination owner refuses",async()=>{
  value.operation="locale-build";value.recovery.units[0].actions=[];const {user}=await open();
  const payload:TaskSavedBuildCommandPayload={kind:"task-saved-build",taskId:value.taskId,attemptId:value.attemptId,operation:"locale-build",itemId:null,resultId:null};
  expect(registry.describe("tasks.open-saved-build",scope,payload)?.availability.enabled).toBe(true);
  expect(registry.dispatch("tasks.open-saved-build",{...scope,sessionToken:"old"},payload)).toBe(false);
  expect(registry.dispatch("tasks.open-saved-build",scope,{...payload,taskId:fixtureIdentity(989)})).toBe(false);
  expect(registry.dispatch("tasks.open-saved-build",scope,{...payload,itemId:value.items[0].status.itemId,resultId:fixtureIdentity(988)})).toBe(false);
  const response=deferred<boolean>();savedRoute.mockReturnValue(response.promise);
  const button=screen.getByRole("button",{name:i18n.t("releasePlugin.savedOpen")});
  await user.click(button);
  expect(savedRoute.mock.calls).toEqual([[value.attemptId]]);
  expect(screen.getByRole("heading",{name:i18n.t("execution.title")})).toBeVisible();
  expect(registry.dispatch("tasks.open-saved-build",scope,payload)).toBe(false);
  await act(async()=>response.resolve(false));
  expect(await screen.findByText(i18n.t("execution.savedBuildBlocked"))).toBeInTheDocument();
  expect(screen.getByRole("heading",{name:i18n.t("execution.title")})).toBeVisible();
  expect(calls("create_execution_identity")).toHaveLength(0);expect(calls("prepare_execution_adoption")).toHaveLength(0);
});

it.each(["retired","replaced"] as const)("ignores a saved-build route accepted after the original session is %s",async boundary=>{
  value.operation="locale-build";value.recovery.units[0].actions=[];
  const {rendered,user}=await open(),response=deferred<boolean>();
  const payload:TaskSavedBuildCommandPayload={kind:"task-saved-build",taskId:value.taskId,attemptId:value.attemptId,operation:"locale-build",itemId:null,resultId:null};
  savedRoute.mockReturnValue(response.promise);
  await user.click(screen.getByRole("button",{name:i18n.t("releasePlugin.savedOpen")}));
  expect(savedRoute.mock.calls).toEqual([[value.attemptId]]);
  if(boundary==="retired")act(()=>reads.retire());
  else {
    const replacement={...project,sessionToken:"replacement-saved-route-session"};
    rendered.rerender(<Harness project={replacement}/>,replacement);
  }
  await act(async()=>{response.resolve(true);await response.promise;});
  expect(screen.getByRole("heading",{name:i18n.t("execution.title")})).toBeVisible();
  expect(registry.dispatch("tasks.open-saved-build",scope,payload)).toBe(false);
  expect(savedRoute).toHaveBeenCalledTimes(1);
  expect(calls("read_saved_plugin_build")).toHaveLength(0);
  expect(calls("create_execution_identity")).toHaveLength(0);
  expect(calls("prepare_execution_adoption")).toHaveLength(0);
});

it("blocks a saved-build route while an original continuation remains unknown without clearing its captured scope",async()=>{
  value=makeDetail("resume-undispatched");value.operation="locale-build";value.items[0].status.execution="queued";
  const {rendered}=await open();await capture("resume-undispatched");
  const original=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args)=>command==="continue_execution"?Promise.reject(new Error("ACK lost")):original(command,args));
  await act(async()=>{expect(registry.dispatch("tasks.submit-action",scope,confirmedPayload())).toBe(true);});
  await waitFor(()=>expect(owner.currentActivity()?.phase).toBe("unknown"));
  const captured=owner.currentActivity(),payload:TaskSavedBuildCommandPayload={kind:"task-saved-build",taskId:value.taskId,attemptId:value.attemptId,operation:"locale-build",itemId:null,resultId:null};
  expect(registry.dispatch("tasks.open-saved-build",scope,payload)).toBe(false);expect(savedRoute).not.toHaveBeenCalled();
  rendered.rerender(<Harness mounted={false} project={project}/>,project);
  expect(registry.describe("tasks.open-saved-build",scope,payload)).toBeUndefined();expect(owner.currentActivity()).toBe(captured);
  expect(calls("continue_execution")).toHaveLength(1);expect(calls("read_saved_plugin_build")).toHaveLength(0);
});
