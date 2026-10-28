import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { jsonIdentity } from "./pluginToolChoices";
import type { ContentScope } from "./sourceCommands";
import type { ContextResourceAction, ContextResourceKind, ContextResourceRevision, ContextResourceScope, SaveContextResource } from "./resourceCommands";
import type { ResourceDraftState, ResourcePending } from "./ResourceDraftSession";

export interface ContextResourceDraft {
  key: string;
  contextId: string | null;
  subjectId: string | null;
  kind: ContextResourceKind;
  locale: string;
  base: ContextResourceRevision | null;
  sourceBasis: ContentScope;
  scope: ContextResourceScope;
  name: string;
  text: string;
  actor: string;
  reason: string;
  editSeq: number;
  restoring: boolean;
  notice: "saved" | "saved-newer" | null;
  failure: CommandFailure | null;
}
export type TypedResourcePending = Extract<ResourcePending, { kind: "typed-context" }>;
export type ContextResourceFields = Pick<ContextResourceDraft, "scope" | "name" | "text" | "actor" | "reason">;
const fields = (value: ContextResourceFields) => ({ scope: value.scope, name: value.name, text: value.text, actor: value.actor, reason: value.reason });
export function contextResourceDirty(value: ContextResourceDraft) {
  return value.restoring || (value.base ? jsonIdentity(fields(value)) !== jsonIdentity(fields(value.base))
    : !!value.name || !!value.text || !!value.actor || !!value.reason || value.scope.kind !== "project");
}
export function contextResourceAction(action: TypedResourcePending): ContextResourceAction {
  return action.operation === "save" ? { kind: "save", request: action.request } : { kind: "withdraw", request: action.request };
}
export function confirmContextResource(action: TypedResourcePending, revision: ContextResourceRevision, prior?: ContextResourceRevision | null) {
  const request = action.request;
  if (revision.projectId !== request.projectId || revision.actionId !== request.actionId || revision.previousRevisionId !== (request.expectedRevisionId ?? null)
    || request.contextId != null && revision.contextId !== request.contextId || revision.actor !== request.actor || revision.reason !== request.reason
    || revision.withdrawn !== (action.operation === "withdraw")) throw new Error("Invalid context resource acknowledgement");
  if (action.operation === "save") {
    const saved = action.request;
    if (saved.subjectId != null && saved.subjectId !== revision.subjectId || saved.kind !== revision.kind || saved.locale !== revision.locale
      || saved.name !== revision.name || saved.text !== revision.text || jsonIdentity(saved.scope) !== jsonIdentity(revision.scope)
      || jsonIdentity(saved.sourceBasis) !== jsonIdentity(revision.sourceBasis)) throw new Error("Invalid context resource content acknowledgement");
  } else if (!prior || prior.subjectId !== revision.subjectId || prior.kind !== revision.kind || prior.locale !== revision.locale || prior.name !== revision.name
    || prior.text !== revision.text || jsonIdentity(prior.scope) !== jsonIdentity(revision.scope) || jsonIdentity(prior.sourceBasis) !== jsonIdentity(revision.sourceBasis)) {
    throw new Error("Invalid context withdrawal content");
  }
}
export function settleContextResource(before: ResourceDraftState, action: TypedResourcePending, revision: ContextResourceRevision): ResourceDraftState {
  if (before.pending !== action) return before;
  const draft = before.typedDrafts[action.draftKey];
  if (!draft) throw new Error("A submitted context draft must be retained");
  confirmContextResource(action, revision, draft.base);
  const unchanged = draft.editSeq === action.submittedSeq && jsonIdentity(fields(draft)) === jsonIdentity(fields(revision));
  const next: ContextResourceDraft = { ...draft, base: revision, contextId: revision.contextId, subjectId: revision.subjectId,
    ...(unchanged ? { ...fields(revision), sourceBasis: revision.sourceBasis } : {}), restoring: false,
    notice: unchanged ? "saved" : "saved-newer", failure: null };
  return { ...before, typedDrafts: { ...before.typedDrafts, [draft.key]: next }, pending: null, pendingUncertain: false, pendingRecorded: false, pendingCheckedMissing: false,
    checkingAction: null, notice: null, failure: null, completionVersion: before.completionVersion + 1 };
}

