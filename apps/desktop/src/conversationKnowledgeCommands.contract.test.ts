import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/conversationKnowledge.contract.json";
import { conversationCommands } from "./conversationCommands";
import { resourceCommands } from "./resourceCommands";
import { validateRequestKnowledgeAdoption, validateRequestKnowledgeDecision, validateRequestKnowledgeDecisionRead,
  validateResponseKnowledgeAdoption, validateResponseKnowledgeDecision } from "./generated/conversations.validators";
import { validateResponseContextResourceAction } from "./generated/resource.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

function data() {
  const preview: unknown = structuredClone(fixture.requests.preview), decision: unknown = structuredClone(fixture.requests.decision);
  const read: unknown = structuredClone(fixture.requests.read), compared: unknown = structuredClone(fixture.responses.preview);
  const receipt: unknown = structuredClone(fixture.responses.decision);
  if (!validateRequestKnowledgeAdoption(preview) || !validateRequestKnowledgeDecision(decision)
    || !validateRequestKnowledgeDecisionRead(read) || !validateResponseKnowledgeAdoption(compared)
    || !validateResponseKnowledgeDecision(receipt)) throw new Error("Invalid shared knowledge fixture");
  return { preview, decision, read, compared, receipt };
}

it("binds the shared human decision and model origin across all five calls", async () => {
  const { preview, decision, read, compared, receipt } = data();
  invoke.mockResolvedValueOnce(compared).mockResolvedValueOnce(receipt).mockResolvedValueOnce(receipt)
    .mockResolvedValueOnce(receipt).mockResolvedValueOnce(fixture.responses.recovery);
  await expect(conversationCommands.prepareKnowledgeAdoption(preview)).resolves.toEqual(compared);
  await expect(conversationCommands.decideKnowledgeProposal(decision)).resolves.toEqual(receipt);
  await expect(conversationCommands.readKnowledgeDecision(read)).resolves.toEqual(receipt);
  await expect(conversationCommands.knowledgeDecisionReceipt(decision)).resolves.toEqual(receipt);
  await expect(conversationCommands.recoverKnowledgeDecision(decision)).resolves.toEqual(fixture.responses.recovery);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["preview_conversation_knowledge_adoption", "decide_conversation_knowledge_proposal",
    "read_conversation_knowledge_decision", "read_conversation_knowledge_decision_action", "recover_conversation_knowledge_decision"]);
  expect(receipt.resource?.text).toBe("Human edited {{name}} — é 👩🏽‍💻");
  expect(receipt.resource?.sourceBasis.revision).toBe("9007199254740993");
});

it.each(["proposal", "entry", "scope", "current", "basis"])("rejects a comparison for another %s", async kind => {
  const { preview, compared } = data();
  if (kind === "proposal") compared.proposal.revisionId = compared.proposal.proposalId;
  if (kind === "entry") compared.entryIndex++;
  if (kind === "scope") compared.scope = { kind: "project" };
  if (kind === "current") compared.current = data().receipt.resource;
  if (kind === "basis") compared.basis = "not-a-comparison";
  invoke.mockResolvedValueOnce(compared);
  await expect(conversationCommands.prepareKnowledgeAdoption(preview)).rejects.toThrow("Invalid IPC response");
  expect(invoke).toHaveBeenCalledOnce();
});

it.each(["proposal", "entry", "action", "actor", "reason", "text", "scope", "origin", "digest"])("rejects an adopted receipt with a changed %s", async kind => {
  const { decision, receipt } = data();
  if (!receipt.resource) throw new Error("Expected adopted fixture");
  if (kind === "proposal") receipt.proposal.revisionId = receipt.proposal.proposalId;
  if (kind === "entry") receipt.entryIndex++;
  if (kind === "action") receipt.actionId = receipt.proposal.proposalId;
  if (kind === "actor") receipt.actor = "Another reviewer";
  if (kind === "reason") receipt.reason = "Another reason";
  if (kind === "text") receipt.resource.text = "Other saved text";
  if (kind === "scope") receipt.resource.scope = { kind: "project" };
  if (kind === "origin") receipt.resource.proposalOrigin = undefined;
  if (kind === "digest" && receipt.resource.proposalOrigin) receipt.resource.proposalOrigin.modelOrigin.resultDigest = "changed";
  invoke.mockResolvedValueOnce(receipt);
  await expect(conversationCommands.decideKnowledgeProposal(decision)).rejects.toThrow("Invalid IPC response");
  expect(invoke).toHaveBeenCalledOnce();
});

it.each(["keep", "reject"] as const)("records %s with the original reviewer and no resource write", async kind => {
  const { decision, receipt } = data();
  decision.decision.decision = kind; decision.decision.adoption = null;
  receipt.decision = kind; receipt.resource = null;
  invoke.mockResolvedValueOnce(receipt);
  await expect(conversationCommands.decideKnowledgeProposal(decision)).resolves.toEqual(receipt);
});

it("keeps pure absence separate from explicit pending recovery and rejects a changed original request", async () => {
  const { decision, read } = data();
  invoke.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(fixture.responses.pending);
  await expect(conversationCommands.readKnowledgeDecision(read)).resolves.toBeNull();
  await expect(conversationCommands.knowledgeDecisionReceipt(decision)).resolves.toBeNull();
  await expect(conversationCommands.recoverKnowledgeDecision(decision)).resolves.toEqual(fixture.responses.pending);
  const forged = structuredClone(fixture.responses.pending); forged.request.adoption.text = "Input B";
  invoke.mockResolvedValueOnce(forged);
  await expect(conversationCommands.recoverKnowledgeDecision(decision)).rejects.toThrow("Invalid IPC response");
  expect(invoke.mock.calls.some(([name]) => name === "decide_conversation_knowledge_proposal")).toBe(false);
});

it("reads the causal resource reference without granting recovery from its reduced request", async () => {
  const { decision, receipt } = data();
  const causal: unknown = { request: fixture.causal, receipt: receipt.resource };
  if (!validateResponseContextResourceAction(causal) || !causal) throw new Error("Invalid causal fixture");
  invoke.mockResolvedValueOnce(causal);
  await expect(resourceCommands.contextResourceAction({ projectId: decision.projectId, sessionToken: decision.sessionToken,
    actionId: receipt.actionId })).resolves.toEqual(causal);
  invoke.mockResolvedValueOnce({ request: causal.request, receipt: null, status: "retry-allowed" });
  await expect(resourceCommands.reconcileContextResourceAction({ projectId: decision.projectId,
    sessionToken: decision.sessionToken, action: causal.request })).rejects.toThrow("Invalid IPC response");
});
