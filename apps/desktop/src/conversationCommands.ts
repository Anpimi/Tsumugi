import { checkedInvoke } from "./ipc";
import { sameAiConfig } from "./aiCommands";
import { sameExecutionIds } from "./executionCommands";
import { jsonIdentity } from "./pluginToolChoices";
import type { Requests } from "./generated/conversations.requests";
import type { Responses } from "./generated/conversations.responses";
import { validateResponseConversation, validateResponsePage, validateResponseMessage, validateResponseMessagePage, validateResponseCreateRecovery, validateResponseMessageRecovery, validateResponsePlanning, validateResponsePlanningReceipt, validateResponsePlanningRecovery, validateResponsePlanningRun } from "./generated/conversations.validators";
import { validateResponseProposal, validateResponseProposalPage, validateResponseProposalCaptureRecovery, validateResponseProposalRevisionRecovery } from "./generated/conversations.validators";

export type { ProjectConversation, ProjectConversationMessage, ProjectConversationPage, ProjectConversationMessagePage,
  ProjectConversationCreateRecovery, ProjectConversationMessageRecovery } from "./generated/conversations.responses";
export type ConversationCreateRequest = Requests["create"];
export type ConversationAppendRequest = Requests["append"];
export type ConversationPlanningRequest = Requests["preparePlanning"];
export type PreparedConversationPlanning = Responses["planning"];
export type ConversationPlanningConsent = Requests["startPlanning"]["consent"];
export type ConversationPlanningReceipt = Responses["planningReceipt"];
export type ConversationPlanningRun = NonNullable<Responses["planningRun"]>;
export type ConversationProposalRevision = Responses["proposal"];
const bytes = new TextEncoder();
const bounded = (value: unknown) => bytes.encode(JSON.stringify(value)).length <= 256 * 1024;
function conversation(value: Responses["conversation"], projectId: string, conversationId?: string) {
  return value.projectId === projectId && (conversationId === undefined || value.conversationId === conversationId)
    && BigInt(value.ordinal) > 0n && (value.title === null || value.title.length > 0 && bytes.encode(value.title).length <= 128);
}
function message(value: Responses["message"], projectId: string, conversationId: string) {
  return value.projectId === projectId && value.conversationId === conversationId && BigInt(value.ordinal) > 0n
    && value.author === "human" && value.body.length > 0 && bytes.encode(value.body).length <= 8192;
}
function created(value: Responses["conversation"], request: Requests["create"]) {
  return conversation(value, request.projectId, request.conversationId) && value.title === request.title;
}
function appended(value: Responses["message"], request: Requests["append"]) {
  return message(value, request.projectId, request.conversationId) && value.messageId === request.messageId && value.body === request.body;
}
function page<T extends { ordinal: string }>(value: { rows: T[]; nextAfter: string | null }, request: { after?: string | null; limit: number }) {
  return value.rows.length <= request.limit && value.rows.every((item, index) => BigInt(item.ordinal) > BigInt(index ? value.rows[index - 1].ordinal : request.after ?? "0"))
    && (value.nextAfter === null || value.rows.length > 0 && value.nextAfter === value.rows.at(-1)?.ordinal) && bounded(value);
}

function planningPreview(preview: Responses["planning"]["preview"], request: Requests["preparePlanning"]) {
  return preview.version === 2 && preview.projectId === request.projectId && preview.conversationId === request.conversationId
    && sameAiConfig(preview.config, request.config) && jsonIdentity(preview.scope) === jsonIdentity(request.scope)
    && preview.selectedMessages.length >= 1 && preview.selectedMessages.length <= 16
    && sameExecutionIds(preview.selectedMessages.map(item => item.messageId), request.selectedMessageIds)
    && preview.selectedMessages.every((item, index) => message(item, request.projectId, request.conversationId)
      && (index === 0 || BigInt(item.ordinal) > BigInt(preview.selectedMessages[index - 1].ordinal)))
    && (request.scope.kind === "conversation-only" ? preview.units.length === 0 : preview.units.length === request.scope.unitIds.length
      && preview.units.every((unit, index) => unit.unitId === (request.scope.kind === "units" ? request.scope.unitIds[index] : undefined)
        && unit.protection.unitId === unit.unitId && unit.protection.locale === (request.scope.kind === "units" ? request.scope.locale : undefined)))
    && preview.brief.messages === preview.selectedMessages.length && preview.brief.units === preview.units.length
    && preview.brief.sourceTexts === preview.units.length && preview.system.length > 0 && preview.input.length > 0
    && preview.byteLength <= 32768 && preview.byteLength === bytes.encode(JSON.stringify({ system: preview.system, input: preview.input })).length
    && bounded(preview);
}

