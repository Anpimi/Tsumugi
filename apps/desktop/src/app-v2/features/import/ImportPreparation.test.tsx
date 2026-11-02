import { useLayoutEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n";
import type { TranslationKey } from "../../../i18n/types";
import type { workbenchEn } from "../../../i18n/workbench";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { TranslationImportProvider, useTranslationImportSession } from "../../../TranslationImportSession";
import { ExecutionTaskProvider, useExecutionTaskSession, type MutationCoordinator } from "../../../ExecutionTaskSession";
import { executionContext, type AttemptDetail } from "../../../executionCommands";
import { WorkbenchCommands } from "../../../workbenchCommands";
import type { ProjectView } from "../../../projectCommands";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { translationInventory, translationPackage, translationView } from "../../../testSupport/pluginTranslationFixture";
import { translationPreviewFixture, translationImportChoice, translationSelectionFixture, translationCaptureFixture,
  translationCheckerFixture, translationProjectionFixture, translationStageAttempt, translationAttemptFixture, translationRowFixture,
  translationActionFixture, translationReceiptFixture, translationRecoveryUnit } from "../../../testSupport/translationFixture";
import type { TranslationAdoptRequest } from "../../../translationCommands";
import { validateRequestAdopt } from "../../../generated/translation.validators";
import { TranslationDrafts } from "../editor/translationDrafts";
import { ProjectLifecycle } from "../../platform/projectLifecycle";
import { InteractionGate } from "../../workspace/interactionGate";
import ImportPreparation from "./ImportPreparation";
import ImportOwnerHost from "./ImportOwnerHost";
import type { ImportOwners } from "./importTypes";
import TranslationImportPanel from "./TranslationImportPanel";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { locator: "/synthetic/import-preparation", sessionToken: "import-preparation", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(900), displayName: "Import fixture", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN", "ja"] } };
const context = executionContext(project), scope = { ...context, area: "translation" as const }, preview = translationPreviewFixture();
const owners: SessionReads[] = [];
const draftOwners: TranslationDrafts[] = [];
const lifecycles: ProjectLifecycle[] = [];
let identity: number, qualified: boolean;
let attempts: Map<string, AttemptDetail>;
let owner: ReturnType<typeof useTranslationImportSession>, tasks: ReturnType<typeof useExecutionTaskSession>;
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
const text = (key: TranslationKey) => i18n.t(key);
const click = (key: TranslationKey) => fireEvent.click(screen.getByRole("button", { name: text(key) }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function ImportOwner({ children, mutations }: { children: ReactNode; mutations: MutationCoordinator }) {
  const value = useExecutionTaskSession();
  return <TranslationImportProvider project={project} tasks={value} mutations={mutations}>{children}</TranslationImportProvider>;
}
function Probe({ commands, gate, disabled, visible }: { commands: WorkbenchCommands; gate: InteractionGate; disabled: boolean; visible: boolean }) {
  const value = useTranslationImportSession(), taskOwner = useExecutionTaskSession();
  useLayoutEffect(() => { owner = value; tasks = taskOwner; });
  return <ImportPreparation project={project} owner={value} tasks={taskOwner} commands={commands} gate={gate} viewId="entries" disabled={disabled} visible={visible} />;
}
function harness() {
  const reads = new SessionReads(context); owners.push(reads);
  const commands = new WorkbenchCommands(), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  let reserved: symbol | null = null;
  const mutations: MutationCoordinator = {
    reserveMutation: () => reserved ? null : (reserved = Symbol("import-mutation")),
    releaseMutation: token => { if (reserved === token) reserved = null; },
  };
  const ui = (visible: boolean, disabled: boolean) => <SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={mutations}><ImportOwner mutations={mutations}>
      <Probe commands={commands} gate={gate} visible={visible} disabled={disabled} />
    </ImportOwner></ExecutionTaskProvider>
  </SessionReadProvider>;
  const result = render(ui(true, false));
  return { reads, commands, gate, show: (visible = true, disabled = false) => result.rerender(ui(visible, disabled)) };
}
async function chooseMenu(labelKey: TranslationKey, item: string) {
  const trigger = await screen.findByRole("button", { name: text(labelKey) });
  await waitFor(() => expect(trigger).toBeEnabled());
  trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}
async function selectEnvironment() {
  const contribution = translationPackage.manifest.contributions[0];
  await chooseMenu("translationPlugin.package", `${translationPackage.manifest.plugin.id} ${translationPackage.manifest.plugin.version} · ${contribution.id}`);
  const trigger = screen.getByRole("button", { name: text("sourcePlugin.runtime") });
  await waitFor(() => expect(trigger).toBeEnabled());
  trigger.focus(); fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem"));
  await waitFor(() => expect(screen.getByRole("button", { name: text("translation.chooseFolder") })).toBeEnabled());
}
async function selectFile() {
  await selectEnvironment();
  click("translation.chooseFolder");
  await chooseMenu("translation.file", "zh.json");
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm that zh.json is for zh-CN/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.capture") })).toBeEnabled());
}
async function captureFile() {
  await selectFile(); click("translationPlugin.capture");
  await screen.findByRole("region", { name: text("translationPlugin.producerReview") });
}
async function extract() {
  await captureFile();
  fireEvent.click(screen.getByRole("checkbox", { name: text("translationPlugin.producerConsent") }));
  click("translation.start");
  await waitFor(() => expect(owner.current().extractionAttempt).not.toBeNull());
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US"); identity = 100; qualified = false; attempts = new Map(); invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const request = args.request;
    if (command === "read_plugin_inventory") return translationInventory;
    if (command === "read_plugin_package") return translationPackage;
    if (command === "read_plugin_translation") return translationView;
    if (command === "read_plugin_translation_source") return translationImportChoice(preview.fixedSourceSnapshotId).source;
    if (command === "read_content_scope") return { revision: "1", currentSnapshot: preview.fixedSourceSnapshotId };
    if (command === "select_plugin_translation") return translationSelectionFixture(preview.fixedSourceSnapshotId);
    if (command === "list_plugin_translation_files") return ["zh.json"];
    if (command === "create_execution_identity") return fixtureIdentity(identity++);
    if (command === "preflight_plugin_translation") return translationCaptureFixture(String(request.attemptId), preview.fixedSourceSnapshotId);
    if (command === "start_plugin_translation" || command === "start_translation_check") {
      const operation = command === "start_plugin_translation" ? "translation-extract" : "translation-semantic-check";
      attempts.set(String(request.attemptId), translationStageAttempt(String(request.attemptId), operation));
      return request.attemptId;
    }
    if (command === "prepare_translation_check") return translationCheckerFixture(String(request.attemptId), String(request.translationAttemptId), String(request.translationResultId), preview.fixedSourceSnapshotId);
    if (command === "finish_translation_check") { qualified = true; return null; }
    if (command === "prepare_translation_projection") return translationProjectionFixture(String(request.attemptId), String(request.translationAttemptId), String(request.translationResultId), preview.fixedSourceSnapshotId);
    if (command === "start_translation_projection") {
      attempts.set(String(request.attemptId), translationAttemptFixture({ ...preview, attemptId: String(request.attemptId) }));
      return request.attemptId;
    }
    if (command === "read_execution_attempt") {
      const detail = attempts.get(String(request.attemptId));
      return detail && detail.operation === "translation-extract" && qualified ? { ...detail, items: detail.items.map(item => ({ ...item, status: { ...item.status, validation: "valid" } })) } : detail ?? null;
    }
    if (command === "read_plugin_execution_start" || command === "read_translation_projection_start" || command === "read_execution_cancellation_action") return null;
    if (command === "cancel_execution_task") return "1";
    throw new Error(`Unexpected synthetic request: ${command}`);
  });
});
afterEach(() => { cleanup(); draftOwners.splice(0).forEach(drafts => drafts.retire()); owners.splice(0).forEach(reads => reads.retire()); lifecycles.splice(0).forEach(value => value.dispose()); });

function FullImportPanel({ commands, gate, drafts, lifecycle }: {
  commands: WorkbenchCommands; gate: InteractionGate; drafts: TranslationDrafts; lifecycle: ProjectLifecycle;
}) {
  const [owners, retain] = useState<ImportOwners | null>(null);
  useLayoutEffect(() => { if (owners) { owner = owners.imports; tasks = owners.tasks; } });
  return <><ImportOwnerHost project={project} drafts={drafts} lifecycle={lifecycle} onOwners={retain} onReveal={() => undefined}/>
    {owners ? <TranslationImportPanel project={project} owners={owners} drafts={drafts} commands={commands} gate={gate}
      viewId="entries" visible disabled={false} onBack={() => undefined} onOpenEntry={() => undefined} /> : null}</>;
}

async function fullPanelHarness() {
  const reads = new SessionReads(context); owners.push(reads);
  const drafts = new TranslationDrafts({ context, reads, ports: { writerId: () => "full-import-writer", list: async () => ({ items: [], next: null }) } });
  draftOwners.push(drafts); expect(await drafts.initialize()).toBe(true);
  const lifecycle = new ProjectLifecycle(); lifecycles.push(lifecycle);
  const commands = new WorkbenchCommands(), gate = new InteractionGate(); gate.setVisibleOwner("entries");
  render(<SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={drafts}>
      <FullImportPanel commands={commands} gate={gate} drafts={drafts} lifecycle={lifecycle} />
    </ExecutionTaskProvider>
  </SessionReadProvider>);
  return { drafts };
}

it("takes file and language consent through matching, fixes a partial batch and reconciles only its original unknown action", async () => {
  const rows = [translationRowFixture(0), translationRowFixture(1), translationRowFixture(2),
    translationRowFixture(3, { status: "selected-conflict", currentText: "Keep the existing translation" }),
    translationRowFixture(4, { status: "ambiguous", unitId: null }), translationRowFixture(5, { status: "unmatched", unitId: null })];
  rows[0].entry.text = "Imported {name}\ne\u0301 👩🏽‍💻 日本語";
  let projected = translationPreviewFixture(rows), lookupAvailable = false;
  const originalInvoke = invoke.getMockImplementation()!, requests = new Map<string, TranslationAdoptRequest>();
  const importedRow = (request: TranslationAdoptRequest) => {
    const row = rows.find(value => value.itemId === request.itemId);
    if (!row) throw new Error("The original adoption must reference one captured row");
    return row;
  };
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    const request = args.request;
    if (command === "start_translation_projection") {
      projected = { ...projected, attemptId: String(request.attemptId) };
      attempts.set(projected.attemptId, translationAttemptFixture(projected)); return projected.attemptId;
    }
    if (command === "read_translation_preview") {
      const rows = projected.rows.filter(row => row.entry.ordinal >= Number(request.after)).slice(0, 2), last = rows.at(-1)?.entry.ordinal;
      return { ...projected, rows, nextOrdinal: last !== undefined && last + 1 < projected.total ? last + 1 : null };
    }
    if (command === "read_execution_attempt" && request.attemptId === projected.attemptId && attempts.has(projected.attemptId)) {
      const offset = Number(request.offset), page = projected.rows.slice(offset, offset + 2);
      return translationAttemptFixture(projected, page, offset + page.length < projected.total ? offset + page.length : null);
    }
    if (command === "prepare_translation_adoption") {
      if (!validateRequestAdopt(request)) throw new Error("Invalid captured adoption request");
      requests.set(request.actionId, request);
      if (request.itemId === rows[1].itemId) throw { code: "dependency-conflict", outcome: "rejected", stage: "execution-adopt", recoveryRequired: false, reason: "translation-selection" };
      return translationActionFixture(request, translationRecoveryUnit(importedRow(request)));
    }
    if (command === "adopt_execution") {
      const original = requests.get(String(request.actionId));
      if (!original) throw new Error("An original prepared adoption is required");
      if (original.itemId === rows[2].itemId) throw new Error("Synthetic lost adoption acknowledgement");
      return translationReceiptFixture(original, translationRecoveryUnit(importedRow(original)));
    }
    if (command === "read_translation_adoption_action") {
      if (!lookupAvailable) throw new Error("Synthetic original receipt not yet available");
      const original = request.adoption;
      if (!validateRequestAdopt(original)) throw new Error("The original request must be retained for lookup");
      const unit = translationRecoveryUnit(importedRow(original));
      return { action: translationActionFixture(original, unit), receipt: translationReceiptFixture(original, unit) };
    }
    return originalInvoke(command, args);
  });
  const { drafts } = await fullPanelHarness();
  await captureFile();
  expect(calls("start_plugin_translation")).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox", { name: text("translationPlugin.producerConsent") })); click("translation.start");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.prepareCheck") })).toBeEnabled());
  click("translationPlugin.prepareCheck");
  await screen.findByRole("region", { name: text("translationPlugin.checkReview") });
  expect(calls("start_translation_check")).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox", { name: text("translationPlugin.checkerConsent") })); click("translationPlugin.startCheck");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.recordCheck") })).toBeEnabled());
  click("translationPlugin.recordCheck");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.preparePreview") })).toBeEnabled());
  click("translationPlugin.preparePreview");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.openPreview") })).toBeEnabled());
  click("translationPlugin.openPreview");
  await screen.findByRole("rowheader", { name: "key-0" });
  expect(screen.getByRole("rowheader", { name: "key-0" }).closest("tr")).toHaveTextContent(rows[0].entry.text, { normalizeWhitespace: false });
  expect(calls("prepare_translation_adoption")).toHaveLength(0);
  type WorkbenchTextKey = { [K in keyof typeof workbenchEn]: typeof workbenchEn[K] extends string ? K : never }[keyof typeof workbenchEn];
  const w = (key: WorkbenchTextKey) => i18n.t(`workbenchV2.${key}`);
  fireEvent.click(screen.getByRole("checkbox", { name: w("importSelectEmpty") }));
  fireEvent.click(screen.getByRole("button", { name: w("importPrepareBatch") }));
  await screen.findByRole("region", { name: w("importConfirmBatch") });
  expect(owner.current().batchCapture?.eligible.map(row => row.itemId)).toEqual(rows.slice(0, 3).map(row => row.itemId));
  expect(owner.current().batchCapture?.excluded).toBe(3);
  expect(calls("prepare_translation_adoption")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: w("nextPage") })); await screen.findByRole("rowheader", { name: "key-2" });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("workbenchV2.importApplyBatch", { count: 3 }) }));
  await waitFor(() => expect(owner.current().batchOutcome).toEqual({ applied: 1, conflicted: 1, failed: 0, unknown: 1 }));
  expect(drafts.getSnapshot().mutationReserved).toBe(true);
  expect(calls("prepare_translation_adoption").map(([, args]) => args.request.itemId)).toEqual(rows.slice(0, 3).map(row => row.itemId));
  expect(calls("prepare_translation_adoption").every(([, args]) => args.request.confirmation.decision === "select-if-empty")).toBe(true);
  const pending = owner.current().uncertain[0], writes = calls("prepare_translation_adoption").length + calls("adopt_execution").length,
    identities = calls("create_execution_identity").length;
  expect(screen.queryByRole("button", { name: w("importRetryOriginal") })).not.toBeInTheDocument();
  lookupAvailable = true;
  fireEvent.click(screen.getByRole("button", { name: w("importCheckResult") }));
  await waitFor(() => expect(owner.current().uncertain).toHaveLength(0));
  expect(calls("read_translation_adoption_action").at(-1)?.[1].request).toEqual({ adoption: pending.request, unitId: pending.recoveryUnitId });
  expect(calls("prepare_translation_adoption").length + calls("adopt_execution").length).toBe(writes);
  expect(calls("create_execution_identity")).toHaveLength(identities);
  expect(owner.current().batchOutcome).toEqual({ applied: 2, conflicted: 1, failed: 0, unknown: 0 });
  expect(drafts.getSnapshot().mutationReserved).toBe(false);
  expect(screen.getByText(i18n.t("workbenchV2.importOutcome", { applied: "2", conflicted: "1", failed: "0", unknown: "0" }))).toBeVisible();
  expect(calls("start_plugin_translation")).toHaveLength(1); expect(calls("start_translation_check")).toHaveLength(1);
  expect(calls("start_translation_projection")).toHaveLength(1);
}, 15000);

