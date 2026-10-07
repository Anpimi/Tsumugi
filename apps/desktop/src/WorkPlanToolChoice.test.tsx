import { createRef, useState, type ReactNode } from "react";
import { cleanup, render as renderUi, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionReadProvider } from "./SessionReadProvider";
import { toolQueryInventory, toolQueryPackage, toolQueryView } from "./testSupport/pluginToolFixture";
import { WorkPlanToolChoice, type PlanToolDraft, type PlanToolChoiceHandle } from "./WorkPlanToolChoice";
import { i18n } from "./i18n";

const invoke = vi.hoisted(() => vi.fn());
function render(ui: ReactNode) { return renderUi(ui, { wrapper: ({ children }) => <SessionReadProvider context={{ projectId: "00000000-0000-4000-8000-000000000001", sessionToken: "synthetic-tool-choice" }} bridge={false}>{children}</SessionReadProvider> }); }
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  invoke.mockReset(); invoke.mockImplementation(async command => {
    if (command === "read_plugin_inventory") return structuredClone(toolQueryInventory);
    if (command === "read_plugin_package") return structuredClone(toolQueryPackage);
    if (command === "read_plugin_tool") return structuredClone(toolQueryView);
    throw new Error(command);
  });
});
afterEach(cleanup);

it("requires an explicit tool/environment choice and captures fixed options without arbitrary query text", async () => {
  const user = userEvent.setup(), ref = createRef<PlanToolChoiceHandle>();
  function Choice() {
    const [value, setValue] = useState<PlanToolDraft | null>(null);
    return <WorkPlanToolChoice open disabled={false} value={value} onChange={setValue} ref={ref} />;
  }
  render(<Choice />);
  expect(ref.current?.capture()).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox", { name: "Include a read-only reference tool" }));
  await screen.findByRole("option", { name: /philosophy.*agent-query-tool/ });
  expect(() => ref.current?.capture()).toThrow();
  await user.selectOptions(screen.getByRole("combobox", { name: "Reference package" }), `${toolQueryPackage.packageDigest}:${toolQueryView.resourceId}`);
  await user.selectOptions(screen.getByRole("combobox", { name: "Execution environment" }), toolQueryView.environmentDigest);
  await screen.findByRole("checkbox", { name: /^Term 👩🏽‍💻/ });
  await user.click(screen.getByRole("checkbox", { name: /^Term 👩🏽‍💻/ }));
  await waitFor(() => expect(ref.current?.capture()).toMatchObject({ target: "zh-CN", selections: ["term"], maxInvocations: 10, view: toolQueryView }));
  expect(ref.current?.capture()?.tool).toEqual({ package: { plugin: toolQueryPackage.manifest.plugin, packageDigest: toolQueryPackage.packageDigest }, resourceId: toolQueryView.resourceId, environmentDigest: toolQueryView.environmentDigest });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(invoke.mock.calls.some(([command]) => command.startsWith("start_") || command.startsWith("authorize_"))).toBe(false);
});
