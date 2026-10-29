import { useLayoutEffect } from "react";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SourcePreparationSheet from "./SourcePreparationSheet";
import { useSourceDraftSession } from "../../../SourceDraftSession";
import { sourceCommands } from "../../../sourceCommands";
import { sourceDraftCommands } from "../../../sourceDraftCommands";
import { sourceDraftValue } from "../../../sourceDraftJournal";
import { translationCommands } from "../../../translationCommands";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { renderWorkbench } from "../../../testSupport/WorkbenchTestShell";
import { installSourceDraftFixture } from "../../../testSupport/sourceDraftFixture";
import { sourceDraftStateFixture } from "../../../testSupport/sourceDraftStateFixture";
import { sourcePageFixture, sourceRowFixture } from "../../../testSupport/sourceFixture";
import { fixtureIdentity as id } from "../../../testSupport/executionFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import wire from "../../../../test/fixtures/sourceCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...wire.session, locator: "/synthetic/source-history-sheet", reconciliationState: "settled",
  metadata: { projectId: wire.session.projectId, displayName: "Source history", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const snapshotId = id(920), currentSnapshot = id(921), attemptB = id(922);
const row = sourceRowFixture({ unitId: id(923), sourceRevisionId: id(924), occurrenceId: id(925) }, { key: "removed.entry", ordinal: 0, text: "Original {{name}} 世界" });
let owner: ReturnType<typeof useSourceDraftSession>, gate: InteractionGate;
const onEntry = vi.fn(), onClose = vi.fn();
function Harness() {
  const value = useSourceDraftSession(); useLayoutEffect(() => { owner = value; });
  return <SourcePreparationSheet project={project} owner={value} gate={gate} viewId="entries" open disabled={false}
    onClose={onClose} onApplied={vi.fn()} onOpenEntry={onEntry} target={null} savedSnapshotId={snapshotId}
    drop={null} dropFailure={null} onDropConsumed={vi.fn()}/>;
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  invoke.mockImplementation(async command => { throw new Error(`Unexpected history command: ${command}`); });
  gate = new InteractionGate(); gate.setVisibleOwner("entries");
  vi.spyOn(sourceCommands, "scope").mockResolvedValue({ revision: "5", currentSnapshot });
  vi.spyOn(sourceCommands, "historyContent").mockResolvedValue(sourcePageFixture({ snapshotId, rows: [row], total: 1, nextOrdinal: null }));
  vi.spyOn(sourceCommands, "lineage").mockResolvedValue([]);
  vi.spyOn(translationCommands, "history").mockResolvedValue({ unitId: row.unitId!, locale: "zh-CN", current: null,
    currentText: null, total: "0", rows: [], nextOrdinal: null });
});
afterEach(cleanup);

it.each(["en-US", "zh-CN"] as const)("opens saved A through real %s presentation without selecting a current entry or disturbing B", async language => {
  await i18n.changeLanguage(language); installSourceDraftFixture();
  const inputs = sourceDraftStateFixture(); inputs.source.actor = "Retained reviewer B 人工"; inputs.source.attempt = attemptB;
  inputs.source.receiptRef = { actionId: id(926), unitId: id(927), snapshotId, attemptId: id(928), resultId: id(929) };
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    expectedRevision: "0", writerId: id(930), value: sourceDraftValue(inputs, "2") } });
  const picker = vi.spyOn(sourceCommands, "selectPlugin"), start = vi.spyOn(sourceCommands, "startPlugin");
  renderWorkbench(<Harness/>, project);
  await waitFor(() => expect(owner.journal.hydration).toBe("ready"));
  const dialog = await screen.findByRole("dialog", { name: i18n.t("sourceMaintenance.savedSource") });
  expect(dialog).toHaveAccessibleName(language === "en-US" ? "Saved source details" : "已保存的源内容详情");
  await userEvent.setup().click(await screen.findByRole("button", { name: "removed.entry" }));
  expect(await screen.findByText(i18n.t("sourceMaintenance.noSavedTranslations"))).toBeVisible();
  expect(sourceCommands.historyContent).toHaveBeenCalledExactlyOnceWith({ ...wire.session, snapshotId, query: "", after: 0, limit: 20 });
  expect(translationCommands.history).toHaveBeenCalledExactlyOnceWith({ ...wire.session, unitId: row.unitId, locale: "zh-CN", afterOrdinal: "0", limit: 20 });
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.openCurrentEntry") })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: i18n.t("source.integration") })).not.toBeInTheDocument();
  expect(onEntry).not.toHaveBeenCalled(); expect(picker).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([command]) => String(command).includes("connection") || command === "read_plugin_inventory")).toBe(false);
  expect(owner.current().actor).toBe("Retained reviewer B 人工"); expect(owner.current().attempt).toBe(attemptB);
  await act(async () => { await owner.flush(); });
  const stored = await sourceDraftCommands.read({ sessionToken: project.sessionToken, key: { projectId: project.metadata.projectId } });
  expect(stored.value?.actor).toBe("Retained reviewer B 人工"); expect(stored.value?.attemptId).toBe(attemptB);
});
