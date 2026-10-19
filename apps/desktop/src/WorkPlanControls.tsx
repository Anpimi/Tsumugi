import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ReviewCheckerDetails, checkerIdentity } from "./ReviewCheckers";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { PluginPermissions } from "./PluginPermissions";
import { validateResponseWorkPlanStartAction } from "./generated/ai.validators";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome } from "./projectCommands";
import type { WorkPlanAuthorizeRequest, WorkPlanControlRequest, WorkPlanStartRequest, AutomationEffect } from "./generated/ai.requests";
import { workPlanCommands, type WorkPlanView, type WorkPlanReceiptView, type WorkPlanStatusView, type WorkPlanCommand } from "./workPlanCommands";
import { useSessionReads } from "./SessionReadProvider";
import { useWorkbenchCommands, type CommandAvailability, type AiStartCommandPayload, type AiStartPendingCommandPayload,
  type AiPlanControlCommandPayload, type AiPlanStartCommandPayload, type AiPlanPendingCommandPayload, type AiPlanTranslationCommandPayload } from "./workbenchCommands";
import { jsonIdentity } from "./pluginToolChoices";
import type { WorkPlanContinuation } from "./AiPreparationSession";
import type { EditorTarget } from "./TranslationWorkbench";
import { useWorkPlanApplicationTools, WorkPlanApplicationToolDetails, WorkPlanApplicationToolObservation } from "./workPlanApplicationTools";

export type PlanPending = ({ kind: "authorize"; request: WorkPlanAuthorizeRequest; checking:boolean; failure:unknown }
  | { kind: "control"; request: WorkPlanControlRequest; checking:boolean; failure:unknown }
  | { kind: "start"; request: WorkPlanStartRequest; attemptId: string; checking: boolean; retryAllowed: boolean; failure: unknown })
  & { prepared: WorkPlanView; editSeq: number; uncertain: boolean; receipt: WorkPlanReceiptView | null };
export type PlanReady = { receipt: WorkPlanReceiptView; prepared: WorkPlanView; editSeq: number };

export interface PlanControlState {
  minutes: number; renewConsent: boolean; checkerConsent: string[]; toolConsent: string | null; applicationToolConsent: string[];
  pending: PlanPending | null; ready: PlanReady | null; missing: boolean;
}
const initialControl = (): PlanControlState => ({ minutes: 60, renewConsent: false, checkerConsent: [], toolConsent: null, applicationToolConsent: [], pending: null, ready: null, missing: false });
/** The preparation owner calls this hook once, independently of its consumer. */
export function useWorkPlanControlSession(live: () => boolean) {
  const [state, setState] = useState(initialControl), ref = useRef(state);
  function update(change: (before: PlanControlState) => PlanControlState) {
    if (!live()) return;
    ref.current = change(ref.current); setState(ref.current);
  }
  return { state, current: () => ref.current, update, reset: () => update(initialControl) };
}
export type WorkPlanControlSession = ReturnType<typeof useWorkPlanControlSession>;