it("takes explicit file, language, extraction and checker decisions before preparing the existing match preview", async () => {
  harness(); await captureFile();
  expect(calls("start_plugin_translation")).toHaveLength(0);
  expect(screen.getByText(text("sourcePlugin.unsandboxed"))).toBeVisible();
  expect(screen.getByRole("button", { name: text("translation.start") })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: text("translationPlugin.producerConsent") })); click("translation.start");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.prepareCheck") })).toBeEnabled());
  click("translationPlugin.prepareCheck");
  await screen.findByRole("region", { name: text("translationPlugin.checkReview") });
  expect(calls("start_translation_check")).toHaveLength(0);
  expect(screen.getByRole("button", { name: text("translationPlugin.startCheck") })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: text("translationPlugin.checkerConsent") })); click("translationPlugin.startCheck");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.recordCheck") })).toBeEnabled());
  click("translationPlugin.recordCheck");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.preparePreview") })).toBeEnabled());
  click("translationPlugin.preparePreview");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.openPreview") })).toBeEnabled());
  click("translationPlugin.openPreview");
  await waitFor(() => expect(owner.current().attempt).not.toBeNull());
  expect(calls("start_plugin_translation")[0][1].request).toMatchObject({ inputDigest: owner.current().preflight?.inputDigest, unsandboxedExecution: true });
  expect(calls("start_translation_check")[0][1].request).toMatchObject({ inputDigest: owner.current().checkReview?.inputDigest, unsandboxedExecution: true });
  expect(calls("prepare_translation_adoption")).toHaveLength(0);
});

