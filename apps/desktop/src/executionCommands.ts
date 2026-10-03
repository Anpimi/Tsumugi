import { invoke } from "@tauri-apps/api/core";
import type { CommandError, ProjectView } from "./projectCommands";

export interface SessionRequest { sessionToken: string; projectId: string }
export const executionContext = (project: ProjectView): SessionRequest => ({ sessionToken: project.sessionToken, projectId: project.metadata.projectId });
export interface ListRequest extends SessionRequest { after: string; limit: number }
export interface TaskRequest extends ListRequest { taskId: string }
export interface AttemptRequest extends SessionRequest { attemptId: string; offset: number; limit: number }
export interface OutputRequest extends SessionRequest { attemptId: string; resultId: string }
export interface CancelRequest extends SessionRequest { taskId: string; requestId: string }
export type RecoveryAction = "resume-undispatched" | "retry-safe-failure" | "validate-output" | "adopt-result" | "query-outcome" | "view-receipt";
export interface RecoveryRequest extends SessionRequest { attemptId: string; unitId: string; action: RecoveryAction; itemIds: string[] }
export interface PrepareRequest extends SessionRequest { attemptId: string; unitId: string; actionId: string; resultIds: string[] }
export interface AdoptRequest extends SessionRequest { actionId: string }
export interface Task { taskId: string; projectId: string; operation: string; sequence: string; cancellationRevision: string }
export interface AttemptSummary { attemptId: string; sequence: string }
export type ExecutionState = "queued" | "dispatched" | "succeeded" | "failed" | "cancelled-before-dispatch" | "unknown";
export interface ItemStatus { itemId: string; execution: ExecutionState; validation: "absent" | "pending" | "valid" | "invalid"; adoption: "unapplied" | "committed" | "conflict" | "rejected"; cancellationRequested: boolean; retrySafe: boolean; diagnostic: string | null }
export interface Scope { kind: string; id: string; locale: string | null }
export interface ItemView { status: ItemStatus; scope: Scope; resultId: string | null }
export interface Progress { total: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number; unknown: number; adopted: number }
export interface RecoveryUnit { unitId: string; itemIds: string[]; scopes: Scope[]; remainingItemIds: string[]; resultIds: string[]; actions: RecoveryAction[]; blockedReason: string | null; receiptId: string | null }
export interface AttemptDetail { attemptId: string; taskId: string; operation: string; progress: Progress; items: ItemView[]; recovery: { attemptId: string; units: RecoveryUnit[] }; nextOffset: number | null }
export type { RuntimeStatus } from "./generated/responses";
import type { RuntimeStatus } from "./generated/responses";
export interface RecoveryView { attemptId: string; queryStarted: boolean }
export interface AdoptionAction { projectId: string; attemptId: string; actionId: string; unitId: string; operation: string; resultIds: string[]; cancellationRevision: string; parameters: unknown }
export interface Receipt { projectId: string; attemptId: string; actionId: string; unitId: string; requestDigest: string; changes: { kind: string; id: string; revision: string }[] }
export interface ResultEnvelope { projectId: string; attemptId: string; itemId: string; resultId: string; supersedes: string | null; dispatchToken: string; capabilityId: string; capabilityVersion: string; outcome: ExecutionState; output: unknown; diagnostic: { code: string; retrySafe: boolean } | null }

export const executionCommands = {
  identity: (request: SessionRequest) => invoke<string>("create_execution_identity", { request }),
  status: (request: SessionRequest) => invoke<RuntimeStatus>("execution_status", { request }),
  list: (request: ListRequest) => invoke<Task[]>("list_execution_tasks", { request }),
  task: (request: TaskRequest) => invoke<AttemptSummary[]>("read_execution_task", { request }),
  attempt: (request: AttemptRequest) => invoke<AttemptDetail>("read_execution_attempt", { request }),
  output: (request: OutputRequest) => invoke<ResultEnvelope>("read_execution_output", { request }),
  cancel: (request: CancelRequest) => invoke<string>("cancel_execution_task", { request }),
  recover: (request: RecoveryRequest) => invoke<RecoveryView>("recover_execution", { request }),
  prepare: (request: PrepareRequest) => invoke<AdoptionAction>("prepare_execution_adoption", { request }),
  adopt: (request: AdoptRequest) => invoke<Receipt>("adopt_execution", { request }),
  receipt: (request: AdoptRequest) => invoke<Receipt | null>("read_execution_receipt", { request }),
  quiesce: (request: SessionRequest) => invoke<RuntimeStatus>("quiesce_execution", { request }),
};
