import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import wire from "../test/fixtures/resourceDraftCommands.contract.json";
import resources from "../test/fixtures/resourceCommands.contract.json";
import { i18n } from "./i18n";
import { executionCommands } from "./executionCommands";
import { resourceCommands, type SaveTerm, type TermRevision, type ResourceDecision } from "./resourceCommands";
import { canonicalResourceDraft, resourceDraftCommands } from "./resourceDraftCommands";
import { validateRequestResourceWrite } from "./generated/draft.validators";
import { initialResourceDraftState, useResourceDraftSession } from "./ResourceDraftSession";
import { resourceDraftValue } from "./resourceDraftJournal";
import { ResourceDraftRecovery } from "./ResourceDraftRecovery";
import { Field, TextInput } from "./design-system/Field";
import { Button } from "./design-system/Button";
import type { ProjectView } from "./projectCommands";
import { renderWorkbench } from "./testSupport/WorkbenchTestShell";
import { installResourceDraftFixture } from "./testSupport/resourceDraftFixture";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "resource-owner-session", locator: "/synthetic/resource-owner", reconciliationState: "settled",
  metadata: { projectId: wire.requests.read.key.projectId, metadataRevision: "1", displayName: "Resource input", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const k = (key: "targetTerm" | "save" | "recoveryTitle" | "recoveryCheck" | "recoveryShow" | "recoveryLocal" | "recoveryRetry") => i18n.t(`knowledge.${key}`);
let owner: ReturnType<typeof useResourceDraftSession>;
function Probe({ disabled = false }: { disabled?: boolean }) {
  const value = useResourceDraftSession(); useLayoutEffect(() => { owner = value; });
  return <><ResourceDraftRecovery owner={value} disabled={disabled}/><Field label={k("targetTerm")}><TextInput readOnly={disabled} value={value.state.termDraft.target}
    onChange={event => value.editTerm({ ...value.current().termDraft, target: event.target.value })}/></Field>
    <Button disabled={disabled || value.blocked()} onClick={() => { void value.saveTerm(() => true); }}>{k("save")}</Button></>;
}
function accepted(request: SaveTerm): TermRevision {
  return { ...resources.responses.term, termId: request.termId ?? resources.responses.term.termId, locale: request.locale, source: request.source, target: request.target,
    aliases: request.aliases, protected: request.protected, reason: request.reason ?? "", scopeUnitId: request.scopeUnitId ?? null,
    originKind: "manual", captureId: null, externalEntryId: null, previousRevisionId: request.expectedRevisionId ?? null, removed: false };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); invoke.mockReset(); invoke.mockImplementation(async command => { throw new Error(`Unexpected synthetic command: ${command}`); });
  vi.spyOn(executionCommands, "identity").mockResolvedValue(resources.requests.term.term.actionId);
});
afterEach(cleanup);
async function open(value = project, disabled = false) {
  const view = renderWorkbench(<Probe disabled={disabled}/>, value);
  await waitFor(() => expect(owner.journal.hydration).toBe("ready")); return view;
}
async function enter() {
  await act(async () => { owner.editTerm({ source: "Barrel", target: "Submitted A", aliases: ["Cask"], scopeUnitId: null, protected: false, reason: "Human reason" }, "Cask, "); await owner.flush(); });
}

it("checkpoints exact A before the formal save, retains B, and reopens it with a different session and removed language", async () => {
  const reply = deferred<TermRevision>();
  const save = vi.spyOn(resourceCommands, "saveTerm").mockImplementation(async request => {
    const head = await resourceDraftCommands.read({ sessionToken: request.sessionToken, key: { projectId: request.projectId } });
    expect(head.value?.pending).toMatchObject({ kind: "term", request: request.term, aliasInput: "Cask, " });
    return reply.promise;
  });
  const view = await open(); await enter(); const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: k("save") }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByRole("textbox", { name: k("targetTerm") }), { target: { value: "New B 👩🏽‍💻 é" } });
  await act(async () => { reply.resolve(accepted(save.mock.calls[0][0].term)); });
  await waitFor(() => expect(owner.current().pending).toBeNull()); await act(async () => { await owner.flush(); });
  expect(owner.current().termDraft.target).toBe("New B 👩🏽‍💻 é"); view.unmount();
  await open({ ...project, sessionToken: "reopened-resource-session", metadata: { ...project.metadata, targetLocales: [] } }, true);
  expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveValue("New B 👩🏽‍💻 é");
  expect(screen.getByRole("textbox", { name: k("targetTerm") })).toHaveAttribute("readonly");
  expect(owner.localeAvailable("zh-CN")).toBe(false); expect(owner.current().aliasInput).toBe("Cask, ");
  await user.click(screen.getByRole("button", { name: k("recoveryShow") }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: k("recoveryLocal") }).value).toContain("New B 👩🏽‍💻 é");
  expect(save).toHaveBeenCalledOnce(); expect(executionCommands.identity).toHaveBeenCalledOnce();
});