it("blocks stale Registry actions at dispatch after cache invalidation, composition or visible-view changes", async () => {
  const { commands, reads, gate } = harness(); await selectEnvironment();
  const input = { kind: "translation-import-setup" as const, editSeq: owner.current().editSeq, locale: "zh-CN", selectionId: null, fileName: "" };
  act(() => gate.setComposing("synthetic-editor", true));
  expect(commands.dispatch("translation.choose-import-folder", scope, input)).toBe(false);
  act(() => { gate.setComposing("synthetic-editor", false); gate.setVisibleOwner("another-view"); });
  expect(commands.dispatch("translation.choose-import-folder", scope, input)).toBe(false);
  act(() => { gate.setVisibleOwner("entries"); reads.client.getQueryCache().find({ queryKey: reads.key(["translation-plugin-source", "zh-CN"]), exact: true })?.invalidate(); });
  expect(commands.dispatch("translation.choose-import-folder", scope, input)).toBe(false);
  expect(calls("select_plugin_translation")).toHaveLength(0);
});

it("rejects a late folder selection when its exact source Query was replaced", async () => {
  const selected = deferred<ReturnType<typeof translationSelectionFixture>>();
  const wire = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "select_plugin_translation" ? selected.promise : wire(command, args));
  const { reads } = harness(); await selectEnvironment(); click("translation.chooseFolder");
  await waitFor(() => expect(calls("select_plugin_translation")).toHaveLength(1));
  act(() => {
    reads.client.removeQueries({ queryKey: reads.key(["translation-plugin-source", "zh-CN"]), exact: true });
    reads.client.setQueryData(reads.key(["translation-plugin-source", "zh-CN"]), translationImportChoice(preview.fixedSourceSnapshotId).source);
  });
  await act(async () => selected.resolve(translationSelectionFixture(preview.fixedSourceSnapshotId)));
  expect(owner.current().folder).toBeNull(); expect(calls("preflight_plugin_translation")).toHaveLength(0);
});

