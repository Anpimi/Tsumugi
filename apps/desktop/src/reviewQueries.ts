import { reviewCommands } from "./reviewCommands";
import type { SessionRequest } from "./executionCommands";
import type { ChangeScope } from "./sessionReads";

export const reviewFindingsKey = (unitId: string, locale: string, offset = 0) => ["review-findings", unitId, locale, offset, 20] as const;
export function reviewFindingsRead(session: SessionRequest, unitId: string, locale: string, offset = 0) {
  return { key: reviewFindingsKey(unitId, locale, offset), scopes: ["source", "translation", "resources", "review"] as ChangeScope[],
    read: () => reviewCommands.findings({ ...session, unitId, locale, offset, limit: 20 }) };
}
