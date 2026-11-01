import { expect, it, vi } from "vitest";
import wire from "../../../../test/fixtures/aiCommands.contract.json";
import { validateResponseView } from "../../../generated/ai.validators";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { resolveRunCandidateBatch, runCandidateBatchTarget } from "./runCandidateBatch";

function fixture() {
  const context = { ...wire.requests.read, sessionToken: "original-run-batch" };
  const prepared = conversationWorkPlanFixture({ ...context, conversationId: id(67000) }).prepared;
  const raw: unknown = structuredClone(wire.responses.view);
  if (!validateResponseView(raw) || !raw.rows[0].output) throw new Error("Expected saved original result");
  raw.rows = [{ ...raw.rows[0], savedRevisionId: id(67001), resultId: id(67002) }];
  const plan = prepared.plan, link = { ...prepared.proposal, planId: plan.planId, planDigest: plan.digest, actionId: id(67003), ordinal: "1" };
  const start = { projectId: context.projectId, planId: plan.planId, actionId: id(67004), expectedGeneration: "2",
    taskId: raw.detail.taskId, attemptId: raw.detail.attemptId };
  const target = runCandidateBatchTarget(link, plan, start, raw.rows);
  if (!target) throw new Error("Expected fixed original batch target");
  return { context, plan, link, start, view: raw, target };
}

it("re-reads the original run and preserves the clicked member set when later outputs arrive", async () => {
  const h = fixture(), extra = structuredClone(h.view.rows[0]);
  extra.item.unitId = id(67010); extra.itemId = id(67011); extra.resultId = id(67012); extra.savedRevisionId = id(67013);
  h.view.rows.push(extra);
  const read = vi.fn(async () => h.view);
  const fixed = await resolveRunCandidateBatch(h.context, h.target, () => true, read);
  expect(read).toHaveBeenCalledWith(h.context, h.link, h.plan, h.start);
  expect(fixed?.candidates).toHaveLength(1); expect(fixed?.candidates[0].revisionId).toBe(id(67001));
  expect(runCandidateBatchTarget(h.link, h.plan, h.start, [])).toBeNull();
});

it("declines an altered original run association, foreign project and late result", async () => {
  const h = fixture(), read = vi.fn(async () => h.view);
  expect(await resolveRunCandidateBatch({ ...h.context, projectId: id(67020) }, h.target, () => true, read)).toBeNull();
  expect(read).not.toHaveBeenCalled();
  h.view.rows[0].savedRevisionId = id(67021);
  expect(await resolveRunCandidateBatch(h.context, h.target, () => true, read)).toBeNull();
  h.view.rows[0].savedRevisionId = id(67001);
  let current = true;
  expect(await resolveRunCandidateBatch(h.context, h.target, () => current, async () => { current = false; return h.view; })).toBeNull();
});