it.each(["hidden", "readonly"] as const)("keeps selected input when a %s view blocks capture before delayed identity allocation completes", async mode => {
  const { show } = harness(); await selectFile();
  const allocated = deferred<string>(), wire = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "create_execution_identity" ? allocated.promise : wire(command, args));
  click("translationPlugin.capture"); await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  show(mode !== "hidden", mode === "readonly");
  await act(async () => allocated.resolve(fixtureIdentity(777)));
  expect(owner.current().fileName).toBe("zh.json"); expect(owner.current().folder).not.toBeNull();
  expect(calls("preflight_plugin_translation")).toHaveLength(0);
});

it("renders current interaction permissions on mount and prop changes without waiting for query results", () => {
  const unread = deferred<never>();
  invoke.mockImplementation(() => unread.promise);
  const { show } = harness();
  const refresh = () => screen.getByRole("button", { name: text("translationPlugin.refresh") });
  const target = () => screen.getByRole("button", { name: text("workbenchV2.importPreparationTarget") });
  expect(refresh()).toBeEnabled(); expect(target()).toBeEnabled();
  show(true, true);
  expect(refresh()).toBeDisabled(); expect(target()).toBeDisabled();
  show(true, false);
  expect(refresh()).toBeEnabled(); expect(target()).toBeEnabled();
  show(false);
  expect(screen.queryByRole("region", { name: text("workbenchV2.importPreparationTitle") })).toBeNull();
  show(true);
  expect(refresh()).toBeEnabled(); expect(target()).toBeEnabled();
});

