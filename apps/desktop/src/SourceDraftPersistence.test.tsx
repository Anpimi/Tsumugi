import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSourceDraftSession } from "./SourceDraftSession";
import SourceDraftRecovery from "./SourceDraftRecovery";
import { sourceDraftCommands, canonicalSourceDraft } from "./sourceDraftCommands";
import { sourceCommands } from "./sourceCommands";
import { executionCommands, type Receipt } from "./executionCommands";
import type { ProjectView } from "./projectCommands";
import { Field, TextInput } from "./design-system/Field";
import { i18n } from "./i18n";
import { renderWorkbench } from "./testSupport/WorkbenchTestShell";
import { installSourceDraftFixture } from "./testSupport/sourceDraftFixture";
import { sourceDraftStateFixture } from "./testSupport/sourceDraftStateFixture";
import { sourceDraftValue } from "./sourceDraftJournal";
import { sourceActionFixture, sourceAttemptFixture, sourcePageFixture, sourceReceiptFixture } from "./testSupport/sourceFixture";
import { pluginSourceRequest, pluginSourceWorkflow } from "./testSupport/pluginSourceFixture";
import { fixtureIdentity as id } from "./testSupport/executionFixture";
import wire from "../test/fixtures/sourceCommands.contract.json";

const invoke = vi.hoisted(() => vi.fn()); vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { ...wire.session, locator: "/synthetic/source-persistence", reconciliationState: "settled",
  metadata: { projectId: wire.session.projectId, displayName: "Source journal", sourceLocale: "en", targetLocales: ["zh-CN"], metadataRevision: "1" } };
const key = { projectId: project.metadata.projectId }, preview = sourcePageFixture();
let owner: ReturnType<typeof useSourceDraftSession>;
const t = (key: "actor" | "recoveryTitle" | "recoveryCheck" | "recoveryPreparation") => i18n.t(`sourceMaintenance.${key}`);
function Probe() {
  const value = useSourceDraftSession(); useLayoutEffect(() => { owner = value; });
  return <><SourceDraftRecovery owner={value}/><Field label={t("actor")}><TextInput value={value.state.actor} onChange={event => value.edit("actor", event.target.value)}/></Field></>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset(); invoke.mockImplementation(async command => { throw new Error(`Unexpected source command: ${command}`); });
  vi.spyOn(executionCommands, "identity").mockResolvedValue(wire.prepare.actionId);
  vi.spyOn(sourceCommands, "scope").mockResolvedValue(preview.scope);
});
afterEach(cleanup);
async function open(value = project) { const result = renderWorkbench(<Probe/>, value); await waitFor(() => expect(owner.journal.hydration).toBe("ready")); return result; }

it("checkpoints exact adoption A before dispatch, retains newer B, and restores B under a new session", async () => {
  const reply = deferred<Receipt>();
  const prepare = vi.spyOn(sourceCommands, "prepare").mockImplementation(async request => {
    const head = await sourceDraftCommands.read({ sessionToken: request.sessionToken, key });
    expect(head.value?.pending).toMatchObject({ kind: "adopt", request: { actionId: request.actionId, attemptId: request.attemptId, confirmation: request.confirmation } });
    return sourceActionFixture(request);
  });
  const adopt = vi.spyOn(executionCommands, "adopt").mockImplementation(async () => reply.promise);
  const view = await open();
  act(() => { owner.showAttempt(preview.attemptId); owner.ready(preview, sourceAttemptFixture(preview.attemptId, preview.resultId)); owner.confirm(true); });
  let saving!: Promise<void>; act(() => { saving = owner.apply(() => true); });
  await waitFor(() => expect(adopt).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByRole("textbox", { name: t("actor") }), { target: { value: "New B 👩🏽‍💻 é" } });
  const request = prepare.mock.calls[0][0];
  await act(async () => { reply.resolve(sourceReceiptFixture(request)); await saving; });
  await waitFor(() => expect(owner.current().pendingApply).toBeNull()); await act(async () => { await owner.flush(); });
  expect(owner.current().actor).toBe("New B 👩🏽‍💻 é"); expect(owner.current().receiptRef?.actionId).toBe(request.actionId);
  view.unmount(); await open({ ...project, sessionToken: "reopened-source-session" });
  expect(owner.current().actor).toBe("New B 👩🏽‍💻 é"); expect(owner.current().receiptRef?.snapshotId).toBe(id(100));
  expect(owner.current().confirmed).toBe(false); expect(owner.current().preparedAction).toBeNull(); expect(prepare).toHaveBeenCalledOnce(); expect(adopt).toHaveBeenCalledOnce();
});

