import { afterEach, expect, it, vi } from "vitest";
import type { DraftHead, DraftKey, DraftReadView, DraftValue } from "../../../draftCommands";
import type { TranslationCandidateSliceRow, TranslationRevision } from "../../../translationCommands";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { TranslationDrafts, type CandidateBatchStage, type TranslationDraftPorts } from "./translationDrafts";

const context = { projectId: id(900), sessionToken: "synthetic-candidate-batch" };
const copy = <T,>(value: T): T => structuredClone(value);
const owners: TranslationDrafts[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.retire()); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function row(index: number, selectedOriginKind: TranslationCandidateSliceRow["selectedOriginKind"] = null): TranslationCandidateSliceRow {
  const target = reviewTargetFixture({ unitId: id(1000 + index), nativeKey: `entry-${index}`, basis: `basis-${index}`,
    selectionId: selectedOriginKind === null ? null : id(1100 + index), revisionId: selectedOriginKind === null ? null : id(1200 + index),
    translationText: selectedOriginKind === null ? null : "" });
  const revision: TranslationRevision = { unitId: target.unitId, locale: target.locale, revisionId: id(1300 + index), actionId: id(1400 + index),
    sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId, ordinal: "2", originKind: "ai", text: index === 0 ? "" : `Candidate ${index} é 👩🏽‍💻 {name}`,
    attemptId: id(1500 + index), resultId: id(1600 + index), itemId: id(1700 + index), contributors: [], candidateDecision: null,
    artifactId: null, declaredLocale: null, fileDigest: null, logicalPath: null, nativeKey: null };
  return { target, selectedOriginKind, protection: { unitId: target.unitId, locale: target.locale, protected: false, revision: "0" }, candidateCount: 1, revisions: [revision] };
}
async function harness(initial = [row(0), row(1, "ai"), row(2, "manual")]) {
  const rows = new Map(initial.map(value => [value.target.unitId, copy(value)])), disk = new Map<string, DraftHead>();
  const keys = initial.map(({ target }) => ({ projectId: context.projectId, unitId: target.unitId, locale: target.locale }));
  const view = (key: DraftKey): DraftReadView => {
    const target = rows.get(key.unitId)!.target;
    return { head: copy(disk.get(key.unitId) ?? { key, revision: "0", writerId: null, value: null }),
      current: { kind: "current", nativeKey: target.nativeKey, sourceText: target.sourceText,
        basis: { sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText } } };
  };
  const readMany = vi.fn<TranslationDraftPorts["readMany"]>(async request => ({ items: request.unitIds.map(unitId => view({ projectId: context.projectId, unitId, locale: request.locale })), nextAfter: null }));
  const slice = vi.fn<TranslationDraftPorts["candidateSlice"]>(async request => ({ projectId: request.projectId, locale: request.locale,
    sourceSnapshotId: request.sourceSnapshotId, scopeId: request.scopeId ?? null, readVersion: "synthetic-read-version", rows: request.unitIds.map(unitId => copy(rows.get(unitId)!)), next: null }));
  const ports = { readMany, candidateSlice: slice,
    read: vi.fn<TranslationDraftPorts["read"]>(async request => view(request.key)),
    write: vi.fn<TranslationDraftPorts["write"]>(async ({ write }) => {
      expect(write.expectedRevision).toBe(disk.get(write.key.unitId)?.revision ?? "0");
      const value = write.value;
      if (value.pending != null || value.merge != null) throw new Error("Unexpected formal or merge request in batch draft");
      const stored: DraftValue = { text: value.text, editSeq: value.editSeq, pending: null,
        basis: { sourceRevisionId: value.basis.sourceRevisionId, selectionId: value.basis.selectionId ?? null, revisionId: value.basis.revisionId ?? null, text: value.basis.text ?? null } };
      const head: DraftHead = { key: write.key, revision: String(BigInt(write.expectedRevision) + 1n), writerId: write.writerId, value: stored };
      disk.set(write.key.unitId, copy(head)); return copy(head);
    }),
    list: vi.fn<TranslationDraftPorts["list"]>(async () => ({ items: [], next: null })),
    history: vi.fn<TranslationDraftPorts["history"]>(), identity: vi.fn<TranslationDraftPorts["identity"]>(),
    save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(),
    writerId: () => id(1900),
  };
  const owner = new TranslationDrafts({ context, reads: { invalidate: vi.fn() }, ports }); owners.push(owner);
  await owner.initialize();
  const capture = async (): Promise<CandidateBatchStage[]> => {
    await owner.openMany(keys);
    return initial.map(({ target }) => {
      const value = owner.getEntry(keys.find(key => key.unitId === target.unitId)!)!.value!;
      return { row: copy(rows.get(target.unitId)!), capture: { editSeq: value.editSeq, basis: copy(value.basis) } };
    });
  };
  return { owner, keys, rows, disk, ports, view, capture };
}

it("stages empty and nonempty AI versions in the existing journal with batched reads, while retaining non-AI selections", async () => {
  const h = await harness(), capture = await h.capture();
  expect(await h.owner.stageCandidateBatch(capture, () => true)).toEqual([
    { key: h.keys[0], staged: true, durable: true }, { key: h.keys[1], staged: true, durable: true }, { key: h.keys[2], staged: false, durable: false },
  ]);
  expect(h.disk.get(h.keys[0].unitId)?.value).toMatchObject({ text: "", basis: { selectionId: null, revisionId: null, text: null }, pending: null });
  expect(h.disk.get(h.keys[1].unitId)?.value).toMatchObject({ text: capture[1].row.revisions[0].text, basis: { text: "" }, pending: null });
  expect(h.ports.readMany).toHaveBeenCalledTimes(2); expect(h.ports.candidateSlice).toHaveBeenCalledTimes(1);
  expect(h.ports.read).not.toHaveBeenCalled(); expect(h.ports.history).not.toHaveBeenCalled(); expect(h.ports.identity).not.toHaveBeenCalled();
  expect(h.ports.save).not.toHaveBeenCalled(); expect(h.ports.select).not.toHaveBeenCalled();
});

