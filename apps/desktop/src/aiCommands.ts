import { checkedInvoke } from "./ipc";
import type { AiConfig, AiPreviewRequest, AiStartRequest, AiReadRequest, AiEffectRetryRequest } from "./generated/ai.requests";
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
    if ((result.planId === null) !== (result.planGeneration === null)
      || new Set(result.rows.map(row => row.itemId)).size !== result.rows.length
      || result.rows.some(row => {
        const effect = row.automation, receipt = effect?.receipt;
        if (row.savedRevisionId && (!row.output || !row.resultId)) return true;
        if (!effect) return false;
        if (!result.planId || !result.planGeneration) return true;
        if (effect.retryable && (effect.phase !== "failed" || !effect.error)) return true;
        if (!receipt) return effect.phase === "selected" || effect.phase === "blocked";
        const selection = receipt.selection;
        return receipt.request.projectId !== request.projectId
          || receipt.request.lease.planId !== result.planId
          || receipt.request.lease.generation !== result.planGeneration
          || receipt.request.unitId !== row.item.unitId || receipt.request.locale !== row.item.targetLocale
          || receipt.request.revisionId !== row.savedRevisionId || receipt.request.actionId !== effect.actionId
          || (receipt.blocked === null ? effect.phase !== "selected" || !selection || !receipt.checkRunId : effect.phase !== "blocked" || selection !== null || receipt.checkRunId !== null)
          || (selection !== null && (selection.unitId !== row.item.unitId
            || selection.locale !== row.item.targetLocale || selection.revisionId !== row.savedRevisionId || selection.actionId !== receipt.request.actionId))
          || receipt.candidateBasis.revisionId !== row.savedRevisionId || receipt.candidateBasis.sourceRevisionId !== row.item.sourceRevisionId
          || receipt.rules.length !== 4 || new Set(receipt.rules.map(rule => rule.rule)).size !== 4
          || receipt.rules.some(rule => !["required-translation", "placeholders", "format", "terminology"].includes(rule.rule))
          || effect.error !== null || effect.retryable;
      })) throw new Error("Invalid IPC response: automatic selection");
    return result;
  },
  retryEffect: async (request: AiEffectRetryRequest) => {
    const result = await checkedInvoke("retry_work_plan_effect", request, validators.validateResponseEffectRetry);
    if (result !== true) throw Object.assign(new Error("Invalid IPC acknowledgement: automatic effect"), { outcome: "unknown" });
    return result;
  },
};
