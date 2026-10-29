import { useState, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import { projectMetadataEn, projectMetadataZh } from "../../../i18n/projectMetadata";
import type { CommandError, MetadataMutationView, ProjectView } from "../../../projectCommands";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import ProjectMetadataSheet from "./ProjectMetadataSheet";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "metadata-session", locator: "/synthetic/projects/original", reconciliationState: "settled",
  metadata: { projectId: "11111111-1111-4111-8111-111111111111", metadataRevision: "1", displayName: "Original project", sourceLocale: "en-US", targetLocales: ["zh-Hans", "ja-JP"] } };
type Label = keyof typeof projectMetadataEn;
const t = (key: Label) => i18n.t(`projectMetadata.${key}`);
const copy = <T,>(value: T): T => structuredClone(value);
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let disk: ProjectView, controller: ProjectLifecycle | undefined;
function receipt(): MetadataMutationView { return { sessionToken: disk.sessionToken, locator: disk.locator, metadata: copy(disk.metadata), outcome: "changed", directoryChanged: disk.locator !== project.locator }; }
function commitName(name: string) { disk = { ...disk, metadata: { ...disk.metadata, displayName: name, metadataRevision: String(BigInt(disk.metadata.metadataRevision) + 1n) } }; return receipt(); }
async function setup() {
  const close = vi.fn(async () => ({ closed: true }));
  controller = new ProjectLifecycle({ open: async () => copy(disk), close, status: async () => ({ active: false, quiescing: false, queryCount: 0, error: null }) });
  const lifecycle = controller; await lifecycle.open(project.locator);
  let show!: (visible: boolean) => void;
  const onClose = vi.fn(), onChanged = vi.fn(async () => lifecycle.refresh());
  function Harness() {
    const state = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot), [visible, setVisible] = useState(true); show = setVisible;
    return <ProjectMetadataSheet project={state.session?.project ?? project} visible={visible} disabled={state.phase !== "idle"} current={() => state.phase === "idle"}
      lifecycle={lifecycle} onReveal={() => setVisible(true)} onClose={() => { onClose(); setVisible(false); }} onChanged={onChanged}/>;
  }
  const view = render(<Harness/>); return { lifecycle, close, onClose, onChanged, view, show: (visible: boolean) => show(visible), user: userEvent.setup() };
}
beforeEach(async () => {
  i18n.addResourceBundle("en-US", "translation", { projectMetadata: projectMetadataEn }, true, true);
  i18n.addResourceBundle("zh-CN", "translation", { projectMetadata: projectMetadataZh }, true, true);
  await i18n.changeLanguage("en-US"); disk = copy(project); invoke.mockReset();
  invoke.mockImplementation(async (command: string, { request }) => {
    if (command === "read_project") return copy(disk);
    if (command === "rename_project") return commitName(request.displayName);
    if (command === "set_target_locales") { disk = { ...disk, metadata: { ...disk.metadata, targetLocales: request.targetLocales, metadataRevision: String(BigInt(disk.metadata.metadataRevision) + 1n) } }; return receipt(); }
    throw new Error(`Unexpected synthetic metadata command: ${command}`);
  });
});
afterEach(() => { cleanup(); controller?.dispose(); controller = undefined; vi.restoreAllMocks(); });

