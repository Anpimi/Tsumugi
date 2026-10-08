import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceArea } from "./WorkbenchFrame";
import type { TranslationKey } from "./i18n/types";

export type WorkbenchCommandId = "project.metadata.save" | "translation.save"
  | "translation.retry-save" | "translation.reconcile-save";
export interface CommandScope {
  projectId: string;
  sessionToken: string;
  area: WorkspaceArea;
}
export interface CommandAvailability {
  enabled: boolean;
  reason?: "hidden" | "busy" | "no-changes" | "pending-action" | "unavailable";
}
export interface WorkbenchCommand {
  id: WorkbenchCommandId;
  nameKey: TranslationKey;
  category: "project" | "translation";
  scope: CommandScope;
  binding: "Mod+S" | null;
  risk: "writes-project" | "writes-translation";
  confirmation: "none" | "required";
  availability: () => CommandAvailability;
  handler: () => void;
}
export type WorkbenchCommandDescription = Omit<WorkbenchCommand, "availability" | "handler"> & { availability: CommandAvailability };

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
      .map(({ availability, handler: _handler, ...description }) => ({ ...description, availability: availability() }));
  }

  dispatch(id: WorkbenchCommandId, scope: CommandScope): boolean {
    const command = this.registrations.get(id)?.command;
    if (!command || command.scope.projectId !== scope.projectId
      || command.scope.sessionToken !== scope.sessionToken || command.scope.area !== scope.area
      || !command.availability().enabled) return false;
    command.handler();
    return true;
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