export function WorkPlanControls({ context, prepared, status, busy, disabled, consent, refresh,
  run, onPlan, onStarted, onBlockedChange, onOpenTranslation, onOpenExtensions, session, editSeq, open, canFresh, ownerBusy }: {
  context: SessionRequest;
  session: WorkPlanControlSession; editSeq: number; open: boolean; canFresh: () => boolean; ownerBusy: () => boolean;
  prepared: WorkPlanView | null;
  status: WorkPlanStatusView | null;
  busy: boolean;
  disabled: boolean;
  consent: boolean;
  refresh: (planId: string, current: () => boolean) => Promise<WorkPlanStatusView>;
  run: (work: (current: WorkPlanContinuation) => Promise<void>) => Promise<void>;
  onPlan: (id: string) => void;
  onStarted: (id: string, planId: string, taskId?: string) => void;
  onBlockedChange: (blocked: boolean) => void;
  onOpenTranslation: (target: EditorTarget, locale: string) => Promise<boolean>;
  onOpenExtensions?: () => void;
}) {
  const { t, i18n } = useTranslation(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const { minutes, renewConsent, checkerConsent, toolConsent, applicationToolConsent, pending, ready, missing } = session.state;
  const setMinutes = (minutes: number) => session.update(before => ({ ...before, minutes }));
  const setRenewConsent = (renewConsent: boolean) => session.update(before => ({ ...before, renewConsent }));
  const setCheckerConsent = (change: (before: string[]) => string[]) => session.update(before => ({ ...before, checkerConsent: change(before.checkerConsent) }));
  const setToolConsent = (toolConsent: string | null) => session.update(before => ({ ...before, toolConsent }));
  const setPending = (pending: PlanPending | null) => session.update(before => ({ ...before, pending }));
  const setReady = (ready: PlanReady | null) => session.update(before => ({ ...before, ready }));
  const setMissing = (missing: boolean) => session.update(before => ({ ...before, missing }));
  // This synchronizes the enclosing workbench's navigation guard, not query facts.
  useEffect(() => { onBlockedChange(Boolean(pending || ready)); }, [pending, ready, onBlockedChange]);
  const validMinutes = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  const plan = status?.plan ?? pending?.prepared ?? ready?.prepared ?? prepared;
  const applicationTools = useWorkPlanApplicationTools(plan?.tools?.entries ?? [], open && !busy);
  const applicationConsentKey = (group: typeof applicationTools.groups[number]) => jsonIdentity([context.sessionToken, context.projectId,
    plan?.planId, plan?.digest, status?.lease.generation ?? "prepared", group.basis, group.capabilities, group.tools]) ?? "";
  const applicationsConfirmed = applicationTools.groups.every(group => applicationToolConsent.includes(applicationConsentKey(group)));
  const confirmedApplications = () => applicationTools.groups.length && applicationsConfirmed && applicationTools.current()
    ? applicationTools.groups.map(group => structuredClone(group.basis)) : [];
  const checkerRequired = Boolean(plan?.preview && plan.options.stages.some(choice => choice.stage === "checks" && choice.mode === "assisted"));
  const checkerConsentKey = (checker: WorkPlanView["checkers"][number]) => JSON.stringify([context.sessionToken, context.projectId,
    plan?.planId, plan?.digest, status?.lease.generation ?? "prepared", checker]);
  const checkerConfirmed = !checkerRequired || Boolean(plan && plan.checkers.length > 0
    && plan.checkers.every(checker => checker.kind === "ready" && checkerConsent.includes(checkerConsentKey(checker))));
  const confirmedCheckers = () => checkerRequired && checkerConfirmed ? plan?.checkers.map(checker => checker.checker) ?? [] : [];
  const toolsRequired = Boolean(plan?.tools?.entries.length);
  const toolKey = toolsRequired && plan ? JSON.stringify([context.sessionToken, context.projectId, plan.planId, plan.digest, status?.lease.generation ?? "prepared", plan.tools]) : null;
  const toolsConfirmed = !toolsRequired || (toolKey !== null && toolConsent === toolKey);
  const blocked = busy || disabled || Boolean(pending);

  function expiry() {
    if (!validMinutes) throw { reason: "work-plan-expiry", outcome: "rejected" };
    return (BigInt(Math.floor(Date.now() / 1000)) + BigInt(minutes * 60)).toString();
  }

  async function accept(receipt: WorkPlanReceiptView, current: WorkPlanContinuation) {
    if (!current()) return false;
    onPlan(receipt.lease.planId);
    const latest = await refresh(receipt.lease.planId, current);
    if (!current()) return false;
    const original=session.current().pending;
    if(!original)throw {outcome:"unknown",reason:"invalid-work-plan-acknowledgement"};
    if(latest.plan.planId!==original.prepared.planId||latest.plan.digest!==original.prepared.digest
      ||jsonIdentity(latest.plan.scope)!==jsonIdentity(original.prepared.scope)
      ||jsonIdentity(latest.plan.options)!==jsonIdentity(original.prepared.options)
      ||jsonIdentity(latest.plan.teamDiscussionLimits)!==jsonIdentity(original.prepared.teamDiscussionLimits)
      ||jsonIdentity(latest.plan.memberPreviews)!==jsonIdentity(original.prepared.memberPreviews)
      ||jsonIdentity(latest.plan.preview)!==jsonIdentity(original.prepared.preview)
      ||jsonIdentity(latest.plan.tools)!==jsonIdentity(original.prepared.tools))throw {outcome:"unknown",reason:"invalid-work-plan-acknowledgement"};
    // A replayed receipt is historical. It must never restore older authority.
    const mayStart = latest.state === "active" && receipt.attemptId !== null
      && latest.lease.generation === receipt.lease.generation
      && BigInt(latest.expiresAt)>BigInt(Math.floor(Date.now()/1000));
    setPending(null); setMissing(false); setReady(mayStart ? {receipt:structuredClone(receipt),prepared:original.prepared,editSeq:original.editSeq} : null); setRenewConsent(false);
    return mayStart && jsonIdentity(latest.plan.checkers)===jsonIdentity(original.prepared.checkers) && current.acceptPlan(latest);
  }

  async function start(capture: PlanReady, current: WorkPlanContinuation) {
    const receipt=capture.receipt;
    if (!receipt.attemptId) return;
    const request = { ...context, planId: receipt.lease.planId, actionId: receipt.actionId,
      expectedGeneration: receipt.lease.generation };
    const entry: Extract<PlanPending,{kind:"start"}> = { kind: "start", request: structuredClone(request), attemptId: receipt.attemptId, prepared: capture.prepared, editSeq:capture.editSeq, uncertain: false, receipt:structuredClone(receipt), checking:false, retryAllowed:false, failure:null };
    await dispatchStart(entry,current);
  }
  function matchesStart(entry: Extract<PlanPending,{kind:"start"}>, current: WorkPlanContinuation) {
    return current() && !reads.retired && session.current().pending?.request === entry.request;
  }
  function settleStart(entry: Extract<PlanPending,{kind:"start"}>, current: WorkPlanContinuation, taskId?: string) {
    if (!matchesStart(entry,current)) return;
    // The enclosing owner captures the original pending preparation and edit sequence.
    if (taskId === undefined) onStarted(entry.attemptId,entry.request.planId);
    else onStarted(entry.attemptId,entry.request.planId,taskId);
    setReady(null); setPending(null); setMissing(false);
  }
  async function lookupStart(entry: Extract<PlanPending,{kind:"start"}>, current: WorkPlanContinuation) {
    if (!matchesStart(entry,current)) return;
    setPending({...entry,checking:true,uncertain:true,retryAllowed:false});
    let result: Awaited<ReturnType<typeof workPlanCommands.startAction>>;
    try {
      result = await workPlanCommands.startAction(entry.request);
      if (!matchesStart(entry,current)) return;
      if (!validateResponseWorkPlanStartAction(result) || result !== null && (result.projectId !== entry.request.projectId
        || result.planId !== entry.request.planId || result.actionId !== entry.request.actionId
        || result.expectedGeneration !== entry.request.expectedGeneration || result.attemptId !== entry.attemptId)) {
        throw {outcome:"unknown",reason:"invalid-work-plan-acknowledgement"};
      }
    } catch (error) {
      if (!matchesStart(entry,current)) return;
      setPending({...entry,checking:false,uncertain:true,retryAllowed:false,failure:error});
      throw error;
    }
    if (result !== null) { settleStart(entry,current,result.taskId); return; }
    setPending({...entry,checking:false,uncertain:true,retryAllowed:true});
    if (entry.failure !== null) throw entry.failure;
  }
  async function dispatchStart(entry: Extract<PlanPending,{kind:"start"}>, current: WorkPlanContinuation, recovering = false) {
    if (!current() || reads.retired) return;
    setPending({...entry,checking:false,retryAllowed:false}); setMissing(false);
    let failed: {error:unknown} | null = null;
    try { await workPlanCommands.start(entry.request,entry.attemptId); }
    catch (error) { failed = {error}; }
    if (!matchesStart(entry,current)) return;
    if (!failed) { settleStart(entry,current); return; }
    const unknown = hasUnknownOutcome(failed.error);
    if (recovering || entry.uncertain || unknown) {
      const retained = {...entry,checking:false,retryAllowed:false,uncertain:true,failure:failed.error}; setPending(retained);
      if (unknown) { await lookupStart(retained,current); return; }
    } else setPending(null);
    throw failed.error;
  }

  function matchesAction(entry:Exclude<PlanPending,{kind:"start"}>,current:WorkPlanContinuation) {
    return current()&&!reads.retired&&session.current().pending?.request===entry.request;
  }
  async function lookupAction(entry:Exclude<PlanPending,{kind:"start"}>,current:WorkPlanContinuation) {
    if(!matchesAction(entry,current))return;
    setPending({...entry,checking:true});setMissing(false);
    let result:Awaited<ReturnType<typeof workPlanCommands.authorizationAction>>;
    try {
      result=entry.kind==="authorize"?await workPlanCommands.authorizationAction(entry.request):await workPlanCommands.controlAction(entry.request);
      if(!matchesAction(entry,current))return;
      if(result!==null)confirmReceipt(result.receipt,entry);
      else if(entry.receipt)throw {outcome:"unknown",reason:"invalid-work-plan-acknowledgement"};
    } catch(error) {
      if(!matchesAction(entry,current))return;
      setPending({...entry,checking:false,failure:error});throw error;
    }
    if(result===null) {
      setPending({...entry,checking:false});setMissing(true);
      if(entry.failure!=null)throw entry.failure;
      return;
    }
    // A recorded Core transition does not restore Host-local grants, and this
    // recovery path never automatically submits its fixed execution input.
    setPending({...entry,receipt:structuredClone(result.receipt),uncertain:false,checking:false,failure:null});
    await accept(result.receipt,current);
  }
  async function mutate(action: Exclude<PlanPending, { kind: "start" }>, current: WorkPlanContinuation, enqueue: boolean) {
    action = structuredClone(action);
    action={...action,checking:false,failure:null};
    setPending(action); setMissing(false);
    let committed = false;
    try {
      const receipt = action.kind === "authorize"
        ? await workPlanCommands.authorize(action.request) : await workPlanCommands.control(action.request);
      confirmReceipt(receipt,action);
      committed = true;
      setPending({...action,receipt:structuredClone(receipt)});
      if (await accept(receipt, current) && enqueue && current.fresh()) {
        const ready=session.current().ready;if(ready)await start(ready, current);
      }
    } catch (error) {
      // Once the action has committed, a failed read must be reconciled using the
      // same receipt. A later start failure is handled by start's own pending state.
      if (current() && !reads.retired && !committed) {
        const unknown=hasUnknownOutcome(error);
        if(action.uncertain||unknown) {
          const retained={...action,uncertain:true,checking:false,failure:error};setPending(retained);
          if(unknown) {await lookupAction(retained,current);return;}
        } else setPending(null);
      }
      throw error;
    }
  }

  async function control(payload: AiPlanControlCommandPayload, current: WorkPlanContinuation) {
    if (!status) return;
    const original = structuredClone({ ...context, planId:payload.planId, expectedGeneration:payload.expectedGeneration,
      command:payload.command,confirmed:payload.confirmed,checkerExecutions:payload.checkerExecutions,toolExecution:payload.toolExecution,
      applicationToolExecutions:payload.applicationToolExecutions,
      expiresAt:payload.command==="continue" ? expiry() : null });
    const prepared = structuredClone(status.plan), capturedSeq=editSeq;
    const actionId = await executionCommands.identity(context);
    if (!current.fresh()) return;
    await mutate({kind:"control",prepared,editSeq:capturedSeq,uncertain:false,receipt:null,checking:false,failure:null,request:{...original,actionId}},current,payload.command==="continue");
  }

  async function reconcile(current: WorkPlanContinuation) {
    const pending = session.current().pending;
    if (!pending) return;
    if (pending.kind === "start") {
      await lookupStart(pending,current);
    } else {
      await lookupAction(pending,current);
    }
  }

  const scope={projectId:context.projectId,sessionToken:context.sessionToken,area:"ai" as const};
  const unavailable:CommandAvailability={enabled:false,reason:"unavailable"};
  function gate(recovery=false):CommandAvailability {
    if(!open||reads.retired)return{enabled:false,reason:"hidden"};
    if(ownerBusy()||busy)return{enabled:false,reason:"busy"};
    if(!recovery&&(disabled||session.current().pending))return unavailable;
    return{enabled:true};
  }
  function statusCurrent() {
    if(!status)return false;
    const query=reads.client.getQueryState<WorkPlanStatusView>(reads.key(["workPlan",status.lease.planId]));
    return query?.status==="success"&&query.fetchStatus==="idle"&&!query.isInvalidated&&query.error===null
      &&query.data?.plan.digest===status.plan.digest&&jsonIdentity(query.data.lease)===jsonIdentity(status.lease)&&query.data.state===status.state;
  }
  function effects():AutomationEffect[] {
    if(!plan)return [];
    return ["save-candidate",...(checkerRequired?["run-checks"] as const:[]),
      ...(plan.options.selectionPolicy==="candidates-only"?[]:
        [plan.options.selectionPolicy==="missing-only"?"select-missing":"replace-captured-selection"] as const),
      ...(plan.options.teamDiscussions?["publish-discussion"] as const:[]),
      ...(plan.options.teamExecution?["dispatch-team-work","send-team-message"] as const:[]),
      ...(toolsRequired?["query-tools"] as const:[])];
  }
  function startPayload():AiStartCommandPayload|undefined {
    return prepared?.preview&&prepared.attemptId?{kind:"ai-start",planId:prepared.planId,digest:prepared.digest,attemptId:prepared.attemptId,
      editSeq,minutes:session.current().minutes,confirmed:consent,checkerExecutions:confirmedCheckers(),toolExecution:toolsRequired&&toolsConfirmed,
      applicationToolExecutions:confirmedApplications(),effects:effects()}:undefined;
  }
  function authorizeAvailability(payload?:AiStartCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    return payload&&jsonIdentity(payload)===jsonIdentity(startPayload())&&!!prepared&&!status&&!session.current().ready
      &&consent&&checkerConfirmed&&toolsConfirmed&&applicationsConfirmed&&applicationTools.current()&&validMinutes&&canFresh()?{enabled:true}:unavailable;
  }
  async function authorize(payload:AiStartCommandPayload,current:WorkPlanContinuation) {
    if(!prepared)return;
    const capture={prepared,editSeq:payload.editSeq,uncertain:false,receipt:null,
      request:{...context,planId:payload.planId,digest:payload.digest,confirmed:payload.confirmed,checkerExecutions:structuredClone(payload.checkerExecutions),
        toolExecution:payload.toolExecution,applicationToolExecutions:structuredClone(payload.applicationToolExecutions),effects:[...payload.effects],expiresAt:expiry()}};
    const actionId=await executionCommands.identity(context);
    if(!current.fresh())return;
    await mutate({kind:"authorize",...capture,checking:false,failure:null,request:{...capture.request,actionId}},current,true);
  }
  function controlPayload(command:WorkPlanCommand):AiPlanControlCommandPayload|undefined {
    return status?{kind:"ai-plan-control",command,planId:status.lease.planId,expectedGeneration:status.lease.generation,
      minutes:command==="continue"?session.current().minutes:null,confirmed:command==="continue"&&renewConsent,
      checkerExecutions:command==="continue"?confirmedCheckers():[],toolExecution:command==="continue"&&toolsRequired&&toolsConfirmed,
      applicationToolExecutions:command==="continue"?confirmedApplications():[]}:undefined;
  }
  function controlAvailability(payload?:AiPlanControlCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    if(!payload||!status||!statusCurrent()||jsonIdentity(payload)!==jsonIdentity(controlPayload(payload.command)))return unavailable;
    if(payload.command==="continue")return !status.plan.options.teamExecution&&!session.current().ready&&(status.state==="paused"||status.state==="taken-over")&&renewConsent&&checkerConfirmed&&toolsConfirmed
      &&applicationsConfirmed&&applicationTools.current()&&validMinutes?{enabled:true}:unavailable;
    return (payload.command==="pause"?status.state==="active":payload.command==="stop"?status.state!=="stopped":status.state!=="taken-over"&&status.state!=="stopped")?{enabled:true}:unavailable;
  }
  function readyPayload():AiPlanStartCommandPayload|undefined {
    const ready=session.current().ready?.receipt;
    return ready?.attemptId?{kind:"ai-plan-start",request:{...context,planId:ready.lease.planId,actionId:ready.actionId,expectedGeneration:ready.lease.generation},attemptId:ready.attemptId}:undefined;
  }
  function readyAvailability(payload?:AiPlanStartCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    const capture=session.current().ready, ready=capture?.receipt;
    return payload&&capture&&ready&&statusCurrent()&&status?.state==="active"&&BigInt(status.expiresAt)>BigInt(Math.floor(Date.now()/1000))
      &&status.lease.generation===ready.lease.generation&&jsonIdentity(status.plan)===jsonIdentity(capture.prepared)
      &&jsonIdentity(payload)===jsonIdentity(readyPayload())?{enabled:true}:unavailable;
  }
  function pendingPayload():AiPlanPendingCommandPayload|undefined {
    const pending=session.current().pending;
    return pending?.kind==="authorize"?{kind:"ai-plan-pending",action:{kind:"authorize",request:pending.request}}:
      pending?.kind==="control"?{kind:"ai-plan-pending",action:{kind:"control",request:pending.request}}:undefined;
  }
  function startPendingPayload():AiStartPendingCommandPayload|undefined {
    const pending=session.current().pending;
    return pending?.kind==="start"?{kind:"ai-start-pending",request:pending.request,attemptId:pending.attemptId,editSeq:pending.editSeq}:undefined;
  }
  function pendingAvailability(payload?:AiPlanPendingCommandPayload,retry=false):CommandAvailability {
    const allowed=gate(true);if(!allowed.enabled)return allowed;
    return payload&&(!retry||session.current().missing)&&jsonIdentity(payload)===jsonIdentity(pendingPayload())?{enabled:true}:unavailable;
  }
  function startPendingAvailability(payload?:AiStartPendingCommandPayload,retry=false):CommandAvailability {
    const allowed=gate(true);if(!allowed.enabled)return allowed;
    const pending=session.current().pending;
    return pending?.kind==="start"&&pending.uncertain&&!pending.checking&&(!retry||pending.retryAllowed)
      &&payload&&jsonIdentity(payload)===jsonIdentity(startPendingPayload())?{enabled:true}:unavailable;
  }
  async function retryPending(current:WorkPlanContinuation) {
    const original=session.current().pending;if(!original)return;
    if(original.kind!=="start") { if(session.current().missing)await mutate({...original,uncertain:true},current,false);return; }
    if(original.retryAllowed)await dispatchStart(original,current,true);
  }
  function confirmReceipt(receipt:WorkPlanReceiptView,action:PlanPending) {
    if(action.kind==="start")return;
    const request=action.request;
    const generation=action.kind==="authorize"?"1":(BigInt(action.request.expectedGeneration)+1n).toString();
    const state=action.kind==="authorize"?"active":{pause:"paused",stop:"stopped","take-over":"taken-over",continue:"active"}[action.request.command];
    if(receipt.actionId!==request.actionId||receipt.lease.planId!==request.planId||receipt.lease.generation!==generation||receipt.state!==state
      ||(action.kind==="authorize"&&receipt.attemptId!==action.prepared.attemptId)
      ||(action.receipt&&jsonIdentity(action.receipt)!==jsonIdentity(receipt)))throw {outcome:"unknown",reason:"invalid-work-plan-acknowledgement"};
  }
  function translationPayload(unit:WorkPlanView["scope"][number]):AiPlanTranslationCommandPayload|undefined {
    return plan?{kind:"ai-plan-translation",planId:plan.planId,digest:plan.digest,expectedGeneration:status?.lease.generation??null,
      unitId:unit.unitId,locale:plan.locale,sourceRevisionId:unit.sourceRevisionId,sourceSnapshotId:unit.sourceSnapshotId}:undefined;
  }
  function translationAvailability(payload?:AiPlanTranslationCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    const unit=plan?.scope.find(unit=>unit.unitId===payload?.unitId);
    return payload&&unit&&!session.current().ready&&jsonIdentity(payload)===jsonIdentity(translationPayload(unit))&&(!status||statusCurrent())?{enabled:true}:unavailable;
  }
  async function openTranslation(payload:AiPlanTranslationCommandPayload) {
    const unit=plan?.scope.find(unit=>unit.unitId===payload.unitId);
    if(!unit||!translationAvailability(payload).enabled)return;
    await onOpenTranslation({unitId:unit.unitId,sourceRevisionId:unit.sourceRevisionId,key:unit.nativeKey,
      sourceText:plan?.preview?.items.find(item=>item.unitId===unit.unitId)?.sourceText??""},payload.locale);
  }
  useLayoutEffect(()=>{
    const metadata={category:"ai" as const,scope,binding:null,confirmation:"none" as const};
    const remove=[
      registry.register({...metadata,id:"ai.start",nameKey:"ai.generate",risk:"runs-ai",confirmation:"required",payloadKind:"ai-start",availability:authorizeAvailability,handler:payload=>{void run(current=>authorize(payload,current));}}),
      registry.register({...metadata,id:"ai.plan.pause",nameKey:"ai.plan.pause",risk:"runs-ai",payloadKind:"ai-plan-control",availability:payload=>payload?.command==="pause"?controlAvailability(payload):unavailable,handler:payload=>{void run(current=>control(payload,current));}}),
      registry.register({...metadata,id:"ai.plan.stop",nameKey:"ai.plan.stop",risk:"runs-ai",payloadKind:"ai-plan-control",availability:payload=>payload?.command==="stop"?controlAvailability(payload):unavailable,handler:payload=>{void run(current=>control(payload,current));}}),
      registry.register({...metadata,id:"ai.plan.take-over",nameKey:"ai.plan.takeOver",risk:"runs-ai",payloadKind:"ai-plan-control",availability:payload=>payload?.command==="take-over"?controlAvailability(payload):unavailable,handler:payload=>{void run(current=>control(payload,current));}}),
      registry.register({...metadata,id:"ai.plan.continue",nameKey:"ai.plan.continue",risk:"runs-ai",confirmation:"required",payloadKind:"ai-plan-control",availability:payload=>payload?.command==="continue"?controlAvailability(payload):unavailable,handler:payload=>{void run(current=>control(payload,current));}}),
      registry.register({...metadata,id:"ai.plan.start-authorized",nameKey:"ai.plan.startAuthorized",risk:"runs-ai",payloadKind:"ai-plan-start",availability:readyAvailability,handler:()=>{const value=session.current().ready;if(value)void run(current=>start(value,current));}}),
      registry.register({...metadata,id:"ai.plan.reconcile-action",nameKey:"ai.reconcile",risk:"reads-execution",payloadKind:"ai-plan-pending",availability:pendingAvailability,handler:()=>{void run(reconcile);}}),
      registry.register({...metadata,id:"ai.plan.retry-action",nameKey:"ai.retrySame",risk:"retries-execution-action",payloadKind:"ai-plan-pending",availability:payload=>pendingAvailability(payload,true),handler:()=>{void run(retryPending);}}),
      registry.register({...metadata,id:"ai.reconcile-start",nameKey:"ai.reconcile",risk:"reads-execution",payloadKind:"ai-start-pending",availability:startPendingAvailability,handler:()=>{void run(reconcile);}}),
      registry.register({...metadata,id:"ai.retry-start",nameKey:"ai.retrySame",risk:"retries-execution-action",payloadKind:"ai-start-pending",availability:payload=>startPendingAvailability(payload,true),handler:()=>{void run(retryPending);}}),
      registry.register({...metadata,id:"ai.plan.open-translation",nameKey:"ai.plan.edit",risk:"opens-translation",payloadKind:"ai-plan-translation",availability:translationAvailability,handler:payload=>{void openTranslation(payload);}}),
    ];return()=>remove.forEach(dispose=>dispose());
  });
  function dispatchControl(command:WorkPlanCommand){const payload=controlPayload(command);if(payload)registry.dispatch(command==="pause"?"ai.plan.pause":command==="stop"?"ai.plan.stop":command==="take-over"?"ai.plan.take-over":"ai.plan.continue",scope,payload);}

  const duration = <label className="field">{t("ai.plan.duration")}<input type="number" min={1} max={1440}
    aria-label={t("ai.plan.duration")}
    value={Number.isFinite(minutes) ? minutes : ""} disabled={blocked || Boolean(ready)}
    aria-invalid={!validMinutes || undefined} onChange={event => setMinutes(event.target.valueAsNumber)} />
    {!validMinutes ? <span className="field-error">{t("ai.errors.work-plan-expiry")}</span> : null}</label>;

  return <section aria-label={t("ai.plan.controls")}>
    {plan ? <>
      <h3>{t("ai.plan.title")}</h3>
      <ul>{plan.options.stages.map(choice => <li key={choice.stage}>{t(`ai.plan.stages.${choice.stage}`)}: {t(choice.stage === "checks" && choice.mode === "assisted" ? "ai.plan.mechanicalChecks" : `ai.plan.modes.${choice.mode}`)}</li>)}</ul>
      {plan.preview ? <p>{t(plan.options.selectionPolicy === "candidates-only" ? "ai.plan.candidatesOnly" : "ai.plan.checkedSelection")}</p> : null}
      {plan.preview ? <p>{t(`ai.plan.policies.${plan.options.selectionPolicy}`)}</p> : null}
      <details open={!plan.preview}><summary>{t("ai.plan.scope", { count: plan.scope.length, locale: plan.locale })}</summary>
        <ul>{plan.scope.map(unit => <li key={unit.unitId}>{unit.nativeKey} <button className="text-button"
          disabled={!translationAvailability(translationPayload(unit)).enabled} onClick={()=>{const payload=translationPayload(unit);if(payload)registry.dispatch("ai.plan.open-translation",scope,payload);}}>{t("ai.plan.edit")}</button></li>)}</ul>
      </details>
      {!plan.preview ? <p>{t("ai.plan.manualHelp")}</p> : null}
      {plan.tools ? <section aria-label={t("ai.tools.reviewTitle")}>
        <h4>{t("ai.tools.reviewTitle")}</h4><p>{t("ai.tools.limitHelp")}</p><p>{t("ai.tools.fixedLimit", { limit: plan.tools.maxInvocations, defaultValue: enUS.ai.tools.fixedLimit })}</p>
        {plan.tools.entries.map(tool => <article key={tool.handle}>
          <h4>{tool.binding.declaration.title} · {tool.binding.capability.provider.plugin.id} {tool.binding.capability.provider.plugin.version}</h4>
          <p>{tool.binding.declaration.description}</p><PluginPermissions permissions={tool.binding.capability.declaration.permissions} />
          <details><summary>{t("sourcePlugin.fixedDetails")}</summary><pre className="ai-text">{JSON.stringify({ binding: tool.binding, execution: tool.execution,
            applicationCapabilities: tool.applicationCapabilities, packageOrigin: tool.packageOrigin, runtimeOrigin: tool.runtimeOrigin, target: tool.target, selections: tool.selections }, null, 2)}</pre></details>
        </article>)}
        {applicationTools.groups.length ? <section aria-label={t("toolQuery.applicationTitle")}>
          {applicationTools.groups.map(group => <fieldset key={jsonIdentity(group.basis)}>
            <legend>{t("ai.tools.applicationInstance", { name: group.tools[0].binding.declaration.title })}</legend>
            <WorkPlanApplicationToolDetails group={group} />
            {!status || status.state === "paused" || status.state === "taken-over" ? <label className="source-check">
              <input type="checkbox" checked={applicationToolConsent.includes(applicationConsentKey(group))}
                disabled={blocked || Boolean(ready) || !applicationTools.current()} onChange={event => {
                  const key = applicationConsentKey(group), checked = event.target.checked;
                  session.update(before => ({ ...before, applicationToolConsent: checked
                    ? [...before.applicationToolConsent.filter(value => value !== key), key]
                    : before.applicationToolConsent.filter(value => value !== key) }));
                }} />{t("ai.tools.applicationConsent")}</label> : null}
          </fieldset>)}
          <WorkPlanApplicationToolObservation observation={applicationTools.observation} />
        </section> : null}
        <p>{t("sourcePlugin.unsandboxed")}</p>
        {!status || status.state === "paused" || status.state === "taken-over" ? <label className="source-check">
          <input type="checkbox" checked={toolKey !== null && toolConsent === toolKey} disabled={blocked || Boolean(ready)}
            onChange={event => setToolConsent(event.target.checked ? toolKey : null)} />{t("ai.tools.consent")}
        </label> : null}
      </section> : null}
      {checkerRequired ? <>
        {plan.checkers.length === 0 ? <p role="alert">{t("ai.plan.checkerUnavailable")}</p> : null}
        {onOpenExtensions && (plan.checkers.length === 0 || plan.checkers.some(checker => checker.kind === "unavailable")) ? <button type="button"
          className="text-button" disabled={blocked} onClick={onOpenExtensions}>{t("review.openExtensions")}</button> : null}
        {plan.checkers.map(checker => checker.kind === "ready" ? <fieldset key={checkerIdentity(checker.checker)}>
          <legend>{t("review.checkerConsentScope", { plugin: `${checker.checker.provider.plugin.publisher}/${checker.checker.provider.plugin.id} ${checker.checker.provider.plugin.version}`, profile: checker.checker.profile.id })}</legend>
          <ReviewCheckerDetails view={checker.plugin} />
          {!status || status.state === "paused" || status.state === "taken-over" ? <label className="source-check">
            <input type="checkbox" checked={checkerConsent.includes(checkerConsentKey(checker))} disabled={blocked || Boolean(ready)}
              onChange={event => { const key = checkerConsentKey(checker); setCheckerConsent(previous => event.target.checked ? [...previous.filter(value => value !== key), key] : previous.filter(value => value !== key)); }} />{t("ai.plan.checkerConsent")}
          </label> : null}
        </fieldset> : <div key={checkerIdentity(checker.checker)} role="alert"><p>{t("ai.plan.checkerUnavailable")}</p>
          <p>{checker.checker.provider.plugin.publisher}/{checker.checker.provider.plugin.id} {checker.checker.provider.plugin.version}</p>
          <CommandFailureDetails failure={commandFailure(checker.error)} /></div>)}
      </> : null}
    </> : null}
    {prepared?.preview && !status && !ready && !pending ? <>
      {duration}
      <button className="primary-button" disabled={!authorizeAvailability(startPayload()).enabled} onClick={()=>{const payload=startPayload();if(payload)registry.dispatch("ai.start",scope,payload);}}>{t("ai.generate")}</button>
    </> : null}
    {status ? <>
      <p role="status">{t(`ai.plan.states.${status.state}`)}</p>
      <p>{t("ai.plan.expires", { time: new Date(Number(status.expiresAt) * 1000).toLocaleString(i18n.resolvedLanguage) })}</p>
      <p>{t("ai.plan.stopHelp")}</p>
      {status.state === "active" ? <button className="secondary-button" disabled={!controlAvailability(controlPayload("pause")).enabled}
        onClick={() => dispatchControl("pause")}>{t("ai.plan.pause")}</button> : null}
      {status.state !== "stopped" ? <>
        <button className="secondary-button" disabled={!controlAvailability(controlPayload("stop")).enabled} onClick={() => dispatchControl("stop")}>{t("ai.plan.stop")}</button>
        {status.state !== "taken-over" ? <button className="secondary-button" disabled={!controlAvailability(controlPayload("take-over")).enabled}
          onClick={() => dispatchControl("take-over")}>{t("ai.plan.takeOver")}</button> : null}
      </> : null}
      {status.plan.options.teamExecution && (status.state !== "active" || BigInt(status.expiresAt) <= BigInt(Math.floor(Date.now() / 1000))) ? <p>{t("ai.team.reprepare")}</p> : null}
      {(status.state === "paused" || status.state === "taken-over") && !status.plan.options.teamExecution ? <>
        <p>{t("ai.plan.continueHelp")}</p>{duration}
        <label className="source-check"><input type="checkbox" checked={renewConsent} disabled={blocked || Boolean(ready)}
          onChange={event => setRenewConsent(event.target.checked)} />{t("ai.plan.renewConsent")}</label>
        <button className="primary-button" disabled={!controlAvailability(controlPayload("continue")).enabled}
          onClick={() => dispatchControl("continue")}>{t("ai.plan.continue")}</button>
      </> : null}
      <button className="secondary-button" disabled={blocked} onClick={() => void run(async current => {
        await refresh(status.lease.planId, current);
      })}>{t("ai.plan.refresh")}</button>
    </> : null}
    {ready && !pending ? <div role="status"><p>{t("ai.plan.ready")}</p><button className="primary-button" disabled={!readyAvailability(readyPayload()).enabled}
      onClick={()=>{const payload=readyPayload();if(payload)registry.dispatch("ai.plan.start-authorized",scope,payload);}}>{t("ai.plan.startAuthorized")}</button></div> : null}
    {pending ? <div role="status"><p>{t(pending.checking ? pending.kind === "start" ? "execution.checkingStart" : "ai.plan.checkingAction" : busy ? "ai.plan.pending" : pending.kind === "start" ? "ai.startUnknown" : pending.receipt ? "ai.plan.actionRecorded" : "ai.plan.actionUnknown")}</p>
      <button className="secondary-button" disabled={pending.kind==="start"?!startPendingAvailability(startPendingPayload()).enabled:!pendingAvailability(pendingPayload()).enabled} onClick={()=>{if(pending.kind==="start"){const payload=startPendingPayload();if(payload)registry.dispatch("ai.reconcile-start",scope,payload);}else{const payload=pendingPayload();if(payload)registry.dispatch("ai.plan.reconcile-action",scope,payload);}}}>{t("ai.reconcile")}</button>
      {pending.kind === "start" ? pending.retryAllowed ? <button className="secondary-button" disabled={!startPendingAvailability(startPendingPayload(),true).enabled}
        onClick={()=>{const payload=startPendingPayload();if(payload)registry.dispatch("ai.retry-start",scope,payload);}}>{t("ai.retrySame")}</button> : null : missing ? <button className="secondary-button" disabled={!pendingAvailability(pendingPayload(),true).enabled}
        onClick={()=>{const payload=pendingPayload();if(payload)registry.dispatch("ai.plan.retry-action",scope,payload);}}>{t("ai.retrySame")}</button> : null}
    </div> : null}
  </section>;
}
