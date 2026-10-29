import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { installResourceDraftFixture } from "../../../testSupport/resourceDraftFixture";
import type { knowledgeEn } from "../../../i18n/knowledge";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ConversationKnowledgeDecision, DecideConversationKnowledgeProposal } from "../../../conversationCommands";
import type { ContextResourceRevision } from "../../../resourceCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { TranslationDraftSession } from "../../../TranslationDraftSession";
import { ExecutionTaskSession } from "../../../ExecutionTaskSession";
import { contextResourceFixture } from "../../../testSupport/contextResourceFixture";
import { knowledgeProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { sourceContentFixture } from "../../../testSupport/sourceFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { makeWorkspaceView, type ViewPatch } from "../../workspace/workspaceStore";
import KnowledgeOwnerHost from "./KnowledgeOwnerHost";
import KnowledgeView from "./KnowledgeView";
import type { KnowledgeOwner } from "./knowledgeTypes";
import type { KnowledgeReviewTarget } from "./KnowledgeProposalPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
type Key = { [K in keyof typeof knowledgeEn]: typeof knowledgeEn[K] extends string ? K : never }[keyof typeof knowledgeEn];
const k = (key: Key) => i18n.t(`knowledge.${key}`);
const project: ProjectView = { sessionToken: "synthetic-knowledge-proposal", locator: "/synthetic/knowledge-proposal", reconciliationState: "settled",
  metadata: { projectId: id(74000), displayName: "Knowledge review", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let fixture: ReturnType<typeof knowledgeProposalFixture>, source: { revision: string; currentSnapshot: string }, serial: number;
let resources: Map<string, ContextResourceRevision>, decisions: Map<number, ConversationKnowledgeDecision>, requests: Map<string, DecideConversationKnowledgeProposal>;
let submit: (request: DecideConversationKnowledgeProposal) => Promise<ConversationKnowledgeDecision>;
let reads: SessionReads, gate: InteractionGate, lifecycle: ProjectLifecycle, owner: KnowledgeOwner | null;
function commit(request: DecideConversationKnowledgeProposal): ConversationKnowledgeDecision {
  const adoption = request.adoption, contextId = adoption?.contextId ?? id(++serial), prior = resources.get(contextId);
  const resource: ContextResourceRevision | null = request.decision === "adopt" && adoption ? { ...contextResourceFixture(), contextId,
    projectId: project.metadata.projectId, subjectId: adoption.subjectId ?? prior?.subjectId ?? contextId, actionId: request.actionId, revisionId: id(++serial), previousRevisionId: adoption.expectedRevisionId ?? null,
    scope: adoption.scope, sourceBasis: { revision: adoption.sourceBasis.revision, currentSnapshot: adoption.sourceBasis.currentSnapshot ?? null },
    actor: request.actor, reason: request.reason, name: adoption.name, text: adoption.text, proposalOrigin: { proposal: request.proposal, entryIndex: request.entryIndex, modelOrigin: fixture.revision.origin } } : null;
  if (resource) resources.set(contextId, resource);
  const receipt: ConversationKnowledgeDecision = { actionId: request.actionId, proposal: request.proposal, entryIndex: request.entryIndex, decision: request.decision,
    actor: request.actor, reason: request.reason, resource };
  requests.set(request.actionId, structuredClone(request)); decisions.set(request.entryIndex, receipt); return receipt;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); serial = 74100; owner = null;
  fixture = knowledgeProposalFixture({ projectId: project.metadata.projectId, conversationId: id(74001) });
  fixture.revision.content = { kind: "knowledge-proposal", summary: "Knowledge from source entries", questions: [], entries: [
    { kind: "character", name: "Mara", text: "Calm original model content", unitIds: [fixture.unitIds[0]] },
    { kind: "background", name: "Dawn", text: "A quiet morning", unitIds: [fixture.unitIds[1]] },
  ] };
  if (!fixture.run.output) throw new Error("A model output fixture is required"); fixture.run.output.model = structuredClone(fixture.revision.content);
  source = { revision: "1", currentSnapshot: fixture.run.preview.units[0].sourceSnapshotId };
  resources = new Map(); decisions = new Map(); requests = new Map(); submit = async request => commit(request);
  reads = new SessionReads(executionContext(project)); gate = new InteractionGate(); gate.setVisibleOwner("knowledge-review");
  lifecycle = new ProjectLifecycle({ open: async () => project, createReads: () => reads, close: async () => ({ closed: true }), status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) }); await lifecycle.open(project.locator);
  invoke.mockReset(); invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "read_conversation_proposal") return structuredClone(fixture.revision);
    if (command === "read_conversation_planning") return structuredClone(fixture.run);
    if (command === "read_conversation_knowledge_decision") return structuredClone(decisions.get(request.entryIndex) ?? null);
    if (command === "preview_conversation_knowledge_adoption") {
      const target = request.adoption, current = target.contextId ? resources.get(target.contextId) : null;
      if (fixture.revision.content.kind !== "knowledge-proposal") throw new Error("Knowledge fixture required");
      return { proposal: target.proposal, entryIndex: target.entryIndex, entry: fixture.revision.content.entries[target.entryIndex], current: current ?? null,
        scope: target.scope, sourceBasis: structuredClone(source), basis: (++serial).toString(16).padStart(64, "0"), requiresWiderConfirmation: target.scope.kind !== "unit" };
    }
    if (command === "decide_conversation_knowledge_proposal") return submit(request.decision);
    if (command === "read_conversation_knowledge_decision_action") return requests.has(request.decision.actionId) ? structuredClone(decisions.get(request.decision.entryIndex)) : null;
    if (command === "recover_conversation_knowledge_decision") return { request: structuredClone(request.decision), outcome: requests.has(request.decision.actionId)
      ? { kind: "recorded", receipt: structuredClone(decisions.get(request.decision.entryIndex)) } : { kind: "pending", replay: "explicit-same-request" } };
    if (command === "read_content_scope") return structuredClone(source);
    if (command === "read_source_content") return sourceContentFixture(source.currentSnapshot, source);
    if (command === "read_context_resource_current") return structuredClone(resources.get(request.contextId) ?? null);
    if (command === "read_context_resource_page") return { rows: structuredClone([...resources.values()].filter(row => row.kind === request.kind)), nextOffset: null, basis: "synthetic-resources" };
    if (command === "create_execution_identity") return id(++serial);
    throw new Error(`Unexpected knowledge review command: ${command}`);
  });
});
afterEach(() => { cleanup(); lifecycle.dispose(); reads.retire(); gate.dispose(); });
function Shell() {
  const [value, setValue] = useState<KnowledgeOwner | null>(null), [view, setView] = useState(() => makeWorkspaceView({ kind: "knowledge", locale: "zh-CN", preset: "characters" }, "knowledge-review"));
  const [target, setTarget] = useState<KnowledgeReviewTarget | null>(() => ({ proposal: { projectId: project.metadata.projectId, conversationId: fixture.revision.conversationId,
    proposalId: fixture.revision.proposalId, revisionId: fixture.revision.revisionId }, entryIndex: 0 }));
  const publish = useCallback((next: KnowledgeOwner | null) => { owner = next; setValue(next); }, []);
  return <><KnowledgeOwnerHost project={project} lifecycle={lifecycle} onOwner={publish} onReveal={() => {}}/>{value ? <KnowledgeView project={project} owner={value} view={view} disabled={false} gate={gate}
    current={dialogId => gate.canDispatch({ viewId: view.id, source: "button", dialogId })} patch={(patch: ViewPatch) => setView(value => ({ ...value, ...patch }))} onDetails={() => {}}
    reviewTarget={target} onReviewOpened={() => setTarget(null)}/> : null}</>;
}
async function open() {
  installResourceDraftFixture();
  const view = render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}><TranslationDraftSession project={project}><ExecutionTaskSession project={project}><Shell/></ExecutionTaskSession></TranslationDraftSession></SessionReadProvider>);
  const user = userEvent.setup(); await screen.findByRole("textbox", { name: k("reviewText") }); return { user, view };
}
function audit(reason = "Reviewed the original result") { fireEvent.change(screen.getByRole("textbox", { name: k("contextActor") }), { target: { value: "Human reviewer" } }); fireEvent.change(screen.getByRole("textbox", { name: k("reason") }), { target: { value: reason } }); }
async function compareNew(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: i18n.t("knowledge.reviewDestinationKinds.new") }));
  const scope = screen.getByRole("button", { name: k("changeScope") }); await waitFor(() => expect(scope).toBeEnabled()); await user.click(scope); audit();
  await waitFor(() => expect(screen.getByRole("button", { name: k("reviewCompare") })).toBeEnabled()); await user.click(screen.getByRole("button", { name: k("reviewCompare") })); await screen.findByText(k("reviewNewConfirmed"));
}
async function adopt(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("checkbox", { name: k("reviewWiderConfirm") })); await user.click(screen.getByRole("button", { name: k("reviewAdopt") }));
  const dialog = await screen.findByRole("dialog", { name: k("reviewConfirmTitle") }); await user.click(within(dialog).getByRole("button", { name: k("reviewAdopt") }));
}

