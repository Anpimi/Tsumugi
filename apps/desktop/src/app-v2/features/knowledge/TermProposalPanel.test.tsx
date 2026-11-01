import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import wire from "../../../../test/fixtures/resourceCommands.contract.json";
import { ExecutionTaskSession } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import { installResourceDraftFixture } from "../../../testSupport/resourceDraftFixture";
import type { knowledgeEn } from "../../../i18n/knowledge";
import type { ProjectView } from "../../../projectCommands";
import { ResourceDraftSession, useResourceDraftSession } from "../../../ResourceDraftSession";
import { validateRequestDecision, validateResponsePreview, validateResponseTerm } from "../../../generated/resource.validators";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { TranslationDraftSession } from "../../../TranslationDraftSession";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { retrievalCapture, retrievalQuery, retrievalResourcePreview } from "../../../testSupport/mcpRetrievalFixture";
import type { ResourceDecision, ResourcePreview } from "../../../resourceCommands";
import { termProposalFixture } from "../../../testSupport/termProposalFixture";
import { InteractionGate } from "../../workspace/interactionGate";
import TermProposalPanel from "./TermProposalPanel";
import type { KnowledgeOwner } from "./knowledgeTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "synthetic-term-proposals", locator: "synthetic-project", reconciliationState: "settled",
  metadata: { projectId: wire.requests.session.projectId, displayName: "Synthetic terms", sourceLocale: "en-US", targetLocales: ["zh-CN"], metadataRevision: "1" } };
let preview: ResourcePreview, reads: SessionReads, gate: InteractionGate, observed: KnowledgeOwner | undefined;
type MessageKey = { [Key in keyof typeof knowledgeEn]: typeof knowledgeEn[Key] extends string ? Key : never }[keyof typeof knowledgeEn];
const label = (key: MessageKey) => i18n.t(`knowledge.${key}`);
let decisionCount = 0, uncertain = false;

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  const raw: unknown = structuredClone(wire.responses.preview);
  if (!validateResponsePreview(raw)) throw new Error("Synthetic term proposal required");
  preview = raw; observed = undefined; decisionCount = 0; uncertain = false;
  reads = new SessionReads(executionContext(project)); gate = new InteractionGate(); gate.setVisibleOwner("knowledge-view");
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, payload: { request: unknown }) => {
    if (command === "read_content_scope") return { revision: "2", currentSnapshot: fixtureIdentity(400) };
    if (command === "list_resource_captures") return [structuredClone(preview.capture)];
    if (command === "read_resource_preview") return structuredClone(preview);
    if (command === "create_execution_identity") return fixtureIdentity(700);
    if ((command === "read_resource_decision_action" || command === "observe_resource_decision_action")) return null;
    if (command === "decide_resource_entry") {
      if (!validateRequestDecision(payload.request)) throw new Error("Invalid original term decision request");
      decisionCount += 1;
      const request = payload.request.decision;
      return { request, actionId: uncertain && decisionCount === 1 ? "invalid-acknowledgement" : request.actionId,
        decision: request.decision, revision: null };
    }
    throw new Error(`Unexpected synthetic command: ${command}`);
  });
  installResourceDraftFixture();
});
afterEach(() => { cleanup(); reads.retire(); gate.dispose(); });

function Content() {
  const owner = useResourceDraftSession(); observed = owner;
  return <TermProposalPanel project={project} owner={owner} disabled={false} gate={gate} viewId="knowledge-view"
    current={dialogId => gate.canDispatch({ viewId: "knowledge-view", source: "button", dialogId })}/>;
}
function observedOwner(): KnowledgeOwner {
  if (!observed) throw new Error("The synthetic resource owner has not mounted");
  return observed;
}
async function open() {
  installResourceDraftFixture();
  render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}>
    <TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
      <ResourceDraftSession project={project}><Content/></ResourceDraftSession>
    </ExecutionTaskSession></TranslationDraftSession>
  </SessionReadProvider>);
  const user = userEvent.setup();
  await waitFor(() => expect(observed?.journal.hydration).toBe("ready"));
  await user.click(await screen.findByRole("button", { name: label("proposalOpen") }));
  await waitFor(() => expect(screen.getByRole("button", { name: label("proposalAdopt") })).toBeEnabled());
  return user;
}
const decisions = () => invoke.mock.calls.filter(([name]) => name === "decide_resource_entry");

