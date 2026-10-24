import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";
import { createRef, useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewWorkbench, type ReviewHandle } from "./ReviewWorkbench";
import type { ProjectView } from "./projectCommands";
import type { ReviewTarget } from "./reviewCommands";
import type { ReviewWrite, WaiverWrite, Waiver, FallbackWrite, FallbackDecision } from "./reviewCommands";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture, reviewDecisionFixture, reviewCheckFixture } from "./testSupport/reviewFixture";
import { useWorkbenchCommands, type WorkbenchCommands, type ReviewWaiverCommandPayload, type ReviewFallbackCommandPayload } from "./workbenchCommands";
import { useReviewDraftSession } from "./ReviewDraftSession";
import type { ChangeScope } from "./sessionReads";
import type { Eligibility } from "./reviewCommands";

function CommandsProbe({ capture }: { capture: (commands: WorkbenchCommands) => void }) {
  const commands = useWorkbenchCommands();
  useLayoutEffect(() => { capture(commands); }, [commands, capture]);
  return null;
}
function ReviewOwnerProbe({ capture }: { capture: (owner: ReturnType<typeof useReviewDraftSession>) => void }) {
  const owner = useReviewDraftSession();
  useLayoutEffect(() => { capture(owner); });
  return null;
}
function waiverReceipt(request: WaiverWrite, waiverId = fixtureIdentity(625)): Waiver {
  return { waiverId, actionId: request.actionId, unitId: request.unitId, locale: request.locale, basis: request.expectedBasis,
    issueId: request.issueId, grant: request.grant, previousWaiverId: request.expectedWaiverId ?? null,
    policyVersion: "balanced-1", actor: request.actor, reason: request.reason, createdAt: "2026-10-03T00:00:00Z" };
}
function fallbackReceipt(request: FallbackWrite): FallbackDecision {
  return { fallbackId: fixtureIdentity(626), actionId: request.actionId, unitId: request.unitId, locale: request.locale,
    sourceRevisionId: targets.first.sourceRevisionId, allow: request.allow, previousFallbackId: request.expectedFallbackId ?? null,
    policyVersion: "balanced-1", actor: request.actor, reason: request.reason, createdAt: "2026-10-03T00:00:00Z" };
}
function waiverFindings(target: ReviewTarget) {
  return reviewCheckFixture(target, fixtureIdentity(621), "completed", { rules: [{ rule: "terminology", status: "findings", reason: null,
    findings: ["first-term", "second-term"].map(issueId => ({ issueId, rule: "terminology", code: "missing", detail: issueId, severity: "warning", waivable: true })) },
    { rule: "placeholders", status: "findings", reason: null, findings: [{ issueId: "blocked-issue", rule: "placeholders", code: "missing", detail: "blocked", severity: "error", waivable: false }] }] });
}

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const project: ProjectView = {
  sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(600), displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
};
const makeTarget = (name: string): ReviewTarget => reviewTargetFixture({
  unitId: fixtureIdentity(name === "first" ? 601 : 611), nativeKey: name, basis: `basis-${name}`,
  sourceRevisionId: fixtureIdentity(name === "first" ? 602 : 612), selectionId: fixtureIdentity(name === "first" ? 603 : 613), revisionId: fixtureIdentity(name === "first" ? 604 : 614),
});
function withLocales(locales: string[], revision: string): ProjectView {
  return { ...project, metadata: { ...project.metadata, targetLocales: locales, metadataRevision: revision } };
}
function workPage(target: ReviewTarget, nextOffset: number | null = null) {
  return { items: [{ unitId: target.unitId, locale: target.locale, nativeKey: target.nativeKey,
    basis: target.basis, reasons: [] }], total: nextOffset === null ? 1 : 2, nextOffset, coverage: "current" };
}
function historyPage(target: ReviewTarget, version: string, nextOffset: number | null = null) {
  return { decisions: [], checks: [reviewCheckFixture(target, fixtureIdentity(650), "completed", {
    runId: fixtureIdentity(651), validatorVersion: version,
  })], waivers: [], fallbacks: [], nextOffset };
}
function eligibilityResult(locales: string[], marker: string, ready = false): Eligibility {
  return { policyVersion: "balanced-1", sourceSnapshotId: fixtureIdentity(600), basis: marker, ready,
    locales: locales.map(locale => ({ locale, ready, checkedUnits: 1, blockerCount: ready ? 0 : 1, exceptionCount: 0,
      blockers: ready ? [] : [{ unitId: targets.first.unitId, nativeKey: marker, code: "qa-missing-or-stale", reference: null }],
      exceptions: [] })) };
}

let targets: Record<string, ReviewTarget>;
let nextIdentity: number;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  targets = { first: makeTarget("first"), second: makeTarget("second") };
  nextIdentity = 0;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(targets.first)]);
    if (command === "read_review_target") return Object.values(targets).find(target => target.unitId === args.request.unitId);
    if (command === "read_review_history") return { decisions: [], checks: [], waivers: [], fallbacks: [], nextOffset: null };
    if (command === "create_execution_identity") return fixtureIdentity(++nextIdentity);
    if (command === "write_review_decision") {
      const decision = args.request.decision as ReviewWrite;
      return reviewDecisionFixture(decision, Object.values(targets).find(target => target.unitId === decision.unitId)!);
    }
    if (command === "read_review_work") return { items: [], total: 0, nextOffset: null, coverage: "current" };
    if (command === "read_review_eligibility") return { policyVersion: "balanced-1", sourceSnapshotId: fixtureIdentity(600), basis: "eligibility",
      ready: false, locales: [{ locale: "zh-CN", ready: false, blockers: [{ unitId: targets.first.unitId, nativeKey: "first", code: "qa-missing-or-stale", reference: null }],
        exceptions: [], checkedUnits: 1, blockerCount: 1, exceptionCount: 0 }] };
    throw new Error(command);
  });
});
afterEach(cleanup);

it("registers scoped Review commands for the committed view and removes them on unmount", async () => {
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const view = render(<><ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>, project);
  const command = (id: string) => registry.list(scope).find(value => value.id === id);
  expect(command("review.approve")).toMatchObject({ nameKey: "review.approve", category: "review", scope,
    binding: null, risk: "writes-review", confirmation: "none", availability: { enabled: false, reason: "hidden" } });
  expect(command("review.request-changes")).toMatchObject({ nameKey: "review.requestChanges", category: "review", binding: null, risk: "writes-review" });
  expect(command("review.run-checks")).toMatchObject({ nameKey: "review.check", category: "review", binding: null, risk: "runs-review-checks" });
  expect(command("review.cancel-checks")).toMatchObject({ nameKey: "review.cancelCheck", category: "review", binding: null, risk: "cancels-review-checks" });
  expect(command("review.retry-pending")).toMatchObject({ nameKey: "review.retry", category: "review", binding: null, risk: "retries-review-action" });

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  expect(command("review.approve")?.availability.enabled).toBe(true);
  expect(command("review.request-changes")?.availability.enabled).toBe(true);
  expect(command("review.run-checks")?.availability.enabled).toBe(true);
  expect(command("review.cancel-checks")?.availability.enabled).toBe(false);
  expect(command("review.retry-pending")?.availability.enabled).toBe(false);
  expect(registry.dispatch("review.approve", { ...scope, area: "translation" })).toBe(false);
  expect(registry.dispatch("review.approve", { ...scope, sessionToken: "older-session" })).toBe(false);
  expect(registry.dispatch("review.approve", { ...scope, projectId: fixtureIdentity(999) })).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity" || name === "write_review_decision")).toHaveLength(0);

  await user.click(screen.getByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "Approve selected entries (1)" }));
  expect(command("review.approve")?.availability).toMatchObject({ enabled: false, reason: "hidden" });
  expect(registry.dispatch("review.approve", scope)).toBe(false);
  await user.click(screen.getByRole("button", { name: "Stay and keep work" }));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(command("review.approve")?.availability).toMatchObject({ enabled: false, reason: "hidden" });
  expect(registry.dispatch("review.approve", scope)).toBe(false);
  expect(screen.queryByRole("button", { name: "Approve selected entries (1)" })).not.toBeInTheDocument();
  view.unmount();
  expect(registry.list(scope)).toHaveLength(0);
});

it("keeps request-changes validation in the owner and routes its button through the same command", async () => {
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  render(<><ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>, project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  expect(registry.list(scope).find(value => value.id === "review.request-changes")?.availability.enabled).toBe(true);
  await act(async () => { expect(registry.dispatch("review.request-changes", scope)).toBe(true); });
  expect(await screen.findByText("Enter a reason for this action.")).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity" || name === "write_review_decision")).toHaveLength(0);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Needs a correction");
  await user.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "write_review_decision")).toHaveLength(1));
  expect(invoke.mock.calls.find(([name]) => name === "write_review_decision")![1].request.decision)
    .toMatchObject({ kind: "request-changes", reason: "Needs a correction", actor: "Reviewer A", unitId: targets.first.unitId,
      locale: "zh-CN", expectedBasis: targets.first.basis });
});

it("retains the original pending Review request across subtabs, remount, and removed language", async () => {
  const original = invoke.getMockImplementation()!;
  let writes = 0;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    const response = await original(name, args);
    return name === "write_review_decision" && ++writes === 1 ? { ...response, actionId: fixtureIdentity(629) } : response;
  });
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const consumer = (current: ProjectView) => <><ReviewWorkbench project={current} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>;
  const view = render(consumer(project), project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Original reason");
  await act(async () => { expect(registry.dispatch("review.approve", scope)).toBe(true); });
  await screen.findByRole("button", { name: "Retry the same action" });
  const originalRequest = invoke.mock.calls.find(([name]) => name === "write_review_decision")![1].request;
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(registry.list(scope).find(value => value.id === "review.retry-pending")?.availability.enabled).toBe(true);
  expect(screen.getByRole("button", { name: "Retry the same action" })).toBeVisible();
  expect(registry.dispatch("review.approve", scope)).toBe(false);
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  expect(registry.list(scope).find(value => value.id === "review.retry-pending")?.availability.enabled).toBe(true);
  view.rerender(null, project);
  expect(registry.list(scope)).toHaveLength(0);
  const removed = withLocales(["ja"], "2");
  view.rerender(consumer(removed), removed);
  expect(await screen.findByRole("button", { name: "Retry the same action" })).toBeEnabled();
  expect(registry.list(scope).find(value => value.id === "review.retry-pending")?.availability.enabled).toBe(true);
  expect(registry.dispatch("review.approve", scope)).toBe(false);
  await act(async () => { expect(registry.dispatch("review.retry-pending", scope)).toBe(true); });
  await waitFor(() => expect(writes).toBe(2));
  const requests = invoke.mock.calls.filter(([name]) => name === "write_review_decision").map(([, args]) => args.request);
  expect(requests).toEqual([originalRequest, originalRequest]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
});

