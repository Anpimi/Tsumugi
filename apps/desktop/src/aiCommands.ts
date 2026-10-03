import { checkedInvoke } from "./ipc";
import type { AiConfig, AiPreviewRequest, AiStartRequest, AiReadRequest } from "./generated/ai.requests";
import * as validators from "./generated/ai.validators";
import type { EditorTarget } from "./TranslationWorkbench";
import type { AiItemView as AiItem } from "./generated/ai.responses";
export type { AiConfig } from "./generated/ai.requests";
export type { AiItemView as AiItem, AiPreviewView as AiPreview, AiPrepared, AiOutputView as AiOutput, AiView } from "./generated/ai.responses";
export type AiStart = AiStartRequest;
export const defaultAiConfig:AiConfig={endpoint:"",model:"",credentialEnv:"OPENAI_API_KEY",tokenField:"max_tokens",maxItems:20,concurrency:1,maxRequests:20,maxOutputTokens:2000,maxRetries:0,timeoutSeconds:60,shareTerms:false,shareContext:false};
export const aiTarget=(item:AiItem):EditorTarget=>({unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,key:item.nativeKey,sourceText:item.sourceText});
export const aiCommands={
  preview:(request:AiPreviewRequest)=>checkedInvoke("preview_ai_translation",request,validators.validateResponsePrepared),
  start:async(request:AiStartRequest)=>{
    const result=await checkedInvoke("start_ai_translation",request,validators.validateResponseIdentity);
    if(result!==request.attemptId)throw new Error("Invalid IPC acknowledgement: AI attempt");
    return result;
  },
  read:async(request:AiReadRequest)=>{
    const result=await checkedInvoke("read_ai_translation",request,validators.validateResponseView);
    if(result.detail.attemptId!==request.attemptId||result.rows.some(row=>row.output&&(row.output.unitId!==row.item.unitId||row.output.targetLocale!==row.item.targetLocale)))throw new Error("Invalid IPC response: AI attempt");
    return result;
  },
};
