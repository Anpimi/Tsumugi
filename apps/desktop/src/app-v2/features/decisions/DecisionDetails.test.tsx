import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import wire from "../../../../test/fixtures/sourceCommands.contract.json";
import type { DecisionItem } from "../../../decisionCommands";
import { validateResponseComparison } from "../../../generated/source.validators";
import { i18n } from "../../../i18n";
import { SessionReadProvider } from "../../../SessionReadProvider";
import { SessionReads } from "../../../sessionReads";
import { sourceCommands } from "../../../sourceCommands";
import DecisionDetails from "./DecisionDetails";
import { decisionTargetKey } from "./decisionTargetReads";
import { conversationCommands } from "../../../conversationCommands";
import { resourceCommands } from "../../../resourceCommands";
import { knowledgeProposalFixture } from "../../../testSupport/conversationProposalFixture";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import executionWire from "../../../../test/fixtures/executionCommands.contract.json";
import { executionCommands } from "../../../executionCommands";
import { validateResponseAttempt } from "../../../generated/execution.validators";

let reads: SessionReads | undefined;
afterEach(() => { cleanup(); reads?.retire(); vi.restoreAllMocks(); });

it("keeps an unlinked original execution read-only and does not retry or clear its unknown outcome", async () => {
  await i18n.changeLanguage("en-US");
  const raw: unknown = structuredClone(executionWire.detail);
  if (!validateResponseAttempt(raw) || !raw.items[0]) throw new Error("Expected original attempt");
  const original = raw.items[0]; original.resultId = null;
  const context = executionWire.session;
  vi.spyOn(executionCommands, "attempt").mockResolvedValue(raw);
  const recover = vi.spyOn(executionCommands, "recover").mockRejectedValue(new Error("Opening a decision cannot retry execution"));
  const item: DecisionItem = { decisionId: "original-unknown-execution", source: "execution-unknown", state: "awaiting-recheck", basis: "c".repeat(64),
    locale: original.scope.locale, targets: [{ kind: "project" }], targetsComplete: true, evidence: null, sourceActionId: null,
    action: { kind: "inspect-execution", taskId: raw.taskId, attemptId: raw.attemptId, itemId: original.status.itemId } };
  const navigate = vi.fn(async () => false);
  reads = new SessionReads(context);
  render(<SessionReadProvider context={context} reads={reads} bridge={false}><DecisionDetails item={item} disabled={false} current={() => true}
    onBack={vi.fn()} onOpenEntry={vi.fn(async () => false)} onNavigate={navigate}/></SessionReadProvider>);
  const open = await screen.findByRole("button", { name: i18n.t("workbenchV2.decisionDetailsOpenExecution") });
  await waitFor(() => expect(open).toBeEnabled()); await userEvent.setup().click(open);
  expect(await screen.findByText(i18n.t("workbenchV2.decisionDetailsExecutionUnlinked"))).toBeVisible();
  expect(screen.getByRole("region", { name: i18n.t("workbenchV2.decisionDetailsContent") })).toHaveFocus();
  expect(navigate).toHaveBeenCalledOnce(); expect(recover).not.toHaveBeenCalled(); expect(original.status.execution).toBe("unknown");
});

it.each(["en-US", "zh-CN"])("reads the exact knowledge item without an external glossary capture and opens its review destination (%s)", async locale => {
  await i18n.changeLanguage(locale);
  const fixture = knowledgeProposalFixture({ projectId: wire.session.projectId, conversationId: fixtureIdentity(60220) });
  const reference = { projectId: fixture.revision.projectId, conversationId: fixture.revision.conversationId, proposalId: fixture.revision.proposalId, revisionId: fixture.revision.revisionId };
  const context = { projectId: reference.projectId, sessionToken: "synthetic-knowledge-details" };
  const proposal = vi.spyOn(conversationCommands, "readProposal").mockResolvedValue(fixture.revision);
  vi.spyOn(conversationCommands, "readKnowledgeDecision").mockResolvedValue(null);
  const external = vi.spyOn(resourceCommands, "preview").mockRejectedValue(new Error("An external glossary must not be read for knowledge proposals"));
  const item: DecisionItem = { decisionId: "resource-proposal:synthetic-knowledge", source: "resource-proposal", state: "pending", basis: "c".repeat(64), locale: "zh-CN", evidence: null, sourceActionId: null,
    targets: [{ kind: "conversation-proposal", conversationId: reference.conversationId, proposalId: reference.proposalId }], targetsComplete: true,
    action: { kind: "review-knowledge-proposal", proposal: reference, entryIndex: 0 } };
  const navigate = vi.fn(async (_item: DecisionItem, _current: () => boolean) => true);
  reads = new SessionReads(context);
  render(<SessionReadProvider context={context} reads={reads} bridge={false}><DecisionDetails item={item} disabled={false} current={() => true} onBack={vi.fn()} onOpenEntry={vi.fn(async () => false)} onNavigate={navigate}/></SessionReadProvider>);
  expect(await screen.findByRole("heading", { name: "Mara" })).toBeVisible(); expect(screen.getByText("Keep a calm tone.")).toBeVisible();
  expect(screen.getByText(i18n.t("workbenchV2.decisionDetailsKnowledgeVersion", { version: "1", number: 1 }))).toBeVisible();
  const open = screen.getByRole("button", { name: i18n.t("workbenchV2.decisionsKnowledgeProposalOpen") }); await waitFor(() => expect(open).toBeEnabled());
  await userEvent.setup().click(open); expect(navigate).toHaveBeenCalledOnce(); expect(navigate.mock.calls[0][0]).toBe(item); expect(navigate.mock.calls[0][1]()).toBe(true);
  expect(proposal).toHaveBeenCalledWith({ ...context, ...reference }); expect(external).not.toHaveBeenCalled();
});

