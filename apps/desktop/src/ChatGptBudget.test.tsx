import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AiConnectionFields } from "./AiConnectionFields";
import { CapturedRequestLimits, PreparationBudgetSummary } from "./ModelConnectionPicker";
import { connectionAiConfig, defaultAiConfig, editedAiConfig, sameAiConfig, validAiLimits, type AiConfig } from "./aiCommands";
import { sameConnection, type AiConnection } from "./connectionCommands";
import { fixtureIdentity } from "./testSupport/executionFixture";
import { i18n } from "./i18n";

const reference = { storeId: fixtureIdentity(970), profileId: fixtureIdentity(971), revision: "1", digest: "a".repeat(64) };
const subscription: AiConnection = { endpoint: "https://api.openai.com/v1/responses", model: "subscription-model", credentialEnv: "", tokenField: "chatgpt_subscription", chatgptAccount: fixtureIdentity(972) };
const api: AiConnection = { endpoint: "https://example.test/v1/chat/completions", model: "api-model", credentialEnv: "SYNTHETIC_KEY_NAME", tokenField: "max_tokens" };
const original: AiConfig = { ...defaultAiConfig, ...api, maxItems: 3, maxRequests: 7, maxOutputTokens: 37, maxRetries: 2, shareTerms: true };
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

it("requires explicit subscription budgets and restores legal API limits while retaining scope and sharing", () => {
  const selected = connectionAiConfig(original, subscription, reference);
  expect(selected).toMatchObject({ maxItems: 3, maxRequests: 7, maxOutputTokens: 0, maxRetries: 0, shareTerms: true, chatgptAccount: subscription.chatgptAccount, connectionProfile: reference });
  expect(validAiLimits(selected)).toBe(true);
  expect(validAiLimits({ ...selected, maxOutputTokens: 37 })).toBe(false);
  expect(validAiLimits({ ...selected, maxRetries: 1 })).toBe(false);
  const back = connectionAiConfig(selected, api, reference);
  expect(back.maxOutputTokens).toBe(defaultAiConfig.maxOutputTokens);
  expect(back.maxRetries).toBe(defaultAiConfig.maxRetries);
  expect(back.chatgptAccount).toBeUndefined();
  expect(back.maxRequests).toBe(7);
  expect(back.shareTerms).toBe(true);
  expect(validAiLimits(back)).toBe(true);
  expect(validAiLimits({ ...back, maxOutputTokens: 0 })).toBe(false);
  expect(connectionAiConfig(original, api, reference).maxOutputTokens).toBe(37);
  expect(connectionAiConfig(original, api, reference).maxRetries).toBe(2);
});

it("treats the selected account as captured connection identity and normalizes absent optional account values", () => {
  const selected = connectionAiConfig(original, subscription, reference);
  const changed = { ...selected, chatgptAccount: fixtureIdentity(973) };
  expect(sameConnection(selected, changed)).toBe(false);
  expect(sameAiConfig(selected, changed)).toBe(false);
  expect(editedAiConfig(selected, changed).connectionProfile).toBeNull();
  expect(sameConnection(api, { ...api, chatgptAccount: null })).toBe(true);
  expect(sameAiConfig(original, { ...original, chatgptAccount: null })).toBe(true);
});

it.each(["en-US", "zh-CN"])("states the subscription limits accurately in preparation, Arena and member previews in %s", async locale => {
  await i18n.changeLanguage(locale); const config = connectionAiConfig(original, subscription, reference);
  const { rerender } = render(<PreparationBudgetSummary config={config}/>);
  expect(screen.getByText(i18n.t("connections.subscriptionInvocationSummary", { items: "3", requests: "7", concurrency: "1", timeout: "60" }))).toBeInTheDocument();
  rerender(<PreparationBudgetSummary config={config} perRequest/>);
  expect(screen.getByText(i18n.t("connections.subscriptionRequestSummary", { timeout: "60" }))).toBeInTheDocument();
  rerender(<CapturedRequestLimits config={config} member/>);
  expect(screen.getByText(i18n.t("connections.subscriptionMemberSummary", { requests: "7", timeout: "60" }))).toBeInTheDocument();
});

it("keeps subscription reset in request mode and requires an explicit preset change to restore API output limits", async () => {
  function Editor() {
    const [config, setConfig] = useState(connectionAiConfig(original, subscription, reference));
    const [presetName, setPresetName] = useState("custom"), [connectionOpen, setConnectionOpen] = useState(true);
    return <><AiConnectionFields config={config} setConfig={setConfig} presetName={presetName} setPresetName={setPresetName} connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={null}/><output aria-label="Budget">{JSON.stringify(config)}</output></>;
  }
  const user = userEvent.setup(); render(<Editor/>);
  expect(screen.queryByRole("spinbutton", { name: i18n.t("ai.maxOutputTokens") })).not.toBeInTheDocument();
  expect(screen.queryByRole("spinbutton", { name: i18n.t("ai.maxRetries") })).not.toBeInTheDocument();
  await user.click(screen.getByText(i18n.t("ai.budget")));
  await user.click(screen.getByRole("button", { name: i18n.t("ai.reset") }));
  expect(screen.getByLabelText("Budget")).toHaveTextContent('"maxOutputTokens":0');
  await user.selectOptions(screen.getByRole("combobox", { name: i18n.t("ai.preset") }), "openai");
  expect(screen.getByRole("spinbutton", { name: i18n.t("ai.maxOutputTokens") })).toHaveValue(2000);
  expect(screen.getByRole("spinbutton", { name: i18n.t("ai.maxRetries") })).toHaveValue(0);
  expect(screen.getByLabelText("Budget")).not.toHaveTextContent('"chatgptAccount"');
});
