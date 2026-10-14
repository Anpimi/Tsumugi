import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchStates } from "./WorkbenchStates";
import { i18n } from "../../i18n";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("keeps newer B unsaved when the example's submitted A settles", async () => {
  await i18n.changeLanguage("en-US"); vi.useFakeTimers();
  render(<WorkbenchStates view="editor" state="dirty" theme="light" locale="en-US" scale={1} />);
  const input = screen.getByRole("textbox", { name: "Translation draft" });
  fireEvent.change(input, { target: { value: "Submitted A 👩🏽‍💻 é" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview save and next" }));
  fireEvent.change(input, { target: { value: "Newer B {{hayCount}} 👩🏽‍💻 é" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(input).toHaveValue("Newer B {{hayCount}} 👩🏽‍💻 é");
  expect(screen.getByText("Submitted text saved; newer edits remain unsaved.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview save" })).toBeEnabled();
});

it("keeps the reference release blocked and directs its blocker to the editor", async () => {
  await i18n.changeLanguage("en-US");
  render(<WorkbenchStates view="delivery" state="conflict" theme="dark" locale="en-US" scale={1} />);
  expect(screen.getByRole("button", { name: "View build-result layout" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Open reference entry" })).toHaveAttribute("href", "iframe.html?id=workbench-states--editor-dirty&viewMode=story");
  expect(screen.getByText("Earlier verified output")).toBeVisible();
});

it("keeps the draft and search when compact controls are collapsed and reopened", async () => {
  await i18n.changeLanguage("en-US"); const user = userEvent.setup();
  render(<WorkbenchStates view="editor" state="dirty" theme="light" locale="en-US" scale={2} />);
  const find = screen.getByRole("button", { name: "Find in reference entries" });
  expect(screen.queryByRole("textbox", { name: "Find in reference entries" })).not.toBeInTheDocument();
  await user.click(find);
  const query = screen.getByRole("textbox", { name: "Find in reference entries" });
  await user.type(query, "stored-hay");
  const draft = screen.getByRole("textbox", { name: "Translation draft" });
  fireEvent.change(draft, { target: { value: "New B {{hayCount}}" } });
  await user.click(find);
  expect(screen.queryByRole("textbox", { name: "Find in reference entries" })).not.toBeInTheDocument();
  expect(draft).toHaveValue("New B {{hayCount}}");
  await user.click(find);
  expect(screen.getByRole("textbox", { name: "Find in reference entries" })).toHaveValue("stored-hay");
  expect(screen.getByText("building.stored-hay.summary", { exact: true })).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview save" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: /building\.stored-hay\.summary/ }));
  expect(screen.queryByRole("textbox", { name: "Find in reference entries" })).not.toBeInTheDocument();
  expect(draft).toHaveFocus();
  expect(draft).toHaveValue("New B {{hayCount}}");
});

it("requires the displayed sample consent before showing the approved layout without installation", async () => {
  await i18n.changeLanguage("en-US"); const user = userEvent.setup();
  render(<WorkbenchStates view="plugins" state="ready" theme="dark" locale="en-US" scale={1} />);
  const preview = screen.getByRole("button", { name: "View approved-state layout" }); expect(preview).toBeDisabled();
  await user.click(screen.getByRole("checkbox")); expect(preview).toBeEnabled(); await user.click(preview);
  expect(screen.getByText("Approved-state example shown. No installation, grant or component execution occurred.")).toBeVisible();
});
