import { checkedInvoke } from "./ipc";
import { validDeliveryActivity } from "./deliveryActivity";
import type { DecisionClientAction, DecisionClientActivity, DecisionPageRequest } from "./generated/decisions.requests";
import type { DecisionItem, DecisionPage } from "./generated/decisions.responses";
import { DecisionSourceValues } from "./generated/decisions.enums";
import { validateRequestPage, validateResponsePage } from "./generated/decisions.validators";

export type { DecisionPageRequest } from "./generated/decisions.requests";
export type { DecisionAction, DecisionCoverage, DecisionItem, DecisionPage, DecisionSource, DecisionTarget } from "./generated/decisions.responses";

const actionIdentity = (action: DecisionClientAction) => JSON.stringify([action.key.kind,
  action.key.kind === "translation" ? [action.key.unitId, action.key.locale]
    : action.key.kind === "conversation" ? action.key.conversationId : null,
  action.slot, action.actionId, action.submittedSeq]);
export const decisionActivityIdentity = (activity: readonly DecisionClientActivity[] | null | undefined) => activity == null ? "unavailable"
  : JSON.stringify(activity.map(owner => [owner.ownerId, owner.revision, owner.actions.map(actionIdentity)]));

function relatedLocalActions(page: DecisionPage, request: DecisionPageRequest): boolean {
  const basis = page.localActions, coverage = page.coverage.find(source => source.source === "local-action-recovery");
  if (basis === null) return !coverage || coverage.state === "unavailable";
  if (!coverage || basis.journalBasis.length !== 64
    || decisionActivityIdentity(basis.activity) !== decisionActivityIdentity(request.activity)
    || new Set(basis.observations.map(row => actionIdentity(row.reference.action))).size !== basis.observations.length
    || (!basis.journalComplete && coverage.state === "complete")
    || (basis.activity === null && basis.observations.some(row => row.outcome === "receipt-absent") && coverage.state === "complete")) return false;
  const active = new Set(basis.activity?.flatMap(owner => owner.actions.map(actionIdentity)) ?? []);
  const actionable = basis.observations.filter(row => ["mismatch", "unavailable"].includes(row.outcome)
    || row.outcome === "receipt-absent" && basis.activity !== null);
  return coverage.knownCount === actionable.length
    && basis.observations.every(row => ((row.outcome === "mismatch" || row.outcome === "unavailable") === (row.errorCode !== null))
      && (row.outcome !== "in-flight" || active.has(actionIdentity(row.reference.action)))
      && (row.outcome !== "receipt-absent" || !active.has(actionIdentity(row.reference.action))))
    && page.items.every(item => {
      if (item.action.kind !== "inspect-local-request") return true;
      const key = actionIdentity(item.action.reference.action);
      const observation = actionable.find(row => actionIdentity(row.reference.action) === key);
      return observation !== undefined && observation.reference.requestKind === item.action.reference.requestKind
        && item.evidence?.kind === "local-request" && item.evidence.outcome === observation.outcome
        && item.evidence.errorCode === observation.errorCode;
    });
}

