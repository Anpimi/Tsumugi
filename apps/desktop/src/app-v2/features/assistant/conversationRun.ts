import type { CommandFailure } from "../../../CommandFailure";
import type { ConversationDraftRevocation, ConversationDraftPending } from "../../../conversationDraftCommands";
import type { conversationCommands } from "../../../conversationCommands";
import type { WorkPlanControlRequest } from "../../../generated/ai.requests";
import type { WorkPlanReceiptView, WorkPlanStatusView, WorkPlanView } from "../../../workPlanCommands";

export type ConversationPlanLink = Awaited<ReturnType<typeof conversationCommands.proposalWorkPlans>>["rows"][number];
export type ConversationRunPending = Extract<ConversationDraftPending, { kind: "work-plan-start" | "work-plan-control" }>;
export interface ConversationRunReady { plan: WorkPlanView; receipt: WorkPlanReceiptView }
export interface ConversationRunFailure { planId: string; cause: CommandFailure }
export type ConversationRunConfirmation = Pick<WorkPlanControlRequest, "checkerExecutions" | "toolExecution" | "applicationToolExecutions"> & { minutes: number; confirmed: boolean };
export function runMatchesLink(status: WorkPlanStatusView, link: ConversationPlanLink) {
  return status.plan.planId === link.planId && status.lease.planId === link.planId && status.plan.digest === link.planDigest;
}
export function runReadyCurrent(ready: ConversationRunReady | undefined, status: WorkPlanStatusView, nowMs: number) {
  return !!ready && status.state === "active" && ready.receipt.state === "active" && !!ready.receipt.attemptId
    && ready.plan.planId === status.plan.planId && ready.plan.digest === status.plan.digest
    && ready.receipt.lease.planId === status.lease.planId && ready.receipt.lease.generation === status.lease.generation
    && BigInt(status.expiresAt) > BigInt(Math.floor(nowMs / 1000));
}
export function isRunPending(pending: ConversationDraftPending | null | undefined): pending is ConversationRunPending {
  return pending?.kind === "work-plan-start" || pending?.kind === "work-plan-control";
}

export type ConversationRevocationCommand = ConversationDraftRevocation["request"]["command"];
export interface ConversationRevocationState {
  busy: "submit" | "check" | null;
  outcome: "unknown" | "absent" | "blocked" | null;
  failure: CommandFailure | null;
}
export function revocationAllowed(command: ConversationRevocationCommand, state: WorkPlanStatusView["state"]) {
  return state !== "stopped" && (command !== "pause" || state === "active") && (command !== "take-over" || state !== "taken-over");
}
export function revocationControlRequest(request: ConversationDraftRevocation["request"]) {
  return { ...request, confirmed: false, checkerExecutions: [], toolExecution: false, applicationToolExecutions: [], expiresAt: null };
}