it("cancels only the active check ID through the command while the Review owner is busy", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, args: unknown) => name === "run_review_checks" ? reply
    : name === "cancel_review_checks" ? Promise.resolve(true) : original(name, args));
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const consumer = (disabled: boolean) => <><ReviewWorkbench project={project} disabled={disabled} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>;
  const view = render(consumer(false), project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await act(async () => { expect(registry.dispatch("review.run-checks", scope)).toBe(true); });
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "run_review_checks")).toBe(true));
  const checkRequest = invoke.mock.calls.find(([name]) => name === "run_review_checks")![1].request;
  view.rerender(null, project);
  expect(registry.list(scope)).toHaveLength(0);
  view.rerender(consumer(true), project);
  expect(await screen.findByRole("button", { name: "Cancel current check" })).toBeEnabled();
  expect(registry.list(scope).find(value => value.id === "review.cancel-checks")?.availability.enabled).toBe(true);
  expect(registry.dispatch("review.run-checks", scope)).toBe(false);
  await act(async () => { expect(registry.dispatch("review.cancel-checks", scope)).toBe(true); });
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "cancel_review_checks")).toBe(true));
  expect(invoke.mock.calls.find(([name]) => name === "cancel_review_checks")![1].request)
    .toMatchObject({ actionId: checkRequest.actionId, projectId: project.metadata.projectId, sessionToken: project.sessionToken });
  await act(async () => finish(reviewCheckFixture(targets.first, checkRequest.actionId, "cancelled")));
  expect(await screen.findByText("The check was cancelled before completion. Run it again for current coverage.")).toBeVisible();
});

it("routes fallback commands to the exact entry and preserves owner reason validation", async () => {
  targets.first = reviewTargetFixture({ ...targets.first, selectionId: null, revisionId: null, translationText: null, basisEvidence: undefined });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    if (name === "allow_source_fallback") {
      const request = args.request.fallback as FallbackWrite, receipt = fallbackReceipt(request);
      targets.first = { ...targets.first, currentFallback: request.allow ? receipt : null };
      return receipt;
    }
    return original(name, args);
  });
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const consumer = (current: ProjectView) => <><ReviewWorkbench project={current} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>;
  const view = render(consumer(project), project), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const payload: ReviewFallbackCommandPayload = { kind: "review-fallback", unitId: targets.first.unitId,
    locale: "zh-CN", basis: targets.first.basis, expectedFallbackId: null };
  expect(registry.list(scope).find(value => value.id === "review.allow-fallback")).toMatchObject({ nameKey: "review.fallback",
    payloadKind: "review-fallback", binding: null, risk: "writes-review", availability: { enabled: false, reason: "unavailable" } });
  expect(registry.describe("review.allow-fallback", scope, payload)?.availability.enabled).toBe(true);
  await act(async () => { expect(registry.dispatch("review.allow-fallback", scope, payload)).toBe(true); });
  expect(await screen.findByText("Enter a reason for this action.")).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity" || name === "allow_source_fallback")).toHaveLength(0);
  expect(registry.dispatch("review.allow-fallback", scope, { ...payload, basis: "older-basis" })).toBe(false);
  expect(registry.dispatch("review.allow-fallback", scope, { ...payload, unitId: targets.second.unitId })).toBe(false);
  expect(registry.dispatch("review.withdraw-fallback", scope, payload)).toBe(false);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Use original wording");
  await user.click(screen.getByRole("button", { name: "Allow source text for this entry" }));
  await screen.findByRole("button", { name: "Withdraw source fallback" });
  const withdraw = { ...payload, expectedFallbackId: fixtureIdentity(626) };
  expect(registry.dispatch("review.allow-fallback", scope, payload)).toBe(false);
  expect(registry.dispatch("review.withdraw-fallback", scope, { ...withdraw, expectedFallbackId: fixtureIdentity(627) })).toBe(false);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Translation will follow");
  await act(async () => { expect(registry.dispatch("review.withdraw-fallback", scope, withdraw)).toBe(true); });
  await screen.findByRole("button", { name: "Allow source text for this entry" });
  const writes = invoke.mock.calls.filter(([name]) => name === "allow_source_fallback").map(([, args]) => args.request);
  expect(writes).toEqual([expect.objectContaining({ projectId: scope.projectId, sessionToken: scope.sessionToken,
    fallback: expect.objectContaining({ allow: true, unitId: payload.unitId, locale: payload.locale, expectedBasis: payload.basis,
      expectedFallbackId: null, actor: "Reviewer A", reason: "Use original wording" }) }), expect.objectContaining({
    fallback: expect.objectContaining({ allow: false, expectedFallbackId: withdraw.expectedFallbackId, reason: "Translation will follow" }) })]);
  const removed = withLocales(["ja"], "2");
  view.rerender(consumer(removed), removed);
  expect(registry.describe("review.allow-fallback", scope, payload)?.availability.enabled).toBe(false);
  expect(registry.dispatch("review.allow-fallback", scope, payload)).toBe(false);
  view.unmount();
  expect(registry.list(scope)).toHaveLength(0);
});

it("requires explicit adoption of changed fallback evidence and keeps the reason for the exact new identity", async () => {
  targets.first = reviewTargetFixture({ ...targets.first, selectionId: null, revisionId: null, translationText: null, basisEvidence: undefined });
  targets.first.currentFallback = fallbackReceipt({ projectId: project.metadata.projectId, actionId: fixtureIdentity(622),
    unitId: targets.first.unitId, locale: "zh-CN", expectedBasis: targets.first.basis, allow: true,
    expectedFallbackId: null, actor: "Reviewer A", reason: "Earlier exception" });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    if (name === "allow_source_fallback") {
      const request = args.request.fallback as FallbackWrite;
      targets.first = { ...targets.first, currentFallback: null };
      return fallbackReceipt(request);
    }
    return original(name, args);
  });
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  render(<><ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>, project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep this withdrawal reason");
  const payload: ReviewFallbackCommandPayload = { kind: "review-fallback", unitId: targets.first.unitId,
    locale: "zh-CN", basis: targets.first.basis, expectedFallbackId: fixtureIdentity(626) };
  targets.first = { ...targets.first, currentFallback: { ...targets.first.currentFallback!, fallbackId: fixtureIdentity(629) } };
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  await screen.findByRole("button", { name: "Use current content and keep reason" });
  expect(screen.getByRole("button", { name: "Withdraw source fallback" })).toBeDisabled();
  expect(registry.dispatch("review.withdraw-fallback", scope, payload)).toBe(false);
  const currentPayload = { ...payload, expectedFallbackId: fixtureIdentity(629) };
  expect(registry.dispatch("review.withdraw-fallback", scope, currentPayload)).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity" || name === "allow_source_fallback")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Use current content and keep reason" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep this withdrawal reason");
  expect(registry.describe("review.withdraw-fallback", scope, currentPayload)?.availability.enabled).toBe(true);
  expect(registry.dispatch("review.withdraw-fallback", scope, payload)).toBe(false);
  await user.click(screen.getByRole("button", { name: "Withdraw source fallback" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "allow_source_fallback")).toHaveLength(1));
  expect(invoke.mock.calls.find(([name]) => name === "allow_source_fallback")![1].request.fallback).toMatchObject({
    expectedBasis: payload.basis, expectedFallbackId: currentPayload.expectedFallbackId, allow: false, reason: "Keep this withdrawal reason" });
});

it("matches each waiver issue and observed waiver identity instead of switching to another current issue", async () => {
  targets.first.currentCheck = waiverFindings(targets.first);
  targets.first.currentWaivers = [waiverReceipt({ projectId: project.metadata.projectId, actionId: fixtureIdentity(622),
    unitId: targets.first.unitId, locale: "zh-CN", expectedBasis: targets.first.basis, issueId: "first-term", grant: true,
    expectedWaiverId: null, actor: "Reviewer A", reason: "Earlier exception" }, fixtureIdentity(624))];
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name: string, args: { request: Record<string, unknown> }) => {
    if (name === "waive_review_issue") {
      const request = args.request.waiver as WaiverWrite, receipt = waiverReceipt(request);
      targets.first = { ...targets.first, currentWaivers: request.grant ? [...targets.first.currentWaivers, receipt]
        : targets.first.currentWaivers.filter(value => value.waiverId !== request.expectedWaiverId) };
      return receipt;
    }
    return original(name, args);
  });
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  render(<><ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>, project);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const grant: ReviewWaiverCommandPayload = { kind: "review-waiver", unitId: targets.first.unitId, locale: "zh-CN",
    basis: targets.first.basis, issueId: "second-term", expectedWaiverId: null };
  const revoke = { ...grant, issueId: "first-term", expectedWaiverId: fixtureIdentity(624) };
  expect(registry.list(scope).find(value => value.id === "review.grant-waiver")).toMatchObject({ payloadKind: "review-waiver",
    nameKey: "review.waive", binding: null, availability: { enabled: false, reason: "unavailable" } });
  expect(registry.describe("review.grant-waiver", scope, grant)?.availability.enabled).toBe(true);
  expect(registry.describe("review.revoke-waiver", scope, revoke)?.availability.enabled).toBe(true);
  expect(registry.dispatch("review.grant-waiver", scope, { ...grant, issueId: "missing-issue" })).toBe(false);
  expect(registry.dispatch("review.grant-waiver", scope, { ...grant, issueId: "blocked-issue" })).toBe(false);
  expect(registry.dispatch("review.grant-waiver", scope, { ...grant, issueId: "first-term" })).toBe(false);
  expect(registry.dispatch("review.grant-waiver", scope, { ...grant, basis: "earlier-basis" })).toBe(false);
  expect(registry.dispatch("review.grant-waiver", scope, { ...grant, locale: "ja" })).toBe(false);
  expect(registry.dispatch("review.revoke-waiver", scope, { ...revoke, issueId: "second-term" })).toBe(false);
  expect(registry.dispatch("review.revoke-waiver", scope, { ...revoke, expectedWaiverId: fixtureIdentity(629) })).toBe(false);
  expect(registry.dispatch("review.grant-waiver", { ...scope, projectId: fixtureIdentity(999) }, grant)).toBe(false);
  expect(registry.dispatch("review.grant-waiver", { ...scope, sessionToken: "old-session" }, grant)).toBe(false);
  await user.click(screen.getByRole("button", { name: "Waive this warning" }));
  expect(await screen.findByText("Enter a reason for this action.")).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(0);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Second issue exception");
  await user.click(screen.getByRole("button", { name: "Waive this warning" }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Withdraw this waiver" })).toHaveLength(2));
  expect(registry.dispatch("review.grant-waiver", scope, grant)).toBe(false);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep this reason");
  targets.first = { ...targets.first, currentWaivers: targets.first.currentWaivers.map(value => value.issueId === "first-term"
    ? { ...value, waiverId: fixtureIdentity(629) } : value) };
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  await waitFor(() => expect(registry.describe("review.revoke-waiver", scope, revoke)?.availability.enabled).toBe(false));
  expect(registry.dispatch("review.revoke-waiver", scope, revoke)).toBe(false);
  const firstFinding = screen.getByText("Protected term needs review: first-term").parentElement!;
  await user.click(within(firstFinding).getByRole("button", { name: "Withdraw this waiver" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "waive_review_issue")).toHaveLength(2));
  const writes = invoke.mock.calls.filter(([name]) => name === "waive_review_issue").map(([, args]) => args.request.waiver);
  expect(writes).toEqual([expect.objectContaining({ issueId: "second-term", grant: true, expectedWaiverId: null,
    unitId: grant.unitId, locale: grant.locale, expectedBasis: grant.basis, reason: "Second issue exception" }),
  expect.objectContaining({ issueId: "first-term", grant: false, expectedWaiverId: fixtureIdentity(629), reason: "Keep this reason" })]);
});

