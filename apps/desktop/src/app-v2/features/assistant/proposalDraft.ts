import { isConversationMessageText, type ConversationPlanningRun } from "../../../conversationCommands";
import type { ConversationProposalDraft } from "../../../conversationDraftCommands";
import { queryField } from "../../../pluginToolChoices";

export type ProposalContent = Extract<ConversationProposalDraft["content"], { kind: "proposal" }>;
const bytes = new TextEncoder();
export function validProposalQuestion(text: string) { return isConversationMessageText(text) && bytes.encode(text).length <= 2048; }
export function validProposalContent(content: ConversationProposalDraft["content"], run?: ConversationPlanningRun | null) {
  return content.kind === "proposal" && isConversationMessageText(content.summary) && content.questions.length <= 8 && content.questions.every(validProposalQuestion)
    && content.unitIds.length > 0 && content.unitIds.length <= 100 && new Set(content.unitIds).size === content.unitIds.length
    && (!run || run.preview.scope.kind === "units" && content.unitIds.every(id => run.preview.units.some(unit => unit.unitId === id)));
}
/** Titles are presentation only. Allowed identities always come from the Core scope. */
export function planningUnitLabels(input: string) {
  const labels = new Map<string, { key: string; text: string }>();
  let value: unknown; try { value = JSON.parse(input); } catch { return labels; }
  const units = queryField(value, ["units"]);
  if (!Array.isArray(units)) return labels;
  for (const unit of units) {
    const id = queryField(unit, ["unitId"]), key = queryField(unit, ["nativeKey"]), text = queryField(unit, ["sourceText"]);
    if (typeof id === "string" && typeof key === "string" && typeof text === "string" && !labels.has(id)) labels.set(id, { key, text });
  }
  return labels;
}
