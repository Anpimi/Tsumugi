export interface ExecutionRecoveryTarget { taskId: string; attemptId: string; itemId: string; operation: string }
export interface ExecutionRecoveryOwners {
  source: readonly (string | null | undefined)[];
  delivery: readonly (string | null | undefined)[];
  review: readonly string[];
}

/** An operation name alone cannot establish ownership of an original attempt. */
export function executionRecoveryDestination(target: ExecutionRecoveryTarget, owners: ExecutionRecoveryOwners) {
  if ((target.operation === "source-import" || target.operation === "source-semantic-check") && owners.source.includes(target.attemptId)) return "source";
  if ((target.operation === "locale-build" || target.operation === "artifact-semantic-check") && owners.delivery.includes(target.attemptId)) return "delivery";
  if (target.operation === "ai-semantic-review" && owners.review.includes(target.attemptId)) return "review";
  return null;
}
