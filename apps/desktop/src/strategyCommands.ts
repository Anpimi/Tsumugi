import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import type * as R from "./generated/strategy.requests";
import type * as S from "./generated/strategy.responses";
import * as validators from "./generated/strategy.validators";

export type ContextStrategyCandidate = S.Responses["candidate"];
export type ContextStrategyDefaultRevision = NonNullable<S.Responses["default"]>;
export type StrategySuite = S.Responses["suite"];
export type StrategyEvaluation = S.Responses["evaluations"]["rows"][number];
export type StrategyEvaluationView = S.Responses["evaluation"];
export type StrategyJudgment = S.Responses["judgment"];
export type StrategyActionReceipt = NonNullable<S.Responses["action"]>;
export type StrategyCheckReceipt = S.Responses["check"];
export type Prepared = S.Responses["prepared"];

function requireMatch(valid: boolean): asserts valid {
  if (!valid) throw Object.assign(new Error("Invalid strategy acknowledgement"), { outcome: "unknown" });
}
export function sameStrategyValue(left: unknown, right: unknown) { return jsonIdentity(left) === jsonIdentity(right); }
export function confirmStrategyCandidate(request: R.CaptureRequest["capture"], value: ContextStrategyCandidate) {
  requireMatch(value.candidateId === request.actionId && value.projectId === request.basis.projectId && value.locale === request.basis.locale
    && sameStrategyValue(value.evidence.basis, request.basis) && sameStrategyValue(value.sourceContext, request.sourceContext)
    && value.reason === request.reason && value.exceptions === request.exceptions);
  return value;
}
export function confirmStrategyAction(actionId: string, value: StrategyActionReceipt) {
  const actual = value.kind === "check" ? value.receipt.request.actionId : value.kind === "judgment" ? value.judgment.request.actionId : value.request.actionId;
  requireMatch(actual === actionId); return value;
}
export const strategyCommands = {
  capture: async (request: R.CaptureRequest) => confirmStrategyCandidate(request.capture,
    await checkedInvoke("capture_context_strategy", request, validators.validateResponseCandidate)),
  candidate: async (request: R.CandidateRequest) => {
    const value = await checkedInvoke("read_context_strategy", request, validators.validateResponseCandidate);
    requireMatch(value.candidateId === request.candidateId && value.projectId === request.projectId); return value;
  },
  candidates: (request: R.PageRequest) => checkedInvoke("list_context_strategies", request,
    (value): value is S.Responses["candidates"] => validators.validateResponseCandidates(value)
      && value.rows.length <= request.limit && (value.nextOffset === null || value.nextOffset === request.offset + request.limit)
      && value.rows.every(row => row.projectId === request.projectId && row.locale === request.locale)),
  suite: async (request: R.SuiteCaptureRequest) => {
    const value = await checkedInvoke("capture_strategy_suite", request, validators.validateResponseSuite);
    requireMatch(value.suiteId === request.capture.actionId && sameStrategyValue(value.request, request.capture)); return value;
  },
  prepare: async (request: R.EvaluationPrepareRequest) => {
    const value = await checkedInvoke("prepare_strategy_evaluation", request, validators.validateResponsePrepared);
    requireMatch(value.evaluation.evaluationId === request.capture.actionId && sameStrategyValue(value.evaluation.request, request.capture)
      && value.attemptId === value.evaluation.attemptId); return value;
  },
  start: async (request: R.EvaluationStartRequest) => {
    const value = await checkedInvoke("start_strategy_evaluation", request, validators.validateResponseIdentity);
    requireMatch(value === request.attemptId); return value;
  },
  startAction: (request: R.EvaluationStartRequest) => checkedInvoke("read_strategy_evaluation_start_action", request,
    (value): value is S.Responses["startAction"] => validators.validateResponseStartAction(value)
      && (value === null || value.projectId === request.projectId && value.evaluationId === request.evaluationId
        && value.attemptId === request.attemptId && value.digest === request.digest)),
  saveAction: (request: R.SaveCandidateRequest) => checkedInvoke("read_strategy_candidate_save_action", request,
    (value): value is S.Responses["saveAction"] => validators.validateResponseSaveAction(value)
      && (value === null || sameStrategyValue(value.request, { projectId: request.projectId, actionId: request.actionId,
        evaluationId: request.evaluationId, itemId: request.itemId, resultId: request.resultId })
        && value.adoption.action.projectId === request.projectId && value.adoption.action.actionId === request.actionId
        && value.adoption.action.operation === "arena-translation" && value.adoption.action.parameters === null
        && sameStrategyValue(value.adoption.action.resultIds, [request.resultId]))),
  startReceipt: (request: R.EvaluationRequest) => checkedInvoke("read_strategy_evaluation_start", request, validators.validateResponseStartReceipt),
  evaluation: async (request: R.EvaluationRequest) => {
    const value = await checkedInvoke("read_strategy_evaluation", request, validators.validateResponseEvaluation);
    requireMatch(value.evaluation.projectId === request.projectId && value.evaluation.evaluationId === request.evaluationId
      && value.candidate.candidateId === value.evaluation.candidateId && value.suite.suiteId === value.evaluation.suiteId
      && value.candidate.projectId === request.projectId && value.suite.projectId === request.projectId
      && value.slots.length === value.suite.units.length * 2 && value.slots.length <= 40 && new Set(value.slots.map(row => row.itemId)).size === value.slots.length
      && value.slots.every(row => (row.slot === 0 || row.slot === 1) && value.suite.units.some(unit => unit.unitId === row.unitId))
      && value.suite.units.every(unit => value.slots.filter(row => row.unitId === unit.unitId).length === 2
        && new Set(value.slots.filter(row => row.unitId === unit.unitId).map(row => row.slot)).size === 2)
      && value.checks.every(row => row.request.evaluationId === request.evaluationId && row.request.projectId === request.projectId)
      && value.judgments.every(row => row.request.evaluationId === request.evaluationId && row.request.projectId === request.projectId)); return value;
  },
  evaluations: (request: R.PageRequest) => checkedInvoke("list_strategy_evaluations", request,
    (value): value is S.Responses["evaluations"] => validators.validateResponseEvaluations(value) && value.rows.length <= request.limit
      && (value.nextOffset === null || value.nextOffset === request.offset + request.limit) && value.rows.every(row => row.projectId === request.projectId)),
  judgment: async (request: R.JudgmentRequest) => {
    const value = await checkedInvoke("record_strategy_judgment", request, validators.validateResponseJudgment);
    requireMatch(value.judgmentId === request.judgment.actionId && sameStrategyValue(value.request, request.judgment)); return value;
  },
  promote: async (request: R.PromoteRequest) => {
    const value = await checkedInvoke("promote_context_strategy", request, validators.validateResponseDefault);
    requireMatch(value !== null && value.actionId === request.promotion.actionId && value.projectId === request.projectId
      && value.revisionId === request.promotion.actionId && value.evaluationId === request.promotion.evaluationId && value.previousRevisionId === request.promotion.expectedRevisionId
      && value.reference !== null && value.reference.projectId === request.projectId && value.reference.revisionId === value.revisionId); return value;
  },
  withdraw: async (request: R.WithdrawRequest) => {
    const value = await checkedInvoke("withdraw_context_strategy", request, validators.validateResponseDefault);
    requireMatch(value !== null && value.actionId === request.withdrawal.actionId && value.projectId === request.projectId
      && value.revisionId === request.withdrawal.actionId && value.locale === request.withdrawal.locale && value.previousRevisionId === request.withdrawal.expectedRevisionId && value.reference === null && value.evaluationId === null); return value;
  },
  default: (request: R.LocaleRequest) => checkedInvoke("read_context_strategy_default", request,
    (value): value is ContextStrategyDefaultRevision | null => validators.validateResponseDefault(value)
      && (value === null || value.projectId === request.projectId && value.locale === request.locale)),
  defaults: (request: R.PageRequest) => checkedInvoke("list_context_strategy_defaults", request,
    (value): value is S.Responses["defaults"] => validators.validateResponseDefaults(value) && value.rows.length <= request.limit
      && (value.nextOffset === null || value.nextOffset === request.offset + request.limit)
      && value.rows.every(row => row.projectId === request.projectId && row.locale === request.locale)),
  action: async (request: R.ActionRequest) => {
    const value = await checkedInvoke("read_strategy_action", request, validators.validateResponseAction);
    return value === null ? null : confirmStrategyAction(request.actionId, value);
  },
  saveCandidate: async (request: R.SaveCandidateRequest) => {
    const value = await checkedInvoke("save_strategy_evaluation_candidate", request, validators.validateResponseAdoption);
    requireMatch(value.projectId === request.projectId && value.actionId === request.actionId && value.changes.length === 1
      && value.changes[0].kind === "translation-revision"); return value;
  },
  prepareCheck: async (request: R.StrategyCheckCommand) => {
    const value = await checkedInvoke("prepare_strategy_evaluation_checks", request, validators.validateResponseCheckPreparation);
    if (value.kind === "recorded") requireMatch(sameStrategyValue(value.receipt.request, request.check));
    else requireMatch(value.view.actionId === request.check.actionId && value.view.checkers.length > 0
      && new Set(value.view.checkers.map(slot => slot.attemptId)).size === value.view.checkers.length);
    return value;
  },
  check: async (request: R.StrategyCheckStartRequest) => {
    const value = await checkedInvoke("run_strategy_evaluation_checks", request, validators.validateResponseCheck);
    requireMatch(sameStrategyValue(value.request, request.check.check)); return value;
  },
};

export const strategyKeys = {
  candidates: (locale: string, offset = 0) => ["context-strategy-candidates", locale, offset] as const,
  evaluations: (locale: string, offset = 0) => ["context-strategy-evaluations", locale, offset] as const,
  evaluation: (id: string) => ["context-strategy-evaluation", id] as const,
  default: (locale: string) => ["context-strategy-default", locale] as const,
  defaults: (locale: string, offset = 0) => ["context-strategy-default-history", locale, offset] as const,
};
