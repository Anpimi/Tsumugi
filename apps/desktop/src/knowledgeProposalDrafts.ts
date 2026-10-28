import { commandFailure, type CommandFailure } from "./CommandFailure";
import { conversationCommands, type ConversationProposalRevision } from "./conversationCommands";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { jsonIdentity } from "./pluginToolChoices";
import type { ContextResourceRevision, ContextResourceScope } from "./resourceCommands";
import type { ResourceDraftState, ResourcePending } from "./ResourceDraftSession";

export type KnowledgeAdoptionPreview = Awaited<ReturnType<typeof conversationCommands.prepareKnowledgeAdoption>>;
export type KnowledgeDecisionRequest = Parameters<typeof conversationCommands.decideKnowledgeProposal>[0]["decision"];
export type KnowledgeDecisionReceipt = Awaited<ReturnType<typeof conversationCommands.decideKnowledgeProposal>>;
type Pending = Extract<ResourcePending, { kind: "knowledge-decision" }>;
export interface KnowledgeProposalDraft {
  key: string;
  proposal: KnowledgeAdoptionPreview["proposal"];
  entryIndex: number;
  entry: KnowledgeAdoptionPreview["entry"];
  locale: string;
  destination: "new" | "update" | "variant" | null;
  target: ContextResourceRevision | null;
  scope: ContextResourceScope | null;
  name: string;
  text: string;
  actor: string;
  reason: string;
  preview: KnowledgeAdoptionPreview | null;
  confirmWiderScope: boolean;
  editSeq: number;
  receipt: KnowledgeDecisionReceipt | null;
  recordedFields: string | null;
  failure: CommandFailure | null;
}
export type KnowledgeProposalFields = Pick<KnowledgeProposalDraft, "destination" | "target" | "scope" | "name" | "text" | "actor" | "reason" | "confirmWiderScope">;
export const knowledgeProposalKey = (proposal: KnowledgeProposalDraft["proposal"], index: number) => JSON.stringify([proposal.projectId, proposal.revisionId, index]);
export function knowledgeProposalFields(draft: KnowledgeProposalFields) {
  const identity = jsonIdentity({ destination: draft.destination, target: draft.target?.contextId ?? null, scope: draft.scope,
    name: draft.name, text: draft.text, actor: draft.actor, reason: draft.reason, confirmWiderScope: draft.confirmWiderScope });
  if (identity === undefined) throw new Error("Knowledge review fields are required"); return identity;
}
export function knowledgeProposalDirty(draft: KnowledgeProposalDraft) {
  return draft.recordedFields !== null ? draft.recordedFields !== knowledgeProposalFields(draft)
    : draft.destination !== null || draft.scope !== null || draft.name !== draft.entry.name || draft.text !== draft.entry.text || !!draft.actor || !!draft.reason;
}
export function knowledgeProposalTarget(draft: KnowledgeProposalDraft) {
  return { contextId: draft.destination === "update" ? draft.target?.contextId ?? null : null,
    ...(draft.destination === "variant" && draft.target ? { subjectId: draft.target.subjectId } : {}) };
}
export function knowledgeProposalComparison(draft: KnowledgeProposalDraft) {
  const identity = jsonIdentity({ proposal: draft.proposal, entryIndex: draft.entryIndex, destination: draft.destination, ...knowledgeProposalTarget(draft), scope: draft.scope });
  if (identity === undefined) throw new Error("A knowledge comparison is required"); return identity;
}
export function confirmKnowledgeDecision(state: ResourceDraftState, action: Pending, receipt: KnowledgeDecisionReceipt) {
  const request = action.request, draft = state.knowledgeDrafts[action.draftKey];
  if (!draft || receipt.actionId !== request.actionId || receipt.entryIndex !== request.entryIndex || receipt.decision !== request.decision || receipt.actor !== request.actor || receipt.reason !== request.reason
    || jsonIdentity(receipt.proposal) !== jsonIdentity(request.proposal)) throw new Error("Invalid knowledge decision association");
  if (request.decision === "adopt") {
    const resource = receipt.resource, adoption = request.adoption;
    if (!resource || !adoption || resource.actionId !== request.actionId || resource.projectId !== request.proposal.projectId || resource.kind !== draft.entry.kind || resource.locale !== draft.locale
      || resource.name !== adoption.name || resource.text !== adoption.text || resource.actor !== request.actor || resource.reason !== request.reason
      || resource.previousRevisionId !== (adoption.expectedRevisionId ?? null) || resource.withdrawn || jsonIdentity(resource.scope) !== jsonIdentity(adoption.scope)
      || adoption.contextId != null && resource.contextId !== adoption.contextId || adoption.subjectId != null && resource.subjectId !== adoption.subjectId
      || jsonIdentity(resource.sourceBasis) !== jsonIdentity(adoption.sourceBasis) || jsonIdentity(resource.proposalOrigin?.proposal) !== jsonIdentity(request.proposal)
      || resource.proposalOrigin?.entryIndex !== request.entryIndex) throw new Error("Invalid adopted knowledge resource");
  } else if (receipt.resource != null || request.adoption != null) throw new Error("A retained or rejected proposal cannot write a resource");
}
export function settleKnowledgeDecision(before: ResourceDraftState, action: Pending, receipt: KnowledgeDecisionReceipt): ResourceDraftState {
  if (before.pending !== action) return before;
  confirmKnowledgeDecision(before, action, receipt);
  const draft = before.knowledgeDrafts[action.draftKey];
  return { ...before, knowledgeDrafts: { ...before.knowledgeDrafts, [draft.key]: { ...draft, receipt, recordedFields: action.submittedFields, failure: null } },
    pending: null, pendingUncertain: false, pendingRecorded: false, pendingCheckedMissing: false, checkingAction: null, failure: null, notice: null, completionVersion: before.completionVersion + 1 };
}

