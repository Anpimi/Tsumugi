import { checkedInvoke } from "./ipc";
import type { Requests } from "./generated/conversations.requests";
import type { Responses } from "./generated/conversations.responses";
import { validateResponseConversation, validateResponsePage, validateResponseMessage, validateResponseMessagePage, validateResponseCreateRecovery, validateResponseMessageRecovery } from "./generated/conversations.validators";

export type { ProjectConversation, ProjectConversationMessage, ProjectConversationPage, ProjectConversationMessagePage,
  ProjectConversationCreateRecovery, ProjectConversationMessageRecovery } from "./generated/conversations.responses";
export type ConversationCreateRequest = Requests["create"];
export type ConversationAppendRequest = Requests["append"];
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

/** Human messages are local records. These commands never authorize a model or start a task. */
export const conversationCommands = {
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
