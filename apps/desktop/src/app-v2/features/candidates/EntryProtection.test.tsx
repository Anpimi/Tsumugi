import { Button } from "../../../design-system/Button";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import type { workbenchEn } from "../../../i18n/workbench";
import type { DraftHead, DraftMergeOrigin, DraftReadView, DraftValue } from "../../../draftCommands";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import type { ReviewTarget } from "../../../reviewCommands";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { protectionKey, type ProtectionRequest } from "../../../WorkProtectionSession";
import type { WorkProtection } from "../../../workPlanCommands";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { TranslationDrafts, type TranslationDraftPorts } from "../editor/translationDrafts";
import CandidateOwnerHost from "./CandidateOwnerHost";
import type { CandidateOwners } from "./candidateTypes";
import EntryProtection from "./EntryProtection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "entry-protection-session", locator: "/synthetic/entry-protection", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Synthetic protection", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const };
const originalTarget = reviewTargetFixture({ sourceText: "Source {name}\né 👩🏽‍💻", translationText: "Translation {name}" });
const copy = <T,>(value: T): T => structuredClone(value);
const identity = (value: { unitId: string; locale: string }) => `${value.unitId}:${value.locale}`;
type TextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
const w = (key: TextKey) => i18n.t(`workbenchV2.${key}`);
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let protections: Map<string, WorkProtection>, recorded: Map<string, WorkProtection>, identities: number;
const resources: { reads: SessionReads; drafts: TranslationDrafts; lifecycle: ProjectLifecycle }[] = [];
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); protections = new Map(); recorded = new Map(); identities = 950; invoke.mockReset();
  invoke.mockImplementation(async (command: string, { request }: { request: ProtectionRequest }) => {
    if (command === "create_execution_identity") return fixtureIdentity(++identities);
    const current = protections.get(identity(request)) ?? { unitId: request.unitId, locale: request.locale, revision: "0", protected: false };
    if (command === "read_work_protection") return copy(current);
    if (command === "set_work_protection") {
      const prior = recorded.get(request.actionId); if (prior) return copy(prior);
      if (current.revision !== request.expectedRevision) throw new Error("Synthetic protection revision conflict");
      const receipt = { unitId: request.unitId, locale: request.locale, revision: String(BigInt(current.revision) + 1n), protected: request.protected };
      protections.set(identity(request), receipt); recorded.set(request.actionId, receipt); return copy(receipt);
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
});
afterEach(() => { cleanup(); resources.splice(0).forEach(({ reads, drafts, lifecycle }) => { reads.retire(); drafts.retire(); lifecycle.dispose(); }); });

async function harness({ target = originalTarget, protectedValue = true, parentDialogId, merge }: { target?: ReviewTarget; protectedValue?: boolean; parentDialogId?: string; merge?: DraftMergeOrigin } = {}) {
  protections.set(identity(target), { unitId: target.unitId, locale: target.locale, revision: "9007199254740993", protected: protectedValue });
  const reads = new SessionReads(context), draftsOnDisk = new Map<string, DraftHead>(), targets = new Map([[target.unitId, copy(target)]]);
  const key = { projectId: context.projectId, unitId: target.unitId, locale: target.locale };
  if (merge) draftsOnDisk.set(identity(key), { key, revision: "1", writerId: fixtureIdentity(990), value: { basis: { sourceRevisionId: target.sourceRevisionId,
    selectionId: target.selectionId, revisionId: target.revisionId, text: target.translationText }, text: target.translationText ?? "", editSeq: "9007199254740993", pending: null, merge } });
  const read: TranslationDraftPorts["read"] = async request => {
    const current = targets.get(request.key.unitId); if (!current) throw new Error("Missing synthetic target");
    const head = draftsOnDisk.get(identity(request.key)) ?? { key: request.key, revision: "0", writerId: null, value: null };
    const view: DraftReadView = { head: copy(head), current: { kind: "current", nativeKey: current.nativeKey, sourceText: current.sourceText,
      basis: { sourceRevisionId: current.sourceRevisionId, selectionId: current.selectionId, revisionId: current.revisionId, text: current.translationText } } };
    return view;
  };
  const write = vi.fn<TranslationDraftPorts["write"]>(async request => {
    const before = draftsOnDisk.get(identity(request.write.key));
    const head: DraftHead = { key: request.write.key, revision: String(BigInt(before?.revision ?? "0") + 1n), writerId: request.write.writerId, value: copy(request.write.value) as DraftValue };
    draftsOnDisk.set(identity(head.key), head); return copy(head);
  });
  const drafts = new TranslationDrafts({ context, reads, ports: { read, write, list: async () => ({ items: [], next: null }), writerId: () => fixtureIdentity(990) } });
  expect(await drafts.initialize()).toBe(true);
  const gate = new InteractionGate(), commands = new WorkbenchCommands(), lifecycle = new ProjectLifecycle(); gate.setVisibleOwner("entries");
  resources.push({ reads, drafts, lifecycle });
  if (parentDialogId) gate.pushDialog(parentDialogId);
  let retained: CandidateOwners | null = null;
  type Settings = { target: ReviewTarget; visible: boolean; disabled: boolean; parentDialogId?: string };
  let settings: Settings = { target, visible: true, disabled: false, parentDialogId };
  function Content(props: Settings) {
    const [owners, publish] = useState<CandidateOwners | null>(null); retained = owners;
    return <><CandidateOwnerHost project={project} drafts={drafts} lifecycle={lifecycle} onOwners={publish} onReveal={() => undefined}/>
      {owners ? <EntryProtection {...props} project={project} drafts={drafts} owners={owners} commands={commands} gate={gate} viewId="entries"/> : null}</>;
  }
  const ui = () => <SessionReadProvider context={context} reads={reads} bridge={false}><Content {...settings}/></SessionReadProvider>;
  const rendered = render(ui());
  await screen.findByText(w(protectedValue ? "entryProtectionProtected" : "entryProtectionUnprotected"));
  return { reads, drafts, key, write, gate, commands, targets, rendered, owners: () => { if (!retained) throw new Error("Protection owner missing"); return retained; },
    show: (patch: Partial<Settings>) => { settings = { ...settings, ...patch }; targets.set(settings.target.unitId, copy(settings.target)); rendered.rerender(ui()); } };
}
async function openRelease(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: w("entryProtectionRelease") }); await waitFor(() => expect(button).toBeEnabled());
  await user.click(button); return { trigger: button, dialog: await screen.findByRole("dialog", { name: w("entryProtectionReleaseTitle") }) };
}

