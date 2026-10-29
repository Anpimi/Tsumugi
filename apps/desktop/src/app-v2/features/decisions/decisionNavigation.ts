import { strategyDraftCommands, strategyPendingActionId } from "../../../strategyDraftCommands";
import { conversationDraftCommands, conversationPendingTarget, conversationPendingActionId } from "../../../conversationDraftCommands";
import { conversationCommands, type ConversationProposalRef } from "../../../conversationCommands";
import { draftCommands, sameDraftKey, type DraftKey } from "../../../draftCommands";
import type { SessionRequest } from "../../../executionCommands";
import type { DecisionItem } from "../../../decisionCommands";
import { reviewCommands, type ReviewTarget } from "../../../reviewCommands";
import { currentDiagnosticRun, sameReviewBasis } from "../../../reviewDiagnosticNavigation";
import { translationCommands, translationHistoryAfter } from "../../../translationCommands";
import { resourceDraftCommands, resourcePendingProject } from "../../../resourceDraftCommands";
import { sourceDraftCommands } from "../../../sourceDraftCommands";
import { readDecisionTarget, teamQuestionMatchesDecision } from "./decisionTargetReads";
import { teamQuestionCommands } from "../../../teamQuestionCommands";
import { validateResponseProposalWorkPlanLink } from "../../../generated/conversations.validators";
import type { SourceReviewTarget } from "../source/sourceTypes";

export type DecisionNavigation =
  | { kind: "candidate"; unitId: string; locale: string; revisionId: string; afterOrdinal: string }
  | { kind: "review"; unitId: string; locale: string }
  | { kind: "finding"; unitId: string; locale: string; runId: string; issueId: string; offset: number }
  | { kind: "translation-request"; key: DraftKey }
  | { kind: "conversation-request"; conversationId: string; slot: "primary" | "revocation"; actionId: string }
  | { kind: "resource-request"; slot: "primary" | "resource-fact"; actionId: string }
  | { kind: "strategy-request"; actionId: string; submittedSeq: string }
  | { kind: "source-request"; slot: "primary" | "source-hook-stop"; actionId: string }
  | { kind: "source-review"; target: SourceReviewTarget }
  | { kind: "conversation-proposal"; conversationId: string; proposalId: string; revisionId: string }
  | { kind: "conversation-team-question"; conversationId: string; planId: string; questionPostId: string }
  | { kind: "knowledge-proposal"; proposal: ConversationProposalRef; entryIndex: number }
  | { kind: "details" };

export interface DecisionNavigationPorts {
  revision: typeof translationCommands.revision;
  target: typeof reviewCommands.target;
  findings: typeof reviewCommands.findings;
  draft: typeof draftCommands.read;
  conversationDraft: typeof conversationDraftCommands.read;
  resourceDraft: typeof resourceDraftCommands.read;
  sourceDraft: typeof sourceDraftCommands.read;
  strategyDraft: typeof strategyDraftCommands.read;
  sourceTarget: typeof readDecisionTarget;
  proposal: typeof conversationCommands.readProposal;
  knowledgeDecision: typeof conversationCommands.readKnowledgeDecision;
  teamQuestion: typeof teamQuestionCommands.question;
  proposalWorkPlan: typeof conversationCommands.readProposalWorkPlan;
}
const ports: DecisionNavigationPorts = {
  revision: request => translationCommands.revision(request),
  target: request => reviewCommands.target(request),
  findings: request => reviewCommands.findings(request),
  draft: request => draftCommands.read(request),
  conversationDraft: request => conversationDraftCommands.read(request),
  resourceDraft: request => resourceDraftCommands.read(request),
  sourceDraft: request => sourceDraftCommands.read(request),
  strategyDraft: request => strategyDraftCommands.read(request),
  sourceTarget: (...args) => readDecisionTarget(...args),
  proposal: request => conversationCommands.readProposal(request),
  knowledgeDecision: request => conversationCommands.readKnowledgeDecision(request),
  teamQuestion: request => teamQuestionCommands.question(request),
  proposalWorkPlan: request => conversationCommands.readProposalWorkPlan(request),
};

export class DecisionNavigationChanged extends Error {
  readonly kind = "decision-navigation-changed";
  constructor() { super("Decision navigation target changed"); this.name = "DecisionNavigationChanged"; }
}

