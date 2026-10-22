import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "./ApplicationReadProvider";
import { ChatGptConnectionFields } from "./ChatGptConnectionFields";
import type { ChatGptAccountStatus, ChatGptLoginView } from "./ChatGptCommands";
import type { AiConnection } from "./connectionCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const accountId = fixtureIdentity(980), oldAccountId = fixtureIdentity(981), registrationId = fixtureIdentity(982);
const login: ChatGptLoginView = { id: fixtureIdentity(983), authorizationUrl: "https://auth.openai.com/authorize", expiresAt: 2000000000000 };
const connection: AiConnection = { endpoint: "https://api.openai.com/v1/responses", model: "retained-model", credentialEnv: "", tokenField: "chatgpt_subscription", chatgptAccount: oldAccountId };
const signedIn = (): ChatGptAccountStatus => ({ account: { id: accountId, registration: registrationId, label: "Synthetic account 日本語" }, registrations: [{ id: registrationId, label: "Synthetic account 日本語" }], login: null, issue: null });
function Harness() {
  const [draft, setDraft] = useState(connection), [note, setNote] = useState("");
  return <><label>Draft note<input value={note} onChange={event => setNote(event.target.value)}/></label>
    <ChatGptConnectionFields connection={draft} disabled={false} onChange={setDraft}/><output aria-label="Draft connection">{JSON.stringify(draft)}</output></>;
}
function setup() { return render(<ApplicationReadProvider><Harness/></ApplicationReadProvider>); }
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset().mockImplementation(async command => {
  if (command === "read_chatgpt_account") return signedIn();
  if (command === "read_chatgpt_models") return { account: accountId, models: [{ id: "available-model", label: "Available model" }] };
  throw new Error(command);
}); });
afterEach(cleanup);

it.each(["en-US", "zh-CN"])("requires explicit account and catalog actions without replacing a draft in %s", async locale => {
  await i18n.changeLanguage(locale); const user = userEvent.setup(); setup();
  expect(invoke).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.check") }));
  await screen.findByText(i18n.t("connections.chatgpt.signedIn", { account: "Synthetic account 日本語" }));
  expect(screen.getByLabelText("Draft connection")).toHaveTextContent(oldAccountId);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_chatgpt_account"]);
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.useAccount", { account: "Synthetic account 日本語" }) }));
  expect(screen.getByLabelText("Draft connection")).toHaveTextContent(accountId);
  expect(screen.getByRole("combobox", { name: i18n.t("connections.model") })).toHaveValue("");
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.refreshModels") }));
  await screen.findByRole("option", { name: "Available model" });
  await user.selectOptions(await screen.findByRole("combobox", { name: i18n.t("connections.model") }), "available-model");
  expect(screen.getByLabelText("Draft connection")).toHaveTextContent("available-model");
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["read_chatgpt_account", "read_chatgpt_models"]);
  expect(invoke).toHaveBeenLastCalledWith("read_chatgpt_models", { request: { account: accountId } });
});

it("waits only after explicit login and keeps newer edits and the previous account reference", async () => {
  invoke.mockImplementation(async command => command === "begin_chatgpt_login" ? login : command === "read_chatgpt_account" ? signedIn() : Promise.reject(new Error(command)));
  const user = userEvent.setup(); setup();
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.signIn") }));
  await screen.findByText(i18n.t("connections.chatgpt.pending"));
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["begin_chatgpt_login"]);
  expect(invoke).toHaveBeenCalledWith("begin_chatgpt_login", { request: { registration: null } });
  await user.type(screen.getByLabelText("Draft note"), "Newer B 日本語");
  await waitFor(() => expect(screen.getByText(i18n.t("connections.chatgpt.signedIn", { account: "Synthetic account 日本語" }))).toBeInTheDocument(), { timeout: 2500 });
  expect(screen.getByLabelText("Draft note")).toHaveValue("Newer B 日本語");
  expect(screen.getByLabelText("Draft connection")).toHaveTextContent(oldAccountId);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["begin_chatgpt_login", "read_chatgpt_account"]);
});

it("uses the selected saved registration and cancels the exact pending login", async () => {
  invoke.mockImplementation(async command => {
    if (command === "read_chatgpt_account") return signedIn();
    if (command === "begin_chatgpt_login") return login;
    if (command === "cancel_chatgpt_login") return { ...signedIn(), issue: "login_cancelled" };
    throw new Error(command);
  });
  const user = userEvent.setup(); setup();
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.check") }));
  await user.selectOptions(await screen.findByRole("combobox", { name: i18n.t("connections.chatgpt.returningAccount") }), registrationId);
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.continue") }));
  await screen.findByText(i18n.t("connections.chatgpt.pending"));
  expect(invoke).toHaveBeenCalledWith("begin_chatgpt_login", { request: { registration: registrationId } });
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.cancel") }));
  await screen.findByText(i18n.t("connections.chatgpt.issues.login_cancelled"));
  expect(invoke).toHaveBeenLastCalledWith("cancel_chatgpt_login", { request: { sessionId: login.id } });
  expect(screen.getByLabelText("Draft connection")).toHaveTextContent(oldAccountId);
});

it("signs out only the observed account and retains the saved draft", async () => {
  invoke.mockImplementation(async command => command === "logout_chatgpt_account" ? { ...signedIn(), account: null } : signedIn());
  const user = userEvent.setup(); setup();
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.check") }));
  await user.click(await screen.findByRole("button", { name: i18n.t("connections.chatgpt.logout") }));
  await screen.findByText(i18n.t("connections.chatgpt.signedOut"));
  expect(invoke).toHaveBeenLastCalledWith("logout_chatgpt_account", { request: { account: accountId } });
  expect(screen.getByLabelText("Draft connection")).toHaveTextContent(oldAccountId);
});

it("stops automatic waiting at login expiry and retains the exact session for manual cancellation", async () => {
  const expired = { ...login, expiresAt: Date.now() - 1 };
  invoke.mockImplementation(async command => command === "begin_chatgpt_login" ? expired : command === "cancel_chatgpt_login" ? { ...signedIn(), issue: "login_cancelled" } : Promise.reject(new Error(command)));
  const user = userEvent.setup(); setup();
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.signIn") }));
  await screen.findByText(i18n.t("connections.chatgpt.pendingPaused"));
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["begin_chatgpt_login"]);
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.cancel") }));
  await screen.findByText(i18n.t("connections.chatgpt.issues.login_cancelled"));
  expect(invoke).toHaveBeenLastCalledWith("cancel_chatgpt_login", { request: { sessionId: expired.id } });
});

it("rejects malformed account status without changing the retained connection", async () => {
  invoke.mockResolvedValue({ ...signedIn(), accessToken: "synthetic-untrusted-value" });
  const user = userEvent.setup(); setup();
  await user.click(screen.getByRole("button", { name: i18n.t("connections.chatgpt.check") }));
  await screen.findByText(i18n.t("connections.chatgpt.readFailed"));
  expect(screen.getByLabelText("Draft connection")).toHaveTextContent(oldAccountId);
  expect(screen.queryByText("synthetic-untrusted-value")).not.toBeInTheDocument();
});
