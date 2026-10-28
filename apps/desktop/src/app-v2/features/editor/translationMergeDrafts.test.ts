import { afterEach, expect, it, vi } from "vitest";
import { canonicalTranslationReuse } from "../../../translationReuse";
import arenaFixture from "../../../../test/fixtures/arenaCommands.contract.json";
import type { ComparisonView, MergeRequest } from "../../../arenaCommands";
import { sameDraftMerge, sameDraftValue, type DraftBasis, type DraftHead, type DraftKey, type DraftMergeOrigin, type DraftReadView, type DraftValue } from "../../../draftCommands";
import { validateResponseComparison } from "../../../generated/arena.validators";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import type { TranslationSelection } from "../../../translationCommands";
import { TranslationDrafts, type TranslationDraftPorts } from "./translationDrafts";

const copy = <T,>(value: T): T => structuredClone(value);
const projectId = arenaFixture.requests.compare.projectId, sessionToken = "merge-draft-session";
const owners: TranslationDrafts[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.retire()); });
function fixtureComparison(): ComparisonView {
  const value: unknown = copy(arenaFixture.responses.comparison);
  if (!validateResponseComparison(value)) throw new Error("Invalid synthetic merge comparison");
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
type MergeRecovery = Awaited<ReturnType<TranslationDraftPorts["recoverMerge"]>>;
function recovery(request: MergeRequest, outcome: MergeRecovery["outcome"]): MergeRecovery {
  const { sessionToken: _session, merge, ...business } = request;
  return { request: { ...business, reuseOrigin: canonicalTranslationReuse(business.reuseOrigin), expectedSelectionId: business.expectedSelectionId ?? null }, merge: copy(merge), outcome };
}
const rejected = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "arena-basis" };

async function harness() {
  let comparison = fixtureComparison(), actionSequence = 810, receiptSequence = 850;
  const key: DraftKey = { projectId, unitId: comparison.unitId, locale: comparison.locale };
  let current: DraftReadView["current"] = { kind: "current", basis: { sourceRevisionId: comparison.sourceRevisionId, selectionId: comparison.selectionId,
    revisionId: comparison.selectedRevisionId, text: comparison.selectedText }, nativeKey: comparison.nativeKey, sourceText: comparison.sourceText };
  let disk: DraftHead = { key, revision: "0", writerId: null, value: null };
  const initialBasis = copy(current.basis);
  const origin: DraftMergeOrigin = { comparisonId: arenaFixture.requests.compare.actionId,
    contributors: comparison.rows.map(row => row.revisionId), expectedBasis: comparison.basis };
  function commit(request: MergeRequest): TranslationSelection {
    const selection: TranslationSelection = { actionId: request.actionId, unitId: request.unitId, locale: request.locale,
      eventId: fixtureIdentity(receiptSequence++), revisionId: fixtureIdentity(receiptSequence++), previousEventId: request.expectedSelectionId ?? null,
      sequence: request.expectedSelectionId ? "2" : "1" };
    current = { kind: "current", basis: { sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId,
      revisionId: selection.revisionId, text: request.text }, nativeKey: comparison.nativeKey, sourceText: comparison.sourceText };
    comparison = { ...comparison, selectionId: selection.eventId, selectedRevisionId: selection.revisionId, selectedText: request.text,
      basis: String(receiptSequence).padStart(64, "0") };
    return selection;
  }
  const ports = {
    read: vi.fn<TranslationDraftPorts["read"]>(async () => copy({ head: disk, current })),
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: disk.value ? [{ key, revision: disk.revision, editSeq: disk.value.editSeq,
      sourceRevisionId: disk.value.basis.sourceRevisionId, hasPending: disk.value.pending !== null }] : [], next: null })),
    write: vi.fn<TranslationDraftPorts["write"]>(async ({ write }) => {
      expect(write.key).toEqual(key); expect(write.expectedRevision).toBe(disk.revision);
      disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: write.writerId, value: copy(write.value) as DraftValue }; return copy(disk);
    }),
    clear: vi.fn<TranslationDraftPorts["clear"]>(async ({ clear }) => {
      expect(clear.expectedRevision).toBe(disk.revision); expect(disk.value?.pending).toBeNull();
      disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: null, value: null }; return copy(disk);
    }),
    identity: vi.fn<TranslationDraftPorts["identity"]>(async () => fixtureIdentity(actionSequence++)),
    comparison: vi.fn<TranslationDraftPorts["comparison"]>(async () => copy(comparison)),
    merge: vi.fn<TranslationDraftPorts["merge"]>(async request => commit(request)),
    recoverMerge: vi.fn<TranslationDraftPorts["recoverMerge"]>(async request => recovery(request, { kind: "pending", replay: "blocked" })),
    save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(),
    recoverSave: vi.fn<TranslationDraftPorts["recoverSave"]>(), recoverSelection: vi.fn<TranslationDraftPorts["recoverSelection"]>(),
    writerId: () => fixtureIdentity(809),
  };
  function create(token = sessionToken) {
    const owner = new TranslationDrafts({ context: { projectId, sessionToken: token }, reads: { invalidate: vi.fn() }, ports }); owners.push(owner); return owner;
  }
  const owner = create(); expect(await owner.initialize()).toBe(true); expect(await owner.open(key)).toBeDefined();
  function capture(active = owner) {
    const value = active.getEntry(key)?.value; if (!value) throw new Error("Missing synthetic draft");
    return { editSeq: value.editSeq, basis: copy(value.basis) };
  }
  return { owner, ports, key, origin, initialBasis, capture, create, commit, disk: () => copy(disk), view: () => copy(comparison),
    setCurrent: (value: DraftReadView["current"]) => { current = copy(value); }, setView: (value: ComparisonView) => { comparison = copy(value); },
    stage: (text = "Merged 👩🏽‍💻 é {name}\nSecond line", proof: () => boolean = () => true) => owner.stageMerge(key, copy(comparison), text, capture(), proof) };
}

