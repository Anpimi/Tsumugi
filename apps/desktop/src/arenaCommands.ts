import {invoke} from "@tauri-apps/api/core";
import {defaultAiConfig, type AiConfig, type AiItem, type AiOutput, type AiStart} from "./aiCommands";
import type {SessionRequest, AttemptDetail} from "./executionCommands";
import type {TranslationSaveRequest, TranslationSelection} from "./translationCommands";
export interface ArenaConfig {variants:AiConfig[];maxItems:number;maxRequests:number;concurrency:number;blind:boolean;parentAttemptId:string|null}
export const defaultArenaConfig=():ArenaConfig=>({variants:[{...defaultAiConfig},{...defaultAiConfig}],maxItems:20,maxRequests:40,concurrency:1,blind:false,parentAttemptId:null});
export interface ArenaPrepared {attemptId:string;preview:{config:ArenaConfig;items:Array<{slot:number;sourceOrder:number;item:AiItem}>;digest:string}}
export interface ArenaView {detail:AttemptDetail;rows:Array<{item:AiItem;itemId:string;sourceOrder:number;label:number;resultId:string|null;output:AiOutput|null}>;variants:AiConfig[]|null;blind:boolean;revealed:boolean;differentInputs:boolean;repeatedSampling:boolean;parentAttemptId:string|null}
export interface ComparisonEntry {revisionId:string;text:string;sourceRevisionId:string;originKind:string;contributors:string[];model:string|null;recipe:string|null;basisCurrent:boolean}
export interface ComparisonView {comparisonId:string|null;unitId:string;locale:string;sourceRevisionId:string;sourceText:string;nativeKey:string;selectionId:string|null;selectedRevisionId:string|null;selectedText:string|null;basis:string;blind:boolean;revealed:boolean;rows:ComparisonEntry[]}
export type ComparisonSummary = Pick<ComparisonView,"comparisonId"|"nativeKey"|"locale">;
export interface CompareRequest extends SessionRequest {actionId:string;unitId:string;locale:string;revisionIds:string[];blind:boolean}
export interface MergeRequest extends TranslationSaveRequest {merge:{contributors:string[];expectedBasis:string}}
export const arenaCommands={
 preview:(request:SessionRequest&{config:ArenaConfig;locale:string;unitIds:string[]})=>invoke<ArenaPrepared>("preview_arena_translation",{request}),
 start:(request:AiStart)=>invoke<string>("start_arena_translation",{request}),
 read:(request:SessionRequest&{attemptId:string})=>invoke<ArenaView>("read_arena_translation",{request}),
 compare:(request:CompareRequest)=>invoke<ComparisonView>("create_arena_comparison",{request}),
 comparison:(request:SessionRequest&{comparisonId:string})=>invoke<ComparisonView>("read_arena_comparison",{request}),
 comparisons:(request:SessionRequest)=>invoke<ComparisonSummary[]>("list_arena_comparisons",{request}),
 reveal:(request:SessionRequest&{comparisonId:string;actionId:string})=>invoke<void>("reveal_arena_identity",{request}),
 merge:(request:MergeRequest)=>invoke<TranslationSelection>("save_arena_merge",{request}),
};
