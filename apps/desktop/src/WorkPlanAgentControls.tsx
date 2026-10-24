import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { createToolQuery } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { openWorkPlanAgent, workPlanCommands, type WorkPlanStatusView } from "./workPlanCommands";
import type { WorkPlanContinuation } from "./AiPreparationSession";
import { jsonIdentity } from "./pluginToolChoices";
import { useWorkbenchCommands, type CommandAvailability, type AiAgentCommandPayload, type AiAgentPendingCommandPayload } from "./workbenchCommands";
import { WorkPlanGenerationControls, type WorkPlanGenerationSession } from "./WorkPlanGenerationControls";
import { ToolGuidance } from "./ToolGuidance";
import { WorkPlanChildControls, type ChildAgentState, initialChildAgentState } from "./WorkPlanChildControls";

type AgentConsumer = Awaited<ReturnType<typeof openWorkPlanAgent>>;
type ToolCapture = Awaited<ReturnType<AgentConsumer["prepareTool"]>>;
type GenerationCapture = Awaited<ReturnType<AgentConsumer["prepare"]>>;
export type AgentPending = ({ kind: "tool"; consumer: AgentConsumer; prepared: ToolCapture }
  | { kind: "generation"; consumer: AgentConsumer; prepared: GenerationCapture })
  & { plan: WorkPlanStatusView["plan"]; generation: string; unitIds: string[]; uncertain: boolean; checking: boolean; retryAllowed: boolean;
    request: Parameters<typeof workPlanCommands.reconcileAgent>[0];
    reconciliation: Awaited<ReturnType<typeof workPlanCommands.reconcileAgent>> | null; failure: CommandFailure | null };
export type ToolRun = { prepared: ToolCapture; plan: WorkPlanStatusView["plan"]; confirmed?: boolean };

export interface AgentState { selected: string[]; toolHandle: string; pending: AgentPending | null; toolRun: ToolRun | null; child: ChildAgentState }
const initialAgent = (): AgentState => ({ selected: [], toolHandle: "", pending: null, toolRun: null, child: initialChildAgentState() });
export function useWorkPlanAgentSession(live: () => boolean) {
  const [state, setState] = useState(initialAgent), ref = useRef(state);
  function update(change: (before: AgentState) => AgentState) {
    if (!live()) return;
    ref.current = change(ref.current); setState(ref.current);
  }
  return { state, current: () => ref.current, update, reset: () => update(initialAgent) };
}
export type WorkPlanAgentSession = ReturnType<typeof useWorkPlanAgentSession>;