it("keeps an uncertain waiver payload and newer reason across remount and removed language", async () => {
  targets.first.currentCheck = waiverFindings(targets.first);
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  let writes = 0;
  invoke.mockImplementation((name: string, args: { request: Record<string, unknown> }) => name === "waive_review_issue"
    ? ++writes === 1 ? reply : Promise.resolve(waiverReceipt(args.request.waiver as WaiverWrite)) : original(name, args));
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const consumer = (current: ProjectView) => <><ReviewWorkbench project={current} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>;
  const view = render(consumer(project), project), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason A");
  const payload: ReviewWaiverCommandPayload = { kind: "review-waiver", unitId: targets.first.unitId, locale: "zh-CN",
    basis: targets.first.basis, issueId: "second-term", expectedWaiverId: null };
  await act(async () => { expect(registry.dispatch("review.grant-waiver", scope, payload)).toBe(true); });
  await waitFor(() => expect(writes).toBe(1));
  const request = invoke.mock.calls.find(([name]) => name === "waive_review_issue")![1].request;
  expect(registry.describe("review.grant-waiver", scope, payload)?.availability).toMatchObject({ enabled: false, reason: "busy" });
  await user.clear(screen.getByRole("textbox", { name: "Reason or evidence" }));
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason B");
  await act(async () => finish({ ...waiverReceipt(request.waiver), issueId: "first-term" }));
  await screen.findByRole("button", { name: "Retry the same action" });
  view.rerender(null, project);
  expect(registry.list(scope)).toHaveLength(0);
  const removed = withLocales(["ja"], "2");
  view.rerender(consumer(removed), removed);
  expect(await screen.findByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
  expect(registry.dispatch("review.grant-waiver", scope, payload)).toBe(false);
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  await act(async () => { expect(registry.dispatch("review.retry-pending", scope)).toBe(true); });
  await waitFor(() => expect(writes).toBe(2));
  expect(invoke.mock.calls.filter(([name]) => name === "waive_review_issue").map(([, args]) => args.request)).toEqual([request, request]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
  expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument();
});

it("does not apply a late fallback receipt or old command scope to a newer project session", async () => {
  targets.first = reviewTargetFixture({ ...targets.first, selectionId: null, revisionId: null, translationText: null, basisEvidence: undefined });
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, args: unknown) => name === "allow_source_fallback" ? reply : original(name, args));
  let registry!: WorkbenchCommands;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const consumer = (current: ProjectView) => <><ReviewWorkbench project={current} disabled={false} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /></>;
  const view = render(consumer(project), project), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Old session reason");
  const payload: ReviewFallbackCommandPayload = { kind: "review-fallback", unitId: targets.first.unitId,
    locale: "zh-CN", basis: targets.first.basis, expectedFallbackId: null };
  await act(async () => { expect(registry.dispatch("review.allow-fallback", scope, payload)).toBe(true); });
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "allow_source_fallback")).toHaveLength(1));
  const request = invoke.mock.calls.find(([name]) => name === "allow_source_fallback")![1].request.fallback;
  const next = { ...project, sessionToken: "next-session", metadata: { ...project.metadata, projectId: fixtureIdentity(800) } };
  view.rerender(consumer(next), next);
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer B");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "New session reason");
  expect(registry.list(scope)).toHaveLength(0);
  expect(registry.dispatch("review.allow-fallback", scope, payload)).toBe(false);
  await act(async () => finish(fallbackReceipt(request)));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("New session reason");
  expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("Reviewer B");
  expect(screen.getByRole("button", { name: "Allow source text for this entry" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Withdraw source fallback" })).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "allow_source_fallback")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
});

it("requires the original batch confirmation and keeps scoped stop available while busy across subtabs and remount", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((name: string, args: unknown) => name === "read_review_summary_page"
    ? Promise.resolve(reviewSummaryPageFixture([reviewSummaryFor(targets.first), reviewSummaryFor(targets.second)]))
    : name === "write_review_decision" ? reply : original(name, args));
  let registry!: WorkbenchCommands, owner!: ReturnType<typeof useReviewDraftSession>;
  const scope = { projectId: project.metadata.projectId, sessionToken: project.sessionToken, area: "review" as const };
  const consumer = (current = project, disabled = false) => <><ReviewWorkbench project={current} disabled={disabled} onOpenTranslation={() => true} />
    <CommandsProbe capture={commands => { registry = commands; }} /><ReviewOwnerProbe capture={value => { owner = value; }} /></>;
  const view = render(consumer(), project), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("checkbox", { name: "Approve selected entries: second" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  expect(registry.describe("review.approve-batch", scope)).toMatchObject({ nameKey: "review.batch", binding: null,
    confirmation: "required", risk: "writes-review", availability: { enabled: true } });
  await act(async () => {
    expect(registry.dispatch("review.approve-batch", scope)).toBe(true);
    expect(registry.dispatch("review.approve-batch", scope)).toBe(false);
  });
  const dialog = screen.getByRole("dialog", { name: "Approve these fixed entries?" });
  expect(within(dialog).getAllByRole("listitem").map(item => item.textContent)).toEqual(["zh-CN: first", "zh-CN: second"]);
  expect(registry.describe("review.approve-batch", scope)?.availability).toMatchObject({ enabled: false, reason: "hidden" });
  expect(registry.dispatch("review.run-checks", scope)).toBe(false);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity" || name === "write_review_decision")).toHaveLength(0);
  const removed = withLocales(["ja"], "2");
  view.rerender(consumer(removed), removed);
  expect(within(dialog).getByRole("button", { name: "Confirm approvals" })).toBeDisabled();
  expect(within(dialog).getByText(/zh-CN is no longer a project target/)).toBeVisible();
  view.rerender(consumer(), project);
  await act(async () => owner.setActor(""));
  expect(within(dialog).getByRole("button", { name: "Confirm approvals" })).toBeDisabled();
  await act(async () => { owner.setActor("Reviewer A"); owner.toggleChosen(reviewSummaryFor(targets.second), false); });
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
  expect(within(dialog).getByRole("button", { name: "Confirm approvals" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "Stay and keep work" }));
  await user.click(screen.getByRole("checkbox", { name: "Approve selected entries: second" }));
  await user.click(screen.getByRole("button", { name: "Approve selected entries (2)" }));
  await user.click(screen.getByRole("button", { name: "Confirm approvals" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "write_review_decision")).toHaveLength(1));
  const request = invoke.mock.calls.find(([name]) => name === "write_review_decision")![1].request.decision;
  expect(registry.describe("review.stop-batch", scope)).toMatchObject({ nameKey: "review.batchCancel", binding: null,
    confirmation: "none", risk: "stops-review-batch", availability: { enabled: true } });
  expect(registry.dispatch("review.approve-batch", scope)).toBe(false);
  view.rerender(null, project);
  expect(registry.list(scope)).toHaveLength(0);
  view.rerender(consumer(project, true), project);
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(screen.getByRole("button", { name: "Stop after the current entry" })).toBeEnabled();
  expect(registry.dispatch("review.stop-batch", { ...scope, sessionToken: "old-session" })).toBe(false);
  expect(registry.dispatch("review.stop-batch", { ...scope, projectId: fixtureIdentity(999) })).toBe(false);
  expect(registry.dispatch("review.stop-batch", { ...scope, area: "translation" })).toBe(false);
  await act(async () => { expect(registry.dispatch("review.stop-batch", scope)).toBe(true); });
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  expect(await screen.findByText(/1 remaining entry was not started/)).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "write_review_decision")).toHaveLength(1);
  expect(registry.dispatch("review.stop-batch", scope)).toBe(false);
  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("checkbox", { name: "Approve selected entries: second" })).toBeChecked();
});

it("rebases a clean review to an available target language before reading it", async () => {
  const user = userEvent.setup();
  const initial = withLocales(["zh-CN", "ja"], "1");
  const view = render(<ReviewWorkbench project={initial} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_review_summary_page")).toBe(true));
  const readCount = invoke.mock.calls.length;

  view.rerender(<ReviewWorkbench project={withLocales(["ja"], "2")} disabled={false} onOpenTranslation={() => true} />);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("ja"));
  await waitFor(() => expect(invoke.mock.calls.slice(readCount).some(([command, args]) => command === "read_review_summary_page" && args.request.locale === "ja")).toBe(true));
  expect(invoke.mock.calls.slice(readCount).filter(([command, args]) => command.startsWith("read_review_") && args.request.locale === "zh-CN")).toEqual([]);
});