it.each(["en-US", "zh-CN"])("reads a proposal without applying it and sends the exact original decision (%s)", async locale => {
  await i18n.changeLanguage(locale);
  const user = await open();
  expect(screen.getAllByText(preview.rows[0].entry.target)[0]).toBeVisible();
  expect(decisions()).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: label("proposalAdopt") }));
  await waitFor(() => expect(decisions()).toHaveLength(1));
  expect(decisions()[0][1].request.decision).toEqual({ projectId: project.metadata.projectId,
    actionId: fixtureIdentity(700), captureId: preview.capture.captureId, entryId: preview.rows[0].entry.id,
    expectedRevisionId: null, decision: "adopt" });
  await waitFor(() => expect(observed?.current().pending).toBeNull());
  expect(observed?.current().previewNeedsRefresh).toBe(true);
});

it("retains the explicit file chooser and its original preview path", async () => {
  const original = invoke.getMockImplementation();
  if (!original) throw new Error("Synthetic IPC harness required");
  invoke.mockImplementation((command, payload) => command === "choose_resource_file" ? Promise.resolve(structuredClone(preview.capture)) : original(command, payload));
  const user = await open();
  expect(invoke.mock.calls.filter(([name]) => name === "choose_resource_file")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: label("proposalChooseFile") }));
  await waitFor(() => expect(invoke.mock.calls.filter(([name]) => name === "choose_resource_file")).toHaveLength(1));
  await waitFor(() => expect(observed?.current().previewNeedsRefresh).toBe(false));
  expect(observed?.current().previewCapture?.origin.kind).toBe("file");
  expect(decisions()).toHaveLength(0);
});

it("keeps the original action after an uncertain acknowledgement and retries only that request", async () => {
  uncertain = true;
  const user = await open();
  await user.click(screen.getByRole("button", { name: label("proposalAdopt") }));
  await waitFor(() => expect(observed?.current().pendingUncertain).toBe(true));
  expect(observed?.current().pendingCheckedMissing).toBe(false);
  expect(screen.queryByRole("button", { name: label("proposalRetry") })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: label("proposalCheck") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: label("proposalCheck") }));
  await user.click(await screen.findByRole("button", { name: label("proposalRetry") }));
  await waitFor(() => expect(decisions()).toHaveLength(2));
  expect(decisions()[1][1].request).toEqual(decisions()[0][1].request);
  expect(invoke.mock.calls.filter(([name]) => name === "create_execution_identity")).toHaveLength(1);
  await waitFor(() => expect(observed?.current().pending).toBeNull());
});

it("rechecks the current row inside a replacement confirmation and keeps changed evidence visible", async () => {
  const rawCurrent: unknown = { ...structuredClone(wire.responses.term), scopeUnitId: null };
  if (!validateResponseTerm(rawCurrent)) throw new Error("Synthetic saved term required");
  const current = rawCurrent;
  preview.rows[0] = { ...preview.rows[0], kind: "override", current };
  // This case starts with an overwrite, rather than the ordinary adoption used by open().
  render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}>
    <TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
      <ResourceDraftSession project={project}><Content/></ResourceDraftSession>
    </ExecutionTaskSession></TranslationDraftSession>
  </SessionReadProvider>);
  const user = userEvent.setup();
  await waitFor(() => expect(observed?.journal.hydration).toBe("ready"));
  await user.click(await screen.findByRole("button", { name: label("proposalOpen") }));
  await user.click(await screen.findByRole("button", { name: label("proposalOverride") }));
  const dialog = await screen.findByRole("dialog", { name: label("proposalConfirmTitle") });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: label("proposalOverride") })).toBeEnabled());
  expect(gate.canDispatch({ viewId: "knowledge-view", source: "keyboard" })).toBe(false);
  preview.rows[0] = { ...preview.rows[0], current: { ...current, revisionId: fixtureIdentity(701), target: "A newer human translation" } };
  await act(async () => { reads.invalidate(["resources"]); });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: label("proposalOverride") })).toBeDisabled());
  expect(within(dialog).getByText(label("proposalChanged"))).toBeVisible();
  expect(decisions()).toHaveLength(0);
  await user.click(within(dialog).getAllByRole("button", { name: label("proposalCancel") })[0]);
  await waitFor(() => expect(gate.getSnapshot().dialogs).toHaveLength(0));
});

