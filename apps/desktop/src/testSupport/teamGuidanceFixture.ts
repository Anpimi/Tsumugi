import { teamExecutionStatusFixture, teamExecutionViewFixture } from "./teamExecutionFixture";
import { teamPostFixture } from "./teamDiscussionFixture";
import type { WorkPlanTeamMessageRequest } from "../generated/ai.requests";
import type { TeamMessage } from "../generated/ai.responses";
import * as validators from "../generated/ai.validators";

export function teamGuidanceFixture() {
  const status = teamExecutionStatusFixture(), view = teamExecutionViewFixture();
  view.stopReason = null;
  if (view.budget) view.budget.unresolved = 0;
  return { status, view };
}
/** A synthetic trusted local author; it does not establish a Core grant. */
export function humanTeamMessageFixture(request: WorkPlanTeamMessageRequest): TeamMessage {
  const post = teamPostFixture();
  const binding = post.author.kind === "member" ? post.author.author.binding : post.author.binding;
  const value: unknown = { messageId: request.message.messageId, sequence: "2", planId: request.lease.planId,
    sender: { kind: "human", actor: "local-user", binding: { ...structuredClone(binding), lease: structuredClone(request.lease), delegation: null } },
    recipientMemberId: request.message.recipientMemberId, recipientRoleVersionId: request.message.expectedRecipientRoleVersionId,
    target: structuredClone(request.message.target), body: request.message.body, postIds: [], causeMessageId: null };
  if (!validators.validateResponseWorkPlanTeamMessage(value)) throw new Error("Invalid synthetic human message");
  return value;
}
