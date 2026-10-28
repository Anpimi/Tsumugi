import { describe, expect, it, vi } from "vitest";
import translationWire from "../../../../test/fixtures/translation-commands.json";
import type { DecisionItem } from "../../../decisionCommands";
import type { ConversationDraftHead, ConversationDraftPending } from "../../../conversationDraftCommands";
import type { DraftReadView } from "../../../draftCommands";
import { validateResponseRevision } from "../../../generated/translation.validators";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { reviewDiagnosticFixture } from "../../../testSupport/reviewDiagnosticFixture";
import { reviewFindingViewFixture, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { conversationProposalFixture } from "../../../testSupport/conversationProposalFixture";
import type { TranslationRevision } from "../../../translationCommands";
import { DecisionNavigationChanged, resolveDecisionNavigation, type DecisionNavigationPorts } from "./decisionNavigation";

const ctx = { projectId: id(60000), sessionToken: "synthetic-decision-session" };
function ports(overrides: Partial<DecisionNavigationPorts> = {}): DecisionNavigationPorts {
  const unexpected = vi.fn(async () => { throw new Error("Unexpected reader"); });
  return { revision: unexpected, target: unexpected, findings: unexpected, draft: unexpected, conversationDraft: unexpected, proposal: unexpected, knowledgeDecision: unexpected, ...overrides };
}
function item(action: DecisionItem["action"], targets: DecisionItem["targets"], locale: string | null = "zh-CN"): DecisionItem {
  const source = action.kind === "compare-candidate" ? "translation-candidate" : action.kind === "review-translation" ? "human-review"
    : action.kind === "review-finding" ? "review-finding" : action.kind === "inspect-local-request" ? "local-action-recovery" : "delivery-blocker";
  return { decisionId: `${source}:synthetic`, source, state: "pending", basis: "b".repeat(64), targets, targetsComplete: true, locale,
    action, sourceActionId: action.kind === "inspect-local-request" ? action.reference.action.actionId : null, evidence: null };
}
function revision(): TranslationRevision {
  const value: unknown = structuredClone(translationWire.revisionResponse);
  if (!validateResponseRevision(value)) throw new Error("Synthetic revision fixture required");
  return { ...value, ordinal: "9007199254740997" };
}
function candidate(value = revision()) {
  return item({ kind: "compare-candidate", unitId: value.unitId, revisionId: value.revisionId,
    sourceSnapshotId: value.sourceSnapshotId, sourceRevisionId: value.sourceRevisionId }, [{ kind: "entry", unitId: value.unitId }], value.locale);
}

it("opens the exact proposal group only while that original revision remains the latest", async () => {
  const original = conversationProposalFixture({ projectId: ctx.projectId, conversationId: id(60200) }).revision;
  original.content.questions = ["Who is the intended audience?"];
  const action = { kind: "clarify-conversation-proposal" as const, conversationId: original.conversationId,
    proposalId: original.proposalId, revisionId: original.revisionId };
  const row = item(action, [{ kind: "conversation-proposal", conversationId: action.conversationId, proposalId: action.proposalId }], null);
  const proposal = vi.fn(async (_request: Parameters<DecisionNavigationPorts["proposal"]>[0]) => original);
  expect(await resolveDecisionNavigation(ctx, row, () => true, ports({ proposal }))).toEqual({ kind: "conversation-proposal",
    conversationId: action.conversationId, proposalId: action.proposalId, revisionId: action.revisionId });
  expect(proposal.mock.calls.map(call => call[0])).toEqual([
    { ...ctx, conversationId: action.conversationId, proposalId: action.proposalId, revisionId: action.revisionId },
    { ...ctx, conversationId: action.conversationId, proposalId: action.proposalId, revisionId: null },
  ]);
  proposal.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, revisionId: id(60201) });
  await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ proposal }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
  let current = true;
  await expect(resolveDecisionNavigation(ctx, row, () => current, ports({ proposal: async () => { current = false; return original; } })))
    .rejects.toBeInstanceOf(DecisionNavigationChanged);
});

