import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import { isConversationMessageText } from "./conversationCommands";
import type { Requests } from "./generated/draft.requests";
import type { Responses } from "./generated/draft.responses";
import { validateResponseConversationRead, validateResponseConversationWritten, validateResponseConversationResolved, validateResponseConversationCleared, validateResponseConversationPage } from "./generated/draft.validators";

export type { ConversationDraftKey, ConversationDraftHead, ConversationDraftPending, ConversationDraftValue, ConversationDraftSummary, ConversationProposalDraft, ConversationDraftRevocation } from "./generated/draft.responses";
export type { ConversationDraftDisposition } from "./generated/draft.requests";
type WireResolveTarget = Requests["conversationResolve"]["resolve"]["target"];
// Local resolutions name a decoded head, with its defaulted fields complete.
export type ConversationDraftResolveTarget =
  | (Omit<Extract<WireResolveTarget, { kind: "pending" }>, "pending"> & { pending: ConversationDraftPending })
  | Extract<WireResolveTarget, { kind: "revocation" }>;
import type { ConversationDraftPending } from "./generated/draft.responses";
type Head = Responses["conversationRead"];
const bytes = new TextEncoder();
const same = (a: unknown, b: unknown) => jsonIdentity(a) === jsonIdentity(b);
export function conversationPendingTarget(pending: ConversationDraftPending) {
  return pending.kind === "proposal-work-plan" ? pending.request.proposal
    : pending.kind === "work-plan-start" || pending.kind === "work-plan-control" ? { projectId: pending.request.projectId, conversationId: pending.conversationId } : pending.request;
}
export function locallyReplayableConversationRequest(pending: ConversationDraftPending | null | undefined) {
  return pending?.kind === "create" || pending?.kind === "append" || pending?.kind === "proposal-capture" || pending?.kind === "proposal-revision";
}
export function canonicalConversationDraft(value: Requests["conversationWrite"]["write"]["value"]) {
  const { proposalEdits, messageEditSeq, revocations, ...rest } = value;
  return { ...rest, pending: rest.pending ?? null, ...(proposalEdits?.length ? { proposalEdits } : {}), ...(messageEditSeq != null ? { messageEditSeq } : {}), ...(revocations?.length ? { revocations } : {}) };
}
function head(value: Head, key: Head["key"]) {
  const draft = value.value, pending = draft?.pending;
  const target = pending ? conversationPendingTarget(pending) : null;
  const edits = draft?.proposalEdits ?? [], revocations = draft?.revocations ?? [];
  const primaryAction = pending?.kind === "planning" ? pending.request.consent.actionId : pending ? pending.request.actionId : null;
  const messageSeq = draft ? draft.messageEditSeq ?? draft.editSeq : "0";
  return same(value.key, key) && (draft === null ? value.writerId === null : value.writerId !== null && BigInt(value.revision) > 0n
    && revocations.length <= 32 && new Set(revocations.map(slot => slot.request.actionId)).size === revocations.length
    && revocations.every(slot => slot.request.projectId === key.projectId && slot.request.actionId !== primaryAction
      && BigInt(slot.request.expectedGeneration) > 0n && BigInt(slot.submittedSeq) <= BigInt(draft.editSeq))
    && BigInt(messageSeq) <= BigInt(draft.editSeq)
    && new Set(edits.map(edit => edit.proposalId)).size === edits.length && edits.every(edit => BigInt(edit.editSeq) <= BigInt(draft.editSeq) && edit.content.kind === "proposal"
      && (pending?.kind !== "proposal-revision" || pending.request.proposalId !== edit.proposalId || pending.submittedSeq !== edit.editSeq
        || edit.expectedRevisionId === pending.request.expectedRevisionId && same(edit.content, pending.request.content)))
    && (pending == null || target?.projectId === key.projectId && target.conversationId === key.conversationId
      && BigInt(pending.submittedSeq) <= BigInt(draft.editSeq)
      && (pending.kind !== "append" || isConversationMessageText(pending.request.body))
      && (pending.kind !== "append" || BigInt(pending.submittedSeq) <= BigInt(messageSeq)
        && (pending.submittedSeq !== messageSeq || pending.request.body === draft.text))))
    && bytes.encode(JSON.stringify(value)).length <= 4 * 1024 * 1024 + 256 * 1024;
}
function written(value: Head, write: Requests["conversationWrite"]["write"]) {
  return head(value, write.key) && value.writerId === write.writerId && same(value.value, canonicalConversationDraft(write.value))
    && BigInt(value.revision) >= BigInt(write.expectedRevision) && BigInt(value.revision) > 0n;
}
/** The application journal preserves input and identities; it never submits the stored action. */
export const conversationDraftCommands = {
  read: (request: Requests["conversationRead"]) => checkedInvoke("read_local_conversation_draft", request,
    (value): value is Head => validateResponseConversationRead(value) && head(value, request.key)),
  write: (input: Requests["conversationWrite"]) => {
    const request = structuredClone(input);
    return checkedInvoke("write_local_conversation_draft", request,
      (value): value is Head => validateResponseConversationWritten(value) && written(value, request.write));
  },
  resolve: (input: Requests["conversationResolve"]) => {
    const request = structuredClone(input);
    const target = request.resolve.target;
    return checkedInvoke("resolve_local_conversation_draft", request,
      (value): value is Head => validateResponseConversationResolved(value) && written(value, request.resolve.write)
        && (target.kind === "pending" ? value.value?.pending === null
          : !(value.value?.revocations ?? []).some(slot => slot.request.actionId === target.revocation.request.actionId)));
  },
  clear: (request: Requests["conversationClear"]) => checkedInvoke("clear_local_conversation_draft", request,
    (value): value is Head => validateResponseConversationCleared(value) && head(value, request.clear.key) && value.value === null
      && BigInt(value.revision) >= BigInt(request.clear.expectedRevision) && BigInt(value.revision) > 0n),
  list: (request: Requests["conversationList"]) => checkedInvoke("list_local_conversation_drafts", request,
    (value): value is Responses["conversationPage"] => validateResponseConversationPage(value) && value.items.length <= request.limit
      && value.items.every((item, index) => item.key.projectId === request.projectId && BigInt(item.revision) > 0n
        && (request.after == null || request.after.conversationId < item.key.conversationId)
        && (index === 0 || value.items[index - 1].key.conversationId < item.key.conversationId))
      && (value.next === null || value.next.projectId === request.projectId
        && (request.after == null || request.after.conversationId < value.next.conversationId)
        && value.items.every(item => item.key.conversationId <= value.next!.conversationId))
      && bytes.encode(JSON.stringify(value)).length <= 256 * 1024),
};
