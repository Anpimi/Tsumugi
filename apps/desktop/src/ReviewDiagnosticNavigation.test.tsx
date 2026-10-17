import { createRef, useLayoutEffect, useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSessionWorkbench, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import * as translationOwner from "./TranslationDraftSession";
import * as reviewOwner from "./ReviewDraftSession";
import * as readOwner from "./SessionReadProvider";
import type { ProjectView } from "./projectCommands";
import type { ReviewEditorSnapshot, ReviewFindingDecision, ReviewDiagnosticLocation, ReviewFindingView } from "./reviewCommands";
import type { TranslationSaveReceipt, TranslationSaveRequest } from "./translationCommands";
import type { WorkspaceDestination } from "./sessionNavigation";
import { reviewDiagnosticFixture } from "./testSupport/reviewDiagnosticFixture";
import { reviewFindingViewFixture, reviewSummaryFor, reviewSummaryPageFixture } from "./testSupport/reviewFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import { connectionFixture } from "./testSupport/connectionFixture";
import { fixtureIdentity } from "./testSupport/executionFixture";
import * as reviewValidation from "./generated/review.validators";
import { validateRequestSave } from "./generated/translation.validators";
import { i18n } from "./i18n";
import wire from "../test/fixtures/reviewCommands.contract.json";
import { semanticDiagnosticFixture } from "./testSupport/semanticDiagnosticFixture";
import type { AiSemanticReviewView } from "./aiSemanticReviewCommands";
import { reviewFindingsKey } from "./reviewQueries";
import { controlContentPaneGeometry } from "./testSupport/contentPaneGeometry";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const project: ProjectView = { sessionToken: "diagnostic-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: wire.requests.target.projectId, displayName: "Diagnostic navigation", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const session = createRef<ProjectSessionHandle>();
const actualDraft = translationOwner.useTranslationDraftSession, actualReview = reviewOwner.useReviewDraftSession, actualReads = readOwner.useSessionReads;
let manual: ReturnType<typeof actualDraft>, review: ReturnType<typeof actualReview>, reads: ReturnType<typeof actualReads>;
let fixture: ReturnType<typeof reviewDiagnosticFixture>, memory: WorkspaceViewMemory, area: WorkspaceArea;
let holdLocation: Promise<ReviewDiagnosticLocation> | null, holdEditor: Promise<ReviewEditorSnapshot> | null, holdSave: Promise<void> | null;
let failLocation: boolean, failSummary: boolean, loseSave: boolean, snapshotReads: number, serial: number, unexpected: string[], repairs: ReviewFindingDecision[];
let semantic: ReturnType<typeof semanticDiagnosticFixture> | null, semanticViews: Map<string, AiSemanticReviewView>, failSemantic: boolean;
let holdSemantic: Promise<AiSemanticReviewView> | null;
let pagedSemanticFindings: boolean;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function Harness({ value = project }: { value?: ProjectView }) {
  const [current, setArea] = useState<WorkspaceArea>("overview"), [, setVersion] = useState(0);
  const retained = useMemo(() => new WorkspaceViewMemory(), [value.sessionToken, value.metadata.projectId]);
  const [commands] = useState(() => new WorkbenchCommands());
  useLayoutEffect(() => { memory = retained; area = current; });
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area: current, memory: retained, activate: setArea, deactivate: () => setArea("overview") }}>
    <button onClick={() => setVersion(before => before + 1)}>Rerender workspace</button>
    <ProjectSessionWorkbench key={`${value.metadata.projectId}:${value.sessionToken}`} ref={session} project={value} disabled={false} onActivate={setArea} onCoordinatingChange={() => {}} />
  </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
function calls(command: string) { return invoke.mock.calls.filter(([name]) => name === command); }
function originalDestination(): Extract<WorkspaceDestination, { kind: "review-edit" }> {
  const { target, run, diagnostic } = fixture;
  return { kind: "review-edit", target: { unitId: target.unitId, sourceRevisionId: target.sourceRevisionId, key: target.nativeKey, sourceText: target.sourceText }, locale: target.locale,
    handoff: { returnTo: { ...reads.context, locale: target.locale, unitId: target.unitId, tab: "work", summaryScope: null, pageAfter: 0, workOffset: 50 },
      diagnostic: { runId: run.runId, source: { purpose: "qa" }, diagnostic, basis: target.basis, basisEvidence: target.basisEvidence, translationText: target.translationText } } };
}
function modelDestination(): Extract<WorkspaceDestination, { kind: "review-edit" }> {
  if (!semantic) throw new Error("Model fixture required");
  const destination = originalDestination();
  destination.handoff.diagnostic = { runId: semantic.run.runId, source: structuredClone(semantic.source), diagnostic: structuredClone(semantic.diagnostic),
    basis: semantic.target.basis, basisEvidence: semantic.target.basisEvidence, translationText: semantic.target.translationText };
  return destination;
}
function noWrites() {
  expect(invoke.mock.calls.map(([name]) => name).filter(name => !name.startsWith("read_") && !name.startsWith("list_"))).toEqual([]);
  expect(unexpected).toEqual([]);
}
function installSemantic(value = semanticDiagnosticFixture()) {
  semantic = value; fixture = value.qa; semanticViews.set(value.view.detail.attemptId, value.view); return value;
}
function modelFinding() {
  const panel = within(screen.getByRole("region", { name: i18n.t("review.advisoryFindings.title") }));
  const article = panel.getAllByText("Synthetic model diagnostic", { exact: false })[0].closest("article");
  if (!article) throw new Error("Model finding article required");
  return within(article);
}
function saveReceipt(request: TranslationSaveRequest): TranslationSaveReceipt {
  const { target, editor } = fixture, previous = editor.translations.current;
  const sequence = (BigInt(previous?.sequence ?? "0") + 1n).toString();
  const selection = { actionId: request.actionId, eventId: fixtureIdentity(serial++), revisionId: fixtureIdentity(serial++), previousEventId: request.expectedSelectionId ?? null,
    unitId: request.unitId, locale: request.locale, sequence };
  const revision = { actionId: request.actionId, unitId: request.unitId, locale: request.locale, sourceRevisionId: request.sourceRevisionId,
    sourceSnapshotId: target.sourceSnapshotId, revisionId: selection.revisionId, ordinal: sequence, text: request.text, originKind: "manual" as const,
    contributors: [], attemptId: null, resultId: null, itemId: null, artifactId: null, logicalPath: null, declaredLocale: null, nativeKey: null, fileDigest: null };
  const receipt = { actionId: request.actionId, projectId: request.projectId, selection, revision,
    basis: { sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId, selectionId: selection.eventId } };
  editor.translations = { ...editor.translations, current: selection, currentText: revision.text, rows: [revision], total: sequence, nextOrdinal: null };
  target.selectionId = selection.eventId; target.revisionId = revision.revisionId; target.translationText = revision.text; target.currentCheck = null;
  target.basis = "e".repeat(64); target.basisEvidence = { ...target.basisEvidence, selectionId: selection.eventId, revisionId: revision.revisionId };
  return receipt;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); vi.restoreAllMocks(); fixture = reviewDiagnosticFixture();
  holdLocation = null; holdEditor = null; holdSave = null; failLocation = false; failSummary = false; loseSave = false; snapshotReads = 0; serial = 3800; unexpected = []; repairs = [];
  semantic = null; semanticViews = new Map(); failSemantic = false; holdSemantic = null; pagedSemanticFindings = false;
  vi.spyOn(translationOwner, "useTranslationDraftSession").mockImplementation(() => { const value = actualDraft(); manual = value; return value; });
  vi.spyOn(reviewOwner, "useReviewDraftSession").mockImplementation(() => { const value = actualReview(); review = value; return value; });
  vi.spyOn(readOwner, "useSessionReads").mockImplementation(() => { const value = actualReads(); reads = value; return value; });
  invoke.mockReset().mockImplementation(async (command: string, { request }: { request: Record<string, unknown> }) => {
    const { target, editor } = fixture;
    if (command === "read_context_strategy_default") return null;
    if (command === "read_model_connections") return connectionFixture([]);
    if (command === "read_project_changes") return { projectId: request.projectId, sessionToken: request.sessionToken, epoch: fixtureIdentity(3799), sequence: "0", progressSequence: "0", scopes: [], runtime: { active: false, quiescing: false, queryCount: 0, error: null } };
    if (command === "read_execution_task_activity") return { total: "0", active: "0", attention: "0", saved: "0", rows: [] };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: target.sourceSnapshotId };
    if (command === "read_source_content") return sourcePageFixture({ snapshotId: target.sourceSnapshotId, scope: { revision: "1", currentSnapshot: target.sourceSnapshotId }, rows: [sourceRowFixture({ unitId: target.unitId, sourceRevisionId: target.sourceRevisionId }, { key: target.nativeKey, text: target.sourceText })] });
    if (command === "read_review_summary_page") { if (failSummary && request.scopeId) throw { reason: "review-scope-expired" }; return reviewSummaryPageFixture([reviewSummaryFor(target)]); }
    if (command === "read_review_target") return structuredClone(target);
    if (command === "read_review_history") return { decisions: [], checks: [fixture.run], waivers: [], fallbacks: [], nextOffset: null };
    if (command === "read_review_work") return { total: 51, nextOffset: request.offset === 0 ? 50 : null, coverage: "synthetic finite queue",
      items: [{ unitId: request.offset === 0 ? fixtureIdentity(3798) : target.unitId, locale: target.locale, nativeKey: request.offset === 0 ? "Earlier window" : target.nativeKey, basis: target.basis, reasons: ["qa-findings"] }] };
    if (command === "read_review_findings") {
      if (semantic && pagedSemanticFindings && request.offset === 0) {
        const page: ReviewFindingView = { ...semantic.findings, findings: Array.from({ length: 20 }, (_, index) => ({
          runId: fixture.run.runId, purpose: "qa", aiOrigin: null, requirement: fixture.requirement, decision: null,
          finding: { ...fixture.finding, issueId: (index + 1).toString(16).padStart(64, "0") },
        })), nextOffset: 20 };
        return structuredClone(page);
      }
      return semantic ? structuredClone({ ...semantic.findings, history: repairs }) : { ...reviewFindingViewFixture(target), findings: target.currentCheck ? [{ runId: target.currentCheck.runId, purpose: "qa", aiOrigin: null, finding: fixture.finding, requirement: fixture.requirement, decision: repairs[0] ?? null }] : [], history: repairs };
    }
    if (command === "read_ai_semantic_review") {
      if (failSemantic) throw new Error("Original semantic read unavailable");
      return { attemptId: request.attemptId, view: structuredClone(holdSemantic ? await holdSemantic : semanticViews.get(String(request.attemptId)) ?? null) };
    }
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_review_editor_snapshot") { snapshotReads++; return snapshotReads > 1 && holdEditor ? await holdEditor : structuredClone(editor); }
    if (command === "read_review_diagnostic_location") {
      const original = semantic && request.runId === semantic.run.runId ? semantic : fixture;
      expect(reviewValidation.validateRequestDiagnosticLocation(request)).toBe(true);
      expect(request).toMatchObject({ unitId: target.unitId, locale: target.locale, runId: original.run.runId, diagnostic: original.diagnostic });
      if (failLocation) throw { code: "dependency-conflict", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "review-diagnostic-current" };
      return holdLocation ? await holdLocation : structuredClone(original.location);
    }
    if (command === "read_translation_history") return structuredClone(editor.translations);
    if (command === "read_work_protection") return { unitId: target.unitId, locale: target.locale, revision: "1", protected: true };
    if (command === "read_context_fact_decisions" || command === "list_resource_captures" || command === "tm_suggestions" || command === "read_terms") return [];
    if (command === "resolve_terms") return editor.terms;
    if (command === "create_execution_identity") return fixtureIdentity(serial++);
    if (command === "save_translation_revision") { if (holdSave) await holdSave; if (!reviewValidation.validateResponseEditor(editor) || !validateRequestSave(request)) throw new Error("Invalid saved editor fixture");
      const receipt = saveReceipt(request); if (loseSave) throw new Error("Synthetic lost original save acknowledgement"); return receipt; }
    if (command === "write_review_finding") {
      if (!reviewValidation.validateRequestFinding(request)) throw new Error("Invalid repair request fixture");
      const value = request.finding;
      const receipt: ReviewFindingDecision = { decisionId: fixtureIdentity(serial++), request: { ...value, expectedDecisionId: value.expectedDecisionId ?? null }, purpose: "qa", aiOrigin: null, finding: fixture.finding,
        requirement: fixture.requirement, basisEvidence: target.basisEvidence, createdAt: "2026-10-17T00:00:00Z" };
      repairs.unshift(receipt); return structuredClone(receipt);
    }
    unexpected.push(command); throw new Error(`Unexpected synthetic IPC command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function openQueue() {
  const ui = render(<Harness />), user = userEvent.setup();
  await act(async () => { expect(await session.current!.navigate({ kind: "review-work" })).toBe(true); });
  await screen.findByRole("button", { name: "Earlier window" });
  await user.click(screen.getByRole("button", { name: i18n.t("review.nextPage") }));
  await user.click(await screen.findByRole("button", { name: fixture.target.nativeKey }));
  await screen.findAllByRole("button", { name: i18n.t(fixture.diagnostic.location!.field === "source" ? "review.diagnosticNavigation.locateSource" : "review.diagnosticNavigation.locateTranslation") });
  return { ui, user };
}
async function locate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: i18n.t(fixture.diagnostic.location!.field === "source" ? "review.diagnosticNavigation.locateSource" : "review.diagnosticNavigation.locateTranslation") })[0]);
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t(fixture.diagnostic.location!.field === "source" ? "review.diagnosticNavigation.sourceText" : "translation.draft") });
  await waitFor(() => expect(input.selectionStart).toBe(1)); expect(input.selectionEnd).toBe(8); expect(input).toHaveFocus(); return input;
}
async function locateModel(user: ReturnType<typeof userEvent.setup>, start = 1, end = 8) {
  if (!semantic?.diagnostic.location) throw new Error("Located semantic fixture required");
  const field = semantic.diagnostic.location.field;
  await user.click(await modelFinding().findByRole("button", { name: i18n.t(field === "source" ? "review.diagnosticNavigation.locateSource" : "review.diagnosticNavigation.locateTranslation") }));
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t(field === "source" ? "review.diagnosticNavigation.sourceText" : "translation.draft") });
  await waitFor(() => expect(input.selectionStart).toBe(start)); expect(input.selectionEnd).toBe(end); expect(input).toHaveFocus(); return input;
}

it("keeps a pending model diagnostic out of the hidden editor and locates it only after an explicit return", async () => {
  const resize = controlContentPaneGeometry(), value = installSemantic(), response = deferred<ReviewEditorSnapshot>(); holdEditor = response.promise;
  const { ui, user } = await openQueue(); await user.click(await modelFinding().findByRole("button", { name: "Locate in translation" }));
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Your draft" });
  resize(ui.container.querySelector(".translation-columns")!, 600);
  await user.click(screen.getByRole("button", { name: "Entries" }));
  const selectedRange = [input.selectionStart, input.selectionEnd];
  await act(async () => { response.resolve(structuredClone(value.editor)); });
  expect(input).not.toBeVisible(); expect(document.activeElement).not.toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual(selectedRange);
  await user.click(screen.getByRole("button", { name: "Current entry" }));
  await waitFor(() => expect(input.selectionStart).toBe(1)); expect(input.selectionEnd).toBe(8); expect(input).toHaveFocus();
  noWrites();
});

it.each([
  { encoding: "utf8-byte" as const, field: "source" as const },
  { encoding: "utf16" as const, field: "translation" as const },
  { encoding: "grapheme" as const, field: "translation" as const },
])("locates the actual $encoding model $field diagnostic through the original CRLF editor and queue return", async ({ encoding, field }) => {
  const value = installSemantic(semanticDiagnosticFixture(encoding, field, true)), qaRun = value.target.currentCheck;
  const { user } = await openQueue(), input = await locateModel(user, 2, 9);
  expect(input.value.slice(2, 9)).toBe("👩🏽‍💻"); expect(manual.current()?.text).toContain("\r\n");
  expect(memory.read("translation", "diagnosticAnchor")).toMatchObject({ diagnostic: { runId: value.run.runId, source: { purpose: "ai-semantic", origin: value.run.evidence } } });
  input.setSelectionRange(0, 0); await user.click(screen.getByRole("button", { name: "Rerender workspace" })); expect(input.selectionStart).toBe(0);
  await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  const row = await screen.findByRole("button", { name: value.target.nativeKey }); await waitFor(() => expect(row).toHaveFocus());
  expect(memory.read("review", "workCursor")).toEqual({ locale: value.target.locale, offset: 50 });
  expect(value.target.currentCheck).toBe(qaRun); expect(calls("read_review_diagnostic_location")[0][1].request.runId).toBe(value.run.runId); noWrites();
});

it("keeps the original mechanical QA journey precise when a separate model run is current", async () => {
  const value = installSemantic(), { user } = await openQueue(); await locate(user);
  expect(calls("read_review_diagnostic_location")[0][1].request.runId).toBe(value.qa.run.runId);
  expect(value.findings.semanticRunId).toBe(value.run.runId); expect(value.target.currentCheck?.runId).toBe(value.qa.run.runId); noWrites();
});

it("locates a current model finding on a refreshed later page while the first page remains invalidated, then returns to the original queue", async () => {
  const value = installSemantic(); pagedSemanticFindings = true;
  const { user } = await openQueue(), panel = within(screen.getByRole("region", { name: i18n.t("review.advisoryFindings.title") }));
  await user.click(panel.getByText(i18n.t("review.advisoryFindings.history")));
  await user.click(panel.getByRole("button", { name: i18n.t("review.advisoryFindings.moreHistory") }));
  await panel.findByRole("button", { name: "Locate in translation" });
  const firstKey = reads.key(reviewFindingsKey(value.target.unitId, value.target.locale));
  const laterKey = reads.key(reviewFindingsKey(value.target.unitId, value.target.locale, 20));
  expect(reads.client.getQueryData<ReviewFindingView>(firstKey)?.findings.every(item => item.purpose === "qa")).toBe(true);
  await act(async () => { reads.invalidate(["review"]); });
  await waitFor(() => {
    const later = reads.client.getQueryState<ReviewFindingView>(laterKey);
    expect(later?.status).toBe("success"); expect(later?.fetchStatus).toBe("idle"); expect(later?.isInvalidated).toBe(false);
  });
  expect(reads.client.getQueryState(firstKey)?.isInvalidated).toBe(true);
  expect(reads.client.getQueryData<ReviewFindingView>(laterKey)?.findings[0].runId).toBe(value.run.runId);
  const firstReads = calls("read_review_findings").filter(([, args]) => args.request.offset === 0).length;
  await user.click(await panel.findByRole("button", { name: "Locate in translation" }));
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Your draft" });
  await waitFor(() => expect(input.selectionStart).toBe(1)); expect(input.selectionEnd).toBe(8);
  expect(calls("read_review_findings").filter(([, args]) => args.request.offset === 0).length).toBeGreaterThan(firstReads);
  expect(calls("read_review_diagnostic_location")[0][1].request.runId).toBe(value.run.runId);
  await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  const row = await screen.findByRole("button", { name: value.target.nativeKey }); await waitFor(() => expect(row).toHaveFocus());
  expect(memory.read("review", "workCursor")).toEqual({ locale: value.target.locale, offset: 50 });
  expect(screen.getByRole("tab", { name: i18n.t("review.workTab") })).toHaveAttribute("aria-selected", "true"); noWrites();
});

it("revokes an old model anchor when another semantic run becomes current on the same basis", async () => {
  const old = installSemantic(), { user } = await openQueue(), input = await locateModel(user);
  const newer = installSemantic(semanticDiagnosticFixture("utf16", "translation", false, 3950));
  expect(newer.target.basis).toBe(old.target.basis); expect(newer.run.runId).not.toBe(old.run.runId);
  input.setSelectionRange(0, 0);
  await act(async () => { reads.invalidate(["review"]); });
  await screen.findByText(i18n.t("review.diagnosticNavigation.stale"));
  expect(input.selectionStart).toBe(0); expect(manual.current()?.text).toBe(old.target.translationText);
  expect(memory.read("translation", "diagnosticAnchor")).toMatchObject({ diagnostic: { runId: old.run.runId } }); noWrites();
});

it("keeps model findings and ordinary editor recovery available when the original diagnostic read fails", async () => {
  installSemantic(); failSemantic = true; const { user } = await openQueue();
  await screen.findByText(i18n.t("review.diagnosticNavigation.semanticUnavailable"));
  expect(modelFinding().queryByRole("button", { name: "Locate in translation" })).not.toBeInTheDocument();
  failSemantic = false; await user.click(screen.getByRole("button", { name: i18n.t("review.diagnosticNavigation.semanticRetry") }));
  await modelFinding().findByRole("button", { name: "Locate in translation" });
  failLocation = true; await user.click(modelFinding().getByRole("button", { name: "Locate in translation" }));
  await screen.findByText(i18n.t("review.diagnosticNavigation.stale")); expect(area).toBe("review");
  await user.click(screen.getByRole("button", { name: i18n.t("review.openTranslation") }));
  await screen.findByRole("textbox", { name: "Your draft" }); expect(memory.read("translation", "diagnosticAnchor")).toBeNull(); noWrites();
});

it("offers ordinary editing for a model finding with no location without requesting one", async () => {
  const value = installSemantic(); value.diagnostic.location = null; value.view.rows[0].output!.rules[0].findings[0].location = null;
  const { user } = await openQueue(); await modelFinding().findByText(i18n.t("review.diagnosticNavigation.semanticNoLocation"));
  expect(modelFinding().queryByRole("button", { name: "Locate in translation" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: i18n.t("review.openTranslation") }));
  await screen.findByRole("textbox", { name: "Your draft" }); expect(calls("read_review_diagnostic_location")).toHaveLength(0); noWrites();
});

it("keeps manual B and reason B when the original model location arrives late", async () => {
  const value = installSemantic(), { user } = await openQueue(), response = deferred<ReviewDiagnosticLocation>(); holdLocation = response.promise;
  await user.click(await modelFinding().findByRole("button", { name: "Locate in translation" }));
  await waitFor(() => expect(calls("read_review_diagnostic_location")).toHaveLength(1));
  act(() => { review.editReason(value.target, "Reason B"); manual.begin({ unitId: fixtureIdentity(3890), locale: "zh-CN", sourceRevisionId: fixtureIdentity(3891), key: "Retained B", sourceText: "Other source" }, null, null, "Manual B"); });
  await act(async () => { response.resolve(structuredClone(value.location)); });
  await screen.findByText(i18n.t("review.diagnosticNavigation.stale")); expect(area).toBe("review");
  expect(manual.current()?.text).toBe("Manual B"); expect(review.current().drafts[`${value.target.locale}:${value.target.unitId}`]).toBe("Reason B"); noWrites();
});

it("does not apply the original model location after replacing the project session", async () => {
  const value = installSemantic(), { ui, user } = await openQueue(), response = deferred<ReviewDiagnosticLocation>(); holdLocation = response.promise;
  await user.click(await modelFinding().findByRole("button", { name: "Locate in translation" }));
  await waitFor(() => expect(calls("read_review_diagnostic_location")).toHaveLength(1));
  ui.rerender(<Harness value={{ ...project, sessionToken: "new-semantic-session" }} />);
  await act(async () => { response.resolve(structuredClone(value.location)); });
  expect(manual.current()).toBeNull(); expect(screen.queryByRole("textbox", { name: "Your draft" })).not.toBeInTheDocument(); noWrites();
});

it.each(["model", "attempt", "result"] as const)("rejects a model handoff with a mismatched original %s at the real session navigation owner", async mismatch => {
  installSemantic(); await openQueue(); const destination = modelDestination(), source = destination.handoff.diagnostic!.source;
  if (source.purpose !== "ai-semantic") throw new Error("Model source required");
  if (mismatch === "model") source.origin.model = "Different model";
  if (mismatch === "attempt") source.origin.attemptId = fixtureIdentity(3999);
  if (mismatch === "result") source.origin.resultId = fixtureIdentity(3999);
  await act(async () => { expect(await session.current!.navigate(destination)).toBe(false); });
  expect(manual.current()).toBeNull(); expect(area).toBe("review"); noWrites();
});

it("does not use a late original model read after related project facts invalidate navigation", async () => {
  const value = installSemantic(); await openQueue(); await modelFinding().findByRole("button", { name: "Locate in translation" });
  const response = deferred<AiSemanticReviewView>(); holdSemantic = response.promise;
  let moving!: Promise<boolean>; act(() => { moving = session.current!.navigate(modelDestination()); });
  await waitFor(() => expect(calls("read_review_diagnostic_location")).toHaveLength(1));
  await act(async () => { reads.invalidate(["review"]); });
  await act(async () => { response.resolve(structuredClone(value.view)); expect(await moving).toBe(false); });
  expect(manual.current()).toBeNull(); expect(area).toBe("review"); noWrites();
});

it("does not select the model range over newer composition input", async () => {
  const value = installSemantic(), response = deferred<ReviewEditorSnapshot>(); holdEditor = response.promise;
  const { user } = await openQueue(); await user.click(await modelFinding().findByRole("button", { name: "Locate in translation" }));
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Your draft" });
  fireEvent.compositionStart(input); act(() => manual.edit(`${manual.current()!.text} 新`));
  await act(async () => { response.resolve(structuredClone(value.editor)); }); fireEvent.compositionEnd(input);
  await screen.findByText(i18n.t("review.diagnosticNavigation.stale")); expect(input).toHaveValue(`${value.target.translationText} 新`); noWrites();
});

it("retains the exact unknown manual save after a model location instead of saving or rerunning on return", async () => {
  installSemantic(); const { user } = await openQueue(), input = await locateModel(user); loseSave = true;
  await user.type(input, " edited"); await user.click(screen.getByRole("button", { name: i18n.t("translation.save") }));
  await waitFor(() => expect(manual.current()?.pending).not.toBeNull()); await waitFor(() => expect(manual.current()?.saving).toBe(false));
  const pending = manual.current()!.pending;
  await user.click(screen.getByRole("button", { name: "Return to original review queue" })); await screen.findByText(i18n.t("review.diagnosticNavigation.returnBlocked"));
  expect(manual.current()?.pending).toBe(pending); expect(calls("save_translation_revision")).toHaveLength(1);
  expect(calls("start_ai_semantic_review")).toHaveLength(0); expect(calls("write_review_finding")).toHaveLength(0); expect(calls("write_review_decision")).toHaveLength(0); expect(unexpected).toEqual([]);
});

it.each(["utf8-byte", "utf16", "grapheme"] as const)("locates the Host-normalized %s diagnostic and returns to the original work window without writes", async encoding => {
  fixture = reviewDiagnosticFixture(encoding); const { user } = await openQueue(), input = await locate(user);
  expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe("👩🏽‍💻"); expect(manual.current()?.text).toBe(fixture.target.translationText);
  input.setSelectionRange(0, 0); await user.click(screen.getByRole("button", { name: "Rerender workspace" }));
  expect(input.selectionStart).toBe(0); expect(input).not.toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  const row = await screen.findByRole("button", { name: fixture.target.nativeKey });
  await waitFor(() => expect(row).toHaveFocus()); expect(screen.getByRole("tab", { name: i18n.t("review.workTab") })).toHaveAttribute("aria-selected", "true");
  expect(memory.read("review", "workCursor")).toEqual({ locale: fixture.target.locale, offset: 50 });
  expect(calls("read_review_work").at(-1)?.[1].request.offset).toBe(50); expect(review.current().selected?.currentCheck?.runId).toBe(fixture.run.runId);
  noWrites();
});

it.each(["source", "translation"] as const)("selects the exact %s range after CRLF using only the textarea display projection", async field => {
  fixture = reviewDiagnosticFixture("grapheme", field, true); const { user } = await openQueue();
  await user.click(screen.getAllByRole("button", { name: i18n.t(field === "source" ? "review.diagnosticNavigation.locateSource" : "review.diagnosticNavigation.locateTranslation") })[0]);
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: i18n.t(field === "source" ? "review.diagnosticNavigation.sourceText" : "translation.draft") });
  await waitFor(() => expect(input.selectionStart).toBe(2)); expect(input.selectionEnd).toBe(9); expect(input.value.slice(2, 9)).toBe("👩🏽‍💻");
  await user.click(screen.getByRole("button", { name: "Rerender workspace" }));
  expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(9); expect(input).not.toHaveFocus();
  if (field === "source") expect(input).toHaveAttribute("readonly");
  else { fireEvent.compositionStart(input); fireEvent.compositionEnd(input); }
  expect(manual.current()?.text).toBe(fixture.target.translationText); expect(manual.current()?.text).toContain("\r\n"); noWrites();
});

it.each([false, true])("restores the exact review scope without silently recapturing it when expired=%s", async expired => {
  const { user } = await openQueue(); await user.click(screen.getByRole("tab", { name: i18n.t("review.reviewTab") }));
  const scope = memory.read("review", "summaryScope");
  await user.click(screen.getByRole("button", { name: i18n.t("review.openTranslation") }));
  await screen.findByRole("textbox", { name: "Your draft" });
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("protection.refreshEntry") })).toBeEnabled());
  const captures = () => calls("read_review_summary_page").filter(([, args]) => args.request.scopeId == null).length;
  const before = captures(); failSummary = expired;
  await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  await screen.findByRole("tab", { name: i18n.t("review.reviewTab"), selected: true });
  if (expired) { await screen.findByText(i18n.t("review.currentUnavailable")); expect(screen.getByRole("button", { name: i18n.t("review.currentRetry") })).toBeVisible(); }
  else await screen.findByRole("button", { name: fixture.target.nativeKey });
  expect(memory.read("review", "summaryScope")).toEqual(scope); expect(captures()).toBe(before); noWrites();
});

it("preserves newer B while a location read is pending and does not navigate on the late response", async () => {
  const { user } = await openQueue(), response = deferred<ReviewDiagnosticLocation>(); holdLocation = response.promise;
  await user.click(screen.getAllByRole("button", { name: "Locate in translation" })[0]); await waitFor(() => expect(calls("read_review_diagnostic_location")).toHaveLength(1));
  act(() => { manual.begin({ unitId: fixtureIdentity(3890), locale: "zh-CN", sourceRevisionId: fixtureIdentity(3891), key: "Retained B", sourceText: "Other source" }, null, null, "Newer B"); });
  await act(async () => { response.resolve(structuredClone(fixture.location)); });
  await screen.findByText(i18n.t("review.diagnosticNavigation.stale")); expect(area).toBe("review"); expect(manual.current()?.text).toBe("Newer B"); noWrites();
});

it("does not apply a delayed location after project session replacement", async () => {
  const { ui } = await openQueue(), response = deferred<ReviewDiagnosticLocation>(); holdLocation = response.promise;
  let moving!: Promise<boolean>; act(() => { moving = session.current!.navigate(originalDestination()); });
  await waitFor(() => expect(calls("read_review_diagnostic_location")).toHaveLength(1));
  ui.rerender(<Harness value={{ ...project, sessionToken: "replacement-diagnostic-session" }} />);
  await act(async () => { response.resolve(structuredClone(fixture.location)); expect(await moving).toBe(false); });
  expect(manual.current()).toBeNull(); expect(screen.queryByRole("textbox", { name: "Your draft" })).not.toBeInTheDocument(); noWrites();
});

it.each(["source", "translation", "review", "removed-locale"] as const)("rejects a location response after %s changes during the read", async changed => {
  const { ui } = await openQueue(), response = deferred<ReviewDiagnosticLocation>(); holdLocation = response.promise;
  let moving!: Promise<boolean>; act(() => { moving = session.current!.navigate(originalDestination()); });
  await waitFor(() => expect(calls("read_review_diagnostic_location")).toHaveLength(1));
  if (changed === "removed-locale") ui.rerender(<Harness value={{ ...project, metadata: { ...project.metadata, targetLocales: [], metadataRevision: "2" } }} />);
  else await act(async () => { reads.invalidate([changed]); });
  await act(async () => { response.resolve(structuredClone(fixture.location)); expect(await moving).toBe(false); });
  expect(manual.current()).toBeNull(); expect(area).toBe("review"); noWrites();
});

it.each(["locale", "unit"] as const)("does not redirect a newer Review %s intent after the original location returns", async changed => {
  await openQueue(); const response = deferred<ReviewDiagnosticLocation>(); holdLocation = response.promise;
  let moving!: Promise<boolean>; act(() => { moving = session.current!.navigate(originalDestination()); });
  await waitFor(() => expect(calls("read_review_diagnostic_location")).toHaveLength(1));
  act(() => { if (changed === "locale") review.setLocale(""); else review.setSelected({ ...fixture.target, unitId: fixtureIdentity(3892) }); });
  await act(async () => { response.resolve(structuredClone(fixture.location)); expect(await moving).toBe(false); });
  expect(manual.current()).toBeNull(); expect(area).toBe("review"); noWrites();
});

it("keeps old diagnostics readable when currentness is rejected and offers ordinary entry recovery", async () => {
  const { user } = await openQueue(); failLocation = true;
  await user.click(screen.getAllByRole("button", { name: "Locate in translation" })[0]);
  await screen.findByText(i18n.t("review.diagnosticNavigation.stale")); expect(area).toBe("review"); expect(manual.current()).toBeNull();
  await user.click(screen.getByRole("button", { name: i18n.t("review.openTranslation") }));
  await screen.findByRole("textbox", { name: "Your draft" }); expect(area).toBe("translation");
  expect(screen.getByRole("button", { name: "Return to original review queue" })).toBeVisible(); expect(calls("read_review_diagnostic_location")).toHaveLength(1); noWrites();
});

it("does not select a diagnostic over a newer composition intent during the editor read", async () => {
  const response = deferred<ReviewEditorSnapshot>(); holdEditor = response.promise;
  const { user } = await openQueue(); await user.click(screen.getAllByRole("button", { name: "Locate in translation" })[0]);
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Your draft" });
  fireEvent.compositionStart(input); act(() => manual.edit(`${manual.current()!.text} 新`));
  await act(async () => { response.resolve(structuredClone(fixture.editor)); });
  fireEvent.compositionEnd(input); await screen.findByText(i18n.t("review.diagnosticNavigation.stale"));
  expect(input).toHaveValue(`${fixture.target.translationText} 新`); expect(input.selectionStart).not.toBe(1); noWrites();
});

it("keeps a newer B and the original queue return when save A completes after cancelling a leave", async () => {
  const { user } = await openQueue(), input = await locate(user);
  await user.type(input, " A"); await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  await user.click(await screen.findByRole("button", { name: i18n.t("translation.stay") }));
  expect(area).toBe("translation"); expect(manual.current()?.text).toContain(" A");
  const saved = deferred<void>(); holdSave = saved.promise;
  await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  await user.click(await screen.findByRole("button", { name: i18n.t("translation.saveAndContinue") }));
  await waitFor(() => expect(calls("save_translation_revision")).toHaveLength(1));
  act(() => manual.edit(`${manual.current()!.text} B`)); const newer = manual.current()!.text;
  await act(async () => { saved.resolve(undefined); });
  await waitFor(() => expect(manual.current()?.pending).toBeNull()); expect(area).toBe("translation"); expect(manual.current()?.text).toBe(newer);
  expect(screen.getByRole("dialog", { name: i18n.t("translation.leaveTitle") })).toBeVisible();
  expect(memory.read("translation", "reviewReturn")).toMatchObject({ tab: "work", workOffset: 50 });
  expect(calls("write_review_decision")).toHaveLength(0); expect(calls("write_review_finding")).toHaveLength(0); expect(unexpected).toEqual([]);
});

it("returns after an explicitly saved repair while QA still requires a current recheck", async () => {
  const { user } = await openQueue(), input = await locate(user);
  await user.type(input, " repaired"); const text = manual.current()!.text;
  await user.click(screen.getByRole("button", { name: i18n.t("translation.save") }));
  await waitFor(() => expect(manual.current()?.baseText).toBe(text));
  await waitFor(() => expect(screen.getByRole("button", { name: "Return to original review queue" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  await screen.findByRole("tab", { name: i18n.t("review.workTab"), selected: true });
  expect(manual.current()?.text).toBe(text); expect(fixture.target.currentCheck).toBeNull();
  expect(memory.read("review", "workCursor")).toEqual({ locale: fixture.target.locale, offset: 50 });
  expect(calls("save_translation_revision")).toHaveLength(1); expect(calls("write_review_finding")).toHaveLength(0); expect(calls("write_review_decision")).toHaveLength(0); expect(unexpected).toEqual([]);
});

it("keeps the exact unknown save recoverable when returning to the queue is blocked", async () => {
  const { user } = await openQueue(), input = await locate(user); loseSave = true;
  await user.type(input, " edited"); await user.click(screen.getByRole("button", { name: i18n.t("translation.save") }));
  await waitFor(() => expect(manual.current()?.pending).not.toBeNull());
  await waitFor(() => expect(manual.current()?.saving).toBe(false)); const pending = manual.current()!.pending;
  await user.click(screen.getByRole("button", { name: "Return to original review queue" }));
  await screen.findByText(i18n.t("review.diagnosticNavigation.returnBlocked"));
  expect(area).toBe("translation"); expect(manual.current()?.pending).toBe(pending); expect(calls("save_translation_revision")).toHaveLength(1);
  expect(screen.getByRole("button", { name: i18n.t("translation.checkSavedAction") })).toBeVisible();
  expect(memory.read("translation", "reviewReturn")).toMatchObject({ tab: "work", workOffset: 50 }); expect(unexpected).toEqual([]);
});

it("records an explicit repair independently, then carries the same diagnostic and queue into the editor", async () => {
  const { user } = await openQueue();
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Inspect this exact saved result");
  const panel = within(screen.getByRole("region", { name: "Advisory findings" }));
  await user.click(panel.getByRole("button", { name: "Record repair request and open editor" }));
  await screen.findByRole("textbox", { name: "Your draft" });
  expect(calls("write_review_finding")).toHaveLength(1); expect(repairs[0].request.disposition).toBe("repair-requested");
  expect(calls("read_review_diagnostic_location")).toHaveLength(1); expect(memory.read("translation", "reviewReturn")).toMatchObject({ tab: "work", workOffset: 50 });
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("write_review_decision")).toHaveLength(0); expect(unexpected).toEqual([]);
});

it("clears an earlier queue origin only on a new explicit work entry", async () => {
  await openQueue(); expect(memory.read("review", "editorOrigin")).toMatchObject({ tab: "work", workOffset: 50 });
  await act(async () => { expect(await session.current!.navigate({ kind: "area", area: "overview" })).toBe(true); });
  expect(memory.read("review", "editorOrigin")).toMatchObject({ tab: "work", workOffset: 50 });
  await act(async () => { expect(await session.current!.navigate({ kind: "review-work" })).toBe(true); });
  expect(memory.read("review", "editorOrigin")).toBeNull(); expect(memory.read("review", "editorReturned")).toBeNull(); noWrites();
});
