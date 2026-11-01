import type { conversationReferencesEn } from "../../../i18n/conversationReferences";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationReferencePage } from "../../../conversationCommands";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { conversationProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import type { OpenConversationEntryReference } from "./ConversationEntryReferences";
import { ConversationMaterialReferences } from "./ConversationMaterialReferences";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const t = (key: keyof typeof conversationReferencesEn, values = {}) => i18n.t(`conversation.${key}`, values);
const disposals: (() => void)[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const context = { projectId: id(72000), sessionToken: "material-reference-session" };
  const { run } = conversationProposalFixture({ projectId: context.projectId, conversationId: id(72001) });
  const source = run.preview.units[0], revisionId = id(72002);
  source.sharedTermRevisionIds = [revisionId];
  const unit = { unitId: source.unitId, locale: "zh-CN", sourceSnapshotId: source.sourceSnapshotId, sourceRevisionId: source.sourceRevisionId };
  const original = { termId: "term-one", revisionId, source: "Harbor", target: "Original harbor", protected: false, originKind: "manual" as const, removed: false };
  const page: ConversationReferencePage = { projectId: context.projectId, conversationId: run.preview.conversationId, attemptId: run.detail.attemptId,
    inputDigest: run.receipt.inputDigest, currentSnapshotId: unit.sourceSnapshotId, after: 0, total: 2, nextAfter: null,
    rows: [{ kind: "term", unit, original, current: { ...original, revisionId: id(72003), target: "Current harbor" } },
      { kind: "file", unit: { ...unit }, artifactId: id(72004), logicalPath: "dialogue/chapter.txt", role: "source" }] };
  return { context, run, page };
}
function harness(change?: (page: ConversationReferencePage) => void, callback = vi.fn<OpenConversationEntryReference>(async () => true)) {
  const h = fixture(); change?.(h.page);
  const reads = new SessionReads(h.context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  invoke.mockImplementation(async command => { if (command === "read_conversation_references") return structuredClone(h.page); throw new Error(`Unexpected command: ${command}`); });
  const props = { context: h.context, run: h.run, visible: true, disabled: false, gate, viewId: "entries", onOpenEntry: callback };
  const tree = () => <SessionReadProvider context={h.context} reads={reads} bridge={false}><ConversationMaterialReferences {...props}/></SessionReadProvider>;
  const rendered = render(tree());
  const dispose = () => { rendered.unmount(); reads.retire(); gate.dispose(); }; disposals.push(dispose);
  const key = reads.key(["conversation-material-references", h.run.preview.conversationId, h.run.detail.attemptId, h.run.receipt.inputDigest, 0]);
  return { ...h, reads, gate, callback, key, dispose, hide() { props.visible = false; rendered.rerender(tree()); } };
}
async function expand() {
  fireEvent.click(screen.getByRole("button", { name: t("showMaterialReferences") }));
  await screen.findByRole("button", { name: t("inspectMaterialReference", { name: "Harbor" }) });
}
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("en-US"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose());
  expect(invoke.mock.calls.every(([command]) => command === "read_conversation_references")).toBe(true); });

it("reads original and current term evidence and source-file association without writing or opening a file", async () => {
  const h = harness(); expect(invoke).not.toHaveBeenCalled(); await expand();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("read_conversation_references", { request: { ...h.context, conversationId: h.page.conversationId,
    attemptId: h.page.attemptId, after: 0, limit: 8 } });
  fireEvent.click(screen.getByRole("button", { name: t("inspectMaterialReference", { name: "Harbor" }) }));
  let dialog = screen.getByRole("dialog", { name: t("materialReferenceDetails") });
  expect(within(dialog).getByText("Original harbor")).toBeVisible(); expect(within(dialog).getByText("Current harbor")).toBeVisible();
  expect(within(dialog).getByText(t("materialTermHistorical"))).toBeVisible(); expect(within(dialog).getByText(t("materialReferenceReadOnly"))).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: t("materialReferenceClose") }));
  fireEvent.click(screen.getByRole("button", { name: t("inspectMaterialReference", { name: "dialogue/chapter.txt" }) }));
  dialog = screen.getByRole("dialog", { name: t("materialReferenceDetails") });
  expect(within(dialog).getByText("dialogue/chapter.txt")).toBeVisible(); expect(within(dialog).getByText(t("materialFileEvidence"))).toBeVisible();
  expect(within(dialog).getByText(t("materialReferenceReadOnly"))).toBeVisible(); expect(h.callback).not.toHaveBeenCalled();
});

it("keeps historical source evidence readable but prevents locating a current entry", async () => {
  const h = harness(page => { page.currentSnapshotId = id(72900); }); await expand();
  for (const name of ["Harbor", "dialogue/chapter.txt"]) {
    const locate = screen.getByRole("button", { name: t("locateMaterialReference", { name }) });
    expect(locate).toBeDisabled(); fireEvent.click(locate);
    fireEvent.click(screen.getByRole("button", { name: t("inspectMaterialReference", { name }) }));
    const dialog = screen.getByRole("dialog", { name: t("materialReferenceDetails") });
    expect(within(dialog).getByText(t("materialSourceHistorical"))).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: t("materialReferenceClose") }));
  }
  expect(h.callback).not.toHaveBeenCalled();
});

