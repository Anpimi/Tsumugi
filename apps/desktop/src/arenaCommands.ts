import {checkedInvoke} from "./ipc";
import {defaultAiConfig} from "./aiCommands";
import type {ArenaConfig,PreviewRequest,StartRequest,ReadRequest,ComparisonCommand,ComparisonRead,SessionRequest,RevealRequest,MergeRequest} from "./generated/arena.requests";
import * as validators from "./generated/arena.validators";
export type {ArenaConfig,ComparisonCommand as CompareRequest,MergeRequest} from "./generated/arena.requests";
export type {Prepared as ArenaPrepared,View as ArenaView,ComparisonEntry,ComparisonView,ComparisonSummary} from "./generated/arena.responses";
export const defaultArenaConfig=():Required<ArenaConfig>=>({variants:[{...defaultAiConfig},{...defaultAiConfig}],maxItems:20,maxRequests:40,concurrency:1,blind:false,parentAttemptId:null});
function requireConfirmation(condition:boolean):asserts condition{if(!condition)throw new Error("Invalid IPC acknowledgement: Arena action");}
/** Recovered comparison reads project current source and selection; only creation fields bind the original request. */
export function confirmArenaComparison(request:ComparisonCommand,value:unknown){
 requireConfirmation(validators.validateResponseComparison(value));
 requireConfirmation(value.comparisonId===request.actionId&&value.unitId===request.unitId&&value.locale===request.locale&&value.blind===request.blind
  &&value.rows.length===request.revisionIds.length&&new Set(value.rows.map(row=>row.revisionId)).size===request.revisionIds.length
  &&value.rows.every(row=>request.revisionIds.includes(row.revisionId)));
 return value;
}
/** Core binds text and contributors through the complete original request digest. The wire receipt contains a selection. */
export function confirmArenaMerge(request:MergeRequest,value:unknown){
 requireConfirmation(validators.validateResponseSelection(value));
 requireConfirmation(value.actionId===request.actionId&&value.unitId===request.unitId&&value.locale===request.locale
  &&value.previousEventId===(request.expectedSelectionId??null)&&BigInt(value.sequence)>0n&&(value.sequence==="1")===(value.previousEventId===null));
 return value;
}
export const arenaCommands={
 preview:(request:PreviewRequest)=>checkedInvoke("preview_arena_translation",request,validators.validateResponsePrepared),
 start:async(request:StartRequest)=>{
  const result=await checkedInvoke("start_arena_translation",request,validators.validateResponseIdentity);
  requireConfirmation(result===request.attemptId);return result;
 },
 startAction:async(request:StartRequest)=>{
  const result=await checkedInvoke("read_arena_start_action",request,validators.validateResponseStartAction);
  requireConfirmation(result===null||(result.projectId===request.projectId&&result.attemptId===request.attemptId&&result.digest===request.digest));
  return result;
 },
 read:async(request:ReadRequest)=>{
  const result=await checkedInvoke("read_arena_translation",request,validators.validateResponseView);
  requireConfirmation(result.detail.attemptId===request.attemptId&&result.rows.every(row=>!row.output||(row.output.unitId===row.item.unitId&&row.output.targetLocale===row.item.targetLocale)));return result;
 },
 compare:async(request:ComparisonCommand)=>{
  const result=await checkedInvoke("create_arena_comparison",request,validators.validateResponseComparison);
  return confirmArenaComparison(request,result);
 },
 comparison:async(request:ComparisonRead)=>{
  const result=await checkedInvoke("read_arena_comparison",request,validators.validateResponseComparison);
  requireConfirmation(result.comparisonId===request.comparisonId);return result;
 },
 comparisons:(request:SessionRequest)=>checkedInvoke("list_arena_comparisons",request,validators.validateResponseComparisons),
 reveal:async(request:RevealRequest)=>{await checkedInvoke("reveal_arena_identity",request,validators.validateResponseReveal);},
 merge:async(request:MergeRequest)=>{
  const result=await checkedInvoke("save_arena_merge",request,validators.validateResponseSelection);
  return confirmArenaMerge(request,result);
 },
};
