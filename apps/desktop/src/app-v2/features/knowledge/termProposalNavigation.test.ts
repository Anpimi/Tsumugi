import { expect, it, vi } from "vitest";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { termProposalFixture } from "../../../testSupport/termProposalFixture";
import { resolveTermProposalReview } from "./termProposalNavigation";

const context = { projectId: id(84001), sessionToken: "term-navigation" }, conversationId = id(84002);
function setup() {
  const fixture = termProposalFixture({ projectId: context.projectId, conversationId }), revision = fixture.revision;
  const reference = { projectId: revision.projectId, conversationId, proposalId: revision.proposalId, revisionId: revision.revisionId };
  const commands = { proposal: vi.fn(async () => structuredClone(fixture.revision)), planning: vi.fn(async () => structuredClone(fixture.run)),
    preview: vi.fn(async () => structuredClone(fixture.preview)) };
  return { fixture, reference, commands };
}

it("opens the original saved revision capture using reads, including historical evidence", async () => {
  const h = setup();
  if (!h.fixture.preview.conversation) throw new Error("Expected conversation provenance");
  h.fixture.preview.conversation.current = false;
  expect(await resolveTermProposalReview(context, h.reference, () => true, h.commands)).toEqual(h.fixture.preview.capture);
  expect(h.commands.preview).toHaveBeenCalledWith({ ...context, captureId: h.reference.revisionId });
  expect(h.commands.planning).toHaveBeenCalledWith({ ...context, conversationId, attemptId: h.fixture.revision.origin.attemptId });
});

it.each(["revision", "result", "input", "origin", "entries"] as const)("rejects a changed %s in the original result chain", async changed => {
  const h = setup();
  if (changed === "revision") h.fixture.revision.revisionId = id(84009);
  if (changed === "result") h.fixture.run.resultId = id(84009);
  if (changed === "input") h.fixture.run.receipt.inputDigest = "f".repeat(64);
  if (changed === "origin" && h.fixture.preview.capture.origin.kind === "conversation") h.fixture.preview.capture.origin.modelOrigin.resultId = id(84009);
  if (changed === "entries" && h.fixture.revision.content.kind === "term-proposal") h.fixture.revision.content.entries[0].source = "Changed evidence";
  await expect(resolveTermProposalReview(context, h.reference, () => true, h.commands)).rejects.toThrow();
});

it("abandons a late source read after navigation changes", async () => {
  const h = setup(); let current = true;
  h.commands.planning.mockImplementation(async () => { current = false; return h.fixture.run; });
  await expect(resolveTermProposalReview(context, h.reference, () => current, h.commands)).rejects.toThrow("navigation changed");
});
