import fixture from "../../test/fixtures/teamDiscussionCommands.contract.json";
import workPlan from "../../test/fixtures/workPlanCommands.contract.json";
import * as validators from "../generated/ai.validators";
import type { TeamHistoryPage, TeamDiscussionPost, WorkPlanStatusView, WorkPlanTeamPublishRequest } from "../workPlanCommands";

export const teamContext = { sessionToken: fixture.requests.history.sessionToken, projectId: fixture.requests.history.projectId };
export function teamPublishRequestFixture(): WorkPlanTeamPublishRequest {
  const value: unknown = structuredClone(fixture.requests.publish);
  if (!validators.validateRequestWorkPlanTeamPublish(value)) throw new Error("Invalid team publication fixture");
  return value;
}
export function teamStatusFixture(): WorkPlanStatusView {
  const value: unknown = { ...structuredClone(workPlan.responses.status), plan: structuredClone(workPlan.responses.discussionPlan),
    lease: structuredClone(fixture.requests.publish.lease), state: "active", expiresAt: String(Math.floor(Date.now() / 1000) + 300),
    effects: ["save-candidate", "publish-discussion"], toolInvocations: null };
  if (!validators.validateResponseWorkPlanStatus(value)) throw new Error("Invalid team status fixture");
  return value;
}
export function teamHistoryFixture(next = false): TeamHistoryPage {
  const value: unknown = structuredClone(next ? fixture.responses.historyNext : fixture.responses.history);
  if (!validators.validateResponseWorkPlanTeamHistory(value)) throw new Error("Invalid team history fixture");
  return value;
}
export function teamPostFixture(): TeamDiscussionPost {
  const value: unknown = structuredClone(fixture.responses.post);
  if (!validators.validateResponseWorkPlanTeamPost(value)) throw new Error("Invalid team post fixture");
  return value;
}
export function publishedTeamFixture(request: WorkPlanTeamPublishRequest): TeamDiscussionPost {
  const value: unknown = { ...structuredClone(fixture.responses.published), planId: request.lease.planId,
    publication: structuredClone(request.publication), author: { ...structuredClone(fixture.responses.published.author),
      binding: { ...structuredClone(fixture.responses.published.author.binding), lease: structuredClone(request.lease) } } };
  if (!validators.validateResponseWorkPlanTeamPost(value)) throw new Error("Invalid published team fixture");
  return value;
}
