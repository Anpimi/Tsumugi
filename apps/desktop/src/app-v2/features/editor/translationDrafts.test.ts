import { expect, it, vi } from "vitest";
import fixture from "../../../../test/fixtures/translation-commands.json";
import { type DraftBasis, type DraftHead, type DraftKey, type DraftPending, type DraftReadView, type DraftValue } from "../../../draftCommands";
import type { TmSuggestion } from "../../../resourceCommands";
import type { CandidateDecision, TranslationHistory, TranslationSaveRequest, TranslationSaveReceipt, TranslationSelectRequest, TranslationSelection, TranslationRevision } from "../../../translationCommands";
import { TranslationDrafts, type TranslationDraftPorts } from "./translationDrafts";

const key: DraftKey = { projectId: fixture.save.projectId, unitId: fixture.save.unitId, locale: fixture.save.locale };
const context = { projectId: key.projectId, sessionToken: "reopened-session" };
const initial: DraftBasis = { sourceRevisionId: fixture.save.sourceRevisionId, selectionId: null, revisionId: null, text: null };
const writerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const candidate: TranslationRevision = { ...fixture.receipt.revision, originKind: "ai", text: "Candidate translation" };
const suggestion: TmSuggestion = { unitId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sourceRevisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  translationRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sourceText: "Original source text", translationText: "TM translation",
  targetLocale: key.locale, originKind: "manual", isCurrentSelection: true, hasHumanApproval: false, matchKind: "exact", scorePercent: 100 };
const copy = <T,>(value: T): T => structuredClone(value);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function saved(request: TranslationSaveRequest): TranslationSaveReceipt {
  const selection = { ...fixture.receipt.selection, actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    previousEventId: request.expectedSelectionId ?? null, sequence: request.expectedSelectionId ? "2" : "1" };
  return { ...fixture.receipt, projectId: request.projectId, actionId: request.actionId, selection,
    revision: { ...fixture.receipt.revision, originKind: "manual", actionId: request.actionId,
      unitId: request.unitId, locale: request.locale, sourceRevisionId: request.sourceRevisionId, text: request.text },
    basis: { ...fixture.receipt.basis, sourceRevisionId: request.sourceRevisionId, selectionId: selection.eventId } };
}
function selected(request: TranslationSelectRequest): TranslationSelection {
  return { ...fixture.receipt.selection, actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    revisionId: request.revisionId, previousEventId: request.expectedSelectionId ?? null, sequence: request.expectedSelectionId ? "2" : "1" };
}
function retained(pending: DraftPending | null = null): DraftHead {
  return { key, revision: "3", writerId, value: { basis: initial, text: "Recovered B", editSeq: "9007199254740993", pending } };
}
function originalPending(): DraftPending {
  const { sessionToken: _credential, ...request } = fixture.save;
  return { kind: "save", request: { ...request, expectedSelectionId: null, text: "Submitted A" }, submittedSeq: "9007199254740992" };
}
const rejected = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
function currentView(basis: DraftBasis): Extract<DraftReadView["current"], { kind: "current" }> {
  return { kind: "current", basis, nativeKey: "entry-key", sourceText: "Original source text" };
}