it("reads without automatic writes and explicitly protects a null selection while preserving a dirty local draft", async () => {
  const target = reviewTargetFixture({ selectionId: null, revisionId: null, translationText: null });
  const h = await harness({ target, protectedValue: false });
  expect(screen.getByText(w("editorNoSelection"))).toBeInTheDocument(); expect(calls("set_work_protection")).toHaveLength(0);
  act(() => { expect(h.drafts.edit(h.key, "Unconfirmed é 👩🏽‍💻")).toBe(true); });
  const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: w("entryProtectionProtect") }));
  await screen.findByText(w("entryProtectionSaved"));
  expect(calls("set_work_protection")[0][1].request).toMatchObject({ ...context, unitId: target.unitId, locale: target.locale,
    sourceRevisionId: target.sourceRevisionId, selectionId: null, expectedRevision: "9007199254740993", protected: true, confirmedRelease: false });
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe("Unconfirmed é 👩🏽‍💻");
  expect(screen.getByRole("button", { name: w("entryProtectionRelease") })).toBeDisabled();
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("select_translation_revision")).toHaveLength(0);
});

it("confirms the captured protection release, gates IME and other dialogs, and restores keyboard focus", async () => {
  const target = reviewTargetFixture({ translationText: "" }), h = await harness({ target, parentDialogId: "workspace-dock" }), user = userEvent.setup();
  const { trigger, dialog } = await openRelease(user);
  expect(within(dialog).getByText(w("editorEmptySelection"))).toBeInTheDocument();
  const keep = within(dialog).getByRole("button", { name: w("entryProtectionCancel") }); await waitFor(() => expect(keep).toHaveFocus());
  const top = h.gate.getSnapshot().dialogs.at(-1); expect(top).toMatch(/^entry-protection-release-/); expect(top).not.toBe("workspace-dock");
  const confirm = within(dialog).getByRole("button", { name: w("entryProtectionConfirmRelease") });
  act(() => h.gate.setComposing("physical-input", true)); expect(confirm).toBeDisabled();
  fireEvent.keyDown(dialog, { key: "Escape", isComposing: true, keyCode: 229 }); expect(dialog).toBeInTheDocument();
  act(() => h.gate.setComposing("physical-input", false));
  let releaseOther!: () => void; act(() => { releaseOther = h.gate.pushDialog("other-dialog"); }); expect(confirm).toBeDisabled();
  act(() => releaseOther()); await user.click(keep);
  await waitFor(() => expect(trigger).toHaveFocus()); expect(calls("set_work_protection")).toHaveLength(0);
  const opened = await openRelease(user); await user.click(within(opened.dialog).getByRole("button", { name: w("entryProtectionConfirmRelease") }));
  await screen.findByText(w("entryProtectionReleased"));
  expect(calls("set_work_protection")[0][1].request).toMatchObject({ ...context, sourceRevisionId: target.sourceRevisionId, selectionId: target.selectionId,
    expectedRevision: "9007199254740993", protected: false, confirmedRelease: true });
  await waitFor(() => expect(screen.getByRole("region", { name: w("entryProtectionTitle") })).toHaveFocus());
  expect(h.gate.getSnapshot().dialogs).toEqual(["workspace-dock"]); expect(h.drafts.getEntry(h.key)?.value?.text).toBe("");
});

