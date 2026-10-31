import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import wire from "../../../../test/fixtures/resourceCommands.contract.json";
import { ExecutionTaskSession } from "../../../ExecutionTaskSession";
import type { DraftHead } from "../../../draftCommands";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { enUS } from "../../../i18n/en-US";
import { validateResponseWritten } from "../../../generated/draft.validators";
import type { ProjectView } from "../../../projectCommands";
import { ResourceDraftSession, useResourceDraftSession } from "../../../ResourceDraftSession";
import { validateRequestCorrectionCapture, validateResponseCorrectionBasis } from "../../../generated/resource.validators";
import type { CaptureCorrectionTerm, CorrectionTermEvidence, CorrectionTermReceipt } from "../../../resourceCommands";
import type { ReviewEditorSnapshot } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { TranslationDraftSession } from "../../../TranslationDraftSession";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { installResourceDraftFixture } from "../../../testSupport/resourceDraftFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts } from "../editor/translationDrafts";
import type { KnowledgeOwner } from "../knowledge/knowledgeTypes";
import TermProposalPanel from "../knowledge/TermProposalPanel";
import EntryCorrectionTerm from "./EntryCorrectionTerm";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "synthetic-entry-correction", locator: "synthetic-correction", reconciliationState: "settled",
  metadata: { projectId: wire.requests.session.projectId, displayName: "Synthetic correction", sourceLocale: "en-US", targetLocales: ["zh-CN", "de-DE"], metadataRevision: "1" } };
const context = executionContext(project);
type CorrectionKey = { [Key in keyof typeof enUS.correctionFeedback]: typeof enUS.correctionFeedback[Key] extends string ? Key : never }[keyof typeof enUS.correctionFeedback];
type CorrectionField = "sourceTerm" | "targetTerm" | "reason";
const c = (key: CorrectionKey) => i18n.t(`correctionFeedback.${key}`), r = (key: "protected" | "retry") => i18n.t(`resource.${key}`);
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let evidence: CorrectionTermEvidence, snapshot: ReviewEditorSnapshot, basisWait: Promise<CorrectionTermEvidence> | null;
let captureWait: Promise<void> | null, loseCapture: boolean, recorded: CorrectionTermReceipt | null, serial: number;
const resources: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
function editor(): ReviewEditorSnapshot {
  const b = evidence.basis, actionId = fixtureIdentity(850);
  const target = reviewTargetFixture({ unitId: b.unitId, locale: b.locale, nativeKey: "barrel", sourceText: evidence.sourceText,
    sourceSnapshotId: b.sourceSnapshotId, sourceRevisionId: b.sourceRevisionId, selectionId: b.after.selectionId, revisionId: b.after.revisionId, translationText: evidence.afterText });
  return { target, readVersion: "saved-manual-correction", context: null,
    terms: { unitId: b.unitId, locale: b.locale, sourceRevisionId: b.sourceRevisionId, entries: [] },
    translations: { unitId: b.unitId, locale: b.locale, current: { eventId: b.after.selectionId, revisionId: b.after.revisionId,
      previousEventId: b.before.selectionId, unitId: b.unitId, locale: b.locale, sequence: "2", actionId },
      currentText: evidence.afterText, total: "2", nextOrdinal: null, rows: [{ revisionId: b.after.revisionId, unitId: b.unitId, locale: b.locale,
        ordinal: "2", actionId, originKind: "manual", sourceRevisionId: b.sourceRevisionId, sourceSnapshotId: b.sourceSnapshotId, text: evidence.afterText,
        resultId: null, attemptId: null, artifactId: null, itemId: null, nativeKey: null, logicalPath: null, fileDigest: null, declaredLocale: null, contributors: [], candidateDecision: null }] } };
}
function receipt(request: CaptureCorrectionTerm): CorrectionTermReceipt {
  return { request: structuredClone(request), capture: { ...structuredClone(wire.responses.correctionCapture.capture),
    origin: { kind: "correction", basis: structuredClone(request.basis) }, targetLocale: request.basis.locale } };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  const raw: unknown = structuredClone(wire.responses.correctionBasis);
  if (!validateResponseCorrectionBasis(raw)) throw new Error("Canonical saved correction evidence required");
  evidence = raw; snapshot = editor(); basisWait = null; captureWait = null; loseCapture = false; recorded = null; serial = 860;
  invoke.mockReset().mockImplementation(async (command: string, { request }: { request: unknown }) => {
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: evidence.basis.sourceSnapshotId };
    if (command === "read_correction_term_basis") return basisWait ?? structuredClone(evidence);
    if (command === "create_execution_identity") return fixtureIdentity(serial++);
    if (command === "list_resource_captures") return recorded ? [structuredClone(recorded.capture)] : [];
    if (command === "read_resource_preview" && recorded) return { capture: structuredClone(recorded.capture), rows: [{
      entry: { id: "term", source: recorded.request.source, target: recorded.request.target, reason: recorded.request.reason, aliases: [], protected: recorded.request.protected, nativeKey: null },
      kind: "added", current: null, scopeUnitId: recorded.request.basis.unitId }], removed: [], correction: { evidence: structuredClone(evidence), decision: null }, mcp: null };
    if (command === "capture_correction_term") {
      if (!validateRequestCorrectionCapture(request)) throw new Error("Original correction request required");
      await captureWait;
      if (loseCapture) { loseCapture = false; return { unconfirmed: true }; }
      recorded = receipt(request.capture); return structuredClone(recorded);
    }
    if (command === "observe_correction_term_action" || command === "read_correction_term_action") return recorded ? structuredClone(recorded) : null;
    throw new Error(`Unexpected synthetic correction command: ${command}`);
  });
  installResourceDraftFixture();
});
afterEach(() => { cleanup(); resources.splice(0).forEach(({ reads, drafts, gate }) => { reads.retire(); drafts.retire(); gate.dispose(); }); });

