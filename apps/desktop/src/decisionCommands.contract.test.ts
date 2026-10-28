import { beforeEach, expect, it, vi } from "vitest";
import fixture from "../test/fixtures/decisionCommands.contract.json";
import { decisionCommands, type DecisionPage, type DecisionPageRequest } from "./decisionCommands";
import { validateRequestPage, validateResponsePage } from "./generated/decisions.validators";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());

function knowledgeGroup() {
  const input = request(), page = response();
  const proposal = { projectId: page.projectId, conversationId: "00000000-0000-4000-8000-000000000051",
    proposalId: "00000000-0000-4000-8000-000000000052", revisionId: "00000000-0000-4000-8000-000000000053" };
  input.query = { locale: "zh-CN", sources: ["resource-proposal"] };
  page.query = { locale: "zh-CN", sources: ["resource-proposal"] };
  page.items = [{ decisionId: `resource-proposal:knowledge:${proposal.revisionId}:0:zh-CN`, source: "resource-proposal",
    state: "pending", locale: "zh-CN", targets: [{ kind: "conversation", conversationId: proposal.conversationId },
      { kind: "conversation-proposal", conversationId: proposal.conversationId, proposalId: proposal.proposalId }],
    targetsComplete: true, basis: "a".repeat(64), sourceActionId: null, evidence: null,
    action: { kind: "review-knowledge-proposal", proposal, entryIndex: 0 } }];
  page.knownCount = 1; page.total = 1; page.next = null; page.localActions = null;
  page.executionActivity = []; page.deliveryActivity = [];
  page.coverage = [{ source: "resource-proposal", state: "complete", knownCount: 1, total: 1, reason: null, errorCode: null }];
  return { input, page };
}

it("keeps an exact knowledge proposal entry in the original resource inbox", async () => {
  const { input, page } = knowledgeGroup();
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(input)).resolves.toEqual(page);
});

it.each(["foreign-project", "wrong-proposal", "capture-target", "missing-conversation", "invalid-index"])("rejects a misbound knowledge inbox entry: %s", async kind => {
  const { input, page } = knowledgeGroup(), item = page.items[0]!;
  if (item.action.kind !== "review-knowledge-proposal") throw new Error("Expected knowledge fixture");
  if (kind === "foreign-project") item.action.proposal.projectId = item.action.proposal.conversationId;
  if (kind === "wrong-proposal") item.action.proposal.proposalId = item.action.proposal.revisionId;
  if (kind === "capture-target") item.targets.push({ kind: "resource", captureId: item.action.proposal.proposalId, entryId: "0" });
  if (kind === "missing-conversation") item.targets = item.targets.filter(target => target.kind !== "conversation");
  if (kind === "invalid-index") item.action.entryIndex = 16;
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
});

function request(): DecisionPageRequest {
  const value: unknown = structuredClone(fixture.request);
  if (!validateRequestPage(value)) throw new Error("Invalid request fixture");
  return value;
}
function response(): DecisionPage {
  const value: unknown = structuredClone(fixture.response);
  if (!validateResponsePage(value)) throw new Error("Invalid response fixture");
  return value;
}