it("keeps an unknown producer start and retries only its original request after an explicit check", async () => {
  const wire = invoke.getMockImplementation()!;
  let allowRetry = false, readAllowed = false;
  invoke.mockImplementation((command, args) => {
    if (command === "start_plugin_translation" && !allowRetry) return Promise.reject(new Error("Lost synthetic acknowledgement"));
    if (command === "read_plugin_execution_start" && !readAllowed) return Promise.reject(new Error("Synthetic lookup unavailable"));
    return wire(command, args);
  });
  const { show } = harness(); await captureFile();
  fireEvent.click(screen.getByRole("checkbox", { name: text("translationPlugin.producerConsent") })); click("translation.start");
  await waitFor(() => expect(owner.current().pendingStart).not.toBeNull());
  await waitFor(() => expect(owner.current().busy).toBe(false));
  const original = owner.current().pendingStart;
  expect(screen.queryByRole("button", { name: text("execution.retryPluginStart") })).toBeNull();
  const unread = deferred<never>(), retainedWire = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => ["read_plugin_inventory", "read_plugin_package", "read_plugin_translation", "read_plugin_translation_source", "list_plugin_translation_files"].includes(command)
    ? unread.promise : retainedWire(command, args));
  show(true, true);
  expect(screen.getByRole("button", { name: text("execution.checkPluginStart") })).toBeDisabled();
  show(true, false);
  expect(screen.getByRole("button", { name: text("execution.checkPluginStart") })).toBeEnabled();
  show(false); show(true);
  expect(screen.getByRole("button", { name: text("execution.checkPluginStart") })).toBeEnabled();
  expect(calls("start_plugin_translation")).toHaveLength(1);
  readAllowed = true; click("execution.checkPluginStart");
  await waitFor(() => expect(screen.getByRole("button", { name: text("execution.retryPluginStart") })).toBeEnabled());
  allowRetry = true; const allocated = calls("create_execution_identity").length; click("execution.retryPluginStart");
  await waitFor(() => expect(owner.current().pendingStart).toBeNull());
  expect(calls("start_plugin_translation").map(([, args]) => args.request)).toEqual([original, original]);
  expect(calls("create_execution_identity")).toHaveLength(allocated);
});