async function harness(value = snapshot) {
  const reads = new SessionReads(context), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  const heads = new Map<string, DraftHead>();
  const drafts = new TranslationDrafts({ context, reads, ports: { writerId: () => fixtureIdentity(840),
    list: async () => ({ items: [], next: null }),
    read: async ({ key }) => ({ head: heads.get(key.unitId) ?? { key, revision: "0", writerId: null, value: null },
      current: { kind: "current", nativeKey: value.target.nativeKey, sourceText: value.target.sourceText,
        basis: { sourceRevisionId: value.target.sourceRevisionId, selectionId: value.target.selectionId, revisionId: value.target.revisionId, text: value.target.translationText } } }),
    write: async ({ write }) => {
      const head: unknown = { key: write.key, revision: String(Number(write.expectedRevision) + 1), writerId: write.writerId,
        value: { ...write.value, basis: { ...write.value.basis, revisionId: write.value.basis.revisionId ?? null,
          selectionId: write.value.basis.selectionId ?? null, text: write.value.basis.text ?? null }, pending: write.value.pending ?? null } };
      if (!validateResponseWritten(head)) throw new Error("Canonical synthetic translation draft head required");
      heads.set(write.key.unitId, head); return head;
    },
  } });
  await drafts.initialize(); resources.push({ reads, drafts, gate });
  const keyFor = (data: ReviewEditorSnapshot) => ["workbench-entry-details", data.target.unitId, data.target.locale] as const;
  function seed(data: ReviewEditorSnapshot) {
    const key = keyFor(data); reads.client.setQueryDefaults(reads.key(key), { meta: { scopes: ["source", "translation", "resources"] } });
    reads.client.setQueryData(reads.key(key), data); return { key, data: reads.client.getQueryData<ReviewEditorSnapshot>(reads.key(key)) ?? data };
  }
  let presentation = { data: value, read: seed(value), visible: true, knowledge: false }, observed: KnowledgeOwner | null = null;
  const onOpenCapture = vi.fn(async (_captureId: string) => true);
  function Content() {
    const owner = useResourceDraftSession(); observed = owner;
    return presentation.knowledge ? <TermProposalPanel project={project} owner={owner} disabled={false} gate={gate} viewId="entries"
      current={() => gate.canDispatch({ viewId: "entries", source: "button" })}/>
      : <EntryCorrectionTerm project={project} target={presentation.data.target} read={presentation.read} owner={owner} drafts={drafts} gate={gate}
        viewId="entries" disabled={false} visible={presentation.visible} onOpenCapture={onOpenCapture}/>;
  }
  const ui = () => <SessionReadProvider context={context} reads={reads} bridge={false}><TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
    <ResourceDraftSession project={project}><Content/></ResourceDraftSession></ExecutionTaskSession></TranslationDraftSession></SessionReadProvider>;
  let rendered = render(ui());
  const owner = () => { if (!observed) throw new Error("Resource owner required"); return observed; };
  await waitFor(() => expect(owner().journal.hydration).toBe("ready"));
  const show = (patch: Partial<typeof presentation>) => { presentation = { ...presentation, ...patch, ...(patch.data ? { read: seed(patch.data) } : {}) }; rendered.rerender(ui()); };
  return { owner, drafts, reads, gate, onOpenCapture, show, remount: () => { rendered.unmount(); rendered = render(ui()); },
    key: { projectId: context.projectId, unitId: value.target.unitId, locale: value.target.locale },
    user: userEvent.setup(), input: (key: CorrectionField, text: string) => fireEvent.change(screen.getByRole("textbox", { name: c(key) }), { target: { value: text } }) };
}
async function open(h: Awaited<ReturnType<typeof harness>>) {
  const button = await screen.findByRole("button", { name: c("open") }); await waitFor(() => expect(button).toBeEnabled());
  await h.user.click(button); await screen.findByRole("textbox", { name: c("sourceTerm") });
}
function fill(h: Awaited<ReturnType<typeof harness>>, reason = "  Human review é 👩🏽‍💻  ") {
  h.input("sourceTerm", "Barrel"); h.input("targetTerm", "木桶"); h.input("reason", reason);
}