it("opens only the exact undecided knowledge item and rejects a changed head or recorded decision", async () => {
  const fixture = conversationProposalFixture({ projectId: ctx.projectId, conversationId: id(60210) }), original = fixture.revision;
  original.content = { kind: "knowledge-proposal", summary: "Character knowledge", questions: [], entries: [{ kind: "character", name: "Mara", text: "Keep the original voice", unitIds: [fixture.unitIds[0]] }] };
  const reference = { projectId: ctx.projectId, conversationId: original.conversationId, proposalId: original.proposalId, revisionId: original.revisionId };
  const row: DecisionItem = { ...item({ kind: "review-knowledge-proposal", proposal: reference, entryIndex: 0 }, [{ kind: "conversation-proposal", conversationId: original.conversationId, proposalId: original.proposalId }]),
    source: "resource-proposal", decisionId: "resource-proposal:synthetic-knowledge" };
  const proposal = vi.fn<DecisionNavigationPorts["proposal"]>(async () => original), knowledgeDecision = vi.fn<DecisionNavigationPorts["knowledgeDecision"]>(async () => null);
  expect(await resolveDecisionNavigation(ctx, row, () => true, ports({ proposal, knowledgeDecision }))).toEqual({ kind: "knowledge-proposal", proposal: reference, entryIndex: 0 });
  proposal.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, revisionId: id(60211) });
  await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ proposal, knowledgeDecision }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
  knowledgeDecision.mockResolvedValueOnce({ actionId: id(60212), proposal: reference, entryIndex: 0, decision: "keep", actor: "Human reviewer", reason: "Keep current resources", resource: null });
  await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ proposal, knowledgeDecision }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
});
function translationLocal() {
  const key = { projectId: ctx.projectId, unitId: id(60001), locale: "zh-CN" };
  const pending = { kind: "save" as const, submittedSeq: "4", request: { ...key, actionId: id(60002), sourceRevisionId: id(60003), expectedSelectionId: null, text: "Submitted A" } };
  const view: DraftReadView = { head: { key, revision: "9", writerId: id(60004), value: { text: "New input B", editSeq: "8", pending,
    basis: { sourceRevisionId: pending.request.sourceRevisionId, selectionId: null, revisionId: null, text: null } } }, current: { kind: "unavailable", reason: "source-missing" } };
  const row = item({ kind: "inspect-local-request", reference: { requestKind: "save", action: {
    key: { kind: "translation", unitId: key.unitId, locale: key.locale }, slot: "primary", actionId: pending.request.actionId, submittedSeq: pending.submittedSeq,
  } } }, [{ kind: "entry", unitId: key.unitId }]);
  return { key, pending, view, row };
}
function conversationLocal() {
  const key = { projectId: ctx.projectId, conversationId: id(60010) }, planId = id(60011);
  const pending = { kind: "work-plan-start", conversationId: key.conversationId, expectedAttemptId: id(60012), submittedSeq: "3",
    request: { projectId: ctx.projectId, planId, actionId: id(60013), expectedGeneration: "2" } } satisfies ConversationDraftPending;
  const revocation = { submittedSeq: "5", request: { projectId: ctx.projectId, planId, actionId: id(60014), expectedGeneration: "2", command: "stop" as const } };
  const head: ConversationDraftHead = { key, revision: "10", writerId: id(60015), value: { text: "Later conversation input B", editSeq: "8", pending, revocations: [revocation] } };
  function row(slot: "primary" | "revocation") {
    const selected = slot === "primary" ? pending : revocation;
    return item({ kind: "inspect-local-request", reference: { requestKind: slot === "primary" ? "work-plan-start" : "work-plan-control", action: {
      key: { kind: "conversation", conversationId: key.conversationId }, slot, actionId: selected.request.actionId, submittedSeq: selected.submittedSeq,
    } } }, [{ kind: "conversation", conversationId: key.conversationId }, { kind: "plan", planId }], null);
  }
  return { key, planId, pending, revocation, head, row };
}