/** Review input shares the original resource action owner and project lifetime. */
export function createKnowledgeProposalMethods(access: {
  session: SessionRequest; live: () => boolean; current: () => ResourceDraftState; update: (change: (before: ResourceDraftState) => ResourceDraftState) => void;
  reserve: () => boolean; release: () => void; dispatch: (action: Pending) => Promise<void>;
}) {
  const { current, update } = access;
  function patch(key: string, change: (draft: KnowledgeProposalDraft) => KnowledgeProposalDraft) {
    update(before => before.knowledgeDrafts[key] ? { ...before, knowledgeDrafts: { ...before.knowledgeDrafts, [key]: change(before.knowledgeDrafts[key]) } } : before);
  }
  function begin(revision: ConversationProposalRevision, entryIndex: number, locale: string) {
    if (!access.live() || revision.projectId !== access.session.projectId || revision.content.kind !== "knowledge-proposal" || !revision.content.entries[entryIndex]) return null;
    const proposal = { projectId: revision.projectId, conversationId: revision.conversationId, proposalId: revision.proposalId, revisionId: revision.revisionId }, key = knowledgeProposalKey(proposal, entryIndex);
    if (!current().knowledgeDrafts[key]) {
      const entry = structuredClone(revision.content.entries[entryIndex]);
      const draft: KnowledgeProposalDraft = { key, proposal, entryIndex, entry, locale, destination: null, target: null, scope: null, name: entry.name, text: entry.text,
        actor: "", reason: "", preview: null, confirmWiderScope: false, editSeq: 0, receipt: null, recordedFields: null, failure: null };
      update(before => ({ ...before, knowledgeDrafts: { ...before.knowledgeDrafts, [key]: draft } }));
    }
    activate(key); return key;
  }
  function activate(key: string) { if (current().knowledgeDrafts[key]) update(before => ({ ...before, knowledgeActiveKey: key })); }
  function edit(key: string, values: Partial<KnowledgeProposalFields>) {
    patch(key, draft => ({ ...draft, ...values, ...(values.destination !== undefined || values.target !== undefined || values.scope !== undefined ? { preview: null, confirmWiderScope: false } : {}), editSeq: draft.editSeq + 1, failure: null }));
  }
  function compare(key: string, preview: KnowledgeAdoptionPreview, expected: string) {
    const draft = current().knowledgeDrafts[key];
    if (!draft || current().pending || current().busyMutation || draft.receipt || knowledgeProposalComparison(draft) !== expected
      || jsonIdentity(preview.proposal) !== jsonIdentity(draft.proposal) || preview.entryIndex !== draft.entryIndex || jsonIdentity(preview.entry) !== jsonIdentity(draft.entry)
      || jsonIdentity(preview.scope) !== jsonIdentity(draft.scope) || preview.current?.contextId !== (knowledgeProposalTarget(draft).contextId ?? undefined)) return false;
    patch(key, value => ({ ...value, preview: structuredClone(preview), confirmWiderScope: false, failure: null })); return true;
  }
  function discard(key: string) {
    const pending = current().pending;
    if (current().busyMutation || pending?.kind === "knowledge-decision" && pending.draftKey === key) return false;
    update(before => { const drafts = { ...before.knowledgeDrafts }; delete drafts[key]; return { ...before, knowledgeDrafts: drafts, knowledgeActiveKey: before.knowledgeActiveKey === key ? null : before.knowledgeActiveKey }; }); return true;
  }
  async function decide(key: string, decision: KnowledgeDecisionRequest["decision"], proof: () => boolean) {
    const draft = current().knowledgeDrafts[key];
    if (!draft || draft.receipt || !proof() || decision === "adopt" && !draft.preview || !access.reserve()) return;
    const start = structuredClone(draft);
    try {
      const actionId = await executionCommands.identity(access.session);
      if (!access.live() || !proof() || !current().knowledgeDrafts[key]) return;
      const preview = start.preview;
      const request: KnowledgeDecisionRequest = { actionId, proposal: start.proposal, entryIndex: start.entryIndex, decision, actor: start.actor, reason: start.reason,
        adoption: decision === "adopt" && preview ? { ...knowledgeProposalTarget(start), expectedRevisionId: preview.current?.revisionId ?? null, scope: preview.scope,
          sourceBasis: preview.sourceBasis, name: start.name, text: start.text, comparisonBasis: preview.basis, confirmWiderScope: start.confirmWiderScope } : null };
      await access.dispatch({ kind: "knowledge-decision", session: access.session, request, draftKey: key, submittedSeq: start.editSeq, submittedFields: knowledgeProposalFields(start) });
    } catch (error) { patch(key, value => ({ ...value, failure: commandFailure(error) })); }
    finally { access.release(); }
  }
  return { begin, activate, edit, compare, discard, decide, hasDrafts: () => Object.values(current().knowledgeDrafts).some(knowledgeProposalDirty) };
}