function relatedItem(item: DecisionItem, projectId: string): boolean {
  if (!item.decisionId.startsWith(`${item.source}:`) || item.basis.length !== 64 || item.targets.length === 0) return false;
  const action = item.action;
  switch (action.kind) {
    case "answer-team-question":
      return item.source === "agent-question" && item.evidence?.kind === "team-question" && item.locale !== null
        && item.sourceActionId === action.questionPostId && item.targets.some(target => target.kind === "plan" && target.planId === action.planId)
        && item.targets.some(target => target.kind === "entry");
    case "compare-candidate":
      return item.source === "translation-candidate" && item.evidence === null
        && item.targets.some(target => target.kind === "entry" && target.unitId === action.unitId);
    case "review-translation":
      return item.source === "human-review" && item.evidence === null
        && item.targets.some(target => target.kind === "entry" && target.unitId === action.unitId);
    case "review-finding":
      return item.source === "review-finding" && item.evidence === null
        && item.targets.some(target => target.kind === "entry" && target.unitId === action.unitId);
    case "review-resource":
      return item.source === "resource-proposal" && item.evidence === null
        && item.targets.some(target => target.kind === "resource" && target.captureId === action.captureId && target.entryId === action.entryId);
    case "review-knowledge-proposal":
      return item.source === "resource-proposal" && item.evidence === null && item.sourceActionId === null
        && item.locale !== null && ["pending", "stale"].includes(item.state) && action.proposal.projectId === projectId
        && action.entryIndex < 16
        && item.targets.some(target => target.kind === "conversation" && target.conversationId === action.proposal.conversationId)
        && item.targets.some(target => target.kind === "conversation-proposal"
          && target.conversationId === action.proposal.conversationId && target.proposalId === action.proposal.proposalId)
        && item.targets.every(target => ["conversation", "conversation-proposal", "entry"].includes(target.kind));
    case "resolve-source-mapping":
      return item.source === "source-mapping" && item.evidence === null
        && item.targets.some(target => target.kind === "source-occurrence" && target.snapshotId === action.snapshotId && target.occurrenceId === action.occurrenceId);
    case "compare-source-mapping":
      return item.source === "source-mapping" && item.locale === null && item.sourceActionId === null
        && item.evidence?.kind === "source-comparison" && item.evidence.changedCount + item.evidence.ambiguousCount + item.evidence.renameCandidateCount > 0
        && ["pending", "stale"].includes(item.state)
        && item.targets.some(target => target.kind === "source-result" && target.attemptId === action.attemptId && target.resultId === action.resultId)
        && item.targets.every(target => target.kind !== "entry" && target.kind !== "source-occurrence");
    case "clarify-conversation-proposal":
      return item.source === "agent-question" && item.locale === null && item.sourceActionId === null
        && item.evidence?.kind === "proposal-questions" && item.evidence.questionCount > 0
        && ["pending", "stale"].includes(item.state)
        && item.targets.some(target => target.kind === "conversation-proposal" && target.conversationId === action.conversationId && target.proposalId === action.proposalId);
    case "inspect-execution":
      return item.source === "execution-unknown" && item.evidence === null;
    case "inspect-local-request": {
      const reference = action.reference, pending = reference.action;
      return item.source === "local-action-recovery" && item.sourceActionId === pending.actionId
        && item.evidence?.kind === "local-request" && ["receipt-absent", "mismatch", "unavailable"].includes(item.evidence.outcome)
        && item.state === (item.evidence.outcome === "receipt-absent" ? "awaiting-recheck" : "stale")
        && (pending.key.kind === "translation"
          ? pending.slot === "primary" && ["save", "selection", "merge"].includes(reference.requestKind)
            && item.locale === pending.key.locale && item.targets.some(target => target.kind === "entry" && pending.key.kind === "translation" && target.unitId === pending.key.unitId)
          : pending.key.kind === "resource"
            ? reference.requestKind.startsWith("resource-")
              && (pending.slot === "resource-fact" ? reference.requestKind === "resource-fact"
                : pending.slot === "primary" && reference.requestKind !== "resource-fact")
              && item.locale === null && item.targets.every(target => target.kind === "project")
            : pending.key.kind === "source"
              ? reference.requestKind.startsWith("source-")
                && (pending.slot === "source-hook-stop" ? reference.requestKind === "source-hook-stop"
                  : pending.slot === "primary" && reference.requestKind !== "source-hook-stop")
                && item.locale === null && item.targets.every(target => target.kind === "project")
            : ["create", "append", "planning", "proposal-capture", "proposal-revision", "proposal-work-plan", "work-plan-start", "work-plan-control"].includes(reference.requestKind)
              && (pending.slot === "primary" || pending.slot === "revocation" && reference.requestKind === "work-plan-control")
              && item.locale === null && item.targets.some(target => target.kind === "conversation" && pending.key.kind === "conversation" && target.conversationId === pending.key.conversationId));
    }
    case "inspect-delivery-outcome": {
      const evidence = item.evidence;
      return item.source === "delivery-unknown" && item.sourceActionId === action.actionId
        && item.decisionId === `delivery-unknown:${action.deliveryId}`
        && item.state === "awaiting-recheck" && item.targetsComplete
        && item.targets.some(target => target.kind === "delivery" && target.releaseId === action.releaseId && target.deliveryId === action.deliveryId)
        && evidence?.kind === "delivery-outcome" && ["pending", "unknown"].includes(evidence.state)
        && evidence.fileCount > 0 && evidence.unknownFileCount <= evidence.fileCount
        && (evidence.state === "pending" ? evidence.unknownFileCount === 0 : evidence.unknownFileCount > 0)
        && evidence.locales.length > 0 && evidence.locales.length <= evidence.fileCount
        && new Set(evidence.locales).size === evidence.locales.length
        && item.locale === (evidence.locales.length === 1 ? evidence.locales[0] : null);
    }
    case "inspect-delivery": {
      const evidence = item.evidence;
      return item.source === "delivery-blocker" && item.locale === action.locale
        && item.targets.some(target => target.kind === "project")
        && evidence?.kind === "delivery" && evidence.blockerCount > 0
        && evidence.reasons.length <= evidence.blockerCount
        && evidence.reasonsComplete === (evidence.reasons.length === evidence.blockerCount)
        && item.targetsComplete === evidence.reasonsComplete;
    }
  }
}