it("retains an existing durable draft even when its text matches the current translation", async () => {
  const h = await harness([row(0, "ai")]), key = h.keys[0], basis = h.view(key).current;
  if (basis.kind !== "current") throw new Error("Synthetic current basis missing");
  h.disk.set(key.unitId, { key, revision: "3", writerId: id(1990), value: { basis: basis.basis, text: "", editSeq: "9007199254740993", pending: null } });
  const capture = await h.capture();
  expect(await h.owner.stageCandidateBatch(capture, () => true)).toEqual([{ key, staged: false, durable: false }]);
  expect(h.ports.write).not.toHaveBeenCalled(); expect(h.owner.getEntry(key)?.value?.editSeq).toBe("9007199254740993");
});

it("keeps newer input B while a batch is checking its captured candidate A", async () => {
  const h = await harness([row(0), row(1)]), capture = await h.capture();
  const wait = deferred<Awaited<ReturnType<TranslationDraftPorts["candidateSlice"]>>>();
  const current = await h.ports.candidateSlice({ ...context, locale: h.keys[0].locale, sourceSnapshotId: capture[0].row.target.sourceSnapshotId, unitIds: h.keys.map(key => key.unitId), state: "available" });
  h.ports.candidateSlice.mockReturnValueOnce(wait.promise);
  const staging = h.owner.stageCandidateBatch(capture, () => true);
  h.owner.edit(h.keys[0], "B — newer human input é 👩🏽‍💻"); await h.owner.flush(h.keys[0]); wait.resolve(current);
  const result = await staging;
  expect(result[0].staged).toBe(false); expect(result[1].durable).toBe(true);
  expect(h.owner.getEntry(h.keys[0])?.value?.text).toBe("B — newer human input é 👩🏽‍💻");
  expect(h.disk.get(h.keys[0].unitId)?.value?.text).toBe("B — newer human input é 👩🏽‍💻");
});

it.each(["protected", "new-candidate", "manual-selection"])("declines a captured row after %s changes", async change => {
  const h = await harness([row(0)]), capture = await h.capture(), original = h.rows.get(h.keys[0].unitId)!;
  if (change === "protected") original.protection = { ...original.protection, protected: true, revision: "1" };
  else if (change === "new-candidate") {
    original.candidateCount = 2;
    original.revisions.push({ ...copy(original.revisions[0]), revisionId: id(1991), actionId: id(1992), ordinal: "3" });
  } else {
    const replacement = row(0, "manual"); h.rows.set(h.keys[0].unitId, replacement);
  }
  expect((await h.owner.stageCandidateBatch(capture, () => true))[0].staged).toBe(false); expect(h.ports.write).not.toHaveBeenCalled();
});

it("pauses after an unconfirmed journal write and retries that same input without staging the next member", async () => {
  const h = await harness([row(0), row(1)]), capture = await h.capture();
  h.ports.write.mockRejectedValueOnce(new Error("Synthetic disk full"));
  expect(await h.owner.stageCandidateBatch(capture, () => true)).toEqual([
    { key: h.keys[0], staged: true, durable: false }, { key: h.keys[1], staged: false, durable: false },
  ]);
  expect(h.owner.getEntry(h.keys[0])?.value).toMatchObject({ text: "", editSeq: "1" });
  expect(h.owner.getEntry(h.keys[1])?.value?.editSeq).toBe("0");
  expect(await h.owner.flush(h.keys[0])).toBe(true); expect(h.ports.write).toHaveBeenCalledTimes(2);
  expect(h.disk.get(h.keys[0].unitId)?.value?.editSeq).toBe("1"); expect(h.disk.has(h.keys[1].unitId)).toBe(false);
});

it("does not let a late batch observation replace a newer row read or its input", async () => {
  const h = await harness([row(0)]); await h.capture(); const old = h.view(h.keys[0]);
  const wait = deferred<Awaited<ReturnType<TranslationDraftPorts["readMany"]>>>(); h.ports.readMany.mockReturnValueOnce(wait.promise);
  const opening = h.owner.openMany(h.keys);
  const changed = h.rows.get(h.keys[0].unitId)!; changed.target.sourceText = "New source"; changed.target.sourceRevisionId = id(1993);
  await h.owner.open(h.keys[0]); h.owner.edit(h.keys[0], "Newer input B"); await h.owner.flush(h.keys[0]);
  wait.resolve({ items: [old], nextAfter: null }); await opening;
  expect(h.owner.getEntry(h.keys[0])?.value?.text).toBe("Newer input B");
  expect(h.owner.getEntry(h.keys[0])?.current).toMatchObject({ sourceText: "New source", basis: { sourceRevisionId: id(1993) } });
  expect(h.owner.getEntry(h.keys[0])?.failure).toBeNull();
});

it("reports a foreign writer conflict and never stages over that writer's head", async () => {
  const h = await harness([row(0)]), capture = await h.capture(), key = h.keys[0], value = h.owner.getEntry(key)!.value!;
  h.disk.set(key.unitId, { key, revision: "1", writerId: id(1994), value: { ...copy(value), text: "Other editor input", editSeq: "1" } });
  expect((await h.owner.stageCandidateBatch(capture, () => true))[0].staged).toBe(false);
  expect(h.owner.getEntry(key)?.failure?.kind).toBe("journal-conflict"); expect(h.ports.write).not.toHaveBeenCalled();
  expect(h.disk.get(key.unitId)?.value?.text).toBe("Other editor input");
});
