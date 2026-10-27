import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import type { ProjectView } from "../../../projectCommands";
import type { CheckRun, FallbackDecision, ReviewHistoryPage, ReviewTarget, Waiver } from "../../../reviewCommands";
import type { Requests } from "../../../generated/review.requests";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewCheckFixture, reviewDecisionFixture, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { coreRuleKeyFixture, pluginRuleKeyFixture } from "../../../testSupport/textReviewFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import EntryReviewHistory, { reviewHistoryKey } from "./EntryReviewHistory";
import type { EntryReviewHistoryProps, ReviewHistoryCommandPayload } from "./historyTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "entry-review-history", locator: "/synthetic/review-history", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(9910), displayName: "Synthetic history", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project), commandScope = { ...context, area: "translation" as const };
const target = reviewTargetFixture();
type WorkbenchTextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: WorkbenchTextKey) => i18n.t(`workbenchV2.${key}`);
const blank = (): ReviewHistoryPage => ({ checks: [], decisions: [], waivers: [], fallbacks: [], nextOffset: null });
const copy = <T,>(value: T): T => structuredClone(value);
const calls = () => invoke.mock.calls.filter(([command]) => command === "read_review_history");
const held: { reads: SessionReads; gate: InteractionGate }[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function decision(label = "Reason é 👩🏽‍💻", current = target, seed = 9911) {
  return reviewDecisionFixture({ projectId: context.projectId, actionId: fixtureIdentity(seed), unitId: current.unitId, locale: current.locale,
    expectedBasis: current.basis, expectedDecisionId: null, actor: "Reviewer A", kind: "approve", reason: label }, current);
}
function page(label: string, nextOffset: number | null = null, current = target): ReviewHistoryPage {
  return { ...blank(), decisions: [decision(label, current)], nextOffset };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_review_history") return blank();
    throw new Error(`Unexpected native request: ${command}`);
  });
});
afterEach(() => { cleanup(); held.splice(0).forEach(({ reads, gate }) => { reads.retire(); gate.dispose(); }); });

function harness(options: { target?: ReviewTarget; offset?: number; disabled?: boolean; parentDialogId?: string } = {}) {
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands();
  gate.setVisibleOwner("entries"); if (options.parentDialogId) gate.pushDialog(options.parentDialogId);
  held.push({ reads, gate });
  const onOffset = vi.fn();
  type Presentation = Pick<EntryReviewHistoryProps, "target" | "visible" | "disabled" | "parentDialogId">;
  let presentation: Presentation = { target: options.target ?? target, visible: true, disabled: options.disabled ?? false, parentDialogId: options.parentDialogId };
  function Content(props: Presentation) {
    const [offset, setOffset] = useState(options.offset ?? 0);
    return <EntryReviewHistory {...props} project={project} commands={commands} gate={gate} viewId="entries" offset={offset}
      onOffset={value => { onOffset(value); setOffset(value); }}/>;
  }
  const ui = () => <SessionReadProvider context={context} reads={reads} bridge={false}><Content {...presentation}/></SessionReadProvider>;
  const rendered = render(ui());
  return { reads, gate, commands, onOffset, rendered, show: (patch: Partial<Presentation>) => { presentation = { ...presentation, ...patch }; rendered.rerender(ui()); } };
}

