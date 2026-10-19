import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/teamDiscussionCommands.contract.json";
import * as validators from "./generated/ai.validators";
import { workPlanCommands } from "./workPlanCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { teamPublishRequestFixture } from "./testSupport/teamDiscussionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
const unknown = { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };

it("uses the four generated historical and publication contracts without restoring a scope", async () => {
  for (const [check, value] of [
    [validators.validateRequestWorkPlanTeamHistory, fixture.requests.history],
    [validators.validateRequestWorkPlanTeamPost, fixture.requests.post],
    [validators.validateRequestWorkPlanTeamPublish, fixture.requests.publish],
    [validators.validateRequestWorkPlanTeamPublicationAction, fixture.requests.publicationAction],
    [validators.validateResponseWorkPlanTeamHistory, fixture.responses.history],
    [validators.validateResponseWorkPlanTeamPost, fixture.responses.post],
    [validators.validateResponseWorkPlanTeamPublicationAction, fixture.responses.publicationAction],
    [validators.validateResponseWorkPlanTeamPublicationAction, null],
  ] as const) expect(check(value)).toBe(true);
  const historyRequest = { ...fixture.requests.history, after: null };
  invoke.mockResolvedValueOnce(fixture.responses.history);
  expect(await workPlanCommands.teamHistory(historyRequest)).toEqual(fixture.responses.history);
  expect(invoke).toHaveBeenLastCalledWith("read_work_plan_team_history", { request: historyRequest });
  invoke.mockResolvedValueOnce(fixture.responses.post);
  expect(await workPlanCommands.teamPost(fixture.requests.post)).toEqual(fixture.responses.post);
  invoke.mockResolvedValueOnce(fixture.responses.published);
  expect(await workPlanCommands.publishTeam(teamPublishRequestFixture())).toEqual(fixture.responses.published);
  invoke.mockResolvedValueOnce(null);
  expect(await workPlanCommands.teamPublicationAction(teamPublishRequestFixture())).toBeNull();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_work_plan_team_history", "read_work_plan_team_post", "publish_work_plan_team_discussion", "read_work_plan_team_publication_action"]);
});

it("rejects mismatched plan, cursor and historical author-role acknowledgements", async () => {
  const page = fixture.responses.history;
  for (const wrong of [{ ...page, planId: fixtureIdentity(8000) }, { ...page, nextAfter: "2" },
    { ...page, authorRoles: [] }, { ...page, posts: [page.posts[0], page.posts[0]] }]) {
    invoke.mockResolvedValueOnce(wrong);
    await expect(workPlanCommands.teamHistory({ ...fixture.requests.history, after: null })).rejects.toMatchObject(unknown);
  }
  invoke.mockResolvedValueOnce(page);
  await expect(workPlanCommands.teamHistory({ ...fixture.requests.history, after: "1" })).rejects.toMatchObject(unknown);
  expect(validators.validateRequestWorkPlanTeamHistory({ ...fixture.requests.history, limit: 17 })).toBe(false);
});

it("requires the exact original human publication and root binding for write and read-only acknowledgement", async () => {
  const post = fixture.responses.published;
  const delegated = { delegationId: fixtureIdentity(8001), parentScopeId: post.author.binding.callerId,
    unitIds: [post.publication.target.unitId], toolHandles: [] };
  for (const wrong of [{ ...post, publication: { ...post.publication, body: "Other content" } },
    { ...post, author: { ...post.author, actor: "someone-else" } },
    { ...post, author: { ...post.author, binding: { ...post.author.binding, lease: { ...post.author.binding.lease, generation: "4" } } } },
    { ...post, author: { ...post.author, binding: { ...post.author.binding, delegation: delegated } } }]) {
    expect(validators.validateResponseWorkPlanTeamPost(wrong)).toBe(true);
    invoke.mockResolvedValueOnce(wrong);
    await expect(workPlanCommands.publishTeam(teamPublishRequestFixture())).rejects.toMatchObject(unknown);
    invoke.mockResolvedValueOnce(wrong);
    await expect(workPlanCommands.teamPublicationAction(teamPublishRequestFixture())).rejects.toMatchObject(unknown);
  }
  expect(validators.validateRequestWorkPlanTeamPublish({ ...fixture.requests.publish, actor: "local-user" })).toBe(false);
});