/** Resolve an exact original record without opening an owner or settling its action. */
export async function resolveDecisionNavigation(context: SessionRequest, item: DecisionItem, current: () => boolean,
  commands: DecisionNavigationPorts = ports,
): Promise<DecisionNavigation> {
  const fixed = structuredClone({ context, item }), ctx = fixed.context, action = fixed.item.action;
  function match(condition: boolean): asserts condition { if (!condition) throw new DecisionNavigationChanged(); }
  function present() { match(current()); }
  function entry(unitId: string): string {
    const locale = fixed.item.locale;
    match(locale !== null && fixed.item.targets.some(target => target.kind === "entry" && target.unitId === unitId));
    return locale;
  }
  function targetMatches(target: ReviewTarget, unitId: string, locale: string) {
    return target.unitId === unitId && target.locale === locale
      && target.sourceSnapshotId === target.basisEvidence.sourceSnapshotId && target.sourceRevisionId === target.basisEvidence.sourceRevisionId
      && target.selectionId === target.basisEvidence.selectionId && target.revisionId === target.basisEvidence.revisionId;
  }
  function planMatches(planId: string | null) {
    return fixed.item.targets.every(target => target.kind !== "plan" || target.planId === planId);
  }
  present();
  switch (action.kind) {
    case "answer-team-question": {
      const question = await commands.teamQuestion({ ...ctx, planId: action.planId, questionPostId: action.questionPostId }); present();
      match(teamQuestionMatchesDecision(fixed.item, question) && fixed.item.state === "pending" && question.state === "open" && question.response === null);
      const conversation = fixed.item.targets.find(target => target.kind === "conversation");
      if (!conversation) return { kind: "details" };
      const link = await commands.proposalWorkPlan({ ...ctx, conversationId: conversation.conversationId, planId: action.planId }); present();
      match(validateResponseProposalWorkPlanLink(link) && link.projectId === ctx.projectId && link.conversationId === conversation.conversationId
        && link.planId === action.planId && BigInt(link.ordinal) > 0n && /^[a-f0-9]{64}$/.test(link.planDigest));
      return { kind: "conversation-team-question", conversationId: link.conversationId, planId: link.planId, questionPostId: action.questionPostId };
    }
    case "compare-source-mapping":
    case "resolve-source-mapping": {
      const target = await commands.sourceTarget(ctx, fixed.item, current); present();
      match(action.kind === "compare-source-mapping" ? target.kind === "source-comparison" : target.kind === "mapping");
      return { kind: "source-review", target: action };
    }
    case "clarify-conversation-proposal": {
      match(fixed.item.locale === null && fixed.item.targets.some(target => target.kind === "conversation-proposal"
        && target.conversationId === action.conversationId && target.proposalId === action.proposalId));
      const request = { ...ctx, conversationId: action.conversationId, proposalId: action.proposalId };
      const exact = await commands.proposal({ ...request, revisionId: action.revisionId });
      present();
      match(exact.projectId === ctx.projectId && exact.conversationId === action.conversationId && exact.proposalId === action.proposalId
        && exact.revisionId === action.revisionId && (exact.content.kind === "proposal" || exact.content.kind === "knowledge-proposal") && exact.content.questions.length > 0);
      const latest = await commands.proposal({ ...request, revisionId: null });
      present();
      match(latest.projectId === ctx.projectId && latest.conversationId === action.conversationId && latest.proposalId === action.proposalId
        && latest.revisionId === exact.revisionId);
      return { kind: "conversation-proposal", conversationId: action.conversationId, proposalId: action.proposalId, revisionId: action.revisionId };
    }
    case "review-knowledge-proposal": {
      const reference = action.proposal;
      match(reference.projectId === ctx.projectId && Number.isInteger(action.entryIndex) && action.entryIndex >= 0 && fixed.item.targets.some(target => target.kind === "conversation-proposal"
        && target.conversationId === reference.conversationId && target.proposalId === reference.proposalId));
      const exact = await commands.proposal({ ...ctx, ...reference }); present();
      match(exact.projectId === ctx.projectId && exact.conversationId === reference.conversationId && exact.proposalId === reference.proposalId && exact.revisionId === reference.revisionId
        && exact.content.kind === "knowledge-proposal" && !!exact.content.entries[action.entryIndex] && exact.content.questions.length === 0);
      const latest = await commands.proposal({ ...ctx, ...reference, revisionId: null }); present();
      match(latest.revisionId === exact.revisionId);
      const decision = await commands.knowledgeDecision({ ...ctx, proposal: reference, entryIndex: action.entryIndex }); present(); match(decision === null);
      return { kind: "knowledge-proposal", proposal: reference, entryIndex: action.entryIndex };
    }
    case "compare-candidate": {
      const locale = entry(action.unitId);
      present();
      const revision = await commands.revision({ ...ctx, unitId: action.unitId, locale, revisionId: action.revisionId });
      present();
      match(revision.unitId === action.unitId && revision.locale === locale && revision.revisionId === action.revisionId
        && revision.sourceRevisionId === action.sourceRevisionId && revision.sourceSnapshotId === action.sourceSnapshotId
        && BigInt(revision.ordinal) > 0n);
      return { kind: "candidate", unitId: action.unitId, locale, revisionId: action.revisionId,
        afterOrdinal: translationHistoryAfter(revision.ordinal, 1) };
    }
    case "review-translation": {
      const locale = entry(action.unitId);
      present();
      const target = await commands.target({ ...ctx, unitId: action.unitId, locale });
      present();
      match(targetMatches(target, action.unitId, locale) && target.selectionId === action.selectionId && target.revisionId === action.revisionId);
      return { kind: "review", unitId: action.unitId, locale };
    }
    case "review-finding": {
      const locale = entry(action.unitId), request = { ...ctx, unitId: action.unitId, locale };
      present();
      const target = await commands.target(request);
      present();
      match(targetMatches(target, action.unitId, locale));
      let offset = 0;
      for (;;) {
        present();
        // Keep the offset compatible with the original EntryIssuesPanel reader.
        const page = await commands.findings({ ...request, offset, limit: 20 });
        present();
        match(page.unitId === action.unitId && page.locale === locale && page.basis === target.basis);
        const finding = page.findings.find(row => row.runId === action.runId && row.finding.issueId === action.issueId);
        const repair = page.repairs.find(row => (row.recheckRunId ?? row.decision.request.runId) === action.runId
          && row.decision.request.issueId === action.issueId
          && (row.status === "awaiting-current-recheck" || row.status === "current-rule-findings"));
        if (finding || repair) {
          if (finding) {
            match(finding.decision?.request.disposition !== "rejected" && (finding.purpose === "qa"
              ? page.runId === action.runId && !!target.currentCheck && currentDiagnosticRun(target, target.currentCheck)
                && target.currentCheck.runId === action.runId
              : page.semanticRunId === action.runId && finding.aiOrigin !== null));
          }
          if (!finding && repair) {
            const decision = repair.decision;
            match(decision.request.projectId === ctx.projectId && decision.request.unitId === action.unitId && decision.request.locale === locale
              && decision.finding.issueId === action.issueId
              && (fixed.item.sourceActionId === null || fixed.item.sourceActionId === decision.request.actionId));
          }
          present();
          const latest = await commands.target(request);
          present();
          match(targetMatches(latest, action.unitId, locale) && latest.basis === target.basis && sameReviewBasis(latest.basisEvidence, target.basisEvidence)
            && (!finding || finding.purpose !== "qa" || latest.currentCheck?.runId === action.runId));
          return { kind: "finding", unitId: action.unitId, locale, runId: action.runId, issueId: action.issueId, offset };
        }
        match(page.nextOffset !== null && Number.isSafeInteger(page.nextOffset) && page.nextOffset > offset);
        offset = page.nextOffset;
      }
    }
    case "inspect-local-request": {
      const reference = action.reference, original = reference.action;
      match(fixed.item.sourceActionId === original.actionId);
      if (original.key.kind === "strategy") {
        match(original.slot === "strategy" && fixed.item.targets.some(target => target.kind === "project"));
        const head = await commands.strategyDraft({ sessionToken: ctx.sessionToken, key: { projectId: ctx.projectId } }); present();
        const pending = head.value?.pending;
        match(head.key.projectId === ctx.projectId && !!pending && pending.submittedSeq === original.submittedSeq
          && strategyPendingActionId(pending) === original.actionId && reference.requestKind === `strategy-${pending.kind}`);
        return { kind: "strategy-request", actionId: original.actionId, submittedSeq: original.submittedSeq };
      }
      if (original.key.kind === "source") {
        match(fixed.item.locale === null && fixed.item.targets.some(target => target.kind === "project"));
        const head = await commands.sourceDraft({ sessionToken: ctx.sessionToken, key: { projectId: ctx.projectId } }); present();
        match(head.key.projectId === ctx.projectId);
        if (original.slot === "source-hook-stop") {
          const pending = head.value?.hookStop;
          match(reference.requestKind === "source-hook-stop" && !!pending && pending.request.stop.actionId === original.actionId && pending.submittedSeq === original.submittedSeq);
        } else {
          const pending = head.value?.pending;
          match(original.slot === "primary" && !!pending && reference.requestKind === (pending.kind === "correct-lineage" ? "source-lineage-correction" : `source-${pending.kind}`) && pending.submittedSeq === original.submittedSeq);
          const actionId = pending.kind === "adopt" ? pending.request.actionId : pending.kind === "correct-lineage" ? pending.request.correction.actionId
            : pending.kind === "finish-check" ? pending.request.resultId : pending.request.attemptId;
          match(actionId === original.actionId);
        }
        return { kind: "source-request", slot: original.slot, actionId: original.actionId };
      }
      if (original.key.kind === "resource") {
        match(planMatches(null) && fixed.item.targets.some(target => target.kind === "project"));
        const head = await commands.resourceDraft({ sessionToken: ctx.sessionToken, key: { projectId: ctx.projectId } }); present();
        match(head.key.projectId === ctx.projectId);
        if (original.slot === "resource-fact") {
          const pending = head.value?.factPending;
          match(reference.requestKind === "resource-fact" && !!pending && pending.request.basis.scope.projectId === ctx.projectId
            && pending.request.actionId === original.actionId && pending.submittedSeq === original.submittedSeq);
        } else {
          const pending = head.value?.pending;
          match(original.slot === "primary" && !!pending && reference.requestKind === `resource-${pending.kind}`
            && resourcePendingProject(pending) === ctx.projectId && pending.request.actionId === original.actionId && pending.submittedSeq === original.submittedSeq);
        }
        return { kind: "resource-request", slot: original.slot, actionId: original.actionId };
      }
      if (original.key.kind === "translation") {
        const key: DraftKey = { projectId: ctx.projectId, unitId: original.key.unitId, locale: original.key.locale };
        match(entry(key.unitId) === key.locale && original.slot === "primary" && planMatches(null));
        present();
        const value = await commands.draft({ sessionToken: ctx.sessionToken, key });
        present();
        const pending = value.head.value?.pending;
        // Later input is independent of the frozen submitted request.
        match(sameDraftKey(value.head.key, key) && !!pending && pending.kind === reference.requestKind
          && sameDraftKey(pending.request, key) && pending.request.actionId === original.actionId && pending.submittedSeq === original.submittedSeq);
        return { kind: "translation-request", key };
      }
      match(original.slot === "primary" || original.slot === "revocation");
      const conversationId = original.key.conversationId, key = { projectId: ctx.projectId, conversationId };
      match(fixed.item.locale === null && fixed.item.targets.some(target => target.kind === "conversation" && target.conversationId === conversationId));
      present();
      const head = await commands.conversationDraft({ sessionToken: ctx.sessionToken, key });
      present();
      match(head.key.projectId === key.projectId && head.key.conversationId === conversationId);
      if (original.slot === "revocation") {
        const slots = head.value?.revocations?.filter(slot => slot.request.actionId === original.actionId) ?? [];
        const slot = slots[0];
        match(reference.requestKind === "work-plan-control" && slots.length === 1 && !!slot
          && slot.request.projectId === ctx.projectId && slot.submittedSeq === original.submittedSeq && planMatches(slot.request.planId));
      } else {
        const pending = head.value?.pending;
        match(!!pending && pending.kind === reference.requestKind && pending.submittedSeq === original.submittedSeq);
        const target = conversationPendingTarget(pending);
        const actionId = conversationPendingActionId(pending);
        const planId = pending.kind === "proposal-work-plan" || pending.kind === "work-plan-start" || pending.kind === "work-plan-control"
          ? pending.request.planId : pending.kind === "team-question-response" ? pending.request.planId
            : pending.kind === "team-message" || pending.kind === "team-publication" ? pending.request.lease.planId
            : pending.kind === "team-recovery" ? pending.request.recovery.planId : null;
        match(target.projectId === ctx.projectId && target.conversationId === conversationId && actionId === original.actionId && planMatches(planId));
      }
      return { kind: "conversation-request", conversationId, slot: original.slot, actionId: original.actionId };
    }
    default: return { kind: "details" };
  }
}
