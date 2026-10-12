import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceArea } from "./WorkbenchFrame";
import type { TranslationKey } from "./i18n/types";
import type { CancellationTarget } from "./ExecutionTaskSession";

type PlainWorkbenchCommandId = "project.metadata.save" | "translation.save"
  | "translation.save-and-next" | "translation.retry-save" | "translation.reconcile-save"
  | "review.approve" | "review.request-changes" | "review.run-checks" | "review.cancel-checks" | "review.retry-pending"
  | "review.approve-batch" | "review.stop-batch"
  | "source.discard" | "source.begin-update" | "source.show-current" | "source.read-current" | "source.read-applied" | "source.refresh-attempt";
export interface ReviewFallbackCommandPayload {
  kind: "review-fallback";
  unitId: string;
  locale: string;
  basis: string;
  expectedFallbackId: string | null;
}
export interface ReviewWaiverCommandPayload {
  kind: "review-waiver";
  unitId: string;
  locale: string;
  basis: string;
  issueId: string;
  expectedWaiverId: string | null;
}
export interface ResourceTermCommandPayload { kind: "resource-term"; locale: string; termId: string | null; expectedRevisionId: string | null; editSeq: number }
export interface ResourceContextCommandPayload { kind: "resource-context"; unitId: string; locale: string; sourceRevisionId: string; expectedRevisionId: string | null; editSeq: number }
export interface ResourceLocaleCommandPayload { kind: "resource-locale"; locale: string }
export interface ResourceCaptureCommandPayload { kind: "resource-capture"; captureId: string; digest: string; locale: string }
export interface ResourceDecisionCommandPayload { kind: "resource-decision"; captureId: string; digest: string; locale: string; entryId: string;
  expectedRevisionId: string | null; decision: "adopt" | "keep" | "ignore" | "override";
  rowKind: "added" | "edited" | "unchanged" | "override" | "removed"; scopeUnitId: string | null }
export interface ResourcePendingCommandPayload { kind: "resource-pending"; pendingKind: "term" | "context" | "decision" | "capture"; actionId: string }
export interface ResourceTranslationCommandPayload { kind: "resource-translation"; locale: string;
  target: { unitId: string; sourceRevisionId: string; key: string; sourceText: string };
  evidenceKind: "tm" | "impact"; evidenceId: string; selectionId: string | null }
export interface SourceSelectionCommandPayload { kind: "source-selection"; domain: string; integrationId: string; version: string }
export interface SourceCaptureCommandPayload { kind: "source-capture"; selectionId: string; sourceLanguage: string }
export interface SourceBasisCommandPayload { kind: "source-basis"; attemptId: string; resultId: string; revision: string; currentSnapshot: string | null; base: string | null; editSeq: number }
export interface SourceComparisonCommandPayload { kind: "source-comparison"; attemptId: string; resultId: string; revision: string; currentSnapshot: string | null;
  originalBase: string; base: string | null; filter: string; after: number; editSeq: number }
export interface SourcePendingCommandPayload { kind: "source-pending"; pendingKind: "start" | "apply"; attemptId: string; actionId: string | null }
export interface SourceTaskCommandPayload { kind: "source-task"; attemptId: string; taskId: string }
export interface SourcePageCommandPayload { kind: "source-page"; snapshotId: string | null; attemptId: string; resultId: string; after: number }
export interface SourceHistoryCommandPayload { kind: "source-history"; offset: number }
export interface SourceHistoryContentCommandPayload { kind: "source-history-content"; snapshotId: string; query: string; after: number; newOrdinal: number | null }
export interface SourceLineageCommandPayload { kind: "source-lineage"; snapshotId: string; ordinal: number }
export interface SourceImpactCommandPayload { kind: "source-impact"; snapshotId: string; locale: string; after: number }
export interface SourceImpactTargetCommandPayload { kind: "source-impact-target"; snapshotId: string; locale: string; occurrenceId: string;
  target: { unitId: string; sourceRevisionId: string; key: string; sourceText: string };
  selectionId: string | null; translationRevisionId: string | null; reviewBasis: string }