function originalGroups() {
  const input = request();
  input.query = { locale: null, sources: ["agent-question", "source-mapping"] };
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const page: DecisionPage = { ...response(), query: { locale: null, sources: ["agent-question", "source-mapping"] },
    items: [
      { decisionId: `agent-question:proposal:${uuid(50)}`, source: "agent-question", state: "pending", locale: null,
        targets: [{ kind: "conversation-proposal", conversationId: uuid(51), proposalId: uuid(50) }], targetsComplete: true,
        basis: "a".repeat(64), sourceActionId: null, evidence: { kind: "proposal-questions", questionCount: 2 },
        action: { kind: "clarify-conversation-proposal", conversationId: uuid(51), proposalId: uuid(50), revisionId: uuid(52) } },
      { decisionId: `source-mapping:result:${uuid(53)}`, source: "source-mapping", state: "stale", locale: null,
        targets: [{ kind: "source-result", attemptId: uuid(54), resultId: uuid(53) }], targetsComplete: true,
        basis: "b".repeat(64), sourceActionId: null, evidence: { kind: "source-comparison", ambiguousCount: 1, renameCandidateCount: 2 },
        action: { kind: "compare-source-mapping", attemptId: uuid(54), resultId: uuid(53), previousSnapshotId: uuid(55), expectedContentRevision: "2" } },
    ], knownCount: 2, total: null, next: null, localActions: null, executionActivity: [], deliveryActivity: [],
    coverage: [
      { source: "agent-question", state: "partial", knownCount: 1, total: null, reason: "source-not-implemented", errorCode: null },
      { source: "source-mapping", state: "complete", knownCount: 1, total: 1, reason: null, errorCode: null },
    ] };
  return { input, page };
}

it("accepts original proposal and pending source groups without pretending member questions are complete", async () => {
  const { input, page } = originalGroups();
  expect(validateResponsePage(page)).toBe(true);
  invoke.mockResolvedValueOnce(page);
  expect(await decisionCommands.page(input)).toEqual(page);
});

it.each(["wrong-proposal", "wrong-result", "missing-evidence", "empty-group", "fake-entry", "false-language"])("rejects an invalid original group: %s", async kind => {
  const { input, page } = originalGroups(), question = page.items[0]!, source = page.items[1]!;
  if (kind === "wrong-proposal" && question.action.kind === "clarify-conversation-proposal") question.action.proposalId = source.action.kind === "compare-source-mapping" ? source.action.resultId : "";
  if (kind === "wrong-result" && source.action.kind === "compare-source-mapping") source.action.resultId = source.action.attemptId;
  if (kind === "missing-evidence") question.evidence = null;
  if (kind === "empty-group") source.evidence = { kind: "source-comparison", ambiguousCount: 0, renameCandidateCount: 0 };
  if (kind === "fake-entry") source.targets.push({ kind: "entry", unitId: page.projectId });
  if (kind === "false-language") question.locale = "zh-CN";
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
});

it("keeps plan and source targets and unknown totals for unavailable sources", async () => {
  const input = request(), page = response();
  invoke.mockResolvedValueOnce(page);
  expect(await decisionCommands.page(input)).toEqual(page);
  expect(invoke).toHaveBeenCalledWith("read_decision_page", { request: input });
  expect(page.total).toBeNull();
  expect(page.items.map(item => item.targets[0]?.kind)).toEqual(["plan", "source-occurrence"]);
});

it.each(["false-total", "missing-source", "false-source-total", "wrong-project", "wrong-query", "reordered", "wrong-target", "false-continuation", "extra-page"])("rejects %s without presenting an empty inbox", async kind => {
  const page = response();
  if (kind === "false-total") page.total = 0;
  if (kind === "missing-source") page.coverage.pop();
  if (kind === "false-source-total") page.coverage.find(source => source.state === "unavailable")!.total = 0;
  if (kind === "wrong-project") page.projectId = "00000000-0000-4000-8000-000000000099";
  if (kind === "wrong-query") page.query.locale = "ja";
  if (kind === "reordered") page.items.reverse();
  if (kind === "wrong-target") page.items[1]!.targets = [{ kind: "project" }];
  if (kind === "false-continuation") page.next = { basis: "d".repeat(64), afterId: page.items.at(-1)!.decisionId };
  if (kind === "extra-page") page.next = { basis: page.basis, afterId: page.items.at(-1)!.decisionId };
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(request())).rejects.toThrow("Invalid IPC response");
});

it("keeps an exact cursor basis and excludes rows before its boundary", async () => {
  const input = request(), page = response();
  input.cursor = { basis: page.basis, afterId: page.items[0]!.decisionId };
  page.items.shift();
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).items).toHaveLength(1);
  const changed = response(); changed.basis = "d".repeat(64); changed.items.shift();
  invoke.mockResolvedValueOnce(changed);
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
});