it("keeps a reason draft recoverable when its language is removed and blocks a fresh review action", async () => {
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "1")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep this reason");
  const readCount = invoke.mock.calls.length;

  view.rerender(<ReviewWorkbench project={withLocales(["ja"], "2")} disabled={false} onOpenTranslation={() => true} />);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep this reason");
  expect(screen.getByText(/zh-CN is no longer a project target/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  expect(invoke.mock.calls.slice(readCount).filter(([command, args]) => command.startsWith("read_review_") && args.request.locale === "zh-CN")).toEqual([]);
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(0);

  view.rerender(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "3")} disabled={false} onOpenTranslation={() => true} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep this reason");
});

it("rechecks the target language after a review action identity resolves", async () => {
  let finishIdentity!: (value: string) => void;
  const identity = new Promise<string>(resolve => { finishIdentity = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "create_execution_identity" ? identity : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Still editing");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "create_execution_identity")).toBe(true));

  view.rerender(<ReviewWorkbench project={withLocales(["ja"], "2")} disabled={false} onOpenTranslation={() => true} />);
  await act(async () => finishIdentity(fixtureIdentity(630)));
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(0);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Still editing");
  expect(screen.getByText(/zh-CN is no longer a project target/)).toBeVisible();
});

it("stops a batch before the next write if its target language is removed", async () => {
  let finishFirst!: (value: unknown) => void;
  const firstReply = new Promise(resolve => { finishFirst = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return Promise.resolve(args.request.afterOrdinal === 0
      ? reviewSummaryPageFixture([reviewSummaryFor(targets.first)], { nextOrdinal: 1, total: 2 })
      : reviewSummaryPageFixture([reviewSummaryFor(targets.second)], { total: 2 }));
    if (command === "write_review_decision" && (args.request.decision as ReviewWrite).unitId === targets.first.unitId) return firstReply;
    return original(command, args);
  });
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: second" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("button", { name: "Approve selected entries (2)" }));
  await user.click(screen.getByRole("button", { name: "Confirm approvals" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1));

  view.rerender(<ReviewWorkbench project={withLocales(["ja"], "2")} disabled={false} onOpenTranslation={() => true} />);
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  await act(async () => finishFirst(reviewDecisionFixture(request, targets.first)));
  await waitFor(() => expect(screen.getByText(/1 recorded, 0 changed, 0 not confirmed/)).toBeInTheDocument());
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1);
  expect(screen.getByText(/1 remaining entry was not started/)).toBeVisible();
  expect(screen.getByText(/zh-CN is no longer a project target/)).toBeVisible();
});

it("accepts the original in-flight receipt without reading a removed language or clearing newer reason text", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "write_review_decision" ? reply : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1));
  await user.type(reason, "B");

  view.rerender(<ReviewWorkbench project={withLocales(["ja"], "2")} disabled={false} onOpenTranslation={() => true} />);
  const readCount = invoke.mock.calls.length;
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  await waitFor(() => expect(reason).toHaveValue("AB"));
  expect(invoke.mock.calls.slice(readCount).filter(([command, args]) => command.startsWith("read_review_") && args.request.locale === "zh-CN")).toEqual([]);
  expect(screen.getByText(/zh-CN is no longer a project target/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
});

it("allows the original uncertain action to check its receipt after the target language is removed", async () => {
  const original = invoke.getMockImplementation()!;
  let writes = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const response = await original(command, args);
    return command === "write_review_decision" && ++writes === 1 ? { ...response, actionId: fixtureIdentity(629) } : response;
  });
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Original reason");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  const retry = await screen.findByRole("button", { name: "Retry the same action" });
  view.rerender(<ReviewWorkbench project={withLocales(["ja"], "2")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(retry);
  await waitFor(() => expect(writes).toBe(2));
  const requests = invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request);
  expect(requests[1]).toEqual(requests[0]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
});

it("keeps an uncertain action reserved after its language is restored until the same request is reconciled", async () => {
  const original = invoke.getMockImplementation()!;
  let writes = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const response = await original(command, args);
    return command === "write_review_decision" && ++writes === 1 ? { ...response, actionId: fixtureIdentity(629) } : response;
  });
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  const retry = await screen.findByRole("button", { name: "Retry the same action" });
  const originalRequest = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request;
  await user.type(reason, "B");

  view.rerender(<ReviewWorkbench project={withLocales(["ja"], "2")} disabled={false} onOpenTranslation={() => true} />);
  expect(screen.getByText(/zh-CN is no longer a project target/)).toBeVisible();
  view.rerender(<ReviewWorkbench project={withLocales(["zh-CN"], "3")} disabled={false} onOpenTranslation={() => true} />);
  await waitFor(() => expect(screen.queryByText(/zh-CN is no longer a project target/)).not.toBeInTheDocument());
  await waitFor(() => expect(retry).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await user.click(screen.getByRole("button", { name: "Run current checks" }));
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision" || command === "run_review_checks")).toHaveLength(1);
  expect(retry).toBeVisible();
  expect(reason).toHaveValue("AB");

  await user.click(retry);
  await waitFor(() => expect(writes).toBe(2));
  const requests = invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request);
  expect(requests).toEqual([originalRequest, originalRequest]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  expect(reason).toHaveValue("AB");
});

it("keeps newer reason text and the recorded action when the whole review consumer unmounts during approval", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "write_review_decision" ? reply : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1));
  await user.type(reason, "B");
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;

  view.rerender(null, project);
  view.rerender(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
  view.rerender(null, project);
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  view.rerender(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  expect(await screen.findByRole("textbox", { name: "Reason or evidence" })).toHaveValue("AB");
  expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("Reviewer A");
  expect(screen.getByRole("heading", { name: "first" })).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1);
});

it("restores the original unknown action after consumer remount without reading a removed language", async () => {
  const original = invoke.getMockImplementation()!;
  let writes = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const response = await original(command, args);
    return command === "write_review_decision" && ++writes === 1 ? { ...response, actionId: fixtureIdentity(629) } : response;
  });
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Original A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await screen.findByRole("button", { name: "Retry the same action" });
  const originalRequest = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request;
  const removed = withLocales(["ja"], "2");

  view.rerender(null, removed);
  const readCount = invoke.mock.calls.length;
  view.rerender(<ReviewWorkbench project={removed} disabled={false} onOpenTranslation={() => true} />, removed);
  expect(await screen.findByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Original A");
  expect(screen.getByText(/zh-CN is no longer a project target/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  expect(invoke.mock.calls.slice(readCount).filter(([command, args]) => command.startsWith("read_review_") && args.request.locale === "zh-CN")).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Retry the same action" }));
  await waitFor(() => expect(writes).toBe(2));
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request))
    .toEqual([originalRequest, originalRequest]);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
});

it("keeps an idle reason and fixed selection when the review panel closes and its consumer remounts", async () => {
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep for later");
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  expect(screen.queryByRole("dialog", { name: "Leave with an unfinished review?" })).not.toBeInTheDocument();
  view.rerender(null, project);
  view.rerender(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  expect(await screen.findByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep for later");
  expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("Reviewer A");
  expect(screen.getByRole("checkbox", { name: "Approve selected entries: first" })).toBeChecked();
});

it("retains an in-flight batch and its stop request across a consumer remount", async () => {
  let finish!: (value: unknown) => void;
  const firstReply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return Promise.resolve(args.request.afterOrdinal === 0
      ? reviewSummaryPageFixture([reviewSummaryFor(targets.first)], { nextOrdinal: 1, total: 2 })
      : reviewSummaryPageFixture([reviewSummaryFor(targets.second)], { total: 2 }));
    if (command === "write_review_decision") return firstReply;
    return original(command, args);
  });
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: second" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("button", { name: "Approve selected entries (2)" }));
  await user.click(screen.getByRole("button", { name: "Confirm approvals" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1));
  view.rerender(null, project);
  view.rerender(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("button", { name: "Stop after the current entry" }));
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  expect(await screen.findByText(/1 recorded, 0 changed, 0 not confirmed/)).toBeVisible();
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("checkbox", { name: "Approve selected entries: second" })).toBeChecked();
});

it("cancels an in-flight check after its consumer remounts", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "run_review_checks") return reply;
    if (command === "cancel_review_checks") return Promise.resolve(true);
    return original(command, args);
  });
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByRole("button", { name: "Run current checks" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "run_review_checks")).toBe(true));
  view.rerender(null, project);
  view.rerender(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("button", { name: "Cancel current check" }));
  const checkRequest = invoke.mock.calls.find(([command]) => command === "run_review_checks")![1].request;
  const cancelRequest = invoke.mock.calls.find(([command]) => command === "cancel_review_checks")![1].request;
  expect(cancelRequest.actionId).toBe(checkRequest.actionId);
  await act(async () => finish(reviewCheckFixture(targets.first, checkRequest.actionId, "cancelled")));
  expect(await screen.findByText("The check was cancelled before completion. Run it again for current coverage.")).toBeVisible();
});

