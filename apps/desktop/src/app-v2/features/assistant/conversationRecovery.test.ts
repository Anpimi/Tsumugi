import { describe, expect, it } from "vitest";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { teamRecoveryFixture, teamRecoveryPreviewFixture } from "../../../testSupport/teamRecoveryFixture";
import { validateRequestWorkPlanTeamRecoveryPrepare } from "../../../generated/ai.validators";
import { teamContext } from "../../../testSupport/teamDiscussionFixture";
import { conversationRecoveryProblem, initialConversationRecoveryDraft, initialConversationRecoveryState, newConversationRecoveryMember,
  recoveryBasisMatches, unchangedConversationRecoveryMember } from "./conversationRecovery";

function fixture() {
  const source = teamRecoveryFixture(), draft = initialConversationRecoveryDraft(source.status.plan, source.view, "9007199254740993");
  draft.instructions = "Preserve human {{literal}} 中文 instructions.";
  return { ...source, draft };
}
describe("conversation team recovery input", () => {
  it("retains exact original members and stable tool handles independently of the source read", () => {
    const h = fixture(), member = h.draft.members[0];
    expect(member).toBeDefined();
    if (!member) throw new Error("Synthetic member required");
    expect(h.draft.editSeq).toBe("9007199254740993");
    expect(member.toolHandles).toEqual(h.view.roster[0]?.toolHandles);
    expect(unchangedConversationRecoveryMember(member)).toBe(true);
    member.role = "A newer human role";
    expect(unchangedConversationRecoveryMember(member)).toBe(false);
    expect(h.view.roster[0]?.role).not.toBe(member.role);
    expect(member.original?.role).toBe(h.view.roster[0]?.role);
  });
  it("requires every unresolved original work reference and keeps input verbatim", () => {
    const h = fixture(), reference = { taskId: id(65000), attemptId: id(65001), inputDigest: "c".repeat(64) };
    h.state.state.unresolvedWork = [reference];
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view, h.state)).toBe("unresolved");
    h.draft.priorWork = [{ ...reference, inputDigest: "b".repeat(64) }];
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view, h.state)).toBe("unresolved");
    h.draft.priorWork = [structuredClone(reference)];
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view, h.state)).toBeNull();
    expect(h.draft.instructions).toBe("Preserve human {{literal}} 中文 instructions.");
  });
  it("rejects removed tools, stale original role versions, invalid scope and duplicate attachments", () => {
    const h = fixture(), member = h.draft.members[0];
    if (!member || !member.original) throw new Error("Synthetic original member required");
    member.toolHandles = ["removed-tool"];
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view)).toBe("scope");
    member.toolHandles = []; member.original.roleVersionId = id(65002);
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view)).toBe("members");
    member.original = structuredClone(h.view.roster[0] ?? null); member.unitIds = [id(65003)];
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view)).toBe("scope");
    member.unitIds = [...(h.view.roster[0]?.unitIds ?? [])]; h.draft.postIds = [id(65004), id(65004)];
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view)).toBe("work");
  });
  it("keeps the historical member ceiling and creates new member input without an old identity", () => {
    const h = fixture(), member = newConversationRecoveryMember(h.draft.nextKey, h.status.plan);
    if (!member) throw new Error("Synthetic new member required");
    expect(member.original).toBeNull(); expect(member.toolHandles).toEqual([]); expect(member.config.concurrency).toBe(1);
    h.draft.members.push(member); h.view.retiredMemberIds = Array.from({ length: 6 }, (_, index) => id(65010 + index));
    expect(conversationRecoveryProblem(h.draft, h.status.plan, h.view)).toBe("memberLimit");
    expect(initialConversationRecoveryState()).toMatchObject({ prepared: null, consent: false, receipt: null, preparedRequest: null });
  });
  it("requires the exact lease and effective team version for a prepared preview", () => {
    const h = fixture(), member = h.view.roster[0], unit = h.status.plan.scope[0];
    if (!member || !unit) throw new Error("Synthetic team and scope required");
    const request: unknown = { ...teamContext, preparationId: id(65020), recovery: { projectId: teamContext.projectId,
      planId: h.status.plan.planId, expectedLease: structuredClone(h.state.state.lease), expectedEffectiveVersion: structuredClone(h.state.state.effectiveVersion),
      members: structuredClone(h.view.roster), work: { workId: id(65021), memberId: member.memberId, kind: "translation", instructions: h.draft.instructions,
        postIds: [], priorWork: [], target: { unitId: unit.unitId, locale: h.status.plan.locale, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId } } } };
    if (!validateRequestWorkPlanTeamRecoveryPrepare(request)) throw new Error("Valid synthetic recovery preparation required");
    const prepared = teamRecoveryPreviewFixture(request, h);
    expect(recoveryBasisMatches(prepared, h.state, h.view)).toBe(true);
    expect(recoveryBasisMatches(prepared, { ...h.state, state: { ...h.state.state, lease: { ...h.state.state.lease, generation: "3" } } }, h.view)).toBe(false);
    const differentDigest = h.view.effectiveVersion.digest === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    expect(recoveryBasisMatches(prepared, h.state, { ...h.view, effectiveVersion: { ...h.view.effectiveVersion, digest: differentDigest } })).toBe(false);
  });
});
