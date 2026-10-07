import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { WorkPlanControls } from "./WorkPlanControls";
import { workPlanCommands, type WorkPlanView, type WorkPlanStatusView } from "./workPlanCommands";
import wire from "../test/fixtures/workPlanCommands.contract.json";
import { validateResponseWorkPlan, validateResponseWorkPlanReceipt } from "./generated/ai.validators";
import { formatReviewSlotFixture, textReviewSlotFixture, textReviewViewFixture } from "./testSupport/textReviewFixture";
import { i18n } from "./i18n";
import { executionCommands } from "./executionCommands";

function planFixture(): WorkPlanView {
  const base = wire.responses.plan;
  if (!validateResponseWorkPlan(base)) throw new Error("Invalid work plan fixture");
  const format = formatReviewSlotFixture();
  const text = [textReviewViewFixture("first-support"), textReviewViewFixture("second-support", "f".repeat(64))];
  return { ...base, options: { ...base.options, selectionPolicy: "missing-only", stages: [
    { stage: "generation", mode: "assisted" }, { stage: "checks", mode: "assisted" },
  ], advisoryChecks: text.map(view => ({ binding: view.binding, environment: view.environment,
    declarationResourceId: view.resourceId, resourcePins: view.resourcePins, rules: view.rules })) },
  checkers: [{ kind: "ready", checker: format.checker, plugin: format.plugin }, ...text.map(view => {
    const slot = textReviewSlotFixture(view);
    return { kind: "ready" as const, checker: slot.checker, plugin: slot.plugin };
  })] };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); vi.restoreAllMocks(); });
afterEach(cleanup);

it("authorizes all captured checker identities only after their separate confirmations", async () => {
  const plan = planFixture();
  const receipt = wire.responses.receipt;
  if (!validateResponseWorkPlanReceipt(receipt) || !receipt.attemptId) throw new Error("Invalid receipt fixture");
  const attemptId = receipt.attemptId;
  vi.spyOn(executionCommands, "identity").mockResolvedValue(wire.requests.authorize.actionId);
  const authorize = vi.spyOn(workPlanCommands, "authorize").mockResolvedValue(receipt);
  vi.spyOn(workPlanCommands, "start").mockResolvedValue(attemptId);
  const status: WorkPlanStatusView = { plan, lease: receipt.lease, state: "active",
    effects: ["save-candidate", "run-checks", "select-missing"], expiresAt: "9007199254740994" };
  const refresh = vi.fn().mockResolvedValue(status);
  const started = vi.fn();
  const context = { sessionToken: "session", projectId: wire.requests.prepare.projectId };
  const user = userEvent.setup();
  const props = { context, prepared: plan, status: null, busy: false, disabled: false, consent: true, refresh,
    run: async (work: (current: () => boolean) => Promise<void>) => { await work(() => true); },
    onPlan: vi.fn(), onStarted: started, onBlockedChange: vi.fn(), onOpenTranslation: vi.fn() };
  const rendered = render(<WorkPlanControls {...props} />);
  const consents = screen.getAllByRole("checkbox", { name: i18n.t("ai.plan.checkerConsent") });
  expect(consents).toHaveLength(3);
  const generate = screen.getByRole("button", { name: "Send and generate candidates" });
  await user.click(consents[0]); await user.click(consents[1]);
  expect(generate).toBeDisabled(); expect(authorize).not.toHaveBeenCalled();
  await user.click(consents[2]); await user.click(generate);
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(authorize.mock.calls[0][0].checkerExecutions).toEqual(plan.checkers.map(checker => checker.checker));
  expect(new Set(authorize.mock.calls[0][0].checkerExecutions.map(checker => checker.provider.plugin.id)).size).toBe(3);
  rendered.rerender(<WorkPlanControls {...props} prepared={null} status={{ ...status, state: "paused", lease: { ...status.lease, generation: "2" } }} />);
  for (const consent of screen.getAllByRole("checkbox", { name: i18n.t("ai.plan.checkerConsent") })) expect(consent).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Continue with renewed authorization" })).toBeDisabled();
});

it("keeps an unavailable selected checker visible and prevents authorization", async () => {
  const plan = planFixture();
  plan.checkers[1] = { kind: "unavailable", checker: plan.checkers[1].checker, error: {
    code: "permission-denied", stage: "read", outcome: "rejected", reason: "plugin-disabled", recoveryRequired: false,
  } };
  const authorize = vi.spyOn(workPlanCommands, "authorize");
  render(<WorkPlanControls context={{ sessionToken: "session", projectId: wire.requests.prepare.projectId }}
    prepared={plan} status={null} busy={false} disabled={false} consent refresh={vi.fn()}
    run={async work => { await work(() => true); }} onPlan={vi.fn()} onStarted={vi.fn()} onBlockedChange={vi.fn()} onOpenTranslation={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent("captured checker or approved runtime is unavailable");
  expect(screen.getByText("example/first-support 0.1.0")).toBeVisible();
  expect(screen.getByRole("button", { name: "Send and generate candidates" })).toBeDisabled();
  expect(authorize).not.toHaveBeenCalled();
});