function harness(head: DraftHead = { key, revision: "0", writerId: null, value: null }) {
  let disk = copy(head), current: DraftReadView["current"] = currentView(copy(initial));
  const receipts = new Map<string, TranslationSaveReceipt>();
  const commitWrite: TranslationDraftPorts["write"] = async request => {
    if (request.write.expectedRevision !== disk.revision) throw rejected;
    disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: request.write.writerId,
      value: copy(request.write.value) as DraftValue };
    return copy(disk);
  };
  const commitClear: TranslationDraftPorts["clear"] = async request => {
    if (request.clear.expectedRevision !== disk.revision || disk.value?.pending) throw rejected;
    disk = { key, revision: (BigInt(disk.revision) + 1n).toString(), writerId: null, value: null };
    return copy(disk);
  };
  const ports = {
    read: vi.fn<TranslationDraftPorts["read"]>(async () => copy({ head: disk, current })),
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: disk.value ? [{ key, revision: disk.revision,
      sourceRevisionId: disk.value.basis.sourceRevisionId, editSeq: disk.value.editSeq, hasPending: disk.value.pending !== null }] : [], next: null })),
    write: vi.fn<TranslationDraftPorts["write"]>(commitWrite),
    clear: vi.fn<TranslationDraftPorts["clear"]>(commitClear),
    identity: vi.fn<TranslationDraftPorts["identity"]>(async () => fixture.save.actionId),
    save: vi.fn<TranslationDraftPorts["save"]>(async request => {
      const receipt = saved(request); receipts.set(request.actionId, receipt);
      current = currentView({ sourceRevisionId: request.sourceRevisionId,
        selectionId: receipt.selection.eventId, revisionId: receipt.selection.revisionId, text: request.text });
      return receipt;
    }),
    select: vi.fn<TranslationDraftPorts["select"]>(async request => selected(request)),
    history: vi.fn<TranslationDraftPorts["history"]>(async () => ({ unitId: key.unitId, locale: key.locale,
      current: null, currentText: null, total: "1", rows: [copy(candidate)], nextOrdinal: null })),
    suggestions: vi.fn<TranslationDraftPorts["suggestions"]>(async () => [copy(suggestion)]),
    recoverSave: vi.fn<TranslationDraftPorts["recoverSave"]>(async request => {
      const { sessionToken: _credential, ...business } = request;
      const receipt = receipts.get(request.actionId);
      return { request: { ...business, expectedSelectionId: business.expectedSelectionId ?? null },
        outcome: receipt ? { kind: "recorded", receipt } : { kind: "pending", replay: "explicit-same-request" } };
    }),
    recoverSelection: vi.fn<TranslationDraftPorts["recoverSelection"]>(async request => {
      const { sessionToken: _credential, ...business } = request;
      return { request: { ...business, expectedSelectionId: business.expectedSelectionId ?? null }, outcome: { kind: "pending", replay: "explicit-same-request" } };
    }),
    writerId: () => writerId,
  };
  const reads = { invalidate: vi.fn() };
  const owner = new TranslationDrafts({ context, reads, ports });
  return { owner, ports, reads, disk: () => disk, setDisk: (value: DraftHead) => { disk = copy(value); },
    setCurrent: (value: DraftReadView["current"]) => { current = copy(value); }, commitWrite, commitClear, receipts,
    ready: async () => { expect(await owner.initialize()).toBe(true); expect(await owner.open(key)).toBeDefined(); } };
}

it("shares one immutable entity across views and never acknowledges B with A's delayed journal acknowledgement", async () => {
  const h = harness(); await h.ready();
  const viewA = h.owner.getEntry(key), viewB = h.owner.getEntry({ ...key });
  expect(viewA).toBe(viewB);
  const first = deferred<DraftHead>(), second = deferred<DraftHead>();
  h.ports.write.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  h.owner.edit(key, "A");
  await vi.waitFor(() => expect(h.ports.write).toHaveBeenCalledTimes(1));
  h.owner.edit(key, "B 👩🏽‍💻\né");
  expect(h.ports.write).toHaveBeenCalledTimes(1);
  first.resolve(await h.commitWrite(h.ports.write.mock.calls[0][0]));
  await vi.waitFor(() => expect(h.ports.write).toHaveBeenCalledTimes(2));
  expect(h.ports.write.mock.calls[1][0].write.expectedRevision).toBe("1");
  expect(h.owner.getEntry(key)).toMatchObject({ value: { text: "B 👩🏽‍💻\né", editSeq: "2" }, durableSeq: "1", journalPending: true });
  second.resolve(await h.commitWrite(h.ports.write.mock.calls[1][0]));
  expect(await h.owner.flush(key)).toBe(true);
  expect(h.owner.getEntry(key)).toMatchObject({ durableSeq: "2", journalPending: false });
  expect(viewA?.value?.text).toBe(""); expect(h.ports.save).not.toHaveBeenCalled();
});

it("projects new local input into recovery summaries and removes it after checked cleanup", async () => {
  const h = harness(); await h.ready();
  expect(h.owner.getSnapshot().summaries).toEqual([]);
  h.owner.edit(key, "A new local draft");
  expect(h.owner.getSnapshot().summaries).toEqual([{ key, revision: "0", editSeq: "1", sourceRevisionId: initial.sourceRevisionId, hasPending: false }]);
  await h.owner.flush(key);
  expect(h.owner.getSnapshot().summaries[0]).toMatchObject({ revision: "1", editSeq: "1", hasPending: false });
  expect(await h.owner.confirm(key)).toEqual({ confirmed: true, savedCurrent: true });
  expect(h.owner.getSnapshot().summaries).toEqual([]);
});

