import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import { isConversationMessageText } from "./conversationCommands";
import type { Requests } from "./generated/draft.requests";
import type { Responses } from "./generated/draft.responses";
import { validateResponseConversationRead, validateResponseConversationWritten, validateResponseConversationResolved, validateResponseConversationCleared, validateResponseConversationPage } from "./generated/draft.validators";

export type { ConversationDraftKey, ConversationDraftHead, ConversationDraftPending, ConversationDraftValue, ConversationDraftSummary } from "./generated/draft.responses";
type Head = Responses["conversationRead"];
const bytes = new TextEncoder();
const same = (a: unknown, b: unknown) => jsonIdentity(a) === jsonIdentity(b);
function head(value: Head, key: Head["key"]) {
  const draft = value.value, pending = draft?.pending;
  return same(value.key, key) && (draft === null ? value.writerId === null : value.writerId !== null && BigInt(value.revision) > 0n
    && (pending == null || pending.request.projectId === key.projectId && pending.request.conversationId === key.conversationId
      && BigInt(pending.submittedSeq) <= BigInt(draft.editSeq)
      && (pending.kind !== "append" || isConversationMessageText(pending.request.body))
      && (pending.kind !== "append" || pending.submittedSeq !== draft.editSeq || pending.request.body === draft.text)))
    && bytes.encode(JSON.stringify(value)).length <= 256 * 1024;
}
function written(value: Head, write: Requests["conversationWrite"]["write"]) {
  return head(value, write.key) && value.writerId === write.writerId && same(value.value, { ...write.value, pending: write.value.pending ?? null })
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
    return checkedInvoke("resolve_local_conversation_draft", request,
      (value): value is Head => validateResponseConversationResolved(value) && written(value, request.resolve.write) && value.value?.pending === null);
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
