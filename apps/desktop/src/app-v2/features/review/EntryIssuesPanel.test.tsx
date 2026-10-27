import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationReadProvider } from "../../../ApplicationReadProvider";
import type { AiSemanticReviewView } from "../../../aiSemanticReviewCommands";
import { ExecutionTaskProvider, type MutationCoordinator } from "../../../ExecutionTaskSession";
import { executionContext } from "../../../executionCommands";
import { i18n } from "../../../i18n";
import type { ProjectView } from "../../../projectCommands";
import { ReviewDraftProvider, reviewDraftKey, useReviewDraftSession } from "../../../ReviewDraftSession";
import type { AdvisoryFinding, ReviewFindingDecision, ReviewFindingView, ReviewFindingWrite, ReviewTarget, Waiver, WaiverWrite } from "../../../reviewCommands";
import { reviewFindingsKey } from "../../../reviewQueries";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import { reviewCheckFixture, reviewFindingViewFixture, reviewTargetFixture } from "../../../testSupport/reviewFixture";
import { coreRuleKeyFixture, pluginRuleKeyFixture } from "../../../testSupport/textReviewFixture";
import { semanticDiagnosticFixture } from "../../../testSupport/semanticDiagnosticFixture";
import { WorkbenchCommands } from "../../../workbenchCommands";
import { InteractionGate } from "../../workspace/interactionGate";
import { TranslationDrafts } from "../editor/translationDrafts";
import EntryIssuesPanel from "./EntryIssuesPanel";
import type { ReviewOwner } from "./reviewTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const project: ProjectView = { sessionToken: "entry-issues", locator: "/synthetic/issues", reconciliationState: "settled",
  metadata: { projectId: fixtureIdentity(9950), displayName: "Synthetic issues", metadataRevision: "1", sourceLocale: "en", targetLocales: ["zh-CN"] } };
const context = executionContext(project), calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
const retained: { reads: SessionReads; drafts: TranslationDrafts; gate: InteractionGate }[] = [];
const w = (key: "entryIssuesGrantWaiver" | "entryIssuesRevokeWaiver" | "entryIssuesReject" | "entryIssuesRestore" | "entryIssuesRepair" | "entryIssuesUnknown") => i18n.t(`workbenchV2.${key}`);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixtures() {
  const target = reviewTargetFixture({ basis: "d".repeat(64), translationText: "" });
  const mandatory = { issueId: "a".repeat(64), rule: "terminology", code: "term", detail: "Required terminology é 👩🏽‍💻", severity: "warning", waivable: true };
  const advisory: AdvisoryFinding = { purpose: "qa", runId: fixtureIdentity(9951), aiOrigin: null, decision: null,
    finding: { issueId: "b".repeat(64), rule: "plugin:synthetic.advice", code: "wording", detail: "Advice é 👩🏽‍💻", severity: "warning", waivable: false },
    requirement: { key: pluginRuleKeyFixture("synthetic.advice"), inputDigest: "1".repeat(64), scopeDigest: "2".repeat(64), targets: [target.unitId], mandatory: false, waivable: false, notApplicable: null } };
  target.currentCheck = reviewCheckFixture(target, fixtureIdentity(9952), "completed", { runId: advisory.runId, rules: [
    { rule: mandatory.rule, key: coreRuleKeyFixture("terminology"), mandatory: true, status: "findings", reason: null, findings: [mandatory] },
    { rule: advisory.finding.rule, key: advisory.requirement.key, mandatory: false, status: "findings", reason: null, findings: [advisory.finding] },
  ] });
  return { target, mandatory, advisory, page: { ...reviewFindingViewFixture(target), findings: [advisory] } };
}
function findingReceipt(request: ReviewFindingWrite, target: ReviewTarget, item: AdvisoryFinding): ReviewFindingDecision {
  return { decisionId: fixtureIdentity(9954), request: { ...request, expectedDecisionId: request.expectedDecisionId ?? null },
    requirement: item.requirement, finding: item.finding, purpose: item.purpose, aiOrigin: item.aiOrigin, basisEvidence: target.basisEvidence, createdAt: "2026-10-28T00:00:00Z" };
}
beforeEach(async () => { await i18n.changeLanguage("en-US"); invoke.mockReset(); });
afterEach(() => { cleanup(); retained.splice(0).forEach(({ reads, drafts, gate }) => { reads.retire(); drafts.retire(); gate.dispose(); }); });
async function harness(target: ReviewTarget, initial: ReviewFindingView, semantic: AiSemanticReviewView | null = null) {
  const reads = new SessionReads(context), gate = new InteractionGate(), commands = new WorkbenchCommands(), onEdit = vi.fn();
  gate.setVisibleOwner("entries");
  const drafts = new TranslationDrafts({ context, reads, ports: { list: async () => ({ items: [], next: null }) } });
  await drafts.initialize(); retained.push({ reads, drafts, gate });
  const mutations: MutationCoordinator = { reserveMutation: () => drafts.reserveMutation("retained-for-navigation"), releaseMutation: token => drafts.releaseMutation(token) };
  const projection = { page: initial }; let nextIdentity = 9970;
  invoke.mockImplementation(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === "read_review_findings") return structuredClone(projection.page);
    if (command === "read_ai_semantic_review") return { attemptId: args.request.attemptId, view: structuredClone(semantic) };
    if (command === "create_execution_identity") return fixtureIdentity(nextIdentity++);
    if (command === "read_review_finding_action" || command === "read_review_waiver_action") return null;
    throw new Error(command);
  });
  let current: ReviewOwner | null = null;
  const key = ["synthetic-issue-details", target.unitId, target.locale] as const;
  const seed = (value: ReviewTarget) => {
    reads.client.setQueryData(reads.key(key), { current: value });
    return { key, data: reads.client.getQueryData(reads.key(key)) };
  };
  let presentation = { target, visible: true, read: seed(target) };
  function Content() {
    const owner = useReviewDraftSession();
    useLayoutEffect(() => { current = owner; });
    return <EntryIssuesPanel {...presentation} project={project} owner={owner} drafts={drafts} commands={commands} gate={gate}
      viewId="entries" disabled={false} onEdit={onEdit}/>;
  }
  const ui = () => <ApplicationReadProvider><SessionReadProvider context={context} reads={reads} bridge={false}>
    <ExecutionTaskProvider project={project} mutations={mutations}><ReviewDraftProvider project={project} mutations={mutations}><Content/></ReviewDraftProvider></ExecutionTaskProvider>
  </SessionReadProvider></ApplicationReadProvider>;
  const view = render(ui());
  const owner = () => { if (!current) throw new Error("Review owner not mounted"); return current; };
  await waitFor(() => expect(calls("read_review_findings")).toHaveLength(1));
  await act(async () => { owner().setLocale(target.locale); owner().setSelected(target); });
  async function audit(reason = "Reason A", actor = "Reviewer A") {
    await act(async () => { owner().setActor(actor); owner().editReason(target, reason); });
  }
  function show(value: ReviewTarget, visible = true) { presentation = { target: value, visible, read: seed(value) }; view.rerender(ui()); }
  return { reads, drafts, gate, commands, owner, audit, view, key, projection, show, onEdit };
}

