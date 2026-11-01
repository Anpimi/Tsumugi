import { conversationCommands } from "../../../conversationCommands";
import type { SessionRequest } from "../../../executionCommands";
import { reviewCommands } from "../../../reviewCommands";
import { sourceCommands } from "../../../sourceCommands";
import type { ViewPatch } from "../../workspace/workspaceStore";
import type { ConversationEntryReference } from "./ConversationEntryReferences";

interface Ports {
  planning: typeof conversationCommands.readPlanning;
  target: typeof reviewCommands.target;
  scope: typeof sourceCommands.scope;
}
const ports: Ports = { planning: request => conversationCommands.readPlanning(request),
  target: request => reviewCommands.target(request), scope: request => sourceCommands.scope(request) };

/** Admit an exact saved reference against current source facts; never restore permission or edit a draft. */
export async function resolveConversationEntryReference(context: SessionRequest, reference: ConversationEntryReference,
  current: () => boolean, commands: Ports = ports): Promise<ViewPatch> {
  const fixed = structuredClone(reference);
  function match(value: boolean): asserts value { if (!value) throw new Error("The conversation entry reference changed"); }
  function present() { match(current() && fixed.projectId === context.projectId); }
  present();
  match(fixed.detailTab === undefined || fixed.detailTab === "detail" || fixed.detailTab === "context");
  const run = await commands.planning({ ...context, conversationId: fixed.conversationId, attemptId: fixed.attemptId });
  present();
  match(!!run && run.preview.projectId === context.projectId && run.preview.conversationId === fixed.conversationId
    && run.receipt.projectId === context.projectId && run.receipt.conversationId === fixed.conversationId
    && run.receipt.consent.attemptId === fixed.attemptId && run.detail.attemptId === fixed.attemptId
    && run.detail.recovery.attemptId === fixed.attemptId && run.preview.scope.kind === "units"
    && run.preview.scope.locale === fixed.locale && run.preview.scope.unitIds.includes(fixed.unitId));
  const units = run.preview.units.filter(unit => unit.unitId === fixed.unitId);
  match(units.length === 1 && units[0].sourceSnapshotId === fixed.sourceSnapshotId && units[0].sourceRevisionId === fixed.sourceRevisionId
    && units[0].protection.unitId === fixed.unitId && units[0].protection.locale === fixed.locale);
  const [scope, target] = await Promise.all([commands.scope(context), commands.target({ ...context, unitId: fixed.unitId, locale: fixed.locale })]);
  present();
  match(scope.currentSnapshot === fixed.sourceSnapshotId && target.unitId === fixed.unitId && target.locale === fixed.locale
    && target.sourceSnapshotId === fixed.sourceSnapshotId && target.sourceRevisionId === fixed.sourceRevisionId
    && target.basisEvidence.sourceSnapshotId === fixed.sourceSnapshotId && target.basisEvidence.sourceRevisionId === fixed.sourceRevisionId);
  return { entryMode: "table", compareSource: false, locale: fixed.locale, preset: "all", query: "", searchInput: "", focus: fixed.unitId,
    dock: "details", detailTab: fixed.detailTab ?? "detail", editing: false, focusMode: false,
    queueActive: true, queueAnchor: fixed.unitId, queueScopeId: null, cursor: null, afterOrdinal: 0, scroll: { top: 0, left: 0 } };
}
