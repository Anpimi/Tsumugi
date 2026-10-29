import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import SourceMappingTable from "./SourceMappingTable";
import { i18n } from "../../../i18n";
import type { LineageChoice, SourceChangePage } from "../../../sourceCommands";
import { sourceRowFixture } from "../../../testSupport/sourceFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import wire from "../../../../test/fixtures/sourceCommands.contract.json";

const previous = sourceRowFixture({ occurrenceId: fixtureIdentity(910) }, { ordinal: 3, key: "dialogue.hero", text: "Original {{name}}" });
const next = { ...previous.occurrence, ordinal: 7, text: "Changed {{name}} 世界" };
const page: SourceChangePage = { ...wire.comparison, total: 3, filteredTotal: 3, nextOrdinal: null,
  counts: { unchanged: 0, moved: 0, changed: 1, added: 0, renameCandidate: 1, ambiguous: 1, removed: 0 }, mappingReviewRequired: 3,
  rows: [{ kind: "changed", old: previous, new: next, candidates: [previous] }] };
const history = vi.fn(), detail = vi.fn();
function Harness() {
  const [choices, setChoices] = useState<Record<number, LineageChoice>>({});
  return <SourceMappingTable page={page} choices={choices} disabled={false} onHistorical={history} onDetails={detail}
    onChoice={(ordinal, choice) => setChoices(before => { const value = { ...before }; if (choice) value[ordinal] = choice; else delete value[ordinal]; return value; })}/>;
}
afterEach(cleanup);

it.each(["en-US", "zh-CN"] as const)("keeps Continue, Reject and unresolved distinct and preserves newer reason and focus during mounted %s language changes", async language => {
  await i18n.changeLanguage(language); render(<Harness/>); const user = userEvent.setup();
  const table = screen.getByRole("table", { name: i18n.t("sourceMaintenance.mappingTable") });
  const choice = within(table).getByRole("combobox", { name: i18n.t("sourceMaintenance.mappingField", { entry: next.nativeIdentity?.display.value || next.key }) });
  expect(choice).toHaveValue("unresolved");
  expect(within(choice).getByRole("option", { name: i18n.t("sourceMaintenance.unresolved") })).toBeVisible();
  await user.selectOptions(choice, `continue:${previous.occurrenceId}`);
  const name = next.nativeIdentity?.display.value || next.key;
  const reason = screen.getByRole<HTMLTextAreaElement>("textbox", { name: i18n.t("sourceMaintenance.reason", { entry: name }) });
  fireEvent.change(reason, { target: { value: "Newer B 👩🏽‍💻\n人工理由" } }); act(() => { reason.focus(); reason.setSelectionRange(2, 7, "backward"); });
  await act(async () => { await i18n.changeLanguage(language === "en-US" ? "zh-CN" : "en-US"); });
  expect(screen.getByRole("textbox", { name: i18n.t("sourceMaintenance.reason", { entry: name }) })).toBe(reason);
  expect(reason).toHaveValue("Newer B 👩🏽‍💻\n人工理由"); expect(reason).toHaveFocus(); expect(reason.selectionStart).toBe(2); expect(reason.selectionEnd).toBe(7);
  expect(screen.getByRole("table")).toHaveAccessibleName(language === "en-US" ? "源内容变化与条目对应" : "Source changes and entry matches");
  expect(within(choice).getByRole("option", { name: i18n.t("sourceMaintenance.reject", { entry: previous.occurrence.nativeIdentity?.display.value || previous.occurrence.key }) })).toBeVisible();
  await user.selectOptions(choice, `reject:${previous.occurrenceId}`); expect(choice).toHaveValue(`reject:${previous.occurrenceId}`);
  await user.selectOptions(choice, "unresolved"); expect(screen.queryByRole("textbox", { name: i18n.t("sourceMaintenance.reason", { entry: name }) })).not.toBeInTheDocument();
});
