import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import { sameSourceEnvironment } from "./sourceCommands";
import { sameSourceHookStop } from "./sourceMaintenanceHookCommands";
import type { Requests } from "./generated/draft.requests";
import type { SourceDraftHead, SourceDraftValue, SourceDraftObserved, SourceDraftPrepared, SourceDraftPending, SourceDraftHookStop,
  SourceDraftObservation } from "./generated/draft.responses";
import { validateResponseSourceRead, validateResponseSourceWritten, validateResponseSourceCleared,
  validateResponseSourceResolved, validateResponseSourceValue, validateResponseSourceObserved, validateResponseSourcePrepared } from "./generated/draft.validators";

export type { SourceDraftHead, SourceDraftValue, SourceDraftPending, SourceDraftHookStop, SourceDraftObservation } from "./generated/draft.responses";
export type SourceDraftResolveTarget = Requests["sourceResolve"]["resolve"]["target"];
export type SourceDraftDisposition = Requests["sourceResolve"]["resolve"]["disposition"];
type Input = Requests["sourceWrite"]["write"]["value"];
const same = (left: unknown, right: unknown) => jsonIdentity(left) === jsonIdentity(right);
const maxBytes = 8 * 1024 * 1024 + 256 * 1024;
const bytes = new TextEncoder();
const safeSequence = (value: string) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);

