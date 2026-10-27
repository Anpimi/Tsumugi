import { expect, it, vi } from "vitest";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import type { ReviewEntryDecisionPayload, RetainedReviewPendingPayload } from "./reviewTypes";

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
  const input = { kind: "retained-review-pending", pending: { kind: "decision", submittedSeq: 0,
    session: { projectId: scope.projectId, sessionToken: scope.sessionToken }, request: { projectId: scope.projectId, unitId: fixtureIdentity(9911),
      locale: "zh-CN", actionId: fixtureIdentity(9916), expectedBasis: "a".repeat(64), expectedDecisionId: null, actor: "Reviewer A", reason: "Reason A", kind: "request-changes" } } } satisfies RetainedReviewPendingPayload;
  const remove = commands.register({ id: "review.recover-entry-check", scope, nameKey: "workbenchV2.reviewRecoveryCheck", category: "review", binding: null,
    confirmation: "none", risk: "reads-review", payloadKind: "retained-review-pending", availability: value => ({ enabled: value?.pending === input.pending }), handler });
  const dispatch = (value: unknown) => Reflect.apply(commands.dispatch, commands, ["review.recover-entry-check", scope, value]);
  expect(dispatch({ ...input, pending: null })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, session: { ...input.pending.session, sessionToken: "another-session" } } })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, request: { ...input.pending.request, projectId: fixtureIdentity(9917) } } })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, request: { ...input.pending.request, reason: "Replaced input B" } } })).toBe(false);
  expect(dispatch(input)).toBe(true); expect(handler).toHaveBeenCalledExactlyOnceWith(input); remove(); expect(dispatch(input)).toBe(false);
});

it("keeps original checker requests and grants in their own session for global recovery", () => {
  const commands = new WorkbenchCommands(), handler = vi.fn();
  const request = { projectId: scope.projectId, sessionToken: scope.sessionToken, actionId: fixtureIdentity(9916),
    unitId: fixtureIdentity(9911), locale: "zh-CN", expectedBasis: "a".repeat(64), advisoryChecks: [] };
  const input = { kind: "retained-review-pending", pending: { kind: "check", request, submittedSeq: null, previousRunId: null,
    basisEvidence: { sourceSnapshotId: fixtureIdentity(9912), sourceRevisionId: fixtureIdentity(9913), selectionId: null, revisionId: null, contextRevisionId: null, termRevisionIds: [] },
    executions: [{ projectId: scope.projectId, sessionToken: scope.sessionToken, attemptId: fixtureIdentity(9917), grantId: fixtureIdentity(9918),
      inputDigest: "b".repeat(64), expiresAtMs: "1793130000000", unsandboxedExecution: true }] } } satisfies RetainedReviewPendingPayload;
  const metadata = { scope, nameKey: "workbenchV2.reviewRecoveryCheck" as const, category: "review" as const, binding: null, confirmation: "none" as const,
    risk: "reads-review" as const, payloadKind: "retained-review-pending" as const, availability: (value: RetainedReviewPendingPayload | undefined) => ({ enabled: value?.pending === input.pending }), handler };
  commands.register({ ...metadata, id: "review.recover-entry-check" });
  commands.register({ ...metadata, id: "review.recover-entry-cancel" });
  const dispatch = (value: unknown) => Reflect.apply(commands.dispatch, commands, ["review.recover-entry-check", scope, value]);
  expect(dispatch({ ...input, pending: null })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, request: { ...request, sessionToken: "another-session" } } })).toBe(false);
  expect(dispatch({ ...input, pending: { ...input.pending, executions: [] } })).toBe(false);
  expect(dispatch(input)).toBe(true); expect(handler).toHaveBeenCalledExactlyOnceWith(input);
  expect(commands.dispatch("review.recover-entry-cancel", scope, input)).toBe(true);
});
