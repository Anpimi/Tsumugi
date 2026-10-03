import { describe, expect, it } from "vitest";
import { hasUnknownOutcome } from "./projectCommands";

describe("mutation outcome classification", () => {
  it("uses the stable code independently of diagnostic wording", () => {
    expect(hasUnknownOutcome({ code: "outcome-unknown", field: "commit" })).toBe(true);
    expect(hasUnknownOutcome({ code: "invalid-input", field: "unknown-locale" })).toBe(false);
    expect(hasUnknownOutcome({ code: "dependency-conflict", stage: "execution-adopt" })).toBe(false);
  });
  it("retains the original action when transport provides no recognized rejection", () => {
    for (const error of [null, undefined, "IPC disconnected", new Error("response lost"), {}, { code: "future-code" }]) {
      expect(hasUnknownOutcome(error)).toBe(true);
    }
  });
});