it.each(["en-US", "zh-CN"])("adopts edited content only through an explicit destination, comparison and wider-scope confirmation in %s", async locale => {
  await i18n.changeLanguage(locale); const { user } = await open(); await compareNew(user);
  expect(screen.getByRole("button", { name: k("reviewAdopt") })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: k("reviewText") }), { target: { value: "Human-edited content 保留原文" } }); await adopt(user);
  await screen.findByText(i18n.t("knowledge.reviewDecisions.adopt"));
  expect([...resources.values()][0]).toMatchObject({ name: "Mara", text: "Human-edited content 保留原文", actor: "Human reviewer", proposalOrigin: { entryIndex: 0, proposal: { revisionId: fixture.revision.revisionId } } });
  expect(invoke.mock.calls.filter(([name]) => name === "save_context_resource")).toHaveLength(0);
});

it("keeps B and the original pending action after a pure positive receipt until explicit recovery", async () => {
  let release: () => void = () => { throw new Error("A decision must be pending"); };
  const hold = new Promise<void>(resolve => { release = resolve; }); submit = async request => { await hold; commit(request); throw { outcome: "unknown" }; };
  const { user } = await open(); await compareNew(user); await adopt(user);
  await waitFor(() => expect(owner?.current().pending?.kind).toBe("knowledge-decision"));
  fireEvent.change(screen.getByRole("textbox", { name: k("reviewText") }), { target: { value: "Retained B 不翻译" } });
  await act(async () => { expect(await lifecycle.close()).toBe(false); release(); }); await screen.findByText(k("contextRecordFound"));
  expect(owner?.current().pending?.kind).toBe("knowledge-decision"); expect(owner?.current().pendingCheckedMissing).toBe(false);
  expect(screen.queryByRole("button", { name: k("retryAction") })).toBeNull();
  await act(async () => { await i18n.changeLanguage("zh-CN"); }); expect(screen.getByRole("textbox", { name: k("reviewText") })).toHaveValue("Retained B 不翻译");
  await user.click(screen.getByRole("button", { name: k("checkAction") })); await screen.findByText(i18n.t("knowledge.reviewDecisions.adopt"));
  expect(owner?.current().pending).toBeNull(); expect(screen.getByRole("textbox", { name: k("reviewText") })).toHaveValue("Retained B 不翻译");
  expect(invoke.mock.calls.filter(([name]) => name === "decide_conversation_knowledge_proposal")).toHaveLength(1);
});

