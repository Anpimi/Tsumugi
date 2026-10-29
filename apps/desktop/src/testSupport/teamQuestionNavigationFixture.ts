import type { DecisionItem } from "../decisionCommands";
import type { TeamQuestionView } from "../generated/ai.responses";
import { validateResponseWorkPlanTeamQuestion } from "../generated/ai.validators";
import { fixtureIdentity as id } from "./executionFixture";
import { teamPostFixture } from "./teamDiscussionFixture";
import { workPlanHistoryFixture } from "./workPlanHistoryFixture";

/** Explicit synthetic member question, with optional real-shaped plan provenance. */
export function teamQuestionNavigationFixture(associated = true) {
  const h = workPlanHistoryFixture(1), question = teamPostFixture(), target = h.page.scope[0];
  if (!target || question.author.kind !== "member") throw new Error("Synthetic member author and entry required");
  question.planId = h.link.planId; question.author.author.binding.lease.planId = h.link.planId;
  question.publication = { ...question.publication, postId: id(68101), kind: "human-question", body: "Which original wording should the team retain?",
    target: { unitId: target.unitId, locale: h.page.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId },
    references: [], replyTo: null, supersedes: null,
    question: { kind: "open", options: [{ optionId: id(68102), label: "Keep the original wording" }] } };
  const raw: unknown = { question, state: "open", response: null };
  if (!validateResponseWorkPlanTeamQuestion(raw)) throw new Error("Invalid synthetic member question");
  const view: TeamQuestionView = raw;
  const item: DecisionItem = { decisionId: `agent-question:team:${h.link.planId}:${question.publication.postId}`, source: "agent-question", state: "pending", basis: "b".repeat(64),
    locale: question.publication.target.locale, targetsComplete: true, sourceActionId: question.publication.postId,
    targets: [{ kind: "plan", planId: h.link.planId }, { kind: "entry", unitId: question.publication.target.unitId },
      ...(associated ? [{ kind: "conversation" as const, conversationId: h.link.conversationId }] : [])],
    action: { kind: "answer-team-question", planId: h.link.planId, questionPostId: question.publication.postId },
    evidence: { kind: "team-question", memberId: question.author.author.memberId, roleVersionId: question.author.author.roleVersionId } };
  return { ...h, question: view, item };
}