it("releases a pending work read when a check receipt starts a newer view query", async () => {
  let finishCheck!: (value: unknown) => void;
  let finishWork!: (value: unknown) => void;
  const checkReply = new Promise(resolve => { finishCheck = resolve; });
  const workReply = new Promise(resolve => { finishWork = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "run_review_checks") return checkReply;
    if (command === "read_review_work") return workReply;
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByRole("button", { name: "Run current checks" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "run_review_checks")).toBe(true));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_review_work")).toBe(true));
  const actionId = invoke.mock.calls.find(([command]) => command === "run_review_checks")![1].request.actionId;
  await act(async () => finishCheck(reviewCheckFixture(targets.first, actionId)));
  await act(async () => finishWork({ items: [], total: 0, nextOffset: null, coverage: "current" }));
  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("button", { name: "Refresh current evidence" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Run current checks" })).toBeEnabled();
});

it("opens the work queue directly while the summary read is still pending", async () => {
  let finishSummary!: (value: unknown) => void;
  const summary = new Promise(resolve => { finishSummary = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_summary_page" ? summary
    : command === "read_review_work" ? workPage(targets.first) : original(command, args));
  const handle = createRef<ReviewHandle>();
  render(<ReviewWorkbench ref={handle} project={project} disabled={false} onOpenTranslation={() => true} />);

  await act(async () => { handle.current!.showWork(); });
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_review_work")).toBe(true));
  expect(screen.getByRole("tab", { name: "Work queue" })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
  await act(async () => finishSummary(reviewSummaryPageFixture([reviewSummaryFor(targets.first)])));
});

it("shows a loading state before an empty work queue result", async () => {
  let finishWork!: (value: unknown) => void;
  const work = new Promise(resolve => { finishWork = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_work" ? work : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_review_work")).toBe(true));
  expect(screen.getByText("Loading work queue…")).toBeVisible();
  expect(screen.queryByText("Choose an entry to review.")).not.toBeInTheDocument();
  await act(async () => finishWork({ items: [], total: 0, nextOffset: null, coverage: "current" }));
  expect(await screen.findByText("No current work items in this language.")).toBeVisible();
  expect(screen.queryByText("Loading work queue…")).not.toBeInTheDocument();
});

it("releases a pending work read on tab change and ignores its late result after reopening", async () => {
  let finishOldWork!: (value: unknown) => void;
  const oldWork = new Promise(resolve => { finishOldWork = resolve; });
  const original = invoke.getMockImplementation()!;
  let workReads = 0;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_work"
    ? ++workReads === 1 ? oldWork : Promise.resolve(workPage(targets.second)) : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  await waitFor(() => expect(workReads).toBe(1));

  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("button", { name: "Refresh current evidence" })).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  await waitFor(() => expect(workReads).toBe(2));
  expect(await screen.findByRole("button", { name: "second" })).toBeVisible();
  await act(async () => finishOldWork(workPage(targets.first)));
  expect(screen.getByRole("button", { name: "second" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "first" })).not.toBeInTheDocument();
});

it("does not show a late work result from another project session", async () => {
  let finishOldWork!: (value: unknown) => void;
  const oldWork = new Promise(resolve => { finishOldWork = resolve; });
  const next = { ...project, sessionToken: "session-2", metadata: { ...project.metadata, projectId: fixtureIdentity(800) } };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: { sessionToken?: string } }) => command === "read_review_work"
    ? args.request.sessionToken === project.sessionToken ? oldWork : Promise.resolve(workPage(targets.second))
    : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command, args]) => command === "read_review_work"
    && args.request.sessionToken === project.sessionToken)).toBe(true));
  view.rerender(null, next);
  view.rerender(<ReviewWorkbench project={next} disabled={false} onOpenTranslation={() => true} />, next);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(await screen.findByRole("button", { name: "second" })).toBeVisible();
  await act(async () => finishOldWork(workPage(targets.first)));
  expect(screen.getByRole("button", { name: "second" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "first" })).not.toBeInTheDocument();
});

it.each(["source", "translation", "review"] as ChangeScope[])("refreshes an active work query on %s changes without rebinding a captured reason", async scope => {
  const original = invoke.getMockImplementation()!;
  let workReads = 0;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_work"
    ? Promise.resolve(workPage(++workReads === 1 ? targets.first : targets.second)) : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep captured reason");
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
  await refreshWorkbenchReads([scope]);
  await waitFor(() => expect(workReads).toBe(2));
  expect(await screen.findByRole("button", { name: "second" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("checkbox", { name: "Approve selected entries: first" })).toBeChecked();
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep captured reason");
});

it("retries the failed work page at its requested cursor and can return to the first page", async () => {
  const original = invoke.getMockImplementation()!;
  let secondAttempts = 0;
  invoke.mockImplementation((command: string, args: { request: { offset?: number } }) => {
    if (command !== "read_review_work") return original(command, args);
    if (args.request.offset === 0) return Promise.resolve(workPage(targets.first, 1));
    if (++secondAttempts === 1) return Promise.reject(new Error("queue unavailable"));
    return Promise.resolve(workPage(targets.second));
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByText(/This action could not complete/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  await waitFor(() => expect(secondAttempts).toBe(2));
  expect(await screen.findByRole("button", { name: "second" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "First page" }));
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
});

it("resets the work cursor before reading a newly selected target language", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: { locale?: string; offset?: number } }) => {
    if (command === "read_review_work") return Promise.resolve(args.request.locale === "ja"
      ? workPage({ ...targets.second, locale: "ja" })
      : args.request.offset === 0 ? workPage(targets.first, 1) : workPage(targets.second));
    if (command === "read_review_summary_page" && args.request.locale === "ja") return reviewSummaryPageFixture([]);
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "1")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("button", { name: "second" })).toBeVisible();
  await user.selectOptions(screen.getByRole("combobox", { name: "Target language" }), "ja");
  await waitFor(() => expect(invoke.mock.calls.some(([command, args]) => command === "read_review_work"
    && args.request.locale === "ja" && args.request.offset === 0)).toBe(true));
  expect(invoke.mock.calls.filter(([command, args]) => command === "read_review_work"
    && args.request.locale === "ja" && args.request.offset !== 0)).toEqual([]);
  expect(screen.getByRole("button", { name: "second" })).toBeVisible();
});

it("does not carry a late review receipt into another project session", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "write_review_decision" ? reply : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Old session");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "write_review_decision")).toBe(true));
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  const next = { ...project, sessionToken: "session-2", metadata: { ...project.metadata, projectId: fixtureIdentity(800) } };
  view.rerender(null, next);
  view.rerender(<ReviewWorkbench project={next} disabled={false} onOpenTranslation={() => true} />, next);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("");
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument();
});

it("does not begin the next old-project batch write after its session closes", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return Promise.resolve(args.request.afterOrdinal === 0
      ? reviewSummaryPageFixture([reviewSummaryFor(targets.first)], { nextOrdinal: 1, total: 2 })
      : reviewSummaryPageFixture([reviewSummaryFor(targets.second)], { total: 2 }));
    if (command === "write_review_decision") return reply;
    return original(command, args);
  });
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: second" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("button", { name: "Approve selected entries (2)" }));
  await user.click(screen.getByRole("button", { name: "Confirm approvals" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1));
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  const next = { ...project, sessionToken: "session-2", metadata: { ...project.metadata, projectId: fixtureIdentity(800) } };
  view.rerender(null, next);
  view.rerender(<ReviewWorkbench project={next} disabled={false} onOpenTranslation={() => true} />, next);
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
});

it("preserves a newer reason draft while an approval is being saved", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "write_review_decision" ? pending : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "write_review_decision")).toBe(true));
  await user.type(reason, "B");
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  await waitFor(() => expect(reason).toHaveValue("AB"));
  const saved = invoke.mock.calls.find(([command]) => command === "write_review_decision")?.[1].request.decision;
  expect(saved).toMatchObject({ unitId: targets.first.unitId, expectedBasis: "basis-first", reason: "A", actor: "Reviewer A" });
});

it("keeps a later A reason after A to B to A edits while the original A is saving", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "write_review_decision" ? reply : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "write_review_decision")).toBe(true));
  await user.clear(reason);
  await user.type(reason, "B");
  await user.clear(reason);
  await user.type(reason, "A");
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  expect(reason).toHaveValue("A");
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1);
});

it("retains the original review action and newer reason when a confirmation belongs to another action", async () => {
  const original = invoke.getMockImplementation()!;
  let writes = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const response = await original(command, args);
    return command === "write_review_decision" && ++writes === 1 ? { ...response, actionId: fixtureIdentity(629) } : response;
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  const retry = await screen.findByRole("button", { name: "Retry the same action" });
  await user.type(reason, "B");
  await user.click(retry);
  await waitFor(() => expect(writes).toBe(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument());
  const requests = invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request);
  expect(requests[1]).toEqual(requests[0]);
  expect(reason).toHaveValue("AB");
  expect(invoke.mock.calls.filter(([command]) => command === "create_execution_identity")).toHaveLength(1);
});

it("uses fixed item bases for batch approval and reports a changed item separately", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") {
      return args.request.afterOrdinal === 0
        ? reviewSummaryPageFixture([reviewSummaryFor(targets.first)], { nextOrdinal: 1, total: 2 })
        : reviewSummaryPageFixture([reviewSummaryFor(targets.second)], { total: 2 });
    }
    if (command === "write_review_decision" && (args.request.decision as { unitId: string }).unitId === targets.second.unitId) {
      throw { code: "dependency-conflict", outcome: "rejected", stage: "execution-read", recoveryRequired: false, reason: "review-current" };
    }
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: second" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("button", { name: "Approve selected entries (2)" }));
  await user.click(screen.getByRole("button", { name: "Confirm approvals" }));
  await waitFor(() => expect(screen.getByText(/1 recorded, 1 changed, 0 not confirmed/)).toBeInTheDocument());
  const writes = invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request.decision);
  expect(writes.map((value: { unitId: string; expectedBasis: string }) => [value.unitId, value.expectedBasis]))
    .toEqual([[targets.first.unitId, "basis-first"], [targets.second.unitId, "basis-second"]]);
});

it("stops a batch after the in-flight approval and keeps later entries selected", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") {
      return Promise.resolve(args.request.afterOrdinal === 0
        ? reviewSummaryPageFixture([reviewSummaryFor(targets.first)], { nextOrdinal: 1, total: 2 })
        : reviewSummaryPageFixture([reviewSummaryFor(targets.second)], { total: 2 }));
    }
    if (command === "write_review_decision") return pending;
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: second" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("button", { name: "Approve selected entries (2)" }));
  await user.click(screen.getByRole("button", { name: "Confirm approvals" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Stop after the current entry" }));
  const request = invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision;
  await act(async () => finish(reviewDecisionFixture(request, targets.first)));
  expect(await screen.findByText(/1 recorded, 0 changed, 0 not confirmed/)).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request.decision.unitId))
    .toEqual([targets.first.unitId]);
  expect(screen.getByRole("checkbox", { name: "Approve selected entries: second" })).toBeChecked();
});

it("shows a localized reason for each blocked language entry", async () => {
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("first: Run the current checks")).toBeInTheDocument();
  expect(screen.getByText("zh-CN: Build preparation blocked")).toBeInTheDocument();
});

it("waits for an explicit assessment of a nonempty language selection without capturing review work", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? Promise.resolve(eligibilityResult(args.request.locales!, "explicit-subset")) : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "1")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await screen.findByRole("button", { name: "first" });
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  expect(screen.getByRole("checkbox", { name: "zh-CN" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "ja" })).toBeChecked();
  expect(screen.getByText("Assess the selected languages to see their current build readiness.")).toBeVisible();
  await refreshWorkbenchReads(["source", "translation", "resources", "review", "project"]);
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility")).toHaveLength(0);
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  await user.click(screen.getByRole("checkbox", { name: "ja" }));
  expect(screen.getByText("Choose at least one language to assess.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Assess build readiness" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "ja" }));
  const beforeAssess = invoke.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("explicit-subset: Run the current checks")).toBeVisible();
  expect(invoke.mock.calls.slice(beforeAssess).map(([name]) => name)).toEqual(["read_review_eligibility"]);
  expect(invoke.mock.calls.find(([name]) => name === "read_review_eligibility")![1].request)
    .toEqual({ projectId: project.metadata.projectId, sessionToken: project.sessionToken, locales: ["ja"] });
  expect(screen.queryByText("zh-CN: Build preparation blocked")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility")).toHaveLength(2));
});

