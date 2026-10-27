import { expect, it, vi } from "vitest";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import type { ReviewEntryDecisionPayload, ReviewEntryPendingPayload } from "./reviewTypes";

const scope = { projectId: fixtureIdentity(9910), sessionToken: "review-registry-session", area: "translation" as const };

it("binds the review decision to its complete target, audit, and command action", () => {
  const commands = new WorkbenchCommands(), handler = vi.fn();
  const input: ReviewEntryDecisionPayload = { kind: "entry-review-decision", decision: "approve", unitId: fixtureIdentity(9911), locale: "zh-CN",
    basis: "a".repeat(64), sourceSnapshotId: fixtureIdentity(9912), sourceRevisionId: fixtureIdentity(9913), selectionId: fixtureIdentity(9914),
    revisionId: fixtureIdentity(9915), expectedDecisionId: null, actor: "Human reviewer", reason: "", editSeq: 0 };
  const remove = commands.register({ id: "review.entry-approve", scope, nameKey: "workbenchV2.entryReviewApprove", category: "review", binding: null,
    confirmation: "none", risk: "writes-review", payloadKind: "entry-review-decision", availability: () => ({ enabled: true }), handler });
  const dispatch = (value: unknown) => Reflect.apply(commands.dispatch, commands, ["review.entry-approve", scope, value]);
  for (const change of [{ decision: "request-changes" }, { actor: " " }, { editSeq: -1 }, { editSeq: "1" }, { sourceRevisionId: "" },
    { selectionId: null }, { revisionId: null }, { expectedDecisionId: undefined }]) expect(dispatch({ ...input, ...change })).toBe(false);
  expect(dispatch(input)).toBe(true); expect(handler).toHaveBeenCalledExactlyOnceWith(input); remove(); expect(dispatch(input)).toBe(false);
});

it("accepts only the original human request in its own project session for recovery", () => {
  const commands = new WorkbenchCommands(), handler = vi.fn();
  const input: ReviewEntryPendingPayload = { kind: "entry-review-pending", pending: { kind: "decision", submittedSeq: 0,
    session: { projectId: scope.projectId, sessionToken: scope.sessionToken }, request: { projectId: scope.projectId, unitId: fixtureIdentity(9911),
      locale: "zh-CN", actionId: fixtureIdentity(9916), expectedBasis: "a".repeat(64), expectedDecisionId: null, actor: "Reviewer A", reason: "Reason A", kind: "request-changes" } } };
  const remove = commands.register({ id: "review.recover-entry-check", scope, nameKey: "workbenchV2.reviewRecoveryCheck", category: "review", binding: null,
    confirmation: "none", risk: "reads-review", payloadKind: "entry-review-pending", availability: value => ({ enabled: value?.pending === input.pending }), handler });
  const dispatch = (value: unknown) => Reflect.apply(commands.dispatch, commands, ["review.recover-entry-check", scope, value]);
  expect(dispatch({ ...input, pending: null })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, session: { ...input.pending.session, sessionToken: "another-session" } } })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, request: { ...input.pending.request, projectId: fixtureIdentity(9917) } } })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, request: { ...input.pending.request, reason: "Replaced input B" } } })).toBe(false);
  expect(dispatch(input)).toBe(true); expect(handler).toHaveBeenCalledExactlyOnceWith(input); remove(); expect(dispatch(input)).toBe(false);
});