function relatedPage(page: DecisionPage, request: DecisionPageRequest): boolean {
  const sources = request.query.sources.length ? request.query.sources : DecisionSourceValues;
  const complete = page.coverage.every(source => source.state === "complete");
  return page.projectId === request.projectId && page.query.locale === (request.query.locale ?? null)
    && JSON.stringify(page.query.sources) === JSON.stringify(request.query.sources)
    && page.basis.length === 64 && (!request.cursor || page.basis === request.cursor.basis)
    && page.items.length <= request.limit && page.items.length <= page.knownCount
    && page.coverage.length === sources.length
    && new Set(page.coverage.map(source => source.source)).size === sources.length
    && page.coverage.every(source => sources.includes(source.source)
      && (source.state === "complete" ? source.total === source.knownCount && source.reason === null && source.errorCode === null
        : source.total === null && source.reason !== null
          && (source.reason === "source-unavailable" ? source.errorCode !== null : source.errorCode === null)
          && (source.state !== "unavailable" || source.knownCount === 0)))
    && page.knownCount === page.coverage.reduce((sum, source) => sum + source.knownCount, 0)
    && page.total === (complete ? page.knownCount : null)
    && relatedLocalActions(page, request)
    && page.items.every((item, index) => sources.includes(item.source) && relatedItem(item, page.projectId)
      && (request.query.locale == null || item.locale === null || item.locale === request.query.locale)
      && (index === 0 ? !request.cursor || item.decisionId > request.cursor.afterId : item.decisionId > page.items[index - 1]!.decisionId))
    && page.coverage.every(source => page.items.filter(item => item.source === source.source).length <= source.knownCount)
    && new Set(page.deliveryActivity.map(job => job.jobId)).size === page.deliveryActivity.length
    && (sources.includes("delivery-unknown") || page.deliveryActivity.length === 0)
    && page.deliveryActivity.every(validDeliveryActivity)
    && page.items.every(item => item.action.kind !== "inspect-delivery-outcome" || item.evidence?.kind === "delivery-outcome"
      && (request.query.locale == null || item.evidence.locales.includes(request.query.locale))
      && (item.evidence.state !== "pending" || !page.deliveryActivity.some(job => job.kind === "export"
        && item.action.kind === "inspect-delivery-outcome" && job.actionId === item.action.actionId && job.releaseId === item.action.releaseId)))
    && new Set(page.executionActivity.map(item => item.attemptId)).size === page.executionActivity.length
    && page.items.every(item => item.action.kind !== "inspect-execution"
      || page.executionActivity.some(activity => item.action.kind === "inspect-execution" && activity.attemptId === item.action.attemptId))
    && (page.next === null
      ? !!request.cursor || page.items.length === page.knownCount
      : page.items.length === request.limit && page.items.length < page.knownCount && page.next.basis === page.basis
        && page.next.afterId === page.items.at(-1)?.decisionId);
}

export const decisionCommands = {
  async page(request: DecisionPageRequest): Promise<DecisionPage> {
    const captured = structuredClone(request);
    if (!validateRequestPage(captured)) throw new Error("Invalid IPC request: read_decision_page");
    return checkedInvoke("read_decision_page", captured,
      (value): value is DecisionPage => validateResponsePage(value) && relatedPage(value, captured));
  },
};
