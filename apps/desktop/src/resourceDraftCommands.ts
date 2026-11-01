import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import type { Requests } from "./generated/draft.requests";
import type { ResourceDraftHead, ResourceDraftValue, ResourceDraftPending, ResourceFactPending } from "./generated/draft.responses";
import { validateResponseResourceRead, validateResponseResourceWritten, validateResponseResourceResolved,
  validateResponseResourceCleared, validateResponseResourceValue } from "./generated/draft.validators";

export type { ResourceDraftHead, ResourceDraftValue, ResourceDraftPending, ResourceFactPending } from "./generated/draft.responses";
export type ResourceDraftDisposition = Requests["resourceResolve"]["resolve"]["disposition"];
export type ResourceDraftResolveTarget =
  | { kind: "primary"; pending: ResourceDraftPending }
  | { kind: "fact"; pending: ResourceFactPending };
type Input = Requests["resourceWrite"]["write"]["value"];
const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
const maxBytes = 4 * 1024 * 1024 + 256 * 1024;
const safeSequence = (value: string) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const bytes = new TextEncoder();

/** Complete Serde's nullable input fields without changing user content. */
function canonicalPending(value: Input["pending"]) {
  if (value == null) return null;
  switch (value.kind) {
    case "typed-context-save": return { ...value, request: { ...value.request,
      contextId: value.request.contextId ?? null, subjectId: value.request.subjectId ?? null,
      expectedRevisionId: value.request.expectedRevisionId ?? null,
      sourceBasis: { ...value.request.sourceBasis, currentSnapshot: value.request.sourceBasis.currentSnapshot ?? null } } };
    case "knowledge-decision": return { ...value, request: { ...value.request, adoption: value.request.adoption == null ? null : {
      ...value.request.adoption, contextId: value.request.adoption.contextId ?? null,
      subjectId: value.request.adoption.subjectId ?? null, expectedRevisionId: value.request.adoption.expectedRevisionId ?? null,
      sourceBasis: { ...value.request.adoption.sourceBasis, currentSnapshot: value.request.adoption.sourceBasis.currentSnapshot ?? null },
    } } };
    case "term": return { ...value, request: { ...value.request, termId: value.request.termId ?? null,
      scopeUnitId: value.request.scopeUnitId ?? null, expectedRevisionId: value.request.expectedRevisionId ?? null } };
    case "context": return { ...value, request: { ...value.request, expectedRevisionId: value.request.expectedRevisionId ?? null } };
    case "decision": {
      const { editedTarget, ...request } = value.request;
      return { ...value, request: { ...request, expectedRevisionId: request.expectedRevisionId ?? null,
        ...(editedTarget == null ? {} : { editedTarget }) } };
    }
    default: return value;
  }
}

export function canonicalResourceDraft(input: Input): ResourceDraftValue {
  const { proposalEditDraft, ...original } = input;
  const value = {
    ...original, ...(proposalEditDraft == null ? {} : { proposalEditDraft: { ...proposalEditDraft, expectedRevisionId: proposalEditDraft.expectedRevisionId ?? null, currentTarget: proposalEditDraft.currentTarget ?? null } }), selectedTerm: input.selectedTerm ?? null, selectedUnit: input.selectedUnit ?? null,
    termDraft: { ...input.termDraft, scopeUnitId: input.termDraft.scopeUnitId ?? null },
    contextRevision: input.contextRevision ?? null, correctionDraft: input.correctionDraft ?? null,
    factDraft: input.factDraft == null ? null : { ...input.factDraft, expectedDecisionId: input.factDraft.expectedDecisionId ?? null },
    typedDrafts: input.typedDrafts.map(draft => ({ ...draft, contextId: draft.contextId ?? null,
      subjectId: draft.subjectId ?? null, base: draft.base ?? null,
      sourceBasis: { ...draft.sourceBasis, currentSnapshot: draft.sourceBasis.currentSnapshot ?? null } })),
    typedActiveKey: input.typedActiveKey ?? null,
    knowledgeDrafts: input.knowledgeDrafts.map(draft => ({ ...draft, destination: draft.destination ?? null,
      target: draft.target ?? null, scope: draft.scope ?? null, receipt: draft.receipt ?? null, recordedFields: draft.recordedFields ?? null })),
    knowledgeActiveKey: input.knowledgeActiveKey ?? null, previewCaptureId: input.previewCaptureId ?? null,
    fixedContextId: input.fixedContextId ?? null, pending: canonicalPending(input.pending),
    factPending: input.factPending == null ? null : { ...input.factPending,
      request: { ...input.factPending.request, expectedDecisionId: input.factPending.request.expectedDecisionId ?? null } },
  };
  if (!validateResponseResourceValue(value)) throw new Error("Invalid local resource input");
  return value;
}

export function resourcePendingProject(pending: ResourceDraftPending) {
  return pending.kind === "knowledge-decision" ? pending.request.proposal.projectId
    : pending.kind === "correction" ? pending.request.basis.projectId : pending.request.projectId;
}

