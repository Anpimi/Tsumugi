import { checkedInvoke } from "./ipc";
import { sameSourceEnvironment } from "./sourceCommands";
import type { StartupClaimRequest, StartupDropRequest, StartupPreflightRequest } from "./generated/source.requests";
import type { Responses, PluginSourceSelection, StartupPreflight } from "./generated/source.responses";
import { validateResponseStartupDirectory, validateResponseStartupPreflight, validateResponseStartupDropEvent, validateResponsePluginSelection } from "./generated/source.validators";

export type StartupDirectory = NonNullable<Responses["startupDirectory"]>;
export type { StartupPreflight, StartupDropEvent } from "./generated/source.responses";
export type { StartupClaimRequest, StartupPreflightRequest } from "./generated/source.requests";
export { validateResponseStartupDropEvent };

function declaredFilesMatch(value: StartupPreflight) {
  const declared = value.source.declaration.materials;
  return declared.length === value.materials.length && value.materials.every((file, index) => {
    const expected = declared[index];
    return file.logicalPath === expected.logicalPath && file.role === expected.role && file.maxBytes === expected.maxBytes
      && (file.byteLength === null ? file.sha256 === null : file.sha256 !== null && file.byteLength <= file.maxBytes);
  }) && value.complete === value.materials.every(file => file.byteLength !== null);
}

/** Native paths stay in the Host. Preparation does not start an import. */
export const startupCommands = {
  chooseDirectory: () => checkedInvoke("select_startup_source_directory", {}, validateResponseStartupDirectory),
  droppedDirectory: (request: StartupDropRequest) => checkedInvoke("select_dropped_startup_source_directory", request,
    (value): value is StartupDirectory => validateResponseStartupDirectory(value) && value !== null),
  preflight: (input: StartupPreflightRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("read_startup_source_preflight", request, (value): value is StartupPreflight => validateResponseStartupPreflight(value)
      && value.directory.selectionId === request.selectionId && sameSourceEnvironment(value.source, request.source) && declaredFilesMatch(value));
  },
  claimDirectory: (input: StartupClaimRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("claim_startup_source_directory", request, (value): value is PluginSourceSelection => validateResponsePluginSelection(value)
      && value !== null && value.selectionId === request.selectionId && sameSourceEnvironment(value.source, request.source));
  },
};
