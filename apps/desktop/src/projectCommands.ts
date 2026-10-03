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
  outcome: "rejected" | "unknown";
  reason?: string;
  field?: string;
  currentRevision?: string;
  recoveryRequired: boolean;
  itemIds?: string[];
  recoveryActions?: string[];
}

const errorCodes = ["invalid-input", "destination-conflict", "missing-project", "permission-denied", "unsupported-schema", "corrupt-project", "stale-revision", "session-invalid", "project-in-use", "busy", "storage-failed", "outcome-unknown", "limit-exceeded", "result-mismatch", "output-invalid", "dependency-conflict", "cancelled"] satisfies CommandErrorCode[];
const stages = ["create", "open", "read", "rename", "add-target-locale", "set-target-locales", "close", "execution-read", "execution-cancel", "execution-recover", "execution-adopt", "execution-quiesce"] satisfies CommandStage[];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const optionalText = (value: unknown) => value === undefined || typeof value === "string";
const optionalTexts = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => typeof item === "string"));
export function isCommandError(value: unknown): value is CommandError {
  return isRecord(value) && errorCodes.some(code => code === value.code) && stages.some(stage => stage === value.stage)
    && (value.outcome === "rejected" || value.outcome === "unknown") && (value.code !== "outcome-unknown" || value.outcome === "unknown")
    && typeof value.recoveryRequired === "boolean" && optionalText(value.reason) && optionalText(value.field)
    && (value.currentRevision === undefined || (typeof value.currentRevision === "string" && /^(0|[1-9]\d*)$/.test(value.currentRevision) && BigInt(value.currentRevision) <= 9223372036854775807n))
    && optionalTexts(value.itemIds) && optionalTexts(value.recoveryActions);
}
/** Transport failures do not prove rejection: retain the original action. */
export function hasUnknownOutcome(error: unknown): boolean {
  return !isRecord(error) || error.outcome !== "rejected" || error.code === "outcome-unknown" || !errorCodes.some(code => code === error.code);
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
