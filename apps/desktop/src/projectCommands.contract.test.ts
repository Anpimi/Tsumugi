import { describe, expect, it } from "vitest";
import contract from "../test/fixtures/projectCommands.contract.json";
import type {
  AddTargetLocaleRequest,
  CloseProjectRequest,
  CloseProjectView,
  CommandError,
  CreateProjectRequest,
  MetadataMutationView,
  OpenProjectRequest,
  ProjectView,
  ReadProjectRequest,
  RenameProjectRequest,
} from "./projectCommands";

const requests: {
  create: CreateProjectRequest;
  open: OpenProjectRequest;
  read: ReadProjectRequest;
  reconcile: ReadProjectRequest;
  rename: RenameProjectRequest;
  addTargetLocale: AddTargetLocaleRequest;
  close: CloseProjectRequest;
} = contract.requests;

const responses: {
  projectView: ProjectView;
  metadataMutation: MetadataMutationView;
  close: CloseProjectView;
} = {
  projectView: {
    ...contract.responses.projectView,
    reconciliationState: contract.responses.projectView.reconciliationState as ProjectView["reconciliationState"],
  },
  metadataMutation: {
    ...contract.responses.metadataMutation,
    outcome: contract.responses.metadataMutation.outcome as MetadataMutationView["outcome"],
  },
  close: contract.responses.close,
};

const error: CommandError = {
  ...contract.error,
  code: contract.error.code as CommandError["code"],
  stage: contract.error.stage as CommandError["stage"],
};

describe("project command wire contract", () => {
  it("keeps TypeScript DTOs aligned with the Rust serialization fixture", () => {
    expect(requests.reconcile).toEqual({ sessionToken: "session-1", expectedRevision: "1" });
    expect(requests.rename).toEqual({
      sessionToken: "session-1",
      expectedRevision: "18446744073709551615",
      displayName: "Literal name",
      directoryName: "renamed-folder",
    });
    expect(responses.projectView.metadata.metadataRevision).toMatch(/^\d+$/);
    expect(responses.projectView.reconciliationState).toBe("settled");
    expect(responses.metadataMutation.outcome).toBe("changed");
    expect(responses.metadataMutation.directoryChanged).toBe(false);
    expect(responses.close.closed).toBe(true);
    expect(error).toEqual({
      code: "outcome-unknown",
      stage: "rename",
      recoveryRequired: true,
    });
  });

  it("uses camelCase wire names and decimal revision strings", () => {
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toMatch(/session_token|expected_revision|metadata_revision|recovery_required/);
    expect(requests.rename.expectedRevision).toMatch(/^\d+$/);
    expect(responses.projectView.metadata.metadataRevision).toMatch(/^\d+$/);
  });
});