function planningReceipt(value: Responses["planningReceipt"], request: { projectId: string; conversationId: string; consent: Requests["startPlanning"]["consent"] }) {
  return value.projectId === request.projectId && value.conversationId === request.conversationId
    && jsonIdentity(value.consent) === jsonIdentity(request.consent) && value.consent.actionId === value.consent.attemptId
    && /^[0-9a-f]{64}$/.test(value.inputDigest) && /^[0-9a-f]{64}$/.test(value.consent.previewDigest)
    && BigInt(value.consent.expiresAtMs) > 0n && value.consent.shareMessages;
}
function planningRun(value: NonNullable<Responses["planningRun"]>, request: Requests["readPlanning"]) {
  const { receipt, preview, detail, budget } = value;
  const item = detail.items[0];
  const model = value.output?.model;
  if (model?.kind === "proposal" && (preview.scope.kind !== "units" || model.unitIds.length === 0
    || new Set(model.unitIds).size !== model.unitIds.length || model.unitIds.some(id => !preview.units.some(unit => unit.unitId === id)))) return false;
  return planningReceipt(receipt, { ...request, consent: receipt.consent }) && receipt.consent.attemptId === request.attemptId
    && receipt.consent.shareUnits === (preview.scope.kind === "units")
    && planningPreview(preview, { ...request, config: preview.config, scope: preview.scope, selectedMessageIds: preview.selectedMessages.map(message => message.messageId) })
    && detail.attemptId === request.attemptId && detail.taskId === receipt.consent.taskId && detail.operation === "conversation-planning"
    && detail.progress.total === 1 && detail.items.length === 1 && !!item && item.status.itemId === receipt.consent.actionId
    && item.scope.kind === "project-conversation" && item.scope.id === request.conversationId
    && (item.scope.locale ?? null) === (preview.scope.kind === "units" ? preview.scope.locale : null)
    && item.resultId === value.resultId && detail.recovery.attemptId === request.attemptId
    && detail.recovery.units.every(unit => unit.actions.length === 0) && budget !== null && budget.limit === 1 && budget.dispatched <= 1
    && (value.output === null || value.resultId !== null && item.status.execution === "succeeded" && item.status.validation === "valid"
      && value.output.requests === 1 && (value.output.usage !== null || value.output.usageIncomplete))
    && bounded(value);
}

function proposal(value: Responses["proposal"], request: { projectId: string; conversationId: string; proposalId?: string; revisionId?: string | null }) {
  const content = value.content;
  return value.projectId === request.projectId && value.conversationId === request.conversationId
    && (request.proposalId === undefined || value.proposalId === request.proposalId)
    && (request.revisionId == null || value.revisionId === request.revisionId)
    && BigInt(value.revision) > 0n && BigInt(value.ordinal) > 0n
    && (value.previousRevisionId === null ? value.revision === "1" : BigInt(value.revision) > 1n && value.previousRevisionId !== value.revisionId)
    && /^[0-9a-f]{64}$/.test(value.origin.inputDigest) && /^[0-9a-f]{64}$/.test(value.origin.resultDigest)
    && content.kind === "proposal" && content.unitIds.length >= 1 && content.unitIds.length <= 100
    && new Set(content.unitIds).size === content.unitIds.length
    && content.summary.length > 0 && bytes.encode(content.summary).length <= 8192
    && content.questions.length <= 8 && content.questions.every(question => question.length > 0 && bytes.encode(question).length <= 2048)
    && bounded(value);
}
function capturedProposal(value: Responses["proposal"], request: Requests["captureProposal"]) {
  return proposal(value, request) && value.revision === "1" && value.previousRevisionId === null
    && value.origin.attemptId === request.attemptId && value.origin.resultId === request.resultId;
}
function revisedProposal(value: Responses["proposal"], request: Requests["reviseProposal"]) {
  return proposal(value, request) && value.previousRevisionId === request.expectedRevisionId
    && jsonIdentity(value.content) === jsonIdentity(request.content);
}
function originalRequest<T extends { sessionToken: string }>(request: T) {
  const { sessionToken: _sessionToken, ...original } = request;
  return original;
}