it.each(["checker", "projection"] as const)("keeps the original unknown %s start separate from a new execution", async phase => {
  const wire = invoke.getMockImplementation()!;
  let allowRetry = false, readAllowed = false;
  const startCommand = phase === "checker" ? "start_translation_check" : "start_translation_projection";
  const readCommand = phase === "checker" ? "read_plugin_execution_start" : "read_translation_projection_start";
  invoke.mockImplementation((command, args) => {
    if (command === startCommand && !allowRetry) return Promise.reject(new Error("Lost synthetic plugin acknowledgement"));
    if (command === readCommand && !readAllowed) return Promise.reject(new Error("Synthetic plugin lookup unavailable"));
    return wire(command, args);
  });
  if (phase === "projection") qualified = true;
  const { show } = harness(); await extract();
  if (phase === "checker") {
    await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.prepareCheck") })).toBeEnabled());
    click("translationPlugin.prepareCheck"); await screen.findByRole("region", { name: text("translationPlugin.checkReview") });
    fireEvent.click(screen.getByRole("checkbox", { name: text("translationPlugin.checkerConsent") })); click("translationPlugin.startCheck");
  } else {
    await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.preparePreview") })).toBeEnabled());
    click("translationPlugin.preparePreview");
    await waitFor(() => expect(screen.getByRole("button", { name: text("translationPlugin.openPreview") })).toBeEnabled());
    click("translationPlugin.openPreview");
  }
  await waitFor(() => expect(owner.current().pendingPlugin?.pendingKind).toBe(phase === "checker" ? "start-check" : "start-projection"));
  await waitFor(() => expect(owner.current().busy).toBe(false));
  const original = owner.current().pendingPlugin?.request;
  show(false); show(true);
  await waitFor(() => expect(screen.getByRole("button", { name: text("execution.checkPluginStart") })).toBeEnabled());
  expect(screen.queryByRole("button", { name: text("execution.retryPluginStart") })).toBeNull();
  expect(calls(startCommand)).toHaveLength(1);
  readAllowed = true; click("execution.checkPluginStart");
  await waitFor(() => expect(screen.getByRole("button", { name: text("execution.retryPluginStart") })).toBeEnabled());
  allowRetry = true; const allocated = calls("create_execution_identity").length; click("execution.retryPluginStart");
  await waitFor(() => expect(owner.current().pendingPlugin).toBeNull());
  expect(calls(startCommand).map(([, args]) => args.request)).toEqual([original, original]);
  expect(calls("create_execution_identity")).toHaveLength(allocated);
});

