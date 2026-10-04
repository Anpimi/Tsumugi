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
  view.detail.items[0].scope.id = item.unitId;
  view.detail.recovery.units[0].unitId = execution.prepare.unitId;
  view.detail.recovery.units[0].scopes[0].id = item.unitId;
  return view;
}

export function arenaViewFixture(item: AiItem): ArenaView {
  const view: unknown = structuredClone(arena.responses.view);
  if (!validateArena(view)) throw new Error("Invalid Arena fixture");
  view.detail.attemptId = aiAttempt;
  view.detail.taskId = aiTask;
  view.detail.recovery.attemptId = aiAttempt;
  view.budget = {limit:40,dispatched:2,legacyHeld:0,unresolved:0,usageUnknown:2,promptTokens:"0",completionTokens:"0"};
  view.rows.forEach((row, i) => {
    row.item = item;
    row.output = { ...row.output!, unitId: item.unitId, targetLocale: item.targetLocale, text: i === 0 ? "Second output" : "First output", usage: null, usageIncomplete: true };
    view.detail.items[i].scope.id = item.unitId;
    view.detail.recovery.units[i].scopes[0].id = item.unitId;
  });
  return view;
}
