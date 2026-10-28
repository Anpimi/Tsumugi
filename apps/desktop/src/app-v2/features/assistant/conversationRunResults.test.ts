import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aiFixture from "../../../../test/fixtures/aiCommands.contract.json";
import translationFixture from "../../../../test/fixtures/translation-commands.json";
import { conversationWorkPlanFixture } from "../../../testSupport/conversationWorkPlanFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { validateResponseView, validateResponseWorkPlan, validateResponseWorkPlanRun, validateResponseWorkPlanStartAction } from "../../../generated/ai.validators";
import { validateResponseProposalWorkPlanLink } from "../../../generated/conversations.validators";
import { validateResponseRevision } from "../../../generated/translation.validators";
import type { AiView } from "../../../aiCommands";
import type { TranslationRevision } from "../../../translationCommands";
import { conversationRunCandidateTarget, readConversationRunResults, resolveConversationRunCandidate, type ConversationRunCandidateTarget } from "./conversationRunResultReads";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
function checkedView(value: unknown): AiView {
  if (!validateResponseView(value)) throw new Error("Invalid synthetic AI view"); return value;
}
function fixture(count = 2) {
  const context = { projectId: aiFixture.requests.read.projectId, sessionToken: "fixture-session" }, conversationId = id(48000);
  const prepared = conversationWorkPlanFixture({ ...context, conversationId }).prepared, plan = structuredClone(prepared.plan);
  const view = checkedView(structuredClone(aiFixture.responses.view)), preview = plan.preview;
  if (!preview || !view.rows[0].output) throw new Error("Complete source fixture required");
  const base = structuredClone(view.rows[0]), material = preview.items[0], basis = plan.scope[0], detail = view.detail.items[0], recovery = view.detail.recovery.units[0];
  preview.items = Array.from({ length: count }, (_, index) => ({ ...structuredClone(material), unitId: id(49000 + index), sourceRevisionId: id(50000 + index),
    nativeKey: `dialogue.${index}`, context: material.context ? { ...structuredClone(material.context), unitId: id(49000 + index) } : null }));
  preview.config.maxItems = count; preview.config.maxRequests = count;
  plan.scope = preview.items.map(item => ({ ...basis, unitId: item.unitId, sourceRevisionId: item.sourceRevisionId, sourceSnapshotId: item.sourceSnapshotId, nativeKey: item.nativeKey }));
  plan.attemptId = id(48001);
  view.rows = preview.items.map((item, index): AiView["rows"][number] => {
    if (!base.output) throw new Error("Output fixture required");
    return { ...structuredClone(base), item: structuredClone(item), itemId: id(51000 + index), resultId: id(52000 + index), savedRevisionId: index === 0 ? id(53000) : null,
      output: { ...structuredClone(base.output), unitId: item.unitId, targetLocale: item.targetLocale, text: index === 0 ? "" : base.output.text } };
  });
  view.detail.items = view.rows.map(row => ({ ...structuredClone(detail), status: { ...detail.status, itemId: row.itemId }, resultId: row.resultId,
    scope: { kind: "translation", locale: row.item.targetLocale, id: row.item.unitId } }));
  view.detail.recovery.units = view.rows.map(row => ({ ...structuredClone(recovery), unitId: row.item.unitId, itemIds: [row.itemId], remainingItemIds: [row.itemId],
    resultIds: row.resultId ? [row.resultId] : [], scopes: [{ kind: "translation", locale: row.item.targetLocale, id: row.item.unitId }] }));
  view.detail.progress = { total: count, queued: 0, running: 0, succeeded: count, failed: 0, cancelled: 0, unknown: 0, adopted: 0 };
  view.config = structuredClone(preview.config); view.recipe = preview.recipe; view.planId = plan.planId; view.planGeneration = "3";
  const start: unknown = { projectId: context.projectId, planId: plan.planId, actionId: id(48002), expectedGeneration: view.planGeneration,
    taskId: view.detail.taskId, attemptId: view.detail.attemptId };
  const link: unknown = { ...prepared.proposal, planId: plan.planId, planDigest: plan.digest, actionId: id(48003), ordinal: "1" };
  if (!validateResponseWorkPlanStartAction(start) || start === null || !validateResponseProposalWorkPlanLink(link) || !validateResponseWorkPlan(plan))
    throw new Error("Invalid synthetic conversation run");
  const run: unknown = { projectId: context.projectId, planId: plan.planId, planDigest: plan.digest, lease: { planId: plan.planId, generation: "5" },
    state: "active", lastStart: start, budgetRootTaskId: start.taskId, budget: null };
  if (!validateResponseWorkPlanRun(run) || run.lastStart === null) throw new Error("Invalid synthetic historical start");
  return { context, link, plan, start, run, view: checkedView(view) };
}
type Fixture = ReturnType<typeof fixture>;
function targetOf(h: Fixture): ConversationRunCandidateTarget {
  const target = conversationRunCandidateTarget(h.link, h.start, h.view.rows[0]);
  if (!target) throw new Error("Saved candidate fixture required"); return target;
}
function revisionOf(h: Fixture): TranslationRevision {
  const target = targetOf(h), value: unknown = { ...structuredClone(translationFixture.revisionResponse), unitId: target.unitId, locale: target.locale,
    revisionId: target.revisionId, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId, text: h.view.rows[0].output?.text,
    originKind: "ai", attemptId: target.attemptId, itemId: target.itemId, resultId: target.resultId, candidateDecision: null };
  if (!validateResponseRevision(value)) throw new Error("Invalid synthetic AI revision"); return value;
}
beforeEach(() => { invoke.mockReset(); });
afterEach(() => { expect(invoke.mock.calls.every(([command]) => command === "read_ai_translation" || command === "read_translation_revision")).toBe(true); });

