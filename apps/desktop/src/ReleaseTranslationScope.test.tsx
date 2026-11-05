import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/reviewCommands.contract.json";
import { i18n } from "./i18n";
import { validateResponsePage } from "./generated/review.validators";
import { TranslationScopeChoices } from "./ReleaseTranslationScope";

function page() {
  const value = structuredClone(fixture.responses.page);
  if (!validateResponsePage(value)) throw new Error("Invalid review fixture");
  return value;
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

it("distinguishes a full build from an explicit all-source stage and selected translations", () => {
  const source = page();
  function Harness() {
    const [selected, setSelected] = useState<string[] | undefined>();
    return <TranslationScopeChoices locale="zh-CN" selected={selected} disabled={false} onChange={value => setSelected(value ?? undefined)}
      page={source} loading={false} failed={false} retry={() => {}}/>;
  }
  render(<Harness/>);
  expect(screen.queryByText("Wooden barrel")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Use selected translations and retain source for other entries" }));
  expect(screen.getByText(/No translations are selected/)).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: "Include saved translation for wooden-barrel" }));
  expect(screen.getByRole("status")).toHaveTextContent("Translations selected: 1");
  fireEvent.click(screen.getByRole("button", { name: "Retain source for every entry" }));
  expect(screen.getByRole("status")).toHaveTextContent("Translations selected: 0");
  expect(source.rows[0].translationText).toEqual(fixture.responses.page.rows[0].translationText);
});

it("keeps the selection visible on read failure and provides a retry", () => {
  const retry = vi.fn(), selected = [page().rows[0].unitId];
  render(<TranslationScopeChoices locale="zh-CN" selected={selected} disabled={false} onChange={() => {}}
    loading={false} failed retry={retry}/>);
  expect(screen.getByRole("alert")).toHaveTextContent("Your selection is kept");
  expect(screen.getByRole("status")).toHaveTextContent("Translations selected: 1");
  fireEvent.click(screen.getByRole("button", { name: "Read entries again" })); expect(retry).toHaveBeenCalledOnce();
});

it("renders long publisher text literally and disables conflicting scope edits", async () => {
  await i18n.changeLanguage("zh-CN");
  const source = page(); source.rows[0].sourceText = "Synthetic <script>alert('literal')</script> — 世界 👩🏽‍💻";
  const change = vi.fn();
  const { container } = render(<TranslationScopeChoices locale="zh-CN" selected={[]} disabled onChange={change}
    page={source} loading={false} failed={false} retry={() => {}}/>);
  expect(screen.getByRole("region", { name: "zh-CN 的译文范围" })).toBeVisible();
  expect(screen.getByText("尚未选择译文。本次阶段产物的所有条目都将保留原文。")).toBeVisible();
  expect(container.querySelector("script")).toBeNull();
  for (const control of screen.getAllByRole("checkbox")) expect(control).toBeDisabled();
  expect(change).not.toHaveBeenCalled();
});