it("keeps a checked merge's contributors and basis only in the existing Host journal until explicit confirmation", async () => {
  const h = await harness(), text = "  Human merge 👩🏽‍💻 é {name}\nKeep whitespace  ";
  expect(await h.stage(text)).toEqual({ staged: true, durable: true });
  expect(h.ports.comparison).toHaveBeenCalledWith({ projectId, sessionToken, comparisonId: h.origin.comparisonId });
  expect(h.ports.read).toHaveBeenCalledTimes(2);
  expect(h.disk().value).toMatchObject({ basis: h.initialBasis, text, editSeq: "1", pending: null, merge: h.origin });
  expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.merge).not.toHaveBeenCalled();
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
  expect(await h.owner.confirm(h.key)).toEqual({ confirmed: true, savedCurrent: true });
  expect(h.ports.merge).toHaveBeenCalledWith({ projectId, sessionToken, actionId: fixtureIdentity(810), unitId: h.key.unitId, locale: h.key.locale,
    sourceRevisionId: h.initialBasis.sourceRevisionId, expectedSelectionId: h.initialBasis.selectionId, text,
    merge: { contributors: h.origin.contributors, expectedBasis: h.origin.expectedBasis } });
  const pendingWrite = h.ports.write.mock.calls.find(([request]) => request.write.value.pending?.kind === "merge")?.[0].write.value.pending;
  expect(pendingWrite).toMatchObject({ kind: "merge", submittedSeq: "1", merge: { contributors: h.origin.contributors, expectedBasis: h.origin.expectedBasis }, request: { text } });
  expect(pendingWrite?.request).not.toHaveProperty("sessionToken");
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("reopens the actual written disk head with complete merge metadata and no automatic formal action", async () => {
  const h = await harness(); await h.stage("Recovered merge");
  const written = h.disk(); h.owner.retire(); const reopened = h.create("reopened-merge-session");
  expect(await reopened.initialize()).toBe(true); await reopened.open(h.key);
  expect(reopened.getEntry(h.key)?.head).toEqual(written);
  expect(reopened.getEntry(h.key)?.value).toMatchObject({ text: "Recovered merge", merge: h.origin, pending: null });
  expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.merge).not.toHaveBeenCalled();
});