function canonicalPending(pending: Input["pending"]) {
  if (pending == null) return null;
  if (pending.kind !== "adopt") return pending;
  const confirmation = { ...pending.request.confirmation,
    expectedCurrentSnapshot: pending.request.confirmation.expectedCurrentSnapshot ?? null,
    lineage: pending.request.confirmation.lineage ?? [], actor: pending.request.confirmation.actor ?? null,
    lineageBaseSnapshot: pending.request.confirmation.lineageBaseSnapshot ?? null };
  if (confirmation.expectedMappingRevision == null) delete confirmation.expectedMappingRevision;
  return { ...pending, request: { ...pending.request, confirmation } };
}
/** Complete nullable fields at the wire boundary; keep user input byte-for-byte. */
export function canonicalSourceDraft(input: Input): SourceDraftValue {
  const { correction, ...fields } = input;
  const value = { ...fields, ...(correction == null ? {} : { correction }), source: input.source ?? null, selectionLabel: input.selectionLabel ?? null,
    attemptId: input.attemptId ?? null, checkAttemptId: input.checkAttemptId ?? null,
    captureRequest: input.captureRequest ?? null, checkPrepareRequest: input.checkPrepareRequest ?? null,
    comparisonRef: input.comparisonRef == null ? null : { ...input.comparisonRef,
      previousSnapshotId: input.comparisonRef.previousSnapshotId ?? null,
      expectedCurrentSnapshot: input.comparisonRef.expectedCurrentSnapshot ?? null },
    manualOrdinal: input.manualOrdinal ?? null, historicalSearch: input.historicalSearch ?? null,
    receiptRef: input.receiptRef ?? null, hook: { ...input.hook, sourceActionId: input.hook.sourceActionId ?? null },
    pending: canonicalPending(input.pending), hookStop: input.hookStop ?? null };
  if (!validateResponseSourceValue(value)) throw new Error("Invalid local source input");
  return value;
}
function related(value: SourceDraftValue, projectId: string) {
  const within = (seq: string, head = value.editSeq) => safeSequence(seq) && BigInt(seq) <= BigInt(head);
  return safeSequence(value.editSeq) && within(value.mappingSeq)
    && value.lineage.every((choice, index) => index === 0 || value.lineage[index - 1].newOrdinal < choice.newOrdinal)
    && (value.captureRequest === null || value.captureRequest.projectId === projectId)
    && (value.checkPrepareRequest === null || value.checkPrepareRequest.projectId === projectId)
    && (value.pending === null || value.pending.request.projectId === projectId && within(value.pending.submittedSeq)
      && within(value.pending.submittedMappingSeq, value.mappingSeq)
      && (value.pending.kind !== "correct-lineage" || value.pending.request.correction.projectId === projectId
        && value.pending.request.correction.basis.projectId === projectId))
    && (value.hookStop === null || value.hookStop.request.projectId === projectId
      && value.hookStop.request.stop.projectId === projectId && within(value.hookStop.submittedSeq));
}
function head(value: SourceDraftHead, projectId: string) {
  return value.key.projectId === projectId && (value.value === null ? value.writerId === null
    : value.writerId !== null && BigInt(value.revision) > 0n && related(value.value, projectId))
    && bytes.encode(JSON.stringify(value)).length <= maxBytes;
}
function written(value: SourceDraftHead, write: Requests["sourceWrite"]["write"]) {
  return head(value, write.key.projectId) && value.writerId === write.writerId
    && same(value.value, canonicalSourceDraft(write.value))
    && BigInt(value.revision) >= BigInt(write.expectedRevision) && BigInt(value.revision) > 0n;
}
function observationMatches(observation: SourceDraftObservation, request: Requests["sourceObserve"]) {
  const target = request.target;
  if (target.kind === "hook-stop") return observation.kind === "pending" || observation.kind === "confirmed-not-applied" || observation.kind === "hook-stopped"
    && observation.receipt.admissionClosed && sameSourceHookStop(observation.receipt.request, target.pending.request.stop);
  const pending = target.pending;
  switch (observation.kind) {
    case "pending": return true;
    case "preparation-expired": return pending.kind === "capture" || pending.kind === "prepare-check";
    case "confirmed-not-applied": return pending.kind === "adopt" || pending.kind === "start" || pending.kind === "start-check" || pending.kind === "finish-check" || pending.kind === "correct-lineage";
    case "capture": return pending.kind === "capture" && observation.view.attemptId === pending.request.attemptId
      && observation.view.sourceLanguage === pending.request.sourceLanguage;
    case "started": return (pending.kind === "start" || pending.kind === "start-check")
      && observation.view.projectId === pending.request.projectId && observation.view.attemptId === pending.request.attemptId
      && observation.view.inputDigest === pending.request.inputDigest
      && observation.view.operation === (pending.kind === "start" ? "source-import" : "source-semantic-check");
    case "check-prepared": return pending.kind === "prepare-check" && observation.view.attemptId === pending.request.attemptId
      && observation.view.sourceAttemptId === pending.request.sourceAttemptId && observation.view.sourceResultId === pending.request.sourceResultId
      && sameSourceEnvironment(observation.view.source, pending.request.source);
    case "check-finished": return pending.kind === "finish-check";
    case "lineage-corrected": return pending.kind === "correct-lineage"
      && observation.receipt.request.projectId === request.key.projectId
      && same(observation.receipt.request, pending.request.correction);
    case "adoption-prepared":
    case "adopted": {
      // The original Source owner must pin a matching receipt before checking
      // a conflicting preparation. Rejecting that evidence here would lose
      // the receipt and let a later absence incorrectly enable replay.
      // Shape and target are checked here; that owner checks both domain
      // associations before publishing a completed state or resolving a slot.
      return pending.kind === "adopt";
    }
    case "hook-stopped": return false;
  }
}
export const sourceDraftCommands = {
  preparation: (input: Requests["sourcePreparation"]) => {
    const request = structuredClone(input), reference = request.reference;
    return checkedInvoke("read_local_source_preparation", request,
      (value): value is SourceDraftPrepared => validateResponseSourcePrepared(value) && same(value.reference, reference)
        && (value.observation.kind === "pending" || value.observation.kind === "preparation-expired"
          || value.observation.kind === "capture" && reference.kind === "capture"
            && value.observation.view.attemptId === reference.request.attemptId && value.observation.view.sourceLanguage === reference.request.sourceLanguage
          || value.observation.kind === "check-prepared" && reference.kind === "prepare-check"
            && value.observation.view.attemptId === reference.request.attemptId && value.observation.view.sourceAttemptId === reference.request.sourceAttemptId
            && value.observation.view.sourceResultId === reference.request.sourceResultId && sameSourceEnvironment(value.observation.view.source, reference.request.source)));
  },
  read: (input: Requests["sourceRead"]) => {
    const request = structuredClone(input);
    return checkedInvoke("read_local_source_draft", request,
      (value): value is SourceDraftHead => validateResponseSourceRead(value) && head(value, request.key.projectId));
  },
  write: (input: Requests["sourceWrite"]) => {
    const request = structuredClone(input); request.write.value = canonicalSourceDraft(request.write.value);
    return checkedInvoke("write_local_source_draft", request,
      (value): value is SourceDraftHead => validateResponseSourceWritten(value) && written(value, request.write));
  },
  resolve: (input: Requests["sourceResolve"]) => {
    const request = structuredClone(input); request.resolve.write.value = canonicalSourceDraft(request.resolve.write.value);
    return checkedInvoke("resolve_local_source_draft", request,
      (value): value is SourceDraftHead => validateResponseSourceResolved(value) && written(value, request.resolve.write)
        && (request.resolve.target.kind === "primary" ? value.value?.pending === null : value.value?.hookStop === null));
  },
  clear: (input: Requests["sourceClear"]) => {
    const request = structuredClone(input);
    return checkedInvoke("clear_local_source_draft", request,
      (value): value is SourceDraftHead => validateResponseSourceCleared(value) && head(value, request.clear.key.projectId)
        && value.value === null && BigInt(value.revision) >= BigInt(request.clear.expectedRevision) && BigInt(value.revision) > 0n);
  },
  observe: (input: Requests["sourceObserve"]) => {
    const request = structuredClone(input);
    if (request.target.kind === "primary") request.target.pending = canonicalPending(request.target.pending)!;
    return checkedInvoke("observe_local_source_action", request,
      (value): value is SourceDraftObserved =>
        validateResponseSourceObserved(value) && same(value.target, request.target) && observationMatches(value.observation, request));
  },
};
