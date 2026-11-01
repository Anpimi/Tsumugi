/** Shared discovery metadata. These commands prepare input; they never execute work. */
export const assistantComposerCommands = [
  { id: "conversation.translate", nameKey: "conversation.commandTranslate", binding: null, aliases: ["/翻译", "/translate"] },
  { id: "conversation.review", nameKey: "conversation.commandReview", binding: null, aliases: ["/审校", "/review"] },
  { id: "conversation.explain", nameKey: "conversation.commandExplain", binding: null, aliases: ["/解释", "/explain"] },
  { id: "conversation.rerun", nameKey: "conversation.commandRerun", binding: null, aliases: ["/重跑", "/rerun"] },
  { id: "conversation.terms", nameKey: "conversation.commandTerms", binding: null, aliases: ["/术语", "/terms"] },
] as const;
export type AssistantComposerCommand = typeof assistantComposerCommands[number];

export function composerCommand(text: string): AssistantComposerCommand | null {
  const token = text.trimStart().split(/\s/u, 1)[0];
  return assistantComposerCommands.find(command => command.aliases.some(alias => alias === token)) ?? null;
}