it("keeps both text and merge provenance in memory when the Host journal cannot confirm the write", async () => {
  const h = await harness(); h.ports.write.mockRejectedValueOnce(new Error("Synthetic disk full"));
  expect(await h.stage("Unsaved merge")).toEqual({ staged: true, durable: false });
  expect(h.owner.getEntry(h.key)).toMatchObject({ value: { text: "Unsaved merge", merge: h.origin, pending: null }, failure: { kind: "journal" } });
  expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.merge).not.toHaveBeenCalled();
});

it.each(["same-as-base", "empty"] as const)("retains %s merge input as a real contributor-bearing draft", async kind => {
  const h = await harness(), text = kind === "empty" ? "" : h.initialBasis.text!;
  expect(await h.stage(text)).toEqual({ staged: true, durable: true });
  expect(h.disk().value).toMatchObject({ text, merge: h.origin });
  expect(h.disk().value).not.toBeNull(); expect(h.owner.getSnapshot().summaries).toHaveLength(1);
  expect(await h.owner.confirm(h.key)).toEqual({ confirmed: true, savedCurrent: true });
  expect(h.ports.merge.mock.calls[0][0]).toMatchObject({ text, merge: { contributors: h.origin.contributors, expectedBasis: h.origin.expectedBasis } });
  expect(h.ports.save).not.toHaveBeenCalled();
});

