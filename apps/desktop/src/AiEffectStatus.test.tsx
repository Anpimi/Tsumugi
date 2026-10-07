import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiEffectStatus } from "./AiEffectStatus";
import fixture from "../test/fixtures/aiCommands.contract.json";
import type { EffectView } from "./generated/ai.responses";
import { i18n } from "./i18n";
import { validateResponseView } from "./generated/ai.validators";
afterEach(cleanup);
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
function recorded(): EffectView {
  const view: unknown = structuredClone(fixture.responses.automaticView);
  if (!validateResponseView(view) || !view.rows[0].automation) throw new Error("Invalid recorded fixture");
  return view.rows[0].automation;
}
it("presents a historical policy selection without claiming current translation or approval", async () => {
  const effect = recorded(); render(<AiEffectStatus effect={effect} disabled={false} onRetry={vi.fn()} />);
  expect(screen.getByText("This candidate was selected by policy")).toBeInTheDocument();
  expect(screen.getByText(/review the editor for the current translation/)).toBeInTheDocument();
  expect(screen.getByText(/Human approval remains separate/)).toBeInTheDocument();
  await userEvent.click(screen.getByText("Mechanical check evidence"));
  expect(screen.getByText(/Required translation/)).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("shows candidate-only completion in both languages without implying checks or selection", async () => {
  const effect: EffectView = { phase: "saved", actionId: null, receipt: null, error: null, retryable: false };
  const { rerender } = render(<AiEffectStatus effect={effect} disabled={false} onRetry={vi.fn()} />);
  expect(screen.getByText("Candidate saved; no translation was selected")).toBeInTheDocument();
  expect(screen.queryByText("Mechanical check evidence")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  await i18n.changeLanguage("zh-CN");
  rerender(<AiEffectStatus effect={effect} disabled={false} onRetry={vi.fn()} />);
  expect(screen.getByText("候选已保存，尚未选择译文")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("explains protection while retaining mechanical evidence in both languages", async () => {
  const effect = recorded(); effect.phase = "blocked"; effect.receipt!.blocked = "protected";
  effect.receipt!.selection = null; effect.receipt!.checkRunId = null;
  const { rerender } = render(<AiEffectStatus effect={effect} disabled={false} onRetry={vi.fn()} />);
  expect(screen.getByText(/mechanical checks still ran/)).toBeInTheDocument();
  await i18n.changeLanguage("zh-CN"); rerender(<AiEffectStatus effect={effect} disabled={false} onRetry={vi.fn()} />);
  expect(screen.getByText(/机械检查仍已执行/)).toBeInTheDocument();
});
it("offers only an explicit allowed retry and prevents it under revoked authority", async () => {
  const effect = recorded(); effect.phase = "failed"; effect.receipt = null; effect.retryable = true;
  effect.error = { code: "storage-failed", stage: "execution-adopt", outcome: "rejected", reason: "execution-storage", recoveryRequired: false, diagnosticId: fixture.requests.read.attemptId };
  const retry = vi.fn(); const { rerender } = render(<AiEffectStatus effect={effect} disabled={true} onRetry={retry} />);
  const button = screen.getByRole("button", { name: "Check saved result and retry original action" });
  expect(button).toBeDisabled(); await userEvent.click(button); expect(retry).not.toHaveBeenCalled();
  rerender(<AiEffectStatus effect={effect} disabled={false} onRetry={retry} />);
  await userEvent.click(button); expect(retry).toHaveBeenCalledTimes(1);
});

it("presents opaque plugin rules and findings without classifying them as terminology", async () => {
  const effect = recorded(); effect.phase = "blocked"; effect.receipt!.blocked = "checks";
  effect.receipt!.selection = null; effect.receipt!.checkRunId = null;
  effect.receipt!.rules.push({ rule: "plugin:third-domain", status: "findings", reason: null,
    findings: [{ issueId: "domain-issue", rule: "plugin:third-domain", code: "third-format-invalid",
      detail: "third-format-invalid", severity: "error", waivable: false }] });
  const { rerender } = render(<AiEffectStatus effect={effect} disabled={false} onRetry={vi.fn()} />);
  await userEvent.click(screen.getByText("Mechanical check evidence"));
  expect(screen.getByText(/Plugin check: third-domain/)).toBeVisible();
  expect(screen.getByText("Plugin check reported: third-format-invalid")).toBeVisible();
  expect(screen.queryByText("Protected term needs review")).not.toBeInTheDocument();
  await i18n.changeLanguage("zh-CN"); rerender(<AiEffectStatus effect={effect} disabled={false} onRetry={vi.fn()} />);
  expect(screen.getByText("插件检查报告：third-format-invalid")).toBeVisible();
});