it("keeps stale MCP evidence readable while refusing adoption and allowing rejection", async () => {
  preview = retrievalResourcePreview(retrievalCapture(fixtureIdentity(720), { ...retrievalQuery(), projectId: project.metadata.projectId }), false);
  render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}>
    <TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
      <ResourceDraftSession project={project}><Content/></ResourceDraftSession>
    </ExecutionTaskSession></TranslationDraftSession>
  </SessionReadProvider>);
  const user = userEvent.setup();
  await waitFor(() => expect(observed?.journal.hydration).toBe("ready"));
  await user.click(await screen.findByRole("button", { name: label("proposalOpen") }));
  await screen.findByText(label("proposalStale"));
  expect(screen.getByRole("button", { name: label("proposalAdopt") })).toBeDisabled();
  const reject = screen.getByRole("button", { name: label("proposalIgnore") });
  await waitFor(() => expect(reject).toBeEnabled());
  await user.click(reject);
  await waitFor(() => expect(decisions()).toHaveLength(1));
  expect(decisions()[0][1].request.decision.decision).toBe("ignore" satisfies ResourceDecision["decision"]);
});

function editedReceipt(request: ResourceDecision) {
  const raw: unknown = structuredClone(wire.responses.term);
  if (!validateResponseTerm(raw)) throw new Error("Synthetic term revision required");
  return { request, actionId: request.actionId, decision: request.decision,
    revision: { ...raw, revisionId: fixtureIdentity(901), source: preview.rows[0].entry.source,
      target: request.editedTarget ?? preview.rows[0].entry.target, aliases: [...preview.rows[0].entry.aliases], protected: preview.rows[0].entry.protected,
      reason: preview.rows[0].entry.reason, scopeUnitId: preview.rows[0].scopeUnitId, captureId: request.captureId,
      externalEntryId: request.entryId, previousRevisionId: request.expectedRevisionId ?? null } };
}

it.each(["en-US", "zh-CN"])("adopts an edited proposal through its original resource request (%s)", async locale => {
  await i18n.changeLanguage(locale);
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => {
    if (command === "decide_resource_entry") {
      if (!validateRequestDecision(payload.request)) throw new Error("Expected typed edited decision");
      return Promise.resolve(editedReceipt(payload.request.decision));
    }
    return original?.(command, payload);
  });
  const user = await open();
  await user.click(screen.getByRole("button", { name: label("proposalEdit") }));
  const input = screen.getByRole("textbox", { name: label("proposalEditedTarget") });
  await user.clear(input);
  expect(screen.getByRole("button", { name: label("proposalAdoptEdited") })).toBeDisabled();
  const edited = "Revised e\u0301 👩🏽‍💻";
  await user.type(input, edited);
  await user.click(screen.getByRole("button", { name: label("proposalAdoptEdited") }));
  await waitFor(() => expect(observed?.current().proposalEditDraft).toBeNull());
  expect(decisions()).toHaveLength(1);
  expect(decisions()[0][1].request.decision).toMatchObject({ captureId: preview.capture.captureId,
    entryId: preview.rows[0].entry.id, expectedRevisionId: null, decision: "adopt", editedTarget: edited });
  expect(invoke.mock.calls.filter(([command]) => command === "save_term")).toHaveLength(0);
});

it.each(["file", "conversation"] as const)("keeps newer B when edited A is acknowledged and advances only its confirmed base (%s)", async origin => {
  if (origin === "conversation") { preview = termProposalFixture({ projectId: project.metadata.projectId, conversationId: fixtureIdentity(950) }).preview; preview.rows = preview.rows.slice(0, 1); }
  let acknowledge: ((value: ReturnType<typeof editedReceipt>) => void) | undefined;
  let submitted: ResourceDecision | undefined;
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => {
    if (command === "decide_resource_entry") {
      if (!validateRequestDecision(payload.request)) throw new Error("Expected typed edited decision");
      submitted = payload.request.decision;
      return new Promise(resolve => { acknowledge = resolve; });
    }
    return original?.(command, payload);
  });
  const user = await open();
  await user.click(screen.getByRole("button", { name: label("proposalEdit") }));
  const input = screen.getByRole("textbox", { name: label("proposalEditedTarget") });
  await user.clear(input); await user.type(input, "Edited A");
  await user.click(screen.getByRole("button", { name: label("proposalAdoptEdited") }));
  await waitFor(() => expect(submitted?.editedTarget).toBe("Edited A"));
  await user.clear(input); await user.type(input, "Newer B e\u0301 👩🏽‍💻");
  if (!submitted || !acknowledge) throw new Error("Expected pending edited action");
  const receipt = editedReceipt(submitted);
  await act(async () => { acknowledge?.(receipt); });
  await waitFor(() => expect(observed?.current().pending).toBeNull());
  expect(input).toHaveValue("Newer B e\u0301 👩🏽‍💻");
  expect(observed?.current().proposalEditDraft?.expectedRevisionId).toBe(receipt.revision.revisionId);
  expect(screen.getByText(label("proposalEditNewer"))).toBeVisible();
});

