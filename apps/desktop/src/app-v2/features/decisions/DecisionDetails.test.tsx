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

let reads: SessionReads | undefined;
afterEach(() => { cleanup(); reads?.retire(); vi.restoreAllMocks(); });

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
    basis: "b".repeat(64), sourceActionId: null, evidence: { kind: "source-comparison", ambiguousCount: 0, renameCandidateCount: 1 },
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
