import type { DecisionDeliveryActivity } from "./generated/decisions.responses";

/** A preview has no write action; export and explicit reconciliation do. */
export function validDeliveryActivity(job: DecisionDeliveryActivity): boolean {
  return job.kind === "preview" ? job.actionId === null : job.actionId !== null;
}
