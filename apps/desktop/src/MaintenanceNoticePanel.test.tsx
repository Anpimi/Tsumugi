import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWorkbench as render } from "./testSupport/WorkbenchTestShell";
import { AiPreparationSession, useAiPreparation } from "./AiPreparationSession";
import { useSourceDraftSession } from "./SourceDraftSession";
import { useTranslationDraftSession } from "./TranslationDraftSession";
import { useSessionReads } from "./SessionReadProvider";
import { IncrementalMaintenance } from "./IncrementalMaintenance";
import { WorkbenchPanel, useWorkbenchState } from "./WorkbenchFrame";
import type { MaintenanceNoticeTarget } from "./sessionNavigation";
import { hookProject as project, hookObservation, hookAssessment } from "./testSupport/sourceMaintenanceHookFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import { i18n } from "./i18n";
import type { SourceMaintenanceHookObservation } from "./sourceMaintenanceHookCommands";
import type { MaintenanceAssessment } from "./workPlanCommands";
const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let ai: ReturnType<typeof useAiPreparation>, source: ReturnType<typeof useSourceDraftSession>, translations: ReturnType<typeof useTranslationDraftSession>, reads: ReturnType<typeof useSessionReads>;
let observation: SourceMaintenanceHookObservation, assessment: MaintenanceAssessment, snapshot: string;
function Probe() {
  const owner = useAiPreparation(), original = useSourceDraftSession(), manual = useTranslationDraftSession(), queries = useSessionReads();
  const [, setNotice] = useWorkbenchState<MaintenanceNoticeTarget | null>("ai", "maintenanceNotice", null);
  const [, setOpen] = useWorkbenchState("ai", "maintenanceOpen", false);
  useLayoutEffect(() => { ai = owner; source = original; translations = manual; reads = queries; });
  return <button type="button" onClick={() => { setNotice({ sourceActionId: observation.sourceActionId, sourceEditSeq: original.current().editSeq, aiEditSeq: owner.current().editSeq }); setOpen(true); }}>View saved notice</button>;
}
function Harness({ active = true }: { active?: boolean }) {
  return <AiPreparationSession initialLocale="fr" targetLocales={project.metadata.targetLocales}><Probe/>
    <WorkbenchPanel open={active} title="AI workspace" description="Synthetic notice handoff" onBack={() => {}}>
      <IncrementalMaintenance project={project} active={active} disabled={false}/>
    </WorkbenchPanel></AiPreparationSession>;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); observation = hookObservation(); assessment = hookAssessment(); snapshot = assessment.sourceSnapshotId;
  invoke.mockReset().mockImplementation(async (command: string, { request }: { request: Record<string, unknown> }) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: snapshot };
    if (command === "read_source_maintenance_hook") return structuredClone(observation);
    if (command === "read_maintenance_assessment") return { ...structuredClone(assessment), locale: request.locale, after: request.after };
    throw new Error(command);
  });
});
afterEach(cleanup);
async function open() {
  const view = render(<Harness/>, project), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "View saved notice" }));
  await screen.findByRole("heading", { name: "Notice entry 1" });
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t(ai.current().dirty ? "sourceHook.replaceDraft" : "sourceHook.createDraft") })).toBeEnabled());
  return { ...view, user };
}
it("opens the saved notice without changing the AI locale or capturing a draft and explicitly captures into the original owner", async () => {
  const { user } = await open();
  expect(ai.locale).toBe("fr"); expect(ai.maintenance).toBeNull(); expect(ai.selected).toEqual([]); expect(ai.current().dirty).toBe(false);
  expect(invoke.mock.calls.every(([command]) => ["read_content_scope", "read_source_maintenance_hook", "read_maintenance_assessment"].includes(command))).toBe(true);
  await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.createDraft") }));
  expect(ai.locale).toBe("zh-CN"); expect(ai.selected).toEqual([id(8811)]); expect(ai.maintenance?.choices.filter(choice => choice.excluded).map(choice => choice.unitId)).toEqual([id(8812), id(8813)]);
  expect(ai.preparedPlan).toBeNull(); expect(ai.consent).toBe(false);
  expect(screen.queryByRole("heading", { name: i18n.t("sourceHook.impactTitle") })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "AI workspace" })).toHaveFocus();
});
it("requires explicit replacement of a dirty AI draft and keeps independent model settings and translation input", async () => {
  const view = render(<Harness/>, project), user = userEvent.setup();
  act(() => { ai.setConfig({ ...ai.config, model: "Config B" }); ai.setSelected([id(8890)]);
    translations.begin({ unitId: id(8891), locale: "fr", key: "Manual", sourceRevisionId: id(8892), sourceText: "Synthetic" }, null, null, "Manual B"); });
  await user.click(screen.getByRole("button", { name: "View saved notice" }));
  const replace = await screen.findByRole("button", { name: i18n.t("sourceHook.replaceDraft") }); await waitFor(() => expect(replace).toBeEnabled());
  expect(ai.locale).toBe("fr"); expect(ai.selected).toEqual([id(8890)]);
  await user.click(replace); expect(screen.getByRole("dialog", { name: i18n.t("sourceHook.replaceTitle") })).toBeInTheDocument();
  expect(ai.maintenance).toBeNull();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.stay") })); expect(replace).toHaveFocus(); expect(ai.selected).toEqual([id(8890)]);
  await user.click(replace); await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.replaceConfirm") }));
  expect(ai.maintenance?.assessment.digest).toBe(assessment.digest); expect(ai.config.model).toBe("Config B"); expect(translations.current()?.text).toBe("Manual B");
  view.unmount();
});
it("refuses a later AI B while a replacement confirmation is open", async () => {
  const view = render(<Harness/>, project), user = userEvent.setup(); act(() => ai.setSelected([id(8890)]));
  await user.click(screen.getByRole("button", { name: "View saved notice" }));
  const replace = await screen.findByRole("button", { name: i18n.t("sourceHook.replaceDraft") }); await waitFor(() => expect(replace).toBeEnabled()); await user.click(replace);
  act(() => ai.setSelected([id(8893)]));
  expect(screen.getByRole("button", { name: i18n.t("sourceHook.replaceConfirm") })).toBeDisabled(); expect(ai.selected).toEqual([id(8893)]); expect(ai.maintenance).toBeNull();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.stay") }));
  expect(screen.getByRole("button", { name: i18n.t("sourceHook.replaceDraft") })).toBeDisabled(); view.unmount();
});
it("rejects a newer source B or an invalidated read without replacing current AI input", async () => {
  const { user } = await open();
  act(() => source.edit("actor", "Source B"));
  expect(screen.getByRole("button", { name: i18n.t("sourceHook.createDraft") })).toBeDisabled(); expect(ai.maintenance).toBeNull();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.closeImpact") }));
  expect(source.current().actor).toBe("Source B"); expect(screen.getByRole("heading", { name: "AI workspace" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "View saved notice" }));
  expect(screen.getByRole("button", { name: i18n.t("sourceHook.createDraft") })).toBeDisabled();
  act(() => { void reads.client.invalidateQueries({ queryKey: reads.key(["maintenance-assessment", snapshot, "zh-CN", 0, 100]), exact: true, refetchType: "none" }); });
  expect(ai.locale).toBe("fr"); expect(ai.selected).toEqual([]);
});
it("keeps saved rows as history when current source or maintenance changes and offers no capture for terminal unknown outcomes", async () => {
  const { user } = await open(); assessment = { ...assessment, digest: "c".repeat(64), rows: [] };
  await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.currentImpact") }));
  await screen.findByText(i18n.t("sourceHook.staleImpact")); expect(screen.getByRole("heading", { name: "Notice entry 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: i18n.t("sourceHook.createDraft") })).toBeDisabled(); expect(ai.maintenance).toBeNull();
  observation = hookObservation(observation.sourceActionId, observation.view!.activation, "interrupted");
  await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.currentImpact") })); await screen.findByText(i18n.t("sourceHook.unknownImpact"));
  expect(ai.locale).toBe("fr"); expect(invoke.mock.calls.every(([command]) => command.startsWith("read_"))).toBe(true);
});
it("keeps the saved notice and dirty B when current reads fail or the work area hides", async () => {
  const { user, rerender } = await open(); act(() => ai.setConfig({ ...ai.config, model: "Later B" }));
  const original = invoke.getMockImplementation()!; invoke.mockImplementation((command, args) => command === "read_maintenance_assessment" ? Promise.reject(new Error("Synthetic unavailable current window")) : original(command, args));
  await user.click(screen.getByRole("button", { name: i18n.t("sourceHook.currentImpact") })); await screen.findByText(i18n.t("sourceHook.currentFailed"));
  expect(screen.getByRole("heading", { name: "Notice entry 1" })).toBeInTheDocument(); expect(ai.config.model).toBe("Later B");
  const calls = invoke.mock.calls.length; rerender(<Harness active={false}/>); await act(async () => { await Promise.resolve(); });
  expect(invoke.mock.calls.length).toBe(calls); expect(ai.config.model).toBe("Later B"); expect(ai.maintenance).toBeNull();
});
