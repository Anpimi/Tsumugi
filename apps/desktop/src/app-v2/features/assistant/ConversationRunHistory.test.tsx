import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { conversationRunHistoryEn, conversationRunHistoryZh } from "../../../i18n/conversationRunHistory";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { historyPageAfter, workPlanHistoryFixture } from "../../../testSupport/workPlanHistoryFixture";
import { ConversationRunHistory } from "./ConversationRunHistory";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const disposals: (() => void)[] = [];
type TextKey = { [K in keyof typeof conversationRunHistoryEn]: typeof conversationRunHistoryEn[K] extends string ? K : never }[keyof typeof conversationRunHistoryEn];
const t = (key: TextKey, values: Record<string, string | number> = {}) => i18n.t(`conversationRunHistory.${key}`, values);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(async () => { invoke.mockReset(); await i18n.changeLanguage("zh-CN"); });
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose()); });

function harness(total = 3) {
  const h = workPlanHistoryFixture(total), reads = new SessionReads(h.context);
  invoke.mockImplementation(async (command: string, { request }: { request: { after: string } }) => {
    if (command === "read_conversation_proposal_work_plan") return structuredClone(h.link);
    if (command === "read_work_plan_history") return historyPageAfter(h.page, request.after);
    throw new Error(`Unexpected mutation, runtime or external request: ${command}`);
  });
  const props = { context: h.context, link: h.link, status: h.status, visible: true, canRead: () => true };
  const tree = () => <SessionReadProvider context={h.context} reads={reads} bridge={false}>
    <label>Independent draft<input aria-label="Independent draft" defaultValue="Retained B"/></label><ConversationRunHistory {...props}/>
  </SessionReadProvider>;
  const rendered = render(tree()); disposals.push(() => { rendered.unmount(); reads.retire(); });
  return { ...h, reads, props, rerender: () => rendered.rerender(tree()) };
}

describe("read-only original plan history", () => {
  it.each(["en-US", "zh-CN"])("starts collapsed and shows original controls and recovery in %s", async language => {
    await i18n.changeLanguage(language); const h = harness();
    const show = screen.getByRole("button", { name: t("show") });
    expect(show.getAttribute("aria-expanded")).toBe("false"); expect(invoke).not.toHaveBeenCalled();
    show.focus(); fireEvent.click(show);
    await screen.findByRole("heading", { name: t("entry", { generation: "3", action: t("teamRecovery") }) });
    expect(screen.getByText("Original recovery instruction 3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("entry", { generation: "1", action: t("authorize") }) })).toBeTruthy();
    expect(screen.getByRole("heading", { name: t("entry", { generation: "2", action: t("pause") }) })).toBeTruthy();
    expect(screen.getByRole("button", { name: t("hide") })).toBe(document.activeElement);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_conversation_proposal_work_plan", "read_work_plan_history"]);
    expect(h.props.status.lease.generation).toBe("3");
  });

  it("paginates at sixteen actions with the original baseline and no invented total", async () => {
    harness(19); fireEvent.click(screen.getByRole("button", { name: t("show") }));
    const next = await screen.findByRole("button", { name: t("next") });
    expect(screen.getAllByRole("heading", { level: 6 })).toHaveLength(16);
    next.focus(); fireEvent.click(next);
    await screen.findByRole("heading", { name: t("entry", { generation: "19", action: t("teamRecovery") }) });
    expect(screen.getAllByRole("heading", { level: 6 })).toHaveLength(3);
    expect(screen.getByRole("region", { name: t("records") })).toBe(document.activeElement);
    const request = invoke.mock.calls.filter(([command]) => command === "read_work_plan_history").at(-1)?.[1].request;
    expect(request.after).toBe("16"); expect(request.limit).toBe(16); expect(request.baseline.lease.generation).toBe("19");
    expect(screen.queryByRole("button", { name: t("next") })).toBeNull();
  });

  it("keeps an unstarted authorization separate and does not offer an attempt action", async () => {
    const h = harness(1), row = h.page.rows[0]; row.start = null; h.page.baseline.lastStart = null;
    fireEvent.click(screen.getByRole("button", { name: t("show") }));
    await screen.findByText(t("startUnconfirmed"));
    expect(screen.queryByRole("button", { name: t("showAttempt") })).toBeNull();
    expect(invoke.mock.calls.every(([command]) => ["read_conversation_proposal_work_plan", "read_work_plan_history"].includes(command))).toBe(true);
  });

  it("keeps the original draft and returns to a fresh first page after a history conflict", async () => {
    const h = harness(19), original = invoke.getMockImplementation();
    if (!original) throw new Error("Missing synthetic read transport");
    invoke.mockImplementation(async (command: string, input: { request: { after: string } }) => {
      if (command === "read_work_plan_history" && input.request.after === "16") throw { code: "dependency-conflict", reason: "work-plan-history-changed" };
      return original(command, input);
    });
    fireEvent.click(screen.getByRole("button", { name: t("show") }));
    fireEvent.click(await screen.findByRole("button", { name: t("next") }));
    await screen.findByText(t("changed"));
    fireEvent.change(screen.getByRole("textbox", { name: "Independent draft" }), { target: { value: "Newer B" } });
    fireEvent.click(screen.getByRole("button", { name: t("recover") }));
    await screen.findByRole("heading", { name: t("entry", { generation: "1", action: t("authorize") }) });
    expect((screen.getByRole("textbox", { name: "Independent draft" }) as HTMLInputElement).value).toBe("Newer B");
    expect(h.props.status.lease.generation).toBe("19");
  });

  it("does not let a delayed history response steal focus from newer input", async () => {
    const h = harness(), pending = deferred<unknown>(), original = invoke.getMockImplementation();
    if (!original) throw new Error("Missing synthetic read transport");
    invoke.mockImplementation((command: string, input: unknown) => command === "read_work_plan_history" ? pending.promise : original(command, input));
    fireEvent.click(screen.getByRole("button", { name: t("show") }));
    await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "read_work_plan_history")).toBe(true));
    const draft = screen.getByRole("textbox", { name: "Independent draft" }); draft.focus(); fireEvent.change(draft, { target: { value: "Newer B" } });
    await act(async () => { pending.resolve(h.first); await pending.promise; });
    await screen.findByRole("heading", { name: t("entry", { generation: "1", action: t("authorize") }) });
    expect(draft).toBe(document.activeElement); expect((draft as HTMLInputElement).value).toBe("Newer B");
    const records = screen.getByRole("region", { name: t("records") }); expect(within(records).getAllByRole("heading", { level: 6 })).toHaveLength(3);
  });
});

it("keeps independent bilingual plural and interpolation wording", async () => {
  expect(conversationRunHistoryEn.show).toBe("View plan history"); expect(conversationRunHistoryZh.show).toBe("查看计划历史");
  for (const language of ["en-US", "zh-CN"]) {
    await i18n.changeLanguage(language);
    for (const count of [0, 1, 2]) {
      const text = i18n.t("conversationRunHistory.scope", { count, locale: "ja-JP" });
      expect(text).toContain(String(count)); expect(text).toContain("ja-JP"); expect(text).not.toContain("{{");
    }
    expect(t("entry", { generation: "9007199254740993", action: "Original action" })).toContain("9007199254740993");
  }
});