it("accepts an exact zero only for a completely read selected source", async () => {
  const input = request(), page = response();
  input.query.sources = ["execution-unknown"];
  page.query = { locale: input.query.locale ?? null, sources: [...input.query.sources] };
  page.coverage = [{ source: "execution-unknown", state: "complete", knownCount: 0, total: 0, reason: null, errorCode: null }];
  page.items = []; page.knownCount = 0; page.total = 0;
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).total).toBe(0);
});

it("captures nested filters before an awaiting caller changes them", async () => {
  const input = request(), captured = structuredClone(input);
  let finish!: (page: DecisionPage) => void;
  invoke.mockImplementationOnce(() => new Promise<DecisionPage>(resolve => { finish = resolve; }));
  const reading = decisionCommands.page(input);
  input.query.locale = "ja"; input.query.sources.push("human-review");
  finish(response());
  expect(await reading).toEqual(response());
  expect(invoke).toHaveBeenCalledWith("read_decision_page", { request: captured });
});

function localFixture() {
  const input = request(), page = response();
  input.query.sources = ["local-action-recovery"]; input.activity = [];
  const action = { key: { kind: "translation" as const, unitId: "00000000-0000-4000-8000-000000000002", locale: "zh-CN" },
    slot: "primary" as const, actionId: "00000000-0000-4000-8000-000000000003", submittedSeq: "1" };
  const reference = { action, requestKind: "save" as const };
  page.query = { locale: null, sources: ["local-action-recovery"] };
  page.knownCount = 1; page.total = 1; page.executionActivity = [];
  page.coverage = [{ source: "local-action-recovery", state: "complete", knownCount: 1, total: 1, reason: null, errorCode: null }];
  page.localActions = { journalBasis: "d".repeat(64), journalComplete: true, activity: [], observations: [{ reference,
    headRevision: "1", writerId: "00000000-0000-4000-8000-000000000004", outcome: "receipt-absent", errorCode: null }] };
  page.items = [{ decisionId: `local-action-recovery:${action.actionId}`, source: "local-action-recovery", state: "awaiting-recheck", locale: "zh-CN",
    targets: [{ kind: "entry", unitId: action.key.unitId }], targetsComplete: true, basis: "e".repeat(64), sourceActionId: action.actionId,
    action: { kind: "inspect-local-request", reference }, evidence: { kind: "local-request", outcome: "receipt-absent", errorCode: null } }];
  return { input, page, action };
}

it("binds a local request to its original slot, source observation and typed target", async () => {
  const { input, page } = localFixture();
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).items[0]?.source).toBe("local-action-recovery");
});

it.each(["recorded", "in-flight"] as const)("excludes %s local requests while retaining their observed identity", async outcome => {
  const { input, page, action } = localFixture();
  const activity = outcome === "in-flight" ? [{ ownerId: "00000000-0000-4000-8000-000000000004", revision: "1", actions: [action] }] : [];
  input.activity = activity; page.localActions!.activity = activity;
  page.localActions!.observations[0]!.outcome = outcome;
  page.items = []; page.knownCount = 0; page.total = 0; page.coverage[0]!.knownCount = 0; page.coverage[0]!.total = 0;
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).items).toEqual([]);
});

it.each(["wrong-activity", "recorded-still-counted", "missing-lifecycle", "wrong-slot", "incomplete-journal"])("rejects %s local recovery projections", async kind => {
  const { input, page } = localFixture();
  if (kind === "wrong-activity") page.localActions!.activity = [{ ownerId: "00000000-0000-4000-8000-000000000004", revision: "2", actions: [] }];
  if (kind === "recorded-still-counted") page.localActions!.observations[0]!.outcome = "recorded";
  if (kind === "missing-lifecycle") { input.activity = null; page.localActions!.activity = null; }
  if (kind === "wrong-slot") page.localActions!.observations[0]!.reference = { ...page.localActions!.observations[0]!.reference,
    action: { ...page.localActions!.observations[0]!.reference.action, slot: "revocation" } };
  if (kind === "incomplete-journal") page.localActions!.journalComplete = false;
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
});

