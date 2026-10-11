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
interface WorkbenchCommandPayloads {
  "review.allow-fallback": ReviewFallbackCommandPayload;
  "review.withdraw-fallback": ReviewFallbackCommandPayload;
  "review.grant-waiver": ReviewWaiverCommandPayload;
  "review.revoke-waiver": ReviewWaiverCommandPayload;
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
  category: "project" | "translation" | "review";
  scope: CommandScope;
  binding: "Mod+S" | null;
  risk: "writes-project" | "writes-translation" | "writes-review" | "runs-review-checks"
    | "cancels-review-checks" | "retries-review-action" | "stops-review-batch";
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
export type WorkbenchCommand = PlainWorkbenchCommand | FallbackWorkbenchCommand | WaiverWorkbenchCommand;
export type WorkbenchCommandDescription = CommandMetadata & {
  id: WorkbenchCommandId;
  payloadKind?: CommandPayload["kind"];
  availability: CommandAvailability;
};

function availability(command: WorkbenchCommand, payload?: CommandPayload): CommandAvailability {
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
  return payload === undefined ? command.availability() : { enabled: false, reason: "unavailable" };
}
function validIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function validTarget(payload: CommandPayload) { return validIdentity(payload.unitId) && validIdentity(payload.locale) && validIdentity(payload.basis); }

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
    } else command.handler();
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
