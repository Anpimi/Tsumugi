import wire from "../../test/fixtures/workPlanCommands.contract.json";
import type { AiConfig } from "../aiCommands";
import type { ConversationProposalRevision } from "../conversationCommands";
import { validateResponseWorkPlan } from "../generated/ai.validators";
import { validateResponseProposalWorkPlan } from "../generated/conversations.validators";
import { conversationProposalFixture } from "./conversationProposalFixture";

/** A local captured plan. It has no runtime or execution permission. */
export function conversationWorkPlanFixture(context: { projectId: string; conversationId: string }, config?: AiConfig) {
  const key = { projectId: context.projectId, conversationId: context.conversationId };
  const fixture = conversationProposalFixture(key), plan: unknown = structuredClone(wire.responses.plan);
  if (!validateResponseWorkPlan(plan)) throw new Error("Invalid synthetic work plan");
  if (fixture.revision.content.kind !== "proposal") throw new Error("Missing synthetic proposal");
  const revision: ConversationProposalRevision = { ...fixture.revision,
    content: { ...fixture.revision.content, unitIds: plan.scope.map(unit => unit.unitId), options: plan.options } };
  const run = structuredClone(fixture.run);
  if (run.preview.scope.kind !== "units" || !plan.preview || !run.output || revision.content.kind !== "proposal") throw new Error("Missing synthetic work-plan material");
  run.preview.scope.unitIds = [...revision.content.unitIds];
  run.preview.units = plan.scope.map(unit => ({ ...run.preview.units[0], unitId: unit.unitId, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId,
    protection: { ...run.preview.units[0].protection, unitId: unit.unitId } }));
  run.output = { ...run.output, model: structuredClone(revision.content) };
  run.preview.input = JSON.stringify({ messages: run.preview.selectedMessages.map(message => ({ author: message.author, body: message.body })),
    units: plan.preview.items.map(item => ({ unitId: item.unitId, nativeKey: item.nativeKey, sourceText: item.sourceText })) });
  run.preview.brief.units = plan.scope.length; run.preview.brief.sourceTexts = plan.scope.length;
  run.preview.byteLength = new TextEncoder().encode(JSON.stringify({ system: run.preview.system, input: run.preview.input })).length;
  if (config) plan.preview.config = structuredClone(config);
  plan.preview.items = plan.preview.items.map(item => ({ ...item, projectContext: { kind: "not-selected" } }));
  const prepared: unknown = { proposal: { ...key, proposalId: revision.proposalId, revisionId: revision.revisionId }, plan };
  if (!validateResponseProposalWorkPlan(prepared)) throw new Error("Invalid synthetic proposal work plan");
  return { ...fixture, run, revision, prepared, config: structuredClone(plan.preview.config) };
}
