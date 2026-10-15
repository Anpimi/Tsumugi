import workPlan from "../../test/fixtures/workPlanCommands.contract.json";
import {validateResponseWorkPlan} from "../generated/ai.validators";
import type {AiPrepared} from "../aiCommands";
import type {WorkPlanView,PlanOptions} from "../workPlanCommands";
import ai from "../../test/fixtures/aiCommands.contract.json";
import arena from "../../test/fixtures/arenaCommands.contract.json";
import execution from "../../test/fixtures/executionCommands.contract.json";
import { validateResponseView as validateAi } from "../generated/ai.validators";
import { validateResponseView as validateArena } from "../generated/arena.validators";
import type { AiConfig, AiItem, AiView } from "../aiCommands";
import type { ArenaView } from "../arenaCommands";
import { fixtureIdentity } from "./executionFixture";

export const aiAttempt = fixtureIdentity(401);
export const aiTask = fixtureIdentity(402);

export function aiViewFixture(item: AiItem, config: AiConfig): AiView {
  const view: unknown = structuredClone(ai.responses.view);
  if (!validateAi(view)) throw new Error("Invalid AI fixture");
  view.budget = {limit:config.maxRequests,dispatched:1,legacyHeld:0,unresolved:0,usageUnknown:1,promptTokens:"0",completionTokens:"0"};
  view.config = config;
  view.detail.attemptId = aiAttempt;
  view.detail.taskId = aiTask;
  view.detail.recovery.attemptId = aiAttempt;
  view.rows[0].item = item;
  view.rows[0].output = { ...view.rows[0].output!, unitId: item.unitId, targetLocale: item.targetLocale, text: "你好", usage: null, usageIncomplete: true };
  view.detail.items[0].scope = { kind: "translation-unit", id: item.unitId, locale: item.targetLocale };
  view.detail.recovery.units[0].unitId = execution.prepare.unitId;
  view.detail.recovery.units[0].scopes[0] = { kind: "translation-unit", id: item.unitId, locale: item.targetLocale };
  return view;
}

export function arenaViewFixture(item: AiItem, config?: import("../arenaCommands").ArenaConfig): ArenaView {
  const view: unknown = structuredClone(arena.responses.view);
  if (!validateArena(view)) throw new Error("Invalid Arena fixture");
  view.detail.attemptId = aiAttempt;
  view.detail.taskId = aiTask;
  view.detail.recovery.attemptId = aiAttempt;
  view.budget = {limit:config?.maxRequests ?? 40,dispatched:2,legacyHeld:0,unresolved:0,usageUnknown:2,promptTokens:"0",completionTokens:"0"};
  if (config) {
    view.blind = config.blind; view.revealed = !config.blind; view.variants = config.blind ? null : structuredClone(config.variants);
    view.parentAttemptId = config.parentAttemptId ?? null;
  }
  view.rows.forEach((row, i) => {
    row.item = item;
    row.output = { ...row.output!, unitId: item.unitId, targetLocale: item.targetLocale, text: i === 0 ? "Second output" : "First output", usage: null, usageIncomplete: true };
    view.detail.items[i].scope = { kind: "translation-unit", id: item.unitId, locale: item.targetLocale };
    view.detail.recovery.units[i].scopes[0] = { kind: "translation-unit", id: item.unitId, locale: item.targetLocale };
  });
  return view;
}

/** Core canonicalizes the plan basis while preserving the ordered AI preview. */
export function aiWorkPlanFixture(prepared:AiPrepared,options?:PlanOptions):WorkPlanView {
  const value:unknown=structuredClone(workPlan.responses.plan);
  if(!validateResponseWorkPlan(value))throw new Error("Invalid work-plan fixture");
  return {...value,attemptId:prepared.attemptId,preview:structuredClone(prepared.preview),locale:prepared.preview.items[0].targetLocale,
    ...(options?{options:{...structuredClone(options),advisoryChecks:options.advisoryChecks.map(check=>({...structuredClone(check),
      execution:{...structuredClone(check.execution),profile:structuredClone(check.execution.profile??null)}}))}}:{}),checkers:[],tools:null,
    scope:prepared.preview.items.map(item=>({unitId:item.unitId,sourceRevisionId:item.sourceRevisionId,sourceSnapshotId:item.sourceSnapshotId,nativeKey:item.nativeKey,selectionId:null})).sort((left,right)=>left.unitId.localeCompare(right.unitId))};
}