it("keeps the newly assessed languages when an older language selection returns late", async () => {
  let finishOld!: (value: unknown) => void;
  const oldAssessment = new Promise(resolve => { finishOld = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? args.request.locales!.length === 2 ? oldAssessment : Promise.resolve(eligibilityResult(args.request.locales!, "new-subset"))
    : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "1")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("Assessing current build readiness…")).toBeVisible();
  expect(screen.getByRole("button", { name: "Assess build readiness" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  expect(screen.queryByText("Assessing current build readiness…")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Assess build readiness" })).toBeEnabled();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("new-subset: Run the current checks")).toBeVisible();
  await act(async () => finishOld(eligibilityResult(["zh-CN", "ja"], "old-selection")));
  expect(screen.getByText("new-subset: Run the current checks")).toBeVisible();
  expect(screen.queryByText(/old-selection/)).not.toBeInTheDocument();
  expect(screen.queryByText("zh-CN: Build preparation blocked")).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility").map(([, args]) => args.request.locales))
    .toEqual([["zh-CN", "ja"], ["ja"]]);
});

it.each(["tab", "hidden"] as const)("releases an assessment wait when %s and reopens only its captured languages", async destination => {
  let rejectOld!: (error: unknown) => void;
  const oldAssessment = new Promise((_, reject) => { rejectOld = reject; });
  const original = invoke.getMockImplementation()!;
  let assessmentReads = 0;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? ++assessmentReads === 1 ? oldAssessment : Promise.resolve(eligibilityResult(args.request.locales!, "reopened-assessment"))
    : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "1")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await screen.findByRole("button", { name: "first" });
  if (destination === "tab") await user.click(screen.getByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  if (destination === "tab") await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep reason");
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("checkbox", { name: "ja" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  await waitFor(() => expect(assessmentReads).toBe(1));
  if (destination === "hidden") {
    await user.click(screen.getByRole("button", { name: "Back to overview" }));
    await refreshWorkbenchReads(["source"]);
    expect(assessmentReads).toBe(1);
    await user.click(screen.getByRole("button", { name: "Review and QA" }));
  } else {
    await user.click(screen.getByRole("tab", { name: "Review" }));
    expect(screen.getByRole("button", { name: "Refresh current evidence" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled();
    await refreshWorkbenchReads(["source"]);
    expect(assessmentReads).toBe(1);
    await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  }
  expect(await screen.findByText("reopened-assessment: Run the current checks")).toBeVisible();
  await act(async () => rejectOld(new Error("Old assessment unavailable")));
  expect(screen.getByText("reopened-assessment: Run the current checks")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("Reviewer A");
  expect(screen.getByRole("button", { name: "Refresh current evidence" })).toBeEnabled();
  if (destination === "tab") {
    expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep reason");
    expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled();
  }
  expect(screen.queryByText(/This action could not complete/)).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility").map(([, args]) => args.request.locales))
    .toEqual([["zh-CN"], ["zh-CN"]]);
});

it("retries a failed assessment at exactly its original language scope and keeps review feedback separate", async () => {
  const original = invoke.getMockImplementation()!;
  let assessmentReads = 0;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? ++assessmentReads === 1 ? Promise.reject(new Error("Assessment unavailable"))
      : Promise.resolve(eligibilityResult(args.request.locales!, "retried-assessment")) : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "1")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("button", { name: "Request changes" }));
  expect(await screen.findByText("Enter a reason for this action.")).toBeVisible();
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep validation reason");
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("checkbox", { name: "zh-CN" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Build readiness could not be assessed.");
  expect(screen.getByText("Enter a reason for this action.")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Can enter build preparation" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry assessment" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Retry assessment" }));
  expect(await screen.findByText("retried-assessment: Run the current checks")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility").map(([, args]) => args.request))
    .toEqual([{ projectId: project.metadata.projectId, sessionToken: project.sessionToken, locales: ["ja"] },
      { projectId: project.metadata.projectId, sessionToken: project.sessionToken, locales: ["ja"] }]);
  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep validation reason");
  expect(screen.getByRole("checkbox", { name: "Approve selected entries: first" })).toBeChecked();
  expect(screen.getByText("Enter a reason for this action.")).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity" || name === "write_review_decision")).toHaveLength(0);
});

it.each(["source", "translation", "resources", "review", "project"] as ChangeScope[])("refreshes an assessed scope on %s changes without recapturing review work or pending actions", async scope => {
  const original = invoke.getMockImplementation()!;
  let assessmentReads = 0;
  invoke.mockImplementation(async (command: string, args: { request: { locales?: string[] } }) => {
    if (command === "read_review_eligibility") return eligibilityResult(args.request.locales!, ++assessmentReads === 1 ? "initial-assessment" : "current-assessment");
    const response = await original(command, args);
    return command === "write_review_decision" ? { ...response, actionId: fixtureIdentity(629) } : response;
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await screen.findByRole("button", { name: "Retry the same action" });
  const originalRequest = invoke.mock.calls.find(([name]) => name === "write_review_decision")![1].request;
  await user.type(reason, "B");
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("initial-assessment: Run the current checks")).toBeVisible();
  targets.first = reviewTargetFixture({ ...targets.first, basisEvidence: undefined, basis: "changed-assessment-basis",
    sourceText: "Changed source", translationText: "Changed translation", sourceRevisionId: fixtureIdentity(690),
    selectionId: fixtureIdentity(691), revisionId: fixtureIdentity(692) });
  const beforeChange = invoke.mock.calls.length;
  await refreshWorkbenchReads([scope]);
  expect(await screen.findByText("current-assessment: Run the current checks")).toBeVisible();
  expect(invoke.mock.calls.slice(beforeChange).map(([name]) => name)).toEqual(["read_review_eligibility"]);
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility").map(([, args]) => args.request.locales))
    .toEqual([["zh-CN"], ["zh-CN"]]);
  expect(screen.getByRole("button", { name: "Retry the same action" })).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "Review" }));
  expect(screen.getByRole("textbox", { name: "Reviewer name" })).toHaveValue("Reviewer A");
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("AB");
  expect(screen.getByRole("checkbox", { name: "Approve selected entries: first" })).toBeChecked();
  expect(screen.queryByText("Changed source")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry the same action" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "write_review_decision")).toHaveLength(2));
  expect(invoke.mock.calls.filter(([name]) => name === "write_review_decision").map(([, args]) => args.request))
    .toEqual([originalRequest, originalRequest]);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("AB");
});

it("hides an old ready verdict while refreshed eligibility is loading or has failed", async () => {
  let rejectRefresh!: (error: unknown) => void;
  const refreshAssessment = new Promise((_, reject) => { rejectRefresh = reject; });
  const original = invoke.getMockImplementation()!;
  let assessmentReads = 0;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? ++assessmentReads === 1 ? Promise.resolve(eligibilityResult(args.request.locales!, "ready-assessment", true))
      : assessmentReads === 2 ? refreshAssessment : Promise.resolve(eligibilityResult(args.request.locales!, "blocked-after-refresh"))
    : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByRole("heading", { name: "Can enter build preparation" })).toBeVisible();
  await refreshWorkbenchReads(["translation"]);
  expect(await screen.findByText("Assessing current build readiness…")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Can enter build preparation" })).not.toBeInTheDocument();
  await act(async () => rejectRefresh(new Error("Current eligibility unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Build readiness could not be assessed.");
  expect(screen.queryByRole("heading", { name: "Can enter build preparation" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry assessment" }));
  expect(await screen.findByText("blocked-after-refresh: Run the current checks")).toBeVisible();
});

it("revokes a removed language capture without silently narrowing it or reviving it on restoration", async () => {
  let finishOld!: (value: unknown) => void;
  const oldAssessment = new Promise(resolve => { finishOld = resolve; });
  const original = invoke.getMockImplementation()!;
  let assessmentReads = 0;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? ++assessmentReads === 1 ? oldAssessment : Promise.resolve(eligibilityResult(args.request.locales!, "restored-explicit-assessment"))
    : original(command, args));
  const current = withLocales(["zh-CN", "ja"], "1");
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={current} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  await waitFor(() => expect(assessmentReads).toBe(1));
  view.rerender(<ReviewWorkbench project={withLocales(["zh-CN"], "2")} disabled={false} onOpenTranslation={() => true} />);
  await refreshWorkbenchReads(["project"]);
  expect(screen.getByText("Assess the selected languages to see their current build readiness.")).toBeVisible();
  expect(screen.queryByText("Assessing current build readiness…")).not.toBeInTheDocument();
  expect(assessmentReads).toBe(1);
  await act(async () => finishOld(eligibilityResult(["zh-CN", "ja"], "removed-language-assessment")));
  expect(screen.queryByText(/removed-language-assessment/)).not.toBeInTheDocument();
  view.rerender(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "3")} disabled={false} onOpenTranslation={() => true} />);
  await refreshWorkbenchReads(["project"]);
  expect(assessmentReads).toBe(1);
  expect(screen.getByRole("checkbox", { name: "zh-CN" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "ja" })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("restored-explicit-assessment: Run the current checks")).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility").map(([, args]) => args.request.locales))
    .toEqual([["zh-CN", "ja"], ["zh-CN"]]);
});

it("revokes an assessment through a target-language round trip before an old response returns", async () => {
  let finishOld!: (value: unknown) => void;
  const oldAssessment = new Promise(resolve => { finishOld = resolve; });
  const original = invoke.getMockImplementation()!;
  let assessmentReads = 0;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? ++assessmentReads === 1 ? oldAssessment : Promise.resolve(eligibilityResult(args.request.locales!, "explicit-after-round-trip"))
    : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={withLocales(["zh-CN", "ja"], "1")} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  await waitFor(() => expect(assessmentReads).toBe(1));
  const locale = screen.getByRole("combobox", { name: "Target language" });
  expect(locale).toBeEnabled();
  await user.selectOptions(locale, "ja");
  expect(screen.getByText("Assess the selected languages to see their current build readiness.")).toBeVisible();
  await user.selectOptions(locale, "zh-CN");
  await refreshWorkbenchReads(["project"]);
  expect(assessmentReads).toBe(1);
  await act(async () => finishOld(eligibilityResult(["zh-CN", "ja"], "old-round-trip-assessment")));
  expect(screen.queryByText(/old-round-trip-assessment/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Assess build readiness" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findAllByText("explicit-after-round-trip: Run the current checks")).toHaveLength(2);
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility").map(([, args]) => args.request.locales))
    .toEqual([["zh-CN", "ja"], ["zh-CN", "ja"]]);
});

it("requires a fresh explicit assessment after the Review consumer unmounts in the same session", async () => {
  let finishOld!: (value: unknown) => void;
  const oldAssessment = new Promise(resolve => { finishOld = resolve; });
  const original = invoke.getMockImplementation()!;
  let assessmentReads = 0;
  invoke.mockImplementation((command: string, args: { request: { locales?: string[] } }) => command === "read_review_eligibility"
    ? ++assessmentReads === 1 ? oldAssessment : Promise.resolve(eligibilityResult(args.request.locales!, "remounted-assessment"))
    : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  await waitFor(() => expect(assessmentReads).toBe(1));
  view.rerender(null, project);
  await act(async () => finishOld(eligibilityResult(["zh-CN"], "unmounted-assessment")));
  view.rerender(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  expect(screen.getByText("Assess the selected languages to see their current build readiness.")).toBeVisible();
  expect(screen.queryByText(/unmounted-assessment/)).not.toBeInTheDocument();
  expect(assessmentReads).toBe(1);
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("remounted-assessment: Run the current checks")).toBeVisible();
});

it("does not display another project session's late assessment", async () => {
  let finishOld!: (value: unknown) => void;
  const oldAssessment = new Promise(resolve => { finishOld = resolve; });
  const original = invoke.getMockImplementation()!;
  const next = { ...project, sessionToken: "session-2", metadata: { ...project.metadata, projectId: fixtureIdentity(800) } };
  invoke.mockImplementation((command: string, args: { request: { sessionToken?: string; locales?: string[] } }) => command === "read_review_eligibility"
    ? args.request.sessionToken === project.sessionToken ? oldAssessment : Promise.resolve(eligibilityResult(args.request.locales!, "next-session-assessment"))
    : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "read_review_eligibility")).toBe(true));
  view.rerender(null, next);
  view.rerender(<ReviewWorkbench project={next} disabled={false} onOpenTranslation={() => true} />, next);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(screen.getByRole("tab", { name: "Build readiness" }));
  expect(screen.getByText("Assess the selected languages to see their current build readiness.")).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Assess build readiness" }));
  expect(await screen.findByText("next-session-assessment: Run the current checks")).toBeVisible();
  await act(async () => finishOld(eligibilityResult(["zh-CN"], "old-session-assessment")));
  expect(screen.getByText("next-session-assessment: Run the current checks")).toBeVisible();
  expect(screen.queryByText(/old-session-assessment/)).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_eligibility").map(([, args]) => [args.request.projectId, args.request.sessionToken]))
    .toEqual([[project.metadata.projectId, project.sessionToken], [next.metadata.projectId, next.sessionToken]]);
});

it("keeps the review open when its translation editor cannot be opened", async () => {
  const user = userEvent.setup();
  const openEditor = vi.fn(() => false);
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={openEditor} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByRole("button", { name: "Open translation editor" }));
  expect(openEditor).toHaveBeenCalledOnce();
  expect(screen.getByRole("region", { name: "Review and QA" })).toBeInTheDocument();
  expect(screen.getByText("The translation editor is unavailable. Your review remains open.")).toBeInTheDocument();
});

it("shows historical check findings and exception reasons", async () => {
  targets.first.currentCheck = reviewCheckFixture(targets.first, fixtureIdentity(621));
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_history") return {
      decisions: [], nextOffset: null,
      checks: [reviewCheckFixture(targets.first, fixtureIdentity(622), "completed", {
        runId: fixtureIdentity(623), validatorVersion: "smapi-prebuild-1", createdAt: "2026-09-28", rules: [{ rule: "placeholders", status: "findings", reason: null,
          findings: [{ issueId: "old-issue", rule: "placeholders", code: "marker-mismatch", detail: "Names differ", severity: "error", waivable: false }] }],
      })],
      waivers: [{ waiverId: fixtureIdentity(624), actionId: fixtureIdentity(625), unitId: targets.first.unitId, locale: "zh-CN", basis: "basis-first",
        issueId: "old-issue", grant: true, previousWaiverId: null, policyVersion: "balanced-1", actor: "Reviewer A",
        reason: "Reviewed original wording", createdAt: "2026-09-28" }],
      fallbacks: [],
    };
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByText("Decision and check history"));
  expect(await screen.findByText("Named placeholders differ or are malformed")).toBeVisible();
  expect(screen.getByText(/Reviewed original wording/)).toBeVisible();
  expect(screen.getByText(/Deterministic check run · smapi-prebuild-1 · Earlier evidence/)).toBeVisible();
  expect(screen.getByText(/Reviewed original wording/)).toHaveTextContent("Earlier evidence");
});

it("keeps the selected target and reason editable when its history read fails, then retries history alone", async () => {
  const original = invoke.getMockImplementation()!;
  let unavailable = true;
  invoke.mockImplementation((command: string, args: unknown) => command === "read_review_history" && unavailable
    ? Promise.reject(new Error("History read unavailable")) : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const reason = await screen.findByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "Keep the captured reason");
  await user.click(screen.getByText("Decision and check history"));
  expect(await screen.findByRole("alert")).toHaveTextContent(/history/i);
  expect(reason).toHaveValue("Keep the captured reason");
  expect(screen.getByText("Hello")).toBeVisible();
  unavailable = false;
  await user.click(screen.getByRole("button", { name: "Retry history" }));
  expect(await screen.findByText("No earlier review or check evidence for this entry.")).toBeVisible();
  expect(reason).toHaveValue("Keep the captured reason");
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_target")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_history")).toHaveLength(2);
});

it("lets a newer target and Work continue while an older history page is pending", async () => {
  let releaseOld!: (value: unknown) => void;
  const oldHistory = new Promise(resolve => { releaseOld = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(targets.first), reviewSummaryFor(targets.second)]);
    if (command === "read_review_history") return args.request.unitId === targets.first.unitId
      ? oldHistory : historyPage(targets.second, "B-current-history");
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name, args]) => name === "read_review_history"
    && args.request.unitId === targets.first.unitId)).toBe(true));
  await user.click(screen.getByRole("tab", { name: "Work queue" }));
  expect(screen.getByRole("button", { name: "Refresh current evidence" })).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "second" }));
  await user.click(screen.getByText("Decision and check history"));
  expect(await screen.findByText(/B-current-history/)).toBeVisible();
  await act(async () => releaseOld(historyPage(targets.first, "A-old-history")));
  expect(screen.getByText(/B-current-history/)).toBeVisible();
  expect(screen.queryByText(/A-old-history/)).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("");
});

it("retries a failed history page at the same cursor and can return to page one without losing an unknown action", async () => {
  const original = invoke.getMockImplementation()!;
  let failSecondPage = true;
  let writes = 0;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_history") {
      if (args.request.offset === 20 && failSecondPage) throw new Error("Second history page unavailable");
      return historyPage(targets.first, args.request.offset === 20 ? "history-page-two" : "history-page-one",
        args.request.offset === 20 ? null : 20);
    }
    const response = await original(command, args);
    return command === "write_review_decision" && ++writes === 1
      ? { ...response, actionId: fixtureIdentity(629) } : response;
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await screen.findByRole("button", { name: "Retry the same action" });
  await user.type(reason, "B");
  await user.click(screen.getByText("Decision and check history"));
  const historyDetails = screen.getByText("Decision and check history").closest("details")!;
  expect(await screen.findByText(/history-page-one/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "More history" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/history/i);
  expect(within(historyDetails).getByRole("button", { name: "First page" })).toBeEnabled();
  expect(reason).toHaveValue("AB");
  expect(screen.getByRole("button", { name: "Retry the same action" })).toBeVisible();
  failSecondPage = false;
  await user.click(screen.getByRole("button", { name: "Retry history" }));
  expect(await screen.findByText(/history-page-two/)).toBeVisible();
  expect(invoke.mock.calls.filter(([name, args]) => name === "read_review_history" && args.request.offset === 20)).toHaveLength(2);
  await user.click(within(historyDetails).getByRole("button", { name: "First page" }));
  expect(await screen.findByText(/history-page-one/)).toBeVisible();
  expect(reason).toHaveValue("AB");
  expect(screen.getByRole("button", { name: "Retry the same action" })).toBeVisible();
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
});

it.each(["review", "project"] as const)("returns to current history after a %s change without rebinding the chosen entry or reason", async (scope) => {
  const original = invoke.getMockImplementation()!;
  let currentHistory = false;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_history") return historyPage(targets.first,
      args.request.offset === 20 ? "older-history-page" : currentHistory ? "latest-history" : "initial-history", args.request.offset === 20 ? null : 20);
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("checkbox", { name: "Approve selected entries: first" }));
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "Keep original basis");
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled();
  await user.click(screen.getByText("Decision and check history"));
  expect(await screen.findByText(/initial-history/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "More history" }));
  expect(await screen.findByText(/older-history-page/)).toBeVisible();
  currentHistory = true;
  const beforeChange = invoke.mock.calls.length;
  await refreshWorkbenchReads([scope]);
  expect(await screen.findByText(/latest-history/)).toBeVisible();
  expect(screen.queryByText(/older-history-page/)).not.toBeInTheDocument();
  expect(invoke.mock.calls.slice(beforeChange).some(([name, args]) => name === "read_review_history"
    && args.request.unitId === targets.first.unitId && args.request.locale === "zh-CN"
    && args.request.offset === 0 && args.request.limit === 20)).toBe(true);
  expect(screen.getByRole("checkbox", { name: "Approve selected entries: first" })).toBeChecked();
  expect(reason).toHaveValue("Keep original basis");
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled();
});