it("retains name B and the independent language edit after acknowledgement A, then uses the confirmed revision", async () => {
  const h = await setup(), pending = deferred<MetadataMutationView>(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "rename_project" && calls(command).length === 1 ? pending.promise : original(command, payload));
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Name A" } });
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Name B 👩🏽‍💻" } });
  fireEvent.change(screen.getByRole("textbox", { name: t("languages") }), { target: { value: "zh-Hans, fr-FR" } });
  await act(async () => { pending.resolve(commitName("Name A")); await pending.promise; });
  await waitFor(() => expect(screen.getByRole("button", { name: t("saveName") })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("Name B 👩🏽‍💻");
  expect(screen.getByRole("textbox", { name: t("languages") })).toHaveValue("zh-Hans, fr-FR");
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  await waitFor(() => expect(calls("rename_project")).toHaveLength(2));
  expect(calls("rename_project")[1][1].request).toEqual({ sessionToken: project.sessionToken, expectedRevision: "2", displayName: "Name B 👩🏽‍💻" });
  expect(calls("set_target_locales")).toHaveLength(0);
});

it("keeps an unknown original request, blocks close and resubmission, and checks its exact revision without losing B", async () => {
  const h = await setup(), original = invoke.getMockImplementation()!; let reads = 0;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "rename_project") { commitName(payload.request.displayName); throw new Error("Lost original acknowledgement"); }
    if (command === "read_project" && ++reads === 1) throw new Error("Original read unavailable");
    return original(command, payload);
  });
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Name A" } });
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  await screen.findByText(t("readFailed"));
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Reasonable newer B" } });
  expect(screen.getByRole("button", { name: t("saveName") })).toBeDisabled();
  await act(async () => { expect(await h.lifecycle.close()).toBe(false); }); expect(h.close).not.toHaveBeenCalled();
  await h.user.click(screen.getByRole("button", { name: t("check") }));
  await waitFor(() => expect(screen.queryByRole("button", { name: t("check") })).toBeNull());
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("Reasonable newer B");
  expect(calls("rename_project")).toHaveLength(1);
  expect(calls("read_project").slice(0, 2).map(([, payload]) => payload.request)).toEqual([
    { sessionToken: project.sessionToken, expectedRevision: "1" }, { sessionToken: project.sessionToken, expectedRevision: "1" },
  ]);
});

it("does not treat unrelated current metadata as the original result and only releases a confirmed previous result", async () => {
  const h = await setup(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "rename_project") { commitName("An unrelated project name"); throw new Error("Unknown write"); }
    return original(command, payload);
  });
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Original requested name" } });
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  await screen.findByText(t("unknown")); expect(screen.getByRole("button", { name: t("saveName") })).toBeDisabled();
  disk = copy(project);
  await h.user.click(screen.getByRole("button", { name: t("check") }));
  await screen.findByText(t("previous"));
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("Original requested name");
  expect(screen.getByRole("button", { name: t("saveName") })).toBeEnabled(); expect(calls("rename_project")).toHaveLength(1);
});

it("refreshes a rejected stale revision while keeping both editable fields for an explicit new submission", async () => {
  const h = await setup(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "rename_project") {
      disk = { ...disk, metadata: { ...disk.metadata, displayName: "External name", metadataRevision: "3" } };
      throw { code: "stale-revision", stage: "rename", outcome: "rejected", recoveryRequired: false, currentRevision: "3" } satisfies CommandError;
    }
    return original(command, payload);
  });
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "My name" } });
  fireEvent.change(screen.getByRole("textbox", { name: t("languages") }), { target: { value: "ja-JP, fr-FR" } });
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  await screen.findByText(t("stale"));
  await waitFor(() => expect(screen.getByRole("button", { name: t("saveName") })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("My name");
  expect(screen.getByRole("textbox", { name: t("languages") })).toHaveValue("ja-JP, fr-FR");
  await h.user.click(screen.getByRole("button", { name: t("saveLanguages") }));
  await waitFor(() => expect(calls("set_target_locales")).toHaveLength(1));
  expect(calls("set_target_locales")[0][1].request).toEqual({ sessionToken: project.sessionToken, expectedRevision: "3", targetLocales: ["ja-JP", "fr-FR"] });
});

it.each(["en-US", "zh-CN"] as const)("explains removed languages and saves only explicit target changes in %s", async language => {
  await i18n.changeLanguage(language); const h = await setup();
  fireEvent.change(screen.getByRole("textbox", { name: t("languages") }), { target: { value: "zh-Hans\nfr-FR" } });
  expect(screen.getByText(language === "zh-CN" ? /已有译文、历史和可恢复草稿仍会保留/ : /Existing translations, history and recoverable drafts are kept/)).toBeVisible();
  expect(calls("set_target_locales")).toHaveLength(0);
  await h.user.click(screen.getByRole("button", { name: t("saveLanguages") }));
  await waitFor(() => expect(calls("set_target_locales")).toHaveLength(1));
  expect(calls("set_target_locales")[0][1].request).toEqual({ sessionToken: project.sessionToken, expectedRevision: "1", targetLocales: ["zh-Hans", "fr-FR"] });
  expect(calls("rename_project")).toHaveLength(0);
  expect(invoke.mock.calls.every(([command]) => ["set_target_locales", "read_project"].includes(command))).toBe(true);
});