it("mounts read-only, keeps mandatory QA separate, and grants or revokes only its exact current waiver", async () => {
  const f = fixtures(), h = await harness(f.target, f.page);
  await screen.findByText(f.advisory.finding.detail);
  expect(calls("create_execution_identity")).toHaveLength(0);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: w("entryIssuesGrantWaiver") })).toBeDisabled();
  await h.audit();
  const saved: { current: Waiver | null } = { current: null };
  const native = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command: string, args) => {
    if (command !== "waive_review_issue") return native(command, args);
    const request = args.request.waiver as WaiverWrite;
    saved.current = { waiverId: fixtureIdentity(9955), actionId: request.actionId, unitId: request.unitId, locale: request.locale,
      basis: request.expectedBasis, issueId: request.issueId, grant: request.grant, previousWaiverId: request.expectedWaiverId ?? null,
      actor: request.actor, reason: request.reason, policyVersion: "synthetic-policy-1", createdAt: "2026-10-28T00:00:00Z" };
    return structuredClone(saved.current);
  });
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesGrantWaiver") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("entryIssuesGrantWaiver") }));
  await waitFor(() => expect(calls("waive_review_issue")).toHaveLength(1));
  await waitFor(() => expect(h.owner().current().pending).toBeNull());
  expect(calls("waive_review_issue")[0][1].request.waiver).toMatchObject({ issueId: f.mandatory.issueId, grant: true, expectedWaiverId: null });
  const granted = saved.current; if (!granted) throw new Error("Waiver was not saved");
  act(() => h.show({ ...f.target, currentWaivers: [granted] })); await h.audit("Revoke reason");
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesRevokeWaiver") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("entryIssuesRevokeWaiver") }));
  await waitFor(() => expect(calls("waive_review_issue")).toHaveLength(2));
  expect(calls("waive_review_issue")[1][1].request.waiver).toMatchObject({ issueId: f.mandatory.issueId, grant: false, expectedWaiverId: fixtureIdentity(9955) });
  expect(calls("write_review_finding")).toHaveLength(0); expect(h.onEdit).not.toHaveBeenCalled();
});

