import { defaultAiConfig, type AiConfig } from "../../../aiCommands";
import type { CommandFailure } from "../../../CommandFailure";
import type { conversationCommands, ConversationProposalRevision } from "../../../conversationCommands";
import type { PlanToolChoiceHandle, PlanToolDraft } from "../../../WorkPlanToolChoice";
import type { PluginTextReviewSelection } from "../../../pluginCommands";
import type { WorkPlanExecutionConsent } from "../../../WorkPlanExecutionReview";

export type ProposalWorkPlanPrepared = Awaited<ReturnType<typeof conversationCommands.prepareProposalWorkPlan>>;
export type ProposalWorkPlanTools = ReturnType<PlanToolChoiceHandle["capture"]>;
export type ProposalWorkPlanConfirmation = Pick<Parameters<typeof conversationCommands.authorizeProposalWorkPlan>[0]["authorization"],
  "checkerExecutions" | "toolExecution" | "applicationToolExecutions" | "effects">;
export interface ConversationWorkPlanInput {
  open: boolean;
  sequence: number;
  revision: ConversationProposalRevision | null;
  config: AiConfig;
  toolDraft: PlanToolDraft | null;
  advisoryChecks: PluginTextReviewSelection[];
  prepared: ProposalWorkPlanPrepared | null;
  consent: boolean;
  executionConsent: WorkPlanExecutionConsent;
  minutes: number;
  busy: "prepare" | "authorize" | null;
  failure: CommandFailure | null;
}
export const emptyExecutionConsent = (): WorkPlanExecutionConsent => ({ checkers: [], tools: null, applications: [] });
export function workPlanInput(): ConversationWorkPlanInput {
  return { open: false, sequence: 0, revision: null, config: structuredClone(defaultAiConfig), toolDraft: null, advisoryChecks: [],
    prepared: null, consent: false, executionConsent: emptyExecutionConsent(), minutes: 60, busy: null, failure: null };
}
export function workPlanMinutesValid(minutes: number) { return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440; }
