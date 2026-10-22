import { SourceContextChoice } from "./SourceContextPreparation";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TaskCancellationFeedback, useExecutionTaskSession } from "./ExecutionTaskSession";
import { commandFailure, failureReason, CommandFailureDetails } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView, useWorkbenchState, useWorkbenchRef, type AttemptWorkbenchHandle, type WorkspaceArea } from "./WorkbenchFrame";
import {enUS} from "./i18n/en-US";
import {useEffect,useImperativeHandle,useLayoutEffect,useRef,useState,type Ref} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {useTranslation} from "react-i18next";
import type {ProjectView} from "./projectCommands";
import {executionContext} from "./executionCommands";
import {sourceReads} from "./sourceQueries";
import {aiTarget,isChatGptSubscription,type AiView} from "./aiCommands";
import { AiConnectionFields } from "./AiConnectionFields";
import { TeamDiscussionDisclosure } from "./TeamDiscussionDisclosure";
import { TeamDiscussionHistory } from "./TeamDiscussionHistory";
import { TeamExecutionChoice } from "./TeamExecutionChoice";
import { TeamExecutionDisclosure } from "./TeamExecutionDisclosure";
import { TeamRecoveryControls } from "./TeamRecoveryControls";
import { TeamExecutionHistory } from "./TeamExecutionHistory";
import { AiPreviewItems } from "./AiPreviewItems";
import { ToolGuidanceSharing } from "./ToolGuidanceSharing";
import { AiOutputUsage, AiProviderBudget } from "./AiUsage";
import {useAiPreparation,type WorkPlanContinuation} from "./AiPreparationSession";
import { WorkPlanControls } from "./WorkPlanControls";
import { ModelConnectionPicker, PreparationBudgetSummary } from "./ModelConnectionPicker";
import { IncrementalMaintenance } from "./IncrementalMaintenance";
import { WorkPlanAgentControls } from "./WorkPlanAgentControls";
import { WorkPlanToolChoice, type PlanToolChoiceHandle } from "./WorkPlanToolChoice";
import { AiScopePicker } from "./AiScopePicker";
import { AiCandidateDecisionPanel } from "./AiCandidateDecisionPanel";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { AiEffectStatus } from "./AiEffectStatus";
import { StrategyWorkbench } from "./StrategyWorkbench";
import { useOptionalStrategyDraftSession } from "./StrategyDraftSession";
import { TextReviewSelections } from "./TextReviewSelections";
import type { PlanOptions, WorkPlanStatusView, TeamWorkReference, TeamToolHistoryAttempt } from "./workPlanCommands";
import type { TranslationRevision } from "./translationCommands";
import type {EditorTarget} from "./TranslationWorkbench";
import type { ContentPage } from "./sourceCommands";
import type { AiReviewOrigin, WorkspaceDestination } from "./sessionNavigation";
import {useWorkbenchCommands,type CommandAvailability,type AiPreparationCommandPayload,
  type AiCandidateCommandPayload,type AiSavedCandidateCommandPayload,type AiTranslationCommandPayload,type AiAdoptionPendingCommandPayload,type AiEffectCommandPayload,
  type ExecutionCancellationCommandPayload,type ExecutionCancellationRetryCommandPayload} from "./workbenchCommands";
