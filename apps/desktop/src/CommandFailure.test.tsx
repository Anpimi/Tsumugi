import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import fixture from "../test/fixtures/commandErrors.contract.json";
import { CommandFailureDetails, commandFailure, failureReason } from "./CommandFailure";
import { hasUnknownOutcome, isCommandError } from "./projectCommands";
import { i18n } from "./i18n";

afterEach(cleanup);

it("validates every shared Rust error shape and retains its structured evidence", () => {
  for (const error of fixture.errors) {
    const decoded: unknown = JSON.parse(JSON.stringify(error));
    expect(isCommandError(decoded)).toBe(true);
    expect(commandFailure(decoded)).toBe(decoded);
    expect(hasUnknownOutcome(decoded)).toBe(error.outcome !== "rejected");
  }
});

it("does not treat malformed conflict or recovery evidence as an explicit rejection", () => {
  const rejected = fixture.errors[0];
  for (const invalid of [
    { ...rejected, diagnosticId: "not-an-identity" },
    { ...rejected, recoveryGuidance: "repeat-write" },
    { ...rejected, conflict: { kind: "future-basis", expected: null, current: null } },
    { ...rejected, conflict: { kind: "translation-selection", current: null } },
    { ...rejected, conflict: { kind: "source-revision", expected: null, current: rejected.conflict!.current } },
    { ...rejected, conflict: { kind: "content-revision", expected: 9007199254740993, current: "2" } },
    { ...rejected, conflict: { kind: "content-revision", expected: "01", current: "9223372036854775808" } },
    { ...rejected, conflict: { kind: "review-basis", expected: null, current: "basis" } },
  ]) {
    expect(isCommandError(invalid)).toBe(false);
    expect(hasUnknownOutcome(invalid)).toBe(true);
  }
});

it.each(["en-US", "zh-CN"])("shows recovery help and expands the original error evidence in %s", async locale => {
  await i18n.changeLanguage(locale);
  const error = commandFailure(fixture.errors[1]);
  render(<CommandFailureDetails failure={error} />);
  expect(screen.getByText(i18n.t("commandError.recovery.review-current"))).toBeVisible();
  const summary = screen.getByText(i18n.t("execution.diagnostic"));
  expect(summary.closest("details")).not.toHaveAttribute("open");
  const user = userEvent.setup();
  await user.click(summary);
  expect(summary.closest("details")).toHaveAttribute("open");
  expect(screen.getByText(fixture.errors[1].diagnosticId)).toBeVisible();
  expect(screen.getByText(i18n.t("commandError.conflict.translation-selection"))).toBeVisible();
  expect(screen.getByText(i18n.t("commandError.none"))).toBeVisible();
  expect(screen.getByText(fixture.errors[1].conflict!.current!)).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("preserves an explicit unknown outcome independently of its diagnostic reason", () => {
  const error = commandFailure({ ...fixture.errors[14], reason: "commit" });
  expect(failureReason(error)).toBe("outcome-unknown");
  expect(failureReason("input-busy")).toBe("input-busy");
  expect(failureReason(null)).toBeNull();
});