it("reads all four real history collections, preserves Unicode audit text and marks an old approval and QA basis as historical", async () => {
  const approval = decision(), run: CheckRun = reviewCheckFixture(target, fixtureIdentity(9912), "completed", { rules: [
    { key: coreRuleKeyFixture("required-translation"), rule: "required-translation", mandatory: true, status: "passed", reason: null, findings: [] },
    { key: pluginRuleKeyFixture("example.editorial"), rule: "plugin:example.editorial", mandatory: false, status: "findings", reason: null,
      findings: [{ issueId: "c".repeat(64), rule: "plugin:example.editorial", code: "advice", severity: "warning", waivable: false, detail: "Keep {{name}} — é 👩🏽‍💻" }] },
  ] });
  const waiver: Waiver = { actionId: fixtureIdentity(9913), waiverId: fixtureIdentity(9914), unitId: target.unitId, locale: target.locale,
    basis: target.basis, grant: true, issueId: "b".repeat(64), actor: "Reviewer W", reason: "Waiver reason", policyVersion: "balanced-1",
    previousWaiverId: null, createdAt: "2026-10-18T01:00:00Z" };
  const fallback: FallbackDecision = { actionId: fixtureIdentity(9915), fallbackId: fixtureIdentity(9916), unitId: target.unitId, locale: target.locale,
    sourceRevisionId: target.sourceRevisionId, allow: true, actor: "Reviewer F", reason: "Fallback reason", policyVersion: "balanced-1",
    previousFallbackId: null, createdAt: "2026-10-18T02:00:00Z" };
  invoke.mockResolvedValue({ decisions: [approval], checks: [run], waivers: [waiver], fallbacks: [fallback], nextOffset: null });
  harness({ target: { ...target, basis: "new-basis", currentDecision: approval, currentCheck: run } });
  expect(await screen.findByText("Reason é 👩🏽‍💻")).toBeInTheDocument();
  expect(screen.getByText("Reviewer A", { exact: false })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: w("entryHistoryTitle") })).toHaveTextContent("Keep {{name}} — é 👩🏽‍💻");
  expect(screen.getByRole("region", { name: w("entryHistoryTitle") })).toHaveTextContent(w("entryHistoryOutdated"));
  expect(screen.queryByText(w("entryHistoryCurrent"))).not.toBeInTheDocument();
  expect(screen.getByText(w("entryHistoryMandatory"))).toBeInTheDocument(); expect(screen.getByText(w("entryHistoryAdvisory"))).toBeInTheDocument();
  expect(screen.getByText("Waiver reason")).toBeInTheDocument(); expect(screen.getByText("Fallback reason")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: w("entryHistoryReload") })).toBeEnabled();
  expect(calls()[0][1].request).toEqual({ ...context, unitId: target.unitId, locale: target.locale, offset: 0, limit: 20 });
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(["read_review_history"]);
});

it("uses the real next offset and retries a failed current page without erasing its records or moving the cursor", async () => {
  let laterReads = 0; const failedRead = deferred<ReviewHistoryPage>();
  invoke.mockImplementation(async (command: string, { request }: { request: Requests["history"] }) => {
    if (command !== "read_review_history") throw new Error(command);
    if (request.offset === 0) return page("First page audit", 20);
    if (++laterReads === 2) return failedRead.promise;
    return page("Later page audit");
  });
  const h = harness({ target: { ...target, currentDecision: decision() } }), user = userEvent.setup();
  await screen.findByText("First page audit");
  await user.click(screen.getByRole("button", { name: w("entryHistoryNext") }));
  await screen.findByText("Later page audit"); expect(h.onOffset).toHaveBeenLastCalledWith(20);
  await waitFor(() => expect(screen.getByRole("region", { name: w("entryHistoryTitle") })).toHaveFocus());
  expect(screen.getByText(w("entryHistoryCurrent"))).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: w("entryHistoryReload") }));
  await screen.findByRole("status");
  expect(screen.getByText(w("entryHistoryUnverified"))).toBeInTheDocument(); expect(screen.queryByText(w("entryHistoryCurrent"))).not.toBeInTheDocument();
  await act(async () => { failedRead.reject(new Error("Read unavailable")); });
  expect(await screen.findByRole("alert")).toHaveTextContent(w("entryHistoryReadFailed"));
  expect(h.reads.client.getQueryState(h.reads.key(reviewHistoryKey(target, 20)))).toMatchObject({ status: "error", isInvalidated: true });
  expect(screen.getByText(w("entryHistoryUnverified"))).toBeInTheDocument(); expect(screen.queryByText(w("entryHistoryCurrent"))).not.toBeInTheDocument();
  expect(screen.getByText("Later page audit")).toBeInTheDocument(); expect(h.onOffset).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: w("entryHistoryReload") })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: w("entryHistoryReload") }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByText(w("entryHistoryCurrent"))).toBeInTheDocument();
  expect(calls().map(([, args]) => args.request.offset)).toEqual([0, 20, 20, 20]);
  expect(h.onOffset).toHaveBeenCalledOnce();
});

it("returns invalidated history to page zero before dispatching another read at the old offset", async () => {
  let firstReads = 0;
  invoke.mockImplementation(async (command: string, { request }: { request: Requests["history"] }) => {
    if (command !== "read_review_history") throw new Error(command);
    if (request.offset === 0) return page(++firstReads === 1 ? "First before review" : "First after review", 20);
    return page("Retained later page");
  });
  const h = harness(), user = userEvent.setup();
  await screen.findByText("First before review");
  await user.click(screen.getByRole("button", { name: w("entryHistoryNext") })); await screen.findByText("Retained later page");
  h.show({ visible: false }); expect(h.onOffset).toHaveBeenLastCalledWith(20);
  h.show({ visible: true }); await screen.findByText("Retained later page"); expect(calls()).toHaveLength(2);
  act(() => { h.reads.invalidate(["review"]); });
  await screen.findByText("First after review"); expect(h.onOffset).toHaveBeenLastCalledWith(0);
  expect(calls().map(([, args]) => args.request.offset)).toEqual([0, 20, 0]);
  expect(h.reads.client.getQueryCache().find({ queryKey: h.reads.key(reviewHistoryKey(target, 0)), exact: true })?.meta?.scopes).toEqual(["source", "translation", "resources", "review"]);
});

