import { createRef, useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSessionWorkbench, type OverviewSourcePresentation, type ProjectSessionHandle } from "./ProjectSessionWorkbench";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { WorkspaceViewMemory, WorkspaceViewProvider, type WorkspaceArea } from "./WorkbenchFrame";
import { WorkbenchCommands, WorkbenchCommandsProvider } from "./workbenchCommands";
import type { CommandError, ProjectView } from "./projectCommands";
import type { CorrectionTermEvidence, CorrectionTermReceipt, GlossaryCapture, ResourceDecisionResult, ResourcePreview, TermRevision } from "./resourceCommands";
import type { ReviewEditorSnapshot } from "./reviewCommands";
import type { TranslationRevision } from "./translationCommands";
import type { WorkProtection } from "./workPlanCommands";
import type { ProtectionRequest } from "./WorkProtectionSession";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewSummaryFor, reviewSummaryPageFixture, reviewTargetFixture } from "./testSupport/reviewFixture";
import { sourcePageFixture, sourceRowFixture } from "./testSupport/sourceFixture";
import resourceFixture from "../test/fixtures/resourceCommands.contract.json";
import { i18n } from "./i18n";
import { validateResponseChanges, validateResponseError } from "./generated/validators";
import { validateResponseScope, validateResponsePage, validateResponseSourceContext } from "./generated/source.validators";
import { validateResponseSummary, validateResponseEditor } from "./generated/review.validators";
import { validateResponseHistory } from "./generated/translation.validators";
import { validateResponseActivity } from "./generated/execution.validators";
import * as resource from "./generated/resource.validators";
import { validateRequestWorkProtectionRead, validateRequestWorkProtectionSet, validateResponseWorkProtection } from "./generated/ai.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const project: ProjectView = { sessionToken: "correction-feedback-session", locator: "isolated", reconciliationState: "settled",
  metadata: { projectId: resourceFixture.requests.session.projectId, displayName: "Correction feedback", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const handle = createRef<ProjectSessionHandle>();
const responses: Record<string, (value: unknown) => boolean> = {
  read_project_changes: validateResponseChanges, read_content_scope: validateResponseScope, read_source_content: validateResponsePage,
  read_review_summary_page: validateResponseSummary, read_review_editor_snapshot: validateResponseEditor,
  read_translation_history: validateResponseHistory, read_execution_task_activity: validateResponseActivity, read_source_context: validateResponseSourceContext,
  read_work_protection: validateResponseWorkProtection, set_work_protection: validateResponseWorkProtection, read_context_revision: resource.validateResponseContext,
  read_terms: resource.validateResponseTerms, list_resource_captures: resource.validateResponseCaptures,
  read_correction_term_basis: resource.validateResponseCorrectionBasis, read_correction_term_action: resource.validateResponseCorrectionAction,
  capture_correction_term: resource.validateResponseCorrectionCapture, read_resource_decision_action: resource.validateResponseDecisionAction,
  read_resource_preview: resource.validateResponsePreview, decide_resource_entry: resource.validateResponseDecision,
};
let evidence: CorrectionTermEvidence, snapshot: ReviewEditorSnapshot, captures: GlossaryCapture[], preview: ResourcePreview | null;
let captureActions: Map<string, CorrectionTermReceipt>, decisionActions: Map<string, ResourceDecisionResult>, term: TermRevision | null;
let protection: WorkProtection, protectionActions: Map<string, { request: ProtectionRequest; receipt: WorkProtection }>;
let serial: number, loseCapture: boolean, commitLostCapture: boolean, loseDecision: boolean, commitLostDecision: boolean, changed: boolean, changedReads: number;
let captureRejection: CommandError | null, decisionRejection: CommandError | null, basisRejection: CommandError | null;
let holdCapture: Promise<void> | null, holdBasis: Promise<CorrectionTermEvidence> | null, wireFailures: string[];
let rendered: ReturnType<typeof render>;
function Harness({ value = project }: { value?: ProjectView }) {
  const [area, setArea] = useState<WorkspaceArea>("overview"), [sourceState, setSourceState] = useState<OverviewSourcePresentation["state"]>("loading");
  const [memory] = useState(() => { const value = new WorkspaceViewMemory(); value.write("translation", "tab", "edit"); return value; });
  const [commands] = useState(() => new WorkbenchCommands());
  return <ApplicationReadProvider><WorkbenchCommandsProvider commands={commands}><WorkspaceViewProvider value={{ area, memory, activate: setArea, deactivate: () => setArea("overview") }}>
    <button disabled={sourceState !== "ready" && area === "overview"} onClick={() => { void handle.current?.navigate({ kind: "area", area: "translation" }); }}>Open translations</button>
    <button onClick={() => { void handle.current?.navigate({ kind: "area", area: "resources" }); }}>Open retained resources</button>
    <button onClick={() => { void handle.current?.prepareExit(); }}>Request safe exit</button>
    <ProjectSessionWorkbench ref={handle} project={value} disabled={false} onActivate={setArea} onCoordinatingChange={() => {}} onSourceState={value => setSourceState(value.state)} />
  </WorkspaceViewProvider></WorkbenchCommandsProvider></ApplicationReadProvider>;
}
function savedRevision(): TranslationRevision {
  const basis = evidence.basis;
  return { revisionId: basis.after.revisionId, unitId: basis.unitId, locale: basis.locale, ordinal: "2", actionId: fixtureIdentity(850), originKind: "manual",
    sourceRevisionId: basis.sourceRevisionId, sourceSnapshotId: basis.sourceSnapshotId, text: evidence.afterText,
    resultId: null, attemptId: null, artifactId: null, itemId: null, nativeKey: null, logicalPath: null, fileDigest: null, declaredLocale: null, contributors: [], candidateDecision: null };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  const value = structuredClone(resourceFixture.responses.correctionBasis);
  if (!resource.validateResponseCorrectionBasis(value)) throw new Error("Invalid canonical correction evidence fixture");
  evidence = value; captures = []; preview = null; captureActions = new Map(); decisionActions = new Map(); term = null;
  serial = 860; loseCapture = false; commitLostCapture = false; loseDecision = false; commitLostDecision = true; captureRejection = null; decisionRejection = null; basisRejection = null;
  holdCapture = null; holdBasis = null; changed = false; changedReads = 0; wireFailures = [];
  const basis = evidence.basis;
  protection = { unitId: basis.unitId, locale: basis.locale, revision: "0", protected: false }; protectionActions = new Map();
  const target = reviewTargetFixture({ unitId: basis.unitId, locale: basis.locale, nativeKey: "entry", sourceText: evidence.sourceText,
    sourceSnapshotId: basis.sourceSnapshotId, sourceRevisionId: basis.sourceRevisionId, selectionId: basis.after.selectionId, revisionId: basis.after.revisionId, translationText: evidence.afterText });
  snapshot = { target, readVersion: "saved-manual-view", context: null,
    terms: { unitId: basis.unitId, locale: basis.locale, sourceRevisionId: basis.sourceRevisionId, entries: [] },
    translations: { unitId: basis.unitId, locale: basis.locale, current: { eventId: basis.after.selectionId, revisionId: basis.after.revisionId,
      previousEventId: basis.before.selectionId, unitId: basis.unitId, locale: basis.locale, sequence: "2", actionId: fixtureIdentity(850) },
      currentText: evidence.afterText, total: "2", rows: [savedRevision()], nextOrdinal: null } };
  invoke.mockReset().mockImplementation(async (command: string, { request }: { request: Record<string, unknown> }) => {
    if (command === "read_context_strategy_default") return null;
    try {
      const result = await reply(command, request);
      const validate = responses[command];
      if (validate && !validate(result)) throw new Error(`Invalid synthetic IPC response: ${command}: ${JSON.stringify(Reflect.get(validate, "errors"))}`);
      return result;
    } catch (error) { wireFailures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`); throw error; }
  });
});
async function reply(command: string, request: Record<string, unknown>): Promise<unknown> {
  const b = evidence.basis;
  switch (command) {
    case "read_project_changes":
      if (changed) changedReads++;
      return { projectId: project.metadata.projectId, sessionToken: project.sessionToken, epoch: fixtureIdentity(859), sequence: changed ? "1" : "0", progressSequence: "0", scopes: changed ? ["translation"] : [], runtime: { active: false, quiescing: false, queryCount: 0, error: null } };
    case "read_content_scope": return { revision: "1", currentSnapshot: b.sourceSnapshotId };
    case "read_execution_task_activity": return { total: "0", active: "0", attention: "0", saved: "0", rows: [] };
    case "read_source_content": return sourcePageFixture({ snapshotId: b.sourceSnapshotId, scope: { revision: "1", currentSnapshot: b.sourceSnapshotId }, rows: [sourceRowFixture({ unitId: b.unitId, sourceRevisionId: b.sourceRevisionId }, { key: "entry", text: evidence.sourceText })] });
    case "read_review_summary_page": return reviewSummaryPageFixture([reviewSummaryFor(snapshot.target)]);
    case "read_review_editor_snapshot": return structuredClone(snapshot);
    case "read_translation_history": return structuredClone(snapshot.translations);
    case "read_work_protection":
      if (!validateRequestWorkProtectionRead(request)) throw new Error("Invalid protection read request");
      expect(request).toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: b.unitId, locale: b.locale });
      return structuredClone(protection);
    case "set_work_protection": {
      if (!validateRequestWorkProtectionSet(request)) throw new Error("Invalid protection write request");
      const original = protectionActions.get(request.actionId);
      if (original) { expect(request).toEqual(original.request); return structuredClone(original.receipt); }
      expect(request).toMatchObject({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: b.unitId, locale: b.locale,
        sourceRevisionId: b.sourceRevisionId, selectionId: b.after.selectionId, expectedRevision: protection.revision, protected: true, confirmedRelease: false });
      protection = { unitId: request.unitId, locale: request.locale, revision: (BigInt(request.expectedRevision) + 1n).toString(), protected: request.protected };
      protectionActions.set(request.actionId, { request: structuredClone(request), receipt: structuredClone(protection) });
      return structuredClone(protection);
    }
    case "read_context_revision": return null;
    case "read_context_fact_decisions": return [];
    case "read_terms": case "read_term_history": return term ? [structuredClone(term)] : [];
    case "list_resource_captures": return structuredClone(captures);
    case "resolve_terms": return structuredClone(snapshot.terms);
    case "tm_suggestions": return [];
    case "read_source_context": return { scope: { projectId: project.metadata.projectId, unitId: b.unitId, locale: b.locale, sourceSnapshotId: b.sourceSnapshotId, sourceRevisionId: b.sourceRevisionId }, contentRevision: "1", sourceAttemptId: fixtureIdentity(851), sourceResultId: fixtureIdentity(852), sourceResultDigest: "a".repeat(64), sourceLocale: "en-US", localUnitId: "entry", occurrenceCount: 1,
      observations: { missingBlocks: true, knownBlocks: 0, knownFacts: 0, emptyBlocks: 0, unknownBlocks: 0, unknownRequiredBlocks: 0, neighborOccurrences: 0, unknownSamples: [] }, entries: [], after: 0, totalEntries: 0, nextAfter: null };
    case "create_execution_identity": return fixtureIdentity(serial++);
    case "read_correction_term_basis":
      if (!resource.validateRequestCorrectionBasis(request)) throw new Error("Invalid correction basis request");
      expect(request).toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, unitId: b.unitId, locale: b.locale, afterSelectionId: b.after.selectionId });
      if (basisRejection) { if (!validateResponseError(basisRejection)) throw new Error("Invalid synthetic basis rejection"); throw basisRejection; }
      return holdBasis ?? structuredClone(evidence);
    case "capture_correction_term": {
      if (!resource.validateRequestCorrectionCapture(request)) throw new Error("Invalid correction capture request");
      const existing = captureActions.get(request.capture.actionId);
      if (existing) { expect(request.capture).toEqual(existing.request); return structuredClone(existing); }
      if (captureRejection) { if (!validateResponseError(captureRejection)) throw new Error("Invalid synthetic capture rejection"); throw captureRejection; }
      const capture: GlossaryCapture = { captureId: fixtureIdentity(880), origin: { kind: "correction", basis: structuredClone(request.capture.basis) }, sourceLocale: "en-US", targetLocale: b.locale, digest: "b".repeat(64), count: 1 };
      const receipt: CorrectionTermReceipt = { request: structuredClone(request.capture), capture };
      await holdCapture;
      if (!loseCapture || commitLostCapture) {
        captureActions.set(request.capture.actionId, receipt); captures = [capture];
        preview = { capture, rows: [{ entry: { id: "term", source: request.capture.source, target: request.capture.target, aliases: [], protected: request.capture.protected, nativeKey: null, reason: request.capture.reason }, kind: "added", current: null, scopeUnitId: b.unitId }], removed: [], correction: { evidence: structuredClone(evidence), decision: null }, mcp: null };
      }
      if (loseCapture) { loseCapture = false; return { unconfirmed: true }; }
      return structuredClone(receipt);
    }
    case "read_correction_term_action":
      if (!resource.validateRequestResourceAction(request)) throw new Error("Invalid resource action request");
      return structuredClone(captureActions.get(request.actionId) ?? null);
    case "read_resource_decision_action":
      if (!resource.validateRequestResourceAction(request)) throw new Error("Invalid resource action request");
      return structuredClone(decisionActions.get(request.actionId) ?? null);
    case "read_resource_preview":
      if (!resource.validateRequestCapture(request) || !preview) throw new Error("Invalid captured correction preview request");
      expect(request).toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, captureId: preview.capture.captureId });
      return { ...structuredClone(preview), correction: { evidence: structuredClone(evidence), decision: preview.correction?.decision ?? null } };
    case "decide_resource_entry": {
      if (!resource.validateRequestDecision(request) || !preview) throw new Error("Invalid resource decision request");
      const value = request.decision;
      const original = decisionActions.get(value.actionId);
      if (original) { expect(original.request).toEqual(value); return structuredClone(original); }
      if (decisionRejection) { if (!validateResponseError(decisionRejection)) throw new Error("Invalid synthetic decision rejection"); throw decisionRejection; }
      if (loseDecision && !commitLostDecision) { loseDecision = false; return { unconfirmed: true }; }
      if (value.decision === "adopt") {
        expect(evidence.current).toBe(true); expect(term).toBeNull();
        const entry = preview.rows[0].entry;
        term = { revisionId: fixtureIdentity(881), termId: fixtureIdentity(882), locale: b.locale, source: entry.source, target: entry.target, aliases: [], protected: entry.protected, scopeUnitId: b.unitId, reason: entry.reason, originKind: "manual", captureId: preview.capture.captureId, externalEntryId: null, previousRevisionId: value.expectedRevisionId ?? null, removed: false };
        preview.rows[0] = { ...preview.rows[0], current: term, kind: "unchanged" };
      }
      const receipt: ResourceDecisionResult = { actionId: value.actionId, request: { ...value, expectedRevisionId: value.expectedRevisionId ?? null }, decision: value.decision, revision: value.decision === "adopt" ? term : null };
      decisionActions.set(value.actionId, receipt);
      if (!preview.correction) throw new Error("Missing correction provenance");
      preview.correction.decision = receipt;
      if (loseDecision) { loseDecision = false; return { unconfirmed: true }; }
      return structuredClone(receipt);
    }
    default: throw new Error(`Unexpected synthetic IPC command: ${command}`);
  }
}
afterEach(cleanup);
async function openEditor({ eligible = true }: { eligible?: boolean } = {}) {
  const user = userEvent.setup(); let phase = "mount production owners";
  try {
    rendered = render(<Harness />);
    phase = "current overview source"; await waitFor(() => expect(screen.getByRole("button", { name: "Open translations" })).toBeEnabled());
    phase = "current task activity"; await screen.findByText(i18n.t("execution.dock.empty"));
    await user.click(screen.getByRole("button", { name: "Open translations" }));
    phase = "exact saved editor entry"; await user.click(await screen.findByRole("button", { name: "entry" }));
    const field = await screen.findByRole("textbox", { name: i18n.t("translation.draft") });
    phase = "unlocked original translation owner"; await waitFor(() => expect(field).not.toHaveAttribute("readonly"));
    await user.type(field, " manual B");
    await user.click(screen.getByText(i18n.t("workbench.references")));
    phase = "accurate correction command";
    if (eligible) await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") })).toBeEnabled());
    return user;
  } catch (error) { throw new Error(`Correction UI setup failed at ${phase}; IPC ${invoke.mock.calls.map(([command]) => command).join(", ")}; fixture errors ${wireFailures.join(" | ")}`, { cause: error }); }
}
async function openCandidate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") }));
  await screen.findByRole("region", { name: i18n.t("correctionFeedback.title") });
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.sourceTerm") }), "Barrel");
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.targetTerm") }), "木桶");
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), "Reviewed local correction");
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") })).toBeEnabled());
}
async function captureCandidate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await screen.findByRole("table");
}
function failFirstActionRead(command: "read_correction_term_action" | "read_resource_decision_action") {
  const original = invoke.getMockImplementation()!; let reads = 0;
  invoke.mockImplementation((name: string, args) => name === command && reads++ === 0
    ? Promise.reject(new Error("Original resource action read temporarily unavailable")) : original(name, args));
}

it.each(["en-US", "zh-CN"])("automatically checks one lost correction capture while preserving candidate B and the retained translation (%s)", async language => {
  await i18n.changeLanguage(language); const user = await openEditor(); await openCandidate(user);
  loseCapture = true; commitLostCapture = true;
  let finishWrite!: () => void, finishRead!: (value: CorrectionTermReceipt | null) => void;
  holdCapture = new Promise<void>(resolve => { finishWrite = resolve; });
  const lookup = new Promise<CorrectionTermReceipt | null>(resolve => { finishRead = resolve; }), native = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "read_correction_term_action" ? lookup : native(command, args));
  const identities = invoke.mock.calls.filter(([command]) => command === "create_execution_identity").length;
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "capture_correction_term")).toHaveLength(1));
  expect(screen.queryByText(i18n.t("resource.checkingAction"))).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_action")).toHaveLength(0);
  await act(async () => { finishWrite(); }); holdCapture = null;
  await screen.findByText(i18n.t("resource.checkingAction"));
  expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") })).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " retained B");
  const request = invoke.mock.calls.find(([command]) => command === "capture_correction_term")![1].request.capture;
  await act(async () => { finishRead(captureActions.get(request.actionId)!); });
  await screen.findByRole("table");
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction retained B");
  expect(screen.queryByText(i18n.t("resource.checkingAction"))).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_action").map(([, args]) => args.request))
    .toEqual([{ projectId: project.metadata.projectId, sessionToken: project.sessionToken, actionId: request.actionId }]);
  expect(invoke.mock.calls.filter(([command]) => command === "capture_correction_term")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(identities + 1);
  expect(term).toBeNull(); expect(invoke.mock.calls.some(([command]) => command === "decide_resource_entry")).toBe(false);
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.return") }));
  expect(await screen.findByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
});

it("keeps the original correction request when a typed action read changes its reason, then confirms it by a manual pure read", async () => {
  const user = await openEditor(); await openCandidate(user); loseCapture = true; commitLostCapture = true;
  const native = invoke.getMockImplementation()!; let reads = 0;
  invoke.mockImplementation(async (command: string, args) => {
    const value = await native(command, args);
    if (command !== "read_correction_term_action" || reads++ > 0) return value;
    if (!resource.validateResponseCorrectionAction(value) || !value) throw new Error("Missing captured correction receipt");
    const wrong = { ...value, request: { ...value.request, reason: "Different original reason" } };
    expect(resource.validateResponseCorrectionAction(wrong)).toBe(true); return wrong;
  });
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") })).toBeEnabled());
  expect(screen.queryByRole("button", { name: i18n.t("resource.retry") })).not.toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " B");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") }));
  await screen.findByRole("table");
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction B");
  expect(invoke.mock.calls.filter(([command]) => command === "capture_correction_term")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_action")).toHaveLength(2);
  expect(term).toBeNull();
});

it("uses only the saved correction and requires explicit candidate creation and adoption", async () => {
  const user = await openEditor();
  expect(invoke.mock.calls.some(([command]) => ["capture_correction_term", "decide_resource_entry", "save_term"].includes(command))).toBe(false);
  await openCandidate(user); await captureCandidate(user);
  const capture = invoke.mock.calls.find(([command]) => command === "capture_correction_term")?.[1].request.capture;
  expect(capture).toMatchObject({ basis: evidence.basis, source: "Barrel", target: "木桶", reason: "Reviewed local correction" });
  expect(JSON.stringify(capture)).not.toContain("manual B"); expect(term).toBeNull();
  expect(invoke.mock.calls.some(([command]) => command === "decide_resource_entry")).toBe(false);
  const row = screen.getByRole("row", { name: /Barrel/ });
  await user.click(within(row).getByRole("button", { name: i18n.t("resource.keep") }));
  await waitFor(() => expect(decisionActions.size).toBe(1)); expect(term).toBeNull();
  await waitFor(() => expect(within(screen.getByRole("row", { name: /Barrel/ })).getByRole("button", { name: i18n.t("resource.adopt") })).toBeEnabled());
  await user.click(within(screen.getByRole("row", { name: /Barrel/ })).getByRole("button", { name: i18n.t("resource.adopt") }));
  await waitFor(() => expect(term?.originKind).toBe("manual"));
  expect(term).toMatchObject({ scopeUnitId: evidence.basis.unitId, locale: evidence.basis.locale, captureId: captures[0].captureId, externalEntryId: null });
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.return") }));
  expect(await screen.findByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
  expect(invoke.mock.calls.some(([command]) => command === "save_term" || command === "save_translation_revision")).toBe(false);
});

it("keeps stale evidence readable and permits Keep or Ignore while refusing first adoption", async () => {
  const user = await openEditor(); await openCandidate(user); await captureCandidate(user);
  evidence.current = false;
  await act(async () => { changed = true; window.dispatchEvent(new Event("focus")); });
  await user.click(await screen.findByRole("button", { name: i18n.t("resource.retryPreview") }));
  await screen.findByText(i18n.t("correctionFeedback.stale"));
  const row = screen.getByRole("row", { name: /Barrel/ });
  expect(within(row).getByRole("button", { name: i18n.t("resource.adopt") })).toBeDisabled();
  expect(within(row).getByRole("button", { name: i18n.t("resource.keep") })).toBeEnabled();
  await user.click(within(row).getByRole("button", { name: i18n.t("resource.ignore") }));
  await waitFor(() => expect([...decisionActions.values()][0]?.decision).toBe("ignore")); expect(term).toBeNull();
});

it("retains the complete unknown request after an empty receipt and retries it without losing newer candidate B", async () => {
  const user = await openEditor(); await openCandidate(user); loseCapture = true;
  failFirstActionRead("read_correction_term_action");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await screen.findByText(i18n.t("correctionFeedback.unknown"));
  const first = invoke.mock.calls.find(([command]) => command === "capture_correction_term")?.[1].request;
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " newer B");
  let exiting: ReturnType<ProjectSessionHandle["prepareExit"]> | undefined;
  await act(async () => { exiting = handle.current?.prepareExit(); });
  const leave = await screen.findByRole("dialog", { name: i18n.t("translation.leaveTitle") });
  await user.click(within(leave).getByRole("button", { name: i18n.t("translation.stay") }));
  expect(await exiting).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open retained resources" }));
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") }));
  await screen.findByText(i18n.t("correctionFeedback.missing"));
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction newer B");
  expect(invoke.mock.calls.filter(([command]) => command === "capture_correction_term")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: i18n.t("resource.retry") }));
  await waitFor(() => expect(captureActions.size).toBe(1));
  const calls = invoke.mock.calls.filter(([command]) => command === "capture_correction_term"); expect(calls).toHaveLength(2); expect(calls[1][1].request).toEqual(first);
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_action")).toHaveLength(2);
  expect(await screen.findByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction newer B");
  expect(term).toBeNull();
});

it("a late successful capture keeps B and reconciles a lost decision acknowledgement by its original action", async () => {
  let finish!: () => void; holdCapture = new Promise<void>(resolve => { finish = resolve; });
  const user = await openEditor(); await openCandidate(user);
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "capture_correction_term")).toBe(true));
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " late B");
  await act(async () => finish()); holdCapture = null;
  await screen.findByRole("table");
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction late B");
  loseDecision = true;
  failFirstActionRead("read_resource_decision_action");
  await user.click(within(screen.getByRole("row", { name: /Barrel/ })).getByRole("button", { name: i18n.t("resource.ignore") }));
  await screen.findByText(i18n.t("correctionFeedback.unknown"));
  const original = invoke.mock.calls.find(([command]) => command === "decide_resource_entry")?.[1].request.decision;
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_resource_decision_action")).toBe(true));
  await waitFor(() => expect(screen.queryByText(i18n.t("correctionFeedback.unknown"))).toBeNull());
  expect([...decisionActions.values()][0].request).toEqual(original);
  expect(invoke.mock.calls.filter(([command]) => command === "decide_resource_entry")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "read_resource_decision_action")).toHaveLength(2);
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction late B");
});

it("refuses a handoff over an existing resource draft and preserves both workspaces", async () => {
  const user = await openEditor();
  await user.click(screen.getByRole("button", { name: "Open retained resources" }));
  await user.type(await screen.findByRole("textbox", { name: i18n.t("resource.sourceTerm") }), "resource B");
  await user.click(screen.getByRole("button", { name: "Open translations" }));
  await user.click(await screen.findByRole("button", { name: i18n.t("correctionFeedback.open") }));
  await screen.findByText(i18n.t("correctionFeedback.blocked"));
  expect(screen.getByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
  await user.click(screen.getByRole("button", { name: "Open retained resources" }));
  expect(await screen.findByRole("textbox", { name: i18n.t("resource.sourceTerm") })).toHaveValue("resource B");
  expect(invoke.mock.calls.some(([command]) => command === "capture_correction_term")).toBe(false);
});

it("rejects a late correction basis after the live translation bridge invalidates the original handoff", async () => {
  const original = structuredClone(evidence), user = await openEditor();
  const eligibilityReads = invoke.mock.calls.filter(([command]) => command === "read_correction_term_basis").length;
  expect(eligibilityReads).toBeGreaterThan(0);
  let finish!: (value: CorrectionTermEvidence) => void;
  holdBasis = new Promise(resolve => { finish = resolve; });
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_basis").length).toBeGreaterThan(eligibilityReads));
  await act(async () => { changed = true; window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(changedReads).toBeGreaterThan(0));
  await act(async () => finish(original));
  holdBasis = null;
  await screen.findByText(i18n.t("correctionFeedback.changed"));
  expect(screen.queryByRole("region", { name: i18n.t("correctionFeedback.title") })).toBeNull();
  expect(screen.getByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
  expect(invoke.mock.calls.some(([command]) => command === "capture_correction_term")).toBe(false);
});

it("requires literal user terms without turning invalid text into a candidate", async () => {
  const user = await openEditor(); await openCandidate(user);
  const source = screen.getByRole("textbox", { name: i18n.t("correctionFeedback.sourceTerm") });
  await user.clear(source); await user.type(source, " Barrel");
  expect(source).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") })).toBeDisabled();
  await user.clear(source); await user.type(source, "Barrel");
  const target = screen.getByRole("textbox", { name: i18n.t("correctionFeedback.targetTerm") });
  await user.clear(target); await user.type(target, "new unsaved term");
  expect(target).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "capture_correction_term")).toBe(false);
});

it("restores a committed candidate from the exact original action after its capture acknowledgement is lost", async () => {
  const user = await openEditor(); await openCandidate(user); loseCapture = true; commitLostCapture = true;
  failFirstActionRead("read_correction_term_action");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await screen.findByText(i18n.t("correctionFeedback.unknown"));
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " retained B");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") }));
  await screen.findByRole("table");
  expect(invoke.mock.calls.filter(([command]) => command === "capture_correction_term")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_action")).toHaveLength(2);
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction retained B");
  expect(term).toBeNull();
});

it("retains correction history and Keep or Ignore after its target locale is removed without allowing adoption or ordinary writes", async () => {
  const user = await openEditor(); await openCandidate(user); await captureCandidate(user);
  evidence.current = false;
  rendered.rerender(<Harness value={{ ...project, metadata: { ...project.metadata, targetLocales: ["fr"] } }} />);
  await act(async () => { changed = true; window.dispatchEvent(new Event("focus")); });
  await user.click(await screen.findByRole("button", { name: i18n.t("resource.retryPreview") }));
  await screen.findByText(i18n.t("correctionFeedback.stale"));
  const row = screen.getByRole("row", { name: /Barrel/ });
  expect(within(row).getByRole("button", { name: i18n.t("resource.adopt") })).toBeDisabled();
  expect(screen.getByRole("button", { name: i18n.t("resource.chooseFile") })).toBeDisabled();
  await waitFor(() => expect(within(row).getByRole("button", { name: i18n.t("resource.keep") })).toBeEnabled());
  await user.click(within(row).getByRole("button", { name: i18n.t("resource.keep") }));
  await waitFor(() => expect([...decisionActions.values()][0]?.request).toMatchObject({ projectId: project.metadata.projectId, captureId: captures[0].captureId, decision: "keep" }));
  expect(term).toBeNull();
  expect(invoke.mock.calls.some(([command]) => command === "save_term")).toBe(false);
});

it("settles an unknown uncommitted capture only after the original retry receives the exact Core stale rejection", async () => {
  const user = await openEditor(); await openCandidate(user); loseCapture = true;
  failFirstActionRead("read_correction_term_action");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await screen.findByText(i18n.t("correctionFeedback.unknown"));
  const original = invoke.mock.calls.find(([command]) => command === "capture_correction_term")?.[1].request;
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " retained B");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") }));
  await screen.findByText(i18n.t("correctionFeedback.missing"));
  evidence.current = false;
  captureRejection = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "correction-stale" };
  await user.click(screen.getByRole("button", { name: i18n.t("resource.retry") }));
  await waitFor(() => expect(screen.queryByText(i18n.t("correctionFeedback.unknown"))).toBeNull());
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("resource.discardDraft") })).toBeEnabled());
  expect(invoke.mock.calls.filter(([command]) => command === "capture_correction_term").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_action")).toHaveLength(2);
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction retained B");
  expect(captureActions.size).toBe(0);
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.return") }));
  expect(await screen.findByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
  await user.click(screen.getByRole("button", { name: "Open retained resources" }));
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction retained B");
  await user.click(screen.getByRole("button", { name: i18n.t("resource.discardDraft") }));
  let exiting: ReturnType<ProjectSessionHandle["prepareExit"]> | undefined;
  await act(async () => { exiting = handle.current?.prepareExit(); });
  await user.click(within(await screen.findByRole("dialog", { name: i18n.t("translation.leaveTitle") })).getByRole("button", { name: i18n.t("translation.discard") }));
  const permit = await exiting; expect(permit?.current()).toBe(true); permit?.release();
});

it("settles an unknown uncommitted decision at the exact Core CAS rejection while retaining candidate B and saved history", async () => {
  let finish!: () => void; holdCapture = new Promise(resolve => { finish = resolve; });
  const user = await openEditor(); await openCandidate(user);
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "capture_correction_term")).toBe(true));
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " decision B");
  await act(async () => finish()); holdCapture = null; await screen.findByRole("table");
  loseDecision = true; commitLostDecision = false;
  failFirstActionRead("read_resource_decision_action");
  await waitFor(() => expect(within(screen.getByRole("row", { name: /Barrel/ })).getByRole("button", { name: i18n.t("resource.ignore") })).toBeEnabled());
  await user.click(within(screen.getByRole("row", { name: /Barrel/ })).getByRole("button", { name: i18n.t("resource.ignore") }));
  await screen.findByText(i18n.t("correctionFeedback.unknown"));
  const original = invoke.mock.calls.find(([command]) => command === "decide_resource_entry")?.[1].request;
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") }));
  await screen.findByText(i18n.t("correctionFeedback.missing"));
  decisionRejection = { code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "resource-current" };
  await user.click(screen.getByRole("button", { name: i18n.t("resource.retry") }));
  await waitFor(() => expect(screen.queryByText(i18n.t("correctionFeedback.unknown"))).toBeNull());
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction decision B");
  expect(invoke.mock.calls.filter(([command]) => command === "decide_resource_entry").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(invoke.mock.calls.filter(([command]) => command === "read_resource_decision_action")).toHaveLength(2);
  expect(captures).toHaveLength(1); expect(decisionActions.size).toBe(0); expect(term).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.return") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.return") }));
  expect(await screen.findByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
});

it("keeps the original unknown request after a Host quiesce rejection even when its receipt read was empty", async () => {
  const user = await openEditor(); await openCandidate(user); loseCapture = true;
  failFirstActionRead("read_correction_term_action");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.capture") }));
  await screen.findByText(i18n.t("correctionFeedback.unknown"));
  await user.type(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") }), " pending B");
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.check") }));
  await screen.findByText(i18n.t("correctionFeedback.missing"));
  captureRejection = { code: "busy", stage: "execution-recover", outcome: "rejected", recoveryRequired: false };
  await user.click(screen.getByRole("button", { name: i18n.t("resource.retry") }));
  await screen.findByText(i18n.t("correctionFeedback.unknown"));
  expect(screen.getByRole("textbox", { name: i18n.t("correctionFeedback.reason") })).toHaveValue("Reviewed local correction pending B");
  expect(screen.getByRole("button", { name: i18n.t("resource.discardDraft") })).toBeDisabled();
  expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.return") })).toBeDisabled();
  expect(screen.queryByRole("button", { name: i18n.t("resource.retry") })).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_action")).toHaveLength(2);
  let exiting: ReturnType<ProjectSessionHandle["prepareExit"]> | undefined;
  await act(async () => { exiting = handle.current?.prepareExit(); });
  await user.click(within(await screen.findByRole("dialog", { name: i18n.t("translation.leaveTitle") })).getByRole("button", { name: i18n.t("translation.discard") }));
  expect(await exiting).toBeNull();
  expect(await screen.findByText(i18n.t("correctionFeedback.unknown"))).toBeVisible();
  expect(captureActions.size).toBe(0);
});

function aiRevision(ordinal: number): TranslationRevision {
  return { ...savedRevision(), revisionId: fixtureIdentity(1000 + ordinal), ordinal: String(ordinal), actionId: fixtureIdentity(1200 + ordinal),
    originKind: "ai", resultId: fixtureIdentity(1400 + ordinal), attemptId: fixtureIdentity(1600 + ordinal),
    artifactId: fixtureIdentity(1800 + ordinal), itemId: fixtureIdentity(2000 + ordinal), text: `Saved AI candidate ${ordinal}` };
}

it("uses exact Core correction evidence when the current saved Manual revision is outside the last 100 candidates", async () => {
  snapshot.translations = { ...snapshot.translations, total: "102", rows: Array.from({ length: 100 }, (_, index) => aiRevision(index + 3)), nextOrdinal: null };
  expect(snapshot.translations.rows.some(row => row.revisionId === snapshot.translations.current?.revisionId)).toBe(false);
  const user = await openEditor();
  const eligibilityReads = invoke.mock.calls.filter(([command]) => command === "read_correction_term_basis").length;
  expect(eligibilityReads).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") }));
  await screen.findByRole("region", { name: i18n.t("correctionFeedback.title") });
  expect(invoke.mock.calls.filter(([command]) => command === "read_correction_term_basis").length).toBeGreaterThan(eligibilityReads);
  await user.click(screen.getByRole("button", { name: i18n.t("correctionFeedback.return") }));
  expect(await screen.findByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
  expect(invoke.mock.calls.some(([command]) => ["capture_correction_term", "decide_resource_entry", "save_term", "save_translation_revision"].includes(command))).toBe(false);
});

it.each(["ai", "reselection"] as const)("keeps a current %s selection ineligible when Core rejects its original manual correction identity", async kind => {
  const selection = snapshot.translations.current;
  if (!selection) throw new Error("Missing synthetic saved selection");
  if (kind === "ai") {
    snapshot.translations.rows = [{ ...aiRevision(2), revisionId: selection.revisionId }];
    selection.actionId = snapshot.translations.rows[0].actionId;
  } else selection.actionId = fixtureIdentity(855);
  basisRejection = { code: "dependency-conflict", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "correction-selection" };
  await openEditor({ eligible: false });
  await screen.findByText(i18n.t("correctionFeedback.readFailed"));
  expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
  expect(invoke.mock.calls.some(([command]) => command === "read_correction_term_basis")).toBe(true);
  expect(screen.queryByRole("region", { name: i18n.t("correctionFeedback.title") })).toBeNull();
  expect(invoke.mock.calls.some(([command]) => command === "capture_correction_term")).toBe(false);
});

it("does not query or offer a first saved translation with no previous selection as a correction", async () => {
  const selection = snapshot.translations.current;
  if (!selection) throw new Error("Missing synthetic saved selection");
  selection.previousEventId = null; selection.sequence = "1";
  snapshot.translations.total = "1"; snapshot.translations.rows[0].ordinal = "1";
  await openEditor({ eligible: false });
  expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") })).toBeDisabled();
  expect(invoke.mock.calls.some(([command]) => command === "read_correction_term_basis")).toBe(false);
  expect(screen.getByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
});

it("shows a retryable local evidence read failure and keeps the retained translation draft", async () => {
  basisRejection = { code: "storage-failed", stage: "execution-read", outcome: "rejected", recoveryRequired: false, reason: "resource-read" };
  const user = await openEditor({ eligible: false });
  const failure = (await screen.findByText(i18n.t("correctionFeedback.readFailed"))).closest("[role=alert]");
  if (!(failure instanceof HTMLElement)) throw new Error("Missing local correction read feedback");
  expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") })).toBeDisabled();
  basisRejection = null;
  await user.click(within(failure).getByRole("button", { name: i18n.t("resource.retryRead") }));
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("correctionFeedback.open") })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: i18n.t("translation.draft") })).toHaveValue(evidence.afterText + " manual B");
  expect(invoke.mock.calls.some(([command]) => command === "capture_correction_term")).toBe(false);
});