it.each(["en-US", "zh-CN"] as const)("hydrates without observing or replaying, updates mounted %s labels, and explicitly resolves expired preparation", async language => {
  await i18n.changeLanguage(language); installSourceDraftFixture();
  const capture = { projectId: key.projectId, selectionId: id(801), attemptId: id(802), sourceLanguage: "en" };
  const value = canonicalSourceDraft({ ...sourceDraftValue(sourceDraftStateFixture(), "2"), actor: "Restored A", selectionLabel: "Original folder",
    pending: { kind: "capture", request: capture, submittedSeq: "1", submittedMappingSeq: "0" } });
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key, expectedRevision: "0", writerId: id(803), value } });
  const observe = vi.spyOn(sourceDraftCommands, "observe").mockImplementation(async request => {
    if (request.target.kind !== "primary" || request.target.pending.kind !== "capture") throw new Error("Expected the original capture request");
    return { target: { kind: "primary", pending: request.target.pending }, observation: { kind: "preparation-expired" } };
  });
  const captureCommand = vi.spyOn(sourceCommands, "capturePlugin"), start = vi.spyOn(sourceCommands, "startPlugin");
  await open({ ...project, sessionToken: "reopened-source-session" });
  expect(observe).not.toHaveBeenCalled(); expect(captureCommand).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: t("actor") });
  fireEvent.change(field, { target: { value: "Newer B 人工" } }); act(() => { field.focus(); field.setSelectionRange(2, 6, "backward"); });
  await act(async () => { await i18n.changeLanguage(language === "en-US" ? "zh-CN" : "en-US"); });
  expect(screen.getByRole("textbox", { name: t("actor") })).toBe(field); expect(field).toHaveFocus(); expect(field).toHaveValue("Newer B 人工");
  expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(6);
  expect(screen.getByRole("region", { name: t("recoveryTitle") })).toHaveAccessibleName(language === "en-US" ? "本机源内容草稿" : "Local source drafts");
  await userEvent.setup().click(screen.getByRole("button", { name: t("recoveryCheck") }));
  await waitFor(() => expect(owner.hasPending()).toBe(false));
  expect(observe).toHaveBeenCalledOnce(); expect(observe.mock.calls[0][0]).toMatchObject({ sessionToken: "reopened-source-session", target: { pending: { request: capture } } });
  expect(owner.current().actor).toBe("Newer B 人工"); expect(owner.current().selectionLabel).toBe("Original folder"); expect(owner.current().preparationExpired).toBe(true);
  expect(captureCommand).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
});

it("waits for the pending capture's local acknowledgement and treats a cancelled folder picker as no change", async () => {
  const gate = deferred<void>(); await open();
  vi.spyOn(sourceCommands, "selectPlugin").mockResolvedValueOnce(pluginSourceWorkflow.selection).mockResolvedValueOnce(null);
  act(() => { owner.setSource(pluginSourceRequest); }); await act(async () => { await owner.select(); owner.declare(true); await owner.flush(); });
  const originalSelection = owner.current().selection;
  await act(async () => { await owner.select(); }); expect(owner.current().selection).toBe(originalSelection); expect(owner.current().declared).toBe(true);
  const actual = sourceDraftCommands.write;
  vi.spyOn(sourceDraftCommands, "write").mockImplementation(async request => { if (request.write.value.pending?.kind === "capture") await gate.promise; return actual(request); });
  const capture = vi.spyOn(sourceCommands, "capturePlugin").mockImplementation(async request => {
    const head = await sourceDraftCommands.read({ sessionToken: request.sessionToken, key });
    expect(head.value?.pending).toMatchObject({ kind: "capture", request: { attemptId: request.attemptId, selectionId: request.selectionId } });
    return { ...pluginSourceWorkflow.preflight, attemptId: request.attemptId, sourceLanguage: "en" };
  });
  let reading!: Promise<void>; act(() => { reading = owner.preflight(() => true); });
  await waitFor(() => expect(owner.current().pendingPlugin?.pendingKind).toBe("capture")); expect(capture).not.toHaveBeenCalled();
  await act(async () => { gate.resolve(); await reading; }); expect(capture).toHaveBeenCalledOnce(); expect(owner.hasPending()).toBe(false);
});

