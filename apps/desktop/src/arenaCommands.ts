import {checkedInvoke} from "./ipc";
import {defaultAiConfig} from "./aiCommands";
import type {ArenaConfig,PreviewRequest,StartRequest,ReadRequest,ComparisonCommand,ComparisonRead,SessionRequest,RevealRequest,MergeRequest} from "./generated/arena.requests";
import * as validators from "./generated/arena.validators";
export type {ArenaConfig,ComparisonCommand as CompareRequest,MergeRequest} from "./generated/arena.requests";
export type {Prepared as ArenaPrepared,View as ArenaView,ComparisonEntry,ComparisonView,ComparisonSummary} from "./generated/arena.responses";
export const defaultArenaConfig=():Required<ArenaConfig>=>({variants:[{...defaultAiConfig},{...defaultAiConfig}],maxItems:20,maxRequests:40,concurrency:1,blind:false,parentAttemptId:null});
function requireConfirmation(condition:boolean):asserts condition{if(!condition)throw new Error("Invalid IPC acknowledgement: Arena action");}
export const arenaCommands={
 preview:(request:PreviewRequest)=>checkedInvoke("preview_arena_translation",request,validators.validateResponsePrepared),
 start:async(request:StartRequest)=>{
  const result=await checkedInvoke("start_arena_translation",request,validators.validateResponseIdentity);
  requireConfirmation(result===request.attemptId);return result;
 },
 read:async(request:ReadRequest)=>{
  const result=await checkedInvoke("read_arena_translation",request,validators.validateResponseView);
  requireConfirmation(result.detail.attemptId===request.attemptId&&result.rows.every(row=>!row.output||(row.output.unitId===row.item.unitId&&row.output.targetLocale===row.item.targetLocale)));return result;
 },
 compare:async(request:ComparisonCommand)=>{
  const result=await checkedInvoke("create_arena_comparison",request,validators.validateResponseComparison);
  requireConfirmation(result.comparisonId===request.actionId&&result.unitId===request.unitId&&result.locale===request.locale&&result.blind===request.blind&&result.rows.length===request.revisionIds.length&&new Set(result.rows.map(row=>row.revisionId)).size===request.revisionIds.length&&result.rows.every(row=>request.revisionIds.includes(row.revisionId)));return {...result,comparisonId:result.comparisonId};
 },
 comparison:async(request:ComparisonRead)=>{
  const result=await checkedInvoke("read_arena_comparison",request,validators.validateResponseComparison);
  requireConfirmation(result.comparisonId===request.comparisonId);return result;
 },
 comparisons:(request:SessionRequest)=>checkedInvoke("list_arena_comparisons",request,validators.validateResponseComparisons),
 reveal:async(request:RevealRequest)=>{await checkedInvoke("reveal_arena_identity",request,validators.validateResponseReveal);},
 merge:async(request:MergeRequest)=>{
  const result=await checkedInvoke("save_arena_merge",request,validators.validateResponseSelection);
  requireConfirmation(result.actionId===request.actionId&&result.unitId===request.unitId&&result.locale===request.locale&&result.previousEventId===(request.expectedSelectionId??null)&&BigInt(result.sequence)>0n&&(result.sequence==="1")===(result.previousEventId===null));return result;
 },
};