it("preserves B and its merge origin after A is confirmed, then requires an explicit current-basis refresh before B can be confirmed", async () => {
  const h = await harness(); await h.stage("Submitted A");
  const response = deferred<TranslationSelection>(); h.ports.merge.mockReturnValueOnce(response.promise);
  const confirming = h.owner.confirm(h.key);
  await vi.waitFor(() => expect(h.ports.merge).toHaveBeenCalledTimes(1));
  h.owner.edit(h.key, "Newer B"); await h.owner.flush(h.key);
  const original = copy(h.ports.merge.mock.calls[0][0]), receipt = h.commit(original);
  response.resolve(receipt);
  expect(await confirming).toEqual({ confirmed: true, savedCurrent: false });
  expect(h.disk().value).toMatchObject({ text: "Newer B", merge: h.origin, pending: null, basis: { text: "Submitted A", selectionId: receipt.eventId } });
  expect(h.owner.getEntry(h.key)).toMatchObject({ failure: { kind: "basis-conflict" }, newerInputAfterConfirmation: true });
  const allocated = h.ports.identity.mock.calls.length;
  expect(await h.owner.confirm(h.key)).toEqual({ confirmed: false, savedCurrent: false });
  expect(h.ports.identity).toHaveBeenCalledTimes(allocated); expect(h.ports.merge).toHaveBeenCalledTimes(1);
  const updated = h.view(); expect(await h.owner.refreshMerge(h.key)).toBe(true);
  expect(h.disk().value).toMatchObject({ text: "Newer B", merge: { ...h.origin, expectedBasis: updated.basis }, basis: { selectionId: receipt.eventId, text: "Submitted A" } });
  expect(await h.owner.confirm(h.key)).toEqual({ confirmed: true, savedCurrent: true });
  expect(h.ports.merge.mock.calls[1][0]).toMatchObject({ text: "Newer B", expectedSelectionId: receipt.eventId,
    merge: { contributors: h.origin.contributors, expectedBasis: updated.basis } });
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("does not let a late merge-basis refresh erase text edited during its comparison read", async () => {
  const h = await harness(); await h.stage("Merge A");
  const response = deferred<ComparisonView>(); h.ports.comparison.mockReturnValueOnce(response.promise);
  const refreshing = h.owner.refreshMerge(h.key); h.owner.edit(h.key, "B during refresh");
  response.resolve(h.view()); expect(await refreshing).toBe(false); await h.owner.flush(h.key);
  expect(h.disk().value).toMatchObject({ text: "B during refresh", merge: h.origin });
  expect(h.ports.merge).not.toHaveBeenCalled();
});

it("rechecks the current selection when explicitly refreshing merge sources, without rebinding a newer input to a stale comparison", async () => {
  const h = await harness(); await h.stage("Keep this merge");
  const changed: DraftBasis = { ...h.initialBasis, selectionId: fixtureIdentity(900), revisionId: fixtureIdentity(901), text: "Other selection" };
  h.setCurrent({ kind: "current", basis: changed, nativeKey: h.view().nativeKey, sourceText: h.view().sourceText });
  expect(await h.owner.refreshMerge(h.key)).toBe(false);
  expect(h.disk().value).toMatchObject({ text: "Keep this merge", basis: h.initialBasis, merge: h.origin });
  expect(h.ports.merge).not.toHaveBeenCalled();
});

it("uses the complete original unknown merge request with the new Host session and only permits explicit same-request replay", async () => {
  const h = await harness(); await h.stage("Original merge A");
  h.ports.merge.mockRejectedValueOnce(new Error("Lost merge acknowledgement")).mockRejectedValueOnce(rejected);
  expect(await h.owner.confirm(h.key)).toEqual({ confirmed: false, savedCurrent: false });
  const original = copy(h.ports.merge.mock.calls[0][0]), pending = copy(h.owner.getEntry(h.key)!.value!.pending);
  h.owner.edit(h.key, "Preserved B"); await h.owner.flush(h.key); h.owner.retire();
  const reopened = h.create("new-merge-session"); await reopened.initialize(); await reopened.open(h.key);
  expect(reopened.getEntry(h.key)?.value).toMatchObject({ text: "Preserved B", merge: h.origin, pending });
  expect(h.ports.merge).toHaveBeenCalledTimes(1); expect(h.ports.identity).toHaveBeenCalledTimes(1);
  await reopened.replay(h.key); expect(h.ports.merge).toHaveBeenCalledTimes(1);
  h.ports.recoverMerge.mockImplementationOnce(async request => recovery(request, { kind: "pending", replay: "explicit-same-request" }));
  await reopened.recover(h.key);
  expect(h.ports.recoverMerge).toHaveBeenLastCalledWith({ ...original, sessionToken: "new-merge-session" });
  expect(reopened.getEntry(h.key)?.replayAllowed).toBe(true);
  await reopened.replay(h.key);
  expect(h.ports.merge.mock.calls[1][0]).toEqual({ ...original, sessionToken: "new-merge-session" });
  expect(reopened.getEntry(h.key)).toMatchObject({ value: { text: "Preserved B", pending, merge: h.origin }, recovery: "unchecked", replayAllowed: false });
  await reopened.replay(h.key); expect(h.ports.merge).toHaveBeenCalledTimes(2);
  expect(h.ports.identity).toHaveBeenCalledTimes(1); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it.each(["blocked", "mismatch", "read-failed"] as const)("keeps %s merge recovery unavailable for replay instead of falling back to a text-only save", async condition => {
  const h = await harness(); await h.stage("Merge to retain"); h.ports.merge.mockRejectedValueOnce(new Error("Lost acknowledgement"));
  if (condition === "read-failed") h.ports.recoverMerge.mockRejectedValueOnce(new Error("Recovery unavailable"));
  else h.ports.recoverMerge.mockImplementationOnce(async request => recovery(request,
    condition === "blocked" ? { kind: "pending", replay: "blocked" } : { kind: "mismatch" }));
  await h.owner.confirm(h.key); await h.owner.replay(h.key);
  expect(h.owner.getEntry(h.key)?.value?.pending?.kind).toBe("merge"); expect(h.owner.getEntry(h.key)?.replayAllowed).toBe(false);
  expect(h.ports.merge).toHaveBeenCalledTimes(1); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
  expect(h.ports.recoverSave).not.toHaveBeenCalled(); expect(h.ports.recoverSelection).not.toHaveBeenCalled();
});

it("settles a recorded original merge through a read alone and clears its pending journal without dispatching the merge again", async () => {
  const h = await harness(); await h.stage("Applied but unacknowledged merge");
  h.ports.merge.mockRejectedValueOnce(new Error("Lost acknowledgement")); await h.owner.confirm(h.key);
  const original = copy(h.ports.merge.mock.calls[0][0]), receipt = h.commit(original);
  h.ports.recoverMerge.mockImplementationOnce(async request => recovery(request, { kind: "recorded", receipt }));
  expect(await h.owner.recover(h.key)).toEqual({ confirmed: true, savedCurrent: true });
  expect(h.ports.recoverMerge).toHaveBeenLastCalledWith(original);
  expect(h.owner.getEntry(h.key)?.value?.pending).toBeNull(); expect(h.disk().value).toBeNull();
  expect(h.ports.merge).toHaveBeenCalledTimes(1); expect(h.ports.identity).toHaveBeenCalledTimes(1);
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it.each(["input", "source", "selection", "rejected-parent", "proof"] as const)("refuses to stage a merge after late %s changes", async change => {
  const h = await harness(), view = h.view(), response = deferred<ComparisonView>(); let valid = true;
  h.ports.comparison.mockReturnValueOnce(response.promise);
  const staging = h.stage("Merge that must not replace input", () => valid);
  if (change === "input") h.owner.edit(h.key, "Local B");
  else if (change === "source") h.setCurrent({ kind: "current", basis: { ...h.initialBasis, sourceRevisionId: fixtureIdentity(910) }, nativeKey: view.nativeKey, sourceText: "Changed source" });
  else if (change === "selection") h.setCurrent({ kind: "current", basis: { ...h.initialBasis, selectionId: fixtureIdentity(911), revisionId: fixtureIdentity(912), text: "New selected text" }, nativeKey: view.nativeKey, sourceText: view.sourceText });
  else if (change === "proof") valid = false;
  const fresh = copy(view); if (change === "rejected-parent") fresh.rows[0].candidateDisposition = "rejected";
  response.resolve(fresh);
  expect(await staging).toEqual({ staged: false, durable: false });
  expect(h.owner.getEntry(h.key)?.value?.text).toBe(change === "input" ? "Local B" : h.initialBasis.text);
  expect(h.owner.getEntry(h.key)?.value?.merge).toBeUndefined();
  expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.merge).not.toHaveBeenCalled();
});

it("rechecks the original proof after the fresh current read before writing any merge input", async () => {
  const h = await harness(), response = deferred<DraftReadView>(); let valid = true;
  h.ports.read.mockReturnValueOnce(response.promise);
  const staging = h.stage("Late merge", () => valid);
  await vi.waitFor(() => expect(h.ports.read).toHaveBeenCalledTimes(2)); valid = false;
  response.resolve({ head: h.disk(), current: { kind: "current", basis: h.initialBasis, nativeKey: h.view().nativeKey, sourceText: h.view().sourceText } });
  expect(await staging).toEqual({ staged: false, durable: false }); expect(h.ports.write).not.toHaveBeenCalled();
});

it("does not acknowledge equal text and edit sequences when contributor identity, order or the merge basis differs", async () => {
  const h = await harness(); await h.stage("Same body");
  const value = h.disk().value; if (!value?.merge) throw new Error("Missing merge provenance");
  expect(sameDraftValue(value, copy(value))).toBe(true);
  expect(sameDraftValue(value, { ...value, merge: { ...value.merge, contributors: [...value.merge.contributors].reverse() } })).toBe(false);
  expect(sameDraftValue(value, { ...value, merge: { ...value.merge, comparisonId: fixtureIdentity(920) } })).toBe(false);
  expect(sameDraftValue(value, { ...value, merge: { ...value.merge, expectedBasis: "c".repeat(64) } })).toBe(false);
  expect(sameDraftMerge(undefined, null)).toBe(true); expect(sameDraftMerge(value.merge, null)).toBe(false);
});