it("keeps ordinary listed drafts recoverable when current source metadata no longer exists", async () => {
  const h = harness(retained());
  h.setCurrent({ kind: "unavailable", reason: "source-missing" });
  expect(await h.owner.initialize()).toBe(true);
  expect(h.owner.getEntry(key)).toBeUndefined();
  expect(h.owner.getSnapshot().summaries).toHaveLength(1);
  await h.owner.open(key);
  expect(h.owner.getEntry(key)).toMatchObject({ current: { kind: "unavailable", reason: "source-missing" }, value: { text: "Recovered B", pending: null } });
  expect(h.owner.getSnapshot().summaries[0]).toMatchObject({ key, hasPending: false });
  expect(await h.owner.discard(key)).toBe(true);
  expect(h.owner.getSnapshot().summaries).toEqual([]);
});

it("reconciles a lost journal acknowledgement with its exact original write before persisting newer B", async () => {
  const h = harness(); await h.ready();
  h.ports.write.mockImplementationOnce(async request => { await h.commitWrite(request); throw new Error("Lost journal acknowledgement"); });
  h.owner.edit(key, "A"); expect(await h.owner.flush(key)).toBe(false);
  const original = copy(h.ports.write.mock.calls[0][0]);
  h.owner.edit(key, "B");
  h.ports.write.mockImplementationOnce(async request => {
    expect(request).toEqual(original);
    expect(h.disk().value?.text).toBe("A");
    return copy(h.disk());
  });
  expect(await h.owner.flush(key)).toBe(true);
  expect(h.ports.write).toHaveBeenCalledTimes(3);
  expect(h.ports.write.mock.calls[2][0].write.expectedRevision).toBe("1");
  expect(h.disk().value?.text).toBe("B");
});

it("freezes A before identity allocation and keeps B durable while formal confirmation waits", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "A"); await h.owner.flush(key);
  const identity = deferred<string>(), receipt = deferred<TranslationSaveReceipt>();
  h.ports.identity.mockReturnValueOnce(identity.promise);
  h.ports.save.mockImplementationOnce(() => receipt.promise);
  const confirming = h.owner.confirm(key);
  expect(h.owner.getSnapshot().mutationReserved).toBe(true);
  expect(await h.owner.confirm(key)).toEqual({ confirmed: false, savedCurrent: false });
  h.owner.edit(key, "B"); await h.owner.flush(key);
  identity.resolve(fixture.save.actionId);
  await vi.waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  expect(h.ports.save.mock.calls[0][0].text).toBe("A");
  expect(h.disk().value).toMatchObject({ text: "B", pending: { kind: "save", submittedSeq: "1", request: { text: "A" } } });
  h.owner.edit(key, "B while confirming"); expect(await h.owner.flush(key)).toBe(true);
  expect(h.disk().value?.text).toBe("B while confirming");
  const result = saved(h.ports.save.mock.calls[0][0]);
  h.setCurrent(currentView({ ...initial, selectionId: result.selection.eventId, revisionId: result.selection.revisionId, text: "A" }));
  receipt.resolve(result);
  expect(await confirming).toEqual({ confirmed: true, savedCurrent: false });
  expect(h.disk().value).toMatchObject({ text: "B while confirming", pending: null, basis: { text: "A" } });
  expect(h.owner.getEntry(key)).toMatchObject({ newerInputAfterConfirmation: true });
  expect(h.ports.identity).toHaveBeenCalledTimes(1); expect(h.ports.clear).not.toHaveBeenCalled();
});

it("writes pending before Core dispatch and retains input when the journal fails", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "Input to retain"); await h.owner.flush(key);
  h.ports.write.mockRejectedValueOnce(new Error("Disk full"));
  expect(await h.owner.confirm(key)).toEqual({ confirmed: false, savedCurrent: false });
  expect(h.ports.save).not.toHaveBeenCalled();
  expect(h.owner.getEntry(key)).toMatchObject({ value: { text: "Input to retain" }, failure: { kind: "journal" } });
  expect(h.owner.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("blocked");
});

it("does not delete B arriving while confirmed A's CAS cleanup is pending", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "A"); await h.owner.flush(key);
  const clear = deferred<DraftHead>(); h.ports.clear.mockImplementationOnce(() => clear.promise);
  const confirming = h.owner.confirm(key);
  await vi.waitFor(() => expect(h.ports.clear).toHaveBeenCalledTimes(1));
  expect(h.disk().value?.pending).toBeNull();
  h.owner.edit(key, "Newer B");
  clear.resolve(await h.commitClear(h.ports.clear.mock.calls[0][0]));
  expect(await confirming).toEqual({ confirmed: true, savedCurrent: false });
  expect(await h.owner.flush(key)).toBe(true);
  expect(h.disk().value?.text).toBe("Newer B");
  expect(h.owner.getEntry(key)?.value?.text).toBe("Newer B");
});

