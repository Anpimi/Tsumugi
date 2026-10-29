import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { conversationTeamQuestionsEn } from "../../../i18n/conversationTeamQuestions";
import { canonicalConversationDraft, type ConversationDraftHead, type conversationDraftCommands } from "../../../conversationDraftCommands";
import { validateResponseConversationWritten } from "../../../generated/draft.validators";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamExecutionViewFixture } from "../../../testSupport/teamExecutionFixture";
import { teamQuestionNavigationFixture } from "../../../testSupport/teamQuestionNavigationFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ConversationSession } from "./ConversationSession";
import { ConversationTeamQuestions } from "./ConversationTeamQuestions";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type TextKey = keyof typeof conversationTeamQuestionsEn;
const t = (key: TextKey) => i18n.t(`conversationTeamQuestions.${key}`);
type Ports = NonNullable<ConstructorParameters<typeof ConversationSession>[3]>;
type Port<K extends keyof Ports> = NonNullable<Ports[K]>;
type Write = Parameters<typeof conversationDraftCommands.write>[0]["write"];
type Props = Omit<Parameters<typeof ConversationTeamQuestions>[0], "input">;
const disposals: (() => void)[] = [];
beforeEach(() => { invoke.mockReset(); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });
function SessionQuestionPanel(props: Props) {
  const snapshot = useSyncExternalStore(props.owner.subscribe, props.owner.getSnapshot, props.owner.getSnapshot);
  const input = snapshot.inputs.get(props.link.conversationId);
  if (!input) throw new Error("Missing synthetic conversation input");
  return <ConversationTeamQuestions {...props} input={input}/>;
}
async function harness() {
  const h = teamQuestionNavigationFixture(), reads = new SessionReads(h.context), gate = new InteractionGate();
  gate.setVisibleOwner("conversation"); h.status.plan.options.teamQuestions = { profile: "current-plan-1" };
  h.status.state = "stopped"; h.status.expiresAt = "1";
  let identity = 68801;
  let head: ConversationDraftHead = { key: { projectId: h.context.projectId, conversationId: h.link.conversationId }, revision: "1", writerId: id(68800),
    value: { text: "Independent unsent composer", editSeq: "1", pending: null } };
  const commit = async (write: Write) => {
    const value = { key: write.key, revision: String(BigInt(head.revision) + 1n), writerId: write.writerId,
      value: canonicalConversationDraft(structuredClone(write.value)) };
    if (!validateResponseConversationWritten(value)) throw new Error("Invalid synthetic question input");
    head = value; return structuredClone(head);
  };
  const respond = vi.fn<Port<"respondTeamQuestion">>(async request => {
    expect(head.value?.pending).toMatchObject({ kind: "team-question-response", request: { projectId: request.projectId, planId: request.planId, response: request.response } });
    const response = request.response.response, event = h.question.question.publication.question;
    const selected = response.kind === "choice" && event?.kind === "open" ? event.options.find(option => option.optionId === response.optionId) : null;
    return { planId: h.link.planId, sequence: String(BigInt(h.question.question.sequence) + 1n), author: { kind: "local-human", actor: "local-user" },
      publication: { postId: request.response.postId, target: h.question.question.publication.target, kind: "human-question", references: [],
        replyTo: request.response.questionPostId, supersedes: null,
        body: response.kind === "text" ? response.body : selected?.label ?? "",
        question: { kind: "resolve", questionPostId: request.response.questionPostId,
          answer: response.kind === "choice" ? { kind: "choice", optionId: response.optionId } : { kind: "text" } } } };
  });
  const owner = new ConversationSession(h.context, vi.fn(), vi.fn(), {
    identity: () => id(identity++), read: async () => structuredClone(head), write: async request => commit(request.write),
    resolve: async request => commit(request.resolve.write),
    readProposalWorkPlan: async () => structuredClone(h.link), readTeamQuestion: async () => structuredClone(h.question), respondTeamQuestion: respond,
  });
  expect(await owner.open(h.link.conversationId)).toBe(true);
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_work_plan_team_questions") return { planId: h.link.planId, questions: [structuredClone(h.question)], nextAfter: null };
    if (command === "read_work_plan_team_execution") return teamExecutionViewFixture();
    throw new Error(`Unexpected dispatch or external request: ${command}`);
  });
  render(<SessionReadProvider context={h.context} reads={reads} bridge={false}>
    <SessionQuestionPanel owner={owner} link={h.link} status={h.status} visible disabled={false} current={() => true} gate={gate} viewId="conversation"/>
  </SessionReadProvider>);
  disposals.push(() => { owner.retire(); reads.retire(); gate.dispose(); });
  return { ...h, owner, respond, head: () => head };
}

describe("local answers in the member question panel", () => {
  it.each([
    { language: "en-US", mode: "text", saveLabel: "Save this answer" },
    { language: "zh-CN", mode: "choice", saveLabel: "保存这条答复" },
  ] as const)("saves a $mode answer through the real session owner in $language", async ({ language, mode, saveLabel }) => {
    await i18n.changeLanguage(language); const h = await harness();
    const show = screen.getByRole("button", { name: t("show") });
    expect(show).toHaveAttribute("aria-expanded", "false"); expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(show); await screen.findByText(h.question.question.publication.body);
    fireEvent.click(screen.getByRole("button", { name: t("edit") }));
    const answer = await screen.findByRole("textbox", { name: t("body") });
    fireEvent.change(answer, { target: { value: "My original wording {{name}} 中文" } });
    const event = h.question.question.publication.question;
    if (event?.kind !== "open") throw new Error("Missing explicit question options");
    const option = event.options[0];
    if (mode === "choice") {
      fireEvent.click(screen.getByRole("radio", { name: option.label }));
      expect(screen.getByRole("radio", { name: option.label })).toBeChecked();
      expect(answer).toHaveValue("My original wording {{name}} 中文");
    }
    await act(async () => { await h.owner.flush(); });
    const save = screen.getByRole("button", { name: t("save") });
    expect(save).toHaveTextContent(saveLabel); expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(h.respond).toHaveBeenCalledOnce());
    await waitFor(() => expect(h.owner.getSnapshot().inputs.get(h.link.conversationId)?.value.pending).toBeNull());
    expect(h.respond.mock.calls[0][0].response.response).toEqual(mode === "choice" ? { kind: "choice", optionId: option.optionId }
      : { kind: "text", body: "My original wording {{name}} 中文" });
    expect(h.owner.teamDraft(h.link.conversationId, h.link.planId)?.questions ?? []).toHaveLength(0);
    expect(h.head().value?.text).toBe("Independent unsent composer");
    expect(invoke.mock.calls.every(([command]) => command === "read_work_plan_team_questions" || command === "read_work_plan_team_execution")).toBe(true);
  });
});