it.each(["en-US", "zh-CN"])("pages the original source comparison and keeps uncertain matches separate from ordinary preview rows (%s)", async locale => {
  await i18n.changeLanguage(locale);
  const raw: unknown = structuredClone(wire.comparison);
  if (!validateResponseComparison(raw) || !raw.rows[0]?.new) throw new Error("Synthetic source comparison required");
  const context = { sessionToken: "synthetic-source-comparison", projectId: wire.session.projectId };
  const first = raw.rows[0], source = first.new!;
  const snapshot = raw.previousSnapshotId;
  const comparison = (after: number) => ({ ...raw, scope: { ...raw.scope, currentSnapshot: snapshot },
    confirmation: { ...raw.confirmation, expectedCurrentSnapshot: snapshot }, total: 2, filteredTotal: 2,
    nextOrdinal: after === 0 ? 1 : null, rows: after === 0 ? [first] : [{ ...first, kind: "rename-candidate" as const,
      new: { ...source, ordinal: 1, key: "new-name", text: "Uncertain source on the second page" },
      candidates: [{ occurrenceId: snapshot, unitId: snapshot, sourceRevisionId: snapshot,
        occurrence: { ...source, key: "old-name", text: "Previously saved source" } }] }] });
  const compare = vi.spyOn(sourceCommands, "compare").mockImplementation(async request => comparison(request.after));
  const item: DecisionItem = { decisionId: "source-mapping:result:original", source: "source-mapping", state: "pending", locale: null,
    targets: [{ kind: "source-result", attemptId: raw.attemptId, resultId: raw.resultId }], targetsComplete: true,
    basis: "b".repeat(64), sourceActionId: null, evidence: { kind: "source-comparison", changedCount: 0, ambiguousCount: 0, renameCandidateCount: 1 },
    action: { kind: "compare-source-mapping", attemptId: raw.attemptId, resultId: raw.resultId,
      previousSnapshotId: snapshot, expectedContentRevision: raw.scope.revision } };
  reads = new SessionReads(context);
  render(<StrictMode><SessionReadProvider context={context} reads={reads} bridge={false}>
    <DecisionDetails item={item} disabled={false} current={() => true} onBack={vi.fn()} onOpenEntry={vi.fn(async () => false)}/>
  </SessionReadProvider></StrictMode>);
  await screen.findByText(i18n.t("workbenchV2.decisionDetailsSourcePageNoMatches"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.decisionsNext") }));
  await screen.findByText("Uncertain source on the second page");
  await waitFor(() => expect(screen.getByRole("region", { name: i18n.t("workbenchV2.decisionDetailsContent") })).toHaveFocus());
  expect(screen.getByText("Previously saved source")).toBeVisible();
  expect(screen.getByText(i18n.t("workbenchV2.decisionDetailsRenameCandidate"))).toBeVisible();
  expect(compare).toHaveBeenLastCalledWith({ ...context, attemptId: raw.attemptId, resultId: raw.resultId,
    base: snapshot, filter: "", after: 1, limit: 50 });
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.decisionsPrevious") }));
  await waitFor(() => expect(screen.getByText(i18n.t("workbenchV2.decisionDetailsSourcePageNoMatches"))).toBeVisible());
  expect(screen.getByRole("region", { name: i18n.t("workbenchV2.decisionDetailsContent") })).toHaveFocus();
  await reads.client.invalidateQueries({ queryKey: reads.key(decisionTargetKey(item, 1)), refetchType: "none" });
  let finish: ((value: ReturnType<typeof comparison>) => void) | undefined;
  const waiting = new Promise<ReturnType<typeof comparison>>(resolve => { finish = resolve; });
  compare.mockImplementationOnce(async () => waiting);
  await user.click(screen.getByRole("button", { name: i18n.t("workbenchV2.decisionsNext") }));
  const back = screen.getByRole("button", { name: i18n.t("workbenchV2.decisionDetailsBack") });
  back.focus();
  await act(async () => { finish?.(comparison(1)); });
  await waitFor(() => expect(reads!.client.isFetching()).toBe(0));
  expect(back).toHaveFocus();
});