it("requires renewed confirmation after any input sequence change, even when the user restores the original text", async () => {
  const h = await harness(), user = userEvent.setup(), { dialog } = await openRelease(user);
  act(() => { h.drafts.edit(h.key, "New input"); h.drafts.edit(h.key, originalTarget.translationText!); });
  const confirm = within(dialog).getByRole("button", { name: w("entryProtectionConfirmRelease") });
  expect(confirm).toBeDisabled(); expect(within(dialog).getByText(w("entryProtectionChanged"))).toBeInTheDocument();
  fireEvent.click(confirm); expect(calls("set_work_protection")).toHaveLength(0);
});

it("rejects a late release after fresh identical protection data revokes the original read witness", async () => {
  const h = await harness(), user = userEvent.setup(), { dialog } = await openRelease(user), allocated = deferred<string>();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "create_execution_identity" ? allocated.promise : original(command, payload));
  await user.click(within(dialog).getByRole("button", { name: w("entryProtectionConfirmRelease") }));
  await waitFor(() => expect(h.drafts.getSnapshot().mutationReserved).toBe(true));
  const queryKey = h.reads.key(protectionKey(originalTarget.unitId, originalTarget.locale, originalTarget.sourceRevisionId, originalTarget.selectionId));
  const data = h.reads.client.getQueryData(queryKey);
  act(() => h.reads.client.setQueryData(queryKey, data));
  await act(async () => allocated.resolve(fixtureIdentity(999)));
  await waitFor(() => expect(h.drafts.getSnapshot().mutationReserved).toBe(false)); expect(calls("set_work_protection")).toHaveLength(0);
});

it("does not send a late release after newer input or a view switch during identity allocation", async () => {
  const h = await harness(), user = userEvent.setup(), { dialog } = await openRelease(user), allocated = deferred<string>();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, payload) => command === "create_execution_identity" ? allocated.promise : original(command, payload));
  await user.click(within(dialog).getByRole("button", { name: w("entryProtectionConfirmRelease") }));
  await waitFor(() => expect(h.drafts.getSnapshot().mutationReserved).toBe(true));
  act(() => { h.drafts.edit(h.key, "New input B"); h.gate.setVisibleOwner("other-view"); });
  const destination = render(<Button>Other view</Button>).getByRole("button", { name: "Other view" }); destination.focus();
  h.show({ visible: false }); await act(async () => allocated.resolve(fixtureIdentity(999)));
  await waitFor(() => expect(h.drafts.getSnapshot().mutationReserved).toBe(false));
  expect(destination).toHaveFocus(); expect(calls("set_work_protection")).toHaveLength(0); expect(h.drafts.getEntry(h.key)?.value?.text).toBe("New input B");
});

it("keeps unknown protection requests with the project owner across hiding and target changes and retries only that original request", async () => {
  const originalInvoke = invoke.getMockImplementation()!; let lose = true;
  invoke.mockImplementation(async (command, payload) => { const result = await originalInvoke(command, payload); if (command === "set_work_protection" && lose) { lose = false; throw new Error("Lost acknowledgement"); } return result; });
  const h = await harness({ protectedValue: false }), user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: w("entryProtectionProtect") }));
  await waitFor(() => expect(h.owners().protection.current().pending?.phase).toBe("unknown"));
  const original = copy(h.owners().protection.current().pending?.request);
  h.show({ visible: false }); expect(h.commands.describe("translation.retry-protection", scope, { kind: "translation-protection-pending", request: original!, key: originalTarget.nativeKey })).toBeUndefined();
  h.show({ visible: true, target: reviewTargetFixture({ unitId: fixtureIdentity(995), nativeKey: "other-entry" }) });
  await user.click(await screen.findByRole("button", { name: w("entryProtectionRetry") }));
  await waitFor(() => expect(h.owners().protection.current().pending).toBeNull());
  expect(calls("set_work_protection").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
});