it("keeps the edited target after a current-term conflict and requires explicit comparison", async () => {
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => command === "decide_resource_entry"
    ? Promise.reject({ code: "dependency-conflict", stage: "execution-adopt", outcome: "rejected", recoveryRequired: false, reason: "resource-current" })
    : original?.(command, payload));
  const user = await open();
  await user.click(screen.getByRole("button", { name: label("proposalEdit") }));
  const input = screen.getByRole("textbox", { name: label("proposalEditedTarget") });
  await user.clear(input); await user.type(input, "Retained human edit");
  await user.click(screen.getByRole("button", { name: label("proposalAdoptEdited") }));
  await waitFor(() => expect(observed?.current().pending).toBeNull());
  expect(input).toHaveValue("Retained human edit");
  expect(observed?.current().proposalEditDraft?.expectedRevisionId).toBeNull();
  expect(observed?.current().previewNeedsRefresh).toBe(true);
  expect(screen.getByRole("button", { name: label("proposalAdoptEdited") })).toBeDisabled();
  expect(decisions()).toHaveLength(1);
  const raw: unknown = structuredClone(wire.responses.term);
  if (!validateResponseTerm(raw)) throw new Error("Expected conflicting current term");
  preview.rows[0] = { ...preview.rows[0], kind: "override", current: { ...raw, revisionId: fixtureIdentity(903), target: "Changed elsewhere",
    originKind: "manual", captureId: null, externalEntryId: null } };
  const editor = screen.getByRole("region", { name: label("proposalEditTitle") });
  await user.click(within(editor).getByRole("button", { name: label("proposalReadAgain") }));
  await waitFor(() => expect(screen.getByRole("button", { name: label("proposalEditUseCurrent") })).toBeEnabled());
  expect(screen.getByRole("button", { name: label("proposalAdoptEdited") })).toBeDisabled();
  expect(within(editor).getByText("Changed elsewhere")).toBeVisible();
  await user.click(screen.getByRole("button", { name: label("proposalEditUseCurrent") }));
  expect(observed?.current().proposalEditDraft?.expectedRevisionId).toBe(fixtureIdentity(903));
  expect(input).toHaveValue("Retained human edit");
  expect(screen.getByRole("button", { name: label("proposalAdoptEdited") })).toBeEnabled();
});

it.each(["file", "conversation"] as const)("retains an edited action after a mismatched receipt and reconciles the same request without resending (%s)", async origin => {
  if (origin === "conversation") { preview = termProposalFixture({ projectId: project.metadata.projectId, conversationId: fixtureIdentity(950) }).preview; preview.rows = preview.rows.slice(0, 1); }
  let submitted: ResourceDecision | undefined;
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => {
    if (command === "decide_resource_entry") {
      if (!validateRequestDecision(payload.request)) throw new Error("Expected typed edited decision");
      const candidate = payload.request.decision;
      if (!candidate) throw new Error("Expected original decision request");
      submitted = candidate;
      const receipt = editedReceipt(candidate);
      return Promise.resolve({ ...receipt, revision: { ...receipt.revision, target: "Mismatched acknowledgement" } });
    }
    if ((command === "observe_resource_decision_action" || command === "read_resource_decision_action") && submitted) {
      return Promise.resolve({ request: submitted, receipt: editedReceipt(submitted) });
    }
    return original?.(command, payload);
  });
  const user = await open();
  await user.click(screen.getByRole("button", { name: label("proposalEdit") }));
  const input = screen.getByRole("textbox", { name: label("proposalEditedTarget") });
  await user.clear(input); await user.type(input, "Exact edited A");
  await user.click(screen.getByRole("button", { name: label("proposalAdoptEdited") }));
  await waitFor(() => expect(observed?.current().pendingRecorded).toBe(true));
  expect(observed?.current().pending?.request).toEqual(submitted);
  expect(input).toHaveValue("Exact edited A");
  expect(invoke.mock.calls.filter(([name]) => name === "observe_resource_decision_action")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([name]) => name === "read_resource_decision_action")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: label("proposalCheck") }));
  await waitFor(() => expect(observed?.current().pending).toBeNull());
  expect(observed?.current().proposalEditDraft).toBeNull();
  expect(decisions()).toHaveLength(1);
});


