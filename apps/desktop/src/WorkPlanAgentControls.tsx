import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { createToolQuery } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { openWorkPlanAgent, type WorkPlanStatusView } from "./workPlanCommands";
import type { WorkPlanContinuation } from "./AiPreparationSession";
import { jsonIdentity } from "./pluginToolChoices";
import { useWorkbenchCommands, type CommandAvailability, type AiAgentCommandPayload, type AiAgentPendingCommandPayload } from "./workbenchCommands";
import { WorkPlanGenerationControls, type WorkPlanGenerationSession } from "./WorkPlanGenerationControls";

type AgentConsumer = Awaited<ReturnType<typeof openWorkPlanAgent>>;
type ToolCapture = Awaited<ReturnType<AgentConsumer["prepareTool"]>>;
type GenerationCapture = Awaited<ReturnType<AgentConsumer["prepare"]>>;
export type AgentPending = ({ kind: "tool"; consumer: AgentConsumer; prepared: ToolCapture }
  | { kind: "generation"; consumer: AgentConsumer; prepared: GenerationCapture })
  & { plan: WorkPlanStatusView["plan"]; generation: string; unitIds: string[]; uncertain: boolean };
export type ToolRun = { prepared: ToolCapture; plan: WorkPlanStatusView["plan"] };

export interface AgentState { selected: string[]; toolHandle: string; pending: AgentPending | null; toolRun: ToolRun | null }
const initialAgent = (): AgentState => ({ selected: [], toolHandle: "", pending: null, toolRun: null });
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
export function WorkPlanAgentControls({ context, status, open, disabled, busy, run, onBlockedChange, onGenerated, session, component, ownerBusy }: {
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
    const common={plan:captured.plan,generation:captured.lease.generation,unitIds:captured.unitIds,uncertain:false};
    const action: AgentPending = captured.toolHandle !== null
      ? { kind:"tool", consumer, ...common, prepared: await consumer.prepareTool({ ...fixed, toolHandle:captured.toolHandle }) }
      : { kind:"generation", consumer, ...common, prepared: await consumer.prepare(fixed) };
    if (!current.fresh()) return;
    setPending(action);
    if (action.kind === "tool") setToolRun({ prepared: action.prepared, plan: captured.plan });
    try {
      if (action.kind === "tool") await action.consumer.startTool(action.prepared);
      else await action.consumer.start(action.prepared);
      if (current()) {
        if (action.kind === "generation") onGenerated(action.prepared.attemptId);
        setPending(null); reads.invalidate(["execution"]);
      }
    } catch (error) {
      if (current()) {
        if (hasUnknownOutcome(error)) setPending({...action,uncertain:true});
        else { setPending(null); if (action.kind === "tool") setToolRun(null); }
      }
      throw error;
    }
  }
  async function reconcile(current: WorkPlanContinuation) {
    const pending=session.current().pending;
    if (!pending) return;
    // Read-only reconciliation never renews a permit or sends the call again.
    const result = await readCompleteAttempt(context, pending.prepared.attemptId,
      pending.kind === "tool" ? "plugin-tool-query" : "ai-translation");
    if (!result) throw { outcome: "unknown", reason: "work-plan-pending" };
    if (result.taskId !== pending.prepared.taskId || result.progress.total !== pending.prepared.scope.length
      || new Set(result.items.map(item=>item.scope.id)).size!==pending.unitIds.length
      || result.items.some(item=>!pending.unitIds.includes(item.scope.id)))
      throw { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };
    if (current()) { if (pending.kind === "generation") onGenerated(pending.prepared.attemptId); setPending(null); reads.invalidate(["execution"]); }
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
    if(ownerBusy()||busy)return{enabled:false,reason:"busy"};
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
    if(ownerBusy()||busy)return{enabled:false,reason:"busy"};
    return value&&jsonIdentity(value)===jsonIdentity(pendingPayload())?{enabled:true}:unavailable;
  }
  useLayoutEffect(()=>{
    const metadata={category:"ai" as const,scope,binding:null,confirmation:"none" as const};
    const remove=[registry.register({...metadata,id:"ai.agent.generate",nameKey:"ai.tools.generateSubset",risk:"runs-ai",payloadKind:"ai-agent",availability:value=>value?.toolHandle===null?availability(value):unavailable,handler:value=>{void run(current=>start(value,current));}}),
      registry.register({...metadata,id:"ai.agent.query-tool",nameKey:"ai.tools.query",risk:"runs-ai",payloadKind:"ai-agent",availability:value=>value?.toolHandle!==null?availability(value):unavailable,handler:value=>{void run(current=>start(value,current));}}),
      registry.register({...metadata,id:"ai.agent.reconcile",nameKey:"ai.reconcile",risk:"reconciles-execution-action",payloadKind:"ai-agent-pending",availability:recoveryAvailability,handler:()=>{void run(reconcile);}})];
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
    {pending ? <div role="status"><p>{t("ai.tools.unknown")}</p><button type="button" className="secondary-button" disabled={!recoveryAvailability(pendingPayload()).enabled}
      onClick={()=>{const value=pendingPayload();if(value)registry.dispatch("ai.agent.reconcile",scope,value);}}>{t("ai.reconcile")}</button></div> : null}
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
