import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceArea } from "./WorkbenchFrame";
import type { TranslationKey } from "./i18n/types";

type PlainWorkbenchCommandId = "project.metadata.save" | "translation.save"
  | "translation.save-and-next" | "translation.retry-save" | "translation.reconcile-save"
  | "review.approve" | "review.request-changes" | "review.run-checks" | "review.cancel-checks" | "review.retry-pending"
  | "review.approve-batch" | "review.stop-batch";
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
interface WorkbenchCommandPayloads {
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
  category: "project" | "translation" | "review" | "resources";
  scope: CommandScope;
  binding: "Mod+S" | null;
  risk: "writes-project" | "writes-translation" | "writes-review" | "runs-review-checks"
    | "cancels-review-checks" | "retries-review-action" | "stops-review-batch"
    | "writes-resources" | "captures-resources" | "reads-resources" | "retries-resource-action" | "opens-translation";
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
  | ResourceCommand<"resource-term", "resource.save-term">
  | ResourceCommand<"resource-context", "resource.save-context" | "resource.capture-context">
  | ResourceCommand<"resource-locale", "resource.choose-file">
  | ResourceCommand<"resource-capture", "resource.open-preview" | "resource.refresh-preview">
  | ResourceCommand<"resource-decision", "resource.decide-entry">
  | ResourceCommand<"resource-pending", "resource.retry-pending">
  | ResourceCommand<"resource-translation", "resource.open-translation">;
export type WorkbenchCommandDescription = CommandMetadata & {
  id: WorkbenchCommandId;
  payloadKind?: CommandPayload["kind"];
  availability: CommandAvailability;
};

function availability(command: WorkbenchCommand, payload?: CommandPayload): CommandAvailability {
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
function validResourcePayload(payload: CommandPayload | undefined): payload is Exclude<CommandPayload, ReviewFallbackCommandPayload | ReviewWaiverCommandPayload> {
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
    if (command.payloadKind === "review-fallback") {
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
