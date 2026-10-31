import { expect, it } from "vitest";
import wire from "../../../../test/fixtures/resourceCommands.contract.json";
import { initialResourceDraftState } from "../../../ResourceDraftSession";
import { knowledgeEntryRecovery } from "./knowledgeState";

it("returns a retained context draft to its unit and language without changing its input", () => {
  const state = initialResourceDraftState("zh-CN");
  state.selectedUnit = { unitId: "retained-unit", sourceRevisionId: "source", occurrence: { key: "hello", text: "Hello" } };
  state.contextDraft = "Keep newer context B 🧵\né";
  const before = structuredClone(state);
  expect(knowledgeEntryRecovery({ current: () => state, contextDirty: () => true }))
    .toEqual({ unitId: "retained-unit", locale: "zh-CN" });
  expect(state).toEqual(before);
});

it.each(["context", "capture"] as const)("returns an unresolved %s request to its original scope", kind => {
  const state = initialResourceDraftState("ja");
  state.selectedUnit = { unitId: "newer-view-unit", sourceRevisionId: "source", occurrence: { key: "later", text: "Later" } };
  const session = { projectId: wire.requests.context.projectId, sessionToken: "synthetic" };
  state.pending = kind === "context"
    ? { kind, session, request: wire.requests.context.context, submittedSeq: 1 }
    : { kind, session, request: wire.requests.contextCapture.capture, submittedSeq: "1" };
  expect(knowledgeEntryRecovery({ current: () => state, contextDirty: () => true }))
    .toEqual({ unitId: state.pending.request.unitId, locale: state.pending.request.locale });
});

it("leaves completed entry context and unrelated term work in their existing Knowledge route", () => {
  const state = initialResourceDraftState("zh-CN");
  state.selectedUnit = { unitId: "saved-unit", sourceRevisionId: "source", occurrence: { key: "hello", text: "Hello" } };
  expect(knowledgeEntryRecovery({ current: () => state, contextDirty: () => false })).toBeNull();
  expect(knowledgeEntryRecovery(null)).toBeNull();
});