it("refreshes the selected target even if the accompanying history refresh fails", async () => {
  const original = invoke.getMockImplementation()!;
  let failHistory = false;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_review_history" && failHistory) return Promise.reject(new Error("History refresh unavailable"));
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name]) => name === "read_review_history")).toBe(true));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "Reason for old evidence");
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled();
  targets.first = reviewTargetFixture({ ...targets.first, basisEvidence: undefined, basis: "new-history-refresh-basis",
    revisionId: fixtureIdentity(626), translationText: "New translation after refresh" });
  failHistory = true;
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  expect(await screen.findByText("New translation after refresh")).toBeVisible();
  await user.click(screen.getByText("Decision and check history"));
  expect(await screen.findByRole("alert")).toHaveTextContent(/history/i);
  expect(screen.getByRole("button", { name: "Retry history" })).toBeEnabled();
  expect(reason).toHaveValue("Reason for old evidence");
  expect(screen.getByText("Earlier content")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
});

it("returns to current history after a check completes even if that history read fails", async () => {
  const original = invoke.getMockImplementation()!;
  let failAfterCheck = false;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_history") {
      if (args.request.offset === 0 && failAfterCheck) return Promise.reject(new Error("Latest history unavailable"));
      return historyPage(targets.first, args.request.offset === 20 ? "older-check-history" : "initial-check-history",
        args.request.offset === 20 ? null : 20);
    }
    if (command === "run_review_checks") {
      const check = reviewCheckFixture(targets.first, args.request.actionId as string);
      targets.first = { ...targets.first, currentCheck: check };
      return check;
    }
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "Keep this check reason");
  await user.click(screen.getByText("Decision and check history"));
  expect(await screen.findByText(/initial-check-history/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "More history" }));
  expect(await screen.findByText(/older-check-history/)).toBeVisible();
  const beforeCheck = invoke.mock.calls.length;
  failAfterCheck = true;
  await user.click(screen.getByRole("button", { name: "Run current checks" }));
  await waitFor(() => expect(invoke.mock.calls.slice(beforeCheck).some(([name, args]) => name === "read_review_history"
    && args.request.offset === 0)).toBe(true));
  expect(await screen.findByRole("alert")).toHaveTextContent(/history/i);
  expect(screen.getByRole("button", { name: "Retry history" })).toBeEnabled();
  expect(invoke.mock.calls.slice(beforeCheck).some(([name, args]) => name === "read_review_history"
    && args.request.unitId === targets.first.unitId && args.request.locale === "zh-CN"
    && args.request.offset === 0 && args.request.limit === 20)).toBe(true);
  expect(reason).toHaveValue("Keep this check reason");
  expect(screen.queryByRole("button", { name: "Retry the same action" })).not.toBeInTheDocument();
});

