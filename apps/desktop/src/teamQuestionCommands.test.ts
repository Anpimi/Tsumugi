import { beforeEach, describe, expect, it, vi } from "vitest";
import { teamQuestionCommands } from "./teamQuestionCommands";
import type { WorkPlanTeamQuestionRespondRequest } from "./generated/ai.requests";
import type { TeamDiscussionPost } from "./generated/ai.responses";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { teamQuestionNavigationFixture } from "./testSupport/teamQuestionNavigationFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => { invoke.mockReset(); });
function fixture() {
  const h = teamQuestionNavigationFixture(), question = h.question.question;
  const request: WorkPlanTeamQuestionRespondRequest = { ...h.context, planId: h.link.planId,
    response: { postId: id(68601), questionPostId: question.publication.postId, response: { kind: "text", body: "Keep the original {name}." } } };
  const receipt = (input = request): TeamDiscussionPost => {
    const response = input.response.response, event = question.publication.question;
    const option = event?.kind === "open" && response.kind === "choice" ? event.options.find(option => option.optionId === response.optionId) : null;
    return { planId: input.planId, sequence: String(BigInt(question.sequence) + 1n), author: { kind: "local-human", actor: "local-user" },
      publication: { postId: input.response.postId, target: structuredClone(question.publication.target), kind: "human-question",
        body: response.kind === "text" ? response.body : response.kind === "dismiss" ? response.reason : option?.label ?? "",
        references: [], replyTo: question.publication.postId, supersedes: null,
        question: response.kind === "dismiss" ? { kind: "dismiss", questionPostId: question.publication.postId }
          : { kind: "resolve", questionPostId: question.publication.postId,
            answer: response.kind === "choice" ? { kind: "choice", optionId: response.optionId } : { kind: "text" } } } };
  };
  return { ...h, request, receipt };
}

describe("explicit member question bridge", () => {
  it("reads the original question through the bounded page and exact locator", async () => {
    const h = fixture(), page = { planId: h.link.planId, questions: [h.question], nextAfter: null };
    invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(h.question);
    expect(await teamQuestionCommands.page({ ...h.context, planId: h.link.planId, after: null, limit: 16 })).toEqual(page);
    expect(await teamQuestionCommands.question({ ...h.context, planId: h.link.planId, questionPostId: h.question.question.publication.postId })).toEqual(h.question);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_work_plan_team_questions", "read_work_plan_team_question"]);
  });

  it.each(["text", "choice"] as const)("records an exact %s answer against its immutable original question", async kind => {
    const h = fixture(), event = h.question.question.publication.question;
    if (kind === "choice" && event?.kind === "open") h.request.response.response = { kind, optionId: event.options[0].optionId };
    const original = structuredClone(h.request), saved = h.receipt();
    invoke.mockResolvedValueOnce(saved);
    expect(await teamQuestionCommands.respond(h.request, h.question.question)).toEqual(saved);
    expect(invoke).toHaveBeenCalledWith("respond_work_plan_team_question", { request: original });
  });

  it("distinguishes its recorded answer from another exact terminal response", async () => {
    const h = fixture(), original = { projectId: h.context.projectId, planId: h.link.planId, request: h.request.response };
    const recorded = { ...original, outcome: { kind: "recorded", receipt: h.receipt() } };
    invoke.mockResolvedValueOnce(recorded);
    expect(await teamQuestionCommands.settlement(h.request, h.question.question)).toEqual(recorded);
    const dismissal = h.receipt({ ...h.request, response: { ...h.request.response, postId: id(68602), response: { kind: "dismiss", reason: "No answer needed now." } } });
    const closed = { ...original, outcome: { kind: "closed-by-other", receipt: dismissal } };
    invoke.mockResolvedValueOnce(closed);
    expect(await teamQuestionCommands.settlement(h.request, h.question.question)).toEqual(closed);
    expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_team_question_response_settlement")).toBe(true);
  });

  it("does not treat a terminal response to another question as this request's outcome", async () => {
    const h = fixture(), receipt = h.receipt();
    receipt.publication.replyTo = id(68603);
    if (receipt.publication.question?.kind === "resolve") receipt.publication.question.questionPostId = id(68603);
    invoke.mockResolvedValueOnce({ projectId: h.context.projectId, planId: h.link.planId, request: h.request.response,
      outcome: { kind: "closed-by-other", receipt } });
    await expect(teamQuestionCommands.settlement(h.request, h.question.question)).rejects.toMatchObject({ code: "result-mismatch", outcome: "unknown" });
  });
});
