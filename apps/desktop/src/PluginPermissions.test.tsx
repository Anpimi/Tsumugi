import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PackagePermissionReview, PluginPermissions } from "./PluginPermissions";
import type { PermissionRequest } from "./pluginCommands";
import { validateResponseCandidate } from "./generated/plugins.validators";
import { i18n } from "./i18n";
import packageFixture from "../test/fixtures/pluginPackage.contract.json";

beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

const requested: PermissionRequest[] = [
  { kind: "captured-input" },
  { kind: "staged-output" },
  { kind: "network", destination: "https://one.example.test" },
  { kind: "network", destination: "https://two.example.test" },
  { kind: "process", program: "approved-helper" },
  { kind: "process", program: "new-helper" },
  { kind: "project-service", contract: { id: "example.service", schemaVersion: 1, behaviorVersion: 1 } },
  { kind: "project-service", contract: { id: "example.service", schemaVersion: 1, behaviorVersion: 2 } },
];

it.each(["en-US", "zh-CN"])("highlights the complete changed declaration without treating matching kinds as approval in %s", async locale => {
  await i18n.changeLanguage(locale);
  render(<PluginPermissions permissions={requested} approvedPermissions={[requested[0], requested[2], requested[4], requested[6]]} review/>);
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(8);
  for (const index of [0, 2, 4, 6]) {
    expect(within(rows[index]).getByText(i18n.t("plugins.permissionPreviouslyApproved"))).toBeVisible();
    expect(rows[index]).not.toHaveAttribute("data-new-permission");
  }
  for (const index of [1, 3, 5, 7]) {
    expect(within(rows[index]).getByText(i18n.t("plugins.permissionNew"))).toBeVisible();
    expect(rows[index]).toHaveAttribute("data-new-permission", "true");
  }
});

it("shows every request as needing approval when a trusted baseline is unavailable", () => {
  render(<PluginPermissions permissions={requested} review/>);
  expect(screen.getAllByText(i18n.t("plugins.permissionNeedsApproval"))).toHaveLength(requested.length);
  expect(screen.queryByText(i18n.t("plugins.permissionPreviouslyApproved"))).not.toBeInTheDocument();
});

it("keeps package and individual capability approvals separate", () => {
  const value: unknown = packageFixture;
  if (!validateResponseCandidate(value) || !value) throw new Error("Invalid package fixture");
  const manifest = value.manifest;
  const previous = { ...manifest, permissions: manifest.permissions, contributions: [] };
  render(<PackagePermissionReview manifest={manifest} approvedManifest={previous} review/>);
  const packagePermissions = screen.getByRole("group", { name: i18n.t("plugins.packagePermissions") });
  const capabilityPermissions = screen.getByRole("group", { name: i18n.t("plugins.capability", { name: "query" }) });
  expect(within(packagePermissions).getByText(i18n.t("plugins.permissionPreviouslyApproved"))).toBeVisible();
  expect(within(capabilityPermissions).getByText(i18n.t("plugins.permissionNew"))).toBeVisible();
});
