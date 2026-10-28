import type { QueryKey } from "@tanstack/react-query";
import { executionCommands, type AttemptDetail, type ExecutionOutputView, type ItemView, type SessionRequest } from "../../../executionCommands";
import type { DecisionItem } from "../../../generated/decisions.responses";
import type { DeliveryRecordView } from "../../../generated/release.responses";
import { releaseCommands } from "../../../releaseCommands";
import { resourceCommands, type ResourcePreview, type ResourcePreviewRow, type TermRevision } from "../../../resourceCommands";
import { reviewCommands, type Eligibility, type EligibilityLocale } from "../../../reviewCommands";
import { sourceCommands, type ContentPage, type ContentRow, type LineageEvidence, type SourceChangePage } from "../../../sourceCommands";
import { conversationCommands, type ConversationKnowledgeDecision, type ConversationKnowledgeEntry, type ConversationProposalRevision } from "../../../conversationCommands";
import { jsonIdentity } from "../../../pluginToolChoices";

export type DecisionTargetDetails =
  | { kind: "resource"; preview: ResourcePreview; proposal: { kind: "row"; row: ResourcePreviewRow } | { kind: "removed"; term: TermRevision } }
  | { kind: "knowledge"; revision: ConversationProposalRevision; entry: ConversationKnowledgeEntry; entryIndex: number; decision: ConversationKnowledgeDecision | null }
  | { kind: "mapping"; page: ContentPage; row: ContentRow; lineage: LineageEvidence[] }
  | { kind: "source-comparison"; page: SourceChangePage }
  | { kind: "execution"; detail: AttemptDetail; item: ItemView; output: ExecutionOutputView | null }
  | { kind: "delivery"; eligibility: Eligibility; locale: EligibilityLocale }
  | { kind: "delivery-outcome"; record: DeliveryRecordView | null }
  | { kind: "overview" };

export interface DecisionTargetReadPorts {
  preview: typeof resourceCommands.preview;
  historyContent: typeof sourceCommands.historyContent;
  lineage: typeof sourceCommands.lineage;
  compare: typeof sourceCommands.compare;
  attempt: typeof executionCommands.attempt;
  output: typeof executionCommands.output;
  eligibility: typeof reviewCommands.eligibility;
  deliveryRecord: typeof releaseCommands.deliveryRecord;
  proposal: typeof conversationCommands.readProposal;
  knowledgeDecision: typeof conversationCommands.readKnowledgeDecision;
}
const ports: DecisionTargetReadPorts = {
  preview: request => resourceCommands.preview(request), historyContent: request => sourceCommands.historyContent(request),
  lineage: request => sourceCommands.lineage(request), attempt: request => executionCommands.attempt(request),
  compare: request => sourceCommands.compare(request),
  output: request => executionCommands.output(request), eligibility: request => reviewCommands.eligibility(request),
  deliveryRecord: request => releaseCommands.deliveryRecord(request),
  proposal: request => conversationCommands.readProposal(request), knowledgeDecision: request => conversationCommands.readKnowledgeDecision(request),
};

export class DecisionTargetReadError extends Error {
  constructor(readonly reason: "changed" | "missing" | "mismatch") { super(`Decision target ${reason}`); }
}

/** SessionReads prefixes this with the exact project and session. */
export function decisionTargetKey(item: DecisionItem, sourceAfter = 0): QueryKey {
  return ["workbench-decision-target", item.decisionId, structuredClone(item.action), item.locale, item.basis, sourceAfter];
}

