import { checkedInvoke } from "./ipc";
import type { Requests } from "./generated/draft.requests";
import type { DraftBasis, DraftHead, DraftKey, DraftValue } from "./generated/draft.responses";
import { validateResponseCleared, validateResponsePage, validateResponseRead, validateResponseWritten } from "./generated/draft.validators";

export type { DraftBasis, DraftHead, DraftKey, DraftPending, DraftValue, DraftPage, DraftSummary, DraftReadView } from "./generated/draft.responses";
type DraftValueInput = Requests["write"]["write"]["value"];

export function sameDraftKey(left: DraftKey, right: DraftKey) {
  return left.projectId === right.projectId && left.unitId === right.unitId && left.locale === right.locale;
}
export function sameDraftBasis(left: DraftValueInput["basis"], right: DraftValueInput["basis"]) {
  return left.sourceRevisionId === right.sourceRevisionId && (left.selectionId ?? null) === (right.selectionId ?? null)
    && (left.revisionId ?? null) === (right.revisionId ?? null) && (left.text ?? null) === (right.text ?? null);
}
function samePending(left: DraftValueInput["pending"], right: DraftValueInput["pending"]): boolean {
  if (left == null || right == null) return (left ?? null) === (right ?? null);
  const a = left.request, b = right.request;
  return left.submittedSeq === right.submittedSeq && left.kind === right.kind
    && a.projectId === b.projectId && a.actionId === b.actionId && a.unitId === b.unitId
    && a.locale === b.locale && a.sourceRevisionId === b.sourceRevisionId
    && (a.expectedSelectionId ?? null) === (b.expectedSelectionId ?? null)
    && (left.kind === "save" && right.kind === "save" ? left.request.text === right.request.text
      : left.kind === "selection" && right.kind === "selection"
        && left.request.revisionId === right.request.revisionId && left.text === right.text);
}
export function sameDraftValue(left: DraftValueInput, right: DraftValueInput) {
  return left.editSeq === right.editSeq && left.text === right.text && sameDraftBasis(left.basis, right.basis)
    && samePending(left.pending, right.pending);
}
function relatedBasis(basis: DraftBasis) {
  return basis.selectionId === null ? basis.revisionId === null && basis.text === null
    : basis.revisionId !== null && basis.text !== null;
}
function relatedValue(key: DraftKey, value: DraftValue) {
  const pending = value.pending;
  return relatedBasis(value.basis) && (pending === null || (sameDraftKey(key, pending.request)
    && pending.request.sourceRevisionId === value.basis.sourceRevisionId
    && pending.request.expectedSelectionId === value.basis.selectionId
    && BigInt(pending.submittedSeq) <= BigInt(value.editSeq)));
}
function relatedHead(head: DraftHead) {
  return head.value === null ? head.writerId === null
    : head.writerId !== null && BigInt(head.revision) > 0n && relatedValue(head.key, head.value);
}
function compareKey(a: DraftKey, b: DraftKey) {
  return a.locale === b.locale ? (a.unitId < b.unitId ? -1 : a.unitId === b.unitId ? 0 : 1)
    : a.locale < b.locale ? -1 : 1;
}

/** These commands preserve input. They never submit a recovered business action. */
export const draftCommands = {
  read: (request: Requests["read"]) => checkedInvoke("read_local_draft", request,
    (value): value is import("./generated/draft.responses").DraftReadView => validateResponseRead(value)
      && sameDraftKey(value.head.key, request.key) && relatedHead(value.head)
      && (value.current.kind !== "current" || relatedBasis(value.current.basis))),
  write: (request: Requests["write"]) => checkedInvoke("write_local_draft", request,
    (head): head is DraftHead => validateResponseWritten(head) && sameDraftKey(head.key, request.write.key)
      && relatedHead(head) && head.value !== null && head.writerId === request.write.writerId
      && sameDraftValue(head.value, request.write.value)
      && BigInt(head.revision) >= BigInt(request.write.expectedRevision)),
  clear: (request: Requests["clear"]) => checkedInvoke("clear_local_draft", request,
    (head): head is DraftHead => validateResponseCleared(head) && sameDraftKey(head.key, request.clear.key)
      && head.value === null && head.writerId === null && BigInt(head.revision) > 0n
      && BigInt(head.revision) >= BigInt(request.clear.expectedRevision)),
  list: (request: Requests["list"]) => checkedInvoke("list_local_drafts", request,
    (page): page is import("./generated/draft.responses").DraftPage => validateResponsePage(page)
      && page.items.length <= request.limit
      && page.items.every((item, index) => item.key.projectId === request.projectId && BigInt(item.revision) > 0n
        && (!request.after || compareKey(request.after, item.key) < 0)
        && (index === 0 || compareKey(page.items[index - 1].key, item.key) < 0))
      && (page.next === null || (page.next.projectId === request.projectId
        && (!request.after || compareKey(request.after, page.next) < 0)
        && page.items.every(item => compareKey(item.key, page.next!) <= 0)))),
};
