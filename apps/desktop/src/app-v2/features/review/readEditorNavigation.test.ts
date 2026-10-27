import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewEditorSnapshot } from "../../../reviewCommands";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewDiagnosticFixture } from "../../../testSupport/reviewDiagnosticFixture";
import { semanticDiagnosticFixture } from "../../../testSupport/semanticDiagnosticFixture";
import type { EntryReviewEditorRequest } from "./navigationTypes";
import { readEditorNavigation } from "./readEditorNavigation";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { projectId: fixtureIdentity(9975), sessionToken: "synthetic-diagnostic-admission" };
const retained: SessionReads[] = [];
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function reads() { const value = new SessionReads(context); retained.push(value); return value; }
function qaRequest(value: ReturnType<typeof reviewDiagnosticFixture>): EntryReviewEditorRequest {
  return { target: structuredClone(value.target), diagnostic: {
    intent: { runId: value.run.runId, source: { purpose: "qa" }, diagnostic: structuredClone(value.diagnostic) }, location: structuredClone(value.location),
  } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function installQa(value: ReturnType<typeof reviewDiagnosticFixture>, sourceSnapshot = value.target.sourceSnapshotId, snapshot: ReviewEditorSnapshot = value.editor) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: sourceSnapshot };
    if (command === "read_review_editor_snapshot") return structuredClone(snapshot);
    throw new Error(`Unexpected IPC: ${command}`);
  });
}
function onlyReads() {
  expect(invoke.mock.calls.every(([command]) => ["read_content_scope", "read_review_editor_snapshot", "read_ai_semantic_review", "read_review_findings"].includes(command))).toBe(true);
  expect(calls("read_review_diagnostic_location")).toHaveLength(0);
}
beforeEach(() => { invoke.mockReset(); });
afterEach(() => { retained.splice(0).forEach(value => value.retire()); });

it("admits fresh QA through the real read adapters without creating another location or mutating Unicode text", async () => {
  const value = reviewDiagnosticFixture("grapheme", "translation", true), input = qaRequest(value), original = structuredClone(input);
  installQa(value);
  const snapshot = await readEditorNavigation(reads(), input, () => true);
  expect(snapshot).toEqual(value.editor); expect(input).toEqual(original);
  expect(snapshot?.target.translationText).toContain("\r\n👩🏽‍💻");
  expect(calls("read_review_editor_snapshot")[0][1].request).toEqual({ ...context, unitId: value.target.unitId, locale: value.target.locale });
  expect(calls("read_content_scope")[0][1].request).toEqual(context);
  onlyReads();
});

it.each(["target", "sourceSnapshot", "field"] as const)("rejects a changed fresh %s before admitting the captured QA location", async change => {
  const value = reviewDiagnosticFixture(), input = qaRequest(value), snapshot = structuredClone(value.editor);
  if (change === "target") snapshot.target.unitId = fixtureIdentity(9976);
  if (change === "field" && input.diagnostic) input.diagnostic.location.location.field = "source";
  installQa(value, change === "sourceSnapshot" ? fixtureIdentity(9977) : value.target.sourceSnapshotId, snapshot);
  expect(await readEditorNavigation(reads(), input, () => true)).toBeNull();
  onlyReads();
});

function installSemantic(value: ReturnType<typeof semanticDiagnosticFixture>) {
  const findings = { ...structuredClone(value.findings), findings: [] };
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: value.target.sourceSnapshotId };
    if (command === "read_review_editor_snapshot") return structuredClone(value.editor);
    if (command === "read_ai_semantic_review") return { attemptId: value.view.detail.attemptId, view: structuredClone(value.view) };
    if (command === "read_review_findings") return structuredClone(findings);
    throw new Error(`Unexpected IPC: ${command}`);
  });
  const input: EntryReviewEditorRequest = { target: structuredClone(value.target), diagnostic: {
    intent: { runId: value.run.runId, source: structuredClone(value.source), diagnostic: structuredClone(value.diagnostic) }, location: structuredClone(value.location),
  } };
  return { findings, input };
}

it("admits the exact original AI run while its finding is absent from the first page, independently of QA", async () => {
  const value = semanticDiagnosticFixture(), { input, findings } = installSemantic(value);
  expect(findings.findings).toEqual([]); expect(findings.semanticRunId).not.toBe(value.target.currentCheck?.runId);
  expect(await readEditorNavigation(reads(), input, () => true)).toEqual(value.editor);
  expect(calls("read_ai_semantic_review")[0][1].request).toEqual({ ...context, attemptId: value.run.evidence.attemptId });
  expect(calls("read_review_findings")[0][1].request).toEqual({ ...context, unitId: value.target.unitId, locale: value.target.locale, offset: 0, limit: 20 });
  onlyReads();
});

it.each(["current run", "origin digest"] as const)("rejects a mismatched semantic %s even when source and selection still match", async change => {
  const value = semanticDiagnosticFixture(), { input, findings } = installSemantic(value);
  if (change === "current run") findings.semanticRunId = fixtureIdentity(9978);
  else {
    const source = input.diagnostic?.intent.source;
    if (!source || source.purpose !== "ai-semantic") throw new Error("Original semantic source required");
    source.origin.resultDigest = "9".repeat(64);
  }
  expect(await readEditorNavigation(reads(), input, () => true)).toBeNull();
  expect(calls("read_ai_semantic_review")).toHaveLength(1); expect(calls("read_review_findings")).toHaveLength(1);
  onlyReads();
});

it("rejects a late fresh read after its caller's original intent expires", async () => {
  const value = reviewDiagnosticFixture(), late = deferred<ReviewEditorSnapshot>(); let current = true;
  installQa(value); const native = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "read_review_editor_snapshot" ? late.promise : native(command, args));
  const admitted = readEditorNavigation(reads(), qaRequest(value), () => current);
  current = false; late.resolve(structuredClone(value.editor));
  expect(await admitted).toBeNull(); expect(calls("read_review_editor_snapshot")).toHaveLength(1);
  onlyReads();
});

it("allows ordinary editing of fresh current content after the earlier source changed, without deriving a range or writing", async () => {
  const earlier = reviewDiagnosticFixture(), current = reviewDiagnosticFixture("utf16", "source", true);
  current.target.sourceSnapshotId = fixtureIdentity(9979); current.target.sourceRevisionId = fixtureIdentity(9980);
  current.target.sourceText = "Current source\r\né 👩🏽‍💻"; current.target.currentCheck = null;
  current.target.basis = "f".repeat(64); current.target.basisEvidence = { ...current.target.basisEvidence,
    sourceSnapshotId: current.target.sourceSnapshotId, sourceRevisionId: current.target.sourceRevisionId };
  installQa(current);
  const input: EntryReviewEditorRequest = { target: structuredClone(earlier.target) }, before = structuredClone(input);
  expect(await readEditorNavigation(reads(), input, () => true)).toEqual(current.editor);
  expect(input).toEqual(before); expect(calls("read_ai_semantic_review")).toHaveLength(0); expect(calls("read_review_findings")).toHaveLength(0);
  onlyReads();
});
