import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DecisionItem, DecisionPage } from "../../../decisionCommands";
import { decisionsEn, decisionsZh } from "../../../i18n/decisions";
import DecisionList, { DecisionBadge, DecisionTray, type DecisionListProps } from "./DecisionList";

let language = createInstance();
beforeEach(async () => {
  language = createInstance();
  await language.use(initReactI18next).init({ lng: "en-US", fallbackLng: "en-US",
    resources: { "en-US": { translation: { workbenchV2: decisionsEn } }, "zh-CN": { translation: { workbenchV2: decisionsZh } } },
    interpolation: { escapeValue: false } });
});
afterEach(cleanup);
const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

function sample(): DecisionPage {
  const candidate: DecisionItem = { decisionId: `translation-candidate:${id(3)}:zh-CN`, source: "translation-candidate", state: "stale",
    locale: "zh-CN", targets: [{ kind: "entry", unitId: id(2) }], targetsComplete: true, basis: "e".repeat(64), sourceActionId: id(4),
    action: { kind: "compare-candidate", unitId: id(2), revisionId: id(3), sourceSnapshotId: id(5), sourceRevisionId: id(6) }, evidence: null };
  const blocker: DecisionItem = { decisionId: "delivery-blocker:zh-CN", source: "delivery-blocker", state: "pending", locale: "zh-CN",
    targets: [{ kind: "project" }], targetsComplete: true, basis: "f".repeat(64), sourceActionId: null,
    action: { kind: "inspect-delivery", locale: "zh-CN" }, evidence: { kind: "delivery", blockerCount: 1,
      reasons: [{ unitId: id(2), nativeKey: "Synthetic entry", code: "approval-missing-or-stale", reference: null }], reasonsComplete: true } };
  const basis = "d".repeat(64);
  return { projectId: id(1), query: { locale: null, sources: ["translation-candidate", "delivery-blocker"] }, basis,
    items: [blocker, candidate], next: { basis, afterId: candidate.decisionId }, knownCount: 25, total: 25,
    coverage: [{ source: "translation-candidate", state: "complete", knownCount: 24, total: 24, reason: null, errorCode: null },
      { source: "delivery-blocker", state: "complete", knownCount: 1, total: 1, reason: null, errorCode: null }],
    deliveryActivity: [], executionActivity: [], localActions: null };
}

function empty(partial: boolean): DecisionPage {
  return { ...sample(), query: { locale: null, sources: [partial ? "agent-question" : "translation-candidate"] },
    items: [], knownCount: 0, total: partial ? null : 0, next: null,
    coverage: partial ? [{ source: "agent-question", state: "unavailable", knownCount: 0, total: null,
      reason: "source-not-implemented", errorCode: null }] : [{ source: "translation-candidate", state: "complete",
      knownCount: 0, total: 0, reason: null, errorCode: null }] };
}

function props(page: DecisionPage | undefined = sample()): DecisionListProps {
  return { page, loading: false, refreshing: false, error: null, selectedId: null, disabled: false, hasPrevious: true,
    onSelect: vi.fn(), onNext: vi.fn(), onBack: vi.fn(), onRefresh: vi.fn() };
}
function content(value: DecisionListProps, onOpen = vi.fn()) {
  return <I18nextProvider i18n={language}><DecisionList {...value}/>
    <DecisionTray page={value.page} loading={value.loading || value.refreshing} error={value.error} disabled={value.disabled} onOpen={onOpen}/>
    <DecisionBadge page={value.page} loading={value.loading || value.refreshing} error={value.error}/>
  </I18nextProvider>;
}

it("uses the shared full count, groups the current page and opens the captured item with keyboard", async () => {
  const page = sample(), value = props(page), onOpen = vi.fn(), user = userEvent.setup();
  const rendered = render(content(value, onOpen));
  expect(screen.getByText("25 decisions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Your decisions (25)" })).toBeInTheDocument();
  expect(screen.getByLabelText("25 decisions need your attention")).toHaveTextContent("25");
  expect(screen.getByRole("region", { name: decisionsEn.decisionsCandidates })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: decisionsEn.decisionsBlockers })).toBeInTheDocument();
  const open = screen.getByRole("button", { name: decisionsEn.decisionsCandidateOpen });
  open.focus(); await user.keyboard("{Enter}");
  expect(value.onSelect).toHaveBeenCalledTimes(1);
  expect(vi.mocked(value.onSelect).mock.calls[0]?.[0]).toBe(page.items[1]);
  fireEvent.click(screen.getByRole("button", { name: decisionsEn.decisionsNext }));
  expect(vi.mocked(value.onNext).mock.calls[0]?.[0]).toBe(page.next);
  fireEvent.click(screen.getByRole("button", { name: decisionsEn.decisionsPrevious }));
  expect(value.onBack).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: decisionsEn.decisionsRefresh }));
  expect(value.onRefresh).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Your decisions (25)" }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  for (const identity of [page.projectId, page.basis, page.items[1]?.decisionId, id(2), id(3)]) {
    if (identity) expect(rendered.container.textContent).not.toContain(identity);
  }
});

it("distinguishes a fully read zero from an incomplete source that has returned no items", () => {
  const value = props(empty(false)), rendered = render(content(value));
  expect(screen.getByRole("heading", { name: decisionsEn.decisionsEmpty })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Your decisions (0)" })).toBeInTheDocument();
  expect(screen.getByLabelText("0 decisions need your attention")).toHaveTextContent("0");
  rendered.rerender(content({ ...value, page: empty(true) }));
  expect(screen.queryByRole("heading", { name: decisionsEn.decisionsEmpty })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: decisionsEn.decisionsPartialEmpty })).toBeInTheDocument();
  expect(screen.getByText(decisionsEn.decisionsSourceNotConnected)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: decisionsEn.decisionsTrayUnknown })).toBeInTheDocument();
  expect(screen.getByLabelText(decisionsEn.decisionsBadgeUnknown)).toHaveTextContent("?");
  expect(screen.queryByText("0 decisions")).not.toBeInTheDocument();
});

