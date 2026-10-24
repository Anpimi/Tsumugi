import { useCallback, useMemo, useSyncExternalStore, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { executionCommands, type AttemptDetail, type SessionRequest } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { useWorkbenchCommands, type AiAgentPendingCommandPayload, type CommandAvailability } from "./workbenchCommands";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { jsonIdentity } from "./pluginToolChoices";
import { openWorkPlanAgent, workPlanCommands, type WorkPlanAgentLeaf, type WorkPlanStatusView } from "./workPlanCommands";
import type { WorkPlanContinuation } from "./AiPreparationSession";
import type { WorkPlanAgentSession } from "./WorkPlanAgentControls";
import { ToolGuidance } from "./ToolGuidance";
import { createToolQuery } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";

type RootConsumer = Awaited<ReturnType<typeof openWorkPlanAgent>>;
type Generation = Awaited<ReturnType<WorkPlanAgentLeaf["prepare"]>>;
type Tool = Awaited<ReturnType<WorkPlanAgentLeaf["prepareTool"]>>;
type ChildCapture = { kind: "generation"; prepared: Generation } | { kind: "tool"; prepared: Tool };
export type ChildRun = ChildCapture
  & { phase: "sending" | "unknown" | "queued" | "not-enqueued"; retryAllowed: boolean;
    request: Parameters<typeof workPlanCommands.reconcileAgent>[0];
    reconciliation?: Awaited<ReturnType<typeof workPlanCommands.reconcileAgent>>; checking?: boolean; failure?: CommandFailure | null };
export interface ChildAgent {
  consumer: WorkPlanAgentLeaf; status: WorkPlanStatusView; accepted: boolean; toolHandle: string; runs: ChildRun[];
}
export interface ChildAgentState {
  unitIds: string[]; toolHandles: string[]; editSeq: number;
  pending: { consumer: RootConsumer; proposal: { unitIds: string[]; toolHandles: string[] }; status: WorkPlanStatusView; editSeq: number; uncertain: boolean } | null;
  children: ChildAgent[];
}
export const initialChildAgentState = (): ChildAgentState => ({ unitIds: [], toolHandles: [], editSeq: 0, pending: null, children: [] });
export const childLifecycleKey = (scopeId: string, attemptId: string) => ["agent-child-lifecycle", scopeId, attemptId];
export function hasChildUncertainty(state: ChildAgentState) {
  return !!state.pending || state.children.some(child => child.runs.some(run => run.phase === "sending" || run.phase === "unknown"));
}
export function childRunWorking(run: ChildRun, detail: AttemptDetail | null | undefined) {
  return run.phase !== "not-enqueued" && (run.phase !== "queued" || !detail || detail.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched"));
}
function confirmLifecycle(run: ChildRun, detail: AttemptDetail | null) {
  const ids = run.prepared.scope.map(unit => unit.unitId);
  if (detail && (detail.taskId !== run.prepared.taskId || detail.attemptId !== run.prepared.attemptId
    || detail.progress.total !== ids.length || detail.items.length !== ids.length
    || new Set(detail.items.map(item => item.scope.id)).size !== ids.length || detail.items.some(item => !ids.includes(item.scope.id))))
    throw { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };
  return detail;
}

/** Child methods and original pending objects live in the existing preparation session. */
export function WorkPlanChildControls({ context, status, open, disabled, busy, session, canRun, run, onOpenTask }: {
  context: SessionRequest; status: WorkPlanStatusView; open: boolean; disabled: boolean; busy: boolean; session: WorkPlanAgentSession;
  canRun: (recovery?: boolean) => boolean; run: (work: (current: WorkPlanContinuation) => Promise<void>, recovery?: boolean) => Promise<void>;
  onOpenTask: (taskId: string, attemptId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), registry = useWorkbenchCommands(), state = session.state.child;
  const expiresAt = state.pending?.status.expiresAt ?? status.expiresAt;
  const subscribe = useCallback((notify: () => void) => {
    const stop = reads.client.getQueryCache().subscribe(notify), remaining = BigInt(expiresAt) * 1000n - BigInt(Date.now());
    const timer = remaining > 0n ? setTimeout(notify, Number(remaining > 2147483646n ? 2147483646n : remaining) + 1) : undefined;
    return () => { stop(); clearTimeout(timer); };
  }, [reads, expiresAt]);
  // Query owns task status; subscribe to its facts rather than copying them into the draft.
  useSyncExternalStore(subscribe, () => {
    const query = reads.client.getQueryState(reads.key(["workPlan", status.lease.planId]));
    return JSON.stringify([BigInt(expiresAt) <= BigInt(Math.floor(Date.now() / 1000)), query?.dataUpdateCount, query?.status, query?.fetchStatus, query?.isInvalidated,
      state.children.map(child => child.runs.map(action => reads.client.getQueryData<AttemptDetail | null>(reads.key(childLifecycleKey(child.consumer.scope.scopeId, action.prepared.attemptId)))?.items.map(item => item.status.execution) ?? null))]);
  }, () => "");
  const change = (fn: (before: ChildAgentState) => ChildAgentState) => session.update(before => ({ ...before, child: fn(before.child) }));
  function currentStatus(expected: WorkPlanStatusView) {
    const query = reads.client.getQueryState<WorkPlanStatusView>(reads.key(["workPlan", expected.lease.planId]));
    return open && !reads.retired && status.state === "active" && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now() / 1000))
      && jsonIdentity(status.lease) === jsonIdentity(expected.lease) && status.plan.digest === expected.plan.digest
      && query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null
      && query.data?.state === "active" && jsonIdentity(query.data.lease) === jsonIdentity(expected.lease)
      && query.data.plan.digest === expected.plan.digest;
  }
  const permitted = !disabled && !busy && currentStatus(status);
  function delegationEnded() {
    const pending = session.current().child.pending;
    if (!pending?.uncertain || hasChildUncertainty({ ...session.current().child, pending: null })) return false;
    if (BigInt(pending.status.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) return true;
    const query = reads.client.getQueryState<WorkPlanStatusView>(reads.key(["workPlan", pending.status.lease.planId]));
    return query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null
      && query.data?.lease.planId === pending.status.lease.planId
      && (query.data.state !== "active" || jsonIdentity(query.data.lease) !== jsonIdentity(pending.status.lease));
  }
  function edit(unitIds: string[], toolHandles: string[]) {
    if (busy || session.current().child.pending) return;
    change(before => ({ ...before, unitIds, toolHandles, editSeq: before.editSeq + 1 }));
  }
  async function delegate(current: WorkPlanContinuation, retry = false) {
    let pending = session.current().child.pending;
    if (!retry) {
      const before = session.current().child;
      if (!permitted || !before.unitIds.length || pending || before.children.length >= 127) return;
      const captured = structuredClone({ status, unitIds: before.unitIds, toolHandles: before.toolHandles, editSeq: before.editSeq });
      const consumer = await openWorkPlanAgent({ ...context, lease: captured.status.lease }, captured.status.plan.scope, captured.status.plan.tools?.entries ?? []);
      if (!current.fresh() || session.current().child.editSeq !== captured.editSeq) return;
      pending = { consumer, proposal: { unitIds: captured.unitIds, toolHandles: captured.toolHandles }, status: captured.status, editSeq: captured.editSeq, uncertain: false };
      change(before => ({ ...before, pending }));
    }
    if (!pending) return;
    const original = pending;
    try {
      const consumer = await original.consumer.delegate(original.proposal);
      if (!current() || session.current().child.pending !== original) return;
      const accepted = current.fresh() && session.current().child.editSeq === original.editSeq;
      change(before => ({ ...before, pending: null, children: before.children.some(child => child.consumer.scope.scopeId === consumer.scope.scopeId) ? before.children
        : [...before.children, { consumer, status: original.status, accepted, toolHandle: "", runs: [] }] }));
    } catch (error) {
      if (current() && session.current().child.pending === original)
        change(before => ({ ...before, pending: original.uncertain || hasUnknownOutcome(error) ? { ...original, uncertain: true } : null }));
      throw error;
    }
  }
  function updateChild(child: ChildAgent, fn: (before: ChildAgent) => ChildAgent) {
    change(before => ({ ...before, children: before.children.map(value => value.consumer === child.consumer ? fn(value) : value) }));
  }
  function currentChild(child: ChildAgent) { return session.current().child.children.find(value => value.consumer === child.consumer); }
  function updateRun(child: ChildAgent, original: ChildRun, fn: (before: ChildRun) => ChildRun | null) {
    updateChild(child, before => ({ ...before, runs: before.runs.flatMap(value => value.prepared === original.prepared ? fn(value) ?? [] : [value]) }));
  }
  function matchesRun(child:ChildAgent,action:ChildRun,current:WorkPlanContinuation) {
    const latest=currentChild(child)?.runs.find(value=>value.prepared === action.prepared);
    return current() && !reads.retired && latest?.request === action.request;
  }
  async function dispatch(child: ChildAgent, action: ChildRun, current: WorkPlanContinuation) {
    if(!matchesRun(child,action,current))return;
    updateRun(child,action,before=>({...before,phase:"sending",retryAllowed:false,checking:false,reconciliation:undefined,failure:null}));
    try {
      if (action.kind === "generation") await child.consumer.start(action.prepared);
      else await child.consumer.startTool(action.prepared);
      if (matchesRun(child,action,current)) { updateRun(child, action, before => ({ ...before, phase: "queued", retryAllowed: false })); reads.invalidate(["execution"]); }
    } catch (error) {
      if(!matchesRun(child,action,current))return;
      const unknown=hasUnknownOutcome(error),failure=commandFailure(error,"outcome-unknown");
      updateRun(child, action, before => action.phase === "unknown" || unknown
        ? { ...before, phase: "unknown", retryAllowed: false, failure } : null);
      if(unknown)await reconcile(child,action,current,failure);
      else throw error;
    }
  }
  async function start(child: ChildAgent, kind: "generation" | "tool", current: WorkPlanContinuation) {
    const latest = currentChild(child);
    if (!permitted || !latest?.accepted || !currentStatus(child.status) || latest.runs.some(action => childRunWorking(action,
      reads.client.getQueryData<AttemptDetail | null>(reads.key(childLifecycleKey(child.consumer.scope.scopeId, action.prepared.attemptId)))))) return;
    const toolHandle = latest.toolHandle;
    if (kind === "tool" && !child.consumer.scope.delegation?.toolHandles.includes(toolHandle)) return;
    const [taskId, attemptId] = await Promise.all([executionCommands.identity(context), executionCommands.identity(context)]);
    if (!current.fresh() || currentChild(child)?.toolHandle !== toolHandle) return;
    const fixed = { taskId, attemptId, unitIds: child.consumer.scope.scope.map(unit => unit.unitId) };
    const capture: ChildCapture = kind === "generation" ? { kind, prepared: await child.consumer.prepare(fixed) }
      : { kind, prepared: await child.consumer.prepareTool({ ...fixed, toolHandle }) };
    if (!current.fresh() || currentChild(child)?.toolHandle !== toolHandle) return;
    const request = Object.freeze({ ...context, lease: Object.freeze({ ...child.status.lease }), taskId, attemptId, inputDigest: capture.prepared.inputDigest });
    const action: ChildRun = capture.kind === "generation" ? { kind: capture.kind, prepared: capture.prepared, request, phase: "sending", retryAllowed: false }
      : { kind: capture.kind, prepared: capture.prepared, request, phase: "sending", retryAllowed: false };
    updateChild(child, before => ({ ...before, runs: [...before.runs, action] }));
    await dispatch(child, action, current);
  }
  async function reconcile(child: ChildAgent, action: ChildRun, current: WorkPlanContinuation, originalFailure:CommandFailure|null=action.failure??null) {
    const original = currentChild(child)?.runs.find(value => value.prepared === action.prepared);
    if (!original || original.phase !== "unknown" || original.checking || !matchesRun(child,original,current)) return;
    updateRun(child, original, before => ({ ...before, checking:true, retryAllowed:false,reconciliation:undefined,failure:null }));
    try {
      const receipt = await workPlanCommands.reconcileAgent(original.request);
      if(!matchesRun(child,original,current))return;
      const latest=currentChild(child)?.runs.find(value=>value.prepared === original.prepared);
      if(latest?.phase !== "unknown")return;
      if(original.prepared.taskId !== original.request.taskId || original.prepared.attemptId !== original.request.attemptId
        || original.prepared.inputDigest !== original.request.inputDigest)throw new Error("Original Agent preparation changed");
      updateRun(child, original, before => ({ ...before, checking:false,phase:receipt.outcome === "enqueued" ? "queued" : "unknown",
        retryAllowed:receipt.outcome === "active",reconciliation:receipt,failure:receipt.outcome === "enqueued" ? null:originalFailure }));
      reads.invalidate(["execution"]);
    } catch(error) {
      if(matchesRun(child,original,current))updateRun(child,original,before=>({...before,checking:false,retryAllowed:false,reconciliation:undefined,failure:commandFailure(error,"outcome-unknown")}));
    }
  }
  function recoveryPayload(child:ChildAgent,action:ChildRun):AiAgentPendingCommandPayload {
    return {kind:"ai-agent-pending",operation:action.kind,scopeId:child.consumer.scope.scopeId,taskId:action.request.taskId,
      attemptId:action.request.attemptId,inputDigest:action.request.inputDigest,unitIds:action.prepared.scope.map(unit=>unit.unitId),
      toolHandle:action.kind === "tool" ? action.prepared.toolHandle:null};
  }
  function recoveryTarget(payload?:AiAgentPendingCommandPayload) {
    for(const child of session.current().child.children)for(const action of child.runs)
      if(payload && jsonIdentity(payload) === jsonIdentity(recoveryPayload(child,action)))return {child,action};
    return null;
  }
  function recoveryAvailability(payload?:AiAgentPendingCommandPayload,kind:"check"|"retry"|"end"="check"):CommandAvailability {
    if(!open||reads.retired)return {enabled:false,reason:"hidden"};
    const target=recoveryTarget(payload);
    if(busy||!canRun(true)||target?.action.checking)return {enabled:false,reason:"busy"};
    if(!target||target.action.phase !== "unknown")return {enabled:false,reason:"unavailable"};
    if(kind === "retry" && (!target.action.retryAllowed||!permitted||!target.child.accepted||!currentStatus(target.child.status)))return {enabled:false,reason:"unavailable"};
    if(kind === "end" && target.action.reconciliation?.outcome !== "not-enqueued")return {enabled:false,reason:"unavailable"};
    return {enabled:true};
  }
  useLayoutEffect(()=>{
    const metadata={category:"ai" as const,scope:{...context,area:"ai" as const},binding:null,confirmation:"none" as const,payloadKind:"ai-agent-pending" as const};
    const remove=[registry.register({...metadata,id:"ai.children.check-start",nameKey:"ai.tools.checkOriginal",risk:"reads-execution",availability:value=>recoveryAvailability(value),handler:value=>{
      const target=recoveryTarget(value);if(target)void run(current=>reconcile(target.child,target.action,current),true);
    }}),registry.register({...metadata,id:"ai.children.retry-start",nameKey:"ai.retrySame",risk:"runs-ai",availability:value=>recoveryAvailability(value,"retry"),handler:value=>{
      const target=recoveryTarget(value);if(target)void run(async current=>{if(current.fresh())await dispatch(target.child,target.action,current);},true);
    }}),registry.register({...metadata,id:"ai.children.end-unqueued",nameKey:"ai.children.endUnqueued",risk:"reads-execution",availability:value=>recoveryAvailability(value,"end"),handler:value=>{
      const target=recoveryTarget(value);if(target)void run(async current=>{
        if(matchesRun(target.child,target.action,current) && target.action.reconciliation?.outcome === "not-enqueued")
          updateRun(target.child,target.action,before=>({...before,phase:"not-enqueued",retryAllowed:false}));
      },true);
    }})];
    return()=>remove.forEach(dispose=>dispose());
  });
  function dispatchRecovery(id:"ai.children.check-start"|"ai.children.retry-start"|"ai.children.end-unqueued",child:ChildAgent,action:ChildRun) {
    registry.dispatch(id,{...context,area:"ai"},recoveryPayload(child,action));
  }
  return <section aria-label={t("ai.children.title")}>
    <h4>{t("ai.children.title")}</h4><p>{t("ai.children.help")}</p>
    <fieldset disabled={busy || !!state.pending || !permitted}><legend>{t("ai.children.units")}</legend>
      {status.plan.scope.map(unit => <label className="source-check" key={unit.unitId}><input type="checkbox" checked={state.unitIds.includes(unit.unitId)} onChange={event =>
        edit(event.target.checked ? [...state.unitIds, unit.unitId] : state.unitIds.filter(id => id !== unit.unitId), state.toolHandles)} />{unit.nativeKey}</label>)}
    </fieldset>
    <fieldset disabled={busy || !!state.pending || !permitted}><legend>{t("ai.children.tools")}</legend>
      {(status.plan.tools?.entries ?? []).map(tool => <label className="source-check" key={tool.handle}><input type="checkbox" checked={state.toolHandles.includes(tool.handle)} onChange={event =>
        edit(state.unitIds, event.target.checked ? [...state.toolHandles, tool.handle] : state.toolHandles.filter(id => id !== tool.handle))} />{tool.binding.declaration.title}</label>)}
      {!status.plan.tools?.entries.length ? <p>{t("ai.children.noTools")}</p> : null}
    </fieldset>
    <button type="button" disabled={!permitted || !canRun() || !state.unitIds.length || !!state.pending || state.children.length >= 127}
      onClick={() => { void run(current => delegate(current)); }}>{t("ai.children.create")}</button>
    {busy && !state.pending ? <p role="status">{t("execution.working")}</p> : null}
    {state.pending ? <div role="status"><p>{t(state.pending.uncertain ? "ai.children.delegationUnknown" : "ai.children.creating")}</p>
      <button type="button" disabled={busy || !canRun(true) || delegationEnded()} onClick={() => { void run(current => delegate(current, true), true); }}>{t("ai.children.retryDelegation")}</button>
      {delegationEnded() ? <><p>{t("ai.children.endedHelp")}</p><button type="button" disabled={busy || !canRun(true)} onClick={() => {
        if (!busy && canRun(true) && delegationEnded()) change(before => ({ ...before, pending: null }));
      }}>{t("ai.children.endPreparation")}</button></> : null}</div> : null}
    {state.children.map((child, index) => {
      const same = currentStatus(child.status), tools = child.status.plan.tools?.entries.filter(tool => child.consumer.scope.delegation?.toolHandles.includes(tool.handle)) ?? [];
      const working = child.runs.some(action => childRunWorking(action, reads.client.getQueryData<AttemptDetail | null>(reads.key(childLifecycleKey(child.consumer.scope.scopeId, action.prepared.attemptId)))));
      const allowed = permitted && same && child.accepted && canRun() && !working;
      return <section key={child.consumer.scope.scopeId} aria-label={t("ai.children.child", { index: index + 1, defaultValue: enUS.ai.children.child })}>
        <h5>{t("ai.children.child", { index: index + 1, defaultValue: enUS.ai.children.child })}</h5>
        <ul>{child.consumer.scope.scope.map(unit => <li key={unit.unitId}>{unit.nativeKey}</li>)}</ul>
        {!same ? <p role="status">{t("ai.children.inactive")}</p> : !child.accepted ? <><p>{t("ai.children.newer")}</p>
          <button type="button" disabled={!permitted || !canRun()} onClick={() => updateChild(child, before => ({ ...before, accepted: true }))}>{t("ai.children.accept")}</button></> : null}
        <ToolGuidance context={context} status={status} open={open} disabled={disabled || !same || !child.accepted} bounded={child.consumer} />
        {tools.length ? <label className="field">{t("ai.children.provider")}<select value={child.toolHandle} disabled={!allowed} onChange={event => updateChild(child, before => ({ ...before, toolHandle: event.target.value }))}>
          <option value="">{t("toolQuery.chooseProvider")}</option>{tools.map(tool => <option key={tool.handle} value={tool.handle}>{tool.binding.declaration.title}</option>)}</select></label> : <p>{t("ai.children.noTools")}</p>}
        <button type="button" disabled={!allowed} onClick={() => { void run(current => start(child, "generation", current)); }}>{t("ai.children.generate")}</button>
        {tools.length ? <button type="button" disabled={!allowed || !tools.some(tool => tool.handle === child.toolHandle)} onClick={() => { void run(current => start(child, "tool", current)); }}>{t("ai.children.query")}</button> : null}
        {child.runs.map(action => <ChildResult key={action.prepared.attemptId} context={context} child={child} action={action} open={open} active={same && child.accepted} busy={busy}
          onHistory={() => onOpenTask(action.request.taskId, action.request.attemptId)} onCheck={async()=>{dispatchRecovery("ai.children.check-start",child,action);}}
          onRetry={async()=>{dispatchRecovery("ai.children.retry-start",child,action);}} recoveryAllowed={recoveryAvailability(recoveryPayload(child,action)).enabled}
          onEnd={()=>{dispatchRecovery("ai.children.end-unqueued",child,action);}} />)}
      </section>;
    })}
  </section>;
}

function ChildResult({ context, child, action, open, active, busy, onHistory, onCheck, onRetry, onEnd, recoveryAllowed }: {
  context: SessionRequest; child: ChildAgent; action: ChildRun; open: boolean; active: boolean; busy: boolean; recoveryAllowed: boolean;
  onHistory: () => Promise<boolean>; onCheck: () => Promise<void>; onRetry: () => Promise<void>; onEnd: () => void;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), scopeId = child.consumer.scope.scopeId;
  const toolHandle = action.kind === "tool" ? action.prepared.toolHandle : null;
  const tool = child.status.plan.tools?.entries.find(tool => tool.handle === toolHandle);
  const presentation = useMemo(() => { try { return tool ? createToolQuery(tool.binding) : null; } catch { return null; } }, [tool]);
  const lifecycle = useSessionQuery({ key: childLifecycleKey(scopeId, action.prepared.attemptId), scopes: ["execution"], enabled: open && (action.phase === "unknown" || action.phase === "queued"),
    read: async () => confirmLifecycle(action, await readCompleteAttempt(context, action.prepared.attemptId, action.kind === "generation" ? "ai-translation" : "plugin-tool-query")) });
  const detail = useSessionQuery({ key: ["agent-child-result", scopeId, action.prepared.attemptId], scopes: ["execution"], enabled: open && active && action.phase === "queued",
    read: () => action.kind === "generation" ? child.consumer.readGenerationAttempt(action.prepared, { offset: 0, limit: 100 })
      : child.consumer.readToolAttempt(action.prepared, { offset: 0, limit: 100 }) });
  const results = detail.data?.items.flatMap(item => item.resultId ? [{ itemId: item.status.itemId, resultId: item.resultId }] : []) ?? [];
  const output = useSessionQuery({ key: ["agent-child-output", scopeId, action.prepared.attemptId, results], scopes: ["execution"], enabled: open && active && !!detail.data && results.length > 0,
    read: () => Promise.all(results.map(item => action.kind === "generation" ? child.consumer.readGenerationOutput(action.prepared, item.itemId, item.resultId)
      : child.consumer.readToolOutput(action.prepared, item))) });
  return <article aria-label={t(action.kind === "generation" ? "ai.children.generationResult" : "ai.children.toolResult")}>
    <h6>{t(action.kind === "generation" ? "ai.children.generationResult" : "ai.children.toolResult")}</h6>
    <p>{action.kind === "generation" ? child.status.plan.preview?.config.model
      : child.status.plan.tools?.entries.find(tool => tool.handle === toolHandle)?.binding.declaration.title}</p>
    <p>{t("ai.children.resultHelp")}</p>
    {action.phase === "unknown" ? <div role="status"><p>{t(action.checking ? "ai.tools.checkingOriginal" : "ai.tools.unknown")}</p>
      <button type="button" disabled={busy || action.checking || !recoveryAllowed} onClick={() => { void onCheck(); }}>{t("ai.tools.checkOriginal")}</button>
      {action.retryAllowed ? <button type="button" disabled={busy || action.checking || !recoveryAllowed || !active} onClick={() => { void onRetry(); }}>{t("ai.retrySame")}</button> : null}</div> : null}
    {action.failure ? <div role="alert"><CommandFailureDetails failure={action.failure}/></div> : null}
    {action.phase === "unknown" && action.reconciliation?.outcome === "not-enqueued" ? <><p>{t("ai.children.notEnqueuedHelp")}</p>
      <button type="button" disabled={busy || action.checking || !recoveryAllowed} onClick={onEnd}>{t("ai.children.endUnqueued")}</button></> : null}
    {action.phase === "unknown" && action.reconciliation?.outcome === "active" ? <p role="status">{t("ai.children.activeUnknown")}</p> : null}
    {action.phase === "not-enqueued" ? <p role="status">{t("ai.children.endedUnqueued")}</p> : null}
    {childRunWorking(action, lifecycle.data) ? <p role="status">{t("execution.working")}</p> : null}
    {detail.isFetching || output.isFetching ? <p role="status">{t("ai.children.reading")}</p> : null}
    {action.phase !== "not-enqueued" && (detail.error || output.error || lifecycle.error) ? <div role="alert"><p>{t("ai.children.readFailed")}</p>
      <button type="button" disabled={busy} onClick={() => reads.invalidate(["execution"])}>{t("ai.refresh")}</button></div> : null}
    {detail.data ? detail.data.items.map(item => <div key={item.status.itemId}><p>{t(`execution.states.${item.status.execution}`)}</p>
      {item.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary><p>{item.status.diagnostic}</p></details> : null}</div>) : null}
    {active && !detail.error && !output.error ? output.data?.map(value => {
      let rows: string[][] | null = null;
      if (presentation && value.outcome === "succeeded") { try { rows = presentation.entries(value.output); } catch { /* Show the original invalid-result state. */ } }
      const generated = value.output && typeof value.output === "object" && "text" in value.output && typeof value.output.text === "string" ? value.output.text : null;
      return <div key={value.resultId}>
        {value.diagnostic ? <p>{value.diagnostic.code}</p> : null}
        {value.outcome === "succeeded" ? action.kind === "generation" ? generated !== null ? <pre>{generated}</pre> : <p role="alert">{t("toolQuery.invalidResult")}</p>
          : !presentation || rows === null ? <p role="alert">{t("toolQuery.invalidResult")}</p>
            : rows.length === 0 ? <p>{presentation.query.output.emptyDescription}</p>
              : <div className="source-table-scroll"><table className="source-table"><thead><tr>{presentation.query.output.columns.map((column, index) => <th key={index} scope="col">{column.label}</th>)}</tr></thead>
                <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}><pre>{cell}</pre></td>)}</tr>)}</tbody></table></div> : null}
        <details><summary>{t("ai.children.resultSource")}</summary><p>{value.capabilityId} · {value.capabilityVersion}</p>
          <pre>{JSON.stringify({ taskId: action.prepared.taskId, attemptId: value.attemptId, itemId: value.itemId, resultId: value.resultId, plugin: value.plugin }, null, 2)}</pre></details>
      </div>;
    }) : null}
    {!active && action.phase !== "not-enqueued" ? <p>{t("ai.children.historyOnly")}</p> : null}
    {action.phase !== "not-enqueued" ? <button type="button" disabled={busy || action.checking || !recoveryAllowed} onClick={() => { void onHistory(); }}>{t("ai.children.history")}</button> : null}
  </article>;
}