describe("conversation run result reads", () => {
  it("reads the complete historical start even when the current lease and plan attempt are newer", async () => {
    const h = fixture(); invoke.mockResolvedValueOnce(h.view);
    const recorded = h.run.lastStart; if (!recorded) throw new Error("Recorded start fixture required");
    expect(h.run.lease.generation).toBe("5"); expect(h.start.expectedGeneration).toBe("3"); expect(h.plan.attemptId).not.toBe(h.start.attemptId);
    expect(await readConversationRunResults(h.context, h.link, h.plan, recorded)).toEqual(h.view);
    expect(h.view.rows.filter(row => row.savedRevisionId)).toHaveLength(1); expect(h.view.rows).toHaveLength(2);
    expect(invoke.mock.calls).toEqual([["read_ai_translation", { request: { ...h.context, attemptId: h.start.attemptId } }]]);
  });

  it("captures request identities, preview material and configuration before an asynchronous read", async () => {
    const h = fixture(), frozen = structuredClone(h); let answer!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = readConversationRunResults(h.context, h.link, h.plan, h.start);
    h.context.projectId = id(48004); h.context.sessionToken = "another-fixture-session";
    h.link.planId = id(48005); h.link.planDigest = "f".repeat(64); h.start.taskId = id(48006); h.start.attemptId = id(48007); h.start.expectedGeneration = "5";
    h.plan.scope[0].sourceRevisionId = id(48008);
    if (!h.plan.preview) throw new Error("Preview fixture required");
    h.plan.preview.items[0].sourceText = "Changed after reading"; h.plan.preview.config.model = "another-model"; h.plan.preview.recipe = "another-recipe";
    answer(frozen.view); expect(await reading).toEqual(frozen.view);
    expect(invoke.mock.calls).toEqual([["read_ai_translation", { request: { ...frozen.context, attemptId: frozen.start.attemptId } }]]);
  });

  it("does not retarget a delayed result to caller metadata changed after the read began", async () => {
    const h = fixture(); let answer!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = readConversationRunResults(h.context, h.link, h.plan, h.start);
    h.start.expectedGeneration = "5"; h.view.planGeneration = "5";
    answer(h.view); await expect(reading).rejects.toThrow("recorded start"); expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects an unrelated project, plan, digest, start or unsupported captured scope before IPC", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.context.projectId = id(48004); }, h => { h.plan.planId = id(48005); },
      h => { h.link.planDigest = "f".repeat(64); }, h => { h.start.projectId = id(48004); }, h => { h.start.planId = id(48005); },
      h => { h.plan.preview = null; }, h => { h.plan.scope = []; }, h => { h.plan.scope = Array.from({ length: 101 }, () => structuredClone(h.plan.scope[0])); }];
    for (const change of changes) {
      const h = fixture(); change(h);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow("result scope");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("binds result plan generation, task, attempt and recovery identity to the recorded start", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.view.planId = id(48005); }, h => { h.view.planGeneration = "5"; },
      h => { h.view.detail.taskId = id(48006); }, h => { h.view.detail.attemptId = id(48007); }, h => { h.view.detail.recovery.attemptId = id(48007); }];
    for (const change of changes) {
      const h = fixture(); change(h); expect(validateResponseView(h.view)).toBe(true); invoke.mockResolvedValueOnce(h.view);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow();
    }
    expect(invoke).toHaveBeenCalledTimes(changes.length);
  });

  it("compares the full captured recipe, configuration and source material rather than only unit identities", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.view.recipe = "another-recipe"; }, h => { h.view.config.model = "another-model"; },
      h => { h.view.rows[0].item.sourceText = "Another captured source"; }, h => { h.view.rows[0].item.sourceRevisionId = id(48008); },
      h => { h.view.rows[0].item.terms[0].target = "Another term"; }, h => { h.view.rows[0].item.omissions.push("Another omission"); }];
    for (const change of changes) {
      const h = fixture(); change(h); expect(validateResponseView(h.view)).toBe(true); invoke.mockResolvedValueOnce(h.view);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow("recorded start");
    }
  });

  it("rejects duplicate units, outside units and duplicate detail identities despite matching row counts", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.view.rows[1].item = structuredClone(h.view.rows[0].item);
      if (!h.view.rows[1].output) throw new Error("Output fixture required"); h.view.rows[1].output.unitId = h.view.rows[0].item.unitId; },
    h => { h.view.rows[1].item.unitId = id(48009); if (!h.view.rows[1].output) throw new Error("Output fixture required"); h.view.rows[1].output.unitId = id(48009); },
    h => { h.view.detail.items[1].status.itemId = h.view.detail.items[0].status.itemId; }];
    for (const change of changes) {
      const h = fixture(); change(h); expect(validateResponseView(h.view)).toBe(true); invoke.mockResolvedValueOnce(h.view);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow("recorded start");
    }
  });

  it("requires complete rows, detail items, progress and matching result identities", async () => {
    const changes: ((h: Fixture) => void)[] = [h => { h.view.rows.pop(); }, h => { h.view.detail.items.pop(); },
      h => { h.view.detail.progress.total = 3; }, h => { h.view.detail.progress.queued = 1; }, h => { h.view.detail.progress.adopted = 3; },
      h => { h.view.detail.items[0].resultId = id(48010); }];
    for (const change of changes) {
      const h = fixture(); change(h); expect(validateResponseView(h.view)).toBe(true); invoke.mockResolvedValueOnce(h.view);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow("recorded start");
    }
  });

  it("binds a displayed candidate decision to the saved candidate and its source", async () => {
    const h = fixture(), row = h.view.rows[0];
    if (!row.savedRevisionId) throw new Error("Saved candidate fixture required");
    // Decisions record their current source snapshot; unchanged source revisions can span snapshots.
    row.candidateDecision = { sourceSnapshotId: id(48022), request: { actionId: id(48020), actor: "Reviewer", disposition: "rejected",
      expectedDecisionId: null, expectedSelectionId: null, locale: row.item.targetLocale, projectId: h.context.projectId, reason: "Keep the original tone",
      revisionId: row.savedRevisionId, sourceRevisionId: row.item.sourceRevisionId, unitId: row.item.unitId } };
    expect(validateResponseView(h.view)).toBe(true); invoke.mockResolvedValueOnce(h.view);
    expect((await readConversationRunResults(h.context, h.link, h.plan, h.start)).rows[0].candidateDecision).toEqual(row.candidateDecision);
    for (const field of ["projectId", "unitId", "locale", "sourceRevisionId", "revisionId"] as const) {
      const invalid = structuredClone(h.view), decision = invalid.rows[0].candidateDecision;
      if (!decision) throw new Error("Candidate decision fixture required");
      decision.request[field] = field === "locale" ? "ja-JP" : id(48021);
      expect(validateResponseView(invalid)).toBe(true); invoke.mockResolvedValueOnce(invalid);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow("recorded start");
    }
  });

  it("reads the complete 100-entry planning bound with one original AI read", async () => {
    const h = fixture(100); invoke.mockResolvedValueOnce(h.view);
    expect((await readConversationRunResults(h.context, h.link, h.plan, h.start)).rows).toHaveLength(100);
    expect(invoke.mock.calls).toEqual([["read_ai_translation", { request: { ...h.context, attemptId: h.start.attemptId } }]]);
  });

  it("refuses an incomplete first hundred rather than returning a silently truncated result", async () => {
    for (const incompleteCursor of [false, true]) {
      const h = fixture(100);
      if (incompleteCursor) h.view.detail.nextOffset = 100; else h.view.rows.pop();
      expect(validateResponseView(h.view)).toBe(true); invoke.mockResolvedValueOnce(h.view);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow("recorded start");
    }
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "invalid"] as const)("retains a complete %s row with null output without hiding another saved result", async validation => {
    const h = fixture(); h.view.rows[1].output = null; h.view.detail.items[1].status.validation = validation;
    expect(validateResponseView(h.view)).toBe(true); invoke.mockResolvedValueOnce(h.view);
    const read = await readConversationRunResults(h.context, h.link, h.plan, h.start);
    expect(read.rows[1].output).toBeNull(); expect(read.detail.items[1].status.validation).toBe(validation);
    expect(conversationRunCandidateTarget(h.link, h.start, read.rows[0])?.revisionId).toBe(h.view.rows[0].savedRevisionId);
    expect(conversationRunCandidateTarget(h.link, h.start, read.rows[1])).toBeNull();
  });

  it("rejects exposed output whose detail does not report successful valid execution", async () => {
    for (const validation of ["pending", "invalid"] as const) {
      const h = fixture(); h.view.detail.items[0].status.validation = validation; invoke.mockResolvedValueOnce(h.view);
      await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toThrow("recorded start");
    }
  });
});

