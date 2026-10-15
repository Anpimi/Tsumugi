import { SourceContextChoice, SourceContextPreview } from "./SourceContextPreparation";
import { useSessionInfiniteQuery, useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { TaskCancellationFeedback, useExecutionTaskSession } from "./ExecutionTaskSession";
import { commandFailure, failureReason, CommandFailureDetails } from "./CommandFailure";
import { WorkbenchPanel, useWorkbenchView, useWorkbenchState } from "./WorkbenchFrame";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import type { ProjectView } from "./projectCommands";
import { executionContext } from "./executionCommands";
import { sourceCommands } from "./sourceCommands";
import { aiTarget, defaultAiConfig, type AiConfig } from "./aiCommands";
import { ModelConnectionPicker, PreparationBudgetSummary } from "./ModelConnectionPicker";
import { arenaCommands as arena, type ArenaConfig, type ArenaView, type ComparisonView, type ComparisonSummary } from "./arenaCommands";
import { useWorkbenchCommands, type CommandAvailability, type ArenaPreparationCommandPayload, type ArenaStartCommandPayload,
 type ArenaCandidateCommandPayload, type ArenaTranslationCommandPayload, type ArenaCompareCommandPayload, type ArenaComparisonCommandPayload,
 type ArenaSelectionCommandPayload, type ArenaMergeCommandPayload, type ArenaRevealCommandPayload, type ArenaRoundCommandPayload,
 type ArenaOpenComparisonCommandPayload, type ArenaPendingCommandPayload, type ExecutionCancellationCommandPayload,
 type ExecutionCancellationRetryCommandPayload } from "./workbenchCommands";
import { translationCommands as translations, type TranslationHistory } from "./translationCommands";
import { useArenaDraftSession } from "./ArenaDraftSession";
import type { AttemptWorkbenchHandle } from "./WorkbenchFrame";
import type { EditorTarget } from "./TranslationWorkbench";

const letter = (i: number) => String.fromCharCode(65 + i);
export interface ArenaHandle extends AttemptWorkbenchHandle { allowNavigate: () => Promise<boolean> }
export function ArenaWorkbench({project,disabled,ref,onOpenTranslation,onOpenConnections,onReturn}:{project:ProjectView;disabled:boolean;ref?:Ref<ArenaHandle>;onOpenTranslation:(target:EditorTarget,locale:string)=>boolean | Promise<boolean>;onOpenConnections?:()=>void;onReturn?:()=>void}) {
 const {t}=useTranslation(),context=executionContext(project),tasks=useExecutionTaskSession(),owner=useArenaDraftSession(),reads=useSessionReads(),registry=useWorkbenchCommands();
 const [open,setOpen]=useWorkbenchView("arena"),[after,setAfter]=useWorkbenchState("arena", "after", 0),[leaving,setLeaving]=useState(false);
 const [comparisonEntry] = useWorkbenchState<(EditorTarget & {locale:string;revisionId:string;revisionOrdinal:string}) | null>("arena", "comparisonEntry", null);
 const comparisonHeading = useRef<HTMLHeadingElement>(null);
 const {config,locale,selected,unit,prepared,consent,attempt,references,comparisonBlind,draft,busy,pending,notice}=owner;
 const fromEntry = !!comparisonEntry && comparisonEntry.unitId === unit && comparisonEntry.locale === locale;
 useLayoutEffect(() => { if (open && fromEntry) comparisonHeading.current?.focus({preventScroll:true}); }, [open, comparisonEntry, fromEntry]);
 const leaveProof = useRef<(() => boolean) | null>(null);
 const leaveResolve=useRef<((value:boolean)=>void)|null>(null),errorRef=useRef<HTMLDivElement>(null);
 const mounted=useRef(true),navigationGeneration=useRef(0);
 useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;navigationGeneration.current++;};},[]);
 useLayoutEffect(()=>{navigationGeneration.current++;},[open,disabled,project.sessionToken,project.metadata.projectId,project.metadata.targetLocales]);
 const scopeRead=useSessionQuery({key:["arena-source-scope",owner.sourceGeneration],scopes:["source","project"],enabled:open,
  read:()=>sourceCommands.scope(context)});
 const snapshot=scopeRead.data?.currentSnapshot;
 const pageRead=useSessionQuery({key:["arena-content",snapshot,after],scopes:["source","project"],enabled:open&&!!snapshot,
  read:()=>sourceCommands.content({...context,snapshotId:snapshot!,after,limit:50})});
 const page=pageRead.data??null;
 const listRead=useSessionQuery({key:["arena-comparisons"],scopes:["arena","source","translation","project"],enabled:open,
  read:()=>arena.comparisons(context)});
 const savedComparisons=listRead.data??[];
 const historyRead=useSessionInfiniteQuery<TranslationHistory,string>({key:["arena-history",unit,locale,owner.sourceGeneration],scopes:["translation","source","resources","project"],
  enabled:open&&!!unit&&owner.targetAvailable,initialPageParam:"0",nextPage:last=>last.nextOrdinal??undefined,
  read:afterOrdinal=>translations.history({...context,unitId:unit,locale,afterOrdinal,limit:50})});
 const pages=historyRead.data?.pages,history=pages?.length?{...pages[pages.length-1],rows:pages.flatMap(value=>value.rows).filter((row,index,rows)=>rows.findIndex(other=>other.revisionId===row.revisionId)===index)}:null;
 const comparisonRead=useSessionQuery({key:["arena-comparison",owner.comparisonId],scopes:["arena","source","translation","resources","project"],
  enabled:open&&!!owner.comparisonId&&!busy,read:()=>owner.readComparison(owner.comparisonId!)});
 const comparison=comparisonRead.data??null;
 const viewRead=useSessionQuery({key:["arena",attempt],scopes:["execution","source","translation","resources","arena"],
  enabled:open&&!!attempt&&!busy,read:()=>owner.readView(attempt!)});
 const view=viewRead.data??null;
 const cancelUnresolved=Object.values(tasks.state).some(value=>(value.target.origin==="arena"||value.target.taskId===view?.detail.taskId)
  &&(value.phase==="preparing"||value.phase==="pending"||value.phase==="unknown"));
 const active=!!attempt&&(!view||view.detail.progress.queued>0||view.detail.progress.running>0),locked=disabled||busy||!!pending||active||cancelUnresolved;
 const readError=viewRead.error??comparisonRead.error??historyRead.error??pageRead.error??scopeRead.error??listRead.error;
 const displayedFailureValue=owner.failure??(readError?commandFailure(notice&&["saved","merged","selected","reconciled"].includes(notice)?{field:"arena-refresh"}:readError,"outcome-unknown"):null);
 const displayedFailure=failureReason(displayedFailureValue);
 useEffect(()=>{if(displayedFailure)errorRef.current?.focus();},[displayedFailure]);
 useEffect(()=>()=>leaveResolve.current?.(false),[]);
 function allowLeave(current:()=>boolean=()=>true):Promise<boolean>{leaveProof.current=current;if(cancelUnresolved){setOpen(true);return Promise.resolve(false);}if(owner.reserved()){setOpen(true);owner.reportFailure("outcome-unknown");return Promise.resolve(false);}if(!owner.current().dirty&&!owner.current().draft)return Promise.resolve(true);setOpen(true);setLeaving(true);return new Promise(resolve=>{leaveResolve.current?.(false);leaveResolve.current=resolve;});}
 function allowNavigate():Promise<boolean>{if(owner.reserved()||cancelUnresolved){setOpen(true);return Promise.resolve(false);}return Promise.resolve(true);}
 function settleLeave(value:boolean){if(value&&leaveProof.current&&!leaveProof.current())value=false;setLeaving(false);if(value&&!owner.reset())value=false;leaveResolve.current?.(value);leaveResolve.current=null;leaveProof.current=null;}
 useImperativeHandle(ref,()=>({allowLeave,allowNavigate,showAttempt(id){setOpen(true);if(!owner.showAttempt(id))owner.reportFailure("arena-draft");}}));
 function changed(next:ArenaConfig){owner.setConfig(next);}
 function variant<K extends keyof AiConfig>(slot:number,key:K,value:AiConfig[K]){changed({...config,variants:config.variants.map((v,i)=>i===slot?{...v,[key]:value}:v)});}
 async function refreshPage(cursor=after){setAfter(cursor);await Promise.all([scopeRead.refetch(),...(snapshot?[pageRead.refetch()]:[]),listRead.refetch()]);}
 async function loadHistory(id:string,afterOrdinal="0"){if(id!==unit){owner.setUnit(id);return;}if(afterOrdinal!=="0")await historyRead.fetchNextPage();else await historyRead.refetch();}
 async function refreshResult(){await Promise.all([...(attempt?[viewRead.refetch()]:[]),...(owner.comparisonId?[comparisonRead.refetch()]:[])]);}
 async function refreshReads(){await Promise.all([refreshPage(),refreshResult(),...(unit&&owner.targetAvailable?[historyRead.refetch()]:[])]);}
 const commandScope={projectId:project.metadata.projectId,sessionToken:project.sessionToken,area:"arena" as const};
 const unavailable:CommandAvailability={enabled:false,reason:"unavailable"};
 function gate(recovery=false):CommandAvailability {
  if(!open||leaving||reads.retired||!mounted.current)return{enabled:false,reason:"hidden"};
  const current=owner.current();
  if(current.busy)return{enabled:false,reason:"busy"};
  if(!recovery&&current.pending)return{enabled:false,reason:"pending-action"};
  if(!recovery&&(disabled||owner.reserved()))return unavailable;
  return{enabled:true};
 }
 function currentRead<T>(key:readonly unknown[]):T|undefined {
  const state=reads.client.getQueryState(reads.key(key));
  return state?.status==="success"&&state.fetchStatus==="idle"&&state.error===null&&!state.isInvalidated?reads.client.getQueryData<T>(reads.key(key)):undefined;
 }
 function currentView(){const id=owner.current().attempt;return id?currentRead<ArenaView>(["arena",id]):undefined;}
 function currentComparison(){const id=owner.current().comparisonId;return id?currentRead<ComparisonView>(["arena-comparison",id]):undefined;}
 function currentHistory(){const current=owner.current();return currentRead<NonNullable<typeof historyRead.data>>(["arena-history",current.unit,current.locale,current.sourceGeneration]);}
 function sourceReady(){const current=owner.current(),scope=currentRead<NonNullable<typeof scopeRead.data>>(["arena-source-scope",current.sourceGeneration]);
  return !!scope?.currentSnapshot&&!!currentRead(["arena-content",scope.currentSnapshot,after]);}
 function preparedSourceCurrent(){const current=owner.current(),scope=currentRead<NonNullable<typeof scopeRead.data>>(["arena-source-scope",current.sourceGeneration]);
  return !!scope?.currentSnapshot&&!!current.prepared&&current.prepared.preview.items.every(row=>row.item.sourceSnapshotId===scope.currentSnapshot);}
 function cancellationUnresolved(){const taskId=owner.current().started?.taskId??currentView()?.detail.taskId,own=taskId?tasks.current(taskId):undefined;
  return !!own&&["preparing","pending","unknown"].includes(own.phase)||Object.values(tasks.state).some(value=>{
   const current=tasks.current(value.target.taskId);return current&&(current.target.origin==="arena"||current.target.taskId===taskId)&&["preparing","pending","unknown"].includes(current.phase);
  });}
 function generationActive(){const current=owner.current(),value=currentView();return !!current.attempt&&(!value||value.detail.progress.queued>0||value.detail.progress.running>0);}
 function preparationPayload():ArenaPreparationCommandPayload {const current=owner.current();return{kind:"arena-preparation",editSeq:current.editSeq,locale:current.locale,unitIds:[...current.selected]};}
 function previewAvailability(payload?:ArenaPreparationCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const current=owner.current();
  return payload&&payload.editSeq===current.editSeq&&payload.locale===current.locale&&payload.unitIds.length===current.selected.length
   &&payload.unitIds.every((id,index)=>id===current.selected[index])&&owner.canPreview()&&!generationActive()&&!cancellationUnresolved()&&sourceReady()?{enabled:true}:unavailable;
 }
 function startPayload():ArenaStartCommandPayload|undefined {const current=owner.current();return current.prepared?{kind:"arena-start",attemptId:current.prepared.attemptId,editSeq:current.editSeq}:undefined;}
 function startAvailability(payload?:ArenaStartCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const current=owner.current();
  return payload&&payload.attemptId===current.prepared?.attemptId&&payload.editSeq===current.editSeq&&owner.canStart()
   &&!generationActive()&&!cancellationUnresolved()&&sourceReady()&&preparedSourceCurrent()?{enabled:true}:unavailable;
 }
 function translationPayload(value:ArenaView,row:ArenaView["rows"][number]):ArenaTranslationCommandPayload {
  return{kind:"arena-translation-target",attemptId:value.detail.attemptId,taskId:value.detail.taskId,itemId:row.itemId,translationUnitId:row.item.unitId,
   locale:row.item.targetLocale,sourceRevisionId:row.item.sourceRevisionId,sourceSnapshotId:row.item.sourceSnapshotId};
 }
 function targetRow(payload:ArenaTranslationCommandPayload|ArenaCandidateCommandPayload){const value=currentView();
  if(!value||value.detail.attemptId!==payload.attemptId||value.detail.taskId!==payload.taskId)return null;const row=value.rows.find(row=>row.itemId===payload.itemId);
  return row&&row.item.unitId===payload.translationUnitId&&row.item.targetLocale===payload.locale&&row.item.sourceRevisionId===payload.sourceRevisionId
   &&row.item.sourceSnapshotId===payload.sourceSnapshotId?{value,row}:null;
 }
 function candidatePayload(value:ArenaView,row:ArenaView["rows"][number]):ArenaCandidateCommandPayload|undefined {const unit=value.detail.recovery.units.find(unit=>unit.itemIds.includes(row.itemId));
  return row.resultId&&unit?{...translationPayload(value,row),kind:"arena-candidate",resultId:row.resultId,recoveryUnitId:unit.unitId}:undefined;}
 function adoptionAvailability(payload?:ArenaCandidateCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;if(!payload)return unavailable;const target=targetRow(payload);
  return target&&target.row.resultId===payload.resultId&&target.value.detail.recovery.units.some(unit=>unit.unitId===payload.recoveryUnitId
   &&unit.itemIds.includes(payload.itemId)&&unit.resultIds.includes(payload.resultId))&&!cancellationUnresolved()&&owner.canAdopt(target.value,payload.resultId)?{enabled:true}:unavailable;
 }
 function comparePayload():ArenaCompareCommandPayload {const current=owner.current();return{kind:"arena-compare",unitId:current.unit,locale:current.locale,revisionIds:[...current.references],blind:current.comparisonBlind,editSeq:current.editSeq};}
 function compareAvailability(payload?:ArenaCompareCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const current=owner.current(),history=currentHistory();
  return payload&&payload.unitId===current.unit&&payload.locale===current.locale&&payload.editSeq===current.editSeq&&payload.blind===current.comparisonBlind
   &&payload.revisionIds.length===current.references.length&&payload.revisionIds.every((id,index)=>id===current.references[index])&&owner.canCompare()
   &&history&&payload.revisionIds.every(id=>history.pages.some(page=>page.unitId===payload.unitId&&page.locale===payload.locale
    &&page.rows.some(row=>row.revisionId===id&&row.unitId===payload.unitId&&row.locale===payload.locale)))?{enabled:true}:unavailable;
 }
 function comparisonPayload(value:ComparisonView):ArenaComparisonCommandPayload {return{kind:"arena-comparison",comparisonId:value.comparisonId!,unitId:value.unitId,
  locale:value.locale,sourceRevisionId:value.sourceRevisionId,selectionId:value.selectionId,basis:value.basis};}
 function sameComparison(payload:ArenaComparisonCommandPayload|ArenaSelectionCommandPayload|ArenaMergeCommandPayload,value:Pick<ComparisonView,"comparisonId"|"unitId"|"locale"|"sourceRevisionId"|"selectionId"|"basis">){
  return payload.comparisonId===value.comparisonId&&payload.unitId===value.unitId&&payload.locale===value.locale&&payload.sourceRevisionId===value.sourceRevisionId
   &&payload.selectionId===value.selectionId&&payload.basis===value.basis;
 }
 function selectionPayload(value:ComparisonView,revisionId:string):ArenaSelectionCommandPayload{return{...comparisonPayload(value),kind:"arena-selection",revisionId};}
 function selectionAvailability(payload?:ArenaSelectionCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const value=currentComparison();
  return payload&&value&&sameComparison(payload,value)&&owner.canSelect(value,payload.revisionId)?{enabled:true}:unavailable;
 }
 function mergeBeginAvailability(payload?:ArenaComparisonCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const value=currentComparison();return payload&&value&&sameComparison(payload,value)&&owner.canBeginMerge(value)?{enabled:true}:unavailable;
 }
 function mergePayload():ArenaMergeCommandPayload|undefined {const draft=owner.current().draft;if(!draft)return undefined;const basis=draft.basis;
  return{kind:"arena-merge-draft",comparisonId:basis.comparisonId,unitId:basis.unitId,locale:basis.locale,sourceRevisionId:basis.sourceRevisionId,selectionId:basis.selectionId,basis:basis.basis,editSeq:draft.editSeq};}
 function mergeAvailability(payload?:ArenaMergeCommandPayload,action:"save"|"refresh"|"discard"="save"):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const draft=owner.current().draft;
  return payload&&draft&&payload.editSeq===draft.editSeq&&sameComparison(payload,draft.basis)
   &&(action==="save"?owner.canSaveMerge():action==="discard"||project.metadata.targetLocales.includes(draft.basis.locale))?{enabled:true}:unavailable;
 }
 function revealAvailability(payload?:ArenaRevealCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;if(!payload)return unavailable;const value=payload.targetKind==="attempt"?currentView():currentComparison();
  return value&&value.blind&&!value.revealed&&payload.targetId===("detail" in value?value.detail.attemptId:value.comparisonId)?{enabled:true}:unavailable;
 }
 function roundPayload(value:ArenaView):ArenaRoundCommandPayload{return{kind:"arena-round",attemptId:value.detail.attemptId,taskId:value.detail.taskId,editSeq:owner.current().editSeq};}
 function roundAvailability(payload?:ArenaRoundCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const value=currentView(),current=owner.current();
  return payload&&value&&payload.attemptId===value.detail.attemptId&&payload.taskId===value.detail.taskId&&payload.editSeq===current.editSeq
   &&!value.detail.progress.queued&&!value.detail.progress.running&&!current.draft&&!cancellationUnresolved()&&project.metadata.targetLocales.includes(value.rows[0].item.targetLocale)?{enabled:true}:unavailable;
 }
 function openComparisonPayload(value:ComparisonSummary):ArenaOpenComparisonCommandPayload{return{kind:"arena-open-comparison",...value};}
 function openComparisonAvailability(payload?:ArenaOpenComparisonCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const list=currentRead<ComparisonSummary[]>(["arena-comparisons"]);
  return payload&&!owner.current().draft&&list?.some(value=>value.comparisonId===payload.comparisonId&&value.locale===payload.locale&&value.nativeKey===payload.nativeKey)?{enabled:true}:unavailable;
 }
 function pendingPayload():ArenaPendingCommandPayload|undefined {const pending=owner.current().pending;if(!pending)return undefined;
  switch(pending.kind){
   case"start":return{kind:"arena-pending",pendingKind:"start",attemptId:pending.request.attemptId};
   case"compare":return{kind:"arena-pending",pendingKind:"compare",actionId:pending.request.actionId,unitId:pending.request.unitId,locale:pending.request.locale};
   case"reveal":return{kind:"arena-pending",pendingKind:"reveal",actionId:pending.request.actionId,targetKind:pending.targetKind,targetId:pending.request.comparisonId};
   case"select":case"merge":return{kind:"arena-pending",pendingKind:pending.kind,actionId:pending.request.actionId,unitId:pending.request.unitId,locale:pending.request.locale};
   case"adopt":return{kind:"arena-pending",pendingKind:"adopt",actionId:pending.request.actionId,attemptId:pending.request.attemptId,recoveryUnitId:pending.request.unitId,resultId:pending.candidate.resultId};
  }
 }
 function recoveryAvailability(payload?:ArenaPendingCommandPayload,retry=false):CommandAvailability {
  const allowed=gate(true);if(!allowed.enabled)return allowed;const pending=owner.current().pending,current=pendingPayload();
  if(!pending?.uncertain||!payload||!current||payload.pendingKind!==current.pendingKind||retry&&!pending.retryAllowed&&pending.kind!=="start"&&pending.kind!=="compare")return unavailable;
  switch(payload.pendingKind){
   case"start":return current.pendingKind==="start"&&payload.attemptId===current.attemptId?{enabled:true}:unavailable;
   case"compare":case"select":case"merge":return(current.pendingKind==="compare"||current.pendingKind==="select"||current.pendingKind==="merge")
    &&payload.actionId===current.actionId&&payload.unitId===current.unitId&&payload.locale===current.locale?{enabled:true}:unavailable;
   case"reveal":return current.pendingKind==="reveal"&&payload.actionId===current.actionId&&payload.targetId===current.targetId&&payload.targetKind===current.targetKind?{enabled:true}:unavailable;
   case"adopt":return current.pendingKind==="adopt"&&payload.actionId===current.actionId&&payload.attemptId===current.attemptId
    &&payload.recoveryUnitId===current.recoveryUnitId&&payload.resultId===current.resultId?{enabled:true}:unavailable;
  }
 }
 function cancellationPayload(value:ArenaView):ExecutionCancellationCommandPayload{return{kind:"execution-cancellation",taskId:value.detail.taskId,attemptId:value.detail.attemptId,origin:"arena"};}
 function cancellationAvailability(payload?:ExecutionCancellationCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;const current=owner.current();if(!current.attempt)return unavailable;
  const key=reads.key(["arena",current.attempt]),query=reads.client.getQueryState(key),value=reads.client.getQueryData<ArenaView>(key),original=current.started;
  // A later read failure does not revoke cancellation of the original checked Task.
  // A successful retained projection supplies its identity; fresh writes use currentRead instead.
  return payload?.origin==="arena"&&query&&query.dataUpdateCount>0&&value&&value.detail.attemptId===current.attempt
   &&value.detail.recovery.attemptId===current.attempt&&value.detail.operation==="arena-translation"&&(!original?.taskId||original.taskId===value.detail.taskId)
   &&payload.taskId===value.detail.taskId&&payload.attemptId===value.detail.attemptId&&(value.detail.progress.queued>0||value.detail.progress.running>0)&&tasks.canCancel(payload)?{enabled:true}:unavailable;
 }
 function cancellationRetryAvailability(payload?:ExecutionCancellationRetryCommandPayload):CommandAvailability {
  const allowed=gate(true);if(!allowed.enabled)return allowed;const original=payload&&tasks.current(payload.taskId),activity=tasks.currentActivity();
  if(activity&&activity.intent.taskId===payload?.taskId&&["capturing","identifying","preparing","adopting","recovering","checking","unknown"].includes(activity.phase))return unavailable;
  return original?.phase==="unknown"&&payload&&original.target.attemptId===payload.attemptId&&original.target.origin===payload.origin&&original.request.requestId===payload.requestId?{enabled:true}:unavailable;
 }
 function translationAvailability(payload?:ArenaTranslationCommandPayload):CommandAvailability {
  const allowed=gate();if(!allowed.enabled)return allowed;return payload&&project.metadata.targetLocales.includes(payload.locale)&&targetRow(payload)?{enabled:true}:unavailable;
 }
 async function openTranslation(payload:ArenaTranslationCommandPayload){
  const target=targetRow(payload),before=owner.current(),ticket=navigationGeneration.current;
  const query=reads.client.getQueryCache().find({queryKey:reads.key(["arena",payload.attemptId]),exact:true}),count=query?.state.dataUpdateCount;
  if(!target||!translationAvailability(payload).enabled||!query)return;
  const currentProof=()=>mounted.current&&!reads.retired&&!disabled&&navigationGeneration.current===ticket&&owner.current().editSeq===before.editSeq
   &&project.metadata.targetLocales.includes(payload.locale)&&targetRow(payload)?.value===target.value
   &&reads.client.getQueryCache().find({queryKey:query.queryKey,exact:true})===query&&query.state.data===target.value&&query.state.dataUpdateCount===count;
  if(!await allowLeave(currentProof))return;
  const current=owner.current(),deliberateReset=current.editSeq===before.editSeq+1&&!current.dirty&&!current.draft&&current.attempt===null;
  // A confirmed discard resets the setup. Its fixed editor destination remains the one the user checked.
  if(!mounted.current||reads.retired||disabled||navigationGeneration.current!==ticket||!project.metadata.targetLocales.includes(payload.locale)
   ||(!deliberateReset&&!currentProof())||reads.client.getQueryCache().find({queryKey:query.queryKey,exact:true})!==query
   ||query.state.status!=="success"||query.state.error!==null||query.state.data!==target.value||query.state.dataUpdateCount!==count)return;
  await onOpenTranslation(aiTarget(target.row.item),payload.locale);
 }
 useLayoutEffect(()=>{
  const metadata={category:"arena" as const,scope:commandScope,binding:null,confirmation:"none" as const};
  const remove=[
   registry.register({...metadata,id:"arena.preview",nameKey:"ai.preview",risk:"captures-arena",payloadKind:"arena-preparation",availability:previewAvailability,handler:()=>{void owner.preview();}}),
   registry.register({...metadata,id:"arena.start",nameKey:"ai.generate",risk:"runs-arena",confirmation:"required",payloadKind:"arena-start",availability:startAvailability,handler:()=>{void owner.start();}}),
   registry.register({...metadata,id:"arena.adopt-result",nameKey:"ai.saveCandidate",risk:"writes-translation",payloadKind:"arena-candidate",availability:adoptionAvailability,handler:payload=>{const target=targetRow(payload);if(target)void owner.adopt(target.value,payload.resultId);}}),
   registry.register({...metadata,id:"arena.create-comparison",nameKey:"arena.compare",risk:"captures-arena",payloadKind:"arena-compare",availability:compareAvailability,handler:()=>{void owner.compare();}}),
   registry.register({...metadata,id:"arena.reveal-identities",nameKey:"arena.reveal",risk:"writes-arena",payloadKind:"arena-reveal",availability:revealAvailability,handler:payload=>{void owner.reveal(payload.targetId,payload.targetKind);}}),
   registry.register({...metadata,id:"arena.select-candidate",nameKey:"arena.use",risk:"writes-translation",payloadKind:"arena-selection",availability:selectionAvailability,handler:payload=>{const value=currentComparison();if(value)void owner.select(value,payload.revisionId);}}),
   registry.register({...metadata,id:"arena.begin-merge",nameKey:"arena.manualMerge",risk:"writes-arena",payloadKind:"arena-comparison",availability:mergeBeginAvailability,handler:()=>{const value=currentComparison();if(value)owner.beginMerge(value);}}),
   registry.register({...metadata,id:"arena.save-merge",nameKey:"arena.saveMerge",risk:"writes-translation",payloadKind:"arena-merge-draft",availability:payload=>mergeAvailability(payload),handler:()=>{void owner.saveMerge();}}),
   registry.register({...metadata,id:"arena.refresh-merge-basis",nameKey:"arena.refreshBasis",risk:"reads-arena",payloadKind:"arena-merge-draft",availability:payload=>mergeAvailability(payload,"refresh"),handler:()=>{void owner.refreshMerge();}}),
   registry.register({...metadata,id:"arena.discard-merge",nameKey:"arena.discardMerge",risk:"discards-arena-draft",payloadKind:"arena-merge-draft",availability:payload=>mergeAvailability(payload,"discard"),handler:()=>{owner.discardMerge();}}),
   registry.register({...metadata,id:"arena.new-round",nameKey:"arena.newRound",risk:"captures-arena",payloadKind:"arena-round",availability:roundAvailability,handler:()=>{const value=currentView();if(value)void owner.newRound(value);}}),
   registry.register({...metadata,id:"arena.open-comparison",nameKey:"arena.reopen",risk:"reads-arena",payloadKind:"arena-open-comparison",availability:openComparisonAvailability,handler:payload=>{owner.openComparison(payload.comparisonId);}}),
   registry.register({...metadata,id:"arena.reconcile-pending",nameKey:"ai.reconcile",risk:"reconciles-execution-action",payloadKind:"arena-pending",availability:recoveryAvailability,handler:()=>{void owner.checkPending();}}),
   registry.register({...metadata,id:"arena.retry-pending",nameKey:"ai.retrySame",risk:"retries-execution-action",payloadKind:"arena-pending",availability:payload=>recoveryAvailability(payload,true),handler:()=>{void owner.retryPending();}}),
   registry.register({...metadata,id:"arena.cancel-task",nameKey:"ai.cancel",risk:"cancels-execution-task",payloadKind:"execution-cancellation",availability:cancellationAvailability,handler:({taskId,attemptId,origin})=>{void tasks.cancel({taskId,attemptId,origin});}}),
   registry.register({...metadata,id:"arena.retry-cancellation",nameKey:"execution.retryCancellation",risk:"retries-execution-action",payloadKind:"execution-cancellation-retry",availability:cancellationRetryAvailability,handler:payload=>{void tasks.retry(payload.taskId);}}),
   registry.register({...metadata,id:"arena.open-translation",nameKey:"ai.openEditor",risk:"opens-translation",payloadKind:"arena-translation-target",availability:translationAvailability,handler:payload=>{void openTranslation(payload);}}),
  ];return()=>remove.forEach(dispose=>dispose());
 });
 const fields=[['endpoint','url'],['model','text'],['credentialEnv','text']] as const,numeric=[['maxOutputTokens',1,16384],['maxRetries',0,2],['timeoutSeconds',1,120]] as const;
 return <><WorkbenchPanel open={open} title={t("arena.title")} description={t("arena.description")} className="arena-dialog" onBack={()=>void allowLeave().then(ok=>{if(ok)setOpen(false);})} backDisabled={disabled || busy || !!pending || cancelUnresolved}>
 {onReturn ? <button className="secondary-button" disabled={busy || !!pending || !!draft || cancelUnresolved} onClick={onReturn}>{t("arena.returnToEntry")}</button> : null}
 <TaskCancellationFeedback origin="arena" taskId={view?.detail.taskId} disabled={busy} visible={open} retryCommand={{available:intent=>cancellationRetryAvailability({...intent,kind:"execution-cancellation-retry"}).enabled,dispatch:intent=>{registry.dispatch("arena.retry-cancellation",commandScope,{...intent,kind:"execution-cancellation-retry"});}}} />
 {open&&(scopeRead.isFetching||pageRead.isFetching||listRead.isFetching||historyRead.isFetching||comparisonRead.isFetching||viewRead.isFetching)?<p role="status">{t("ai.readLoading")}</p>:null}
 {displayedFailure?<div role="alert" tabIndex={-1} ref={errorRef}><p>{t(`arena.errors.${displayedFailure}`,{defaultValue:t(`ai.errors.${displayedFailure}`,{defaultValue:t("arena.errors.failed")})})}</p><CommandFailureDetails failure={displayedFailureValue} /><button disabled={busy||!!pending} onClick={()=>void refreshReads()}>{t("ai.refresh")}</button></div>:null}
 {notice?<p role="status">{t(`arena.${notice}`,{defaultValue:t("arena.reconciled")})}</p>:null}
 {prepared&&snapshot&&prepared.preview.items.some(row=>row.item.sourceSnapshotId!==snapshot)?<p role="status">{t("arena.sourceStale")}</p>:null}
 {!owner.targetAvailable?<p role="status">{t("arena.removedLocale",{locale})}</p>:null}{owner.staleReason&&owner.staleReason!=="connection"?<p role="status">{t("arena.sourceStale")} <button disabled={busy||!!pending} onClick={()=>owner.clearSelectedRange()}>{t("arena.clearRange")}</button></p>:null}<details open={!attempt&&!fromEntry}><summary>{t("arena.generation")}</summary><fieldset disabled={locked||!owner.targetAvailable}><legend>{t("arena.schemes")}</legend>
 {config.variants.map((v,slot)=><section key={slot} className="arena-scheme">
   <h3>{t("arena.scheme",{defaultValue:enUS.arena.scheme,number:slot+1})}</h3>
   <ModelConnectionPicker config={v} label={t("connections.chooseScheme",{defaultValue:enUS.connections.chooseScheme,number:slot+1})} active={open} disabled={locked} editSeq={owner.editSeq}
     onSelect={(view,id,seq)=>owner.selectConnection(slot,view,id,seq)} onOpenSettings={onOpenConnections}/>
   <PreparationBudgetSummary config={v} perRequest/>
   <details open={displayedFailure==="arena-limits"||["ai-endpoint","ai-model","ai-credential","ai-token-field"].includes(displayedFailure??"")?true:undefined}>
     <summary>{t("connections.advancedScheme",{defaultValue:enUS.connections.advancedScheme,number:slot+1})}</summary>
     {fields.map(([key,type])=><label className="field" key={key}>{t(`ai.${key}`)}<input type={type} value={v[key]} aria-label={t("arena.schemeField",{defaultValue:enUS.arena.schemeField,number:slot+1,field:t(`ai.${key}`)})} onChange={e=>variant(slot,key,e.target.value)}/></label>)}
     <p>{t("ai.credentialHelp")}</p><label className="field">{t("ai.tokenField")}<select value={v.tokenField} onChange={e=>variant(slot,"tokenField",e.target.value)}><option>max_tokens</option><option>max_completion_tokens</option></select></label>
     {numeric.filter(([key])=>key==="maxOutputTokens"||key==="maxRetries"||key==="timeoutSeconds").map(([key,min,max])=><label className="field" key={key}>{t(`ai.${key}`)}<input type="number" min={min} max={max} value={Number.isFinite(v[key])?v[key]:""} onChange={e=>variant(slot,key,e.target.valueAsNumber)}/></label>)}
     <SourceContextChoice value={v.sourceContext} onChange={value=>variant(slot,"sourceContext",value)}/>
     <label><input type="checkbox" checked={v.shareTerms} onChange={e=>variant(slot,"shareTerms",e.target.checked)}/>{t("ai.shareTerms")}</label><label><input type="checkbox" checked={v.shareContext} onChange={e=>variant(slot,"shareContext",e.target.checked)}/>{t("ai.shareContext")}</label>
   </details>
 </section>)}
 <button disabled={config.variants.length>=4} onClick={()=>changed({...config,variants:[...config.variants,{...defaultAiConfig}]})}>{t("arena.addScheme")}</button><button disabled={config.variants.length<=2} onClick={()=>changed({...config,variants:config.variants.slice(0,-1)})}>{t("arena.removeScheme")}</button>
 <p>{t("connections.arenaBudgetSummary",{defaultValue:enUS.connections.arenaBudgetSummary,items:config.maxItems,requests:config.maxRequests,concurrency:config.concurrency})}</p><details open={displayedFailure==="arena-limits"?true:undefined}><summary>{t("arena.sharedBudget")}</summary>{([['maxItems',1,100],['maxRequests',1,300],['concurrency',1,2]] as const).map(([key,min,max])=><label className="field" key={key}>{t(`ai.${key}`)}<input type="number" min={min} max={max} value={Number.isFinite(config[key])?config[key]:""} onChange={e=>changed({...config,[key]:e.target.valueAsNumber})}/></label>)}
 </details>
 <label className="field">{t("ai.locale")}<select value={locale} onChange={e=>{owner.setLocale(e.target.value);}} disabled={!!draft}>{!owner.targetAvailable?<option value={locale} disabled>{t("arena.removedLocale",{locale})}</option>:null}{project.metadata.targetLocales.map(l=><option key={l}>{l}</option>)}</select></label><label><input type="checkbox" checked={config.blind} onChange={e=>changed({...config,blind:e.target.checked})}/>{t("arena.blind")}</label>
 <h3>{t("ai.scope",{count:selected.length})}</h3>{page?<ul>{page.rows.map(row=>row.unitId?<li key={row.unitId}><label><input type="checkbox" checked={selected.includes(row.unitId)} onChange={e=>{owner.setSelected(old=>e.target.checked?[...old,row.unitId!]:old.filter(id=>id!==row.unitId));}}/>{row.occurrence.key}: {row.occurrence.text}</label></li>:null)}</ul>:<p>{t("ai.noSource")}</p>}<button onClick={()=>void refreshPage(0)}>{t("ai.first")}</button>{page?.nextOrdinal!=null?<button onClick={()=>void refreshPage(page.nextOrdinal!)}>{t("ai.next")}</button>:null}
 <button className="primary-button" disabled={!previewAvailability(preparationPayload()).enabled} onClick={()=>{registry.dispatch("arena.preview",commandScope,preparationPayload());}}>{t("ai.preview")}</button></fieldset></details>
 {prepared?<section><h3>{t("ai.previewTitle")}</h3><p>{t("arena.expanded",{defaultValue:enUS.arena.expanded,count:prepared.preview.items.length,requests:prepared.preview.config.maxRequests,concurrency:prepared.preview.config.concurrency})}</p><p>{t("ai.costUnknown")}</p><p>{t("ai.rateLimit")}</p>{prepared.preview.items.map(({slot,sourceOrder,item})=><article key={`${sourceOrder}:${slot}`}><h4>{t("arena.scheme",{defaultValue:enUS.arena.scheme,number:slot+1})} · {item.nativeKey} → {item.targetLocale}</h4><p>{prepared.preview.config.variants[slot].endpoint} · {prepared.preview.config.variants[slot].model} · direct-translation-1</p><p>{t("connections.requestSummary",{tokens:prepared.preview.config.variants[slot].maxOutputTokens,retries:prepared.preview.config.variants[slot].maxRetries,timeout:prepared.preview.config.variants[slot].timeoutSeconds,defaultValue:enUS.connections.requestSummary})}</p><pre className="ai-text">{item.sourceText}</pre>{item.terms.map(term=><p key={term.revisionId}>{term.source} → {term.target}</p>)}{item.context?<pre className="ai-text">{item.context.text}</pre>:null}<SourceContextPreview capture={item.sourceContext}/>{item.omissions.map(reason=><p key={reason}>{reason.startsWith("term-conflict:")?t("ai.termConflict",{term:reason.slice(14)}):t(`ai.${reason}`,{defaultValue:reason})}</p>)}</article>)}{config.parentAttemptId?<p>{t("arena.repeatCost")}</p>:null}<label><input type="checkbox" disabled={locked||!owner.connectionCurrent()} checked={consent} onChange={e=>owner.setConsent(e.target.checked)}/>{t("arena.consent")}</label><button className="primary-button" disabled={!startAvailability(startPayload()).enabled} onClick={()=>{const payload=startPayload();if(payload)registry.dispatch("arena.start",commandScope,payload);}}>{t("ai.generate")}</button></section>:null}
 {pending?<section role="status"><p>{t("arena.uncertain")}</p><button disabled={!recoveryAvailability(pendingPayload()).enabled} onClick={()=>{const payload=pendingPayload();if(payload)registry.dispatch("arena.reconcile-pending",commandScope,payload);}}>{t("ai.reconcile")}</button>{pending.retryAllowed||pending.kind==="start"||pending.kind==="compare"?<button disabled={!recoveryAvailability(pendingPayload(),true).enabled} onClick={()=>{const payload=pendingPayload();if(payload)registry.dispatch("arena.retry-pending",commandScope,payload);}}>{t("ai.retrySame")}</button>:null}</section>:null}
 {view?<section><h3>{t("ai.results")}</h3><p>{t("ai.progress",{...view.detail.progress,defaultValue:enUS.ai.progress})}</p>{view.budget?<><p>{t("ai.budgetSummary",{...view.budget,defaultValue:enUS.ai.budgetSummary})}</p><p>{t("ai.budgetUsage",{...view.budget,defaultValue:enUS.ai.budgetUsage})}</p>{view.budget.legacyHeld>0?<p>{t("ai.legacyBudget",{count:view.budget.legacyHeld,defaultValue:enUS.ai.legacyBudget})}</p>:null}</>:null}{view.differentInputs?<p>{t("arena.differentInputs")}</p>:null}{view.repeatedSampling?<p>{t("arena.repeatedSampling")}</p>:null}<p>{t("arena.usageSummary",{defaultValue:enUS.arena.usageSummary,input:view.rows.reduce((n,r)=>n+BigInt(r.output?.usage?.promptTokens??"0"),0n).toString(),output:view.rows.reduce((n,r)=>n+BigInt(r.output?.usage?.completionTokens??"0"),0n).toString()})} · {view.rows.some(r=>!r.output?.usage||r.output.usageIncomplete)?t("ai.usageUnknown"):t("arena.reportedOnly")}</p>
 <button disabled={busy||!!pending} onClick={()=>void refreshResult()}>{t("ai.refresh")}</button>{active?<button disabled={!cancellationAvailability(cancellationPayload(view)).enabled} onClick={()=>{registry.dispatch("arena.cancel-task",commandScope,cancellationPayload(view));}}>{t("ai.cancel")}</button>:<button disabled={!roundAvailability(roundPayload(view)).enabled} onClick={()=>{registry.dispatch("arena.new-round",commandScope,roundPayload(view));}}>{t("arena.newRound")}</button>}
 {view.blind&&!view.revealed?<button disabled={!revealAvailability({kind:"arena-reveal",targetKind:"attempt",targetId:view.detail.attemptId}).enabled} onClick={()=>{registry.dispatch("arena.reveal-identities",commandScope,{kind:"arena-reveal",targetKind:"attempt",targetId:view.detail.attemptId});}}>{t("arena.reveal")}</button>:null}
 {[...new Set(view.rows.map(r=>r.sourceOrder))].map(order=><section key={order}><h4>{view.rows.find(r=>r.sourceOrder===order)?.item.nativeKey}</h4><pre className="ai-text">{view.rows.find(r=>r.sourceOrder===order)?.item.sourceText}</pre><div className="arena-columns">{view.rows.filter(r=>r.sourceOrder===order).map(row=>{const status=view.detail.items.find(i=>i.status.itemId===row.itemId)?.status;return <article key={row.itemId}><h5>{t("arena.candidate",{defaultValue:enUS.arena.candidate,label:letter(row.label)})}</h5>{view.variants?<p>{view.variants[row.label].model} · direct-translation-1</p>:null}<p>{t(`ai.states.${status?.execution}`,{defaultValue:status?.execution??""})}</p>{status?.diagnostic?<p>{t(`ai.errors.${status.diagnostic}`,{defaultValue:t("arena.errors.failed")})}</p>:null}{row.output?<><pre className="ai-text">{row.output.text}</pre><p>{row.output.usage?t("ai.usage",{...row.output.usage,defaultValue:enUS.ai.usage}):t("ai.usageUnknown")}</p><button disabled={!adoptionAvailability(candidatePayload(view,row)).enabled} onClick={()=>{const payload=candidatePayload(view,row);if(payload)registry.dispatch("arena.adopt-result",commandScope,payload);}}>{status?.adoption==="committed"||!!owner.saved[row.resultId!]?t("ai.saved"):t("ai.saveCandidate")}</button></>:null}</article>;})}</div><button disabled={!translationAvailability(translationPayload(view,view.rows.find(r=>r.sourceOrder===order)!)).enabled} onClick={()=>{registry.dispatch("arena.open-translation",commandScope,translationPayload(view,view.rows.find(r=>r.sourceOrder===order)!));}}>{t("ai.openEditor")}</button></section>)}<p>{t("ai.noAutomaticRetry")}</p></section>:null}
 <section><h3 ref={comparisonHeading} tabIndex={-1}>{t("arena.savedComparison")}</h3><p>{t("arena.offline")}</p>{fromEntry && comparisonEntry && references.includes(comparisonEntry.revisionId) && !history?.rows.some(row=>row.revisionId===comparisonEntry.revisionId) ? <p role="status">{t("arena.locateRevision",{number:comparisonEntry.revisionOrdinal})}</p> : null}<label className="field">{t("arena.original")}<select value={unit} disabled={busy||!!pending||!!draft} onChange={e=>void loadHistory(e.target.value)}><option value="">{t("arena.chooseOriginal")}</option>{fromEntry && comparisonEntry && !page?.rows.some(row=>row.unitId===unit) ? <option value={unit}>{comparisonEntry.key}</option> : null}{page?.rows.map(row=>row.unitId?<option key={row.unitId} value={row.unitId}>{row.occurrence.key}</option>:null)}</select></label><label className="field">{t("ai.locale")}<select value={locale} disabled={busy||!!pending||!!draft||active||!!prepared} onChange={e=>owner.setLocale(e.target.value)}>{!owner.targetAvailable?<option value={locale} disabled>{t("arena.removedLocale",{locale})}</option>:null}{project.metadata.targetLocales.map(l=><option key={l}>{l}</option>)}</select></label><button disabled={busy||!!pending||!unit||!!draft} onClick={()=>void loadHistory(unit)}>{t("arena.loadCandidates")}</button>
 {history?<><p>{t("arena.chooseCandidates")}</p>{history.rows.map(row=><label className="arena-history" key={row.revisionId}><input type="checkbox" disabled={busy||!!pending||!!draft||(!references.includes(row.revisionId)&&references.length>=4)} checked={references.includes(row.revisionId)} onChange={e=>{owner.setReferences(old=>e.target.checked?[...old,row.revisionId]:old.filter(id=>id!==row.revisionId));}}/><span>{row.candidateDecision ? <strong>{t(row.candidateDecision.request.disposition === "rejected" ? "candidateDecisions.rejected" : "candidateDecisions.restored")} · </strong> : null}{t("arena.revision",{defaultValue:enUS.arena.revision,number:row.ordinal})} · {row.text}</span></label>)}{history.nextOrdinal!=null?<button disabled={busy||!!pending||!!draft} onClick={()=>void loadHistory(unit,history.nextOrdinal!)}>{t("arena.moreCandidates")}</button>:null}<label><input type="checkbox" disabled={busy||!!pending||!!draft} checked={comparisonBlind} onChange={e=>{owner.setComparisonBlind(e.target.checked);}}/>{t("arena.blind")}</label><button disabled={!compareAvailability(comparePayload()).enabled} onClick={()=>{registry.dispatch("arena.create-comparison",commandScope,comparePayload());}}>{t("arena.compare")}</button></>:null}
 {savedComparisons.map(c=><button key={c.comparisonId} disabled={!openComparisonAvailability(openComparisonPayload(c)).enabled} onClick={()=>{registry.dispatch("arena.open-comparison",commandScope,openComparisonPayload(c));}}>{t("arena.reopen",{defaultValue:enUS.arena.reopen,name:c.nativeKey,locale:c.locale})}</button>)}
 {comparison?<section><h4>{comparison.nativeKey} → {comparison.locale}</h4><pre className="ai-text">{comparison.sourceText}</pre><p>{t("arena.current",{defaultValue:enUS.arena.current,text:comparison.selectedText??t("translation.noSelection")})}</p><p>{t("arena.historical")}</p><p>{t("arena.rejectionHelp")}</p>{comparison.blind&&!comparison.revealed?<button disabled={!revealAvailability({kind:"arena-reveal",targetKind:"comparison",targetId:comparison.comparisonId!}).enabled} onClick={()=>{registry.dispatch("arena.reveal-identities",commandScope,{kind:"arena-reveal",targetKind:"comparison",targetId:comparison.comparisonId!});}}>{t("arena.reveal")}</button>:null}<div className="arena-columns">{comparison.rows.map((row,i)=><article key={row.revisionId}><h5>{t("arena.candidate",{defaultValue:enUS.arena.candidate,label:letter(i)})}</h5><pre className="ai-text">{row.text}</pre><p>{row.basisCurrent?t("arena.currentBasis"):t("arena.oldBasis")}</p>{row.candidateDisposition ? <p role="status">{t(row.candidateDisposition === "rejected" ? "candidateDecisions.rejected" : "candidateDecisions.restored")}</p> : null}{comparison.revealed?<p>{row.model??(row.originKind==="ai"?t("ai.origin"):row.originKind==="manual"?t("translation.manualOrigin"):t("translation.importOrigin",{file:""}))} {row.recipe??""}</p>:null}<button disabled={!selectionAvailability(selectionPayload(comparison,row.revisionId)).enabled} onClick={()=>{registry.dispatch("arena.select-candidate",commandScope,selectionPayload(comparison,row.revisionId));}}>{t("arena.use")}</button></article>)}</div><button disabled={!mergeBeginAvailability(comparisonPayload(comparison)).enabled} onClick={()=>{registry.dispatch("arena.begin-merge",commandScope,comparisonPayload(comparison));}}>{t("arena.manualMerge")}</button><button disabled={busy||!!pending} onClick={()=>void refreshResult()}>{t("ai.refresh")}</button></section>:null}
 {draft?<section><h3>{t("arena.manualMerge")}</h3><p>{t("arena.mergeHelp")}</p><p>{t("arena.mergeDecisionHelp")}</p>{draft.stale||!owner.mergeBasisCurrent(draft.basis)?<p role="status">{t("arena.staleMerge")}</p>:null}<label className="field">{t("arena.mergedText")}<textarea value={draft.text} onChange={e=>owner.editMerge(e.target.value)}/></label><button className="primary-button" disabled={!mergeAvailability(mergePayload()).enabled} onClick={()=>{const payload=mergePayload();if(payload)registry.dispatch("arena.save-merge",commandScope,payload);}}>{t("arena.saveMerge")}</button><button disabled={!mergeAvailability(mergePayload(),"refresh").enabled} onClick={()=>{const payload=mergePayload();if(payload)registry.dispatch("arena.refresh-merge-basis",commandScope,payload);}}>{t("arena.refreshBasis")}</button><button disabled={!mergeAvailability(mergePayload(),"discard").enabled} onClick={()=>{const payload=mergePayload();if(payload)registry.dispatch("arena.discard-merge",commandScope,payload);}}>{t("arena.discardMerge")}</button></section>:null}</section>
 </WorkbenchPanel>
 <Dialog.Root open={leaving} onOpenChange={next=>{if(!next)settleLeave(false);}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop"/><Dialog.Content className="confirm-dialog execution-confirm-dialog"><Dialog.Title>{t("arena.unsaved")}</Dialog.Title><Dialog.Description>{t("arena.unsavedHelp")}</Dialog.Description><button onClick={()=>settleLeave(false)}>{t("ai.stay")}</button><button onClick={()=>settleLeave(true)}>{t("ai.discard")}</button></Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