export interface AiPreparationCommandPayload { kind: "ai-preparation"; editSeq: number; locale: string; unitIds: string[] }
export interface AiStartCommandPayload { kind: "ai-start"; attemptId: string; editSeq: number }
interface ExecutionItemCommandTarget {
  attemptId: string; taskId: string; itemId: string; translationUnitId: string;
  locale: string; sourceRevisionId: string; sourceSnapshotId: string;
}
export interface AiCandidateCommandPayload extends ExecutionItemCommandTarget { kind: "ai-candidate"; resultId: string; recoveryUnitId: string }
export interface AiTranslationCommandPayload extends ExecutionItemCommandTarget { kind: "ai-translation-target" }
export interface AiStartPendingCommandPayload { kind: "ai-start-pending"; attemptId: string; editSeq: number }
export interface AiAdoptionPendingCommandPayload { kind: "ai-adoption-pending"; attemptId: string; actionId: string; recoveryUnitId: string; resultId: string }
export interface ExecutionCancellationCommandPayload extends CancellationTarget { kind: "execution-cancellation" }
export interface ExecutionCancellationRetryCommandPayload extends CancellationTarget { kind: "execution-cancellation-retry"; requestId: string }
export interface ArenaPreparationCommandPayload { kind: "arena-preparation"; editSeq: number; locale: string; unitIds: string[] }
export interface ArenaStartCommandPayload { kind: "arena-start"; attemptId: string; editSeq: number }
export interface ArenaCandidateCommandPayload extends ExecutionItemCommandTarget { kind: "arena-candidate"; resultId: string; recoveryUnitId: string }
export interface ArenaTranslationCommandPayload extends ExecutionItemCommandTarget { kind: "arena-translation-target" }
export interface ArenaCompareCommandPayload { kind: "arena-compare"; unitId: string; locale: string; revisionIds: string[]; blind: boolean; editSeq: number }
interface ArenaComparisonTarget { comparisonId: string; unitId: string; locale: string; sourceRevisionId: string; selectionId: string | null; basis: string }
export interface ArenaComparisonCommandPayload extends ArenaComparisonTarget { kind: "arena-comparison" }
export interface ArenaSelectionCommandPayload extends ArenaComparisonTarget { kind: "arena-selection"; revisionId: string }
export interface ArenaMergeCommandPayload extends ArenaComparisonTarget { kind: "arena-merge-draft"; editSeq: number }
export interface ArenaRevealCommandPayload { kind: "arena-reveal"; targetKind: "attempt" | "comparison"; targetId: string }
export interface ArenaRoundCommandPayload { kind: "arena-round"; attemptId: string; taskId: string; editSeq: number }
export interface ArenaOpenComparisonCommandPayload { kind: "arena-open-comparison"; comparisonId: string; nativeKey: string; locale: string }
export type ArenaPendingCommandPayload = { kind: "arena-pending" } & (
  | { pendingKind: "start"; attemptId: string }
  | { pendingKind: "compare"; actionId: string; unitId: string; locale: string }
  | { pendingKind: "reveal"; actionId: string; targetKind: "attempt" | "comparison"; targetId: string }
  | { pendingKind: "select" | "merge"; actionId: string; unitId: string; locale: string }
  | { pendingKind: "adopt"; actionId: string; attemptId: string; recoveryUnitId: string; resultId: string }
);
interface WorkbenchCommandPayloads {
  "arena.preview": ArenaPreparationCommandPayload;
  "arena.start": ArenaStartCommandPayload;
  "arena.adopt-result": ArenaCandidateCommandPayload;
  "arena.create-comparison": ArenaCompareCommandPayload;
  "arena.reveal-identities": ArenaRevealCommandPayload;
  "arena.select-candidate": ArenaSelectionCommandPayload;
  "arena.begin-merge": ArenaComparisonCommandPayload;
  "arena.save-merge": ArenaMergeCommandPayload;
  "arena.refresh-merge-basis": ArenaMergeCommandPayload;
  "arena.discard-merge": ArenaMergeCommandPayload;
  "arena.new-round": ArenaRoundCommandPayload;
  "arena.open-comparison": ArenaOpenComparisonCommandPayload;
  "arena.reconcile-pending": ArenaPendingCommandPayload;
  "arena.retry-pending": ArenaPendingCommandPayload;
  "arena.cancel-task": ExecutionCancellationCommandPayload;
  "arena.retry-cancellation": ExecutionCancellationRetryCommandPayload;
  "arena.open-translation": ArenaTranslationCommandPayload;
  "ai.preview": AiPreparationCommandPayload;
  "ai.start": AiStartCommandPayload;
  "ai.adopt-result": AiCandidateCommandPayload;
  "ai.reconcile-start": AiStartPendingCommandPayload;
  "ai.retry-start": AiStartPendingCommandPayload;
  "ai.reconcile-adoption": AiAdoptionPendingCommandPayload;
  "ai.retry-adoption": AiAdoptionPendingCommandPayload;
  "ai.cancel-task": ExecutionCancellationCommandPayload;
  "ai.retry-cancellation": ExecutionCancellationRetryCommandPayload;
  "ai.open-translation": AiTranslationCommandPayload;
  "review.allow-fallback": ReviewFallbackCommandPayload;
  "review.withdraw-fallback": ReviewFallbackCommandPayload;
  "review.grant-waiver": ReviewWaiverCommandPayload;
  "review.revoke-waiver": ReviewWaiverCommandPayload;
  "resource.save-term": ResourceTermCommandPayload;
  "resource.save-context": ResourceContextCommandPayload;
  "resource.capture-context": ResourceContextCommandPayload;
  "resource.choose-file": ResourceLocaleCommandPayload;
  "resource.open-preview": ResourceCaptureCommandPayload;
  "resource.refresh-preview": ResourceCaptureCommandPayload;
  "resource.decide-entry": ResourceDecisionCommandPayload;
  "resource.retry-pending": ResourcePendingCommandPayload;
  "resource.open-translation": ResourceTranslationCommandPayload;
  "source.select": SourceSelectionCommandPayload;
  "source.preflight": SourceCaptureCommandPayload;
  "source.start": SourceCaptureCommandPayload;
  "source.apply": SourceBasisCommandPayload;
  "source.estimate": SourceBasisCommandPayload;
  "source.search-comparison": SourceComparisonCommandPayload;
  "source.refresh-comparison": SourceComparisonCommandPayload;
  "source.retry-start": SourcePendingCommandPayload;
  "source.check-receipt": SourcePendingCommandPayload;
  "source.retry-apply": SourcePendingCommandPayload;
  "source.keep-output": SourcePendingCommandPayload;
  "source.cancel-task": SourceTaskCommandPayload;
  "source.read-page": SourcePageCommandPayload;
  "source.read-history": SourceHistoryCommandPayload;
  "source.read-history-content": SourceHistoryContentCommandPayload;
  "source.find-lineage-candidates": SourceHistoryContentCommandPayload;
  "source.read-lineage": SourceLineageCommandPayload;
  "source.read-impact": SourceImpactCommandPayload;
  "source.open-work": SourceImpactCommandPayload;
  "source.open-translation": SourceImpactTargetCommandPayload;
}
export type WorkbenchCommandId = PlainWorkbenchCommandId | keyof WorkbenchCommandPayloads;
type CommandPayload = WorkbenchCommandPayloads[keyof WorkbenchCommandPayloads];
type PayloadArguments<Id extends WorkbenchCommandId> = Id extends keyof WorkbenchCommandPayloads
  ? [payload: WorkbenchCommandPayloads[Id]] : [];