/** Project conversations, explicit planning permission and original-action history. */
export const conversationCommands = {
  captureProposal: (request: Requests["captureProposal"]) => checkedInvoke("capture_conversation_proposal", request,
    (value): value is Responses["proposal"] => validateResponseProposal(value) && capturedProposal(value, request)),
  reviseProposal: (request: Requests["reviseProposal"]) => checkedInvoke("revise_conversation_proposal", request,
    (value): value is Responses["proposal"] => validateResponseProposal(value) && revisedProposal(value, request)),
  readProposal: (request: Requests["readProposal"]) => checkedInvoke("read_conversation_proposal", request,
    (value): value is Responses["proposal"] => validateResponseProposal(value) && proposal(value, request)),
  proposalRevisions: (request: Requests["proposalRevisions"]) => checkedInvoke("read_conversation_proposal_revisions", request,
    (value): value is Responses["proposalPage"] => validateResponseProposalPage(value) && value.projectId === request.projectId
      && value.conversationId === request.conversationId && page(value, request)
      && new Set(value.rows.map(row => row.revisionId)).size === value.rows.length && value.rows.every(row => proposal(row, request))),
  validateProposal: (request: Requests["validateProposal"]) => checkedInvoke("validate_conversation_proposal", request,
    (value): value is Responses["proposal"] => validateResponseProposal(value) && proposal(value, request)),
  recoverProposalCapture: (request: Requests["recoverProposalCapture"]) => checkedInvoke("recover_conversation_proposal_capture", request,
    (value): value is Responses["proposalCaptureRecovery"] => validateResponseProposalCaptureRecovery(value)
      && jsonIdentity(value.request) === jsonIdentity(originalRequest(request))
      && (value.outcome.kind !== "recorded" || capturedProposal(value.outcome.receipt, request))),
  recoverProposalRevision: (request: Requests["recoverProposalRevision"]) => checkedInvoke("recover_conversation_proposal_revision", request,
    (value): value is Responses["proposalRevisionRecovery"] => validateResponseProposalRevisionRecovery(value)
      && jsonIdentity(value.request) === jsonIdentity(originalRequest(request))
      && (value.outcome.kind !== "recorded" || revisedProposal(value.outcome.receipt, request))),
  startPlanning: (request: Requests["startPlanning"]) => checkedInvoke("start_conversation_planning", request,
    (value): value is Responses["planningReceipt"] => validateResponsePlanningReceipt(value) && planningReceipt(value, request)),
  recoverPlanning: (request: Requests["recoverPlanning"]) => checkedInvoke("recover_conversation_planning", request,
    (value): value is Responses["planningRecovery"] => validateResponsePlanningRecovery(value)
      && value.request.projectId === request.projectId && value.request.conversationId === request.conversationId
      && jsonIdentity(value.request.consent) === jsonIdentity(request.consent)
      && (value.outcome.kind === "recorded" ? planningReceipt(value.outcome.receipt, request)
        : value.outcome.kind === "mismatch" || value.outcome.replay === "blocked")),
  readPlanning: (request: Requests["readPlanning"]) => checkedInvoke("read_conversation_planning", request,
    (value): value is Responses["planningRun"] => validateResponsePlanningRun(value) && (value === null || planningRun(value, request))),
  preparePlanning: (request: Requests["preparePlanning"]) => checkedInvoke("prepare_conversation_planning", request,
    (value): value is Responses["planning"] => validateResponsePlanning(value) && /^[0-9a-f]{64}$/.test(value.previewDigest) && planningPreview(value.preview, request)),
  validatePlanning: (request: Requests["validatePlanning"], expected: Responses["planning"]) => checkedInvoke("validate_conversation_planning", request,
    (value): value is Responses["planning"] => validateResponsePlanning(value) && value.preparationId === request.preparationId
      && expected.preparationId === request.preparationId && expected.preview.projectId === request.projectId
      && jsonIdentity(value) === jsonIdentity(expected)),
  create: (request: Requests["create"]) => checkedInvoke("create_project_conversation", request,
    (value): value is Responses["conversation"] => validateResponseConversation(value) && created(value, request)),
  list: (request: Requests["list"]) => checkedInvoke("list_project_conversations", request,
    (value): value is Responses["page"] => validateResponsePage(value) && value.projectId === request.projectId && page(value, request)
      && new Set(value.rows.map(item => item.conversationId)).size === value.rows.length && value.rows.every(item => conversation(item, request.projectId))),
  read: (request: Requests["read"]) => checkedInvoke("read_project_conversation", request,
    (value): value is Responses["conversation"] => validateResponseConversation(value) && conversation(value, request.projectId, request.conversationId)),
  messages: (request: Requests["messages"]) => checkedInvoke("read_project_conversation_messages", request,
    (value): value is Responses["messagePage"] => validateResponseMessagePage(value) && value.projectId === request.projectId
      && value.conversationId === request.conversationId && page(value, request)
      && new Set(value.rows.map(item => item.messageId)).size === value.rows.length && value.rows.every(item => message(item, request.projectId, request.conversationId))),
  append: (request: Requests["append"]) => checkedInvoke("append_project_conversation_message", request,
    (value): value is Responses["message"] => validateResponseMessage(value) && appended(value, request)),
  recoverCreate: (request: Requests["recoverCreate"]) => checkedInvoke("recover_project_conversation_create", request,
    (value): value is Responses["createRecovery"] => validateResponseCreateRecovery(value)
      && value.request.projectId === request.projectId && value.request.actionId === request.actionId
      && value.request.conversationId === request.conversationId && value.request.title === request.title
      && (value.outcome.kind !== "recorded" || created(value.outcome.receipt, request))),
  recoverMessage: (request: Requests["recoverMessage"]) => checkedInvoke("recover_project_conversation_message", request,
    (value): value is Responses["messageRecovery"] => validateResponseMessageRecovery(value)
      && value.request.projectId === request.projectId && value.request.actionId === request.actionId
      && value.request.conversationId === request.conversationId && value.request.messageId === request.messageId && value.request.body === request.body
      && (value.outcome.kind !== "recorded" || appended(value.outcome.receipt, request))),
};
