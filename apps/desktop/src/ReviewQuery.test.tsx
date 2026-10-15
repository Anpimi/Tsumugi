import { createRef, useLayoutEffect, type RefObject } from "react";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewWorkbench, type ReviewHandle } from "./ReviewWorkbench";
import { useReviewDraftSession } from "./ReviewDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import type { ProjectView } from "./projectCommands";
import type { ReviewTarget, ReviewWrite } from "./reviewCommands";
import type { ChangeScope } from "./sessionReads";
import { i18n } from "./i18n";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { reviewFindingViewFixture, reviewTargetFixture, reviewSummaryFor, reviewSummaryPageFixture, reviewDecisionFixture } from "./testSupport/reviewFixture";
import { renderWorkbench as render, refreshWorkbenchReads } from "./testSupport/WorkbenchTestShell";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = {
  sessionToken: "review-query-session", locator: "C:\\isolated\\review-query", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(600), displayName: "Review query", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" },
};
const scopeId = fixtureIdentity(609);
let target: ReviewTarget;
let second: ReviewTarget;
let owner: ReturnType<typeof useReviewDraftSession>;
let reads: ReturnType<typeof useSessionReads>;
function Probe() {
  const currentOwner = useReviewDraftSession(), currentReads = useSessionReads();
  useLayoutEffect(() => { owner = currentOwner; reads = currentReads; });
  return null;
}
function consumer(current = project, ref?: RefObject<ReviewHandle | null>) {
  return <><ReviewWorkbench project={current} disabled={false} onOpenTranslation={() => true} ref={ref} /><Probe /></>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function calls(name: string) { return invoke.mock.calls.filter(([command]) => command === name); }
function currentQueryTarget() { return reads.client.getQueryData<ReviewTarget>(reads.key(["review-target", target.unitId, "zh-CN"])); }
async function selectFirst(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await user.click(await screen.findByRole("button", { name: "first" }));
  await screen.findByRole("textbox", { name: "Reason or evidence" });
  await user.type(screen.getByRole("textbox", { name: "Reviewer name" }), "Reviewer A");
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  target = reviewTargetFixture({ sourceText: "Original source", translationText: "Original translation" });
  second = reviewTargetFixture({ unitId: fixtureIdentity(611), nativeKey: "second", sourceRevisionId: fixtureIdentity(612),
    selectionId: fixtureIdentity(613), revisionId: fixtureIdentity(614), basis: "basis-second" });
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_summary_page") return reviewSummaryPageFixture([reviewSummaryFor(target)], { scopeId });
    if (command === "read_review_target") return args.request.unitId === target.unitId ? target : second;
    if (command === "read_review_findings") return reviewFindingViewFixture(args.request.unitId === target.unitId ? target : second);
    if (command === "read_plugin_text_reviews") return { settingsRevision: "1", entries: [] };
    if (command === "read_review_history") return { decisions: [], checks: [], waivers: [], fallbacks: [], nextOffset: null };
    if (command === "create_execution_identity") return fixtureIdentity(620);
    if (command === "write_review_decision") return reviewDecisionFixture(args.request.decision as ReviewWrite, target);
    if (command === "read_review_work") return { items: [], total: 0, nextOffset: null, coverage: "current" };
    throw new Error(command);
  });
});
afterEach(cleanup);