export interface AiHandle extends AttemptWorkbenchHandle {allowNavigate:(destination?: WorkspaceDestination)=>Promise<boolean>}
const stage=(e:unknown)=>commandFailure(e,"outcome-unknown");
export function AiWorkbench({project,disabled,ref,onOpenTranslation,onOpenExtensions,onOpenConnections,onOpenManual,onOpenMcpQuery,onOpenComparison,onOpenReview,onOpenTask}:{project:ProjectView;disabled:boolean;ref?:Ref<AiHandle>;onOpenTranslation:(target:EditorTarget,locale:string,suggestedText?:string)=>Promise<boolean>;onOpenExtensions?:()=>void;onOpenConnections?:()=>void;onOpenManual?:(area:WorkspaceArea)=>Promise<boolean>;onOpenMcpQuery?:()=>Promise<boolean>;onOpenComparison?:(target:EditorTarget,locale:string,revision:Pick<TranslationRevision,"revisionId"|"ordinal">)=>Promise<boolean>;onOpenReview?:(target:EditorTarget,locale:string,origin:AiReviewOrigin)=>Promise<boolean>;onOpenTask?:(taskId:string,attemptId:string)=>Promise<boolean>}) {
  const {t,i18n}=useTranslation();const context=executionContext(project),reads=useSessionReads(),registry=useWorkbenchCommands();
  const [connectionOpen,setConnectionOpen]=useWorkbenchState("ai", "connectionOpen", false);
  const preparation=useAiPreparation(), tasks=useExecutionTaskSession(), translationDraft=useTranslationDraftSession();
  const strategy = useOptionalStrategyDraftSession();
  const [candidateTarget,setCandidateTarget]=useWorkbenchState<AiSavedCandidateCommandPayload|null>("ai","candidateTarget",null);
  const {presetName,setPresetName,config,setConfig,locale,setLocale,selected,selectedSnapshotId,setSelected,preparedPlan:prepared,options,setOptions,toolDraft,setToolDraft,advisoryChecks,setAdvisoryChecks,
    consent,setConsent,staleReason,pendingStart,pendingAdopt,dirty,sourceGeneration,clearSelectedRange,reset,targetAvailable,attempt,busy}=preparation;
  const toolChoice = useRef<PlanToolChoiceHandle>(null);
  const lastSourceGeneration = useWorkbenchRef("ai", "sourceGeneration", sourceGeneration);
  const [open,setOpen]=useWorkbenchView("ai"),[after,setAfter]=useWorkbenchState("ai", "after", 0),[leaving,setLeaving]=useState(false);
  const leaveProof = useRef<(() => boolean) | null>(null);
  const leaveResolve=useRef<((v:boolean)=>void)|null>(null),errorRef=useRef<HTMLDivElement>(null);
  const mounted=useRef(false),navigationGeneration=useRef(0);
  const childHistoryIntent = useRef<{ taskId: string; attemptId: string; current: () => boolean } | null>(null);
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;navigationGeneration.current++;};},[]);
  useLayoutEffect(()=>{navigationGeneration.current++;},[open,disabled,project.sessionToken]);
  const scopeOptions=sourceReads.scope(context),scopeRead=useSessionQuery({...scopeOptions,enabled:open});
  const contentOptions=sourceReads.content(context,scopeRead.data?.currentSnapshot??"",after,scopeRead.data);
  const contentRead=useSessionQuery({...contentOptions,enabled:open&&!!scopeRead.data?.currentSnapshot&&!scopeRead.error});
  const visiblePage=!contentRead.error?contentRead.data??null:null;
  const storedPlan = preparation.planId ? reads.client.getQueryData<WorkPlanStatusView>(reads.key(["workPlan",preparation.planId]))?.plan : null;
  const capturedTeam = attempt ? (preparation.startedPlan?.attemptId === attempt ? preparation.startedPlan.prepared.options.teamExecution
    : prepared?.attemptId === attempt ? prepared.options.teamExecution : storedPlan?.attemptId === attempt ? storedPlan.options.teamExecution : null) : null;
  const selectedUnitNames = new Map<string, string>();
  for (const [, page] of reads.client.getQueriesData<ContentPage>({ queryKey: reads.key(["source-content", scopeRead.data?.currentSnapshot ?? ""]) })) {
    if (page && scopeRead.data?.currentSnapshot && page.snapshotId === scopeRead.data.currentSnapshot) for (const row of page.rows) if (row.unitId) selectedUnitNames.set(row.unitId, row.occurrence.key);
  }
  const viewRead = useSessionQuery<AiView | null>({
    key: ["aiCommands", attempt], scopes: ["execution", "source", "translation", "resources", "arena"], enabled: open && !!attempt && !capturedTeam,
    read: () => preparation.readView(attempt!),
  });
  const view = capturedTeam ? null : viewRead.data ?? null;
  const planId = preparation.planId ?? view?.planId ?? null;
  const planRead = useSessionQuery<WorkPlanStatusView>({key:["workPlan",planId],scopes:["project","execution","source","translation","resources","review"],enabled:open&&!!planId,
    read:()=>preparation.readPlan(planId!)});
  const status = !planRead.error ? planRead.data ?? null : null;
  const [teamDeadlineTick,setTeamDeadlineTick]=useState(0);
  useEffect(()=>{
    if(!open||!capturedTeam||!status||status.state!=="active")return;
    const remaining=BigInt(status.expiresAt)*1000n-BigInt(Date.now())+1n;
    if(remaining<=0n)return;
    const timer=window.setTimeout(()=>setTeamDeadlineTick(value=>value+1),Number(remaining>2147483647n?2147483647n:remaining));
    return()=>window.clearTimeout(timer);
  },[open,!!capturedTeam,status?.plan.planId,status?.state,status?.expiresAt,teamDeadlineTick]);
  const sharingPlan = prepared?.preview ? prepared : status?.plan.preview ? status.plan
    : preparation.planControl.state.ready?.prepared.preview ? preparation.planControl.state.ready.prepared
    : preparation.planControl.state.pending?.prepared;
  const sharing = sharingPlan?.preview;
  const mcpDraft = preparation.mcpDraft, mcpOriginal = preparation.mcpOriginal, mcpState = mcpOriginal?.state;
  const originalMcpView = mcpOriginal?.status();
  const capturedMcp = sharingPlan?.options.mcpTermQuery?.preview;
  const assisted = options.stages.some(choice=>choice.stage==="generation"&&choice.mode==="assisted");
  const perform = (work: Parameters<typeof preparation.runWorkPlan>[0]) => preparation.runWorkPlan(work,planId,contentOptions.key);
  const refreshPlan = preparation.readPlanForAction;

  const failureValue=preparation.failure??(viewRead.error||planRead.error||scopeRead.error||contentRead.error?stage(viewRead.error??planRead.error??scopeRead.error??contentRead.error):null);
  const failure=failureReason(failureValue);
  const active=!!attempt&&(capturedTeam? !status||status.state==="active"&&BigInt(status.expiresAt)>BigInt(Math.floor(Date.now()/1000))
    : !view||view.detail.progress.queued>0||view.detail.progress.running>0||view.rows.some(row=>row.automation&&["waiting","saving-candidate","checking"].includes(row.automation.phase)));
  const cancelUnresolved = Object.values(tasks.state).some(value => (value.target.origin === "ai" || value.target.taskId === view?.detail.taskId)
    && (value.phase === "preparing" || value.phase === "pending" || value.phase === "checking" || value.phase === "unknown"));
  const locked=disabled||preparation.reserved()||active||cancelUnresolved;
  const planBlocked=!!preparation.planControl.state.pending||!!preparation.planControl.state.ready;
  useEffect(()=>()=>{leaveResolve.current?.(false);},[]);
  useEffect(()=>{if(lastSourceGeneration.current!==sourceGeneration){lastSourceGeneration.current=sourceGeneration;setAfter(0);}},[sourceGeneration]);
  useEffect(()=>{if(failure){if(["ai-endpoint","ai-model","ai-credential"].includes(failure))setConnectionOpen(true);errorRef.current?.focus();}},[failure]);
  function allowLeave(current: () => boolean = () => true):Promise<boolean> {
    leaveProof.current = current;
    if(cancelUnresolved||translationDraft.candidates.blocked()||translationDraft.candidates.hasDraft()){setOpen(true);return Promise.resolve(false);}
    if(preparation.recovery.blocked()){
      const originalPlan=preparation.recovery.pendingPlan();if(originalPlan)preparation.recordPlan(originalPlan);
      setOpen(true);return Promise.resolve(false);
    }
    if(preparation.discussions.blocked()){
      const originalPlan=preparation.discussions.firstBlockedPlan();if(originalPlan)preparation.recordPlan(originalPlan);
      setOpen(true);return Promise.resolve(false);
    }
    if(preparation.guidance.blocked()){
      const originalPlan=preparation.guidance.firstBlockedPlan();if(originalPlan)preparation.recordPlan(originalPlan);
      setOpen(true);return Promise.resolve(false);
    }
    if(preparation.reserved() || strategy?.reserved()){setOpen(true);return Promise.resolve(false);}
    if(!dirty && !preparation.discussions.hasDraft() && !preparation.recovery.hasDraft() && !preparation.guidance.hasDraft() && !strategy?.dirty())return Promise.resolve(true);
    setOpen(true);setLeaving(true);return new Promise(resolve=>{leaveResolve.current?.(false);leaveResolve.current=resolve;});
  }
  function allowNavigate(destination?:WorkspaceDestination):Promise<boolean> {
    const history = childHistoryIntent.current;
    if(history && destination?.kind === "task" && destination.taskId === history.taskId && destination.attemptId === history.attemptId
      && !cancelUnresolved && !translationDraft.candidates.blocked() && history.current()) return Promise.resolve(true);
    if(destination?.kind === "task" && !cancelUnresolved && !translationDraft.candidates.blocked() && preparation.canOpenRecoveryTask(destination.taskId,destination.attemptId)) return Promise.resolve(true);
    if(preparation.reserved(true)||translationDraft.candidates.blocked()){setOpen(true);return Promise.resolve(false);}
    return Promise.resolve(true);
  }
  async function openChildHistory(taskId:string,attemptId:string) {
    if(!onOpenTask || childHistoryIntent.current || !preparation.canOpenChildHistory(taskId,attemptId))return false;
    const intent={taskId,attemptId,current:()=>preparation.canOpenChildHistory(taskId,attemptId)};childHistoryIntent.current=intent;
    try{return await onOpenTask(taskId,attemptId);}
    finally{if(childHistoryIntent.current===intent)childHistoryIntent.current=null;}
  }
  async function openTeamToolHistory(work:TeamWorkReference,row:TeamToolHistoryAttempt) {
    const originalPlan=status?.plan.planId;
    if(!onOpenTask || disabled || !open || !mounted.current || childHistoryIntent.current || !originalPlan
      || !preparation.canOpenTeamToolHistory(originalPlan,work,row))return false;
    const {taskId,attemptId}=row.reference;
    const intent={taskId,attemptId,current:()=>preparation.canOpenTeamToolHistory(originalPlan,work,row)};childHistoryIntent.current=intent;
    try{return await onOpenTask(taskId,attemptId);}
    finally{if(childHistoryIntent.current===intent)childHistoryIntent.current=null;}
  }
  function settleLeave(value:boolean){if(value&&leaveProof.current&&!leaveProof.current())value=false;setLeaving(false);if(value&&strategy&&!strategy.reset())value=false;if(value&&!reset())value=false;leaveResolve.current?.(value);leaveResolve.current=null;leaveProof.current=null;}
  useImperativeHandle(ref,()=>({allowLeave,allowNavigate,showAttempt(id){preparation.showAttempt(id);setOpen(true);}}));
  function loadPage(next=0){if(next===0){void reads.client.invalidateQueries({queryKey:reads.key(scopeOptions.key),exact:true});void reads.client.invalidateQueries({queryKey:reads.key(sourceReads.content(context,scopeRead.data?.currentSnapshot??"",0,scopeRead.data).key),exact:true});}setAfter(next);}
  function refreshReads(){loadPage();if(attempt)void viewRead.refetch();if(planId)void planRead.refetch();}
  function change<K extends keyof typeof config>(key:K,value:(typeof config)[K]){setConfig(c=>({...c,[key]:value}));}
  const commandScope={projectId:project.metadata.projectId,sessionToken:project.sessionToken,area:"ai" as const};
  const unavailable:CommandAvailability={enabled:false,reason:"unavailable"};
  function gate(recovery=false):CommandAvailability {
    if(!open||leaving||reads.retired)return{enabled:false,reason:"hidden"};
    const current=preparation.current();
    if(current.busy)return{enabled:false,reason:"busy"};
    if(!recovery&&(current.pendingStart||current.pendingAdopt||translationDraft.candidates.blocked()))return{enabled:false,reason:"pending-action"};
    if(!recovery&&(disabled||preparation.reserved()))return unavailable;
    return{enabled:true};
  }
  function currentRead<T>(key:readonly unknown[]):T|undefined {
    const query=reads.client.getQueryState(reads.key(key));
    return query?.status==="success"&&query.fetchStatus==="idle"&&query.error===null&&!query.isInvalidated
      ?reads.client.getQueryData<T>(reads.key(key)):undefined;
  }
  function currentView(){const id=preparation.current().attempt;return id?currentRead<AiView>(["aiCommands",id]):undefined;}
  function planCurrent(value:AiView) {
    if(!value.planId)return value.planGeneration===null;
    const plan=currentRead<WorkPlanStatusView>(["workPlan",value.planId]);
    return !!plan&&plan.plan.planId===value.planId&&plan.lease.planId===value.planId&&plan.lease.generation===value.planGeneration
      &&plan.state==="active"&&BigInt(plan.expiresAt)>BigInt(Math.floor(Date.now()/1000));
  }
  function effectPayload(value:AiView,row:AiView["rows"][number]):AiEffectCommandPayload|undefined {
    return value.planId&&value.planGeneration&&row.automation?{kind:"ai-effect",planId:value.planId,expectedGeneration:value.planGeneration,
      attemptId:value.detail.attemptId,itemId:row.itemId,actionId:row.automation.actionId}:undefined;
  }
  function effectAvailability(payload?:AiEffectCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    const value=currentView(),row=value?.rows.find(row=>row.itemId===payload?.itemId);
    return payload&&value&&row?.automation?.retryable&&row.candidateDecision?.request.disposition!=="rejected"&&row.automation.phase==="failed"&&row.automation.actionId===payload.actionId
      &&value.detail.attemptId===payload.attemptId&&value.planId===payload.planId&&value.planGeneration===payload.expectedGeneration&&planCurrent(value)&&sourceReady()?{enabled:true}:unavailable;
  }
  async function retryEffect(payload:AiEffectCommandPayload,current:WorkPlanContinuation) {
    const permit=currentRead<WorkPlanStatusView>(["workPlan",payload.planId]);if(!permit)return;
    const latest=await preparation.readViewForAction(payload.attemptId,current);
    if(!current.fresh()||latest.planId!==payload.planId||latest.planGeneration!==payload.expectedGeneration
      ||BigInt(permit.expiresAt)<=BigInt(Math.floor(Date.now()/1000)))return;
    const row=latest.rows.find(row=>row.itemId===payload.itemId);
    if(!row?.automation?.retryable||row.candidateDecision?.request.disposition==="rejected"||row.automation.phase!=="failed"||row.automation.actionId!==payload.actionId)return;
    await preparation.retryEffect(payload.attemptId,payload.itemId);
  }
  function sourceReady(){
    const scope=currentRead<NonNullable<typeof scopeRead.data>>(scopeOptions.key);
    return !!scope?.currentSnapshot&&!!currentRead(sourceReads.content(context,scope.currentSnapshot,after,scope).key);
  }
  function selectionCurrent(){
    const source=currentRead<NonNullable<typeof scopeRead.data>>(scopeOptions.key);
    return !selected.length || selectedSnapshotId===null || selectedSnapshotId===source?.currentSnapshot;
  }
  function preparedSourceCurrent(){
    const source=currentRead<NonNullable<typeof scopeRead.data>>(scopeOptions.key);
    return !prepared || prepared.scope.every(unit=>unit.sourceSnapshotId===source?.currentSnapshot);
  }
  function generationActive(){
    const current=preparation.current(),value=currentView();
    if(!current.attempt)return false;
    const plan=current.planId?currentRead<WorkPlanStatusView>(["workPlan",current.planId]):null;
    const team=current.startedPlan?.attemptId===current.attempt?current.startedPlan.prepared.options.teamExecution
      :plan?.plan.attemptId===current.attempt?plan.plan.options.teamExecution:null;
    return team?!plan||plan.plan.attemptId!==current.attempt||plan.state==="active"&&BigInt(plan.expiresAt)>BigInt(Math.floor(Date.now()/1000))
      :!value||value.detail.progress.queued>0||value.detail.progress.running>0;
  }
  function preparationPayload():AiPreparationCommandPayload {
    const current=preparation.current();return{kind:"ai-preparation",editSeq:current.editSeq,locale:current.locale,unitIds:[...current.selected]};
  }
  function previewAvailability(payload?:AiPreparationCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    const current=preparation.current();
    return payload&&payload.editSeq===current.editSeq&&payload.locale===current.locale
      &&payload.unitIds.length===current.selected.length&&payload.unitIds.every((id,index)=>id===current.selected[index])
      &&preparation.canPreview(preparation.current().options.stages.some(choice=>choice.stage==="generation"&&choice.mode==="assisted"))&&!generationActive()&&!cancelUnresolved&&sourceReady()&&selectionCurrent()?{enabled:true}:unavailable;
  }
  function translationPayload(value:AiView,row:AiView["rows"][number]):AiTranslationCommandPayload {
    return{kind:"ai-translation-target",attemptId:value.detail.attemptId,taskId:value.detail.taskId,itemId:row.itemId,
      translationUnitId:row.item.unitId,locale:row.item.targetLocale,sourceRevisionId:row.item.sourceRevisionId,sourceSnapshotId:row.item.sourceSnapshotId};
  }
  function targetRow(payload:AiTranslationCommandPayload|AiCandidateCommandPayload|AiSavedCandidateCommandPayload){
    const value=currentView();
    if(!value||value.detail.attemptId!==payload.attemptId||value.detail.taskId!==payload.taskId)return null;
    const row=value.rows.find(row=>row.itemId===payload.itemId);
    return row&&row.item.unitId===payload.translationUnitId&&row.item.targetLocale===payload.locale
      &&row.item.sourceRevisionId===payload.sourceRevisionId&&row.item.sourceSnapshotId===payload.sourceSnapshotId?{value,row}:null;
  }
  function candidatePayload(value:AiView,row:AiView["rows"][number]):AiCandidateCommandPayload|undefined {
    const unit=value.detail.recovery.units.find(unit=>unit.itemIds.includes(row.itemId));
    return row.resultId&&unit?{...translationPayload(value,row),kind:"ai-candidate",resultId:row.resultId,recoveryUnitId:unit.unitId}:undefined;
  }
  function savedCandidatePayload(value:AiView,row:AiView["rows"][number]):AiSavedCandidateCommandPayload|undefined {
    return row.savedRevisionId&&row.resultId?{...translationPayload(value,row),kind:"ai-saved-candidate",revisionId:row.savedRevisionId,resultId:row.resultId}:undefined;
  }
  function savedCandidateAvailability(payload?:AiSavedCandidateCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    const target=payload&&targetRow(payload);
    return payload&&target&&project.metadata.targetLocales.includes(payload.locale)&&target.row.savedRevisionId===payload.revisionId&&target.row.resultId===payload.resultId?{enabled:true}:unavailable;
  }
  function candidateDecisionRow(){
    if(!candidateTarget)return null;
    const target=targetRow(candidateTarget);
    return target&&target.row.savedRevisionId===candidateTarget.revisionId&&target.row.resultId===candidateTarget.resultId?target:null;
  }
  function adoptionAvailability(payload?:AiCandidateCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    if(!payload)return unavailable;
    const target=targetRow(payload);
    return target&&target.row.resultId===payload.resultId
      &&target.value.detail.recovery.units.some(unit=>unit.unitId===payload.recoveryUnitId&&unit.itemIds.includes(payload.itemId)&&unit.resultIds.includes(payload.resultId))
      &&!cancelUnresolved&&preparation.canAdopt(target.value,payload.resultId)?{enabled:true}:unavailable;
  }
  function adoptionPendingPayload():AiAdoptionPendingCommandPayload|undefined {
    const pending=preparation.current().pendingAdopt;return pending?{kind:"ai-adoption-pending",attemptId:pending.request.attemptId,
      actionId:pending.request.actionId,recoveryUnitId:pending.request.unitId,resultId:pending.candidate.resultId}:undefined;
  }
  function adoptionRecoveryAvailability(payload?:AiAdoptionPendingCommandPayload,retry=false):CommandAvailability {
    const allowed=gate(true);if(!allowed.enabled)return allowed;
    const pending=preparation.current().pendingAdopt;
    return pending?.uncertain&&(!retry||pending.retryAllowed)&&payload&&payload.attemptId===pending.request.attemptId
      &&payload.actionId===pending.request.actionId&&payload.recoveryUnitId===pending.request.unitId&&payload.resultId===pending.candidate.resultId?{enabled:true}:unavailable;
  }
  function cancellationPayload(value:AiView):ExecutionCancellationCommandPayload {
    return{kind:"execution-cancellation",taskId:value.detail.taskId,attemptId:value.detail.attemptId,origin:"ai"};
  }
  function retainedCancellationView(){
    const current=preparation.current();
    if(!current.attempt)return undefined;
    const key=reads.key(["aiCommands",current.attempt]);
    const value=reads.client.getQueryData<AiView|null>(key);
    const original=current.started?.prepared.attemptId===current.attempt?current.started:null;
    // Cancelling a checked original Task does not require an idle view read.
    // Keep the existing successful view route, including its exact owner proof.
    return current.checkedTask?.attemptId===current.attempt&&current.checkedTask.taskId===value?.detail.taskId&&value?.detail.attemptId===current.attempt
      &&value.detail.recovery.attemptId===current.attempt&&value.detail.operation==="ai-translation"
      &&(!original?.taskId||original.taskId===value.detail.taskId)
      &&(!current.startedPlan?.taskId||current.startedPlan.taskId===value.detail.taskId)?value:undefined;
  }
  function cancellationAvailability(payload?:ExecutionCancellationCommandPayload):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    const value=retainedCancellationView();
    return payload?.origin==="ai"&&value&&payload.taskId===value.detail.taskId&&payload.attemptId===value.detail.attemptId
      &&(value.detail.progress.queued>0||value.detail.progress.running>0)&&tasks.canCancel(payload)?{enabled:true}:unavailable;
  }
  function cancellationRetryAvailability(payload?:ExecutionCancellationRetryCommandPayload,retry=true):CommandAvailability {
    const allowed=gate(true);if(!allowed.enabled)return allowed;
    const original=payload&&tasks.current(payload.taskId),activity=tasks.currentActivity();
    if(activity&&activity.intent.taskId===payload?.taskId&&["capturing","identifying","preparing","adopting","recovering","checking","unknown"].includes(activity.phase))return unavailable;
    return original?.phase==="unknown"&&(!retry||original.retryAllowed)&&payload&&original.target.attemptId===payload.attemptId&&original.target.origin===payload.origin
      &&original.request.requestId===payload.requestId?{enabled:true}:unavailable;
  }
  function translationAvailability(payload?:AiTranslationCommandPayload,rewrite=false):CommandAvailability {
    const allowed=gate();if(!allowed.enabled)return allowed;
    const target=payload&&targetRow(payload);
    return payload&&project.metadata.targetLocales.includes(payload.locale)&&target&&(!rewrite||target.row.output&&target.row.candidateDecision?.request.disposition!=="rejected")?{enabled:true}:unavailable;
  }
  async function openTranslation(payload:AiTranslationCommandPayload,rewrite=false){
    const target=targetRow(payload),ticket=navigationGeneration.current;
    const query=reads.client.getQueryCache().find({queryKey:reads.key(["aiCommands",payload.attemptId]),exact:true}),version=query?.state.dataUpdateCount;
    if(!target||!translationAvailability(payload,rewrite).enabled||!await allowNavigate())return;
    if(!mounted.current||navigationGeneration.current!==ticket||!translationAvailability(payload,rewrite).enabled
      ||!query||query.state.data!==target.value||query.state.dataUpdateCount!==version)return;
    if(rewrite&&target.row.output)await onOpenTranslation(aiTarget(target.row.item),payload.locale,target.row.output.text);
    else await onOpenTranslation(aiTarget(target.row.item),payload.locale);
  }
  async function openSourceEditor(target:EditorTarget){
    const page=currentRead<NonNullable<typeof visiblePage>>(contentOptions.key),ticket=navigationGeneration.current;
    if(!page||!sourceReady()||!page.rows.some(row=>row.unitId===target.unitId&&row.sourceRevisionId===target.sourceRevisionId)||!await allowNavigate())return;
    if(!mounted.current||navigationGeneration.current!==ticket||!sourceReady()||currentRead(contentOptions.key)!==page)return;
    await onOpenTranslation(target,locale);
  }
  function reviewAvailability(payload?:AiTranslationCommandPayload):CommandAvailability {
    return onOpenReview ? translationAvailability(payload) : unavailable;
  }
  async function openReview(payload:AiTranslationCommandPayload) {
    const target=targetRow(payload);
    if(!target||!reviewAvailability(payload).enabled||!onOpenReview)return;
    await onOpenReview(aiTarget(target.row.item),payload.locale,{attemptId:payload.attemptId,taskId:payload.taskId,
      itemId:payload.itemId,editSeq:preparation.current().editSeq});
  }
  useLayoutEffect(()=>{
    const metadata={category:"ai" as const,scope:commandScope,binding:null,confirmation:"none" as const};
    const remove=[
      registry.register({...metadata,id:"ai.inspect-candidate",nameKey:"candidateDecisions.inspect",risk:"opens-translation",payloadKind:"ai-saved-candidate",availability:savedCandidateAvailability,handler:payload=>setCandidateTarget(payload)}),
      registry.register({...metadata,id:"ai.effect.retry",nameKey:"ai.effects.retry",risk:"runs-ai",payloadKind:"ai-effect",availability:effectAvailability,handler:payload=>{void perform(current=>retryEffect(payload,current));}}),
      registry.register({...metadata,id:"ai.preview",nameKey:"ai.preview",risk:"captures-ai",payloadKind:"ai-preparation",availability:previewAvailability,handler:()=>{void preparation.preparePlan(()=>assisted&&toolDraft?toolChoice.current?.capture()??null:null,contentOptions.key);}}),
      registry.register({...metadata,id:"ai.adopt-result",nameKey:"ai.saveCandidate",risk:"writes-translation",payloadKind:"ai-candidate",availability:adoptionAvailability,
        handler:payload=>{const target=targetRow(payload);if(target)void preparation.adopt(target.value,payload.resultId);}}),
      registry.register({...metadata,id:"ai.reconcile-adoption",nameKey:"ai.reconcile",risk:"reads-execution",payloadKind:"ai-adoption-pending",availability:adoptionRecoveryAvailability,handler:()=>{void preparation.checkAdoption();}}),
      registry.register({...metadata,id:"ai.retry-adoption",nameKey:"ai.retrySame",risk:"retries-execution-action",payloadKind:"ai-adoption-pending",availability:payload=>adoptionRecoveryAvailability(payload,true),handler:()=>{void preparation.retryAdoption();}}),
      registry.register({...metadata,id:"ai.cancel-task",nameKey:"ai.cancel",risk:"cancels-execution-task",payloadKind:"execution-cancellation",availability:cancellationAvailability,
        handler:({taskId,attemptId,origin})=>{void tasks.cancel({taskId,attemptId,origin});}}),
      registry.register({...metadata,id:"ai.retry-cancellation",nameKey:"execution.retryCancellation",risk:"retries-execution-action",payloadKind:"execution-cancellation-retry",availability:cancellationRetryAvailability,handler:payload=>{void tasks.retry(payload.taskId);}}),
      registry.register({...metadata,id:"ai.check-cancellation",nameKey:"execution.checkCancellation",risk:"reads-execution",payloadKind:"execution-cancellation-retry",availability:payload=>cancellationRetryAvailability(payload,false),handler:payload=>{void tasks.checkCancellation(payload.taskId);}}),
      registry.register({...metadata,id:"ai.open-translation",nameKey:"ai.openEditor",risk:"opens-translation",payloadKind:"ai-translation-target",availability:translationAvailability,handler:payload=>{void openTranslation(payload);}}),
      registry.register({...metadata,id:"ai.open-review",nameKey:"ai.reviewHandoff.open",risk:"opens-review",payloadKind:"ai-translation-target",availability:reviewAvailability,handler:payload=>{void openReview(payload);}}),
      registry.register({...metadata,id:"ai.rewrite-translation",nameKey:"ai.workspace.rewrite",risk:"opens-translation",payloadKind:"ai-translation-target",availability:payload=>translationAvailability(payload,true),handler:payload=>{void openTranslation(payload,true);}}),
    ];
    return()=>remove.forEach(cleanup=>cleanup());
  });
  return <>{open?<WorkbenchPanel open={open} title={t("ai.title")} description={t("ai.description")} className="ai-dialog" onBack={()=>void allowNavigate().then(ok=>{if(ok)setOpen(false);})} backDisabled={disabled||preparation.reserved()||translationDraft.candidates.blocked()}>
    <section aria-label={t("ai.workspace.manualTitle")}><h2>{t("ai.workspace.manualTitle")}</h2><p>{t("ai.workspace.manualHelp")}</p>
      {onOpenManual?<div className="execution-actions">{(["translation","resources","review","source","release"] as const).map(area=><button key={area} type="button" className="secondary-button" disabled={disabled||preparation.reserved()||cancelUnresolved} onClick={()=>{void onOpenManual(area);}}>{t(`ai.workspace.manual.${area}`)}</button>)}</div>:null}
    </section>
    {!project.metadata.targetLocales.length?<p role="status">{t("ai.workspace.noTargets")}</p>:null}
    <IncrementalMaintenance project={project} active={open} disabled={locked} onOpenManual={onOpenManual}/>
    <StrategyWorkbench area="ai" project={project} active={open} disabled={disabled || preparation.reserved()} config={config} onOpenConnections={onOpenConnections} />
    {preparation.strategyDefault === "loading" ? <p role="status">{t("strategy.defaultLoading")}</p> : preparation.strategyDefault === "failed" ? <div role="alert"><p>{t("strategy.defaultFailed")}</p><CommandFailureDetails failure={preparation.strategyDefaultFailure} />
      <button type="button" className="secondary-button" disabled={preparation.reserved()} onClick={() => void preparation.loadStrategyDefault()}>{t("strategy.retryDefault")}</button></div> : config.contextStrategy ? <p role="status">{t("strategy.appliedDefault")}</p> : null}
    <TaskCancellationFeedback origin="ai" taskId={view?.detail.taskId} disabled={busy} retryCommand={{
      available:intent=>cancellationRetryAvailability({...intent,kind:"execution-cancellation-retry"}).enabled,
      dispatch:intent=>{registry.dispatch("ai.retry-cancellation",commandScope,{...intent,kind:"execution-cancellation-retry"});},
    }} checkCommand={{available:intent=>cancellationRetryAvailability({...intent,kind:"execution-cancellation-retry"},false).enabled,
      dispatch:intent=>{registry.dispatch("ai.check-cancellation",commandScope,{...intent,kind:"execution-cancellation-retry"});}}} />
    {preparation.notice?<p role="status">{t(preparation.notice==="started"?"ai.startRecorded":preparation.notice==="saved"?"ai.candidateRecorded":preparation.notice==="maintenance"?"sourceHook.captured":"ai.newerInput")}</p>:null}
    {open&&(scopeRead.isFetching||contentRead.isFetching&&!!scopeRead.data?.currentSnapshot||viewRead.isFetching&&!!attempt||planRead.isFetching&&!!planId)?<p role="status">{t("ai.readLoading")}</p>:null}
    {failure?<div role="alert" tabIndex={-1} ref={errorRef}><p>{t(`ai.errors.${failure}`,{defaultValue:t("ai.errors.failed")})}</p><CommandFailureDetails failure={failureValue} /><button className="secondary-button" onClick={refreshReads} disabled={busy}>{t("ai.refresh")}</button></div>:null}
    {!targetAvailable&&locale?<p role="alert">{t("ai.errors.ai-locale")}</p>:null}
    {targetAvailable&&staleReason&&staleReason!=="connection"&&!prepared?<p role="status">{t(staleReason==="source"?"ai.errors.ai-source":"ai.errors.ai-preview")}</p>:null}
    <fieldset disabled={locked}><legend>{t("ai.scope",{count:selected.length})}</legend><h3>{t("ai.plan.stagesTitle")}</h3>{options.stages.map(choice=><label className="field" key={choice.stage}>{t(`ai.plan.stages.${choice.stage}`)}<select value={choice.mode} onChange={event=>{
      const mode = event.target.value;
      if(mode!=="manual"&&mode!=="assisted"&&mode!=="skipped")return;
      if(choice.stage==="generation"&&mode!=="assisted")preparation.setTeamDraft(null);
      setOptions(previous=>{
        const next: PlanOptions = {...previous,
          selectionPolicy: (choice.stage === "generation" || choice.stage === "checks") && mode !== "assisted" ? "candidates-only" : previous.selectionPolicy,
          stages:previous.stages.map(item=>item.stage===choice.stage?{...item,mode}:choice.stage==="generation"&&mode!=="assisted"&&item.stage==="checks"&&item.mode==="assisted"?{...item,mode:"manual"}:item)
        };
        if (choice.stage === "generation" && mode !== "assisted") { delete next.teamDiscussions; delete next.teamExecution; delete next.toolGuidance; }
        return next;
      });
    }}><option value="manual">{t("ai.plan.modes.manual")}</option>{choice.stage==="generation"?<option value="assisted">{t("ai.plan.modes.assisted")}</option>:choice.stage==="checks"&&assisted?<option value="assisted">{t("ai.plan.mechanicalChecks")}</option>:null}<option value="skipped">{t("ai.plan.modes.skipped")}</option></select></label>)}
    {assisted?<><label className="field">{t("ai.plan.selectionPolicy")}<select aria-label={t("ai.plan.selectionPolicy")} value={options.selectionPolicy} onChange={event=>{
      const selectionPolicy = event.target.value;
      if(selectionPolicy!=="candidates-only"&&selectionPolicy!=="missing-only"&&selectionPolicy!=="replace-captured-selection")return;
      setOptions(previous=>({...previous,selectionPolicy,stages:previous.stages.map(choice=>choice.stage==="checks"&&selectionPolicy!=="candidates-only"?{...choice,mode:"assisted"}:choice)}));

    }}>{(["candidates-only","missing-only","replace-captured-selection"] as const).map(policy=><option key={policy} value={policy}>{t(`ai.plan.policies.${policy}`)}</option>)}</select></label>
    {options.selectionPolicy!=="candidates-only"?<p>{t("ai.plan.checkedSelection")}</p>:null}</>:null}
{assisted?<><ModelConnectionPicker config={config} label={t("connections.choose")} active={open} disabled={locked} editSeq={preparation.editSeq} onSelect={preparation.selectConnection} onOpenSettings={onOpenConnections}/><PreparationBudgetSummary config={config} policy={options.teamDiscussions} team={!!preparation.teamDraft}/><AiConnectionFields config={config} setConfig={setConfig} presetName={presetName} setPresetName={setPresetName} connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={failure}/></>:null}
    {assisted?<WorkPlanToolChoice ref={toolChoice} open={open} disabled={locked} value={toolDraft} onChange={setToolDraft}/>:null}
    {assisted&&mcpOriginal?<section aria-label={t("ai.mcpTermQuery.title")}><h3>{t("ai.mcpTermQuery.title")}</h3>
      {onOpenMcpQuery?<button type="button" className="secondary-button" disabled={locked} onClick={()=>{void onOpenMcpQuery();}}>{t("ai.mcpTermQuery.prepare")}</button>:null}
      {mcpDraft?<><p>{t("ai.mcpTermQuery.scope",{entry:mcpDraft.label,locale:mcpDraft.preview.basis.locale})}</p>
        <p className="ai-text">{mcpDraft.preview.request.tool.endpoint}</p>
        <p className="ai-text">{mcpDraft.preview.request.tool.serverName} · {mcpDraft.preview.request.tool.serverVersion} · {mcpDraft.preview.request.tool.toolName}</p>
        <label>{t("mcpRetrieval.fixedQuery")}<textarea readOnly rows={3} value={mcpDraft.preview.arguments.query}/></label>
        <p>{t("mcpRetrieval.sourceLocale")} · {mcpDraft.preview.arguments.sourceLocale}</p>
        <p>{t("ai.mcpTermQuery.expiry",{expiry:new Intl.DateTimeFormat(i18n.resolvedLanguage,{dateStyle:"medium",timeStyle:"medium"}).format(mcpDraft.preview.request.expiresAtMs)})}</p>
        <p className="ai-text">{t("ai.mcpTermQuery.destination",{endpoint:config.endpoint,model:config.model})}</p>
        <p>{t("ai.mcpTermQuery.limits",{sdk:toolDraft?.maxInvocations??0,total:(toolDraft?.maxInvocations??0)+1})}</p>
        <p>{t("ai.mcpTermQuery.plainText")}</p>
        {originalMcpView?.task?<p role="status">{t("mcpRetrieval.status",{phase:t(`mcpRetrieval.phases.${originalMcpView.phase}`)})}</p>:!preparation.mcpScopeCurrent()?<p role="status">{t(mcpDraft.preview.request.expiresAtMs<=Date.now()?"ai.mcpTermQuery.expired":preparation.teamDraft?"ai.mcpTermQuery.unsupported":"ai.mcpTermQuery.changed")}</p>:null}
        <label className="source-check"><input type="checkbox" checked={mcpDraft.serviceConsent} disabled={locked||!preparation.mcpScopeCurrent()||!preparation.connectionCurrent()}
          onChange={event=>preparation.setMcpConsent("serviceConsent",event.target.checked)}/>{t("ai.mcpTermQuery.serviceConsent")}</label>
        <label className="source-check"><input type="checkbox" checked={mcpDraft.modelConsent} disabled={locked||!preparation.mcpScopeCurrent()||!preparation.connectionCurrent()}
          onChange={event=>preparation.setMcpConsent("modelConsent",event.target.checked)}/>{t("ai.mcpTermQuery.modelConsent")}</label>
        <button type="button" className="secondary-button" disabled={locked} onClick={()=>preparation.clearMcpQuery()}>{t("ai.mcpTermQuery.clear")}</button>
      </>:<p>{t("ai.mcpTermQuery.empty")}</p>}
    </section>:null}
    {assisted?<><label className="source-check"><input type="checkbox" checked={!!options.toolGuidance} disabled={locked||!toolDraft?.entries.length}
      onChange={event=>{
        const enabled=event.target.checked;
        if(enabled&&!toolDraft?.entries.length)return;
        setOptions(previous=>{const next={...previous};if(enabled)next.toolGuidance={profile:"declared-tools-1"};else delete next.toolGuidance;return next;});
      }}/>{t("ai.toolGuidanceSharing.enable")}</label><p>{t("ai.toolGuidanceSharing.help")}</p></>:null}
    <label className="field">{t("ai.locale")}<select value={locale} disabled={!!preparation.maintenance} onChange={e=>{setLocale(e.target.value);}}>{!targetAvailable&&locale?<option value={locale} disabled>{locale}</option>:null}{project.metadata.targetLocales.map(l=><option key={l}>{l}</option>)}</select></label>
    {assisted?<label className="source-check"><input type="checkbox" checked={!!options.teamDiscussions} onChange={event=>{
      const enabled=event.target.checked;
      setOptions(previous=>{
        const next={...previous};
        if(enabled) next.teamDiscussions={profile:"current-plan-1"};
        else delete next.teamDiscussions;
        return next;
      });
    }}/>{t("ai.discussions.enable")}</label>:null}
    {assisted&&options.teamDiscussions?<label className="source-check"><input type="checkbox" checked={options.teamDiscussions.profile==="current-plan-2"} onChange={event=>{
      const enabled=event.target.checked;
      setOptions(previous=>previous.teamDiscussions?{...previous,teamDiscussions:{profile:enabled?"current-plan-2":"current-plan-1"}}:previous);
    }}/>{t("ai.discussions.enableArtifacts")}</label>:null}
    {assisted?<><label className="source-check"><input type="checkbox" checked={config.shareTerms} onChange={e=>change("shareTerms",e.target.checked)}/>{t("ai.shareTerms")}</label><label className="source-check"><input type="checkbox" checked={config.shareContext} onChange={e=>change("shareContext",e.target.checked)}/>{t("ai.shareContext")}</label></>:null}
    {assisted?<SourceContextChoice value={config.sourceContext} onChange={value=>change("sourceContext",value)}/>:null}
    <AiScopePicker page={visiblePage} snapshotId={scopeRead.data?.currentSnapshot??null} selectedSnapshotId={selectedSnapshotId} selected={selected} after={after}
      ready={sourceReady()} loading={scopeRead.isFetching||contentRead.isFetching} failed={!!scopeRead.error||!!contentRead.error} disabled={locked||!!preparation.maintenance}
      onChange={setSelected} onRefresh={refreshReads} onPage={loadPage} onOpenEditor={target=>{void openSourceEditor(target);}}/>
    <button className="secondary-button" type="button" disabled={locked||!selected.length} onClick={()=>{if(locked)return;clearSelectedRange();}}>{t("ai.clearSelectedRange")}</button>
    {assisted?<TeamExecutionChoice value={preparation.teamDraft} config={config} selected={selected} unitNames={selectedUnitNames} tools={toolDraft}
      discussionsEnabled={!!options.teamDiscussions} disabled={locked} open={open} editSeq={preparation.editSeq} onChange={preparation.setTeamDraft} onConfig={preparation.editTeamConfig}
      onConnection={preparation.selectTeamConnection} onOpenSettings={onOpenConnections}/>:null}
    {options.stages.some(choice=>choice.stage==="checks"&&choice.mode==="assisted")?<><p>{t("review.formatChecksRequired")}</p><TextReviewSelections value={advisoryChecks} active={open} scopeKey={JSON.stringify([context,locale])} disabled={locked} onOpenExtensions={onOpenExtensions} onSnapshotRevision={revision=>{if(prepared?.checkers.some(checker=>checker.kind==="ready"&&checker.plugin.plugin.settingsRevision!==revision))preparation.invalidatePreview();}} onChange={setAdvisoryChecks}/></>:null}
    <button className="primary-button" disabled={!previewAvailability(preparationPayload()).enabled} onClick={()=>{registry.dispatch("ai.preview",commandScope,preparationPayload());}}>{t(assisted?"ai.preview":"ai.plan.prepareManual")}</button></fieldset>
    {mcpOriginal&&mcpState?.operation?.handedToAi?<section aria-label={t("mcpRetrieval.original")}><p>{t("ai.mcpTermQuery.stopHelp")}</p>
      <div className="execution-actions"><button type="button" disabled={disabled} onClick={()=>{void mcpOriginal.retryRead();}}>{t("ai.mcpTermQuery.read")}</button>
        <button type="button" disabled={disabled||mcpState.operation.closed&&mcpState.operation.drained&&!mcpState.stop?.pending&&!mcpState.stop?.unknown}
          onClick={()=>{void(mcpState.stopping?mcpOriginal.retryStop():mcpOriginal.stop());}}>{t("ai.mcpTermQuery.stop")}</button>
        {mcpOriginal.canEndWait()?<button type="button" onClick={()=>mcpOriginal.endWait()}>{t("mcpRetrieval.endWait")}</button>:null}</div>
      {mcpState.operation.closed?<p role="status">{t(mcpState.operation.drained?"mcpRetrieval.closed":"mcpRetrieval.draining")}</p>:null}
      {mcpState.stop?.unknown?<p role="status">{t("mcpRetrieval.stopUnknown")}</p>:null}
      {[mcpState.readFailure,mcpState.stopFailure].map((error,index)=>error?<div role="alert" key={index}><CommandFailureDetails failure={error}/></div>:null)}
    </section>:null}
    {sharing&&targetAvailable?<section><h3>{t("ai.previewTitle")}</h3>
      {!sharingPlan?.options.teamExecution?<p>{sharing.config.endpoint} · {sharing.config.model}</p>:null}
      <p>{t(isChatGptSubscription(sharing.config)?"connections.subscriptionInvocationSummary":"ai.limits",{items:String(sharing.config.maxItems),requests:String(sharing.config.maxRequests),concurrency:String(sharing.config.concurrency),tokens:String(sharing.config.maxOutputTokens),retries:String(sharing.config.maxRetries),timeout:String(sharing.config.timeoutSeconds)})}</p>
      <p>{t(sharingPlan?.options.teamExecution?sharingPlan.options.teamDiscussions?.profile==="current-plan-2"?"ai.team.artifactCostUnknown":"ai.team.costUnknown":sharingPlan?.options.teamDiscussions?.profile==="current-plan-2"?"ai.discussions.artifactCostUnknown":sharingPlan?.options.teamDiscussions?"ai.discussions.costUnknown":"ai.costUnknown")}</p><p>{t("ai.rateLimit")}</p>
      {sharingPlan?.options.teamExecution?<TeamExecutionDisclosure plan={sharingPlan}/>:<><AiPreviewItems items={sharing.items}/>{sharingPlan?<><TeamDiscussionDisclosure plan={sharingPlan}/><ToolGuidanceSharing plan={sharingPlan} config={sharing.config}/></>:null}</>}
      {capturedMcp?<section aria-label={t("ai.mcpTermQuery.confirmation")}><h4>{t("ai.mcpTermQuery.title")}</h4><p>{t("ai.mcpTermQuery.confirmation")}</p>
        <p>{t("ai.mcpTermQuery.scope",{entry:sharingPlan?.scope.find(unit=>unit.unitId===capturedMcp.basis.unitId)?.nativeKey??"",locale:capturedMcp.basis.locale})}</p>
        <p className="ai-text">{capturedMcp.request.tool.endpoint} · {capturedMcp.request.tool.toolName}</p><pre className="ai-text">{capturedMcp.arguments.query}</pre>
        <p className="ai-text">{t("ai.mcpTermQuery.destination",{endpoint:sharing.config.endpoint,model:sharing.config.model})}</p>
        <p>{t("ai.mcpTermQuery.limits",{sdk:sharingPlan?.tools?.maxInvocations??0,total:(sharingPlan?.tools?.maxInvocations??0)+1})}</p>
      </section>:null}
      {prepared?.options.toolGuidance&&!status?<p>{t("ai.toolGuidanceSharing.confirmation")}</p>:null}
      {prepared?.preview&&!status?<label className="source-check"><input type="checkbox" checked={consent} disabled={locked||!preparation.connectionCurrent()} onChange={e=>setConsent(e.target.checked)}/>{t(prepared.options.teamExecution?prepared.options.teamDiscussions?.profile==="current-plan-2"?"ai.team.artifactConsent":"ai.team.consent":prepared.options.teamDiscussions?.profile==="current-plan-2"?"ai.discussions.artifactConsent":prepared.options.teamDiscussions?"ai.discussions.consent":"ai.consent")}</label>:null}
    </section>:null}
    <WorkPlanControls context={context} prepared={prepared} status={status} busy={busy} disabled={disabled||!!pendingAdopt||preparation.guidance.blocked()} consent={consent}
      revocationDisabled={disabled||!!pendingAdopt} runRevocation={work=>preparation.runWorkPlan(work,planId,contentOptions.key,true)}
      session={preparation.planControl} editSeq={preparation.editSeq} run={perform} refresh={refreshPlan} onPlan={preparation.recordPlan}
      open={open} ownerBusy={()=>preparation.current().busy} canFresh={()=>sourceReady()&&selectionCurrent()&&preparedSourceCurrent()&&preparation.current().preparedPlan===prepared&&preparation.current().consent&&targetAvailable&&!cancelUnresolved&&(!prepared?.preview||preparation.connectionCurrent())&&(!prepared?.options.mcpTermQuery||preparation.mcpScopeCurrent())}
      onStarted={(id,idPlan,taskId)=>{const original=preparation.planControl.current().pending;if(original?.kind==="start")preparation.recordPlanStart(id,idPlan,original.prepared,original.request.expectedGeneration,original.editSeq,taskId??null);}}
      onBlockedChange={()=>{}} onOpenExtensions={onOpenExtensions} onOpenTranslation={onOpenTranslation}/>
    {status?.plan.options.teamExecution?<TeamRecoveryControls key={`team-recovery:${status.plan.planId}`} context={context} status={status} open={open}
      disabled={disabled||busy||!!pendingAdopt||cancelUnresolved||planBlocked||preparation.guidance.blocked()} session={preparation.recovery} onPlan={preparation.recordPlan} onOpenSettings={onOpenConnections} onOpenTask={onOpenTask}/>:null}
    {status?<TeamDiscussionHistory context={context} status={status} open={open} session={preparation.discussions}
      writable={!disabled&&!preparation.guidance.blocked()&&!scopeRead.error&&!!scopeRead.data?.currentSnapshot&&project.metadata.targetLocales.includes(status.plan.locale)
        &&status.plan.scope.every(unit=>unit.sourceSnapshotId===scopeRead.data?.currentSnapshot)}/>:null}
    {status?.plan.options.teamExecution?<TeamExecutionHistory key={`team-execution:${status.plan.planId}`} context={context} status={status} open={open} onOpenTask={onOpenTask}
      guidance={preparation.guidance} guidanceWritable={!disabled&&!busy&&!cancelUnresolved&&!planRead.isFetching&&!planRead.isStale&&!planRead.error
        &&!scopeRead.isFetching&&!scopeRead.isStale&&!scopeRead.error&&!!scopeRead.data?.currentSnapshot&&project.metadata.targetLocales.includes(status.plan.locale)
        &&status.plan.scope.every(unit=>unit.sourceSnapshotId===scopeRead.data?.currentSnapshot)}
      onOpenToolTask={onOpenTask?openTeamToolHistory:undefined}
      onReadPost={postId=>preparation.discussions.focusPost(status.plan.planId,postId)}/>:null}
    {status?.plan.preview&&!status.plan.options.teamExecution?<WorkPlanAgentControls context={context} status={status} open={open} disabled={disabled||planBlocked||!!pendingAdopt||active} busy={busy}
      session={preparation.agent} component={preparation.component} ownerBusy={()=>preparation.current().busy} run={perform} onBlockedChange={()=>{}} onGenerated={preparation.recordGenerated}
      childControls={onOpenTask?{disabled:disabled||planBlocked||!!pendingAdopt||cancelUnresolved||!sourceReady()||!project.metadata.targetLocales.includes(status.plan.locale),canRun:preparation.canRunChild,
        run:(work,recovery)=>preparation.runChildWorkPlan(work,planId,contentOptions.key,recovery),onOpenTask:openChildHistory}:undefined}/>:null}
    {pendingAdopt?<section><p role="status">{t(pendingAdopt.checking?"execution.checkingAdoption":pendingAdopt.uncertain?"ai.adoptUnknown":"ai.adoptPending")}</p><p>{pendingAdopt.candidate.item.nativeKey} → {pendingAdopt.candidate.item.targetLocale}</p><pre className="ai-text">{pendingAdopt.candidate.text}</pre>{pendingAdopt.uncertain?<><button className="secondary-button" disabled={!adoptionRecoveryAvailability(adoptionPendingPayload()).enabled} onClick={()=>{const payload=adoptionPendingPayload();if(payload)registry.dispatch("ai.reconcile-adoption",commandScope,payload);}}>{t("ai.reconcile")}</button>{pendingAdopt.retryAllowed?<button className="secondary-button" disabled={!adoptionRecoveryAvailability(adoptionPendingPayload(),true).enabled} onClick={()=>{const payload=adoptionPendingPayload();if(payload)registry.dispatch("ai.retry-adoption",commandScope,payload);}}>{t("ai.retrySame")}</button>:null}</>:null}</section>:null}
    {view?<section><h3>{t("ai.results")}</h3><p>{view.config.model} · {view.recipe}</p><p>{t("ai.progress",{...view.detail.progress,defaultValue:enUS.ai.progress})}</p>{view.budget?<AiProviderBudget budget={view.budget}/>:null}{active?<button className="secondary-button" disabled={!cancellationAvailability(cancellationPayload(view)).enabled} onClick={()=>{registry.dispatch("ai.cancel-task",commandScope,cancellationPayload(view));}}>{t("ai.cancel")}</button>:null}<button className="secondary-button" disabled={busy} onClick={()=>void viewRead.refetch()}>{t("ai.refresh")}</button>
    {view.rows.map(row=>{const item=view.detail.items.find(i=>i.status.itemId===row.itemId),adoptPayload=candidatePayload(view,row),editorPayload=translationPayload(view,row);const effect=effectPayload(view,row),savedPayload=savedCandidatePayload(view,row);return <article key={row.itemId}><h4>{row.item.nativeKey}</h4><p>{t(`ai.states.${item?.status.execution}`,{defaultValue:item?.status.execution??""})}</p>{item?.status.diagnostic?<p>{t(`ai.errors.${item.status.diagnostic}`,{defaultValue:t("ai.errors.failed")})}</p>:null}{row.automation?<AiEffectStatus effect={row.automation} disabled={!effectAvailability(effect).enabled} onRetry={()=>{if(effect)registry.dispatch("ai.effect.retry",commandScope,effect);}}/>:null}{row.output?<><pre className="ai-text">{row.output.text}</pre><AiOutputUsage usage={row.output.usage} incomplete={row.output.usageIncomplete}/><button className="secondary-button" disabled={!adoptionAvailability(adoptPayload).enabled} onClick={()=>{if(adoptPayload)registry.dispatch("ai.adopt-result",commandScope,adoptPayload);}}>{row.savedRevisionId||item?.status.adoption==="committed"||(row.resultId&&preparation.saved[row.resultId])?t("ai.saved"):t("ai.saveCandidate")}</button></>:null}{row.candidateDecision?<p role="status">{t(row.candidateDecision.request.disposition==="rejected"?"candidateDecisions.rejected":"candidateDecisions.restored")} · {row.candidateDecision.request.actor}: {row.candidateDecision.request.reason}</p>:null}{row.savedRevisionId?<button className="secondary-button" disabled={!savedCandidateAvailability(savedPayload).enabled} onClick={()=>{if(savedPayload)registry.dispatch("ai.inspect-candidate",commandScope,savedPayload);}}>{t("candidateDecisions.inspect")}</button>:row.output?<p>{t("candidateDecisions.saveFirst")}</p>:null}<div className="execution-actions">{onOpenReview?<button className="secondary-button" disabled={!reviewAvailability(editorPayload).enabled} onClick={()=>{registry.dispatch("ai.open-review",commandScope,editorPayload);}}>{t("ai.reviewHandoff.open")}</button>:null}<button className="secondary-button" disabled={!translationAvailability(editorPayload).enabled} onClick={()=>{registry.dispatch("ai.open-translation",commandScope,editorPayload);}}>{t("ai.openEditor")}</button>{row.output?<button type="button" className="secondary-button" disabled={!translationAvailability(editorPayload,true).enabled} onClick={()=>{registry.dispatch("ai.rewrite-translation",commandScope,editorPayload);}}>{t("ai.workspace.rewrite")}</button>:null}</div></article>;})}<p>{t("ai.noAutomaticRetry")}</p></section>:null}

    <AiCandidateDecisionPanel key={candidateTarget?.revisionId??"no-candidate"} project={project} disabled={disabled||busy||leaving} target={candidateTarget} currentRow={candidateDecisionRow} onOpenComparison={onOpenComparison}/>
  </WorkbenchPanel>:null}<Dialog.Root open={leaving} onOpenChange={next=>{if(!next)settleLeave(false);}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop"/><Dialog.Content className="confirm-dialog execution-confirm-dialog"><Dialog.Title>{t("ai.unsaved")}</Dialog.Title><Dialog.Description>{t("ai.unsavedDescription")}</Dialog.Description><button className="secondary-button" onClick={()=>settleLeave(false)}>{t("ai.stay")}</button><button className="secondary-button" onClick={()=>settleLeave(true)}>{t("ai.discard")}</button></Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