it("explains missing plugins and compatible approved runtimes without presenting a runnable import", async () => {
  const wire = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "read_plugin_inventory" ? Promise.resolve({ ...translationInventory, packages: [], packageDecisions: [] }) : wire(command, args));
  const { reads } = harness();
  await screen.findByText(text("workbenchV2.importPreparationNoPlugins"));
  expect(screen.getByRole("button", { name: text("translation.chooseFolder") })).toBeDisabled();
  invoke.mockImplementation((command, args) => command === "read_plugin_inventory" ? Promise.resolve({ ...translationInventory, runtimeDecisions: [] }) : wire(command, args));
  act(() => reads.invalidate(["project"]));
  const contribution = translationPackage.manifest.contributions[0];
  await chooseMenu("translationPlugin.package", `${translationPackage.manifest.plugin.id} ${translationPackage.manifest.plugin.version} · ${contribution.id}`);
  await screen.findByText(text("workbenchV2.importPreparationNoRuntimes"));
  expect(screen.getByRole("button", { name: text("sourcePlugin.runtime") })).toBeDisabled();
});

it("keeps the selected folder after a file-read failure and recovers through the read command", async () => {
  const wire = invoke.getMockImplementation()!; let filesAvailable = false;
  invoke.mockImplementation((command, args) => command === "list_plugin_translation_files" && !filesAvailable ? Promise.reject(new Error("Synthetic file read failed")) : wire(command, args));
  harness(); await selectEnvironment(); click("translation.chooseFolder");
  await screen.findByText(text("workbenchV2.importPreparationReadFailed"));
  const selected = owner.current().folder;
  filesAvailable = true; click("workbenchV2.importPreparationRetryRead");
  await waitFor(() => expect(screen.getByRole("button", { name: text("translation.file") })).toBeEnabled());
  expect(owner.current().folder).toEqual(selected); expect(calls("select_plugin_translation")).toHaveLength(1);
});