/** Drafts and actions remain in ResourceDraftSession; these methods add typed editing semantics. */
export function createContextResourceMethods(access: {
  session: SessionRequest;
  live: () => boolean;
  current: () => ResourceDraftState;
  update: (change: (before: ResourceDraftState) => ResourceDraftState) => void;
  reserve: () => boolean;
  release: () => void;
  dispatch: (action: TypedResourcePending) => Promise<void>;
}) {
  const { current, update } = access;
  function patch(key: string, change: (draft: ContextResourceDraft) => ContextResourceDraft) {
    update(before => before.typedDrafts[key] ? { ...before, typedDrafts: { ...before.typedDrafts, [key]: change(before.typedDrafts[key]) } } : before);
  }
  function begin(kind: ContextResourceKind, locale: string, sourceBasis: ContentScope, revision: ContextResourceRevision | null = null, variant = false) {
    if (!access.live() || sourceBasis.currentSnapshot === null && !revision || revision && (revision.kind !== kind || revision.locale !== locale || revision.projectId !== access.session.projectId)) return null;
    const retained = !variant && revision ? Object.values(current().typedDrafts).find(draft => draft.contextId === revision.contextId) : undefined;
    if (retained) { if (revision?.withdrawn) patch(retained.key, draft => ({ ...draft, restoring: true, editSeq: draft.editSeq + 1 })); activate(retained.key); return retained.key; }
    const key = !variant && revision ? revision.contextId : `new:${crypto.randomUUID()}`;
    const draft: ContextResourceDraft = { key, contextId: variant ? null : revision?.contextId ?? null, subjectId: revision?.subjectId ?? null, kind, locale,
      base: variant ? null : revision, sourceBasis: structuredClone(sourceBasis), scope: structuredClone(revision?.scope ?? { kind: "project" }),
      name: revision?.name ?? "", text: revision?.text ?? "", actor: revision?.actor ?? "", reason: variant ? "" : revision?.reason ?? "", editSeq: 0,
      restoring: revision?.withdrawn === true && !variant, notice: null, failure: null };
    update(before => ({ ...before, typedDrafts: { ...before.typedDrafts, [key]: draft }, typedActiveKey: key })); return key;
  }
  function activate(key: string) { if (current().typedDrafts[key]) update(before => ({ ...before, typedActiveKey: key })); }
  function edit(key: string, values: Partial<ContextResourceFields>) { patch(key, draft => ({ ...draft, ...values, editSeq: draft.editSeq + 1, notice: null })); }
  function discard(key: string) {
    const state = current(); if (state.pending?.kind === "typed-context" && state.pending.draftKey === key || state.busyMutation) return false;
    update(before => { const drafts = { ...before.typedDrafts }; delete drafts[key]; return { ...before, typedDrafts: drafts, typedActiveKey: before.typedActiveKey === key ? null : before.typedActiveKey }; }); return true;
  }
  function adoptCurrent(key: string, revision: ContextResourceRevision, expected: string, sequence: number) {
    const draft = current().typedDrafts[key];
    if (!draft || current().pending || current().busyMutation || draft.editSeq !== sequence || draft.base?.revisionId !== expected || draft.contextId !== revision.contextId
      || draft.kind !== revision.kind || draft.locale !== revision.locale || revision.projectId !== access.session.projectId) return false;
    patch(key, value => ({ ...value, base: revision, subjectId: revision.subjectId, editSeq: value.editSeq + 1, notice: null, failure: null })); return true;
  }
  function adoptSource(key: string, sourceBasis: ContentScope, sequence: number) {
    const draft = current().typedDrafts[key];
    if (!draft || !sourceBasis.currentSnapshot || current().pending || current().busyMutation || draft.editSeq !== sequence) return false;
    patch(key, value => ({ ...value, sourceBasis: structuredClone(sourceBasis), editSeq: value.editSeq + 1, failure: null, notice: null })); return true;
  }
  async function submit(key: string, operation: "save" | "withdraw", proof: () => boolean) {
    const draft = current().typedDrafts[key];
    if (!draft || !proof() || !access.reserve()) return;
    const start = structuredClone(draft);
    try {
      const actionId = await executionCommands.identity(access.session);
      if (!access.live() || !proof() || !current().typedDrafts[key]) return;
      if (operation === "withdraw") {
        if (!start.base || start.base.withdrawn) return;
        await access.dispatch({ kind: "typed-context", operation, draftKey: key, submittedSeq: start.editSeq, session: access.session,
          request: { projectId: access.session.projectId, actionId, contextId: start.base.contextId, expectedRevisionId: start.base.revisionId, actor: start.actor, reason: start.reason } });
      } else {
        const request: SaveContextResource = { projectId: access.session.projectId, actionId, contextId: start.contextId, subjectId: start.subjectId,
          expectedRevisionId: start.base?.revisionId ?? null, sourceBasis: start.sourceBasis, kind: start.kind, locale: start.locale, ...fields(start) };
        await access.dispatch({ kind: "typed-context", operation, draftKey: key, submittedSeq: start.editSeq, session: access.session, request });
      }
    } catch (error) { patch(key, value => ({ ...value, failure: commandFailure(error) })); }
    finally { access.release(); }
  }
  return { begin, activate, edit, discard, adoptCurrent, adoptSource, save: (key: string, proof: () => boolean) => submit(key, "save", proof),
    withdraw: (key: string, proof: () => boolean) => submit(key, "withdraw", proof), hasDrafts: () => Object.values(current().typedDrafts).some(contextResourceDirty) };
}
