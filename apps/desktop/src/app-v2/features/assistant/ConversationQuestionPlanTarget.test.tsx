import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { i18n } from "../../../i18n";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { teamQuestionNavigationFixture } from "../../../testSupport/teamQuestionNavigationFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationSession } from "./ConversationSession";
import { ConversationWorkPlanPanel } from "./ConversationWorkPlanPanel";
import type { ConversationPlanLink } from "./conversationRun";
import type { ConversationTeamQuestionTarget } from "./conversationNavigation";

const invoke = vi.hoisted(() => vi.fn());
const observed = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./ConversationRunPanel", () => ({ ConversationRunPanel: (props: { link: ConversationPlanLink; questionTarget?: ConversationTeamQuestionTarget | null }) => {
  observed(props); return <section aria-label={props.link.planId}>{props.questionTarget ? <p>{props.questionTarget.questionPostId}</p> : null}</section>;
} }));
const disposals: (() => void)[] = [];
beforeEach(async () => { invoke.mockReset(); observed.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

it.each([false, true])("reads the original question plan exactly and renders it once (already on first page: %s)", async included => {
  const h = teamQuestionNavigationFixture(), link = { ...h.link, ordinal: "2" }, key = { projectId: h.context.projectId, conversationId: link.conversationId };
  const old = { ...link, planId: id(68201), actionId: id(68202), ordinal: "1" };
  const owner = new ConversationSession(h.context, vi.fn(), vi.fn(), { read: async () => ({ key, revision: "1", writerId: id(68203),
    value: { text: "Retained input B", editSeq: "4", pending: null } }) });
  expect(await owner.open(link.conversationId)).toBe(true);
  const input = owner.getSnapshot().inputs.get(link.conversationId); if (!input) throw new Error("Missing original synthetic conversation input");
  invoke.mockImplementation(async (command: string, { request }: { request: { proposalId: string; revisionId: string; after?: string | null } }) => {
    if (command === "read_conversation_proposal_work_plans") return { ...key, rows: [included ? link : old], nextAfter: included ? null : "1" };
    if (command === "read_conversation_proposal_work_plan") return link;
    if (command === "read_conversation_proposal") return { ...conversationWorkPlanFixture(key).revision, proposalId: request.proposalId, revisionId: request.revisionId };
    throw new Error(`Unexpected mutation or full-history scan: ${command}`);
  });
  const reads = new SessionReads(h.context), gate = new InteractionGate(); gate.setVisibleOwner("conversation");
  const target: ConversationTeamQuestionTarget = { conversationId: link.conversationId, planId: link.planId, questionPostId: h.question.question.publication.postId, focus: false, origin: document.body };
  render(<ApplicationReadProvider><SessionReadProvider context={h.context} reads={reads} bridge={false}>
    <ConversationWorkPlanPanel owner={owner} input={input} visible disabled={false} gate={gate} viewId="conversation" questionTarget={target}/>
  </SessionReadProvider></ApplicationReadProvider>);
  disposals.push(() => { owner.retire(); reads.retire(); gate.dispose(); });
  await screen.findByText(target.questionPostId);
  expect(screen.getAllByRole("region", { name: link.planId })).toHaveLength(1);
  await waitFor(() => expect(reads.client.isFetching()).toBe(0));
  const selected = observed.mock.calls.map(([props]) => props).filter(props => props.link.planId === link.planId).at(-1);
  expect(selected.questionTarget).toBe(target);
  expect(invoke.mock.calls.filter(([command]) => command === "read_conversation_proposal_work_plan").map(([, args]) => args.request)).toEqual([{ ...h.context, conversationId: link.conversationId, planId: link.planId }]);
  expect(invoke.mock.calls.filter(([command]) => command === "read_conversation_proposal_work_plans").every(([, args]) => args.request.after === null)).toBe(true);
  expect(owner.getSnapshot().inputs.get(link.conversationId)?.value.text).toBe("Retained input B");
});