describe("conversation saved candidate reads", () => {
  it("captures the exact start and saved empty-string result without creating another action identity", async () => {
    const h = fixture(), identity = vi.spyOn(crypto, "randomUUID"), expected = { projectId: h.context.projectId, conversationId: h.link.conversationId,
      planId: h.link.planId, planDigest: h.link.planDigest, actionId: h.start.actionId, generation: h.start.expectedGeneration, taskId: h.start.taskId, attemptId: h.start.attemptId,
      unitId: h.view.rows[0].item.unitId, locale: h.view.rows[0].item.targetLocale, sourceRevisionId: h.view.rows[0].item.sourceRevisionId,
      sourceSnapshotId: h.view.rows[0].item.sourceSnapshotId, itemId: h.view.rows[0].itemId, resultId: h.view.rows[0].resultId, revisionId: h.view.rows[0].savedRevisionId };
    const target = targetOf(h); expect(h.view.rows[0].output?.text).toBe(""); expect(target).toEqual(expected); expect(target.actionId).not.toBe(h.link.actionId);
    h.start.actionId = id(48011); h.start.taskId = id(48012); h.view.rows[0].item.sourceRevisionId = id(48013); h.link.planDigest = "f".repeat(64);
    expect(target).toEqual(expected); expect(identity).not.toHaveBeenCalled(); identity.mockRestore(); expect(invoke).not.toHaveBeenCalled();
  });

  it("does not invent candidate navigation for unsaved, missing-output or unrelated start rows", () => {
    const h = fixture(), row = h.view.rows[0];
    for (const incomplete of [{ ...row, savedRevisionId: null }, { ...row, resultId: null }, { ...row, output: null }])
      expect(conversationRunCandidateTarget(h.link, h.start, incomplete)).toBeNull();
    expect(conversationRunCandidateTarget(h.link, { ...h.start, projectId: id(48004) }, row)).toBeNull();
    expect(conversationRunCandidateTarget(h.link, { ...h.start, planId: id(48005) }, row)).toBeNull(); expect(invoke).not.toHaveBeenCalled();
  });

  it("reads the exact AI revision with its empty text and an ordinal beyond JavaScript integer precision", async () => {
    const h = fixture(), target = targetOf(h), revision = revisionOf(h); invoke.mockResolvedValueOnce(revision);
    expect(await resolveConversationRunCandidate(h.context, target)).toEqual(revision);
    expect(revision.text).toBe(""); expect(revision.ordinal).toBe("9007199254740993");
    expect(invoke.mock.calls).toEqual([["read_translation_revision", { request: { ...h.context, unitId: target.unitId, locale: target.locale, revisionId: target.revisionId } }]]);
  });

  it("retains the captured target and request when navigation metadata changes during an exact revision read", async () => {
    const h = fixture(), target = targetOf(h), frozen = structuredClone({ context: h.context, target }), revision = revisionOf(h);
    let answer!: (value: unknown) => void; invoke.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const reading = resolveConversationRunCandidate(h.context, target);
    h.context.projectId = id(48004); h.context.sessionToken = "another-fixture-session";
    target.unitId = id(48014); target.revisionId = id(48015); target.attemptId = id(48016); target.itemId = id(48017); target.resultId = id(48018); target.sourceRevisionId = id(48019);
    answer(revision); expect(await reading).toEqual(revision);
    expect(invoke.mock.calls).toEqual([["read_translation_revision", { request: { ...frozen.context, unitId: frozen.target.unitId, locale: frozen.target.locale, revisionId: frozen.target.revisionId } }]]);
  });

  it("requires exact AI origin, source basis, result identities and a positive saved ordinal", async () => {
    const changes: ((revision: TranslationRevision) => void)[] = [revision => { revision.originKind = "manual"; }, revision => { revision.sourceSnapshotId = id(48020); },
      revision => { revision.sourceRevisionId = id(48019); }, revision => { revision.attemptId = id(48016); }, revision => { revision.itemId = id(48017); },
      revision => { revision.resultId = id(48018); }, revision => { revision.ordinal = "0"; }];
    for (const change of changes) {
      const h = fixture(), revision = revisionOf(h); change(revision); expect(validateResponseRevision(revision)).toBe(true); invoke.mockResolvedValueOnce(revision);
      await expect(resolveConversationRunCandidate(h.context, targetOf(h))).rejects.toThrow("does not match");
    }
  });

  it("uses the existing exact revision boundary to reject different unit, locale or revision responses", async () => {
    const changes: ((revision: TranslationRevision) => void)[] = [revision => { revision.unitId = id(48014); }, revision => { revision.locale = "ja"; }, revision => { revision.revisionId = id(48015); }];
    for (const change of changes) {
      const h = fixture(), revision = revisionOf(h); change(revision); expect(validateResponseRevision(revision)).toBe(true); invoke.mockResolvedValueOnce(revision);
      await expect(resolveConversationRunCandidate(h.context, targetOf(h))).rejects.toThrow("read_translation_revision");
    }
  });

  it("rejects another project's navigation target before reading any revision", async () => {
    const h = fixture(); await expect(resolveConversationRunCandidate({ ...h.context, projectId: id(48004) }, targetOf(h))).rejects.toThrow("another project");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves read failures without scanning, retrying, saving or starting a model request", async () => {
    const h = fixture(), resultFailure = new Error("Result read unavailable"), revisionFailure = new Error("Revision read unavailable");
    invoke.mockRejectedValueOnce(resultFailure);
    await expect(readConversationRunResults(h.context, h.link, h.plan, h.start)).rejects.toBe(resultFailure);
    invoke.mockRejectedValueOnce(revisionFailure); await expect(resolveConversationRunCandidate(h.context, targetOf(h))).rejects.toBe(revisionFailure);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_ai_translation", "read_translation_revision"]);
  });
});