it("reads conversation provenance and keeps stale terminology visible while refusing adoption", async () => {
  const fixture = termProposalFixture({ projectId: project.metadata.projectId, conversationId: fixtureIdentity(950) });
  preview = fixture.preview;
  if (!preview.conversation) throw new Error("Expected original proposal provenance");
  preview.conversation.current = false;
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => command === "read_conversation_planning" ? Promise.resolve(structuredClone(fixture.run)) : original?.(command, payload));
  render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}>
    <TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
      <ResourceDraftSession project={project}><Content/></ResourceDraftSession>
    </ExecutionTaskSession></TranslationDraftSession>
  </SessionReadProvider>);
  const user = userEvent.setup();
  await waitFor(() => expect(observed?.journal.hydration).toBe("ready"));
  await user.click(await screen.findByRole("button", { name: label("proposalOpen") }));
  await screen.findByText(label("proposalStale"));
  screen.getAllByRole("button", { name: label("proposalAdopt") }).forEach(button => expect(button).toBeDisabled());
  screen.getAllByRole("button", { name: label("proposalEdit") }).forEach(button => expect(button).toBeDisabled());
  expect(screen.getByText("Hi", { exact: true })).toBeVisible();
  expect(screen.getByText(fixture.revision.origin.resultDigest)).not.toBeVisible();
  await user.click(within(screen.getByRole("region", { name: label("proposalConversation") })).getByText(label("details")));
  expect(screen.getByText(fixture.revision.origin.resultDigest)).toBeVisible();
  await user.click(screen.getByRole("button", { name: label("proposalOriginalResult") }));
  await screen.findByText(/"purpose":"term-proposal"/);
  expect(invoke.mock.calls.filter(([name]) => name === "read_conversation_planning")).toHaveLength(1);
  expect(decisions()).toHaveLength(0);
  const reject = screen.getAllByRole("button", { name: label("proposalIgnore") })[0];
  await waitFor(() => expect(reject).toBeEnabled()); await user.click(reject);
  await waitFor(() => expect(decisions()).toHaveLength(1));
  expect(decisions()[0][1].request.decision).toMatchObject({ captureId: fixture.revision.revisionId, entryId: "0", decision: "ignore" });
});

it("adopts several conversation terms sequentially through the original capture and never changes their evidence", async () => {
  preview = termProposalFixture({ projectId: project.metadata.projectId, conversationId: fixtureIdentity(950) }).preview;
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => {
    if (command === "decide_resource_entry") {
      if (!validateRequestDecision(payload.request)) throw new Error("Expected original term decision");
      const request = payload.request.decision;
      const entry = preview.rows.find(row => row.entry.id === request.entryId);
      if (!entry) throw new Error("Expected unprocessed original entry");
      preview = { ...preview, rows: preview.rows.filter(row => row !== entry) };
      return Promise.resolve({ request, actionId: request.actionId, decision: request.decision, revision: null });
    }
    return original?.(command, payload);
  });
  render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}>
    <TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
      <ResourceDraftSession project={project}><Content/></ResourceDraftSession>
    </ExecutionTaskSession></TranslationDraftSession>
  </SessionReadProvider>);
  const user = userEvent.setup();
  await waitFor(() => expect(observed?.journal.hydration).toBe("ready"));
  await user.click(await screen.findByRole("button", { name: label("proposalOpen") }));
  await waitFor(() => expect(screen.getAllByRole("button", { name: label("proposalAdopt") })[0]).toBeEnabled());
  await user.click(screen.getAllByRole("button", { name: label("proposalAdopt") })[0]);
  await waitFor(() => expect(observed?.current().pending).toBeNull());
  const previewRegion = screen.getByRole("region", { name: label("proposalTitle") });
  await user.click(within(previewRegion).getAllByRole("button", { name: label("proposalReadAgain") })[0]);
  await waitFor(() => expect(screen.getByRole("button", { name: label("proposalAdopt") })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: label("proposalAdopt") }));
  await waitFor(() => expect(observed?.current().pending).toBeNull());
  expect(decisions().map(([, payload]) => payload.request.decision.entryId)).toEqual(["0", "1"]);
  expect(decisions().every(([, payload]) => payload.request.decision.captureId === preview.capture.captureId)).toBe(true);
  expect(decisions().every(([, payload]) => Object.keys(payload.request.decision).sort().join(",") === "actionId,captureId,decision,entryId,expectedRevisionId,projectId")).toBe(true);
});

