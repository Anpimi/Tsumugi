import { expect, it, vi } from "vitest";
import { WorkbenchCommands, type TranslationStageCommandPayload, type TranslationDraftCandidateCommandPayload } from "../../../workbenchCommands";

const scope = { projectId: "project", sessionToken: "session", area: "translation" as const };
const metadata = { nameKey: "translation.addCandidate" as const, category: "translation" as const, scope, binding: null, risk: "writes-translation" as const, confirmation: "none" as const };
const payload: TranslationStageCommandPayload = { kind: "translation-stage", unitId: "unit", locale: "zh-CN", sourceSnapshotId: "snapshot", sourceRevisionId: "source",
  expectedSelectionId: null, expectedRevisionId: null, draftEditSeq: "9007199254740993123456789", draftBasis: { sourceRevisionId: "source", selectionId: null, revisionId: null, text: null },
  evidence: { kind: "revision", revisionId: "candidate", actionId: "action", ordinal: "9007199254740993123456788", sourceRevisionId: "source", sourceSnapshotId: "snapshot", decisionId: null } };

it("preserves decimal string draft sequences and validates the full stage target before invoking its scoped owner", () => {
  const commands = new WorkbenchCommands(), handler = vi.fn();
  const remove = commands.register({ ...metadata, id: "translation.stage-candidate", payloadKind: "translation-stage", availability: () => ({ enabled: true }), handler });
  const dispatch = (input: unknown, currentScope = scope) => Reflect.apply(commands.dispatch, commands, ["translation.stage-candidate", currentScope, input]);
  for (const invalid of [null, undefined, { ...payload, draftEditSeq: 9007199254740992 }, { ...payload, draftEditSeq: "01" },
    { ...payload, expectedRevisionId: undefined }, { ...payload, draftBasis: null }, { ...payload, draftBasis: { ...payload.draftBasis, sourceRevisionId: "other" } },
    { ...payload, draftBasis: { ...payload.draftBasis, text: "Invalid selection association" } }, { ...payload, evidence: null },
    { ...payload, evidence: { ...payload.evidence, ordinal: "0" } }, { ...payload, evidence: { ...payload.evidence, actionId: "" } },
    { ...payload, evidence: { kind: "tm", donorUnitId: "donor", translationRevisionId: "", sourceRevisionId: "source" } }]) expect(dispatch(invalid)).toBe(false);
  expect(dispatch(payload, { ...scope, sessionToken: "retired" })).toBe(false);
  expect(commands.describe("translation.stage-candidate", scope, payload)?.availability.enabled).toBe(true);
  expect(handler).not.toHaveBeenCalled(); expect(dispatch(payload)).toBe(true);
  expect(handler).toHaveBeenCalledExactlyOnceWith(payload);
  remove(); expect(dispatch(payload)).toBe(false);
});

it("keeps human audit sequence numeric while validating its independent string draft sequence and original candidate decision", () => {
  const commands = new WorkbenchCommands(), handler = vi.fn();
  const decision: TranslationDraftCandidateCommandPayload = { ...payload, kind: "translation-draft-candidate", expectedDecisionId: null,
    disposition: "rejected", actor: "Reviewer", reason: "Wrong meaning", decisionEditSeq: 2 };
  commands.register({ ...metadata, id: "translation.decide-draft-candidate", payloadKind: "translation-draft-candidate", availability: () => ({ enabled: true }), handler });
  const dispatch = (input: unknown) => Reflect.apply(commands.dispatch, commands, ["translation.decide-draft-candidate", scope, input]);
  for (const change of [{ actor: " " }, { reason: "" }, { decisionEditSeq: "2" }, { expectedDecisionId: "different" }, { draftEditSeq: 2 },
    { evidence: { kind: "tm", donorUnitId: "unit", sourceRevisionId: "source", translationRevisionId: "revision" } }]) expect(dispatch({ ...decision, ...change })).toBe(false);
  expect(dispatch(decision)).toBe(true); expect(handler).toHaveBeenCalledExactlyOnceWith(decision);
});
