import { checkedInvoke } from "./ipc";
import { validateResponseClose, validateResponseError, validateResponseMetadataMutation, validateResponseProjectView } from "./generated/validators";
import type { CommandError } from "./generated/responses";
import type { CreateProjectRequest, OpenProjectRequest, ReadProjectRequest, RenameProjectRequest, AddTargetLocaleRequest, SetTargetLocalesRequest, CloseProjectRequest } from "./generated/requests";
export type { CommandErrorCode, CommandStage, CommandError, ProjectMetadataView, ProjectView, MetadataMutationView, MetadataChangeOutcome, CloseProjectView, ReconciliationState } from "./generated/responses";
export type { CreateProjectRequest, OpenProjectRequest, ReadProjectRequest, RenameProjectRequest, AddTargetLocaleRequest, SetTargetLocalesRequest, CloseProjectRequest } from "./generated/requests";

export function isCommandError(value: unknown): value is CommandError {
  return validateResponseError(value) && (value.code !== "outcome-unknown" || value.outcome === "unknown");
}
/** Transport failures do not prove rejection: retain the original action. */
export function hasUnknownOutcome(error: unknown): boolean {
  return !isCommandError(error) || error.outcome !== "rejected";
}

export const projectCommands = {
  setTargetLocales(request: SetTargetLocalesRequest) {
    return checkedInvoke("set_target_locales", request, validateResponseMetadataMutation);
  },
  create(request: CreateProjectRequest) {
    return checkedInvoke("create_project", request, validateResponseProjectView);
  },
  open(request: OpenProjectRequest) {
    return checkedInvoke("open_project", request, validateResponseProjectView);
  },
  read(request: ReadProjectRequest) {
    return checkedInvoke("read_project", request, validateResponseProjectView);
  },
  rename(request: RenameProjectRequest) {
    return checkedInvoke("rename_project", request, validateResponseMetadataMutation);
  },
  addTargetLocale(request: AddTargetLocaleRequest) {
    return checkedInvoke("add_target_locale", request, validateResponseMetadataMutation);
  },
  close(request: CloseProjectRequest) {
    return checkedInvoke("close_project", request, validateResponseClose);
  },
};