describe("decision navigation", () => {
  it("uses the exact candidate revision ordinal without losing decimal precision", async () => {
    const value = revision(), read = vi.fn(async () => value);
    await expect(resolveDecisionNavigation(ctx, candidate(value), () => true, ports({ revision: read }))).resolves.toEqual({
      kind: "candidate", unitId: value.unitId, locale: value.locale, revisionId: value.revisionId, afterOrdinal: "9007199254740996",
    });
    expect(read).toHaveBeenCalledWith({ ...ctx, unitId: value.unitId, locale: value.locale, revisionId: value.revisionId });
  });

  it.each(["unitId", "locale", "revisionId", "sourceRevisionId", "sourceSnapshotId"] as const)("rejects a candidate with changed %s", async field => {
    const value = revision(), other = { ...value, [field]: field === "locale" ? "fr" : id(60999) };
    await expect(resolveDecisionNavigation(ctx, candidate(value), () => true, ports({ revision: async () => other }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
  });

  it("opens human review only for the original selected revision", async () => {
    const target = reviewTargetFixture(), row = item({ kind: "review-translation", unitId: target.unitId,
      revisionId: target.revisionId!, selectionId: target.selectionId! }, [{ kind: "entry", unitId: target.unitId }]);
    await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ target: async () => target }))).resolves.toEqual({ kind: "review", unitId: target.unitId, locale: target.locale });
    const changed = reviewTargetFixture({ ...target, selectionId: id(60020), basisEvidence: { ...target.basisEvidence, selectionId: id(60020) } });
    await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ target: async () => changed }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
  });

  it("locates an exact run and issue on a later finding page", async () => {
    const h = reviewDiagnosticFixture(), base = reviewFindingViewFixture(h.target);
    const advisory = { runId: h.run.runId, purpose: "qa" as const, aiOrigin: null, finding: h.finding, requirement: h.requirement, decision: null };
    const read = vi.fn<DecisionNavigationPorts["findings"]>().mockResolvedValueOnce({ ...base, nextOffset: 20,
      findings: [{ ...advisory, finding: { ...h.finding, issueId: "other-issue" } }] }).mockResolvedValueOnce({ ...base, findings: [advisory] });
    const row = item({ kind: "review-finding", unitId: h.target.unitId, runId: h.run.runId, issueId: h.finding.issueId }, [{ kind: "entry", unitId: h.target.unitId }]);
    await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ target: async () => h.target, findings: read }))).resolves.toEqual({
      kind: "finding", unitId: h.target.unitId, locale: h.target.locale, runId: h.run.runId, issueId: h.finding.issueId, offset: 20,
    });
    expect(read.mock.calls.map(([request]) => request.offset)).toEqual([0, 20]);
  });

  it("rejects missing findings and a source selection changed during pagination", async () => {
    const h = reviewDiagnosticFixture(), base = reviewFindingViewFixture(h.target);
    const row = item({ kind: "review-finding", unitId: h.target.unitId, runId: h.run.runId, issueId: h.finding.issueId }, [{ kind: "entry", unitId: h.target.unitId }]);
    await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ target: async () => h.target, findings: async () => base }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
    const readTarget = vi.fn<DecisionNavigationPorts["target"]>().mockResolvedValueOnce(h.target).mockResolvedValueOnce({ ...h.target,
      selectionId: id(60021), basisEvidence: { ...h.target.basisEvidence, selectionId: id(60021) } });
    await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ target: readTarget, findings: async () => ({ ...base,
      findings: [{ runId: h.run.runId, purpose: "qa", aiOrigin: null, finding: h.finding, requirement: h.requirement, decision: null }] }) }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
  });

  it("keeps an exact unresolved historical repair reachable after its source basis changes", async () => {
    const h = reviewDiagnosticFixture(), runId = id(60030), issueId = h.finding.issueId;
    const page = { ...reviewFindingViewFixture(h.target), repairs: [{ status: "awaiting-current-recheck" as const, recheckRunId: null,
      decision: { decisionId: id(60031), purpose: "qa" as const, aiOrigin: null, finding: h.finding, requirement: h.requirement,
        createdAt: "2026-10-29T00:00:00Z", basisEvidence: { ...h.target.basisEvidence, sourceRevisionId: id(60032) },
        request: { projectId: ctx.projectId, actionId: id(60033), unitId: h.target.unitId, locale: h.target.locale, runId, issueId, expectedBasis: "c".repeat(64),
          expectedDecisionId: null, actor: "Synthetic reviewer", reason: "Check after editing", disposition: "repair-requested" as const } } }] };
    page.history = page.repairs.map(repair => repair.decision);
    const row = item({ kind: "review-finding", unitId: h.target.unitId, runId, issueId }, [{ kind: "entry", unitId: h.target.unitId }]);
    row.sourceActionId = id(60033);
    await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ target: async () => h.target, findings: async () => page }))).resolves.toEqual({
      kind: "finding", unitId: h.target.unitId, locale: h.target.locale, runId, issueId, offset: 0,
    });
  });

  it("opens the original translation request while preserving later input B", async () => {
    const h = translationLocal();
    await expect(resolveDecisionNavigation(ctx, h.row, () => true, ports({ draft: async () => h.view }))).resolves.toEqual({ kind: "translation-request", key: h.key });
    expect(h.view.head.value?.text).toBe("New input B");
  });

  it.each(["kind", "action", "sequence", "project"])("rejects a changed local translation %s", async change => {
    const h = translationLocal();
    if (change === "kind") h.view.head.value!.pending = { kind: "selection", submittedSeq: h.pending.submittedSeq, text: "Submitted A",
      request: { ...h.key, actionId: h.pending.request.actionId, sourceRevisionId: h.pending.request.sourceRevisionId, expectedSelectionId: null, revisionId: id(60022) } };
    if (change === "action") h.pending.request.actionId = id(60023);
    if (change === "sequence") h.pending.submittedSeq = "6";
    if (change === "project") h.view.head.key.projectId = id(60024);
    await expect(resolveDecisionNavigation(ctx, h.row, () => true, ports({ draft: async () => h.view }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
  });

  it("distinguishes the conversation primary request from the exact revocation and plan", async () => {
    const h = conversationLocal(), readers = ports({ conversationDraft: async () => h.head });
    await expect(resolveDecisionNavigation(ctx, h.row("primary"), () => true, readers)).resolves.toEqual({ kind: "conversation-request", conversationId: h.key.conversationId, slot: "primary", actionId: h.pending.request.actionId });
    await expect(resolveDecisionNavigation(ctx, h.row("revocation"), () => true, readers)).resolves.toEqual({ kind: "conversation-request", conversationId: h.key.conversationId, slot: "revocation", actionId: h.revocation.request.actionId });
    const wrongPlan = h.row("revocation"); wrongPlan.targets = [{ kind: "conversation", conversationId: h.key.conversationId }, { kind: "plan", planId: id(60025) }];
    await expect(resolveDecisionNavigation(ctx, wrongPlan, () => true, readers)).rejects.toBeInstanceOf(DecisionNavigationChanged);
    const removed = h.row("revocation"); h.head.value!.revocations = [];
    await expect(resolveDecisionNavigation(ctx, removed, () => true, readers)).rejects.toBeInstanceOf(DecisionNavigationChanged);
  });

  it("discards late responses and preserves reader errors without interpreting messages", async () => {
    const value = revision(), row = candidate(value);
    let live = true, finish!: (value: TranslationRevision) => void;
    const waiting = new Promise<TranslationRevision>(resolve => { finish = resolve; });
    const result = resolveDecisionNavigation(ctx, row, () => live, ports({ revision: () => waiting }));
    live = false; finish(value);
    await expect(result).rejects.toBeInstanceOf(DecisionNavigationChanged);
    const untouched = vi.fn<DecisionNavigationPorts["revision"]>();
    await expect(resolveDecisionNavigation(ctx, row, () => false, ports({ revision: untouched }))).rejects.toBeInstanceOf(DecisionNavigationChanged);
    expect(untouched).not.toHaveBeenCalled();
    const failure = new Error("Decision navigation target changed");
    await expect(resolveDecisionNavigation(ctx, row, () => true, ports({ revision: async () => { throw failure; } }))).rejects.toBe(failure);
  });
});