/** These locators only read original records. They never authorize an action. */
export async function readDecisionTarget(context: SessionRequest, item: DecisionItem, current: () => boolean,
  commands: DecisionTargetReadPorts = ports, sourceAfter = 0,
): Promise<DecisionTargetDetails> {
  const fixed = structuredClone({ context, item }), ctx = fixed.context, action = fixed.item.action;
  function present() { if (!current()) throw new DecisionTargetReadError("changed"); }
  function match(condition: boolean): asserts condition { if (!condition) throw new DecisionTargetReadError("mismatch"); }
  present();
  switch (action.kind) {
    case "review-knowledge-proposal": {
      match(action.proposal.projectId === ctx.projectId && Number.isInteger(action.entryIndex) && action.entryIndex >= 0
        && fixed.item.targets.some(target => target.kind === "conversation-proposal" && target.conversationId === action.proposal.conversationId && target.proposalId === action.proposal.proposalId));
      const revision = await commands.proposal({ ...ctx, ...action.proposal }); present();
      match(revision.projectId === ctx.projectId && revision.conversationId === action.proposal.conversationId && revision.proposalId === action.proposal.proposalId
        && revision.revisionId === action.proposal.revisionId && revision.content.kind === "knowledge-proposal");
      const entry = revision.content.entries[action.entryIndex];
      if (!entry) throw new DecisionTargetReadError("missing");
      const decision = await commands.knowledgeDecision({ ...ctx, proposal: action.proposal, entryIndex: action.entryIndex }); present();
      match(decision === null || jsonIdentity(decision.proposal) === jsonIdentity(action.proposal) && decision.entryIndex === action.entryIndex);
      return { kind: "knowledge", revision, entry, entryIndex: action.entryIndex, decision };
    }
    case "compare-source-mapping": {
      match(fixed.item.locale === null && fixed.item.targets.some(target => target.kind === "source-result"
        && target.attemptId === action.attemptId && target.resultId === action.resultId));
      const page = await commands.compare({ ...ctx, attemptId: action.attemptId, resultId: action.resultId,
        base: action.previousSnapshotId, filter: "", after: sourceAfter, limit: 50 });
      present();
      const end = sourceAfter + page.rows.length;
      match(page.attemptId === action.attemptId && page.resultId === action.resultId && page.previousSnapshotId === action.previousSnapshotId
        && page.scope.currentSnapshot === action.previousSnapshotId && page.scope.revision === action.expectedContentRevision
        && page.confirmation.expectedCurrentSnapshot === page.scope.currentSnapshot
        && page.confirmation.expectedContentRevision === page.scope.revision && page.rows.length <= 50
        && end <= page.filteredTotal && page.filteredTotal <= page.total
        && (page.nextOrdinal === null ? end === page.filteredTotal : page.rows.length > 0 && page.nextOrdinal === end && end < page.filteredTotal));
      return { kind: "source-comparison", page };
    }
    case "review-resource": {
      const preview = await commands.preview({ ...ctx, captureId: action.captureId });
      present();
      match(preview.capture.captureId === action.captureId && (fixed.item.locale === null || preview.capture.targetLocale === fixed.item.locale));
      const rows = preview.rows.filter(row => row.entry.id === action.entryId);
      const removed = preview.removed.filter(term => term.externalEntryId === action.entryId);
      if (rows.length + removed.length === 0) throw new DecisionTargetReadError("missing");
      match(rows.length + removed.length === 1);
      const row = rows[0], term = removed[0];
      if (row) return { kind: "resource", preview, proposal: { kind: "row", row } };
      if (term) return { kind: "resource", preview, proposal: { kind: "removed", term } };
      throw new DecisionTargetReadError("missing");
    }
    case "resolve-source-mapping": {
      const page = await commands.historyContent({ ...ctx, snapshotId: action.snapshotId, query: "", after: action.ordinal, limit: 1 });
      present();
      match(page.snapshotId === action.snapshotId && page.rows.length <= 1);
      const row = page.rows[0];
      if (!row) throw new DecisionTargetReadError("missing");
      match(row.occurrenceId === action.occurrenceId && row.occurrence.ordinal === action.ordinal);
      const lineage = await commands.lineage({ ...ctx, snapshotId: action.snapshotId, ordinal: action.ordinal });
      present();
      return { kind: "mapping", page, row, lineage };
    }
    case "inspect-execution": {
      // Core admits at most 2,000 items per attempt and pages at most 100.
      const seen = new Set<string>();
      let offset = 0, total: number | null = null, operation: string | null = null;
      while (offset < 2000) {
        present();
        const detail = await commands.attempt({ ...ctx, attemptId: action.attemptId, offset, limit: 100 });
        present();
        const end = offset + detail.items.length, progress = detail.progress;
        match(detail.attemptId === action.attemptId && detail.taskId === action.taskId && detail.recovery.attemptId === action.attemptId
          && detail.items.length <= 100 && progress.total <= 2000 && end <= progress.total
          && (total === null || total === progress.total) && (operation === null || operation === detail.operation)
          && progress.total === progress.queued + progress.running + progress.succeeded + progress.failed + progress.cancelled + progress.unknown
          && (detail.nextOffset === null ? end === progress.total : detail.items.length > 0 && detail.nextOffset === end && end < progress.total));
        total = progress.total; operation = detail.operation;
        for (const row of detail.items) { match(!seen.has(row.status.itemId)); seen.add(row.status.itemId); }
        const target = detail.items.find(row => row.status.itemId === action.itemId);
        if (target) {
          match(fixed.item.locale === null || target.scope.locale === fixed.item.locale);
          const output = target.resultId === null ? null : await commands.output({ ...ctx, attemptId: action.attemptId, resultId: target.resultId });
          present();
          match(output === null || output.projectId === ctx.projectId && output.attemptId === action.attemptId
            && output.itemId === action.itemId && output.resultId === target.resultId);
          return { kind: "execution", detail, item: target, output };
        }
        if (detail.nextOffset === null) break;
        offset = detail.nextOffset;
      }
      throw new DecisionTargetReadError("missing");
    }
    case "inspect-delivery": {
      const eligibility = await commands.eligibility({ ...ctx, locales: [action.locale] });
      present();
      match(eligibility.locales.length === 1 && (fixed.item.locale === null || fixed.item.locale === action.locale));
      const locale = eligibility.locales[0];
      if (!locale) throw new DecisionTargetReadError("missing");
      match(locale.locale === action.locale && locale.blockers.length <= locale.blockerCount && locale.exceptions.length <= locale.exceptionCount);
      return { kind: "delivery", eligibility, locale };
    }
    case "inspect-delivery-outcome": {
      const record = await commands.deliveryRecord({ ...ctx, releaseId: action.releaseId, deliveryId: action.deliveryId, actionId: action.actionId });
      present();
      match(record === null || record.releaseId === action.releaseId && record.deliveryId === action.deliveryId && record.actionId === action.actionId);
      return { kind: "delivery-outcome", record };
    }
    default: return { kind: "overview" };
  }
}