it("reopens an unknown conversation decision with B intact and refuses to replace its capture before explicit reconciliation", async () => {
  const fixture = termProposalFixture({ projectId: project.metadata.projectId, conversationId: fixtureIdentity(950) });
  preview = fixture.preview; preview.rows = preview.rows.slice(0, 1);
  let submitted: ResourceDecision | undefined;
  const original = invoke.getMockImplementation();
  invoke.mockImplementation((command, payload) => {
    if (command === "decide_resource_entry") {
      if (!validateRequestDecision(payload.request)) throw new Error("Expected original terminology decision");
      const candidate = payload.request.decision;
      if (!candidate) throw new Error("Expected original decision request");
      submitted = candidate;
      const receipt = editedReceipt(candidate);
      return Promise.resolve({ ...receipt, revision: { ...receipt.revision, target: "Unconfirmed acknowledgement" } });
    }
    if (command === "read_resource_decision_action" && submitted) return Promise.resolve({ request: submitted, receipt: editedReceipt(submitted) });
    return original?.(command, payload);
  });
  const user = await open();
  await user.click(screen.getByRole("button", { name: label("proposalEdit") }));
  const input = screen.getByRole("textbox", { name: label("proposalEditedTarget") });
  await user.clear(input); await user.type(input, "Original edited A");
  await user.click(screen.getByRole("button", { name: label("proposalAdoptEdited") }));
  await waitFor(() => expect(observed?.current().pendingUncertain).toBe(true));
  await user.clear(input); await user.type(input, "New B after uncertain A");
  await act(async () => { expect(await observed?.flush()).toBe(true); });
  const pending = structuredClone(observed?.current().pending);
  cleanup(); observed = undefined;
  render(<SessionReadProvider context={executionContext(project)} reads={reads} bridge={false}>
    <TranslationDraftSession project={project}><ExecutionTaskSession project={project}>
      <ResourceDraftSession project={project}><Content/></ResourceDraftSession>
    </ExecutionTaskSession></TranslationDraftSession>
  </SessionReadProvider>);
  await waitFor(() => expect(observedOwner().journal.hydration).toBe("ready"));
  const restored = screen.getByRole("textbox", { name: label("proposalEditedTarget") });
  expect(restored).toHaveValue("New B after uncertain A");
  expect(observedOwner().current().pending).toEqual(pending);
  expect(observedOwner().current().previewCaptureId).toBe(fixture.revision.revisionId);
  const other = termProposalFixture({ projectId: project.metadata.projectId, conversationId: fixtureIdentity(951) }).preview.capture;
  other.captureId = fixtureIdentity(952);
  if (other.origin.kind !== "conversation") throw new Error("Expected another conversation capture");
  other.origin.proposal.revisionId = other.captureId;
  expect(observedOwner().canReceiveConversation(other)).toBe(false);
  await act(async () => { const owner = observedOwner(); expect(await owner.openConversationPreview(other, owner.current(), () => true)).toBe(false); });
  expect(observedOwner().current().previewCaptureId).toBe(fixture.revision.revisionId);
  expect(invoke.mock.calls.filter(([name]) => name === "read_resource_decision_action")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: label("proposalCheck") }));
  await waitFor(() => expect(observed?.current().pending).toBeNull());
  expect(restored).toHaveValue("New B after uncertain A");
  expect(observedOwner().current().proposalEditDraft?.expectedRevisionId).toBe(fixtureIdentity(901));
  expect(decisions()).toHaveLength(1);
});
