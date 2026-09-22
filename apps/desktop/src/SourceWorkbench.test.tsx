import { createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceWorkbench, type SourceHandle } from "./SourceWorkbench";
import type { ContentPage } from "./sourceCommands";
import type { ProjectView } from "./projectCommands";
import { i18n } from "./i18n";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "session", locator: "C:\\isolated\\project", reconciliationState: "settled", metadata: { projectId: "project", displayName: "Demo", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const preview: ContentPage = { snapshotId: null, attemptId: "attempt", resultId: "result", scope: { revision: "1", currentSnapshot: null }, confirmation: { resultDigest: "digest", identityPolicy: "native-key", expectedContentRevision: "1", sourceLanguage: "en-US" }, namespace: "Example.Mod", coverage: [{ artifactId: "file", logicalPath: "i18n/default.json", role: "source", sha256: "hash" }], total: 2, nextOrdinal: 1, diagnostics: [], rows: [{ occurrenceId: null, unitId: null, sourceRevisionId: null, occurrence: { ordinal: 0, artifactId: "file", namespace: "Example.Mod", key: "hello", text: "Unchanged {{name}} 世界", keyByteRange: [1, 8], valueByteRange: [9, 30], identityBasis: "native-key" } }] };
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "read_source_integration") return { id: "stardew-smapi", version: "0.1.0", available: true, formatProfiles: ["smapi-i18n-flat"] };
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: null };
    if (command === "select_source") return { selectionId: "selection", folderName: "Example Mod" };
    if (command === "preflight_source") return { namespace: "Example.Mod", count: 2, sourceLanguage: "en-US", diagnostics: [], files: [] };
    if (command === "create_execution_identity") return "action";
    if (command === "start_source_import") return "attempt";
    if (command === "read_execution_attempt") return { attemptId: "attempt", taskId: "task", items: [{ resultId: "result", status: { execution: "succeeded", validation: "valid" } }] };
    if (command === "read_source_preview") return preview;
    if (command === "prepare_source_adoption" || command === "cancel_source_capture") return {};
    if (command === "adopt_execution" || command === "read_execution_receipt") return { changes: [{ kind: "source-snapshot", id: "snapshot", revision: "2" }] };
    if (command === "read_source_content") return { ...preview, snapshotId: "snapshot", scope: { revision: "2", currentSnapshot: "snapshot" } };
    throw new Error(command);
  });
});
afterEach(cleanup);
it.each([
  ["en-US", "Source content", "Choose Mod folder", "I confirm", "Check source files", "Every value in i18n/default.json must be a string."],
  ["zh-CN", "源内容", "选择 Mod 文件夹", "我确认", "检查源文件", "i18n/default.json 中的每个值都必须是字符串。"],
])("explains unsupported source values in %s and allows rechecking", async (locale, entry, choose, declaration, check, message) => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation()!;
  let invalid = true;
  invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "preflight_source" && invalid) return Promise.reject({ code: "output-invalid", field: "source-value-not-string" });
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: entry }));
  await user.click(await screen.findByRole("button", { name: choose }));
  await user.click(screen.getByRole("checkbox", { name: new RegExp(declaration) }));
  await user.click(screen.getByRole("button", { name: check }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  invalid = false;
  await user.click(screen.getByRole("button", { name: check }));
  await screen.findByText(/Example\.Mod[:：]/);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
async function select() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Source content" }));
  await user.click(await screen.findByRole("button", { name: "Choose Mod folder" }));
  await screen.findByText("Example Mod");
  return user;
}
async function prepare() {
  const user = await select();
  await user.click(screen.getByRole("checkbox", { name: /I confirm/ }));
  await user.click(screen.getByRole("button", { name: "Check source files" }));
  await user.click(await screen.findByRole("button", { name: "Import for preview" }));
  await screen.findByRole("heading", { name: "Review imported strings" });
  return user;
}
it("requires a language declaration and full-range confirmation, retaining literal source text", async () => {
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  expect(screen.getByText("Unchanged {{name}} 世界")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply to project" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2 strings/ }));
  await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await screen.findByRole("heading", { name: "Imported source content" });
  expect(invoke).toHaveBeenCalledWith("prepare_source_adoption", { request: { sessionToken: "session", projectId: "project", attemptId: "attempt", resultId: "result", actionId: "action", confirmation: preview.confirmation } });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});
it("keeps the selection across view changes and requires a decision before leaving the project", async () => {
  const ref = createRef<SourceHandle>();
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  const user = await select();
  expect(screen.getByRole("button", { name: "Check source files" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Source content" }));
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "Stay in project" }));
  expect(await decision).toBe(false);
  expect(screen.getByText("Example Mod")).toBeInTheDocument();
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "Discard selection and continue" }));
  expect(await decision).toBe(true);
  expect(invoke).toHaveBeenCalledWith("cancel_source_capture", { request: { sessionToken: "session", projectId: "project" } });
});
it("queries a lost acknowledgement without applying a second time", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "adopt_execution") throw { code: "outcome-unknown" };
    if (command === "read_content_scope" && invoke.mock.calls.some(([name]) => name === "read_execution_receipt")) return { revision: "2", currentSnapshot: "snapshot" };
    return original(command, args);
  });
  render(<SourceWorkbench project={project} disabled={false} />);
  const user = await prepare();
  await user.click(screen.getByRole("checkbox", { name: /Apply all 2/ }));
  await user.click(screen.getByRole("button", { name: "Apply to project" }));
  await user.click(await screen.findByRole("button", { name: "Check recorded outcome" }));
  await screen.findByRole("heading", { name: "Imported source content" });
  expect(invoke.mock.calls.filter(([name]) => name === "adopt_execution")).toHaveLength(1);
});
it("ignores a preflight response invalidated by leaving, and supports Chinese labels", async () => {
  await i18n.changeLanguage("zh-CN");
  const ref = createRef<SourceHandle>();
  render(<SourceWorkbench ref={ref} project={project} disabled={false} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "源内容" }));
  await user.click(await screen.findByRole("button", { name: "选择 Mod 文件夹" }));
  await user.click(screen.getByRole("checkbox", { name: /我确认/ }));
  let complete!: (value: unknown) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: unknown) => command === "preflight_source" ? new Promise(resolve => { complete = resolve; }) : original(command, args));
  await user.click(screen.getByRole("button", { name: "检查源文件" }));
  let decision!: Promise<boolean>;
  act(() => { decision = ref.current!.allowLeave(); });
  await user.click(screen.getByRole("button", { name: "放弃选择并继续" }));
  expect(await decision).toBe(true);
  await act(async () => { complete({ namespace: "STALE", count: 1, diagnostics: [] }); });
  await waitFor(() => expect(screen.queryByText(/STALE/)).not.toBeInTheDocument());
});