/** A bounded production consumer of the original plan, provider and tool ledger. */
export function WorkPlanAgentControls({ context, status, open, disabled, busy, run, onBlockedChange, onGenerated, session, component, ownerBusy, childControls }: {
  childControls?: { disabled: boolean; canRun: (recovery?: boolean) => boolean; run: (work: (current: WorkPlanContinuation) => Promise<void>, recovery?: boolean) => Promise<void>;
    onOpenTask: (taskId: string, attemptId: string) => Promise<boolean> };
  session: WorkPlanAgentSession; component: WorkPlanGenerationSession; ownerBusy: () => boolean;
  context: SessionRequest; status: WorkPlanStatusView; open: boolean; disabled: boolean; busy: boolean;
  run: (work: (current: WorkPlanContinuation) => Promise<void>) => Promise<void>;
  onBlockedChange: (blocked: boolean) => void; onGenerated: (attemptId: string) => void;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const { selected, toolHandle, pending, toolRun } = session.state;
  const setSelected = (change: (before: string[]) => string[]) => session.update(before => ({ ...before, selected: change(before.selected) }));
  const setToolHandle = (toolHandle: string) => session.update(before => ({ ...before, toolHandle }));
  const setPending = (pending: AgentPending | null) => session.update(before => ({ ...before, pending }));
  const setToolRun = (toolRun: ToolRun | null) => session.update(before => ({ ...before, toolRun }));
  const componentBlocked = !!component.current().operation;
  const entries = status.plan.tools?.entries ?? [];
  const tool = toolRun?.plan.tools?.entries.find(entry => entry.handle === toolRun.prepared.toolHandle);
  const presentation = useMemo(() => { try { return tool ? createToolQuery(tool.binding) : null; } catch { return null; } }, [tool]);
  const attemptId = toolRun?.prepared.attemptId ?? null;
  const detail = useSessionQuery({ key: ["agent-tool-attempt", attemptId], scopes: ["execution"], enabled: open && !!attemptId && !busy,
    read: async () => {
      if (!attemptId || !toolRun) return null;
      const result = await readCompleteAttempt(context, attemptId, "plugin-tool-query");
      if (result && (result.taskId !== toolRun.prepared.taskId || result.progress.total !== toolRun.prepared.scope.length))
        throw new Error("Agent tool result coverage changed");
      return result;
    } });
  const resultIds = detail.data?.items.flatMap(item => item.resultId ? [item.resultId] : []) ?? [];
  const output = useSessionQuery({ key: ["agent-tool-output", attemptId, ...resultIds], scopes: ["execution"], enabled: open && !!attemptId && resultIds.length > 0 && !busy,
    read: () => Promise.all(resultIds.map(resultId => executionCommands.output({ ...context, attemptId: attemptId!, resultId }))) });
  const working = !!toolRun && (!detail.data || detail.data.items.some(item => ["queued", "dispatched"].includes(item.status.execution)));
  useEffect(() => { onBlockedChange(!!pending || working || componentBlocked); return () => onBlockedChange(false); }, [!!pending, working, componentBlocked, onBlockedChange]);
  const active = status.state === "active" && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now() / 1000));
  const validUnits = selected.length > 0 && selected.every(id => status.plan.scope.some(unit => unit.unitId === id));
  const remaining = status.toolInvocations ? status.toolInvocations.limit - status.toolInvocations.reserved : 0;
  const insufficient = selected.length > remaining;
  const locked = disabled || busy || !!pending || working || componentBlocked || !active;
  async function start(payload: AiAgentCommandPayload, current: WorkPlanContinuation) {
    if (!validUnits) return;
    const captured=structuredClone({plan:status.plan,lease:status.lease,unitIds:payload.unitIds,toolHandle:payload.toolHandle});
    const consumer = await openWorkPlanAgent({ ...context, lease: captured.lease }, captured.plan.scope, captured.plan.tools?.entries??[]);
    if (!current.fresh()) return;
    const [taskId, attemptId] = await Promise.all([executionCommands.identity(context), executionCommands.identity(context)]);
    if (!current.fresh()) return;
    const fixed = { taskId, attemptId, unitIds: captured.unitIds };
    const common={plan:captured.plan,generation:captured.lease.generation,unitIds:captured.unitIds,uncertain:false,
      checking:false,retryAllowed:false,reconciliation:null,failure:null};
    const capture = captured.toolHandle !== null
      ? {kind:"tool" as const, prepared:await consumer.prepareTool({ ...fixed, toolHandle:captured.toolHandle })}
      : {kind:"generation" as const, prepared:await consumer.prepare(fixed)};
    if (!current.fresh()) return;
    const request = Object.freeze({...context,lease:Object.freeze({...captured.lease}),taskId,attemptId,inputDigest:capture.prepared.inputDigest});
    const action: AgentPending = {...capture,consumer,...common,request};
    setPending(action);
    if (action.kind === "tool") setToolRun({prepared:action.prepared,plan:captured.plan,confirmed:false});
    await dispatch(action,current);
  }
  function matches(entry:AgentPending,current:WorkPlanContinuation) {
    return current() && !reads.retired && session.current().pending?.request === entry.request;
  }
  function complete(entry:AgentPending,current:WorkPlanContinuation) {
    if(!matches(entry,current))return;
    if(entry.kind === "generation") onGenerated(entry.request.attemptId);
    else session.update(before=>({...before,toolRun:before.toolRun?.prepared === entry.prepared ? {...before.toolRun,confirmed:true}:before.toolRun}));
    setPending(null);reads.invalidate(["execution"]);
  }
  async function lookupOriginal(entry:AgentPending,current:WorkPlanContinuation,originalFailure:CommandFailure|null=entry.failure) {
    if(!matches(entry,current) || session.current().pending?.checking)return;
    const retained={...entry,uncertain:true,checking:true,retryAllowed:false,reconciliation:null,failure:null};
    setPending(retained);
    try {
      const receipt=await workPlanCommands.reconcileAgent(entry.request);
      if(!matches(retained,current))return;
      setPending({...retained,checking:false,reconciliation:receipt,retryAllowed:receipt.outcome === "active",failure:originalFailure});
      if(receipt.outcome === "enqueued")complete(retained,current);
    } catch(error) {
      if(matches(retained,current))setPending({...retained,checking:false,retryAllowed:false,failure:commandFailure(error,"outcome-unknown")});
    }
  }
  async function dispatch(entry:AgentPending,current:WorkPlanContinuation) {
    if(!matches(entry,current))return;
    const retained={...entry,retryAllowed:false,checking:false,reconciliation:null,failure:null};setPending(retained);
    try {
      if(entry.kind === "tool")await entry.consumer.startTool(entry.prepared);
      else await entry.consumer.start(entry.prepared);
      complete(retained,current);
    } catch(error) {
      if(!matches(retained,current))return;
      const unknown=hasUnknownOutcome(error), failure=commandFailure(error,"outcome-unknown");
      if(unknown || entry.uncertain) {
        const pending={...retained,uncertain:true,failure};setPending(pending);
        if(unknown)await lookupOriginal(pending,current,failure);
      } else {
        setPending(null);
        if(entry.kind === "tool")session.update(before=>({...before,toolRun:before.toolRun?.prepared === entry.prepared ? null:before.toolRun}));
        throw error;
      }
    }
  }
  async function reconcile(current:WorkPlanContinuation) {
    const entry=session.current().pending;
    if(entry?.uncertain)await lookupOriginal(entry,current);
  }
  async function retry(current:WorkPlanContinuation) {
    const entry=session.current().pending;
    if(entry?.retryAllowed && current.fresh() && retryAvailability(pendingPayload()).enabled)await dispatch(entry,current);
  }
  async function endUnqueued(current:WorkPlanContinuation) {
    const entry=session.current().pending;
    if(!entry || entry.checking || !matches(entry,current) || entry.reconciliation?.outcome !== "not-enqueued")return;
    if(entry.kind === "tool")session.update(before=>({...before,toolRun:before.toolRun?.prepared === entry.prepared ? null:before.toolRun}));
    setPending(null);
  }
  const scope={projectId:context.projectId,sessionToken:context.sessionToken,area:"ai" as const};
  const unavailable:CommandAvailability={enabled:false,reason:"unavailable"};
  function currentStatus(){const query=reads.client.getQueryState<WorkPlanStatusView>(reads.key(["workPlan",status.lease.planId]));
    return query?.status==="success"&&query.fetchStatus==="idle"&&!query.isInvalidated&&query.error===null
      &&query.data?.plan.digest===status.plan.digest&&jsonIdentity(query.data.lease)===jsonIdentity(status.lease)&&query.data.state===status.state;}
  function payload(kind:"tool"|"generation"):AiAgentCommandPayload {return{kind:"ai-agent",planId:status.lease.planId,expectedGeneration:status.lease.generation,
    unitIds:[...session.current().selected],toolHandle:kind==="tool"?session.current().toolHandle:null};}
  function availability(value?:AiAgentCommandPayload):CommandAvailability {
    if(!open||reads.retired)return{enabled:false,reason:"hidden"};
    if(ownerBusy()||busy||session.current().pending?.checking)return{enabled:false,reason:"busy"};
    if(!value||disabled||session.current().pending||working||componentBlocked||!currentStatus()
      ||status.state!=="active"||BigInt(status.expiresAt)<=BigInt(Math.floor(Date.now()/1000))
      ||!value.unitIds.length||value.unitIds.some(id=>!status.plan.scope.some(unit=>unit.unitId===id))
      ||jsonIdentity(value)!==jsonIdentity(payload(value.toolHandle===null?"generation":"tool")))return unavailable;
    return value.toolHandle===null||(entries.some(entry=>entry.handle===value.toolHandle)&&value.unitIds.length<=remaining)?{enabled:true}:unavailable;
  }
  function pendingPayload():AiAgentPendingCommandPayload|undefined {
    const pending=session.current().pending;
    return pending?{kind:"ai-agent-pending",operation:pending.kind,scopeId:pending.prepared.scopeId,taskId:pending.prepared.taskId,
      attemptId:pending.prepared.attemptId,inputDigest:pending.prepared.inputDigest,unitIds:[...pending.unitIds],toolHandle:pending.kind==="tool"?pending.prepared.toolHandle:null}:undefined;
  }
  function recoveryAvailability(value?:AiAgentPendingCommandPayload):CommandAvailability {
    if(!open||reads.retired)return{enabled:false,reason:"hidden"};
    if(ownerBusy()||busy||session.current().pending?.checking)return{enabled:false,reason:"busy"};
    return value&&jsonIdentity(value)===jsonIdentity(pendingPayload())?{enabled:true}:unavailable;
  }
  function retryAvailability(value?:AiAgentPendingCommandPayload):CommandAvailability {
    const available=recoveryAvailability(value);if(!available.enabled)return available;
    const pending=session.current().pending;
    return !disabled && pending?.retryAllowed && active && currentStatus()
      && jsonIdentity(pending.request.lease) === jsonIdentity(status.lease) && pending.plan.digest === status.plan.digest ? {enabled:true}:unavailable;
  }
  function endAvailability(value?:AiAgentPendingCommandPayload):CommandAvailability {
    const available=recoveryAvailability(value);return available.enabled && session.current().pending?.reconciliation?.outcome !== "not-enqueued" ? unavailable:available;
  }
  useLayoutEffect(()=>{
    const metadata={category:"ai" as const,scope,binding:null,confirmation:"none" as const};
    const remove=[registry.register({...metadata,id:"ai.agent.generate",nameKey:"ai.tools.generateSubset",risk:"runs-ai",payloadKind:"ai-agent",availability:value=>value?.toolHandle===null?availability(value):unavailable,handler:value=>{void run(current=>start(value,current));}}),
      registry.register({...metadata,id:"ai.agent.query-tool",nameKey:"ai.tools.query",risk:"runs-ai",payloadKind:"ai-agent",availability:value=>value?.toolHandle!==null?availability(value):unavailable,handler:value=>{void run(current=>start(value,current));}}),
      registry.register({...metadata,id:"ai.agent.reconcile",nameKey:"ai.tools.checkOriginal",risk:"reads-execution",payloadKind:"ai-agent-pending",availability:recoveryAvailability,handler:()=>{void run(reconcile);}}),
      registry.register({...metadata,id:"ai.agent.retry",nameKey:"ai.retrySame",risk:"runs-ai",payloadKind:"ai-agent-pending",availability:retryAvailability,handler:()=>{void run(retry);}}),
      registry.register({...metadata,id:"ai.agent.end-unqueued",nameKey:"ai.children.endUnqueued",risk:"reads-execution",payloadKind:"ai-agent-pending",availability:endAvailability,handler:()=>{void run(endUnqueued);}})];
    return()=>remove.forEach(dispose=>dispose());
  });
  function resultRows(resultId: string, itemId: string) {
    const result = output.data?.find(item => item?.resultId === resultId);
    if (!presentation || !result || result.projectId !== context.projectId || result.attemptId !== attemptId
      || result.itemId !== itemId || result.outcome !== "succeeded") return null;
    try { return presentation.entries(result.output); } catch { return null; }
  }
  return <section aria-label={t("ai.tools.agentTitle")}>
    <h3>{t("ai.tools.agentTitle")}</h3><p>{t("ai.tools.agentHelp")}</p>
    <ToolGuidance context={context} status={status} open={open} disabled={disabled} />
    {childControls ? <WorkPlanChildControls context={context} status={status} open={open} busy={busy} session={session} {...childControls} /> : null}
    <fieldset disabled={locked}><legend>{t("ai.tools.subset")}</legend>
      {status.plan.scope.map(unit => <label className="source-check" key={unit.unitId}><input type="checkbox" checked={selected.includes(unit.unitId)}
        onChange={event => setSelected(ids => event.target.checked ? [...ids, unit.unitId] : ids.filter(id => id !== unit.unitId))} />{unit.nativeKey}</label>)}
    </fieldset>
    {entries.length ? <>
      <label className="field">{t("toolQuery.provider")}<select value={toolHandle} disabled={locked} onChange={event => setToolHandle(event.target.value)}>
        <option value="">{t("toolQuery.chooseProvider")}</option>{entries.map(entry => <option key={entry.handle} value={entry.handle}>{entry.binding.declaration.title} · {entry.binding.capability.provider.plugin.version}</option>)}
      </select></label>
      {status.toolInvocations ? <p>{t("ai.tools.usage", { ...status.toolInvocations, defaultValue: enUS.ai.tools.usage })}</p> : null}
      {validUnits && insufficient ? <p role="status">{t("ai.tools.insufficient", { needed: selected.length, remaining, defaultValue: enUS.ai.tools.insufficient })}</p> : null}
      <button type="button" className="secondary-button" disabled={!availability(payload("tool")).enabled}
        onClick={()=>{registry.dispatch("ai.agent.query-tool",scope,payload("tool"));}}>{t("ai.tools.query")}</button>
    </> : <p>{t("ai.tools.noTools")}</p>}
    <button type="button" className="secondary-button" disabled={!availability(payload("generation")).enabled}
      onClick={()=>{registry.dispatch("ai.agent.generate",scope,payload("generation"));}}>{t("ai.tools.generateSubset")}</button>
    <WorkPlanGenerationControls context={context} status={status} selected={selected} open={open}
      disabled={disabled || !!pending || working} busy={busy} run={run} session={component} ownerBusy={ownerBusy} onBlockedChange={() => {}} onGenerated={onGenerated} />
    {!active ? <p role="status">{t("ai.tools.inactive")}</p> : null}
    {toolRun?.confirmed ? <p role="status">{t("ai.tools.startRecorded")}</p> : null}
    {pending ? <div role="status"><p>{t(pending.checking ? "ai.tools.checkingOriginal" : pending.reconciliation?.outcome === "active" ? "ai.tools.originalMissing" : pending.reconciliation?.outcome === "not-enqueued" ? "ai.children.notEnqueuedHelp" : "ai.tools.unknown")}</p><button type="button" className="secondary-button" disabled={!recoveryAvailability(pendingPayload()).enabled}
      onClick={()=>{const value=pendingPayload();if(value)registry.dispatch("ai.agent.reconcile",scope,value);}}>{t("ai.tools.checkOriginal")}</button>
      {pending.retryAllowed ? <button type="button" className="secondary-button" disabled={!retryAvailability(pendingPayload()).enabled}
        onClick={()=>{const value=pendingPayload();if(value)registry.dispatch("ai.agent.retry",scope,value);}}>{t("ai.retrySame")}</button> : null}
      {pending.reconciliation?.outcome === "not-enqueued" ? <button type="button" className="secondary-button" disabled={!endAvailability(pendingPayload()).enabled}
        onClick={()=>{const value=pendingPayload();if(value)registry.dispatch("ai.agent.end-unqueued",scope,value);}}>{t("ai.children.endUnqueued")}</button> : null}
      {pending.failure ? <div role="alert"><CommandFailureDetails failure={pending.failure}/></div> : null}</div> : null}
    {detail.error || output.error ? <div role="alert"><p>{t("toolQuery.failed")}</p><button type="button" className="secondary-button" disabled={busy}
      onClick={() => reads.invalidate(["execution"])}>{t("ai.refresh")}</button></div> : null}
    {working ? <p role="status">{t("execution.working")}</p> : null}
    {detail.data && toolRun ? <section aria-label={t("toolQuery.results")}>
      <h4>{t("toolQuery.results")}</h4><p>{t("toolQuery.references")}</p>
      {detail.data.items.map(item => {
        const rows = item.resultId ? resultRows(item.resultId, item.status.itemId) : null;
        return <article key={item.status.itemId}><p>{t(`execution.states.${item.status.execution}`)}</p>
          {item.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary><p>{item.status.diagnostic}</p></details> : null}
          {item.status.execution === "succeeded" && presentation ? !output.data ? <p role="status">{t("execution.working")}</p>
            : rows === null ? <p role="alert">{t("toolQuery.invalidResult")}</p>
            : rows.length === 0 ? <p>{presentation.query.output.emptyDescription}</p>
              : <div className="source-table-scroll"><table className="source-table"><thead><tr>{presentation.query.output.columns.map((column, index) => <th key={index} scope="col">{column.label}</th>)}</tr></thead>
                <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}><pre>{cell}</pre></td>)}</tr>)}</tbody></table></div> : null}
        </article>;
      })}
    </section> : null}
  </section>;
}