it.each(["start", "start-check"] as const)("explicitly closes recovered %s admission while retaining input typed during local settlement", async kind => {
  installSourceDraftFixture();
  const request = { projectId: key.projectId, attemptId: id(810), inputDigest: "a".repeat(64), grantId: id(811),
    expiresAtMs: "123", unsandboxedExecution: true, startMetadata: { taskId: id(812), generation: id(813) } };
  const pending = { kind, request, submittedSeq: "1", submittedMappingSeq: "0" };
  const value = canonicalSourceDraft({ ...sourceDraftValue(sourceDraftStateFixture(), "2"), actor: "Restored A", pending });
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key, expectedRevision: "0", writerId: id(814), value } });
  const observe = vi.spyOn(sourceDraftCommands, "observe").mockImplementation(async request => {
    if (request.target.kind !== "primary" || (request.target.pending.kind !== "start" && request.target.pending.kind !== "start-check")) throw new Error("Expected the original Source start");
    return { target: { kind: "primary", pending: request.target.pending }, observation: { kind: "pending" } };
  });
  const start = vi.spyOn(sourceCommands, "startPlugin"), check = vi.spyOn(sourceCommands, "startCheck");
  await open({ ...project, sessionToken: "reopened-source-session" });
  expect(observe).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: t("recoveryCheck") }));
  expect(owner.hasPending()).toBe(true);
  const acknowledgement = deferred<void>(), actual = sourceDraftCommands.resolve;
  const resolve = vi.spyOn(sourceDraftCommands, "resolve").mockImplementation(async request => { await acknowledgement.promise; return actual(request); });
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.cancelStart") }));
  await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  expect(resolve.mock.calls[0][0]).toMatchObject({ sessionToken: "reopened-source-session", resolve: {
    target: { kind: "primary", pending }, disposition: "confirmed-not-applied" } });
  fireEvent.change(screen.getByRole("textbox", { name: t("actor") }), { target: { value: "Newer B 人工 👩🏽‍💻" } });
  await act(async () => { acknowledgement.resolve(); });
  await waitFor(() => expect(owner.hasPending()).toBe(false)); await act(async () => { await owner.flush(); });
  expect(owner.current().actor).toBe("Newer B 人工 👩🏽‍💻");
  const saved = await sourceDraftCommands.read({ sessionToken: "reopened-source-session", key });
  expect(saved.value?.actor).toBe("Newer B 人工 👩🏽‍💻"); expect(saved.value?.pending).toBeNull();
  expect(start).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
});

it("records an already executed recovered checker result only after an explicit check and retry without running the checker again", async () => {
  installSourceDraftFixture();
  const request = { projectId: key.projectId, attemptId: id(820), resultId: id(821) };
  const pending = { kind: "finish-check" as const, request, submittedSeq: "1", submittedMappingSeq: "0" };
  await sourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key, expectedRevision: "0", writerId: id(822),
    value: canonicalSourceDraft({ ...sourceDraftValue(sourceDraftStateFixture(), "2"), actor: "Retained B 人工", checkAttemptId: request.attemptId, pending }) } });
  const observe = vi.spyOn(sourceDraftCommands, "observe").mockImplementation(async request => {
    if (request.target.kind !== "primary" || request.target.pending.kind !== "finish-check") throw new Error("Expected the original finish request");
    return { target: { kind: "primary", pending: request.target.pending }, observation: { kind: "pending" } };
  });
  const finish = vi.spyOn(sourceCommands, "finishCheck").mockImplementation(async request => {
    expect((await sourceDraftCommands.read({ sessionToken: request.sessionToken, key })).value?.pending).toEqual(pending);
    return null;
  });
  const start = vi.spyOn(sourceCommands, "startCheck"), prepare = vi.spyOn(sourceCommands, "prepareCheck");
  await open({ ...project, sessionToken: "reopened-source-session" });
  expect(observe).not.toHaveBeenCalled(); expect(finish).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: i18n.t("sourceMaintenance.recoveryFinishCheck") })).not.toBeInTheDocument();
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: t("recoveryCheck") }));
  expect(owner.hasPending()).toBe(true); expect(finish).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: i18n.t("sourceMaintenance.recoveryFinishCheck") }));
  await waitFor(() => expect(owner.hasPending()).toBe(false));
  expect(finish).toHaveBeenCalledExactlyOnceWith({ ...request, sessionToken: "reopened-source-session" });
  expect(owner.current().actor).toBe("Retained B 人工");
  expect(start).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
});