type DecisionRow = DecisionPage["items"][number];
type DeliveryEvidence = Extract<NonNullable<DecisionRow["evidence"]>, { kind: "delivery-outcome" }>;
type DeliveryActivity = DecisionPage["deliveryActivity"][number];

function deliveryFixture() {
  const input = request(), page = response();
  const action: Extract<DecisionRow["action"], { kind: "inspect-delivery-outcome" }> = {
    kind: "inspect-delivery-outcome", releaseId: "00000000-0000-4000-8000-000000000005",
    deliveryId: "00000000-0000-4000-8000-000000000006", actionId: "00000000-0000-4000-8000-000000000007",
  };
  const target: Extract<DecisionRow["targets"][number], { kind: "delivery" }> = {
    kind: "delivery", releaseId: action.releaseId, deliveryId: action.deliveryId,
  };
  const evidence: DeliveryEvidence = { kind: "delivery-outcome", state: "pending",
    locales: ["fr-FR", "zh-CN"], fileCount: 3, unknownFileCount: 0 };
  const item: DecisionRow = { decisionId: `delivery-unknown:${action.deliveryId}`, source: "delivery-unknown",
    state: "awaiting-recheck", locale: null, targets: [target], targetsComplete: true,
    basis: "e".repeat(64), sourceActionId: action.actionId, action, evidence };
  input.query = { locale: null, sources: ["delivery-unknown"] }; input.activity = [];
  page.query = { locale: input.query.locale ?? null, sources: [...input.query.sources] };
  page.items = [item]; page.knownCount = 1; page.total = 1; page.next = null;
  page.coverage = [{ source: "delivery-unknown", state: "complete", knownCount: 1, total: 1, reason: null, errorCode: null }];
  page.executionActivity = []; page.deliveryActivity = []; page.localActions = null;
  const job = (kind: DeliveryActivity["kind"], actionId: string | null): DeliveryActivity => ({
    jobId: "00000000-0000-4000-8000-000000000008", kind, releaseId: action.releaseId, actionId,
  });
  return { input, page, item, action, target, evidence, job };
}

it("keeps the original typed delivery, release, action and complete language set", async () => {
  const { input, page, action, evidence } = deliveryFixture();
  input.query.locale = "fr-FR"; page.query.locale = "fr-FR";
  invoke.mockResolvedValueOnce(page);
  const found = await decisionCommands.page(input);
  expect(found.items[0]?.decisionId).toBe(`delivery-unknown:${action.deliveryId}`);
  expect(found.items[0]?.locale).toBeNull();
  expect(found.items[0]?.evidence).toEqual(evidence);
  expect(found.items[0]?.targets).toEqual([{ kind: "delivery", releaseId: action.releaseId, deliveryId: action.deliveryId }]);
});

it("uses the original single file language when a delivery has one language", async () => {
  const { input, page, item, evidence } = deliveryFixture();
  evidence.locales = ["zh-CN"]; item.locale = "zh-CN";
  input.query.locale = "zh-CN"; page.query.locale = "zh-CN";
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).items[0]?.locale).toBe("zh-CN");
});

