import { useLayoutEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSessionOwners } from "./ProjectSessionWorkbench";
import { useSessionReads } from "./SessionReadProvider";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useAiPreparation } from "./AiPreparationSession";
import type { ProjectView } from "./projectCommands";
import fixture from "../test/fixtures/translation-commands.json";
import { fixtureIdentity } from "./testSupport/executionFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
beforeEach(() => { invoke.mockReset(); });
afterEach(cleanup);

it("keeps the original owners for copying while retired handlers cannot edit or dispatch", async () => {
  render(<ProjectSessionOwners project={project} bridge={false}><Probe /></ProjectSessionOwners>);
  act(() => { begin(); review.setActor("Original author"); ai.setSelected([fixture.receipt.revision.unitId]); ai.setPresetName("Original settings"); });
  const originalDraft = drafts.current(), originalReview = review.current(), originalAi = ai.current();
  act(() => reads.retire());
  act(() => { drafts.edit("Stale edit"); review.setActor("Stale author"); ai.setPresetName("Stale settings"); });
  await act(async () => { expect((await drafts.save()).saved).toBe(false); await ai.preview(); });
  expect(screen.getByLabelText("Local translation")).toHaveTextContent("Newer B");
  expect(drafts.current()).toBe(originalDraft); expect(review.current()).toBe(originalReview); expect(ai.current()).toBe(originalAi);
  expect(drafts.reserveMutation()).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it("ends the original continuation before identity acknowledgement without unmounting its draft", async () => {
  let finish!: (identity: string) => void;
  invoke.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  render(<ProjectSessionOwners project={project} bridge={false}><Probe /></ProjectSessionOwners>);
  act(begin);
  let pending!: ReturnType<typeof drafts.save>; act(() => { pending = drafts.save(); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() => { drafts.edit("Latest input C"); reads.retire(); });
  await act(async () => { finish(fixtureIdentity(980)); expect((await pending).saved).toBe(false); });
  expect(screen.getByLabelText("Local translation")).toHaveTextContent("Latest input C");
  expect(drafts.current()?.text).toBe("Latest input C");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["create_execution_identity"]);
});