it("uses advisory decisions and their previous IDs without changing mandatory checks or automatically opening repair", async () => {
  const f = fixtures(), h = await harness(f.target, f.page), native = invoke.getMockImplementation()!;
  let next = 9960;
  invoke.mockImplementation(async (command: string, args) => {
    if (command !== "write_review_finding") return native(command, args);
    const receipt = { ...findingReceipt(args.request.finding as ReviewFindingWrite, f.target, f.advisory), decisionId: fixtureIdentity(next++) };
    h.projection.page = { ...h.projection.page, findings: [{ ...f.advisory, decision: receipt }], history: [receipt, ...h.projection.page.history] };
    return receipt;
  });
  await h.audit();
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesReject") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("entryIssuesReject") }));
  await screen.findByRole("button", { name: w("entryIssuesRestore") }); await h.audit("Restore reason");
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesRestore") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("entryIssuesRestore") }));
  await waitFor(() => expect(calls("write_review_finding")).toHaveLength(2));
  await screen.findByRole("button", { name: w("entryIssuesReject") }); await h.audit("Please fix the wording");
  await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesRepair") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("entryIssuesRepair") }));
  await waitFor(() => expect(calls("write_review_finding")).toHaveLength(3));
  expect(calls("write_review_finding").map(([, args]) => [args.request.finding.disposition, args.request.finding.expectedDecisionId]))
    .toEqual([["rejected", null], ["restored", fixtureIdentity(9960)], ["repair-requested", fixtureIdentity(9961)]]);
  expect(f.target.currentCheck?.rules[0].status).toBe("findings"); expect(calls("waive_review_issue")).toHaveLength(0);
  expect(h.onEdit).not.toHaveBeenCalled();
});

it("rejects an exact findings query replaced and restored while identity is pending", async () => {
  const f = fixtures(), h = await harness(f.target, f.page), identity = deferred<string>(), native = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args) => command === "create_execution_identity" ? identity.promise : native(command, args));
  await h.audit(); await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesReject") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("entryIssuesReject") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  await act(async () => {
    h.reads.client.setQueryData(h.reads.key(reviewFindingsKey(f.target.unitId, f.target.locale)), structuredClone(f.page));
    identity.resolve(fixtureIdentity(9953));
  });
  await waitFor(() => expect(h.drafts.getSnapshot().mutationReserved).toBe(false));
  expect(calls("write_review_finding")).toHaveLength(0); expect(h.owner().current().drafts[reviewDraftKey(f.target)]).toBe("Reason A");
});

it("keeps audit B and the original unknown finding request for the shared owner to recover", async () => {
  const f = fixtures(), h = await harness(f.target, f.page), identity = deferred<string>(), native = invoke.getMockImplementation()!;
  let original: ReviewFindingDecision | null = null;
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "create_execution_identity") return identity.promise;
    if (command === "write_review_finding") { original = findingReceipt(args.request.finding as ReviewFindingWrite, f.target, f.advisory); throw new Error("Lost finding ACK"); }
    return native(command, args);
  });
  await h.audit(); await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesReject") })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: w("entryIssuesReject") }));
  await waitFor(() => expect(calls("create_execution_identity")).toHaveLength(1));
  await h.audit("Reason B é 👩🏽‍💻", "Reviewer B");
  await act(async () => { identity.resolve(fixtureIdentity(9953)); });
  await screen.findByText(w("entryIssuesUnknown"));
  const pending = h.owner().current().pending;
  expect(pending?.kind).toBe("finding"); expect(pending?.request).toMatchObject({ actor: "Reviewer A", reason: "Reason A", expectedDecisionId: null });
  expect(h.drafts.getSnapshot().mutationReserved).toBe(true);
  act(() => h.show(f.target, false));
  invoke.mockImplementation((command: string, args) => command === "read_review_finding_action" ? Promise.resolve(original) : native(command, args));
  await act(async () => { await h.owner().checkPending(); });
  expect(h.owner().current().pending).toBeNull(); expect(h.owner().current().actor).toBe("Reviewer B");
  expect(h.owner().current().drafts[reviewDraftKey(f.target)]).toBe("Reason B é 👩🏽‍💻");
  expect(calls("write_review_finding")).toHaveLength(1); expect(calls("create_execution_identity")).toHaveLength(1);
});

it("reads the original AI run separately and never offers its suggestion as a mandatory waiver", async () => {
  const f = semanticDiagnosticFixture(), h = await harness(f.target, f.findings, f.view);
  const suggestion = await screen.findByText(f.finding.detail);
  await h.audit(); await waitFor(() => expect(screen.getByRole("button", { name: w("entryIssuesReject") })).toBeEnabled());
  expect(calls("read_ai_semantic_review")[0][1].request.attemptId).toBe(f.view.detail.attemptId);
  const article = suggestion.closest("article"); if (!article) throw new Error("Suggestion card not found");
  expect(within(article).queryByRole("button", { name: w("entryIssuesGrantWaiver") })).not.toBeInTheDocument();
  expect(calls("create_execution_identity")).toHaveLength(0);
  expect(invoke.mock.calls.every(([command]) => command === "read_review_findings" || command === "read_ai_semantic_review")).toBe(true);
});
