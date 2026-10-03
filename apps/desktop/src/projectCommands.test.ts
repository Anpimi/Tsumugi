import { describe, expect, it } from "vitest";
import { hasUnknownOutcome } from "./projectCommands";

describe("mutation outcome classification", () => {
  it("uses the explicit outcome independently of diagnostic wording", () => {
    expect(hasUnknownOutcome({ code: "outcome-unknown", outcome: "unknown", reason: "commit" })).toBe(true);
    expect(hasUnknownOutcome({ code: "invalid-input", outcome: "rejected", field: "unknown-locale" })).toBe(false);
    expect(hasUnknownOutcome({ code: "dependency-conflict", outcome: "rejected", stage: "execution-adopt" })).toBe(false);
  });
  it("retains the original action when transport provides no recognized rejection", () => {
    for (const error of [null, undefined, "IPC disconnected", new Error("response lost"), {}, { outcome: "rejected" }, { code: "future-code", outcome: "rejected" }, { code: "outcome-unknown", outcome: "rejected" }]) {
      expect(hasUnknownOutcome(error)).toBe(true);
    }
  });
});
