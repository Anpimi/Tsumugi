import { describe, expect, it } from "vitest";
import { hasUnknownOutcome } from "./projectCommands";

describe("mutation outcome classification", () => {
  it("uses the explicit outcome independently of diagnostic wording", () => {
    expect(hasUnknownOutcome({ code: "outcome-unknown", outcome: "unknown", stage: "execution-adopt", recoveryRequired: true, reason: "commit" })).toBe(true);
    expect(hasUnknownOutcome({ code: "invalid-input", outcome: "rejected", stage: "set-target-locales", recoveryRequired: false, field: "unknown-locale" })).toBe(false);
    expect(hasUnknownOutcome({ code: "dependency-conflict", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false })).toBe(false);
  });
  it("retains the original action when transport provides no recognized rejection", () => {
    for (const error of [null, undefined, "IPC disconnected", new Error("response lost"), {}, { outcome: "rejected" }, { code: "future-code", outcome: "rejected" }, { code: "outcome-unknown", outcome: "rejected" }]) {
      expect(hasUnknownOutcome(error)).toBe(true);
    }
  });
  it("keeps malformed known-code rejections uncertain at the generated error boundary", () => {
    const rejected = { code: "dependency-conflict", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false };
    for (const error of [
      { code: rejected.code, outcome: rejected.outcome },
      { ...rejected, stage: "execution-write" },
      { ...rejected, stage: null },
      { ...rejected, recoveryRequired: "false" },
      { ...rejected, field: null },
      { ...rejected, reason: 42 },
      { ...rejected, currentRevision: "18446744073709551616" },
      { ...rejected, itemIds: ["not-an-identity"] },
      { ...rejected, recoveryActions: ["replay-unknown"] },
    ]) expect(hasUnknownOutcome(error)).toBe(true);
    expect(hasUnknownOutcome({ ...rejected, reason: "unknown-wording-is-not-an-outcome" })).toBe(false);
  });
});
