import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import type { WorkPlanTeamQuestionRequest, WorkPlanTeamQuestionsRequest, WorkPlanTeamQuestionRespondRequest } from "./generated/ai.requests";
import type { TeamDiscussionPost, TeamQuestionView } from "./generated/ai.responses";
import * as validators from "./generated/ai.validators";
const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
function invalid(): never { throw { code: "result-mismatch", reason: "invalid-team-question-acknowledgement", outcome: "unknown" }; }
function openPost(post: TeamDiscussionPost) {
  return post.author.kind === "member" && post.publication.kind === "human-question" && post.publication.question?.kind === "open"
    && post.publication.replyTo === null && post.publication.supersedes === null
    && new Set(post.publication.question.options.map(choice => choice.optionId)).size === post.publication.question.options.length;
}
function terminal(post: TeamDiscussionPost, question: TeamDiscussionPost) {
  const event = post.publication.question;
  return post.planId === question.planId && post.author.kind === "local-human" && post.author.actor === "local-user"
    && post.publication.kind === "human-question" && !!event && event.kind !== "open" && event.questionPostId === question.publication.postId
    && post.publication.replyTo === question.publication.postId && post.publication.supersedes === null
    && BigInt(post.sequence) > BigInt(question.sequence) && same(post.publication.target, question.publication.target)
    && post.publication.references.length === 0;
}
function validView(value: TeamQuestionView, planId: string) {
  if (value.question.planId !== planId || !openPost(value.question)) return false;
  if (value.state === "open") return value.response === null;
  return !!value.response && terminal(value.response, value.question)
    && (value.state === "resolved" ? value.response.publication.question?.kind === "resolve" : value.response.publication.question?.kind === "dismiss");
}
function matches(post: TeamDiscussionPost, request: WorkPlanTeamQuestionRespondRequest, question: TeamDiscussionPost) {
  if (!terminal(post, question) || post.publication.postId !== request.response.postId) return false;
  const response = request.response.response, event = post.publication.question;
  if (response.kind === "dismiss") return event?.kind === "dismiss" && post.publication.body === response.reason;
  if (event?.kind !== "resolve") return false;
  if (response.kind === "text") return event.answer.kind === "text" && post.publication.body === response.body;
  const open = question.publication.question;
  const selected = open?.kind === "open" ? open.options.find(choice => choice.optionId === response.optionId) : null;
  return !!selected && event.answer.kind === "choice" && event.answer.optionId === response.optionId && post.publication.body === selected.label;
}
export const teamQuestionCommands = {
  page: async (input: WorkPlanTeamQuestionsRequest) => {
    const request = structuredClone(input);
    if (!validators.validateRequestWorkPlanTeamQuestions(request)) throw new Error("Invalid team question page");
    const value = await checkedInvoke("read_work_plan_team_questions", request, validators.validateResponseWorkPlanTeamQuestions);
    if (value.planId !== request.planId || value.questions.length > request.limit
      || new Set(value.questions.map(view => view.question.publication.postId)).size !== value.questions.length
      || value.questions.some((view, index) => !validView(view, request.planId)
        || BigInt(view.question.sequence) <= BigInt(index ? value.questions[index - 1].question.sequence : request.after ?? "0"))
      || value.nextAfter !== null && value.nextAfter !== value.questions.at(-1)?.question.sequence) invalid();
    return value;
  },
  question: async (input: WorkPlanTeamQuestionRequest) => {
    const request = structuredClone(input);
    if (!validators.validateRequestWorkPlanTeamQuestion(request)) throw new Error("Invalid team question read");
    const value = await checkedInvoke("read_work_plan_team_question", request, validators.validateResponseWorkPlanTeamQuestion);
    if (!validView(value, request.planId) || value.question.publication.postId !== request.questionPostId) invalid();
    return value;
  },
  respond: async (input: WorkPlanTeamQuestionRespondRequest, originalQuestion: TeamDiscussionPost) => {
    const request = structuredClone(input), question = structuredClone(originalQuestion);
    if (!validators.validateRequestWorkPlanTeamQuestionRespond(request) || !openPost(question) || question.planId !== request.planId
      || question.publication.postId !== request.response.questionPostId) throw new Error("Invalid original team question response");
    const value = await checkedInvoke("respond_work_plan_team_question", request, validators.validateResponseWorkPlanTeamQuestionRespond);
    if (!matches(value, request, question)) invalid();
    return value;
  },
  settlement: async (input: WorkPlanTeamQuestionRespondRequest, originalQuestion: TeamDiscussionPost) => {
    const request = structuredClone(input), question = structuredClone(originalQuestion);
    if (!validators.validateRequestWorkPlanTeamQuestionResponseSettlement(request) || !openPost(question) || question.planId !== request.planId
      || question.publication.postId !== request.response.questionPostId) throw new Error("Invalid original team question response lookup");
    const value = await checkedInvoke("read_work_plan_team_question_response_settlement", request, validators.validateResponseWorkPlanTeamQuestionResponseSettlement);
    if (value.projectId !== request.projectId || value.planId !== request.planId || !same(value.request, request.response)) invalid();
    if (value.outcome.kind === "recorded" && !matches(value.outcome.receipt, request, question)) invalid();
    if (value.outcome.kind === "closed-by-other" && (!terminal(value.outcome.receipt, question) || value.outcome.receipt.publication.postId === request.response.postId)) invalid();
    return value;
  },
};
export type { TeamQuestionView, TeamQuestionsPage } from "./generated/ai.responses";