export interface CommandScope {
  projectId: string;
  sessionToken: string;
  area: WorkspaceArea;
}
export interface CommandAvailability {
  enabled: boolean;
  reason?: "hidden" | "busy" | "no-changes" | "pending-action" | "unavailable";
}
interface CommandMetadata {
  nameKey: TranslationKey;
  category: "project" | "translation" | "review" | "resources" | "source" | "ai" | "arena";
  scope: CommandScope;
  binding: "Mod+S" | null;
  risk: "writes-project" | "writes-translation" | "writes-review" | "runs-review-checks"
    | "cancels-review-checks" | "retries-review-action" | "stops-review-batch"
    | "writes-resources" | "captures-resources" | "reads-resources" | "retries-resource-action" | "opens-translation"
    | "captures-source" | "reads-source" | "writes-source" | "retries-source-action" | "cancels-source-task"
    | "captures-ai" | "runs-ai" | "reconciles-execution-action" | "retries-execution-action" | "cancels-execution-task"
    | "captures-arena" | "runs-arena" | "writes-arena" | "reads-arena" | "discards-arena-draft";
  confirmation: "none" | "required";
}
interface PlainWorkbenchCommand extends CommandMetadata {
  id: PlainWorkbenchCommandId;
  payloadKind?: never;
  availability: () => CommandAvailability;
  handler: () => void;
}
interface FallbackWorkbenchCommand extends CommandMetadata {
  id: "review.allow-fallback" | "review.withdraw-fallback";
  payloadKind: "review-fallback";
  availability: (payload: ReviewFallbackCommandPayload | undefined) => CommandAvailability;
  handler: (payload: ReviewFallbackCommandPayload) => void;
}
interface WaiverWorkbenchCommand extends CommandMetadata {
  id: "review.grant-waiver" | "review.revoke-waiver";
  payloadKind: "review-waiver";
  availability: (payload: ReviewWaiverCommandPayload | undefined) => CommandAvailability;
  handler: (payload: ReviewWaiverCommandPayload) => void;
}
type ResourceCommand<K extends CommandPayload["kind"], I extends WorkbenchCommandId> = CommandMetadata & {
  id: I; payloadKind: K;
  availability: (payload: Extract<CommandPayload, { kind: K }> | undefined) => CommandAvailability;
  handler: (payload: Extract<CommandPayload, { kind: K }>) => void;
};
export type WorkbenchCommand = PlainWorkbenchCommand | FallbackWorkbenchCommand | WaiverWorkbenchCommand
  | ResourceCommand<"arena-preparation", "arena.preview">
  | ResourceCommand<"arena-start", "arena.start">
  | ResourceCommand<"arena-candidate", "arena.adopt-result">
  | ResourceCommand<"arena-compare", "arena.create-comparison">
  | ResourceCommand<"arena-reveal", "arena.reveal-identities">
  | ResourceCommand<"arena-selection", "arena.select-candidate">
  | ResourceCommand<"arena-comparison", "arena.begin-merge">
  | ResourceCommand<"arena-merge-draft", "arena.save-merge" | "arena.refresh-merge-basis" | "arena.discard-merge">
  | ResourceCommand<"arena-round", "arena.new-round">
  | ResourceCommand<"arena-open-comparison", "arena.open-comparison">
  | ResourceCommand<"arena-pending", "arena.reconcile-pending" | "arena.retry-pending">
  | ResourceCommand<"arena-translation-target", "arena.open-translation">
  | ResourceCommand<"ai-preparation", "ai.preview">
  | ResourceCommand<"ai-start", "ai.start">
  | ResourceCommand<"ai-candidate", "ai.adopt-result">
  | ResourceCommand<"ai-start-pending", "ai.reconcile-start" | "ai.retry-start">
  | ResourceCommand<"ai-adoption-pending", "ai.reconcile-adoption" | "ai.retry-adoption">
  | ResourceCommand<"execution-cancellation", "ai.cancel-task" | "arena.cancel-task">
  | ResourceCommand<"execution-cancellation-retry", "ai.retry-cancellation" | "arena.retry-cancellation">
  | ResourceCommand<"ai-translation-target", "ai.open-translation">
  | ResourceCommand<"resource-term", "resource.save-term">
  | ResourceCommand<"resource-context", "resource.save-context" | "resource.capture-context">
  | ResourceCommand<"resource-locale", "resource.choose-file">
  | ResourceCommand<"resource-capture", "resource.open-preview" | "resource.refresh-preview">
  | ResourceCommand<"resource-decision", "resource.decide-entry">
  | ResourceCommand<"resource-pending", "resource.retry-pending">
  | ResourceCommand<"resource-translation", "resource.open-translation">
  | ResourceCommand<"source-selection", "source.select">
  | ResourceCommand<"source-capture", "source.preflight" | "source.start">
  | ResourceCommand<"source-basis", "source.apply" | "source.estimate">
  | ResourceCommand<"source-comparison", "source.search-comparison" | "source.refresh-comparison">
  | ResourceCommand<"source-pending", "source.retry-start" | "source.check-receipt" | "source.retry-apply" | "source.keep-output">
  | ResourceCommand<"source-task", "source.cancel-task">
  | ResourceCommand<"source-page", "source.read-page">
  | ResourceCommand<"source-history", "source.read-history">
  | ResourceCommand<"source-history-content", "source.read-history-content" | "source.find-lineage-candidates">
  | ResourceCommand<"source-lineage", "source.read-lineage">
  | ResourceCommand<"source-impact", "source.read-impact" | "source.open-work">
  | ResourceCommand<"source-impact-target", "source.open-translation">;