it("disables current actions immediately for readonly props and rechecks source, selection and protection revision changes", async () => {
  const h = await harness(), user = userEvent.setup(), opened = await openRelease(user);
  protections.set(identity(originalTarget), { unitId: originalTarget.unitId, locale: originalTarget.locale, revision: "9007199254740994", protected: true });
  await act(async () => { await h.reads.client.refetchQueries({ queryKey: h.reads.key(protectionKey(originalTarget.unitId, originalTarget.locale, originalTarget.sourceRevisionId, originalTarget.selectionId)), exact: true }); });
  expect(h.reads.client.getQueryData<WorkProtection>(h.reads.key(protectionKey(originalTarget.unitId, originalTarget.locale, originalTarget.sourceRevisionId, originalTarget.selectionId)))?.revision).toBe("9007199254740994");
  expect(within(opened.dialog).getByRole("button", { name: w("entryProtectionConfirmRelease") })).toBeDisabled();
  h.show({ target: reviewTargetFixture({ ...originalTarget, sourceRevisionId: fixtureIdentity(996), selectionId: fixtureIdentity(997), revisionId: fixtureIdentity(998) }), disabled: true });
  expect(screen.getByRole("button", { name: w("entryProtectionProtect"), hidden: true })).toBeDisabled();
  expect(screen.getByRole("button", { name: w("entryProtectionRelease"), hidden: true })).toBeDisabled();
  expect(calls("set_work_protection")).toHaveLength(0);
});

it("replays an unknown original release while retaining newer input B without allocating another action", async () => {
  const originalInvoke = invoke.getMockImplementation()!; let lose = true;
  invoke.mockImplementation(async (command, payload) => { const result = await originalInvoke(command, payload); if (command === "set_work_protection" && lose) { lose = false; throw new Error("Lost release acknowledgement"); } return result; });
  const h = await harness(), user = userEvent.setup(), { dialog } = await openRelease(user);
  await user.click(within(dialog).getByRole("button", { name: w("entryProtectionConfirmRelease") }));
  await waitFor(() => expect(h.owners().protection.current().pending?.phase).toBe("unknown"));
  const original = copy(h.owners().protection.current().pending?.request);
  act(() => { expect(h.drafts.edit(h.key, "Newer retained input B 👩🏽‍💻")).toBe(true); });
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  const retry = await screen.findByRole("button", { name: w("entryProtectionRetry") }); await waitFor(() => expect(retry).toBeEnabled());
  await user.click(retry); await waitFor(() => expect(h.owners().protection.current().pending).toBeNull());
  expect(calls("set_work_protection").map(([, payload]) => payload.request)).toEqual([original, original]);
  expect(calls("create_execution_identity")).toHaveLength(1); expect(h.drafts.getSnapshot().mutationReserved).toBe(false);
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe("Newer retained input B 👩🏽‍💻");
  expect(calls("save_translation_revision")).toHaveLength(0); expect(calls("select_translation_revision")).toHaveLength(0);
  expect(screen.getByText(w("entryProtectionReconciled"))).toBeInTheDocument();
});

it("keeps release disabled for a pending merge origin even when its text equals the current saved translation", async () => {
  const merge: DraftMergeOrigin = { comparisonId: fixtureIdentity(980), expectedBasis: "synthetic-comparison-basis", contributors: [originalTarget.revisionId!] };
  const h = await harness({ merge });
  expect(h.drafts.getEntry(h.key)?.value?.text).toBe(originalTarget.translationText);
  expect(h.drafts.getEntry(h.key)?.value?.merge).toEqual(merge);
  expect(screen.getByRole("button", { name: w("entryProtectionRelease") })).toBeDisabled();
  expect(screen.getByText(w("entryProtectionDraftBlocked"))).toBeInTheDocument(); expect(calls("set_work_protection")).toHaveLength(0);
});
