import { defaultAiConfig } from "../aiCommands";
import type { ConversationPlanningRun, ConversationProposalRevision } from "../conversationCommands";
import { fixtureIdentity as id } from "./executionFixture";

/** Synthetic history with no execution permission or external Provider. */
export function conversationProposalFixture(context: { projectId: string; conversationId: string }) {
  const unitIds = [id(33001), id(33002)], snapshot = id(33003), attemptId = id(33004), resultId = id(33006);
  const content: ConversationProposalRevision["content"] = { kind: "proposal", summary: "先保存候选，人工核对后再选用。", unitIds: [unitIds[0]],
    options: { stages: [{ stage: "generation", mode: "assisted" }], selectionPolicy: "candidates-only", advisoryChecks: [], adoptResources: false, deliver: false }, questions: [] };
  const messages = [{ ...context, messageId: id(33009), author: "human" as const, ordinal: "1", body: "请保留人物语气，先给出这两条的候选方案。" }];
  const config = { ...structuredClone(defaultAiConfig), endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "fixture", credentialEnv: "", maxRequests: 1, maxItems: 2 };
  const system = "Synthetic planning instructions", input = JSON.stringify({ messages: messages.map(message => ({ author: message.author, body: message.body })),
    units: unitIds.map((unitId, index) => ({ unitId, nativeKey: `dialogue.${index + 1}`, sourceText: index ? "Leave before dawn." : "Hello, {name}!" })) });
  const consent = { actionId: attemptId, attemptId, taskId: id(33005), previewDigest: "a".repeat(64), expiresAtMs: "1000", shareMessages: true, shareUnits: true };
  const scope = { kind: "project-conversation", id: context.conversationId, locale: "zh-CN" }, unknownTokens = { tokens: "0", unknownRequests: 1 };
  const run: ConversationPlanningRun = { receipt: { ...context, consent, inputDigest: "b".repeat(64) }, preview: { ...context, version: 2, config,
    scope: { kind: "units", locale: "zh-CN", unitIds }, selectedMessages: messages, system, input,
    byteLength: new TextEncoder().encode(JSON.stringify({ system, input })).length,
    units: unitIds.map((unitId, index) => ({ unitId, sourceSnapshotId: snapshot, sourceRevisionId: id(33020 + index), selectionId: null, translationRevisionId: null,
      protection: { unitId, locale: "zh-CN", revision: "0", protected: false }, sharedTermRevisionIds: [], sharedContextRevisionId: null })),
    brief: { messages: 1, units: 2, sourceTexts: 2, terms: 0, manualContexts: 0, manualContextFacts: 0, sourceContextFacts: 0, sourceContextNeighbors: 0 } },
    detail: { attemptId, taskId: consent.taskId, operation: "conversation-planning", nextOffset: null,
      progress: { total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0, adopted: 0 },
      items: [{ scope, resultId, status: { itemId: attemptId, execution: "succeeded", validation: "valid", adoption: "unapplied", cancellationRequested: false, retrySafe: false, diagnostic: null } }],
      recovery: { attemptId, units: [{ unitId: attemptId, itemIds: [attemptId], scopes: [scope], remainingItemIds: [], resultIds: [resultId], actions: [], receiptId: null, blockedReason: "conversation-planning-read-only" }] } },
    budget: { limit: 1, dispatched: 1, legacyHeld: 0, unresolved: 0, usageUnknown: 0, promptTokens: "7", completionTokens: "3", cacheRead: unknownTokens, cacheWrite: unknownTokens, reasoning: unknownTokens },
    resultId, output: { model: content, requests: 1, usageIncomplete: false, usage: { promptTokens: "7", completionTokens: "3", cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null } } };
  const revision: ConversationProposalRevision = { ...context, proposalId: id(33007), revisionId: id(33008), revision: "1", ordinal: "1", previousRevisionId: null,
    origin: { attemptId, resultId, inputDigest: "b".repeat(64), resultDigest: "c".repeat(64) }, content };
  return { run, revision, unitIds };
}
