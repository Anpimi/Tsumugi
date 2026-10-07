import { checkedInvoke } from "./ipc";
import type { AiConfig, AiPreviewRequest, AiStartRequest, AiReadRequest, AiEffectRetryRequest } from "./generated/ai.requests";
import * as validators from "./generated/ai.validators";
import type { EditorTarget } from "./TranslationWorkbench";
import type { AiItemView as AiItem, AutomaticSelectionReceipt } from "./generated/ai.responses";
import { checkerIdentity, contractIdentity, providerIdentity, ruleIdentity } from "./reviewIdentity";
export type { AiConfig } from "./generated/ai.requests";
export type { AiItemView as AiItem, AiPreviewView as AiPreview, AiPrepared, AiOutputView as AiOutput, AiView } from "./generated/ai.responses";
export type AiStart = AiStartRequest;
export const defaultAiConfig:AiConfig={endpoint:"",model:"",credentialEnv:"OPENAI_API_KEY",tokenField:"max_tokens",maxItems:20,concurrency:1,maxRequests:20,maxOutputTokens:2000,maxRetries:0,timeoutSeconds:60,shareTerms:false,shareContext:false};
export const aiTarget=(item:AiItem):EditorTarget=>({unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,key:item.nativeKey,sourceText:item.sourceText});

function capturedChecksMatch(receipt: AutomaticSelectionReceipt): boolean {
  const evidence = receipt.evidence;
  if (!evidence || receipt.rules.length !== evidence.requiredChecks.requirements.length) return false;
  const requirements = evidence.requiredChecks.requirements;
  const projected = new Map(receipt.rules.map(rule => [ruleIdentity(rule.key), rule]));
  if (projected.size !== receipt.rules.length || new Set(requirements.map(requirement => ruleIdentity(requirement.key))).size !== requirements.length) return false;
  const sourceProvider = providerIdentity(evidence.sourceBinding.checker.capability.provider);
  const checkers = [{ provider: evidence.sourceBinding.checker.capability.provider, profile: evidence.sourceBinding.declaration.profile },
    ...evidence.advisoryChecks.map(choice => ({ provider: choice.binding.checker.provider, profile: choice.binding.declaration.profile }))];
  if (new Set(checkers.map(checkerIdentity)).size !== checkers.length
    || evidence.sourceBinding.declaration.rules.some(declared => !requirements.some(requirement => requirement.mandatory
      && requirement.key.implementation.kind === "plugin" && providerIdentity(requirement.key.implementation.provider) === sourceProvider
      && contractIdentity(requirement.key.rule) === contractIdentity(declared.rule)))) return false;
  if (requirements.some(requirement => {
    const rule = projected.get(ruleIdentity(requirement.key));
    if (!rule || rule.mandatory !== requirement.mandatory) return true;
    const implementation = requirement.key.implementation;
    if (implementation.kind === "core") return !requirement.mandatory;
    const provider = providerIdentity(implementation.provider), reference = contractIdentity(requirement.key.rule);
    if (requirement.mandatory) return provider !== sourceProvider
      || !evidence.sourceBinding.declaration.rules.some(declared => contractIdentity(declared.rule) === reference);
    return requirement.waivable || !evidence.advisoryChecks.some(choice => providerIdentity(choice.binding.checker.provider) === provider
      && choice.rules.some(selected => contractIdentity(selected) === reference));
  })) return false;
  return evidence.advisoryChecks.every(choice => choice.rules.length > 0
    && new Set(choice.rules.map(contractIdentity)).size === choice.rules.length
    && choice.rules.every(selected => choice.binding.declaration.rules.some(declared => contractIdentity(declared.rule) === contractIdentity(selected))
      && requirements.some(requirement => !requirement.mandatory && requirement.key.implementation.kind === "plugin"
        && providerIdentity(requirement.key.implementation.provider) === providerIdentity(choice.binding.checker.provider)
        && contractIdentity(requirement.key.rule) === contractIdentity(selected))));
}

function mandatoryChecksClean(receipt: AutomaticSelectionReceipt): boolean {
  const evidence = receipt.evidence;
  if (!evidence) return false;
  return evidence.requiredChecks.requirements.filter(requirement => requirement.mandatory).every(requirement => {
    const identity = ruleIdentity(requirement.key);
    const rule = receipt.rules.find(rule => ruleIdentity(rule.key) === identity);
    const results = evidence.results.filter(result => ruleIdentity(result.key) === identity);
    if (!rule || rule.findings.length !== 0 || results.length !== 1) return false;
    const result = results[0];
    if (requirement.targets.length === 0 || new Set(requirement.targets).size !== requirement.targets.length
      || result.inputDigest !== requirement.inputDigest || result.scopeDigest !== requirement.scopeDigest
      || result.coveredTargets.length !== requirement.targets.length
      || new Set(result.coveredTargets).size !== result.coveredTargets.length
      || result.coveredTargets.some(target => !requirement.targets.includes(target))) return false;
    return (rule.status === "passed" && result.outcome.kind === "completed" && result.outcome.findings.length === 0)
      || (rule.status === "not-applicable" && result.outcome.kind === "not-applicable"
        && result.outcome.basis.code === requirement.notApplicable?.code
        && result.outcome.basis.basisDigest === requirement.notApplicable?.basisDigest);
  });
}

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
            || selection.locale !== row.item.targetLocale || selection.revisionId !== row.savedRevisionId || selection.actionId !== receipt.request.actionId || selection.previousEventId !== receipt.capturedSelectionId))
          || receipt.candidateBasis.revisionId !== row.savedRevisionId || receipt.candidateBasis.sourceRevisionId !== row.item.sourceRevisionId
          || !capturedChecksMatch(receipt)
          || (selection !== null && (receipt.candidateBasis.selectionId !== selection.eventId
            || !mandatoryChecksClean(receipt)))
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
