import { invoke } from "@tauri-apps/api/core";
import type { SessionRequest, AttemptDetail } from "./executionCommands";
import type { EditorTarget } from "./TranslationWorkbench";
export interface AiConfig {endpoint:string;model:string;credentialEnv:string;tokenField:string;maxItems:number;concurrency:number;maxRequests:number;maxOutputTokens:number;maxRetries:number;timeoutSeconds:number;shareTerms:boolean;shareContext:boolean}
export const defaultAiConfig:AiConfig={endpoint:"",model:"",credentialEnv:"OPENAI_API_KEY",tokenField:"max_tokens",maxItems:20,concurrency:1,maxRequests:20,maxOutputTokens:2000,maxRetries:0,timeoutSeconds:60,shareTerms:false,shareContext:false};
export interface AiItem {unitId:string;sourceRevisionId:string;sourceSnapshotId:string;nativeKey:string;sourceLocale:string;sourceText:string;targetLocale:string;terms:Array<{revisionId:string;source:string;target:string;protected:boolean}>;context:{revisionId:string;text:string}|null;omissions:string[];resourceBaseline:number}
export interface AiPreview {config:AiConfig;recipe:string;items:AiItem[];digest:string}
export interface AiPrepared {preview:AiPreview;attemptId:string}
export interface AiOutput {unitId:string;targetLocale:string;text:string;usage:{promptTokens:number;completionTokens:number}|null;requests:number;usageIncomplete:boolean}
export interface AiView {config:AiConfig;recipe:string;detail:AttemptDetail;rows:Array<{item:AiItem;itemId:string;resultId:string|null;output:AiOutput|null}>}
export interface AiStart extends SessionRequest {attemptId:string;digest:string;confirmed:boolean}
export const aiTarget=(item:AiItem):EditorTarget=>({unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,key:item.nativeKey,sourceText:item.sourceText});
export const aiCommands={
  preview:(request:SessionRequest & {config:AiConfig;locale:string;unitIds:string[]})=>invoke<AiPrepared>("preview_ai_translation",{request}),
  start:(request:AiStart)=>invoke<string>("start_ai_translation",{request}),
  read:(request:SessionRequest & {attemptId:string})=>invoke<AiView>("read_ai_translation",{request}),
};
