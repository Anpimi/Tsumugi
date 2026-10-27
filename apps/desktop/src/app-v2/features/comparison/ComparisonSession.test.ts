import { afterEach, expect, it, vi } from "vitest";
import arenaFixture from "../../../../test/fixtures/arenaCommands.contract.json";
import translationFixture from "../../../../test/fixtures/translation-commands.json";
import type { ComparisonView } from "../../../arenaCommands";
import type { DraftBasis, DraftHead, DraftValue } from "../../../draftCommands";
import { executionContext } from "../../../executionCommands";
import { validateResponseComparison } from "../../../generated/arena.validators";
import type { ProjectView } from "../../../projectCommands";
import { SessionReads } from "../../../sessionReads";
import type { TranslationRevision } from "../../../translationCommands";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import { ComparisonSession, comparisonReadKey, type ComparisonPorts } from "./ComparisonSession";

const project: ProjectView = { sessionToken: "comparison-session", locator: "/synthetic/comparison", reconciliationState: "settled",
  metadata: { projectId: arenaFixture.requests.compare.projectId, displayName: "Saved comparisons", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project), copy = <T,>(value: T): T => structuredClone(value);
function fixtureView(): ComparisonView {
  const value: unknown = copy(arenaFixture.responses.comparison);
  if (!validateResponseComparison(value)) throw new Error("Invalid saved comparison fixture");
  return { ...value, selectionId: null, selectedRevisionId: null, selectedText: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
const resources: { owner: ComparisonSession; drafts: TranslationDrafts; reads: SessionReads }[] = [];
afterEach(() => { resources.splice(0).forEach(({ owner, drafts, reads }) => { owner.dispose(); drafts.retire(); reads.retire(); }); });
const rejected = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
async function harness() {
  let stored = fixtureView();
  const key = { projectId: context.projectId, unitId: stored.unitId, locale: stored.locale };
  const basis: DraftBasis = { sourceRevisionId: stored.sourceRevisionId, selectionId: null, revisionId: null, text: null };
  let disk: DraftHead = { key, revision: "0", writerId: null, value: null };
  const revision: TranslationRevision = { ...translationFixture.receipt.revision, revisionId: stored.rows[1].revisionId,
    unitId: stored.unitId, locale: stored.locale, sourceRevisionId: stored.sourceRevisionId, text: stored.rows[1].text, originKind: "manual", ordinal: "2" };
  const reads = new SessionReads(context);
  const draftPorts = {
    list: async () => ({ items: [], next: null }),
    read: vi.fn<TranslationDraftPorts["read"]>(async () => ({ head: copy(disk), current: { kind: "current", basis: copy(basis), nativeKey: stored.nativeKey, sourceText: stored.sourceText } })),
    write: vi.fn<TranslationDraftPorts["write"]>(async ({ write }) => {
      expect(write.expectedRevision).toBe(disk.revision);
      disk = { key, writerId: write.writerId, revision: (BigInt(disk.revision) + 1n).toString(), value: copy(write.value) as DraftValue }; return copy(disk);
    }),
    history: vi.fn<TranslationDraftPorts["history"]>(async () => ({ unitId: key.unitId, locale: key.locale, current: null, currentText: null, total: "2", rows: [copy(revision)], nextOrdinal: null })),
    save: vi.fn<TranslationDraftPorts["save"]>(), select: vi.fn<TranslationDraftPorts["select"]>(), writerId: () => arenaFixture.responses.identity,
  };
  const drafts = new TranslationDrafts({ context, reads, ports: draftPorts }); await drafts.initialize(); await drafts.open(key);
  const ports = {
    identity: vi.fn<ComparisonPorts["identity"]>(async () => arenaFixture.requests.compare.actionId),
    comparisons: vi.fn<ComparisonPorts["comparisons"]>(async () => copy(arenaFixture.responses.comparisons)),
    comparison: vi.fn<ComparisonPorts["comparison"]>(async () => copy(stored)),
    compare: vi.fn<ComparisonPorts["compare"]>(async request => {
      const rows = request.revisionIds.map(id => stored.rows.find(row => row.revisionId === id));
      if (rows.some(row => row === undefined)) throw rejected;
      stored = { ...stored, comparisonId: request.actionId, blind: request.blind, revealed: !request.blind,
        rows: request.blind ? copy(stored.rows).reverse() : copy(stored.rows) };
      return copy(stored);
    }),
    comparisonAction: vi.fn<ComparisonPorts["comparisonAction"]>(async () => null),
    reveal: vi.fn<ComparisonPorts["reveal"]>(async () => { stored = { ...stored, revealed: true }; }),
    revealTarget: vi.fn<ComparisonPorts["revealTarget"]>(async () => ({ projectId: context.projectId, targetId: stored.comparisonId!, targetKind: "comparison", visible: stored.revealed })),
  };
  const owner = new ComparisonSession({ project, drafts, reads, ports }); resources.push({ owner, drafts, reads });
  return { owner, drafts, reads, ports, draftPorts, key, basis, revision, view: () => copy(stored), disk: () => copy(disk),
    setView: (value: ComparisonView) => { stored = copy(value); },
    input: () => ({ unitId: key.unitId, locale: key.locale, revisionIds: stored.rows.map(row => row.revisionId), blind: true }),
    receipt: () => { const { sessionToken: _credential, ...request } = ports.compare.mock.calls[0][0]; return copy(request); } };
}

it.each([2, 4])("creates only a fixed %s-revision comparison, retaining Core's stable blind order without dispatching a model or selecting text", async count => {
  const h = await harness();
  if (count === 4) {
    const view = h.view();
    h.setView({ ...view, rows: [...view.rows, ...view.rows.map((row, index) => ({ ...row, revisionId: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}` }))] });
  }
  const input = h.input(), original = [...input.revisionIds], identity = deferred<string>();
  h.ports.identity.mockReturnValueOnce(identity.promise);
  const creating = h.owner.create(input, () => true); input.revisionIds.reverse();
  identity.resolve(arenaFixture.requests.compare.actionId); await creating;
  expect(h.ports.compare.mock.calls[0][0].revisionIds).toEqual(original);
  expect(h.owner.current()).toMatchObject({ comparisonId: arenaFixture.requests.compare.actionId, pending: null, notice: "created" });
  const stored = h.reads.client.getQueryData<ComparisonView>(h.reads.key(comparisonReadKey(arenaFixture.requests.compare.actionId)));
  expect(stored?.rows.map(row => row.revisionId)).toEqual([...original].reverse());
  expect(stored?.rows.every(row => row.model === null && row.recipe === null)).toBe(true);
  expect(await h.owner.list()).toEqual(arenaFixture.responses.comparisons);
  expect((await h.owner.read(arenaFixture.requests.compare.actionId)).rows.map(row => row.revisionId)).toEqual([...original].reverse());
  expect(h.draftPorts.save).not.toHaveBeenCalled(); expect(h.draftPorts.select).not.toHaveBeenCalled();
});

it.each(["too-few", "duplicate", "too-many"] as const)("rejects %s comparison membership before allocating an action", async kind => {
  const h = await harness(), input = h.input();
  input.revisionIds = kind === "too-few" ? input.revisionIds.slice(0, 1) : kind === "duplicate" ? [input.revisionIds[0], input.revisionIds[0]]
    : Array.from({ length: 5 }, (_, index) => `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  await h.owner.create(input, () => true); expect(h.ports.identity).not.toHaveBeenCalled(); expect(h.ports.compare).not.toHaveBeenCalled();
});

it.each(["proof", "source", "locale", "retire"] as const)("refuses a late comparison creation after %s changes", async change => {
  const h = await harness(), identity = deferred<string>(); let valid = true;
  h.ports.identity.mockReturnValueOnce(identity.promise);
  const creating = h.owner.create(h.input(), () => valid);
  if (change === "proof") valid = false;
  else if (change === "source") h.reads.invalidate(["source"]);
  else if (change === "locale") h.owner.updateProject({ ...project, metadata: { ...project.metadata, targetLocales: [] } });
  else h.reads.retire();
  identity.resolve(arenaFixture.requests.compare.actionId); await creating;
  expect(h.ports.compare).not.toHaveBeenCalled();
});

it("recovers an unknown creation by its exact original request and only retries that request after a missing-action check", async () => {
  const h = await harness();
  h.ports.compare.mockRejectedValueOnce(new Error("Lost creation acknowledgement")).mockRejectedValueOnce(rejected);
  h.ports.comparisonAction.mockRejectedValueOnce(new Error("Original action temporarily unavailable"));
  await h.owner.create(h.input(), () => true);
  const pending = h.owner.current().pending;
  expect(pending?.kind).toBe("compare"); expect(h.owner.current().retryAllowed).toBe(false);
  expect(h.owner.lifecycleParticipant().inspect({ kind: "close-project" }).status).toBe("blocked");
  expect(h.drafts.lifecycleParticipant().inspect({ kind: "close-view" }).status).toBe("ready");
  await h.owner.retry(); expect(h.ports.compare).toHaveBeenCalledTimes(1);
  await h.owner.check(); expect(h.owner.current().retryAllowed).toBe(true);
  await h.owner.retry(); expect(h.owner.current()).toMatchObject({ pending, retryAllowed: false });
  expect(h.ports.compare.mock.calls[1][0]).toEqual(h.ports.compare.mock.calls[0][0]);
  h.ports.comparisonAction.mockResolvedValueOnce(h.receipt()); await h.owner.check();
  expect(h.owner.current()).toMatchObject({ pending: null, notice: "creation-confirmed" });
  expect(h.ports.identity).toHaveBeenCalledTimes(1); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
});

it("does not treat a mismatched creation action as proof of the original request", async () => {
  const h = await harness(); h.ports.compare.mockRejectedValueOnce(new Error("Lost acknowledgement"));
  h.ports.comparisonAction.mockImplementationOnce(async request => {
    const { sessionToken: _credential, ...original } = request; return { ...original, locale: "fr-FR" };
  });
  await h.owner.create(h.input(), () => true);
  expect(h.owner.current()).toMatchObject({ retryAllowed: false, pending: { kind: "compare" } });
  h.ports.comparisonAction.mockResolvedValueOnce(h.receipt()); await h.owner.check();
  expect(h.owner.current().pending).toBeNull();
});

it("fulfils an unknown reveal from the checked target visibility without inventing a reveal-action receipt", async () => {
  const h = await harness();
  h.ports.reveal.mockRejectedValueOnce(new Error("Lost reveal acknowledgement"));
  h.ports.revealTarget.mockResolvedValueOnce({ projectId: context.projectId, targetId: h.view().comparisonId!, targetKind: "comparison", visible: true });
  await h.owner.reveal(h.view(), () => true);
  expect(h.owner.current()).toMatchObject({ pending: null, notice: "identities-visible" });
  expect(h.ports.reveal).toHaveBeenCalledTimes(1); expect(h.ports.identity).toHaveBeenCalledTimes(1);
});

it("keeps a missing reveal target uncertain and retries only the same original reveal after a checked hidden target", async () => {
  const h = await harness();
  h.ports.reveal.mockRejectedValueOnce(new Error("Lost reveal acknowledgement")).mockRejectedValueOnce(rejected);
  h.ports.revealTarget.mockResolvedValueOnce(null);
  await h.owner.reveal(h.view(), () => true);
  const pending = h.owner.current().pending;
  expect(h.owner.current()).toMatchObject({ targetMissing: true, retryAllowed: false });
  await h.owner.retry(); expect(h.ports.reveal).toHaveBeenCalledTimes(1);
  await h.owner.check(); expect(h.owner.current()).toMatchObject({ targetMissing: false, retryAllowed: true });
  await h.owner.retry(); expect(h.owner.current()).toMatchObject({ pending, retryAllowed: false });
  expect(h.ports.reveal.mock.calls[1][0]).toEqual(h.ports.reveal.mock.calls[0][0]); expect(h.ports.identity).toHaveBeenCalledTimes(1);
});

it("rejects blind identity leakage and any attempt to swap persisted A/B positions on a later read", async () => {
  const h = await harness(), view = h.view();
  h.setView({ ...view, rows: view.rows.map((row, index) => index === 0 ? { ...row, model: "Hidden model" } : row) });
  await expect(h.owner.read(view.comparisonId!)).rejects.toThrow("Invalid Arena");
  h.reads.client.setQueryData(h.reads.key(comparisonReadKey(view.comparisonId!)), view);
  h.setView({ ...view, rows: [...view.rows].reverse() });
  await expect(h.owner.read(view.comparisonId!)).rejects.toThrow("display positions");
});

it("stages a checked ordinary revision through the existing Host journal, preserving the chosen text without formal save/select", async () => {
  const h = await harness(), value = h.drafts.getEntry(h.key)!.value!;
  expect(await h.owner.stage(h.view(), h.revision, { editSeq: value.editSeq, basis: value.basis }, () => true)).toEqual({ staged: true, durable: true });
  expect(h.disk().value).toMatchObject({ text: h.revision.text, basis: h.basis, pending: null });
  expect(h.draftPorts.history).toHaveBeenCalledTimes(1); expect(h.draftPorts.save).not.toHaveBeenCalled(); expect(h.draftPorts.select).not.toHaveBeenCalled();
});

it.each(["input", "source", "selection", "rejected"] as const)("does not stage a comparison after its %s changes during the real comparison reread", async change => {
  const h = await harness(), view = h.view(), value = h.drafts.getEntry(h.key)!.value!, reply = deferred<ComparisonView>();
  h.ports.comparison.mockReturnValueOnce(reply.promise);
  const staging = h.owner.stage(view, h.revision, { editSeq: value.editSeq, basis: value.basis }, () => true);
  if (change === "input") h.drafts.edit(h.key, "Newer manual B");
  const changed = change === "source" ? { ...view, sourceRevisionId: translationFixture.save.sourceRevisionId }
    : change === "selection" ? { ...view, selectionId: arenaFixture.responses.identity }
      : change === "rejected" ? { ...view, rows: view.rows.map(row => row.revisionId === h.revision.revisionId ? { ...row, candidateDisposition: "rejected" as const } : row) } : view;
  reply.resolve(changed);
  expect(await staging).toEqual({ staged: false, durable: false });
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe(change === "input" ? "Newer manual B" : "");
  expect(h.draftPorts.save).not.toHaveBeenCalled(); expect(h.draftPorts.select).not.toHaveBeenCalled();
});
