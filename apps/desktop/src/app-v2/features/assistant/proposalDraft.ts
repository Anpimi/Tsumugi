import { isConversationMessageText, type ConversationPlanningRun } from "../../../conversationCommands";
import type { ConversationProposalDraft } from "../../../conversationDraftCommands";
import { jsonIdentity, queryField } from "../../../pluginToolChoices";
import { proposalTeamProblem } from "./proposalRecipe";

export type ProposalContent = Extract<ConversationProposalDraft["content"], { kind: "proposal" | "knowledge-proposal" | "term-proposal" }>;
export type KnowledgeProposalContent = Extract<ProposalContent, { kind: "knowledge-proposal" }>;
const bytes = new TextEncoder();
export function validProposalQuestion(text: string) { return isConversationMessageText(text) && bytes.encode(text).length <= 2048; }
export function editableProposal(content: ConversationProposalDraft["content"]): content is ProposalContent {
  return content.kind === "proposal" || content.kind === "knowledge-proposal" || content.kind === "term-proposal";
}
export function validKnowledgeName(text: string) { return !!text.trim() && !text.includes("\0") && bytes.encode(text).length <= 512; }
export function validKnowledgeText(text: string) { return !!text.trim() && !text.includes("\0") && bytes.encode(text).length <= 16384; }
export function validProposalContent(content: ConversationProposalDraft["content"], run?: ConversationPlanningRun | null) {
  if (!editableProposal(content) || !isConversationMessageText(content.summary) || content.questions.length > 8 || !content.questions.every(validProposalQuestion)) return false;
  const validUnits = (unitIds: readonly string[]) => unitIds.length > 0 && unitIds.length <= 100 && new Set(unitIds).size === unitIds.length
    && (!run || run.preview.scope.kind === "units" && unitIds.every(id => run.preview.units.some(unit => unit.unitId === id)));
  if (content.kind === "term-proposal") return content.entries.length > 0 && content.entries.length <= 16
    && bytes.encode(JSON.stringify(content)).length <= 60 * 1024 && (!run || run.preview.purpose === "terminology"
      && run.output?.model.kind === "term-proposal" && jsonIdentity(content.entries) === jsonIdentity(run.output.model.entries));
  return content.kind === "proposal" ? validUnits(content.unitIds) && !proposalTeamProblem(content.options, content.unitIds) && (!run || run.preview.purpose == null)
    : content.entries.length > 0 && content.entries.length <= 16 && bytes.encode(JSON.stringify(content)).length <= 65536
      && content.entries.every(entry => validKnowledgeName(entry.name) && validKnowledgeText(entry.text) && validUnits(entry.unitIds))
      && (!run || run.preview.purpose === "knowledge");
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
