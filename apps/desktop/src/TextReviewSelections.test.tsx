import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { TextReviewSelections } from "./TextReviewSelections";
import { pluginCommands, type PluginTextReviewSelection, type PluginTextReviewListView } from "./pluginCommands";
import { textReviewViewFixture } from "./testSupport/textReviewFixture";
import { i18n } from "./i18n";

vi.mock("./pluginCommands", () => ({ pluginCommands: { textReviews: vi.fn() } }));
const read = vi.mocked(pluginCommands.textReviews);
const list = (): PluginTextReviewListView => ({ settingsRevision: "1", entries: ["first-support", "second-support"].map((id, index) => {
  const view = textReviewViewFixture(id, (index ? "f" : "c").repeat(64));
  return { package: { plugin: view.binding.checker.provider.plugin, packageDigest: view.binding.checker.provider.packageDigest },
    resourceId: view.resourceId, environmentDigest: view.environmentDigest, availability: { kind: "ready", view } };
}) });
beforeEach(async () => { await i18n.changeLanguage("en-US"); read.mockReset(); read.mockResolvedValue(list()); });
afterEach(cleanup);
function Choices({ onChange, scopeKey = "scope" }: { onChange: (choices: PluginTextReviewSelection[]) => void; scopeKey?: string }) {
  const [value, setValue] = useState<PluginTextReviewSelection[]>([]);
  return <TextReviewSelections value={value} active disabled={false} scopeKey={scopeKey}
    onChange={choices => { setValue(choices); onChange(choices); }} />;
}

it("requires explicit rule choices and keeps equal rules from different providers distinct", async () => {
  const change = vi.fn(); const user = userEvent.setup();
  render(<Choices onChange={change} />);
  const rules = await screen.findAllByRole("checkbox", { name: "Preferred form" });
  expect(rules).toHaveLength(2); for (const rule of rules) expect(rule).not.toBeChecked();
  expect(change).not.toHaveBeenCalled();
  await user.click(rules[0]); await user.click(rules[1]);
  const choices: PluginTextReviewSelection[] = change.mock.calls.at(-1)![0];
  expect(choices).toHaveLength(2);
  expect(choices.map(choice => choice.package.plugin.id)).toEqual(["first-support", "second-support"]);
  expect(choices[0].rules).toEqual(choices[1].rules);
  expect(choices[0].rules).toHaveLength(1);
});

it("retains selected unavailable identities until the user removes them", async () => {
  const change = vi.fn(); const user = userEvent.setup();
  render(<Choices onChange={change} />);
  await user.click((await screen.findAllByRole("checkbox", { name: "Preferred form" }))[0]);
  const captured = change.mock.calls.at(-1)![0];
  const unavailable = list(); unavailable.entries[0].availability = { kind: "unavailable", error: {
    code: "permission-denied", stage: "read", outcome: "rejected", recoveryRequired: false, reason: "plugin-disabled",
  } };
  read.mockResolvedValue(unavailable);
  await user.click(screen.getByRole("button", { name: "Refresh text checkers" }));
  const remove = await screen.findByRole("button", { name: "Remove from this action" });
  expect(change.mock.calls.at(-1)![0]).toEqual(captured);
  expect(screen.queryAllByRole("checkbox", { name: "Preferred form" })).toHaveLength(1);
  await user.click(remove); expect(change.mock.calls.at(-1)![0]).toEqual([]);
});

it("ignores a late discovery response belonging to an earlier scope", async () => {
  let complete!: (value: PluginTextReviewListView) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const rendered = render(<Choices onChange={vi.fn()} scopeKey="old" />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  read.mockResolvedValue({ settingsRevision: "2", entries: [] });
  rendered.rerender(<Choices onChange={vi.fn()} scopeKey="new" />);
  await screen.findByText(/No text suggestion checkers are installed/);
  await act(async () => complete(list()));
  expect(screen.queryByRole("checkbox", { name: "Preferred form" })).not.toBeInTheDocument();
});

it("shows read failures without substituting an empty successful list", async () => {
  read.mockRejectedValue({ code: "storage-failed", stage: "read", outcome: "rejected", recoveryRequired: false });
  render(<Choices onChange={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Text checkers could not be read");
  expect(screen.queryByText(/No text suggestion checkers are installed/)).not.toBeInTheDocument();
});

it("preserves discovered choices while interaction is locked and unlocked", async () => {
  const onChange = vi.fn();
  const props = { value: [], onChange, active: true, scopeKey: "same-action" };
  const rendered = render(<TextReviewSelections {...props} disabled={false} />);
  const rules = await screen.findAllByRole("checkbox", { name: "Preferred form" });
  rendered.rerender(<TextReviewSelections {...props} disabled />);
  for (const rule of rules) expect(rule).toBeDisabled();
  read.mockImplementationOnce(() => new Promise(() => {}));
  rendered.rerender(<TextReviewSelections {...props} disabled={false} />);
  expect(screen.getAllByRole("checkbox", { name: "Preferred form" })).toHaveLength(2);
  for (const rule of rules) expect(rule).toBeEnabled();
  expect(read).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});

it("discovers the current scope even when interaction is initially locked", async () => {
  render(<TextReviewSelections value={[]} onChange={vi.fn()} active disabled scopeKey="locked-action" />);
  for (const rule of await screen.findAllByRole("checkbox", { name: "Preferred form" })) expect(rule).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh text checkers" })).toBeDisabled();
});
