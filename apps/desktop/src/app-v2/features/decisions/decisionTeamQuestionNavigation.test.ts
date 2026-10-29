import { describe, expect, it, vi } from "vitest";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamQuestionNavigationFixture } from "../../../testSupport/teamQuestionNavigationFixture";
import type { DecisionItem } from "../../../decisionCommands";
import type { TeamQuestionView } from "../../../generated/ai.responses";
import { DecisionNavigationChanged, resolveDecisionNavigation, type DecisionNavigationPorts } from "./decisionNavigation";
import { readDecisionTarget, type DecisionTargetReadPorts } from "./decisionTargetReads";

function ports(overrides: Partial<DecisionNavigationPorts> = {}): DecisionNavigationPorts {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected mutation or unrelated read"); };
  return { revision: unexpected, target: unexpected, findings: unexpected, draft: unexpected, conversationDraft: unexpected,
    resourceDraft: unexpected, sourceDraft: unexpected, strategyDraft: unexpected, sourceTarget: unexpected, proposal: unexpected, knowledgeDecision: unexpected,
    teamQuestion: unexpected, proposalWorkPlan: unexpected, ...overrides };
}

describe("explicit member question inbox navigation", () => {
  it("reads the exact open question and canonical plan link before returning its conversation destination", async () => {
    const h = teamQuestionNavigationFixture(), question = vi.fn(async () => h.question), link = vi.fn(async () => h.link);
    expect(await resolveDecisionNavigation(h.context, h.item, () => true, ports({ teamQuestion: question, proposalWorkPlan: link }))).toEqual({
      kind: "conversation-team-question", conversationId: h.link.conversationId, planId: h.link.planId, questionPostId: h.question.question.publication.postId });
    expect(question).toHaveBeenCalledWith({ ...h.context, planId: h.link.planId, questionPostId: h.question.question.publication.postId });
    expect(link).toHaveBeenCalledWith({ ...h.context, conversationId: h.link.conversationId, planId: h.link.planId });
    expect(question.mock.invocationCallOrder[0]).toBeLessThan(link.mock.invocationCallOrder[0]);
  });

  it("keeps a question with no saved conversation association in read-only details", async () => {
    const h = teamQuestionNavigationFixture(false), link = vi.fn(async () => h.link);
    expect(await resolveDecisionNavigation(h.context, h.item, () => true, ports({ teamQuestion: async () => h.question, proposalWorkPlan: link }))).toEqual({ kind: "details" });
    expect(link).not.toHaveBeenCalled();
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected unrelated read"); };
    const readPorts: DecisionTargetReadPorts = { preview: unexpected, historyContent: unexpected, lineage: unexpected, compare: unexpected, attempt: unexpected,
      output: unexpected, eligibility: unexpected, deliveryRecord: unexpected, proposal: unexpected, knowledgeDecision: unexpected, teamQuestion: async () => h.question };
    expect(await readDecisionTarget(h.context, h.item, () => true, readPorts)).toEqual({ kind: "team-question", view: h.question, conversationId: null });
  });

  it.each([
    (item: DecisionItem, _view: TeamQuestionView) => { item.sourceActionId = id(68110); },
    (item: DecisionItem, _view: TeamQuestionView) => { item.locale = "ja-JP"; },
    (item: DecisionItem, _view: TeamQuestionView) => { item.targets = item.targets.filter(target => target.kind !== "plan"); },
    (item: DecisionItem, _view: TeamQuestionView) => { if (item.evidence?.kind === "team-question") item.evidence.memberId = id(68111); },
    (item: DecisionItem, _view: TeamQuestionView) => { if (item.evidence?.kind === "team-question") item.evidence.roleVersionId = id(68112); },
    (_item: DecisionItem, view: TeamQuestionView) => { view.question.publication.target.unitId = id(68113); },
    (_item: DecisionItem, view: TeamQuestionView) => { view.question.planId = id(68114); },
    (_item: DecisionItem, view: TeamQuestionView) => { view.state = "resolved"; },
    (_item: DecisionItem, view: TeamQuestionView) => { view.question.publication.question = undefined; view.question.publication.kind = "note"; },
  ])("rejects stale or differently bound question evidence before reading a conversation", async mutate => {
    const h = teamQuestionNavigationFixture(), item = structuredClone(h.item), view = structuredClone(h.question), link = vi.fn(async () => h.link);
    mutate(item, view);
    await expect(resolveDecisionNavigation(h.context, item, () => true, ports({ teamQuestion: async () => view, proposalWorkPlan: link }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
    expect(link).not.toHaveBeenCalled();
  });

  it.each(["projectId", "conversationId", "planId"] as const)("rejects a canonical link for another %s", async field => {
    const h = teamQuestionNavigationFixture(), link = { ...h.link, [field]: id(68115) };
    await expect(resolveDecisionNavigation(h.context, h.item, () => true, ports({ teamQuestion: async () => h.question, proposalWorkPlan: async () => link }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
  });

  it("stops a late read after its original view or focus is no longer current", async () => {
    const h = teamQuestionNavigationFixture(); let current = true;
    const link = vi.fn(async () => h.link);
    await expect(resolveDecisionNavigation(h.context, h.item, () => current, ports({ teamQuestion: async () => { current = false; return h.question; }, proposalWorkPlan: link }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
    expect(link).not.toHaveBeenCalled();
  });
});
