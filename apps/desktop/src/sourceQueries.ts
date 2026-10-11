import type { SessionRequest } from "./executionCommands";
import type { ChangeScope } from "./sessionReads";
import { sourceCommands, sameSourceConfirmation, type ContentPage, type ContentScope, type SourceChangePage } from "./sourceCommands";

const source: ChangeScope[] = ["source"];
export const sourceKeys = {
  scope: ["source-scope"],
  integration: (domain: string) => ["source-integration", domain],
  content: (snapshotId: string, after: number, scope?: ContentScope) => ["source-content", snapshotId, scope?.revision ?? "", scope?.currentSnapshot ?? null, after, 50],
  history: (offset: number) => ["source-history", offset, 50],
  historyContent: (snapshotId: string, query: string, after: number) => ["source-history-content", snapshotId, query, after, 20],
  lineage: (snapshotId: string, ordinal: number) => ["source-lineage", snapshotId, ordinal],
  impact: (snapshotId: string, locale: string, after: number) => ["source-impact", snapshotId, locale, after, 10],
  comparison: (basis: SourceChangePage | null, filter: string, after: number) => ["source-comparison", basis?.attemptId, basis?.resultId,
    basis?.previousSnapshotId, basis?.scope.revision, basis?.scope.currentSnapshot, basis?.confirmation.resultDigest, filter, after, 50],
  preview: (basis: ContentPage | null, after: number) => ["source-preview-page", basis?.attemptId, basis?.resultId,
    basis?.scope.revision, basis?.scope.currentSnapshot, basis?.confirmation.resultDigest, after, 50],
};
export function sameSourcePageBasis(left: ContentPage | SourceChangePage, right: ContentPage | SourceChangePage) {
  return left.attemptId === right.attemptId && left.resultId === right.resultId
    && left.scope.revision === right.scope.revision && left.scope.currentSnapshot === right.scope.currentSnapshot
    && sameSourceConfirmation(left.confirmation, right.confirmation)
    && (!("previousSnapshotId" in left) || ("previousSnapshotId" in right && left.previousSnapshotId === right.previousSnapshotId));
}
/** Options for the existing project cache. Fixed preparation is never recaptured by a query. */
export const sourceReads = {
  scope: (session: SessionRequest) => ({ key: sourceKeys.scope, scopes: source, read: () => sourceCommands.scope(session) }),
  integration: (session: SessionRequest, domain: string) => ({ key: sourceKeys.integration(domain), scopes: ["source"] as ChangeScope[], read: () => sourceCommands.integration(session, domain) }),
  content: (session: SessionRequest, snapshotId: string, after: number, scope?: ContentScope) => ({ key: sourceKeys.content(snapshotId, after, scope), scopes: source,
    read: async () => {
      const page = await sourceCommands.content({ ...session, snapshotId, after, limit: 50 });
      if (page.snapshotId !== snapshotId || (scope && (page.scope.revision !== scope.revision || page.scope.currentSnapshot !== scope.currentSnapshot))) throw { reason: "stale-preview" };
      return page;
    } }),
  history: (session: SessionRequest, offset: number) => ({ key: sourceKeys.history(offset), scopes: source, read: () => sourceCommands.history({ ...session, offset, limit: 50 }) }),
  historyContent: (session: SessionRequest, snapshotId: string, query: string, after: number) => ({ key: sourceKeys.historyContent(snapshotId, query, after), scopes: source,
    read: async () => { const page = await sourceCommands.historyContent({ ...session, snapshotId, query, after, limit: 20 });
      if (page.snapshotId !== snapshotId) throw new Error("Invalid source history reference"); return page; } }),
  lineage: (session: SessionRequest, snapshotId: string, ordinal: number) => ({ key: sourceKeys.lineage(snapshotId, ordinal), scopes: source, read: () => sourceCommands.lineage({ ...session, snapshotId, ordinal }) }),
  impact: (session: SessionRequest, snapshotId: string, locale: string, after: number) => ({ key: sourceKeys.impact(snapshotId, locale, after), scopes: ["source", "translation", "resources", "review"] as ChangeScope[],
    read: async () => { const page = await sourceCommands.impact({ ...session, snapshotId, locale, after, limit: 10 });
      if (page.snapshotId !== snapshotId || page.summary.locale !== locale || page.rows.some(row => row.locale !== locale)) throw new Error("Invalid source impact reference"); return page; } }),
  comparison: (session: SessionRequest, basis: SourceChangePage | null, filter: string, after: number) => ({ key: sourceKeys.comparison(basis, filter, after), scopes: source,
    read: async () => { if (!basis) throw new Error("Source comparison requires a fixed basis");
      const page = await sourceCommands.compare({ ...session, attemptId: basis.attemptId, resultId: basis.resultId, base: basis.previousSnapshotId, filter, after, limit: 50 });
      if (!sameSourcePageBasis(basis, page)) throw { reason: "stale-preview" }; return page; } }),
  preview: (session: SessionRequest, basis: ContentPage | null, after: number) => ({ key: sourceKeys.preview(basis, after), scopes: source,
    read: async () => { if (!basis) throw new Error("Source preview requires a fixed basis");
      const page = await sourceCommands.preview({ ...session, attemptId: basis.attemptId, resultId: basis.resultId, after, limit: 50 });
      if (!sameSourcePageBasis(basis, page)) throw { reason: "stale-preview" }; return page; } }),
};