it.each(["source", "translation", "resources", "review", "project"] as ChangeScope[])(
  "rereads the original summary scope and current target on %s without adopting its newer basis", async scope => {
    const user = userEvent.setup();
    render(consumer(), project);
    await selectFirst(user);
    await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason B");
    await user.click(screen.getByRole("checkbox", { name: "Approve selected entries: first" }));
    const captured = owner.current().selected, chosen = owner.current().chosen;
    target = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "new-basis", revisionId: fixtureIdentity(626), translationText: "Current changed translation" });
    await refreshWorkbenchReads([scope]);
    await waitFor(() => expect(currentQueryTarget()?.translationText).toBe("Current changed translation"));
    expect(screen.getByText("Original source")).toBeVisible();
    expect(screen.getByText("Original translation")).toBeVisible();
    expect(screen.queryByText("Current changed translation")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "View current evidence" }));
    expect(await screen.findByText("Current changed translation")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
    expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
    expect(owner.current().selected).toBe(captured);
    expect(owner.current().projection?.basis).toBe("basis-first");
    expect(owner.current().chosen).toBe(chosen);
    const summaryRequests = calls("read_review_summary_page").map(([, args]) => args.request);
    expect(summaryRequests.filter(request => request.scopeId === null)).toHaveLength(1);
    expect(summaryRequests.slice(1)).toEqual(expect.arrayContaining([expect.objectContaining({ locale: "zh-CN", scopeId, query: "", afterOrdinal: 0, limit: 50 })]));
    await user.click(screen.getByRole("button", { name: "Use current content and keep reason" }));
    expect(owner.current().selected?.basis).toBe("new-basis");
    expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
    expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled();
  },
);

it("retries a failed summary page at the same scope and cursor without allocating another capture", async () => {
  const original = invoke.getMockImplementation()!;
  let failed = true;
  invoke.mockImplementation((name: string, args: { request: Record<string, unknown> }) => {
    if (name === "read_review_summary_page") {
      if (args.request.afterOrdinal === 0) return Promise.resolve(reviewSummaryPageFixture([reviewSummaryFor(target)], { scopeId, nextOrdinal: 1, total: 2 }));
      return failed ? Promise.reject(new Error("Summary page unavailable")) : Promise.resolve(reviewSummaryPageFixture([reviewSummaryFor(second)], { scopeId, total: 2 }));
    }
    return original(name, args);
  });
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep original reason");
  await user.click(screen.getByRole("button", { name: "Next page" }));
  const alert = await screen.findByRole("alert");
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep original reason");
  failed = false;
  await user.click(within(alert).getByRole("button", { name: "Retry current information" }));
  expect(await screen.findByRole("button", { name: "second" })).toBeVisible();
  const requests = calls("read_review_summary_page").map(([, args]) => args.request);
  expect(requests).toHaveLength(3);
  expect(requests.slice(1)).toEqual([expect.objectContaining({ scopeId, afterOrdinal: 1 }), expect.objectContaining({ scopeId, afterOrdinal: 1 })]);
  await user.click(screen.getAllByRole("button", { name: "First page" })[0]);
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
  expect(calls("read_review_summary_page").filter(([, args]) => args.request.scopeId === null)).toHaveLength(1);
});

it("retains the exact scope and draft through hidden semantic invalidation and consumer remount", async () => {
  const user = userEvent.setup();
  const view = render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Kept across regions");
  const capture = owner.current().selected;
  view.rerender(<Probe />, project);
  const before = calls("read_review_summary_page").length;
  target = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "hidden-new-basis", revisionId: fixtureIdentity(626), translationText: "Changed while hidden" });
  await refreshWorkbenchReads(["translation"]);
  expect(calls("read_review_summary_page")).toHaveLength(before);
  view.rerender(consumer(), project);
  await waitFor(() => expect(currentQueryTarget()?.translationText).toBe("Changed while hidden"));
  expect(screen.getByText("Original translation")).toBeVisible();
  expect(screen.queryByText("Changed while hidden")).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "View current evidence" }));
  expect(await screen.findByText("Changed while hidden")).toBeVisible();
  expect(owner.current().selected).toBe(capture);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Kept across regions");
  expect(calls("read_review_summary_page").filter(([, args]) => args.request.scopeId === null)).toHaveLength(1);
  expect(calls("read_review_summary_page").at(-1)![1].request.scopeId).toBe(scopeId);
});