it("shows partial counts and the missing source without counting just the visible rows", () => {
  const page = sample();
  page.total = null;
  page.coverage[0] = { source: "translation-candidate", state: "partial", knownCount: 24, total: null, reason: "source-limit", errorCode: null };
  render(content(props(page)));
  expect(screen.getByText("At least 25 decisions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Your decisions (at least 25)" })).toBeInTheDocument();
  expect(screen.getByLabelText("At least 25 decisions need your attention. Some sources are incomplete.")).toHaveTextContent("25+");
  expect(screen.getByText(decisionsEn.decisionsSourceLimit)).toBeInTheDocument();
});

it("keeps initial loading and read failure separate from an empty inbox and offers refresh", () => {
  const value = { ...props(undefined), page: undefined, loading: true }, rendered = render(content(value));
  expect(screen.getByRole("status")).toHaveTextContent(decisionsEn.decisionsLoading);
  expect(screen.queryByRole("heading", { name: decisionsEn.decisionsEmpty })).not.toBeInTheDocument();
  expect(screen.getByLabelText(decisionsEn.decisionsBadgeLoading)).toHaveTextContent("…");
  const failed = { ...value, loading: false, error: new Error("Synthetic internal path must not be shown") };
  rendered.rerender(content(failed));
  expect(screen.getByRole("alert")).toHaveTextContent(decisionsEn.decisionsReadFailed);
  expect(screen.getByLabelText(decisionsEn.decisionsBadgeError)).toHaveTextContent("?");
  expect(rendered.container.textContent).not.toContain("Synthetic internal path");
  fireEvent.click(screen.getByRole("button", { name: decisionsEn.decisionsRefresh }));
  expect(value.onRefresh).toHaveBeenCalledTimes(1);
});

it("retains the previous data after refresh failure and blocks its old row and cursor actions", () => {
  const value = { ...props(), error: new Error("Synthetic refresh failure") }, rendered = render(content(value));
  expect(screen.getByRole("alert")).toHaveTextContent(decisionsEn.decisionsRefreshFailed);
  expect(screen.getByText("Last read: 25 decisions")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: decisionsEn.decisionsCandidateTitle })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: decisionsEn.decisionsCandidateOpen })).toBeDisabled();
  expect(screen.getByRole("button", { name: decisionsEn.decisionsNext })).toBeDisabled();
  expect(screen.getByRole("button", { name: decisionsEn.decisionsPrevious })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: decisionsEn.decisionsCandidateOpen }));
  expect(value.onSelect).not.toHaveBeenCalled();
  rendered.rerender(content({ ...value, page: empty(false) }));
  expect(screen.getByRole("heading", { name: decisionsEn.decisionsPreviousEmpty })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: decisionsEn.decisionsEmpty })).not.toBeInTheDocument();
});

it("does not select another row when the selected decision disappears on refresh", () => {
  const page = sample(), selected = page.items[1];
  if (!selected) throw new Error("Synthetic candidate required");
  const value = { ...props(page), selectedId: selected.decisionId }, rendered = render(content(value));
  expect(screen.getByRole("button", { name: decisionsEn.decisionsCandidateOpen })).toHaveAttribute("aria-current", "true");
  const changed: DecisionPage = { ...page, items: page.items.filter(item => item.decisionId !== selected.decisionId), knownCount: 24, total: 24,
    coverage: page.coverage.map(source => source.source === "translation-candidate" ? { ...source, knownCount: 23, total: 23 } : source) };
  rendered.rerender(content({ ...value, page: changed }));
  expect(screen.getByRole("button", { name: decisionsEn.decisionsBlockerOpen })).not.toHaveAttribute("aria-current");
  expect(value.onSelect).not.toHaveBeenCalled();
  expect(value.selectedId).toBe(selected.decisionId);
});

it("keeps refreshing and external disablement on the existing controls without enabling old decisions", () => {
  const value = { ...props(), refreshing: true }, onOpen = vi.fn(), rendered = render(content(value, onOpen));
  expect(screen.getByRole("status")).toHaveTextContent(decisionsEn.decisionsRefreshing);
  expect(screen.getByRole("button", { name: decisionsEn.decisionsRefresh })).toBeDisabled();
  expect(screen.getByRole("button", { name: decisionsEn.decisionsCandidateOpen })).toBeDisabled();
  rendered.rerender(content({ ...value, refreshing: false, disabled: true }, onOpen));
  expect(screen.getByRole("button", { name: decisionsEn.decisionsCandidateOpen })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Your decisions (25)" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Your decisions (25)" }));
  expect(onOpen).not.toHaveBeenCalled();
});

it("presents source names and the recheck state in Chinese without displaying storage identities", async () => {
  await language.changeLanguage("zh-CN");
  const page = sample(), candidate = page.items[1];
  if (!candidate) throw new Error("Synthetic candidate required");
  candidate.state = "awaiting-recheck";
  const rendered = render(content(props(page)));
  expect(screen.getByRole("heading", { level: 1, name: decisionsZh.decisionsTitle })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: decisionsZh.decisionsCandidates })).toBeInTheDocument();
  expect(screen.getByText(decisionsZh.decisionsAwaitingRecheck)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: decisionsZh.decisionsCandidateOpen })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "待你决定（25）" })).toBeInTheDocument();
  expect(rendered.container.textContent).not.toContain(candidate.decisionId);
});