it("does not display an old session's late history after the Review consumer reopens for another project", async () => {
  let releaseOld!: (value: unknown) => void;
  const oldHistory = new Promise(resolve => { releaseOld = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => command === "read_review_history"
    ? args.request.sessionToken === project.sessionToken ? oldHistory : historyPage(targets.first, "new-session-history")
    : original(command, args));
  const user = userEvent.setup();
  const view = render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />, project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await waitFor(() => expect(invoke.mock.calls.some(([name, args]) => name === "read_review_history"
    && args.request.sessionToken === project.sessionToken)).toBe(true));
  const next = { ...project, sessionToken: "another-session", metadata: { ...project.metadata, projectId: fixtureIdentity(800) } };
  view.rerender(null, next);
  view.rerender(<ReviewWorkbench project={next} disabled={false} onOpenTranslation={() => true} />, next);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByText("Decision and check history"));
  expect(await screen.findByText(/new-session-history/)).toBeVisible();
  await act(async () => releaseOld(historyPage(targets.first, "old-session-history")));
  expect(screen.getByText(/new-session-history/)).toBeVisible();
  expect(screen.queryByText(/old-session-history/)).not.toBeInTheDocument();
  expect(invoke.mock.calls.filter(([name]) => name === "read_review_history").map(([, args]) => args.request.sessionToken))
    .toEqual(expect.arrayContaining([project.sessionToken, next.sessionToken]));
});

it("requests cancellation for the active check and reports its persisted outcome", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "run_review_checks") return pending;
    if (command === "cancel_review_checks") return Promise.resolve(true);
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByRole("button", { name: "Run current checks" }));
  await user.click(await screen.findByRole("button", { name: "Cancel current check" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "cancel_review_checks")).toBe(true));
  const checkRequest = invoke.mock.calls.find(([command]) => command === "run_review_checks")?.[1].request;
  const cancelRequest = invoke.mock.calls.find(([command]) => command === "cancel_review_checks")?.[1].request;
  expect(cancelRequest).toMatchObject({ actionId: checkRequest.actionId, projectId: project.metadata.projectId, sessionToken: "session" });
  await act(async () => finish(reviewCheckFixture(targets.first, checkRequest.actionId, "cancelled")));
  expect(await screen.findByText("The check was cancelled before completion. Run it again for current coverage.")).toBeInTheDocument();
});

it("does not present a late check reply as current after the selected revision changes", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "run_review_checks" ? pending : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.click(screen.getByRole("button", { name: "Run current checks" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "run_review_checks")).toBe(true));
  const checkedTarget = targets.first;
  const checkRequest = invoke.mock.calls.find(([command]) => command === "run_review_checks")![1].request;
  targets.first = reviewTargetFixture({ ...targets.first, basisEvidence: undefined, basis: "new-basis", revisionId: fixtureIdentity(626), translationText: "新译文", currentCheck: null });
  await act(async () => finish(reviewCheckFixture(checkedTarget, checkRequest.actionId)));
  expect(await screen.findByText("新译文")).toBeVisible();
  expect(screen.getByText("Current checks have not run or are stale.")).toBeVisible();
});

it("keeps a newer reason while late QA for an older basis stays out of current checks", async () => {
  let finish!: (value: unknown) => void;
  const reply = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "run_review_checks" ? reply : original(command, args));
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Run current checks" }));
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "run_review_checks")).toBe(true));
  await user.type(reason, "B");
  const checked = targets.first;
  const actionId = invoke.mock.calls.find(([command]) => command === "run_review_checks")![1].request.actionId;
  targets.first = reviewTargetFixture({ ...targets.first, basisEvidence: undefined, basis: "new-basis",
    revisionId: fixtureIdentity(626), translationText: "新译文", currentCheck: null });
  await act(async () => finish(reviewCheckFixture(checked, actionId)));
  expect(await screen.findByText("新译文")).toBeVisible();
  expect(reason).toHaveValue("AB");
  expect(screen.getByText("Current checks have not run or are stale.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
});

it("does not rebind a reason typed while a clean refresh waits for a newer basis", async () => {
  let finish!: (value: ReviewTarget) => void;
  const reply = new Promise<ReviewTarget>(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  let reads = 0;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_review_target" && ++reads === 2) return reply;
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  await waitFor(() => expect(reads).toBe(2));
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "B");
  const newer = reviewTargetFixture({ ...targets.first, basisEvidence: undefined, basis: "new-basis",
    revisionId: fixtureIdentity(626), translationText: "新译文", currentCheck: null });
  await act(async () => finish(newer));
  expect(reason).toHaveValue("B");
  expect(await screen.findByText("新译文")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(0);
});

it("keeps a reason on its original target through another unit until current content is explicitly adopted", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(targets.first), reviewSummaryFor(targets.second)]);
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason B");
  targets.first = reviewTargetFixture({ ...targets.first, basisEvidence: undefined, basis: "new-basis",
    revisionId: fixtureIdentity(626), translationText: "新译文", currentCheck: null });
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  expect(await screen.findByText("新译文")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "second" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "second" }));
  await user.click(screen.getByRole("button", { name: "first" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
  expect(screen.getByText("Earlier content")).toBeVisible();
  expect(screen.getByText("Current content")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Use current content and keep reason" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(1));
  expect(invoke.mock.calls.find(([command]) => command === "write_review_decision")![1].request.decision)
    .toMatchObject({ expectedBasis: "new-basis", reason: "Reason B" });
});

it("updates a captured reason with a same-basis batch decision before a later single decision", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(targets.first), reviewSummaryFor(targets.second)]);
    const response = await original(command, args);
    if (command === "write_review_decision") targets.first = { ...targets.first, currentDecision: response };
    return response;
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("checkbox", { name: "Approve selected entries: first" }));
  await user.click(screen.getByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason B");
  await user.click(screen.getByRole("button", { name: "Approve selected entries (1)" }));
  await user.click(screen.getByRole("button", { name: "Confirm approvals" }));
  await waitFor(() => expect(targets.first.currentDecision).not.toBeNull());
  const firstReceipt = targets.first.currentDecision!;
  await waitFor(() => expect(screen.getByRole("button", { name: "second" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "second" }));
  await user.click(screen.getByRole("button", { name: "first" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision")).toHaveLength(2));
  const requests = invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request.decision);
  expect(requests[1]).toMatchObject({ expectedBasis: "basis-first", expectedDecisionId: firstReceipt.decisionId, reason: "Reason B" });
});

it("keeps an old reason basis after direct reselection and a target-language round trip", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page" && args.request.locale === "ja") return reviewSummaryPageFixture([]);
    return original(command, args);
  });
  const user = userEvent.setup();
  const multiLocale = withLocales(["zh-CN", "ja"], "1");
  render(<ReviewWorkbench project={multiLocale} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason B");
  targets.first = reviewTargetFixture({ ...targets.first, basisEvidence: undefined, basis: "new-basis",
    revisionId: fixtureIdentity(626), translationText: "新译文", currentCheck: null });
  await user.click(screen.getByRole("button", { name: "first" }));
  expect(await screen.findByText("新译文")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Target language" })).toBeEnabled());
  await user.selectOptions(screen.getByRole("combobox", { name: "Target language" }), "ja");
  await user.selectOptions(screen.getByRole("combobox", { name: "Target language" }), "zh-CN");
  await user.click(await screen.findByRole("button", { name: "first" }));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
  expect(screen.getByText("Earlier content")).toBeVisible();
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
});

it("releases a cancelled view read after back navigation so the retained draft can recover", async () => {
  let finish!: (value: ReviewTarget) => void;
  const reply = new Promise<ReviewTarget>(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  let reads = 0;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "read_review_target" && ++reads === 2) return reply;
    return original(command, args);
  });
  const user = userEvent.setup();
  render(<ReviewWorkbench project={project} disabled={false} onOpenTranslation={() => true} />);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep for later");
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  await waitFor(() => expect(reads).toBe(2));
  await user.click(screen.getByRole("button", { name: "Back to overview" }));
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await act(async () => finish(targets.first));
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep for later");
  expect(screen.getByRole("button", { name: "Refresh current evidence" })).toBeEnabled();
});
