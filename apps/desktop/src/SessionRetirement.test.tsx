import { createRef, useLayoutEffect, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSessionOwners, ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { useSessionReads } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import * as draftOwner from "./TranslationDraftSession";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useAiPreparation } from "./AiPreparationSession";
import type { ProjectView } from "./projectCommands";
import fixture from "../test/fixtures/translation-commands.json";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import type { SessionExitPermit } from "./sessionNavigation";
import executionFixture from "../test/fixtures/executionCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const project: ProjectView = { ...fixture.start, locator: "C:\\isolated\\retired-drafts", reconciliationState: "settled",
  metadata: { projectId: fixture.start.projectId, displayName: "Fixture", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let drafts: ReturnType<typeof useTranslationDraftSession>, review: ReturnType<typeof useReviewDraftSession>;
let ai: ReturnType<typeof useAiPreparation>, reads: ReturnType<typeof useSessionReads>;
function Probe() {
  const translation = useTranslationDraftSession(), reasons = useReviewDraftSession(), preparation = useAiPreparation(), queries = useSessionReads();
  useLayoutEffect(() => { drafts = translation; review = reasons; ai = preparation; reads = queries; });
  return <output aria-label="Local translation">{translation.draft?.text}</output>;
}
function begin() {
  drafts.begin({ unitId: fixture.receipt.revision.unitId, locale: "zh-CN", sourceRevisionId: fixture.receipt.revision.sourceRevisionId,
    key: "key", sourceText: "Original" }, null, null);
  drafts.edit("Newer B");
}
beforeEach(() => { invoke.mockReset(); invoke.mockImplementation(async (command: string) => {
  if (command === "read_context_strategy_default") return null;
  throw new Error(command);
}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("revokes an issued exit permit synchronously for pending editor input and exposes its original owner", async () => {
  const handle = createRef<ProjectSessionHandle>(), actual = draftOwner.useTranslationDraftSession;
  let memory!: WorkspaceViewMemory;
  vi.spyOn(draftOwner, "useTranslationDraftSession").mockImplementation(() => { const owner = actual(); drafts = owner; return owner; });
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_context_strategy_default") return null;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: null };
    if (command === "read_project_changes") return { projectId: project.metadata.projectId, sessionToken: project.sessionToken,
      epoch: fixtureIdentity(981), sequence: "0", progressSequence: "0", scopes: [], runtime: executionFixture.status };
    if (command === "read_execution_task_activity") return { total: "0", active: "0", attention: "0", saved: "0", rows: [] };
    throw new Error(command);
  });
  function Harness() {
    const [area, activate] = useState<WorkspaceArea>("overview"), [retained] = useState(() => new WorkspaceViewMemory());
    const [commands] = useState(() => new WorkbenchCommands()); memory = retained;
    return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}>
      <WorkspaceViewProvider value={{ area, memory: retained, activate, deactivate: () => activate("overview") }}>
        <ProjectSessionWorkbench ref={handle} project={project} disabled={false} onActivate={activate} onCoordinatingChange={() => {}} />
      </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
  }
  render(<Harness />);
  act(() => { drafts.begin({ unitId: fixture.receipt.revision.unitId, locale: "zh-CN", sourceRevisionId: fixture.receipt.revision.sourceRevisionId,
    key: "key", sourceText: "Original" }, null, null); });
  const before = drafts.current(); let permit!: SessionExitPermit | null;
  await act(async () => { permit = await handle.current!.prepareExit(); });
  expect(permit?.current()).toBe(true); let token!: symbol | null;
  act(() => { token = drafts.reserveInputMutation(); expect(permit?.current()).toBe(false); });
  expect(drafts.current()).toBe(before); permit!.release();
  await act(async () => { expect(await handle.current!.prepareExit()).toBeNull(); });
  expect(memory.read("translation", "tab")).toBe("edit");
  act(() => drafts.releaseMutation(token!));
  expect(permit!.current()).toBe(false);
  await act(async () => { permit = await handle.current!.prepareExit(); });
  expect(permit?.current()).toBe(true);
  act(() => handle.current!.retire());
  expect(permit?.current()).toBe(false); expect(drafts.reserveInputMutation()).toBeNull();
});

it("keeps the original owners for copying while retired handlers cannot edit or dispatch", async () => {
  render(<ApplicationReadProvider><ProjectSessionOwners project={project} bridge={false}><Probe /></ProjectSessionOwners></ApplicationReadProvider>);
  act(() => { begin(); review.setActor("Original author"); ai.setSelected([fixture.receipt.revision.unitId]); ai.setPresetName("Original settings"); });
  const originalDraft = drafts.current(), originalReview = review.current(), originalAi = ai.current();
  act(() => reads.retire());
  act(() => { drafts.edit("Stale edit"); review.setActor("Stale author"); ai.setPresetName("Stale settings"); });
  await act(async () => { expect((await drafts.save()).saved).toBe(false); await ai.preview(); });
  expect(screen.getByLabelText("Local translation")).toHaveTextContent("Newer B");
  expect(drafts.current()).toBe(originalDraft); expect(review.current()).toBe(originalReview); expect(ai.current()).toBe(originalAi);
  expect(drafts.reserveMutation()).toBeNull();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_context_strategy_default"]);
});

it("ends the original continuation before identity acknowledgement without unmounting its draft", async () => {
  let finish!: (identity: string) => void;
  invoke.mockImplementation((command: string) => {
    if (command === "read_context_strategy_default") return Promise.resolve(null);
    if (command === "create_execution_identity") return new Promise<string>(resolve => { finish = resolve; });
    throw new Error(command);
  });
  render(<ApplicationReadProvider><ProjectSessionOwners project={project} bridge={false}><Probe /></ProjectSessionOwners></ApplicationReadProvider>);
  act(begin);
  let pending!: ReturnType<typeof drafts.save>; act(() => { pending = drafts.save(); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() => { drafts.edit("Latest input C"); reads.retire(); });
  await act(async () => { finish(fixtureIdentity(980)); expect((await pending).saved).toBe(false); });
  expect(screen.getByLabelText("Local translation")).toHaveTextContent("Latest input C");
  expect(drafts.current()?.text).toBe("Latest input C");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_context_strategy_default", "create_execution_identity"]);
});