it("protects IME input and focus, then asks before discarding unsent settings on panel close", async () => {
  const h = await setup(), input = screen.getByRole<HTMLInputElement>("textbox", { name: t("name") });
  fireEvent.change(input, { target: { value: "中文 é 👩🏽‍💻" } }); input.focus(); input.setSelectionRange(1, 3);
  fireEvent.compositionStart(input);
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(screen.getByRole("textbox", { name: t("name") })).toBe(input); expect(input).toHaveFocus(); expect(input.selectionStart).toBe(1);
  await h.user.click(screen.getByRole("button", { name: t("saveName") })); await h.user.keyboard("{Escape}");
  expect(calls("rename_project")).toHaveLength(0); expect(h.onClose).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await h.user.click(screen.getByRole("button", { name: t("close") }));
  expect(await screen.findByRole("heading", { name: t("leaveTitle") })).toHaveFocus();
  await h.user.click(screen.getByRole("button", { name: t("stay") })); expect(input).toHaveValue("中文 é 👩🏽‍💻");
  await h.user.click(screen.getByRole("button", { name: t("close") })); await h.user.click(screen.getByRole("button", { name: t("discard") }));
  expect(h.onClose).toHaveBeenCalledOnce(); expect(calls("rename_project")).toHaveLength(0);
});

it("settles the real lifecycle confirmation while its preparing state disables ordinary business actions", async () => {
  const h = await setup(); fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Unsent name" } });
  let closing!: Promise<boolean>; act(() => { closing = h.lifecycle.close(); });
  await screen.findByRole("heading", { name: t("leaveTitle") });
  expect(screen.getByRole("button", { name: t("saveName") })).toBeDisabled();
  expect(screen.getByRole("button", { name: t("discard") })).toBeEnabled();
  await h.user.click(screen.getByRole("button", { name: t("discard") }));
  await act(async () => { expect(await closing).toBe(true); }); expect(h.close).toHaveBeenCalledOnce(); expect(calls("rename_project")).toHaveLength(0);
});

it("validates folder moves and never adds folder consent to an ordinary rename", async () => {
  const h = await setup();
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Bad/name" } });
  await h.user.click(screen.getByRole("checkbox", { name: t("renameFolder") }));
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  expect(screen.getByText(t("folderInvalid"))).toBeVisible(); expect(calls("rename_project")).toHaveLength(0);
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "renamed-folder" } });
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  await waitFor(() => expect(calls("rename_project")).toHaveLength(1));
  expect(calls("rename_project")[0][1].request).toEqual({ sessionToken: project.sessionToken, expectedRevision: "1", displayName: "renamed-folder", directoryName: "renamed-folder" });
});

it("keeps rejected language input and presents the validation at that field without treating rejection as unknown", async () => {
  const h = await setup(), original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "set_target_locales") throw { code: "invalid-input", field: "targetLocales", stage: "set-target-locales", outcome: "rejected", recoveryRequired: false } satisfies CommandError;
    return original(command, payload);
  });
  const input = screen.getByRole("textbox", { name: t("languages") });
  fireEvent.change(input, { target: { value: "not a language tag" } });
  await h.user.click(screen.getByRole("button", { name: t("saveLanguages") }));
  expect(await screen.findByText(t("languagesInvalid"))).toBeVisible();
  expect(input).toHaveValue("not a language tag"); expect(input).toHaveAttribute("aria-invalid", "true");
  expect(calls("set_target_locales")).toHaveLength(1); expect(calls("read_project")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: t("check") })).toBeNull();
});

it("requires a successful workspace refresh after a known acknowledgement and retains newer input during recovery", async () => {
  const h = await setup(), original = invoke.getMockImplementation()!; let reading = 0;
  invoke.mockImplementation(async (command, payload) => {
    if (command === "read_project" && ++reading === 1) throw new Error("Workspace read unavailable after acknowledgement");
    return original(command, payload);
  });
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Name A" } });
  await h.user.click(screen.getByRole("button", { name: t("saveName") }));
  await screen.findByText(t("refreshFailed"));
  fireEvent.change(screen.getByRole("textbox", { name: t("name") }), { target: { value: "Retained B" } });
  expect(screen.getByRole("button", { name: t("saveName") })).toBeDisabled();
  await act(async () => { expect(await h.lifecycle.close()).toBe(false); }); expect(h.close).not.toHaveBeenCalled();
  await h.user.click(screen.getByRole("button", { name: t("refresh") }));
  await waitFor(() => expect(screen.getByRole("button", { name: t("saveName") })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: t("name") })).toHaveValue("Retained B"); expect(calls("rename_project")).toHaveLength(1);
});