it.each(["en-US", "zh-CN"])("explicitly reads saved evidence, preserves translation B, then saves an unadopted local candidate (%s)", async language => {
  await i18n.changeLanguage(language); const h = await harness();
  await waitFor(() => expect(screen.getByRole("button", { name: c("open") })).toBeEnabled());
  expect(calls("read_correction_term_basis")).toHaveLength(0); expect(calls("capture_correction_term")).toHaveLength(0);
  await act(async () => { h.drafts.edit(h.key, "Translation B é 👩🏽‍💻"); await h.drafts.flush(h.key); });
  await open(h); expect(calls("capture_correction_term")).toHaveLength(0);
  await h.user.click(screen.getByText(c("evidence")));
  expect(screen.getByRole("textbox", { name: c("before") })).toHaveValue(evidence.beforeText);
  expect(screen.getByRole("textbox", { name: c("after") })).toHaveValue(evidence.afterText);
  fill(h); await h.user.click(screen.getByRole("checkbox", { name: r("protected") }));
  await waitFor(() => expect(screen.getByRole("button", { name: c("capture") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: c("capture") }));
  await waitFor(() => expect(h.onOpenCapture).toHaveBeenCalledWith(wire.responses.correctionCapture.capture.captureId));
  expect(recorded?.request).toMatchObject({ basis: evidence.basis, source: "Barrel", target: "木桶", protected: true, reason: "  Human review é 👩🏽‍💻  " });
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe("Translation B é 👩🏽‍💻");
  expect(calls("decide_resource_entry")).toHaveLength(0); expect(calls("save_term")).toHaveLength(0);
});

it.each(["first-save", "ai", "mismatched-action"])("hides the correction entry for %s without reading or capturing", async kind => {
  const value = structuredClone(snapshot);
  if (kind === "first-save" && value.translations.current) value.translations.current.previousEventId = null;
  if (kind === "ai") value.translations.rows[0].originKind = "ai";
  if (kind === "mismatched-action") value.translations.rows[0].actionId = fixtureIdentity(999);
  await harness(value);
  expect(screen.queryByRole("button", { name: c("open") })).not.toBeInTheDocument();
  expect(calls("read_correction_term_basis")).toHaveLength(0); expect(calls("capture_correction_term")).toHaveLength(0);
});

it.each(["stale", "unchanged-text", "wrong-predecessor"])("refuses %s evidence after the explicit read", async kind => {
  if (kind === "stale") evidence.current = false;
  if (kind === "unchanged-text") evidence.beforeText = evidence.afterText;
  if (kind === "wrong-predecessor") evidence.basis.before.selectionId = fixtureIdentity(998);
  const h = await harness();
  await waitFor(() => expect(screen.getByRole("button", { name: c("open") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: c("open") }));
  await screen.findByText(c("unavailable"));
  expect(h.owner().current().correctionDraft).toBeNull(); expect(calls("capture_correction_term")).toHaveLength(0);
});

it("rejects normalized or absent substrings without rewriting the exact input", async () => {
  evidence.sourceText += " é"; evidence.afterText += " é"; snapshot = editor();
  const h = await harness(); await open(h); fill(h);
  h.input("sourceTerm", "é"); h.input("targetTerm", "é");
  expect(screen.getByRole("textbox", { name: c("sourceTerm") })).toHaveValue("é");
  expect(screen.getByText(c("sourceMismatch"))).toBeVisible(); expect(screen.getByText(c("targetMismatch"))).toBeVisible();
  expect(screen.getByRole("button", { name: c("capture") })).toBeDisabled();
  h.input("sourceTerm", " é"); h.input("targetTerm", " é");
  await waitFor(() => expect(screen.getByRole("button", { name: c("capture") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: c("capture") }));
  await waitFor(() => expect(recorded?.request.source).toBe(" é")); expect(recorded?.request.target).toBe(" é");
});

it("keeps composition input editable while withholding the capture action", async () => {
  const h = await harness(); await open(h); fill(h);
  const reason = screen.getByRole("textbox", { name: c("reason") });
  await waitFor(() => expect(screen.getByRole("button", { name: c("capture") })).toBeEnabled());
  fireEvent.compositionStart(reason); h.input("reason", "组合输入 B é 👩🏽‍💻");
  expect(reason).not.toHaveAttribute("readonly"); expect(reason).toHaveValue("组合输入 B é 👩🏽‍💻");
  expect(screen.getByRole("button", { name: c("capture") })).toBeDisabled(); expect(calls("capture_correction_term")).toHaveLength(0);
  fireEvent.compositionEnd(reason);
  await waitFor(() => expect(screen.getByRole("button", { name: c("capture") })).toBeEnabled());
});

it.each(["translation", "resource"])("does not let a late evidence read replace newer %s input", async kind => {
  const wait = deferred<CorrectionTermEvidence>(); basisWait = wait.promise;
  const h = await harness(); const trigger = await screen.findByRole("button", { name: c("open") });
  await waitFor(() => expect(trigger).toBeEnabled()); await h.user.click(trigger);
  await waitFor(() => expect(calls("read_correction_term_basis")).toHaveLength(1));
  await act(async () => {
    if (kind === "translation") { h.drafts.edit(h.key, "New translation B"); await h.drafts.flush(h.key); }
    else h.owner().editTerm({ ...h.owner().current().termDraft, source: "Resource B" });
    wait.resolve(structuredClone(evidence));
  });
  await waitFor(() => expect(trigger).not.toHaveAttribute("aria-busy"));
  expect(h.owner().current().correctionDraft).toBeNull();
  if (kind === "resource") expect(h.owner().current().termDraft.source).toBe("Resource B");
  else expect(h.drafts.getEntry(h.key)?.value?.text).toBe("New translation B");
  expect(calls("capture_correction_term")).toHaveLength(0);
});

it.each(["entry", "source"])("revokes a read when the %s changes", async kind => {
  const wait = deferred<CorrectionTermEvidence>(); basisWait = wait.promise;
  const h = await harness(); await waitFor(() => expect(screen.getByRole("button", { name: c("open") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: c("open") }));
  const next = structuredClone(snapshot); next.target.unitId = fixtureIdentity(999); next.translations.unitId = next.target.unitId;
  act(() => { if (kind === "source") h.reads.invalidate(["source"]); else h.show({ data: next }); });
  await act(async () => { wait.resolve(structuredClone(evidence)); });
  expect(h.owner().current().correctionDraft).toBeNull(); expect(calls("capture_correction_term")).toHaveLength(0);
});

it("keeps resource B while a capture is pending and opens only the confirmed candidate", async () => {
  const wait = deferred<void>(); captureWait = wait.promise;
  const h = await harness(); await open(h); fill(h, "Reason A");
  await waitFor(() => expect(screen.getByRole("button", { name: c("capture") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: c("capture") }));
  await waitFor(() => expect(calls("capture_correction_term")).toHaveLength(1));
  h.input("reason", "Reason B during save");
  expect(h.onOpenCapture).not.toHaveBeenCalled();
  await act(async () => { wait.resolve(); });
  await waitFor(() => expect(h.owner().current().pending).toBeNull());
  expect(recorded?.request.reason).toBe("Reason A"); expect(h.owner().current().correctionDraft?.reason).toBe("Reason B during save");
  expect(screen.getByText(c("savedNewer"))).toBeVisible(); expect(h.onOpenCapture).toHaveBeenCalledTimes(1);
});

it("retains an unknown original request and resource B across views, then explicitly retries that same action", async () => {
  loseCapture = true; const h = await harness(); await open(h); fill(h, "Original request A");
  await waitFor(() => expect(screen.getByRole("button", { name: c("capture") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: c("capture") }));
  await waitFor(() => expect(h.owner().current().pendingUncertain).toBe(true));
  h.input("reason", "Preserved resource B");
  expect(screen.queryByRole("button", { name: r("retry") })).not.toBeInTheDocument();
  act(() => h.show({ knowledge: true }));
  expect(await screen.findByRole("textbox", { name: c("reason") })).toHaveValue("Preserved resource B");
  expect(screen.getByText(i18n.t("correctionFeedback.scope", { unit: i18n.t("knowledge.proposalScopeEntry"), locale: evidence.basis.locale }))).toBeVisible();
  await act(async () => { await h.owner().flush(); });
  act(() => h.remount());
  await waitFor(() => expect(h.owner().journal.hydration).toBe("ready"));
  expect(await screen.findByRole("textbox", { name: c("reason") })).toHaveValue("Preserved resource B");
  expect(calls("capture_correction_term")).toHaveLength(1);
  await waitFor(() => expect(screen.getByRole("button", { name: c("check") })).toBeEnabled());
  await h.user.click(screen.getByRole("button", { name: c("check") }));
  const retry = await screen.findByRole("button", { name: r("retry") }); await waitFor(() => expect(retry).toBeEnabled());
  expect(h.owner().current().pending).not.toBeNull(); expect(h.owner().current().correctionDraft?.reason).toBe("Preserved resource B");
  await h.user.click(retry); await waitFor(() => expect(h.owner().current().pending).toBeNull());
  expect(calls("capture_correction_term")).toHaveLength(2); expect(calls("capture_correction_term")[1][1]).toEqual(calls("capture_correction_term")[0][1]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(recorded?.request.reason).toBe("Original request A");
  expect(h.owner().current().correctionDraft?.reason).toBe("Preserved resource B");
  expect(calls("decide_resource_entry")).toHaveLength(0);
});