it("recompares an explicit target after its version changes while preserving input, then blocks changed source", async () => {
  const saved = contextResourceFixture({ projectId: project.metadata.projectId, sourceBasis: source }); resources.set(saved.contextId, saved);
  const { user } = await open(); await user.click(screen.getByRole("button", { name: i18n.t("knowledge.reviewDestinationKinds.update") }));
  const panel = screen.getByRole("region", { name: k("reviewTitle") }); await user.click(await within(panel).findByRole("button", { name: "Mara" })); audit();
  await waitFor(() => expect(screen.getByRole("button", { name: k("reviewCompare") })).toBeEnabled()); await user.click(screen.getByRole("button", { name: k("reviewCompare") }));
  await screen.findByRole("region", { name: k("comparison") }); fireEvent.change(screen.getByRole("textbox", { name: k("reviewText") }), { target: { value: "Keep my edited B" } });
  resources.set(saved.contextId, { ...saved, revisionId: id(++serial), text: "Current external change" }); act(() => reads.invalidate(["resources"]));
  await screen.findByText(k("reviewComparisonChanged")); expect(screen.getByRole("button", { name: k("reviewAdopt") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: k("reviewCompare") })); expect(await within(screen.getByRole("region", { name: k("comparison") })).findByText("Current external change")).toBeVisible();
  expect(screen.getByRole("textbox", { name: k("reviewText") })).toHaveValue("Keep my edited B");
  source = { revision: "2", currentSnapshot: id(++serial) }; act(() => reads.invalidate(["source"])); await screen.findByText(k("reviewSourceChanged"));
  expect(screen.getByRole("button", { name: k("reviewCompare") })).toBeDisabled(); expect(screen.getByRole("textbox", { name: k("reviewText") })).toHaveValue("Keep my edited B");
});

it("records keep and reject independently without writing project resources", async () => {
  const { user } = await open(); audit("Keep the project unchanged"); await user.click(screen.getByRole("button", { name: k("reviewKeep") })); await screen.findByText(i18n.t("knowledge.reviewDecisions.keep"));
  await user.click(screen.getByRole("button", { name: i18n.t("knowledge.reviewItem", { number: 2, name: "Dawn" }) })); audit("Reject this unsupported background");
  await user.click(screen.getByRole("button", { name: k("reviewReject") })); await screen.findByText(i18n.t("knowledge.reviewDecisions.reject"));
  expect([...decisions.values()].map(value => value.decision)).toEqual(["keep", "reject"]); expect(resources.size).toBe(0);
  expect(decisions.get(1)).toMatchObject({ actor: "Human reviewer", reason: "Reject this unsupported background", entryIndex: 1, resource: null });
});
