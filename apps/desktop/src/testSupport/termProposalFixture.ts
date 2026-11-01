import type { ConversationProposalRevision } from "../conversationCommands";
import type { ResourcePreview } from "../resourceCommands";
import { conversationProposalFixture } from "./conversationProposalFixture";

/** Fixed terminology evidence; no external model, capture action or term write. */
export function termProposalFixture(context: { projectId: string; conversationId: string }) {
  const fixture = conversationProposalFixture(context);
  const content: ConversationProposalRevision["content"] = { kind: "term-proposal", summary: "Terminology from the two original entries", questions: [], entries: [
    { unitId: fixture.unitIds[0], source: "Hello", aliases: ["Hi"], target: "你好", protected: true, reason: "Keep this greeting consistent." },
    { unitId: fixture.unitIds[1], source: "dawn", aliases: [], target: "黎明", protected: false, reason: "Retain the time of day." },
  ] };
  fixture.revision.content = content;
  if (!fixture.run.output) throw new Error("A synthetic model result is required");
  fixture.run.output.model = structuredClone(content);
  fixture.run.preview.version = 4; fixture.run.preview.purpose = "terminology";
  fixture.run.preview.system = "Synthetic terminology planning instructions";
  const input = JSON.parse(fixture.run.preview.input);
  fixture.run.preview.input = JSON.stringify({ ...input, purpose: "term-proposal", scope: fixture.run.preview.scope });
  fixture.run.preview.byteLength = new TextEncoder().encode(JSON.stringify({ system: fixture.run.preview.system, input: fixture.run.preview.input })).length;
  return { ...fixture, content, preview: termPreviewFor(fixture.revision) };
}

export function termPreviewFor(revision: ConversationProposalRevision): ResourcePreview {
  if (revision.content.kind !== "term-proposal") throw new Error("A synthetic term proposal is required");
  const proposal = { projectId: revision.projectId, conversationId: revision.conversationId, proposalId: revision.proposalId, revisionId: revision.revisionId };
  return { capture: { captureId: revision.revisionId, sourceLocale: "en-US", targetLocale: "zh-CN", digest: "d".repeat(64), count: revision.content.entries.length,
    origin: { kind: "conversation", proposal, modelOrigin: structuredClone(revision.origin) } },
  rows: revision.content.entries.map((entry, index) => ({ entry: { id: String(index), source: entry.source, aliases: [...entry.aliases], target: entry.target,
    protected: entry.protected, nativeKey: `dialogue.${index + 1}`, reason: entry.reason }, current: null, kind: "added", scopeUnitId: entry.unitId })),
  removed: [], correction: null, mcp: null, conversation: { proposal, modelOrigin: structuredClone(revision.origin), current: revision.content.questions.length === 0 } };
}