it("routes cancellation and uncertain cancellation recovery through the original Task owner", async () => {
  const wire = invoke.getMockImplementation()!; let retryAllowed = false;
  invoke.mockImplementation((command, args) => {
    if (command === "start_plugin_translation") {
      const detail = translationStageAttempt(String(args.request.attemptId), "translation-extract");
      detail.items[0].status.execution = "dispatched"; attempts.set(String(args.request.attemptId), detail); return Promise.resolve(args.request.attemptId);
    }
    if (command === "cancel_execution_task" && !retryAllowed) return Promise.reject(new Error("Lost synthetic cancellation acknowledgement"));
    return wire(command, args);
  });
  harness(); await extract();
  await waitFor(() => expect(screen.getByRole("button", { name: text("execution.cancel") })).toBeEnabled());
  click("execution.cancel");
  await screen.findByText(text("execution.cancelUnknown"));
  expect(calls("cancel_execution_task")).toHaveLength(1);
  const original = calls("cancel_execution_task")[0][1].request;
  click("execution.checkCancellation");
  await waitFor(() => expect(screen.getByRole("button", { name: text("execution.retryCancellation") })).toBeEnabled());
  retryAllowed = true; click("execution.retryCancellation");
  await screen.findByText(text("execution.cancelRecorded"));
  expect(calls("cancel_execution_task").map(([, args]) => args.request)).toEqual([original, original]);
  expect(tasks.current(original.taskId)?.phase).toBe("recorded");
});

it("keeps running attempt facts while hidden and prevents new execution in read-only mode", async () => {
  const { show, reads, commands } = harness(); await extract();
  const attempt = owner.current().extractionAttempt!;
  const detail = translationStageAttempt(attempt, "translation-extract"); detail.items[0].status.execution = "dispatched";
  act(() => { reads.client.setQueryData(reads.key(["translation-plugin-producer", attempt]), detail); });
  show(false);
  expect(owner.hasActive()).toBe(true); expect(calls("cancel_execution_task")).toHaveLength(0);
  expect(commands.describe("translation.start-import", scope, { kind: "translation-import-consent", editSeq: owner.current().editSeq, locale: "zh-CN", selectionId: owner.current().folder?.selectionId ?? null, fileName: "zh.json", sourceSnapshotId: preview.fixedSourceSnapshotId,
    fileDigest: owner.current().preflight?.file.sha256 ?? null, inputDigest: owner.current().preflight?.inputDigest ?? null, producerConsent: true, confirmed: true })).toBeUndefined();
  show(true, true);
  await screen.findByText(text("workbenchV2.importPreparationReadOnly"));
  expect(screen.getByRole("button", { name: text("execution.cancel") })).toBeDisabled();
  expect(owner.current().extractionAttempt).toBe(attempt);
});