export type WorkbenchCommandDescription = CommandMetadata & {
  id: WorkbenchCommandId;
  payloadKind?: CommandPayload["kind"];
  availability: CommandAvailability;
};

function availability(command: WorkbenchCommand, payload?: CommandPayload): CommandAvailability {
  if (command.payloadKind?.startsWith("arena-")) {
    if (!validArenaPayload(payload)) return unavailable;
    switch (command.payloadKind) {
      case "arena-preparation": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-start": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-candidate": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-compare": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-reveal": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-selection": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-comparison": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-merge-draft": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-round": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-open-comparison": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-pending": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "arena-translation-target": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
    }
  }
  if (command.payloadKind?.startsWith("ai-") || command.payloadKind?.startsWith("execution-cancellation")) {
    if (!validAiPayload(payload)) return unavailable;
    switch (command.payloadKind) {
      case "ai-preparation": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "ai-start": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "ai-candidate": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "ai-start-pending": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "ai-adoption-pending": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "execution-cancellation": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "execution-cancellation-retry": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "ai-translation-target": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
    }
  }
  if (command.payloadKind?.startsWith("source-")) {
    if (!validSourcePayload(payload)) return unavailable;
    switch (command.payloadKind) {
      case "source-selection": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-capture": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-basis": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-comparison": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-pending": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-task": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-page": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-history": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-history-content": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-lineage": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-impact": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "source-impact-target": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
    }
  }
  if (command.payloadKind?.startsWith("resource-")) {
    if (!validResourcePayload(payload)) return { enabled: false, reason: "unavailable" };
    switch (command.payloadKind) {
      case "resource-term": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "resource-context": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "resource-locale": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "resource-capture": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "resource-decision": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "resource-pending": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
      case "resource-translation": return payload.kind === command.payloadKind ? command.availability(payload) : unavailable;
    }
  }
  if (command.payloadKind === "review-fallback") {
    if (payload?.kind === "review-fallback" && validTarget(payload)
      && (payload.expectedFallbackId === null || validIdentity(payload.expectedFallbackId))) return command.availability(payload);
    return { enabled: false, reason: command.availability(undefined).reason ?? "unavailable" };
  }
  if (command.payloadKind === "review-waiver") {
    if (payload?.kind === "review-waiver" && validTarget(payload) && validIdentity(payload.issueId)
      && (payload.expectedWaiverId === null || validIdentity(payload.expectedWaiverId))) return command.availability(payload);
    return { enabled: false, reason: command.availability(undefined).reason ?? "unavailable" };
  }
  return !command.payloadKind && payload === undefined ? command.availability() : { enabled: false, reason: "unavailable" };
}
function validIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function validTarget(payload: ReviewFallbackCommandPayload | ReviewWaiverCommandPayload) { return validIdentity(payload.unitId) && validIdentity(payload.locale) && validIdentity(payload.basis); }
const unavailable: CommandAvailability = { enabled: false, reason: "unavailable" };
function nullableIdentity(value: unknown) { return value === null || validIdentity(value); }
function editSequence(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
type AiCommandPayload = Extract<CommandPayload, { kind: `ai-${string}` | `execution-cancellation${string}` }>;
function validExecutionItemTarget(payload: ExecutionItemCommandTarget) {
  return [payload.attemptId, payload.taskId, payload.itemId, payload.translationUnitId, payload.locale,
    payload.sourceRevisionId, payload.sourceSnapshotId].every(validIdentity);
}
function validComparisonTarget(payload: ArenaComparisonTarget) {
  return [payload.comparisonId, payload.unitId, payload.locale, payload.sourceRevisionId, payload.basis].every(validIdentity) && nullableIdentity(payload.selectionId);
}
function validArenaPayload(payload: CommandPayload | undefined): payload is Extract<CommandPayload, { kind: `arena-${string}` }> {
  if (!payload || typeof payload !== "object") return false;
  switch (payload.kind) {
    case "arena-preparation": return editSequence(payload.editSeq) && validIdentity(payload.locale) && Array.isArray(payload.unitIds)
      && payload.unitIds.length > 0 && payload.unitIds.every(validIdentity) && new Set(payload.unitIds).size === payload.unitIds.length;
    case "arena-start": return validIdentity(payload.attemptId) && editSequence(payload.editSeq);
    case "arena-candidate": return validExecutionItemTarget(payload) && validIdentity(payload.resultId) && validIdentity(payload.recoveryUnitId);
    case "arena-translation-target": return validExecutionItemTarget(payload);
    case "arena-compare": return validIdentity(payload.unitId) && validIdentity(payload.locale) && editSequence(payload.editSeq) && typeof payload.blind === "boolean"
      && Array.isArray(payload.revisionIds) && payload.revisionIds.length >= 2 && payload.revisionIds.length <= 4
      && payload.revisionIds.every(validIdentity) && new Set(payload.revisionIds).size === payload.revisionIds.length;
    case "arena-reveal": return validIdentity(payload.targetId) && ["attempt", "comparison"].includes(payload.targetKind);
    case "arena-selection": return validComparisonTarget(payload) && validIdentity(payload.revisionId);
    case "arena-comparison": return validComparisonTarget(payload);
    case "arena-merge-draft": return validComparisonTarget(payload) && editSequence(payload.editSeq);
    case "arena-round": return validIdentity(payload.attemptId) && validIdentity(payload.taskId) && editSequence(payload.editSeq);
    case "arena-open-comparison": return [payload.comparisonId, payload.locale].every(validIdentity) && typeof payload.nativeKey === "string";
    case "arena-pending": switch (payload.pendingKind) {
      case "start": return validIdentity(payload.attemptId);
      case "compare": case "select": case "merge": return [payload.actionId, payload.unitId, payload.locale].every(validIdentity);
      case "reveal": return validIdentity(payload.actionId) && validIdentity(payload.targetId) && ["attempt", "comparison"].includes(payload.targetKind);
      case "adopt": return [payload.actionId, payload.attemptId, payload.recoveryUnitId, payload.resultId].every(validIdentity);
      default: return false;
    }
    default: return false;
  }
}
function validAiPayload(payload: CommandPayload | undefined): payload is AiCommandPayload {
  if (!payload || typeof payload !== "object") return false;
  switch (payload.kind) {
    case "ai-preparation": return editSequence(payload.editSeq) && validIdentity(payload.locale) && Array.isArray(payload.unitIds)
      && payload.unitIds.length > 0 && payload.unitIds.every(validIdentity) && new Set(payload.unitIds).size === payload.unitIds.length;
    case "ai-start": case "ai-start-pending": return validIdentity(payload.attemptId) && editSequence(payload.editSeq);
    case "ai-candidate": return validExecutionItemTarget(payload) && validIdentity(payload.resultId) && validIdentity(payload.recoveryUnitId);
    case "ai-translation-target": return validExecutionItemTarget(payload);
    case "ai-adoption-pending": return [payload.attemptId, payload.actionId, payload.recoveryUnitId, payload.resultId].every(validIdentity);
    case "execution-cancellation": return validIdentity(payload.taskId) && validIdentity(payload.attemptId)
      && ["tasks", "source", "ai", "arena"].includes(payload.origin);
    case "execution-cancellation-retry": return validIdentity(payload.taskId) && validIdentity(payload.attemptId)
      && validIdentity(payload.requestId) && ["tasks", "source", "ai", "arena"].includes(payload.origin);
    default: return false;
  }
}
function validResourcePayload(payload: CommandPayload | undefined): payload is Extract<CommandPayload, { kind: `resource-${string}` }> {
  if (!payload || typeof payload !== "object") return false;
  switch (payload.kind) {
    case "resource-term": return validIdentity(payload.locale) && nullableIdentity(payload.termId) && nullableIdentity(payload.expectedRevisionId) && editSequence(payload.editSeq);
    case "resource-context": return validIdentity(payload.unitId) && validIdentity(payload.locale) && validIdentity(payload.sourceRevisionId) && nullableIdentity(payload.expectedRevisionId) && editSequence(payload.editSeq);
    case "resource-locale": return validIdentity(payload.locale);
    case "resource-capture": return validIdentity(payload.captureId) && validIdentity(payload.digest) && validIdentity(payload.locale);
    case "resource-decision": return validIdentity(payload.captureId) && validIdentity(payload.digest) && validIdentity(payload.locale) && validIdentity(payload.entryId)
      && nullableIdentity(payload.expectedRevisionId) && nullableIdentity(payload.scopeUnitId)
      && ["adopt", "keep", "ignore", "override"].includes(payload.decision) && ["added", "edited", "unchanged", "override", "removed"].includes(payload.rowKind);
    case "resource-pending": return validIdentity(payload.actionId) && ["term", "context", "decision", "capture"].includes(payload.pendingKind);
    case "resource-translation": return !!payload.target && typeof payload.target === "object" && validIdentity(payload.locale)
      && validIdentity(payload.target.unitId) && validIdentity(payload.target.sourceRevisionId) && validIdentity(payload.target.key)
      && typeof payload.target.sourceText === "string" && validIdentity(payload.evidenceId)
      && (payload.evidenceKind === "tm" ? payload.selectionId === null : payload.evidenceKind === "impact" && validIdentity(payload.selectionId));
    default: return false;
  }
}
type SourcePayload = Extract<CommandPayload, { kind: `source-${string}` }>;
function validSourcePayload(payload: CommandPayload | undefined): payload is SourcePayload {
  if (!payload || typeof payload !== "object") return false;
  switch (payload.kind) {
    case "source-selection": return validIdentity(payload.domain) && validIdentity(payload.integrationId) && validIdentity(payload.version);
    case "source-capture": return validIdentity(payload.selectionId) && validIdentity(payload.sourceLanguage);
    case "source-basis": return validIdentity(payload.attemptId) && validIdentity(payload.resultId) && validIdentity(payload.revision)
      && nullableIdentity(payload.currentSnapshot) && nullableIdentity(payload.base) && editSequence(payload.editSeq);
    case "source-comparison": return validIdentity(payload.attemptId) && validIdentity(payload.resultId) && validIdentity(payload.revision)
      && nullableIdentity(payload.currentSnapshot) && validIdentity(payload.originalBase) && nullableIdentity(payload.base)
      && typeof payload.filter === "string" && editSequence(payload.after) && editSequence(payload.editSeq);
    case "source-pending": return validIdentity(payload.attemptId) && (payload.pendingKind === "start" ? payload.actionId === null : payload.pendingKind === "apply" && validIdentity(payload.actionId));
    case "source-task": return validIdentity(payload.attemptId) && validIdentity(payload.taskId);
    case "source-page": return nullableIdentity(payload.snapshotId) && validIdentity(payload.attemptId) && validIdentity(payload.resultId) && editSequence(payload.after);
    case "source-history": return editSequence(payload.offset);
    case "source-history-content": return validIdentity(payload.snapshotId) && typeof payload.query === "string" && editSequence(payload.after)
      && (payload.newOrdinal === null || editSequence(payload.newOrdinal));
    case "source-lineage": return validIdentity(payload.snapshotId) && editSequence(payload.ordinal);
    case "source-impact": return validIdentity(payload.snapshotId) && validIdentity(payload.locale) && editSequence(payload.after);
    case "source-impact-target": return validIdentity(payload.snapshotId) && validIdentity(payload.locale) && validIdentity(payload.occurrenceId)
      && !!payload.target && typeof payload.target === "object" && validIdentity(payload.target.unitId) && validIdentity(payload.target.sourceRevisionId)
      && validIdentity(payload.target.key) && typeof payload.target.sourceText === "string" && nullableIdentity(payload.selectionId)
      && nullableIdentity(payload.translationRevisionId) && validIdentity(payload.reviewBasis);
    default: return false;
  }
}

/** UI commands only. Native authorization and request validation remain at their mutation boundaries. */
export class WorkbenchCommands {
  private registrations = new Map<WorkbenchCommandId, { token: symbol; command: WorkbenchCommand }>();

  register(command: WorkbenchCommand): () => void {
    const token = Symbol(command.id);
    this.registrations.set(command.id, { token, command });
    return () => {
      if (this.registrations.get(command.id)?.token === token) this.registrations.delete(command.id);
    };
  }

  list(scope: CommandScope): WorkbenchCommandDescription[] {
    return [...this.registrations.values()].map(({ command }) => command)
      .filter(command => command.scope.projectId === scope.projectId
        && command.scope.sessionToken === scope.sessionToken && command.scope.area === scope.area)
      .map(command => this.description(command));
  }

  describe<Id extends WorkbenchCommandId>(id: Id, scope: CommandScope, ...args: PayloadArguments<Id>): WorkbenchCommandDescription | undefined {
    const command = this.scopedCommand(id, scope);
    return command ? this.description(command, args[0]) : undefined;
  }

  // Resolve the live registration and its exact input again; metadata is not authorization.
  dispatch<Id extends WorkbenchCommandId>(id: Id, scope: CommandScope, ...args: PayloadArguments<Id>): boolean {
    const command = this.scopedCommand(id, scope);
    const payload = args[0];
    if (!command || !availability(command, payload).enabled) return false;
    if (command.payloadKind === "arena-preparation" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-start" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-candidate" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-compare" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-reveal" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-selection" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-comparison" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-merge-draft" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-round" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-open-comparison" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-pending" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "arena-translation-target" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "ai-preparation" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "ai-start" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "ai-candidate" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "ai-start-pending" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "ai-adoption-pending" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "execution-cancellation" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "execution-cancellation-retry" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "ai-translation-target" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "review-fallback") {
      if (payload?.kind !== "review-fallback") return false;
      command.handler(payload);
    } else if (command.payloadKind === "review-waiver") {
      if (payload?.kind !== "review-waiver") return false;
      command.handler(payload);
    } else if (command.payloadKind === "resource-term" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "resource-context" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "resource-locale" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "resource-capture" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "resource-decision" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "resource-pending" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "resource-translation" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-selection" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-capture" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-basis" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-comparison" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-pending" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-task" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-page" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-history" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-history-content" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-lineage" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-impact" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (command.payloadKind === "source-impact-target" && payload?.kind === command.payloadKind) command.handler(payload);
    else if (!command.payloadKind) command.handler();
    else return false;
    return true;
  }

  private scopedCommand(id: WorkbenchCommandId, scope: CommandScope): WorkbenchCommand | undefined {
    const command = this.registrations.get(id)?.command;
    if (!command || command.scope.projectId !== scope.projectId
      || command.scope.sessionToken !== scope.sessionToken || command.scope.area !== scope.area) return undefined;
    return command;
  }

  private description(command: WorkbenchCommand, payload?: CommandPayload): WorkbenchCommandDescription {
    const { availability: _availability, handler: _handler, ...description } = command;
    return { ...description, availability: availability(command, payload) };
  }
}

const WorkbenchCommandsContext = createContext<WorkbenchCommands | null>(null);

export function WorkbenchCommandsProvider({ commands, children }: { commands: WorkbenchCommands; children: ReactNode }) {
  return <WorkbenchCommandsContext.Provider value={commands}>{children}</WorkbenchCommandsContext.Provider>;
}

export function useWorkbenchCommands(): WorkbenchCommands {
  const commands = useContext(WorkbenchCommandsContext);
  if (!commands) throw new Error("WorkbenchCommandsProvider is required");
  return commands;
}
