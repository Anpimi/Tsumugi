import { invoke } from "@tauri-apps/api/core";

export type CommandErrorCode =
  | "invalid-input"
  | "destination-conflict"
  | "missing-project"
  | "permission-denied"
  | "unsupported-schema"
  | "corrupt-project"
  | "stale-revision"
  | "session-invalid"
  | "project-in-use"
  | "busy"
  | "storage-failed"
  | "outcome-unknown"
  | "limit-exceeded" | "result-mismatch" | "output-invalid" | "dependency-conflict" | "cancelled";

export type CommandStage = "create" | "open" | "read" | "rename" | "add-target-locale" | "set-target-locales" | "close"
  | "execution-read" | "execution-cancel" | "execution-recover" | "execution-adopt" | "execution-quiesce";

export interface CommandError {
  code: CommandErrorCode;
  stage: CommandStage;
  field?: string;
  currentRevision?: string;
  recoveryRequired: boolean;
  itemIds?: string[];
  recoveryActions?: string[];
}

export interface CreateProjectRequest {
  destination: string;
  displayName: string;
  sourceLocale: string;
  targetLocales: string[];
}

export interface OpenProjectRequest {
  locator: string;
}

export interface ReadProjectRequest {
  sessionToken: string;
  expectedRevision?: string;
}

export interface RenameProjectRequest {
  sessionToken: string;
  expectedRevision: string;
  displayName: string;
  directoryName?: string;
}

export interface AddTargetLocaleRequest {
  sessionToken: string;
  expectedRevision: string;
  locale: string;
}

export interface SetTargetLocalesRequest {
  sessionToken: string;
  expectedRevision: string;
  targetLocales: string[];
}

export interface CloseProjectRequest {
  sessionToken: string;
}

export interface ProjectMetadataView {
  projectId: string;
  displayName: string;
  sourceLocale: string;
  targetLocales: string[];
  metadataRevision: string;
}

export type ReconciliationState = "settled" | "committed" | "previous";

export interface ProjectView {
  sessionToken: string;
  locator: string;
  metadata: ProjectMetadataView;
  reconciliationState: ReconciliationState;
}

export type MetadataChangeOutcome = "changed" | "unchanged";

export interface MetadataMutationView {
  sessionToken: string;
  locator: string;
  metadata: ProjectMetadataView;
  outcome: MetadataChangeOutcome;
  directoryChanged: boolean;
}

export interface CloseProjectView {
  closed: boolean;
}

export const projectCommands = {
  setTargetLocales(request: SetTargetLocalesRequest) {
    return invoke<MetadataMutationView>("set_target_locales", { request });
  },
  create(request: CreateProjectRequest) {
    return invoke<ProjectView>("create_project", { request });
  },
  open(request: OpenProjectRequest) {
    return invoke<ProjectView>("open_project", { request });
  },
  read(request: ReadProjectRequest) {
    return invoke<ProjectView>("read_project", { request });
  },
  rename(request: RenameProjectRequest) {
    return invoke<MetadataMutationView>("rename_project", { request });
  },
  addTargetLocale(request: AddTargetLocaleRequest) {
    return invoke<MetadataMutationView>("add_target_locale", { request });
  },
  close(request: CloseProjectRequest) {
    return invoke<CloseProjectView>("close_project", { request });
  },
};