it.each(["en-US", "zh-CN"] as const)("restores unknown without reading a receipt, updates mounted %s labels, and requires explicit reconciliation", async language => {
  await i18n.changeLanguage(language); installResourceDraftFixture();
  const request: unknown = structuredClone(wire.requests.write);
  if (!validateRequestResourceWrite(request)) throw new Error("Expected generated resource input");
  await resourceDraftCommands.write({ ...request, sessionToken: project.sessionToken });
  const pending = canonicalResourceDraft(request.write.value).pending; if (!pending || pending.kind !== "term") throw new Error("Expected original term request");
  const observed = vi.spyOn(resourceCommands, "observeTermAction"), read = vi.spyOn(resourceCommands, "termAction").mockResolvedValue({ request: pending.request, receipt: accepted(pending.request) });
  const save = vi.spyOn(resourceCommands, "saveTerm"); await open({ ...project, sessionToken: "reopened-pending-session" });
  expect(owner.current()).toMatchObject({ pendingUncertain: true, pendingCheckedMissing: false, pendingRecorded: false });
  expect(observed).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: k("targetTerm") });
  fireEvent.change(field, { target: { value: "New B after reopening" } }); act(() => { field.focus(); field.setSelectionRange(2, 8, "backward"); });
  await act(async () => { await i18n.changeLanguage(language === "en-US" ? "zh-CN" : "en-US"); });
  expect(screen.getByRole("textbox", { name: k("targetTerm") })).toBe(field); expect(field).toHaveFocus(); expect(field).toHaveValue("New B after reopening");
  expect(field.selectionStart).toBe(2); expect(field.selectionEnd).toBe(8);
  expect(screen.getByRole("region", { name: k("recoveryTitle") })).toHaveAccessibleName(language === "en-US" ? "本机知识草稿" : "Local knowledge drafts");
  await userEvent.setup().click(screen.getByRole("button", { name: k("recoveryCheck") }));
  await waitFor(() => expect(owner.current().pending).toBeNull());
  expect(owner.current().termDraft.target).toBe("New B after reopening"); expect(owner.current().newerTerm).toBe(true);
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0][0].sessionToken).toBe("reopened-pending-session");
  expect(read.mock.calls[0][0].term).toEqual(pending.request); expect(save).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
});

it("keeps pending and B after a journal resolve failure and retries its exact local frame without resending the save", async () => {
  await open(); await enter();
  const actual = resourceDraftCommands.resolve;
  const resolve = vi.spyOn(resourceDraftCommands, "resolve").mockRejectedValueOnce(new Error("Synthetic local acknowledgement failed")).mockImplementation(actual);
  const save = vi.spyOn(resourceCommands, "saveTerm").mockImplementation(async request => accepted(request.term));
  await userEvent.setup().click(screen.getByRole("button", { name: k("save") }));
  await waitFor(() => expect(owner.journal.failure).not.toBeNull()); expect(owner.current().pending?.kind).toBe("term");
  fireEvent.change(screen.getByRole("textbox", { name: k("targetTerm") }), { target: { value: "B while local recovery is waiting" } });
  await userEvent.setup().click(screen.getByRole("button", { name: k("recoveryRetry") }));
  await waitFor(() => expect(owner.current().pending).toBeNull()); await act(async () => { await owner.flush(); });
  expect(owner.current().termDraft.target).toBe("B while local recovery is waiting"); expect(save).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledTimes(2); expect(resolve.mock.calls[1][0]).toEqual(resolve.mock.calls[0][0]);
});

it("reopens an edited adoption with newer input and reconciles only the exact original receipt", async () => {
  installResourceDraftFixture();
  const request: ResourceDecision = { projectId: project.metadata.projectId, actionId: resources.requests.term.term.actionId,
    captureId: resources.responses.preview.capture.captureId, entryId: resources.responses.preview.rows[0].entry.id,
    expectedRevisionId: null, decision: "adopt", editedTarget: "Submitted A" };
  const state = initialResourceDraftState("zh-CN");
  state.previewCaptureId = request.captureId;
  state.proposalEditDraft = { captureId: request.captureId, entryId: request.entryId, locale: "zh-CN", expectedRevisionId: null,
    source: "Original source", currentTarget: null, originalTarget: "Original proposal", target: "Newer B after unknown e\u0301 👩🏽‍💻", editSeq: 3 };
  state.pending = { kind: "decision", session: { sessionToken: project.sessionToken, projectId: project.metadata.projectId },
    locale: "zh-CN", submittedSeq: "2", request };
  await resourceDraftCommands.write({ sessionToken: project.sessionToken, write: { key: { projectId: project.metadata.projectId },
    expectedRevision: "0", writerId: resources.requests.term.term.actionId, value: resourceDraftValue(state, "100") } });
  const receipt = { request, actionId: request.actionId, decision: request.decision, revision: { ...resources.responses.term,
    target: request.editedTarget ?? "", captureId: request.captureId, previousRevisionId: null } };
  const observed = vi.spyOn(resourceCommands, "observeDecisionAction"), write = vi.spyOn(resourceCommands, "decide");
  const read = vi.spyOn(resourceCommands, "decisionAction").mockResolvedValue({ request, receipt });
  await open({ ...project, sessionToken: "reopened-edited-session", metadata: { ...project.metadata, targetLocales: [] } });
  expect(owner.current().locale).toBe("zh-CN"); expect(owner.localeAvailable("zh-CN")).toBe(false);
  expect(observed).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  expect(owner.current().pendingCheckedMissing).toBe(false);
  await userEvent.setup().click(screen.getByRole("button", { name: k("recoveryCheck") }));
  await waitFor(() => expect(owner.current().pending).toBeNull());
  expect(owner.current().proposalEditDraft?.target).toBe("Newer B after unknown e\u0301 👩🏽‍💻");
  expect(owner.current().proposalEditDraft?.expectedRevisionId).toBe(receipt.revision.revisionId);
  expect(read.mock.calls[0][0]).toMatchObject({ sessionToken: "reopened-edited-session", decision: request });
  expect(write).not.toHaveBeenCalled(); expect(executionCommands.identity).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: k("recoveryShow") }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: k("recoveryLocal") }).value).toContain("Newer B after unknown");
});
