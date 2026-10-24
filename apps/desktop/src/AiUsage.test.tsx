import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AiOutputUsage, AiProviderBudget } from "./AiUsage";
import { i18n } from "./i18n";
import { enUS } from "./i18n/en-US";
import type { AiUsageView, ProviderBudget } from "./generated/ai.responses";
import { unreportedTokenTotalsFixture, unreportedUsageDetailsFixture } from "./testSupport/usageFixture";

afterEach(cleanup);

function detail(field: "cacheRead" | "cacheWrite" | "reasoning") {
  const group = screen.getByText(i18n.t(`ai.usageDetails.${field}`)).parentElement;
  if (!group) throw new Error("Expected the reported token detail group");
  return within(group);
}

it.each(["en-US", "zh-CN"])("distinguishes reported zero from unreported details without changing complete totals in %s", async locale => {
  await i18n.changeLanguage(locale);
  const usage: AiUsageView = { promptTokens: "0", completionTokens: "0", cacheReadTokens: "0", cacheWriteTokens: null, reasoningTokens: null };
  render(<AiOutputUsage usage={usage} incomplete={false}/>);
  expect(screen.getByText(i18n.t("ai.usage", { ...usage, defaultValue: enUS.ai.usage }))).toBeVisible();
  expect(screen.queryByText(i18n.t("ai.usageDetails.partialTotals"))).not.toBeInTheDocument();
  const summary = screen.getByText(i18n.t("ai.usageDetails.title"));
  expect(summary.closest("details")).not.toHaveAttribute("open");
  await userEvent.setup().click(summary);
  expect(detail("cacheRead").getByText(i18n.t("ai.usageDetails.reported", { tokens: "0" }))).toBeVisible();
  expect(detail("cacheWrite").getByText(i18n.t("ai.usageDetails.notReported"))).toBeVisible();
  expect(detail("reasoning").getByText(i18n.t("ai.usageDetails.notReported"))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.usageDetails.billingUnknown"))).toBeVisible();
});

it.each(["en-US", "zh-CN"])("shows exact ledger portions and independent missing-report counts without treating unknown as zero in %s", async locale => {
  await i18n.changeLanguage(locale);
  const budget: ProviderBudget = { limit: 20, dispatched: 3, legacyHeld: 1, unresolved: 1, usageUnknown: 0,
    promptTokens: "5534023222112865484500", completionTokens: "20", cacheRead: { tokens: "0", unknownRequests: 0 },
    cacheWrite: { tokens: "0", unknownRequests: 3 }, reasoning: { tokens: "18446744073709551615", unknownRequests: 1 } };
  const view = render(<AiProviderBudget budget={budget}/>);
  expect(screen.getByText(i18n.t("ai.budgetSummary", { ...budget, defaultValue: enUS.ai.budgetSummary }))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.budgetUsage", { ...budget, defaultValue: enUS.ai.budgetUsage }))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.legacyBudget", { count: 1, defaultValue: enUS.ai.legacyBudget }))).toBeVisible();
  await userEvent.setup().click(screen.getByText(i18n.t("ai.usageDetails.title")));
  expect(detail("cacheRead").getByText(i18n.t("ai.usageDetails.reported", { tokens: "0" }))).toBeVisible();
  expect(detail("cacheWrite").getByText(i18n.t("ai.usageDetails.partial", { tokens: "0", requests: "3" }))).toBeVisible();
  expect(detail("reasoning").getByText(i18n.t("ai.usageDetails.partial", { tokens: "18446744073709551615", requests: "1" }))).toBeVisible();
  expect(screen.queryByText(i18n.t("ai.usageDetails.partialTotals"))).not.toBeInTheDocument();
  expect(screen.getByText(i18n.t("ai.usageDetails.billingUnknown"))).toBeVisible();
  const unavailable: ProviderBudget = { ...budget, usageUnknown: 3, promptTokens: "0", completionTokens: "0", ...unreportedTokenTotalsFixture(3) };
  view.rerender(<AiProviderBudget budget={unavailable}/>);
  expect(screen.getByText(i18n.t("ai.budgetSummary", { ...unavailable, defaultValue: enUS.ai.budgetSummary }))).toBeVisible();
  expect(screen.getAllByText(i18n.t("ai.usageDetails.partial", { tokens: "0", requests: "3" }))).toHaveLength(3);
  expect(screen.queryByText(i18n.t("ai.usageDetails.reported", { tokens: "0" }))).not.toBeInTheDocument();
});

it.each(["en-US", "zh-CN"])("keeps missing details separate from partial or wholly unavailable request totals in %s", async locale => {
  await i18n.changeLanguage(locale);
  const usage: AiUsageView = { promptTokens: "17", completionTokens: "5", ...unreportedUsageDetailsFixture() };
  const view = render(<AiOutputUsage usage={usage} incomplete={false}/>);
  await userEvent.setup().click(screen.getByText(i18n.t("ai.usageDetails.title")));
  expect(screen.getAllByText(i18n.t("ai.usageDetails.notReported"))).toHaveLength(3);
  expect(screen.queryByText(i18n.t("ai.usageDetails.partialTotals"))).not.toBeInTheDocument();
  view.rerender(<AiOutputUsage usage={usage} incomplete/>);
  expect(screen.getByText(i18n.t("ai.usageDetails.partialTotals"))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.usage", { ...usage, defaultValue: enUS.ai.usage }))).toBeVisible();
  view.rerender(<AiOutputUsage usage={null} incomplete/>);
  expect(screen.getByText(i18n.t("ai.usageUnknown"))).toBeVisible();
  expect(screen.queryByText(i18n.t("ai.usageDetails.title"))).not.toBeInTheDocument();
  expect(screen.queryByText(i18n.t("ai.usageDetails.reported", { tokens: "0" }))).not.toBeInTheDocument();
  expect(screen.getByText(i18n.t("ai.usageDetails.billingUnknown"))).toBeVisible();
});

it.each(["en-US", "zh-CN"])("does not add overlapping cache or reasoning details to totals and preserves a large detail string in %s", async locale => {
  await i18n.changeLanguage(locale);
  const usage: AiUsageView = { promptTokens: "100", completionTokens: "20", cacheReadTokens: "80", cacheWriteTokens: "90", reasoningTokens: "10" };
  const view = render(<AiOutputUsage usage={usage} incomplete={false}/>);
  expect(screen.getByText(i18n.t("ai.usage", { ...usage, defaultValue: enUS.ai.usage }))).toBeVisible();
  await userEvent.setup().click(screen.getByText(i18n.t("ai.usageDetails.title")));
  for (const [field, tokens] of [["cacheRead", "80"], ["cacheWrite", "90"], ["reasoning", "10"]] as const) {
    expect(detail(field).getByText(i18n.t("ai.usageDetails.reported", { tokens }))).toBeVisible();
  }
  expect(screen.getByText(i18n.t("ai.usageDetails.subsets"))).toBeVisible();
  view.rerender(<AiOutputUsage usage={{ ...usage, cacheReadTokens: "18446744073709551615" }} incomplete={false}/>);
  expect(detail("cacheRead").getByText(i18n.t("ai.usageDetails.reported", { tokens: "18446744073709551615" }))).toBeVisible();
  expect(screen.getByText(i18n.t("ai.usage", { ...usage, defaultValue: enUS.ai.usage }))).toBeVisible();
});
