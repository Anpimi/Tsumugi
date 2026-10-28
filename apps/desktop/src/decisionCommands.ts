import { checkedInvoke } from "./ipc";
import type { DecisionPageRequest } from "./generated/decisions.requests";
import type { DecisionItem, DecisionPage } from "./generated/decisions.responses";
import { DecisionSourceValues } from "./generated/decisions.enums";
import { validateRequestPage, validateResponsePage } from "./generated/decisions.validators";

export type { DecisionPageRequest } from "./generated/decisions.requests";
export type { DecisionAction, DecisionCoverage, DecisionItem, DecisionPage, DecisionSource, DecisionTarget } from "./generated/decisions.responses";

function relatedItem(item: DecisionItem): boolean {
  if (!item.decisionId.startsWith(`${item.source}:`) || item.basis.length !== 64 || item.targets.length === 0) return false;
  const action = item.action;
  switch (action.kind) {
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
    case "resolve-source-mapping":
      return item.source === "source-mapping" && item.evidence === null
        && item.targets.some(target => target.kind === "source-occurrence" && target.snapshotId === action.snapshotId && target.occurrenceId === action.occurrenceId);
    case "inspect-execution":
      return item.source === "execution-unknown" && item.evidence === null;
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
    && page.items.every((item, index) => sources.includes(item.source) && relatedItem(item)
      && (request.query.locale == null || item.locale === null || item.locale === request.query.locale)
      && (index === 0 ? !request.cursor || item.decisionId > request.cursor.afterId : item.decisionId > page.items[index - 1]!.decisionId))
    && page.coverage.every(source => page.items.filter(item => item.source === source.source).length <= source.knownCount)
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