it("ignores a pre-unmount target read after the same consumer returns and rereads its current target", async () => {
  const original = invoke.getMockImplementation()!;
  const old = deferred<ReviewTarget>();
  let targetReads = 0;
  invoke.mockImplementation((name: string, args: unknown) => name === "read_review_target" && ++targetReads === 2 ? old.promise : original(name, args));
  const user = userEvent.setup();
  const view = render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "B survives old read");
  const captured = target;
  await refreshWorkbenchReads(["translation"]);
  await waitFor(() => expect(targetReads).toBe(2));
  view.rerender(<Probe />, project);
  target = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "remount-basis", revisionId: fixtureIdentity(626), translationText: "New remount content" });
  view.rerender(consumer(), project);
  await waitFor(() => expect(currentQueryTarget()?.translationText).toBe("New remount content"));
  expect(screen.getByText("Original translation")).toBeVisible();
  expect(screen.queryByText("New remount content")).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "View current evidence" }));
  expect(await screen.findByText("New remount content")).toBeVisible();
  await act(async () => old.resolve({ ...captured, translationText: "Old late content" }));
  expect(screen.queryByText("Old late content")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("B survives old read");
  expect(owner.current().selected?.basis).toBe("basis-first");
});

it("keeps a confirmed save and newer B after the current target read fails, then retries only that read", async () => {
  const original = invoke.getMockImplementation()!;
  const saved = deferred<unknown>();
  let failTarget = false;
  invoke.mockImplementation((name: string, args: unknown) => name === "write_review_decision" ? saved.promise
    : name === "read_review_target" && failTarget ? Promise.reject(new Error("Current target unavailable")) : original(name, args));
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(calls("write_review_decision")).toHaveLength(1));
  await user.clear(reason); await user.type(reason, "B");
  const request = calls("write_review_decision")[0][1].request.decision as ReviewWrite;
  const receipt = reviewDecisionFixture(request, target);
  target = { ...target, currentDecision: receipt }; failTarget = true;
  await act(async () => saved.resolve(receipt));
  const alert = await screen.findByRole("alert");
  expect(screen.getByText("The action was recorded. Earlier evidence remains in project history.")).toBeVisible();
  expect(reason).toHaveValue("B");
  expect(owner.current().pending).toBeNull();
  expect(owner.current().selected?.currentDecision?.decisionId).toBe(receipt.decisionId);
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  const summaries = calls("read_review_summary_page").length;
  failTarget = false;
  await user.click(within(alert).getByRole("button", { name: "Retry current information" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeEnabled());
  expect(calls("read_review_summary_page")).toHaveLength(summaries);
  expect(calls("write_review_decision")).toHaveLength(1);
  expect(reason).toHaveValue("B");
  expect(screen.getByText("The action was recorded. Earlier evidence remains in project history.")).toBeVisible();
});

it.each(["basis", "failure", "refresh", "hidden", "retired", "replaced"] as const)("does not dispatch a fresh action after its identity wait loses %s proof", async change => {
  const original = invoke.getMockImplementation()!;
  const identity = deferred<string>();
  let failTarget = false;
  invoke.mockImplementation((name: string, args: unknown) => name === "create_execution_identity" ? identity.promise
    : name === "read_review_target" && failTarget ? Promise.reject(new Error("Target proof unavailable")) : original(name, args));
  const user = userEvent.setup();
  const view = render(consumer(), project);
  await selectFirst(user);
  const capturedOwner = owner;
  const captured = owner.current().selected;
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  await user.clear(screen.getByRole("textbox", { name: "Reason or evidence" }));
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "B");
  if (change === "basis") {
    target = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "identity-new-basis", revisionId: fixtureIdentity(626), translationText: "Changed during identity" });
    await refreshWorkbenchReads(["translation"]);
    await waitFor(() => expect(currentQueryTarget()?.translationText).toBe("Changed during identity"));
    expect(screen.queryByText("Changed during identity")).not.toBeInTheDocument();
    expect(screen.getByText("Original translation")).toBeVisible();
  } else if (change === "failure") {
    failTarget = true; await refreshWorkbenchReads(["translation"]); await screen.findByRole("alert");
  } else if (change === "refresh") {
    await refreshWorkbenchReads(["review"]);
    await waitFor(() => expect(reads.client.getQueryState(reads.key(["review-target", target.unitId, "zh-CN"]))?.dataUpdateCount).toBe(2));
  } else if (change === "hidden") view.rerender(<Probe />, project);
  else if (change === "replaced") {
    const next = { ...project, sessionToken: "replacement-query-session" };
    view.rerender(consumer(next), next);
  }
  else act(() => reads.retire());
  await act(async () => identity.resolve(fixtureIdentity(620)));
  expect(calls("write_review_decision")).toHaveLength(0);
  expect(capturedOwner.current().selected).toBe(captured);
  expect(capturedOwner.current().drafts["zh-CN:" + target.unitId]).toBe("B");
  expect(capturedOwner.current().pending).toBeNull();
  if (change === "replaced") expect(owner.current().selected).toBeNull();
});