it("retains the original unknown after a same-request replay is definitely rejected", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "A"); await h.owner.flush(key);
  h.ports.save.mockRejectedValueOnce(new Error("Lost acknowledgement")).mockRejectedValueOnce(rejected);
  await h.owner.confirm(key);
  const pending = copy(h.owner.getEntry(key)!.value!.pending);
  expect(h.owner.getEntry(key)).toMatchObject({ recovery: "pending", replayAllowed: true });
  h.owner.edit(key, "B"); await h.owner.flush(key); await h.owner.replay(key);
  expect(h.owner.getEntry(key)).toMatchObject({ value: { text: "B", pending }, recovery: "unchecked", replayAllowed: false });
  expect(h.ports.save.mock.calls[1][0]).toEqual(h.ports.save.mock.calls[0][0]);
  expect(h.ports.identity).toHaveBeenCalledTimes(1);
  await h.owner.replay(key); expect(h.ports.save).toHaveBeenCalledTimes(2);
  expect(await h.owner.confirm(key)).toEqual({ confirmed: false, savedCurrent: false });
});

it("releases a first definite rejection without inventing an unknown result", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "A"); await h.owner.flush(key);
  h.ports.save.mockRejectedValueOnce(rejected);
  await h.owner.confirm(key);
  expect(h.owner.getEntry(key)).toMatchObject({ value: { pending: null, text: "A" }, recovery: null, failure: { kind: "confirmation" } });
  expect(h.ports.recoverSave).not.toHaveBeenCalled();
  expect(h.owner.getSnapshot().mutationReserved).toBe(false);
});