it.each(["unit", "term", "provenance"] as const)("rejects %s mismatches before showing reference actions", async change => {
  const h = harness(page => {
    const row = page.rows[0];
    if (change === "unit") row.unit.sourceRevisionId = id(72901);
    if (change === "term" && row.kind === "term") row.original.revisionId = id(72901);
    if (change === "provenance") page.inputDigest = "c".repeat(64);
  });
  fireEvent.click(screen.getByRole("button", { name: t("showMaterialReferences") }));
  await screen.findByText(t("materialReferencesFailed"));
  expect(screen.queryByRole("button", { name: t("locateMaterialReference", { name: "Harbor" }) })).not.toBeInTheDocument();
  expect(h.callback).not.toHaveBeenCalled();
});

it.each(["invalidate", "same-data", "dialog", "hide"] as const)("revokes an in-flight locate proof on %s", async guard => {
  const pending = deferred<boolean>(), callback = vi.fn<OpenConversationEntryReference>(() => pending.promise), h = harness(undefined, callback);
  await expand(); fireEvent.click(screen.getByRole("button", { name: t("locateMaterialReference", { name: "Harbor" }) }));
  await waitFor(() => expect(callback).toHaveBeenCalledOnce());
  const [reference, current] = callback.mock.calls[0];
  expect(reference).toEqual({ projectId: h.context.projectId, conversationId: h.page.conversationId, attemptId: h.page.attemptId,
    ...h.page.rows[0].unit, detailTab: "context" }); expect(current()).toBe(true);
  act(() => {
    if (guard === "invalidate") h.reads.invalidate(["resources"]);
    if (guard === "same-data") h.reads.client.setQueryData(h.key, h.reads.client.getQueryData(h.key));
    if (guard === "dialog") h.gate.pushDialog("other-dialog");
    if (guard === "hide") h.hide();
  });
  expect(current()).toBe(false);
  await act(async () => { pending.resolve(false); await pending.promise; });
  expect(screen.queryByText(t("materialReferenceChanged"))).not.toBeInTheDocument();
  expect(callback).toHaveBeenCalledOnce();
});

it("warns inside the open inspector after invalidation and refreshes current evidence through its dialog gate", async () => {
  const h = harness(); await expand();
  fireEvent.click(screen.getByRole("button", { name: t("inspectMaterialReference", { name: "Harbor" }) }));
  const dialog = screen.getByRole("dialog", { name: t("materialReferenceDetails") });
  expect(within(dialog).getByText("Current harbor")).toBeVisible();
  const updated = structuredClone(h.page), term = updated.rows[0];
  if (term.kind !== "term" || !term.current) throw new Error("Current synthetic term required");
  term.current.target = "Updated current harbor";
  const invalidated = deferred<ConversationReferencePage>();
  invoke.mockImplementationOnce(() => invalidated.promise);
  act(() => { h.reads.invalidate(["resources"]); });
  await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent(t("materialReferencesStale")));
  expect(within(dialog).getByText("Current harbor")).toBeVisible();
  await act(async () => { invalidated.resolve(updated); await invalidated.promise; });
  await waitFor(() => expect(within(dialog).getByText("Updated current harbor")).toBeVisible());
  expect(within(dialog).queryByText(t("materialReferencesStale"))).not.toBeInTheDocument();
  const refreshed = structuredClone(updated), refreshedTerm = refreshed.rows[0];
  if (refreshedTerm.kind !== "term" || !refreshedTerm.current) throw new Error("Current synthetic term required");
  refreshedTerm.current.target = "Refreshed current harbor";
  const pending = deferred<ConversationReferencePage>();
  invoke.mockImplementationOnce(() => pending.promise);
  fireEvent.click(within(dialog).getByRole("button", { name: t("materialReferencesRefresh") }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent(t("materialReferencesStale")));
  await act(async () => { pending.resolve(refreshed); await pending.promise; });
  await waitFor(() => expect(within(dialog).getByText("Refreshed current harbor")).toBeVisible());
  expect(within(dialog).queryByText(t("materialReferencesStale"))).not.toBeInTheDocument();
  expect(within(dialog).getByText("Original harbor")).toBeVisible(); expect(h.callback).not.toHaveBeenCalled();
});

it("warns on invalidation without refetch and refuses stale reference dispatch without issuing another read", async () => {
  const h = harness(); await expand();
  fireEvent.click(screen.getByRole("button", { name: t("inspectMaterialReference", { name: "Harbor" }) }));
  const dialog = screen.getByRole("dialog", { name: t("materialReferenceDetails") });
  expect(within(dialog).getByText("Current harbor")).toBeVisible();
  await act(async () => { await h.reads.client.invalidateQueries({ queryKey: h.key, exact: true, refetchType: "none" }); });
  await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent(t("materialReferencesStale")));
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: t("materialReferenceClose") }));
  const locate = screen.getByRole("button", { name: t("locateMaterialReference", { name: "Harbor" }) });
  expect(locate).toBeDisabled(); fireEvent.click(locate);
  const inspect = screen.getByRole("button", { name: t("inspectMaterialReference", { name: "Harbor" }) });
  expect(inspect).toBeDisabled(); fireEvent.click(inspect);
  expect(h.callback).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: t("materialReferenceDetails") })).not.toBeInTheDocument();
});

it("checks the query state at dispatch before a stale render can disable the buttons", async () => {
  const h = harness(); await expand();
  const locate = screen.getByRole("button", { name: t("locateMaterialReference", { name: "Harbor" }) });
  const inspect = screen.getByRole("button", { name: t("inspectMaterialReference", { name: "Harbor" }) });
  expect(locate).toBeEnabled(); expect(inspect).toBeEnabled();
  act(() => {
    void h.reads.client.invalidateQueries({ queryKey: h.key, exact: true, refetchType: "none" });
    fireEvent.click(locate); fireEvent.click(inspect);
  });
  expect(h.callback).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: t("materialReferenceDetails") })).not.toBeInTheDocument();
});