it("waits for a fresh same-target reselection and preserves the original capture if it fails", async () => {
  const original = invoke.getMockImplementation()!;
  const fresh = deferred<ReviewTarget>();
  let targetReads = 0;
  invoke.mockImplementation((name: string, args: unknown) => name === "read_review_target" && ++targetReads === 2 ? fresh.promise : original(name, args));
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep fixed capture");
  const captured = owner.current().selected;
  await user.click(screen.getByRole("button", { name: "first" }));
  await waitFor(() => expect(targetReads).toBe(2));
  expect(owner.current().selected).toBe(captured);
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  await act(async () => fresh.reject(new Error("Fresh selection failed")));
  await screen.findByRole("alert");
  expect(owner.current().selected).toBe(captured);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep fixed capture");
  expect(calls("create_execution_identity")).toHaveLength(0);
});

it("keeps the original unknown request retryable while the current target query is unavailable", async () => {
  const original = invoke.getMockImplementation()!;
  let writes = 0, failTarget = false;
  invoke.mockImplementation(async (name: string, args: unknown) => {
    if (name === "read_review_target" && failTarget) throw new Error("Target unavailable during recovery");
    const result = await original(name, args);
    return name === "write_review_decision" && ++writes === 1 ? { ...result, actionId: fixtureIdentity(629) } : result;
  });
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "Original A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  const retry = await screen.findByRole("button", { name: "Retry the same action" });
  const request = calls("write_review_decision")[0][1].request;
  await user.clear(reason); await user.type(reason, "New B");
  failTarget = true;
  await refreshWorkbenchReads(["translation"]);
  await screen.findByRole("alert");
  expect(retry).toBeEnabled();
  expect(owner.current().pending?.request.actionId).toBe(request.decision.actionId);
  await user.click(retry);
  await waitFor(() => expect(owner.current().pending).toBeNull());
  expect(calls("write_review_decision")).toHaveLength(2);
  expect(calls("write_review_decision")[1][1].request).toEqual(request);
  expect(reason).toHaveValue("New B");
  expect(screen.getByText("The action was recorded. Earlier evidence remains in project history.")).toBeVisible();
});

