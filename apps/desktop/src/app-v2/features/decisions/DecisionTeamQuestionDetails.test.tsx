import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { teamQuestionCommands } from "../../../teamQuestionCommands";
import { teamQuestionNavigationFixture } from "../../../testSupport/teamQuestionNavigationFixture";
import { i18n } from "../../../i18n";
import { decisionDetailsEn, decisionDetailsZh } from "../../../i18n/decisionDetails";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import DecisionDetails from "./DecisionDetails";
import type { DecisionItem } from "../../../decisionCommands";

const owners: SessionReads[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(reads => reads.retire()); vi.restoreAllMocks(); });

it.each(["en-US", "zh-CN"])("reads an unassociated member question without inventing an answer destination (%s)", async language => {
  await i18n.changeLanguage(language); const h = teamQuestionNavigationFixture(false), reads = new SessionReads(h.context); owners.push(reads);
  const reader = vi.spyOn(teamQuestionCommands, "question").mockResolvedValue(h.question), navigate = vi.fn(async (_item: DecisionItem, _current: () => boolean) => true);
  const respond = vi.spyOn(teamQuestionCommands, "respond").mockRejectedValue(new Error("Read-only details cannot answer"));
  render(<SessionReadProvider context={h.context} reads={reads} bridge={false}>
    <DecisionDetails item={h.item} disabled={false} current={() => true} onBack={vi.fn()} onOpenEntry={vi.fn(async () => false)} onNavigate={navigate}/>
  </SessionReadProvider>);
  expect(await screen.findByText(h.question.question.publication.body)).toBeTruthy();
  expect(screen.getByText(i18n.t("workbenchV2.decisionDetailsTeamQuestionReadOnly"))).toBeTruthy();
  expect(screen.queryByRole("button", { name: i18n.t("workbenchV2.decisionDetailsTeamQuestionOpen") })).toBeNull();
  expect(reader).toHaveBeenCalledWith({ ...h.context, planId: h.link.planId, questionPostId: h.question.question.publication.postId });
  expect(navigate).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled();
});

it.each(["en-US", "zh-CN"])("offers only the exact original open question destination (%s)", async language => {
  await i18n.changeLanguage(language); const h = teamQuestionNavigationFixture(), reads = new SessionReads(h.context); owners.push(reads);
  vi.spyOn(teamQuestionCommands, "question").mockResolvedValue(h.question);
  const navigate = vi.fn(async (_item: DecisionItem, _current: () => boolean) => true);
  render(<SessionReadProvider context={h.context} reads={reads} bridge={false}>
    <DecisionDetails item={h.item} disabled={false} current={() => true} onBack={vi.fn()} onOpenEntry={vi.fn(async () => false)} onNavigate={navigate}/>
  </SessionReadProvider>);
  const button = await screen.findByRole("button", { name: i18n.t("workbenchV2.decisionDetailsTeamQuestionOpen") });
  await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce()); expect(navigate.mock.calls[0]?.[0]).toEqual(h.item);
});

it("keeps independent English and Chinese navigation wording", () => {
  expect(decisionDetailsEn.decisionDetailsTeamQuestionOpen).toBe("Open and answer original question");
  expect(decisionDetailsZh.decisionDetailsTeamQuestionOpen).toBe("打开并回答原问题");
  expect(decisionDetailsEn.decisionDetailsTeamQuestionReadOnly).toContain("no saved conversation association");
  expect(decisionDetailsZh.decisionDetailsTeamQuestionReadOnly).toContain("没有关联已保存的会话");
});