it.each(["wrong-decision-id", "wrong-release", "wrong-delivery", "wrong-source-action", "project-target", "incomplete-targets",
  "wrong-locale-filter", "fabricated-single-locale", "duplicate-locales", "empty-files", "unknown-without-unknown-files",
  "pending-with-unknown-files", "too-many-unknown-files", "final-state", "wrong-state", "missing-evidence"])("rejects %s delivery outcome projections", async kind => {
  const { input, page, item, target, evidence } = deliveryFixture();
  const other = "00000000-0000-4000-8000-000000000099";
  if (kind === "wrong-decision-id") item.decisionId = `delivery-unknown:${other}`;
  if (kind === "wrong-release") target.releaseId = other;
  if (kind === "wrong-delivery") target.deliveryId = other;
  if (kind === "wrong-source-action") item.sourceActionId = other;
  if (kind === "project-target") item.targets = [{ kind: "project" }];
  if (kind === "incomplete-targets") item.targetsComplete = false;
  if (kind === "wrong-locale-filter") { input.query.locale = "ja"; page.query.locale = "ja"; }
  if (kind === "fabricated-single-locale") item.locale = "fr-FR";
  if (kind === "duplicate-locales") evidence.locales = ["zh-CN", "zh-CN"];
  if (kind === "empty-files") evidence.fileCount = 0;
  if (kind === "unknown-without-unknown-files") evidence.state = "unknown";
  if (kind === "pending-with-unknown-files") evidence.unknownFileCount = 1;
  if (kind === "too-many-unknown-files") { evidence.state = "unknown"; evidence.unknownFileCount = 4; }
  if (kind === "final-state") evidence.state = "failed";
  if (kind === "wrong-state") item.state = "pending";
  if (kind === "missing-evidence") item.evidence = null;
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
});

it.each(["preview", "reconcile", "different-action", "different-release"] as const)("retains pending delivery checks alongside %s activity", async kind => {
  const { input, page, action, job } = deliveryFixture();
  const active = job(kind === "preview" ? "preview" : kind === "reconcile" ? "reconcile" : "export",
    kind === "preview" ? null : action.actionId);
  if (kind === "different-action") active.actionId = "00000000-0000-4000-8000-000000000099";
  if (kind === "different-release") active.releaseId = "00000000-0000-4000-8000-000000000099";
  page.deliveryActivity = [active];
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).items).toHaveLength(1);
});

it("excludes only a pending delivery owned by the exact active export", async () => {
  const { input, page, action, job } = deliveryFixture();
  page.deliveryActivity = [job("export", action.actionId)];
  invoke.mockResolvedValueOnce(structuredClone(page));
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
  page.items = []; page.knownCount = 0; page.total = 0; page.coverage[0]!.knownCount = 0; page.coverage[0]!.total = 0;
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).deliveryActivity).toEqual(page.deliveryActivity);
});

it.each(["export", "reconcile"] as const)("retains a persisted unknown even while its exact %s is active", async kind => {
  const { input, page, action, evidence, job } = deliveryFixture();
  evidence.state = "unknown"; evidence.unknownFileCount = 1;
  page.deliveryActivity = [job(kind, action.actionId)];
  invoke.mockResolvedValueOnce(page);
  expect((await decisionCommands.page(input)).items).toHaveLength(1);
});

it.each(["preview-with-action", "export-without-action", "reconcile-without-action", "duplicate-job", "unselected-source"])("rejects %s delivery activity", async kind => {
  const { input, page, action, job } = deliveryFixture();
  page.deliveryActivity = [job("reconcile", action.actionId)];
  if (kind === "preview-with-action") page.deliveryActivity[0]!.kind = "preview";
  if (kind === "export-without-action") { page.deliveryActivity[0]!.kind = "export"; page.deliveryActivity[0]!.actionId = null; }
  if (kind === "reconcile-without-action") page.deliveryActivity[0]!.actionId = null;
  if (kind === "duplicate-job") page.deliveryActivity.push(structuredClone(page.deliveryActivity[0]!));
  if (kind === "unselected-source") {
    input.query.sources = ["execution-unknown"]; page.query.sources = ["execution-unknown"];
    page.items = []; page.knownCount = 0; page.total = 0;
    page.coverage = [{ source: "execution-unknown", state: "complete", knownCount: 0, total: 0, reason: null, errorCode: null }];
  }
  invoke.mockResolvedValueOnce(page);
  await expect(decisionCommands.page(input)).rejects.toThrow("Invalid IPC response");
});
