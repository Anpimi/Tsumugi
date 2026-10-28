import { useSessionInfiniteQuery, useSessionQuery } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type ContextResourceKind, type ContextResourcePage, type SourceFactBasis } from "../../../resourceCommands";
import { sourceCommands, type ContentScope } from "../../../sourceCommands";

export const resourceCurrentKey = (id: string | null) => ["knowledge-context-current", id] as const;
export function useContextResourceCurrent(project: ProjectView, id: string | null, enabled: boolean, expected: { kind: ContextResourceKind; locale: string }) {
  return useSessionQuery({ key: resourceCurrentKey(id), scopes: ["resources"], enabled: enabled && !!id,
    read: async () => { if (!id) throw new Error("A context resource is required"); const value = await resourceCommands.contextResourceCurrent({ ...executionContext(project), contextId: id });
      if (value && (value.contextId !== id || value.projectId !== project.metadata.projectId || value.kind !== expected.kind || value.locale !== expected.locale)) throw new Error("Invalid context resource association"); return value; } });
}
export function useContextResourcePages(project: ProjectView, locale: string, kind: ContextResourceKind, enabled: boolean, historyId?: string) {
  return useSessionInfiniteQuery<ContextResourcePage, { offset: number; basis: string | null }>({ key: historyId ? ["knowledge-context-history", historyId] : ["knowledge-context-list", locale, kind],
    scopes: ["source", "resources", "project"], enabled, initialPageParam: { offset: 0, basis: null },
    nextPage: last => last.nextOffset === null ? undefined : { offset: last.nextOffset, basis: last.basis },
    read: async ({ offset, basis }) => {
      const session = executionContext(project);
      const page = historyId ? await resourceCommands.contextResourceHistory({ ...session, contextId: historyId, offset, limit: 50, basis })
        : await resourceCommands.contextResourcePage({ ...session, locale, kind, offset, limit: 50, basis });
      if (basis !== null && page.basis !== basis || page.rows.length > 50 || page.rows.some(row => row.projectId !== session.projectId || row.locale !== locale || row.kind !== kind || historyId && row.contextId !== historyId)
        || page.nextOffset !== null && (page.rows.length === 0 || page.nextOffset !== offset + page.rows.length)) throw new Error("Invalid context resource page association");
      return page;
    } });
}
export const contextSourceKey = ["resource-source-scope"] as const;
export function useContextSource(project: ProjectView, enabled: boolean) {
  const session = executionContext(project);
  const source = useSessionQuery({ key: contextSourceKey, scopes: ["source"], enabled, read: () => sourceCommands.scope(session) });
  const basis = source.data;
  const files = useSessionQuery({ key: ["knowledge-context-files", basis?.currentSnapshot, basis?.revision], scopes: ["source"], enabled: enabled && !!basis?.currentSnapshot && !source.error,
    read: async () => {
      if (!basis?.currentSnapshot) throw new Error("A current source is required");
      const page = await sourceCommands.content({ ...session, snapshotId: basis.currentSnapshot, after: 0, limit: 1 });
      if (page.snapshotId !== basis.currentSnapshot || !sameContentScope(page.scope, basis)) throw new Error("Source file list changed"); return page;
    } });
  return { source, files };
}
export function sameContentScope(left: ContentScope, right: ContentScope) { return left.currentSnapshot === right.currentSnapshot && left.revision === right.revision; }
export type ContextResolutionScope = SourceFactBasis["scope"];