it("loads every pending original request with the new session and only reads its business result", async () => {
  const pending = originalPending(), h = harness(retained(pending));
  expect(await h.owner.initialize()).toBe(true);
  expect(h.owner.getEntry(key)?.value?.pending).toEqual(pending);
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.identity).not.toHaveBeenCalled();
  await h.owner.recover(key);
  expect(h.ports.recoverSave).toHaveBeenCalledWith({ ...pending.request, sessionToken: context.sessionToken });
  expect(h.disk().value?.pending?.request).not.toHaveProperty("sessionToken");
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it.each(["blocked", "mismatch", "read-failed"] as const)("keeps %s recovery unavailable for replay", async condition => {
  const h = harness(retained(originalPending())); await h.ready();
  if (condition === "read-failed") h.ports.recoverSave.mockRejectedValueOnce(new Error("Read failed"));
  else h.ports.recoverSave.mockImplementationOnce(async request => ({ request: { ...originalPending().request, text: "Submitted A", expectedSelectionId: null },
    outcome: condition === "blocked" ? { kind: "pending", replay: "blocked" } : { kind: "mismatch" } }));
  await h.owner.recover(key); await h.owner.replay(key);
  expect(h.owner.getEntry(key)?.value?.pending).not.toBeNull();
  expect(h.owner.getEntry(key)?.replayAllowed).toBe(false); expect(h.ports.save).not.toHaveBeenCalled();
});

it("keeps a historical receipt separate from the current selection and preserves recovered B", async () => {
  const pending = originalPending(), h = harness(retained(pending)); await h.ready();
  const request = { ...pending.request, sessionToken: context.sessionToken, text: "Submitted A" };
  h.receipts.set(request.actionId, saved(request));
  const newer = { ...initial, selectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", text: "Someone else's current text" };
  h.setCurrent(currentView(newer));
  expect(await h.owner.recover(key)).toEqual({ confirmed: true, savedCurrent: false });
  expect(h.owner.getEntry(key)).toMatchObject({ value: { text: "Recovered B", basis: { text: "Submitted A" }, pending: null }, current: { basis: newer }, basisCurrent: false });
  expect(h.ports.clear).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled();
});

it("requires explicit rebasing of changed source and preserves the user's input", async () => {
  const h = harness(retained());
  const changed = { ...initial, sourceRevisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
  h.setCurrent(currentView(changed)); await h.ready();
  expect(await h.owner.confirm(key)).toEqual({ confirmed: false, savedCurrent: false });
  expect(h.ports.identity).not.toHaveBeenCalled();
  expect(await h.owner.rebase(key)).toBe(true);
  expect(h.owner.getEntry(key)).toMatchObject({ basisCurrent: true, value: { basis: changed, text: "Recovered B", editSeq: "9007199254740994" } });
  h.setCurrent({ kind: "unavailable", reason: "locale-removed" }); await h.owner.open(key);
  expect(await h.owner.confirm(key)).toEqual({ confirmed: false, savedCurrent: false });
  expect(await h.owner.rebase(key)).toBe(false); expect(h.owner.getEntry(key)?.value?.text).toBe("Recovered B");
});

it("continues an empty tombstone page and blocks leaving if pending hydration fails", async () => {
  const h = harness(retained(originalPending()));
  h.ports.list.mockResolvedValueOnce({ items: [], next: key });
  expect(h.owner.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("blocked");
  expect(h.owner.lifecycleParticipant().inspect({ kind: "restore" })).toEqual({ status: "ready", revision: "initial-presentation" });
  expect(await h.owner.initialize()).toBe(true);
  expect(h.ports.list.mock.calls[1][0].after).toEqual(key);
  expect(h.owner.getEntry(key)?.value?.pending).not.toBeNull();
  const failed = harness(); failed.ports.list.mockRejectedValueOnce(new Error("Journal unavailable"));
  expect(await failed.owner.initialize()).toBe(false);
  expect(failed.owner.getSnapshot().hydration).toBe("failed");
  const participant = failed.owner.lifecycleParticipant();
  expect(participant.inspect({ kind: "navigate" }).status).toBe("blocked");
  expect(await participant.prepareLeave({ kind: "close-project" }, () => true, () => true)).toBe(false);
});

it("preserves local input when another writer advances the journal head", async () => {
  const h = harness(retained()); await h.ready();
  h.setDisk({ ...retained(), revision: "4", writerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", value: { ...retained().value!, text: "Other window" } });
  h.owner.edit(key, "Local input"); expect(await h.owner.flush(key)).toBe(false);
  await h.owner.open(key);
  expect(h.owner.getEntry(key)).toMatchObject({ value: { text: "Local input" }, failure: { kind: "journal-conflict" } });
  expect(await h.owner.rebase(key)).toBe(false); expect(await h.owner.discard(key)).toBe(false);
  expect(h.disk().value?.text).toBe("Other window"); expect(h.ports.save).not.toHaveBeenCalled();
});

it("allows durable draft navigation but rejects a leave prepared before newer input", async () => {
  const h = harness(); await h.ready();
  const first = deferred<DraftHead>(); h.ports.write.mockReturnValueOnce(first.promise);
  h.owner.edit(key, "A"); await vi.waitFor(() => expect(h.ports.write).toHaveBeenCalledTimes(1));
  const participant = h.owner.lifecycleParticipant();
  const leaving = participant.prepareLeave({ kind: "close-project" }, () => true, () => true);
  h.owner.edit(key, "Newer B"); first.resolve(await h.commitWrite(h.ports.write.mock.calls[0][0]));
  expect(await leaving).toBe(false);
  expect(participant.inspect({ kind: "close-view" }).status).toBe("ready");
  expect(participant.inspect({ kind: "close-project" }).status).toBe("ready");
});

it("preserves a newer edit when an explicit discard's CAS acknowledgement arrives late", async () => {
  const h = harness(retained()); await h.ready();
  const clear = deferred<DraftHead>(); h.ports.clear.mockReturnValueOnce(clear.promise);
  const discarding = h.owner.discard(key);
  await vi.waitFor(() => expect(h.ports.clear).toHaveBeenCalledTimes(1));
  h.owner.edit(key, "B after discard was prepared");
  clear.resolve(await h.commitClear(h.ports.clear.mock.calls[0][0]));
  expect(await discarding).toBe(false); await h.owner.flush(key);
  expect(h.disk().value?.text).toBe("B after discard was prepared");
});

it("retains a confirmed result when its subsequent current read fails", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "A"); await h.owner.flush(key);
  const save = h.ports.save.getMockImplementation()!;
  h.ports.save.mockImplementationOnce(async request => {
    const receipt = await save(request); h.ports.read.mockRejectedValueOnce(new Error("Current read failed")); return receipt;
  });
  expect(await h.owner.confirm(key)).toEqual({ confirmed: true, savedCurrent: false });
  expect(h.owner.getEntry(key)?.value?.pending).toBeNull();
  expect(h.owner.getEntry(key)?.currentFailure).toBeInstanceOf(Error);
  expect(h.disk().value?.pending).toBeNull(); expect(h.ports.save).toHaveBeenCalledTimes(1);
});

it("does not dispatch a fresh action when its locale disappears during identity allocation", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "Retained input"); await h.owner.flush(key);
  const identity = deferred<string>(); h.ports.identity.mockReturnValueOnce(identity.promise);
  const confirming = h.owner.confirm(key);
  h.setCurrent({ kind: "unavailable", reason: "locale-removed" }); identity.resolve(fixture.save.actionId);
  expect(await confirming).toEqual({ confirmed: false, savedCurrent: false });
  expect(h.ports.save).not.toHaveBeenCalled();
  expect(h.owner.getEntry(key)).toMatchObject({ value: { text: "Retained input", pending: null }, failure: { kind: "basis-conflict" } });
});

it("preserves the original selection and B through a delayed history selection acknowledgement", async () => {
  const h = harness(); await h.ready();
  const revision: TranslationRevision = { ...fixture.receipt.revision, originKind: "manual", text: "Selected historical text" };
  const reply = deferred<TranslationSelection>(); h.ports.select.mockReturnValueOnce(reply.promise);
  const selecting = h.owner.selectRevision(key, revision);
  await vi.waitFor(() => expect(h.ports.select).toHaveBeenCalledTimes(1));
  h.owner.edit(key, "B while selecting"); await h.owner.flush(key);
  const receipt = selected(h.ports.select.mock.calls[0][0]);
  h.setCurrent(currentView({ ...initial, selectionId: receipt.eventId, revisionId: receipt.revisionId, text: revision.text }));
  reply.resolve(receipt);
  expect(await selecting).toEqual({ confirmed: true, savedCurrent: false });
  expect(h.disk().value).toMatchObject({ text: "B while selecting", pending: null, basis: { text: revision.text } });
});

it("ignores a late receipt after retirement and sends no recovery or replacement-session read", async () => {
  const h = harness(); await h.ready(); h.owner.edit(key, "A"); await h.owner.flush(key);
  const reply = deferred<TranslationSaveReceipt>(); h.ports.save.mockReturnValueOnce(reply.promise);
  const confirming = h.owner.confirm(key);
  await vi.waitFor(() => expect(h.ports.save).toHaveBeenCalledTimes(1));
  const before = h.owner.getEntry(key), readCount = h.ports.read.mock.calls.length;
  h.owner.retire(); reply.resolve(saved(h.ports.save.mock.calls[0][0]));
  expect(await confirming).toEqual({ confirmed: false, savedCurrent: false });
  expect(h.owner.getEntry(key)).toBe(before);
  expect(h.ports.read).toHaveBeenCalledTimes(readCount); expect(h.ports.recoverSave).not.toHaveBeenCalled();
  expect(h.owner.edit(key, "Later B")).toBe(false);
});

it("stages a checked candidate into the existing Host journal and only creates a formal revision on confirmation", async () => {
  const h = harness(); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!;
  expect(await h.owner.stageRevision(key, candidate, { editSeq, basis }, () => true)).toEqual({ staged: true, durable: true });
  expect(h.disk().value).toMatchObject({ text: candidate.text, basis: initial, editSeq: "1", pending: null });
  expect(h.ports.history).toHaveBeenCalledWith({ ...context, unitId: key.unitId, locale: key.locale,
    afterOrdinal: (BigInt(candidate.ordinal) - 1n).toString(), limit: 1 });
  expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
  expect(await h.owner.confirm(key)).toEqual({ confirmed: true, savedCurrent: true });
  expect(h.ports.save.mock.calls[0][0].text).toBe(candidate.text); expect(h.ports.select).not.toHaveBeenCalled();
});

it("keeps an existing dirty draft and its original edit sequence instead of adopting over it", async () => {
  const h = harness(retained()); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!;
  expect(await h.owner.stageRevision(key, candidate, { editSeq, basis }, () => true)).toEqual({ staged: false, durable: false });
  expect(h.owner.getEntry(key)?.value?.text).toBe("Recovered B"); expect(h.ports.history).not.toHaveBeenCalled();
});

it.each(["input", "proof", "source", "locale", "selection", "retire"] as const)("refuses candidate adoption when %s changes while real history is pending", async change => {
  const h = harness(); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!, history = deferred<TranslationHistory>();
  let valid = true;
  h.ports.history.mockReturnValueOnce(history.promise);
  const staging = h.owner.stageRevision(key, candidate, { editSeq, basis }, () => valid);
  if (change === "input") h.owner.edit(key, "Newer manual B");
  else if (change === "proof") valid = false;
  else if (change === "source") h.setCurrent(currentView({ ...initial, sourceRevisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));
  else if (change === "locale") h.setCurrent({ kind: "unavailable", reason: "locale-removed" });
  else if (change === "selection") h.setCurrent(currentView({ ...initial, selectionId: fixture.receipt.selection.eventId,
    revisionId: fixture.receipt.revision.revisionId, text: "Someone else's selection" }));
  else h.owner.retire();
  history.resolve({ unitId: key.unitId, locale: key.locale, current: null, currentText: null, total: "1", rows: [candidate], nextOrdinal: null });
  expect(await staging).toEqual({ staged: false, durable: false });
  expect(h.owner.getEntry(key)?.value?.text).toBe(change === "input" ? "Newer manual B" : "");
  expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("checks the original view proof again after the fresh current-basis read", async () => {
  const h = harness(); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!, current = deferred<DraftReadView>();
  let valid = true; h.ports.read.mockReturnValueOnce(current.promise);
  const staging = h.owner.stageRevision(key, candidate, { editSeq, basis }, () => valid);
  await vi.waitFor(() => expect(h.ports.read).toHaveBeenCalledTimes(2));
  valid = false; current.resolve({ head: copy(h.disk()), current: currentView(initial) });
  expect(await staging).toEqual({ staged: false, durable: false }); expect(h.ports.write).not.toHaveBeenCalled();
});

it("rejects a candidate newly rejected in real history, even when its older displayed revision was eligible", async () => {
  const h = harness(); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!;
  const decision: CandidateDecision = { sourceSnapshotId: candidate.sourceSnapshotId,
    request: { projectId: key.projectId, actionId: fixture.save.actionId, unitId: key.unitId, locale: key.locale,
      revisionId: candidate.revisionId, sourceRevisionId: candidate.sourceRevisionId, expectedSelectionId: null,
      expectedDecisionId: null, disposition: "rejected", actor: "Reviewer", reason: "Different meaning" } };
  h.ports.history.mockResolvedValueOnce({ unitId: key.unitId, locale: key.locale, current: null, currentText: null,
    total: "1", rows: [{ ...candidate, candidateDecision: decision }], nextOrdinal: null });
  expect(await h.owner.stageRevision(key, candidate, { editSeq, basis }, () => true)).toEqual({ staged: false, durable: false });
  expect(h.ports.write).not.toHaveBeenCalled(); expect(h.owner.getEntry(key)?.value?.text).toBe("");
});

it("retains staged input and reports an unacknowledged Host journal write without claiming durability", async () => {
  const h = harness(); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!;
  h.ports.write.mockRejectedValueOnce(new Error("Disk full"));
  expect(await h.owner.stageRevision(key, candidate, { editSeq, basis }, () => true)).toEqual({ staged: true, durable: false });
  expect(h.owner.getEntry(key)).toMatchObject({ value: { text: candidate.text, pending: null }, failure: { kind: "journal" } });
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it.each(["  TM 👩🏽‍💻 é {{name}}\nSecond line  ", ""])("adopts a real cross-unit TM suggestion with its exact text %j into the current entity's Host draft", async text => {
  const h = harness(); await h.ready();
  const chosen = { ...suggestion, translationText: text }, { editSeq, basis } = h.owner.getEntry(key)!.value!;
  h.ports.suggestions.mockResolvedValueOnce([chosen]);
  expect(await h.owner.stageSuggestion(key, chosen, { editSeq, basis }, () => true)).toEqual({ staged: true, durable: true });
  expect(h.ports.suggestions).toHaveBeenCalledWith({ ...context, unitId: key.unitId, locale: key.locale, offset: 0, limit: 20 });
  expect(chosen.unitId).not.toBe(key.unitId);
  expect(h.disk()).toMatchObject({ key, value: { basis: initial, text, editSeq: "1", pending: null } });
  expect(h.ports.history).not.toHaveBeenCalled(); expect(h.ports.identity).not.toHaveBeenCalled();
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it.each(["input", "proof", "source-text", "source-revision", "locale", "selection", "retire"] as const)("refuses late TM adoption after the target's %s changes", async change => {
  const h = harness(); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!, suggestions = deferred<TmSuggestion[]>();
  let valid = true; h.ports.suggestions.mockReturnValueOnce(suggestions.promise);
  const staging = h.owner.stageSuggestion(key, suggestion, { editSeq, basis }, () => valid);
  if (change === "input") h.owner.edit(key, "Newer manual input");
  else if (change === "proof") valid = false;
  else if (change === "source-text") h.setCurrent({ ...currentView(initial), sourceText: "Changed source text" });
  else if (change === "source-revision") h.setCurrent(currentView({ ...initial, sourceRevisionId: suggestion.sourceRevisionId }));
  else if (change === "locale") h.setCurrent({ kind: "unavailable", reason: "locale-removed" });
  else if (change === "selection") h.setCurrent(currentView({ ...initial, selectionId: fixture.receipt.selection.eventId,
    revisionId: fixture.receipt.revision.revisionId, text: "Other selected translation" }));
  else h.owner.retire();
  suggestions.resolve([suggestion]);
  expect(await staging).toEqual({ staged: false, durable: false });
  expect(h.owner.getEntry(key)?.value?.text).toBe(change === "input" ? "Newer manual input" : "");
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it.each(["text", "source-text", "unit", "source-revision", "translation-revision", "locale", "origin", "removed"] as const)("refuses TM adoption when the inspected suggestion's %s no longer matches the real result", async change => {
  const h = harness(); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!;
  const different = { ...suggestion };
  if (change === "text") different.translationText = "Different returned translation";
  else if (change === "source-text") different.sourceText = "Different donor source";
  else if (change === "unit") different.unitId = key.unitId;
  else if (change === "source-revision") different.sourceRevisionId = initial.sourceRevisionId;
  else if (change === "translation-revision") different.translationRevisionId = candidate.revisionId;
  else if (change === "locale") different.targetLocale = "fr-FR";
  else if (change === "origin") different.originKind = "ai";
  h.ports.suggestions.mockResolvedValueOnce(change === "removed" ? [] : [different]);
  expect(await h.owner.stageSuggestion(key, suggestion, { editSeq, basis }, () => true)).toEqual({ staged: false, durable: false });
  expect(h.owner.getEntry(key)?.value?.text).toBe(""); expect(h.ports.write).not.toHaveBeenCalled();
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("keeps an existing dirty draft instead of replacing it with a TM suggestion", async () => {
  const h = harness(retained()); await h.ready();
  const { editSeq, basis } = h.owner.getEntry(key)!.value!;
  expect(await h.owner.stageSuggestion(key, suggestion, { editSeq, basis }, () => true)).toEqual({ staged: false, durable: false });
  expect(h.owner.getEntry(key)?.value?.text).toBe("Recovered B"); expect(h.ports.suggestions).not.toHaveBeenCalled();
});

it("only allows retained project-session reservations to survive ordinary navigation, and keeps project exits blocked", async () => {
  const h = harness(); await h.ready();
  const participant = h.owner.lifecycleParticipant(), exclusive = h.owner.reserveMutation();
  if (!exclusive) throw new Error("Expected an exclusive mutation reservation");
  for (const kind of ["navigate", "language", "close-view", "close-project"] as const) expect(participant.inspect({ kind }).status).toBe("blocked");
  h.owner.releaseMutation(exclusive);
  const retained = h.owner.reserveMutation("retained-for-navigation");
  if (!retained) throw new Error("Expected a retained mutation reservation");
  for (const kind of ["navigate", "language", "close-view"] as const) expect(participant.inspect({ kind }).status).toBe("ready");
  for (const kind of ["open-project", "close-project", "close-window"] as const) expect(participant.inspect({ kind }).status).toBe("blocked");
  h.owner.releaseMutation(retained);
  expect(participant.inspect({ kind: "close-project" }).status).toBe("ready");
  const next = h.owner.reserveMutation("retained-for-navigation"); expect(next).not.toBeNull();
  h.owner.retire();
  expect(participant.inspect({ kind: "close-window" }).status).toBe("blocked");
});

it.each([false, true])("requires durable, unchanged local input before leaving with a retained reservation (newer input: %s)", async newerInput => {
  const h = harness(); await h.ready();
  expect(h.owner.reserveMutation("retained-for-navigation")).not.toBeNull();
  const first = deferred<DraftHead>(); h.ports.write.mockReturnValueOnce(first.promise);
  h.owner.edit(key, "Local A");
  await vi.waitFor(() => expect(h.ports.write).toHaveBeenCalledTimes(1));
  const participant = h.owner.lifecycleParticipant();
  expect(participant.inspect({ kind: "close-view" }).status).toBe("dirty");
  const leaving = participant.prepareLeave({ kind: "close-view" }, () => true, () => true);
  if (newerInput) h.owner.edit(key, "Newer B");
  first.resolve(await h.commitWrite(h.ports.write.mock.calls[0][0]));
  expect(await leaving).toBe(!newerInput);
  expect(h.disk().value?.text).toBe(newerInput ? "Newer B" : "Local A");
  expect(participant.inspect({ kind: "close-project" }).status).toBe("blocked");
});