it("keeps dirty leave recovery available while only a current target query is waiting", async () => {
  const original = invoke.getMockImplementation()!;
  const pending = deferred<ReviewTarget>();
  let targetReads = 0;
  invoke.mockImplementation((name: string, args: unknown) => name === "read_review_target" && ++targetReads === 2 ? pending.promise : original(name, args));
  const user = userEvent.setup();
  const ref = createRef<ReviewHandle>();
  render(consumer(project, ref), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep draft while reading");
  await refreshWorkbenchReads(["translation"]);
  await waitFor(() => expect(targetReads).toBe(2));
  expect(owner.inFlight()).toBe(false);
  expect(screen.getByRole("button", { name: "Approve selected revision" })).toBeDisabled();
  let leave!: Promise<boolean>;
  act(() => { leave = ref.current!.allowLeave(); });
  const dialog = await screen.findByRole("dialog", { name: "Leave with an unfinished review?" });
  await user.click(within(dialog).getByRole("button", { name: "Stay and keep work" }));
  await expect(leave).resolves.toBe(false);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep draft while reading");
  await act(async () => pending.resolve(target));
});

it("keeps an expired summary capture until explicit refresh allocates its replacement", async () => {
  const original = invoke.getMockImplementation()!;
  const replacement = fixtureIdentity(619);
  let expired = false;
  invoke.mockImplementation((name: string, args: { request: Record<string, unknown> }) => {
    if (name === "read_review_summary_page") {
      if (expired && args.request.scopeId === scopeId) return Promise.reject({ code: "dependency-conflict", reason: "review-scope-source-changed" });
      return Promise.resolve(reviewSummaryPageFixture([reviewSummaryFor(target)], { scopeId: expired ? replacement : scopeId }));
    }
    return original(name, args);
  });
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep earlier reason");
  const captured = owner.current().selected;
  expired = true;
  await refreshWorkbenchReads(["source"]);
  const alert = await screen.findByRole("alert");
  expect(calls("read_review_summary_page").filter(([, args]) => args.request.scopeId === null)).toHaveLength(1);
  await user.click(within(alert).getByRole("button", { name: "Retry current information" }));
  await waitFor(() => expect(calls("read_review_summary_page")).toHaveLength(3));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh current evidence" })).toBeEnabled());
  expect(calls("read_review_summary_page").at(-1)![1].request.scopeId).toBe(scopeId);
  expect(owner.current().selected).toBe(captured);
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
  expect(calls("read_review_summary_page").filter(([, args]) => args.request.scopeId === null)).toHaveLength(2);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep earlier reason");
  expect(owner.current().selected).toBe(captured);
});

it("does not automatically reallocate a cancelled null-scope capture on consumer remount", async () => {
  const original = invoke.getMockImplementation()!;
  const old = deferred<unknown>();
  let summaries = 0;
  invoke.mockImplementation((name: string, args: unknown) => name === "read_review_summary_page" && ++summaries === 1 ? old.promise : original(name, args));
  const user = userEvent.setup();
  const ref = createRef<ReviewHandle>();
  const view = render(consumer(project, ref), project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await waitFor(() => expect(summaries).toBe(1));
  view.rerender(<Probe />, project);
  view.rerender(consumer(project, ref), project);
  expect(calls("read_review_summary_page")).toHaveLength(1);
  await act(async () => old.resolve(reviewSummaryPageFixture([reviewSummaryFor(target)], { scopeId })));
  expect(screen.queryByRole("button", { name: "first" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Refresh current evidence" }));
  expect(await screen.findByRole("button", { name: "first" })).toBeVisible();
  expect(calls("read_review_summary_page")).toHaveLength(2);
  expect(calls("read_review_summary_page").every(([, args]) => args.request.scopeId === null)).toBe(true);
});

it("rereads only the new fixed scope when a semantic change arrives during explicit capture", async () => {
  const original = invoke.getMockImplementation()!;
  const capture = deferred<unknown>();
  invoke.mockImplementation((name: string, args: { request: Record<string, unknown> }) => name === "read_review_summary_page" && args.request.scopeId === null
    ? capture.promise : original(name, args));
  const user = userEvent.setup();
  render(consumer(), project);
  await user.click(screen.getByRole("button", { name: "Review and QA" }));
  await waitFor(() => expect(calls("read_review_summary_page")).toHaveLength(1));
  await refreshWorkbenchReads(["translation"]);
  const earlier = target;
  target = { ...target, nativeKey: "current-summary" };
  await act(async () => capture.resolve(reviewSummaryPageFixture([reviewSummaryFor(earlier)], { scopeId })));
  expect(await screen.findByRole("button", { name: "current-summary" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "first" })).not.toBeInTheDocument();
  const requests = calls("read_review_summary_page").map(([, args]) => args.request);
  expect(requests).toHaveLength(2);
  expect(requests[0].scopeId).toBeNull();
  expect(requests[1]).toMatchObject({ scopeId, afterOrdinal: 0, query: "", locale: "zh-CN" });
});

it("rejects a mismatched fresh target identity and retries the original selection without rebinding its reason", async () => {
  const original = invoke.getMockImplementation()!;
  const selection = deferred<ReviewTarget>();
  let targetReads = 0;
  invoke.mockImplementation((name: string, args: unknown) => name === "read_review_target" && ++targetReads === 2 ? selection.promise : original(name, args));
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Fixed reason");
  const selected = owner.current().selected;
  await user.click(screen.getByRole("button", { name: "first" }));
  await waitFor(() => expect(targetReads).toBe(2));
  await act(async () => selection.resolve(second));
  const alert = await screen.findByRole("alert");
  expect(owner.current().selected).toBe(selected);
  expect(screen.queryByRole("heading", { name: "second" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Fixed reason");
  await user.click(within(alert).getByRole("button", { name: "Retry current information" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(targetReads).toBe(3);
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Fixed reason");
  expect(owner.current().selected?.basis).toBe("basis-first");
});

it("keeps unknown action evidence primary when a remounted current query returns late", async () => {
  const original = invoke.getMockImplementation()!;
  const first = target;
  const late = deferred<ReviewTarget>();
  let targetReads = 0, writes = 0;
  invoke.mockImplementation((name: string, args: { request: Record<string, unknown> }) => {
    if (name === "read_review_target" && ++targetReads === 2) return late.promise;
    if (name === "write_review_decision") {
      const receipt = reviewDecisionFixture(args.request.decision as ReviewWrite, first);
      return Promise.resolve(++writes === 1 ? { ...receipt, actionId: fixtureIdentity(629) } : receipt);
    }
    return original(name, args);
  });
  const user = userEvent.setup();
  const view = render(consumer(), project);
  await selectFirst(user);
  const reason = screen.getByRole("textbox", { name: "Reason or evidence" });
  await user.type(reason, "Original A");
  await user.click(screen.getByRole("button", { name: "Approve selected revision" }));
  await screen.findByRole("button", { name: "Retry the same action" });
  const pending = owner.current().pending;
  const request = calls("write_review_decision")[0][1].request;
  await user.clear(reason); await user.type(reason, "New B");
  view.rerender(<Probe />, project);
  target = reviewTargetFixture({ ...first, basisEvidence: undefined, basis: "unseen-current-basis", sourceRevisionId: fixtureIdentity(690),
    selectionId: fixtureIdentity(691), revisionId: fixtureIdentity(692), sourceText: "Unseen current source", translationText: "Unseen current translation" });
  view.rerender(consumer(), project);
  await waitFor(() => expect(targetReads).toBe(2));
  expect(screen.getByRole("button", { name: "Retry the same action" })).toBeEnabled();
  expect(screen.getByText("Original source")).toBeVisible();
  await act(async () => late.resolve(target));
  await waitFor(() => expect(currentQueryTarget()?.basis).toBe("unseen-current-basis"));
  expect(screen.queryByText("Unseen current source")).not.toBeInTheDocument();
  expect(screen.getByText("Original source")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("New B");
  expect(owner.current().pending).toBe(pending);
  await user.click(await screen.findByRole("button", { name: "View current evidence" }));
  expect(await screen.findByText("Unseen current source")).toBeVisible();
  expect(screen.getByText("Original source")).toBeVisible();
  expect(screen.getByRole("button", { name: "Use current content and keep reason" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Retry the same action" }));
  await waitFor(() => expect(owner.current().pending).toBeNull());
  expect(calls("write_review_decision").map(([, args]) => args.request)).toEqual([request, request]);
  expect(owner.current().selected?.basis).toBe("basis-first");
  expect(screen.getByText("Original source")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("New B");
});

it("does not reuse an earlier comparison intent to reveal a later automatic basis change", async () => {
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Reason B");
  target = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "first-comparison", revisionId: fixtureIdentity(626), translationText: "Explicit comparison" });
  await refreshWorkbenchReads(["translation"]);
  await waitFor(() => expect(currentQueryTarget()?.basis).toBe("first-comparison"));
  await user.click(await screen.findByRole("button", { name: "View current evidence" }));
  expect(await screen.findByText("Explicit comparison")).toBeVisible();
  target = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "later-comparison", revisionId: fixtureIdentity(627), translationText: "Later unseen comparison" });
  await refreshWorkbenchReads(["translation"]);
  await waitFor(() => expect(currentQueryTarget()?.basis).toBe("later-comparison"));
  expect(screen.queryByText("Later unseen comparison")).not.toBeInTheDocument();
  expect(screen.getByText("Original translation")).toBeVisible();
  expect(await screen.findByRole("button", { name: "View current evidence" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Reason B");
  expect(owner.current().selected?.basis).toBe("basis-first");
});

it.each(["capture", "fixed"] as const)("rejects wrong summary provenance during %s reads without adopting its rows", async phase => {
  const original = invoke.getMockImplementation()!;
  let rejectRows = phase === "capture";
  invoke.mockImplementation((name: string, args: unknown) => name === "read_review_summary_page" && rejectRows
    ? Promise.resolve(reviewSummaryPageFixture([{ ...reviewSummaryFor(target), sourceSnapshotId: fixtureIdentity(695) }], { scopeId, sourceSnapshotId: target.sourceSnapshotId }))
    : original(name, args));
  const user = userEvent.setup();
  render(consumer(), project);
  if (phase === "capture") await user.click(screen.getByRole("button", { name: "Review and QA" }));
  else {
    await selectFirst(user);
    await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep fixed reason");
    rejectRows = true;
    await refreshWorkbenchReads(["source"]);
  }
  await screen.findByRole("alert");
  expect(screen.queryByRole("checkbox", { name: "Approve selected entries: first" })).not.toBeInTheDocument();
  expect(calls("read_review_summary_page").filter(([, args]) => args.request.scopeId === null)).toHaveLength(1);
  if (phase === "capture") expect(owner.current().selected).toBeNull();
  else {
    expect(owner.current().selected?.basis).toBe("basis-first");
    expect(screen.getByText("Original source")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Reason or evidence" })).toHaveValue("Keep fixed reason");
  }
  expect(calls("create_execution_identity")).toHaveLength(0);
});

it("does not adopt a newer query basis arriving between the comparison and its click handler", async () => {
  const user = userEvent.setup();
  render(consumer(), project);
  await selectFirst(user);
  await user.type(screen.getByRole("textbox", { name: "Reason or evidence" }), "Keep original reason");
  target = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "shown-comparison", revisionId: fixtureIdentity(626), translationText: "Shown comparison" });
  await refreshWorkbenchReads(["translation"]);
  await user.click(await screen.findByRole("button", { name: "View current evidence" }));
  await screen.findByText("Shown comparison");
  const adopt = screen.getByRole("button", { name: "Use current content and keep reason" });
  const newer = reviewTargetFixture({ ...target, basisEvidence: undefined, basis: "unseen-click-basis", revisionId: fixtureIdentity(627), translationText: "Unseen click content" });
  adopt.addEventListener("click", () => {
    reads.client.setQueryData(reads.key(["review-target", target.unitId, "zh-CN"]), newer);
  }, { capture: true, once: true });
  await user.click(adopt);
  expect(owner.current().selected?.basis).toBe("basis-first");
  expect(owner.current().drafts["zh-CN:" + target.unitId]).toBe("Keep original reason");
  expect(screen.getByText("Original translation")).toBeVisible();
  expect(screen.queryByText("Unseen click content")).not.toBeInTheDocument();
  expect(calls("create_execution_identity")).toHaveLength(0);
});