it("does not mistake an empty later page for an entry with no history and resets a directly invalidated cached page", async () => {
  const h = harness({ offset: 20 }), user = userEvent.setup();
  expect(await screen.findByText(w("entryHistoryPageEmpty"))).toBeInTheDocument();
  expect(screen.queryByText(w("entryHistoryEmpty"))).not.toBeInTheDocument();
  h.show({ visible: false });
  await act(async () => { await h.reads.client.invalidateQueries({ queryKey: h.reads.key(reviewHistoryKey(target, 20)), exact: true }); });
  await waitFor(() => expect(h.onOffset).toHaveBeenLastCalledWith(0)); expect(calls()).toHaveLength(1);
  h.show({ visible: true }); await screen.findByText(w("entryHistoryEmpty"));
  expect(calls().map(([, args]) => args.request.offset)).toEqual([20, 0]);
  expect(screen.getByRole("button", { name: w("entryHistoryFirst") })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: w("entryHistoryReload") }));
  await waitFor(() => expect(calls()).toHaveLength(3));
});

it("rejects hidden, disabled, IME and unrelated-dialog actions immediately while keeping read-only records available", async () => {
  invoke.mockResolvedValue(page("History audit", 20));
  const h = harness({ parentDialogId: "workspace-dock" }); await screen.findByText("History audit");
  const payload: ReviewHistoryCommandPayload = { kind: "entry-review-history", unitId: target.unitId, locale: target.locale, offset: 20 };
  h.show({ disabled: true }); expect(screen.getByRole("button", { name: w("entryHistoryNext") })).toBeDisabled();
  expect(screen.getByText("History audit")).toBeInTheDocument(); expect(screen.getByText(w("entryHistoryUnverified"))).toBeInTheDocument();
  expect(h.commands.dispatch("review.entry-history-next", commandScope, payload)).toBe(false);
  h.show({ disabled: false });
  act(() => { h.gate.setComposing("editor", true); }); expect(screen.getByRole("button", { name: w("entryHistoryNext") })).toBeDisabled();
  act(() => { h.gate.setComposing("editor", false); });
  let close!: () => void; act(() => { close = h.gate.pushDialog("other-dialog"); });
  expect(h.commands.dispatch("review.entry-history-next", commandScope, payload)).toBe(false);
  act(() => { close(); }); expect(screen.getByRole("button", { name: w("entryHistoryNext") })).toBeEnabled();
  h.show({ visible: false }); expect(h.commands.dispatch("review.entry-history-next", commandScope, payload)).toBe(false);
  expect(h.onOffset).not.toHaveBeenCalled(); expect(calls()).toHaveLength(1);
});

it("ignores a previous target's late response and never steals focus after the user moves to another input", async () => {
  const oldRead = deferred<ReviewHistoryPage>(), refreshed = deferred<ReviewHistoryPage>();
  const other = reviewTargetFixture({ unitId: fixtureIdentity(9920), nativeKey: "other" }); let newReads = 0;
  invoke.mockImplementation(async (command: string, { request }: { request: Requests["history"] }) => {
    if (command !== "read_review_history") throw new Error(command);
    if (request.unitId === target.unitId) return oldRead.promise;
    return ++newReads === 1 ? page("New target audit", null, other) : refreshed.promise;
  });
  const h = harness(); await waitFor(() => expect(calls()).toHaveLength(1));
  h.show({ target: other }); await screen.findByText("New target audit");
  await act(async () => { oldRead.resolve(page("Old target audit")); });
  expect(screen.queryByText("Old target audit")).not.toBeInTheDocument();
  const button = screen.getByRole("button", { name: w("entryHistoryReload") }); button.focus(); fireEvent.click(button);
  await waitFor(() => expect(calls()).toHaveLength(3));
  const input = document.createElement("textarea"); document.body.append(input); input.focus(); input.value = "New input B";
  await act(async () => { refreshed.resolve(page("New target refreshed", null, other)); });
  expect(await screen.findByText("New target refreshed")).toBeInTheDocument(); expect(input).toHaveFocus(); expect(input.value).toBe("New input B"); input.remove();
  expect(within(screen.getByRole("region", { name: w("entryHistoryTitle") })).queryByText("Old target audit")).not.toBeInTheDocument();
});
