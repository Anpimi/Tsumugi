import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewWorkbench } from "./ReviewWorkbench";
import type { ProjectView } from "./projectCommands";
import type { ReviewTarget } from "./reviewCommands";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const project: ProjectView = {
  sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled",
  metadata: { projectId: "project", displayName: "Demo", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
};
const makeTarget = (unitId: string): ReviewTarget => ({
  unitId, locale: "zh-CN", nativeKey: unitId, sourceSnapshotId: "snapshot", sourceRevisionId: `source-${unitId}`,
  sourceText: "Hello", selectionId: `selection-${unitId}`, revisionId: `revision-${unitId}`,
  translationText: "你好", basis: `basis-${unitId}`, termConflict: false,
  currentDecision: null, currentCheck: null, currentFallback: null, currentWaivers: [],
});

let targets: Record<string, ReviewTarget>;
let nextIdentity: number;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  targets = { first: makeTarget("first"), second: makeTarget("second") };
  nextIdentity = 0;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_page") return { rows: [targets.first], nextOrdinal: null, total: 1 };
    if (command === "read_review_target") return targets[args.request.unitId as string];
    if (command === "read_review_history") return { decisions: [], checks: [], waivers: [], fallbacks: [], nextOffset: null };
    if (command === "create_execution_identity") return `action-${++nextIdentity}`;
    if (command === "write_review_decision") return { decisionId: "decision", ...(args.request.decision as object) };
    if (command === "read_review_work") return { items: [], total: 0, nextOffset: null, coverage: "current" };
    if (command === "read_review_eligibility") return { policyVersion: "balanced-1", sourceSnapshotId: "snapshot", basis: "eligibility",
      ready: false, locales: [{ locale: "zh-CN", ready: false, blockers: [{ unitId: "first", nativeKey: "first", code: "qa-missing-or-stale", reference: null }],
        exceptions: [], checkedUnits: 1, blockerCount: 1, exceptionCount: 0 }] };
    throw new Error(command);
  });
});
afterEach(cleanup);

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
  await act(async () => finish({ decisionId: "decision" }));
  await waitFor(() => expect(reason).toHaveValue("AB"));
  const saved = invoke.mock.calls.find(([command]) => command === "write_review_decision")?.[1].request.decision;
  expect(saved).toMatchObject({ unitId: "first", expectedBasis: "basis-first", reason: "A", actor: "Reviewer A" });
});

it("uses fixed item bases for batch approval and reports a changed item separately", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_page") {
      return args.request.afterOrdinal === 0
        ? { rows: [targets.first], nextOrdinal: 1, total: 2 }
        : { rows: [targets.second], nextOrdinal: null, total: 2 };
    }
    if (command === "write_review_decision" && (args.request.decision as { unitId: string }).unitId === "second") {
      throw { code: "dependency-conflict", field: "review-current" };
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
    .toEqual([["first", "basis-first"], ["second", "basis-second"]]);
});

it("stops a batch after the in-flight approval and keeps later entries selected", async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_page") {
      return Promise.resolve(args.request.afterOrdinal === 0
        ? { rows: [targets.first], nextOrdinal: 1, total: 2 }
        : { rows: [targets.second], nextOrdinal: null, total: 2 });
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
  await act(async () => finish({ decisionId: "decision" }));
  expect(await screen.findByText(/1 recorded, 0 changed, 0 not confirmed/)).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([command]) => command === "write_review_decision").map(([, args]) => args.request.decision.unitId))
    .toEqual(["first"]);
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
  targets.first.currentCheck = { runId: "new-check", actionId: "new-action", unitId: "first", locale: "zh-CN",
    basis: "basis-first", validatorVersion: "smapi-prebuild-2", outcome: "completed", createdAt: "2026-09-29", rules: [] };
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_history") return {
      decisions: [], nextOffset: null,
      checks: [{ runId: "old-check", actionId: "action", unitId: "first", locale: "zh-CN", basis: "basis-first",
        validatorVersion: "smapi-prebuild-1", createdAt: "2026-09-28", rules: [{ rule: "placeholders", status: "findings", reason: null,
          findings: [{ issueId: "old-issue", rule: "placeholders", code: "marker-mismatch", detail: "Names differ", severity: "error", waivable: false }] }] }],
      waivers: [{ waiverId: "waiver", actionId: "action", unitId: "first", locale: "zh-CN", basis: "basis-first",
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
  expect(cancelRequest).toMatchObject({ actionId: checkRequest.actionId, projectId: "project", sessionToken: "session" });
  await act(async () => finish({ outcome: "cancelled" }));
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
  targets.first = { ...targets.first, basis: "new-basis", revisionId: "new-revision", translationText: "新译文", currentCheck: null };
  await act(async () => finish({ outcome: "completed" }));
  expect(await screen.findByText("新译文")).toBeVisible();
  expect(screen.getByText("Current checks have not run or are stale.")).toBeVisible();
});