function related(value: ResourceDraftValue, projectId: string) {
  const within = (sequence: string) => safeSequence(sequence) && BigInt(sequence) <= BigInt(value.editSeq);
  const typed = value.typedDrafts, knowledge = value.knowledgeDrafts, pending = value.pending;
  return (value.proposalEditDraft == null || within(value.proposalEditDraft.editSeq) && value.proposalEditDraft.locale === value.locale
    && value.proposalEditDraft.captureId === value.previewCaptureId) && safeSequence(value.editSeq) && within(value.termSeq) && within(value.contextSeq)
    && !(pending && value.factPending)
    && new Set(typed.map(draft => draft.key)).size === typed.length
    && new Set(knowledge.map(draft => draft.key)).size === knowledge.length
    && (value.typedActiveKey === null || typed.some(draft => draft.key === value.typedActiveKey))
    && (value.knowledgeActiveKey === null || knowledge.some(draft => draft.key === value.knowledgeActiveKey))
    && typed.every(draft => within(draft.editSeq) && (draft.base === null || draft.base.projectId === projectId
      && draft.base.contextId === draft.contextId && draft.base.kind === draft.kind && draft.base.locale === draft.locale))
    && knowledge.every(draft => within(draft.editSeq) && draft.proposal.projectId === projectId
      && (draft.target === null || draft.target.projectId === projectId)
      && (draft.receipt === null || same(draft.receipt.proposal, draft.proposal) && draft.receipt.entryIndex === draft.entryIndex))
    && (value.correctionDraft === null || within(value.correctionDraft.editSeq) && value.correctionDraft.evidence.basis.projectId === projectId)
    && (value.factDraft === null || within(value.factDraft.editSeq) && value.factDraft.basis.scope.projectId === projectId)
    && (value.factPending === null || value.factPending.request.basis.scope.projectId === projectId && within(value.factPending.submittedSeq)
      && value.factDraft !== null && same(value.factDraft.basis, value.factPending.request.basis))
    && (pending === null || resourcePendingProject(pending) === projectId && within(pending.submittedSeq)
      && (pending.kind !== "typed-context-save" && pending.kind !== "typed-context-withdraw"
        || typed.some(draft => draft.key === pending.draftKey && BigInt(pending.submittedSeq) <= BigInt(draft.editSeq)))
      && (pending.kind !== "knowledge-decision" || knowledge.some(draft => draft.key === pending.draftKey
        && same(draft.proposal, pending.request.proposal) && draft.entryIndex === pending.request.entryIndex
        && BigInt(pending.submittedSeq) <= BigInt(draft.editSeq))));
}

function head(value: ResourceDraftHead, projectId: string) {
  return value.key.projectId === projectId && (value.value === null ? value.writerId === null
    : value.writerId !== null && BigInt(value.revision) > 0n && related(value.value, projectId))
    && bytes.encode(JSON.stringify(value)).length <= maxBytes;
}
function written(value: ResourceDraftHead, write: Requests["resourceWrite"]["write"]) {
  return head(value, write.key.projectId) && value.writerId === write.writerId
    && same(value.value, canonicalResourceDraft(write.value))
    && BigInt(value.revision) >= BigInt(write.expectedRevision) && BigInt(value.revision) > 0n;
}

/** A journal acknowledgement preserves input; it does not apply resource edits. */
export const resourceDraftCommands = {
  read: (input: Requests["resourceRead"]) => {
    const request = structuredClone(input);
    return checkedInvoke("read_local_resource_draft", request,
      (value): value is ResourceDraftHead => validateResponseResourceRead(value) && head(value, request.key.projectId));
  },
  write: (input: Requests["resourceWrite"]) => {
    const request = structuredClone(input); request.write.value = canonicalResourceDraft(request.write.value);
    return checkedInvoke("write_local_resource_draft", request,
      (value): value is ResourceDraftHead => validateResponseResourceWritten(value) && written(value, request.write));
  },
  resolve: (input: Requests["resourceResolve"]) => {
    const request = structuredClone(input); request.resolve.write.value = canonicalResourceDraft(request.resolve.write.value);
    return checkedInvoke("resolve_local_resource_draft", request,
      (value): value is ResourceDraftHead => validateResponseResourceResolved(value) && written(value, request.resolve.write)
        && (request.resolve.target.kind === "primary" ? value.value?.pending === null : value.value?.factPending === null));
  },
  clear: (input: Requests["resourceClear"]) => {
    const request = structuredClone(input);
    return checkedInvoke("clear_local_resource_draft", request,
      (value): value is ResourceDraftHead => validateResponseResourceCleared(value) && head(value, request.clear.key.projectId)
        && value.value === null && BigInt(value.revision) >= BigInt(request.clear.expectedRevision) && BigInt(value.revision) > 0n);
  },
};
