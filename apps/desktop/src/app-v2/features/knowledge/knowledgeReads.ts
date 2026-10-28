import { useSessionInfiniteQuery, useSessionQuery } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type TermRevision } from "../../../resourceCommands";
import { reviewCommands } from "../../../reviewCommands";

export const knowledgeTermsKey = (locale: string) => ["knowledge-terms", locale, 100] as const;
export function useKnowledgeTerms(project: ProjectView, locale: string, enabled: boolean) {
  const session = executionContext(project);
  return useSessionInfiniteQuery<TermRevision[], string | null>({ key: knowledgeTermsKey(locale), scopes: ["resources"], enabled,
    initialPageParam: null as string | null,
    nextPage: last => last.length === 100 ? last.at(-1)!.termId : undefined,
    read: async afterTermId => {
      const rows = await resourceCommands.terms({ ...session, locale, afterTermId, limit: 100 });
      if (rows.length > 100 || rows.some((row, index) => row.locale !== locale || row.termId <= (index ? rows[index - 1].termId : afterTermId ?? ""))) throw new Error("Invalid term page association");
      return rows;
    } });
}
export const knowledgeCurrentKey = (termId: string | null, locale: string) => ["knowledge-term-current", termId, locale] as const;
export function useKnowledgeCurrent(project: ProjectView, locale: string, termId: string | null, enabled: boolean) {
  return useSessionQuery({ key: knowledgeCurrentKey(termId, locale), scopes: ["resources"], enabled: enabled && !!termId,
    read: async () => {
      if (!termId) throw new Error("A term identity is required");
      const term = await resourceCommands.termCurrent({ ...executionContext(project), termId });
      if (term && (term.termId !== termId || term.locale !== locale)) throw new Error("Invalid current term association");
      return term;
    } });
}
export function useKnowledgeScope(project: ProjectView, locale: string, unitId: string | null, enabled: boolean) {
  return useSessionQuery({ key: ["knowledge-scope-entry", unitId, locale], scopes: ["source", "translation", "review", "resources"], enabled: enabled && !!unitId,
    read: async () => {
      if (!unitId) throw new Error("An entry scope is required");
      const result = await reviewCommands.editorSnapshot({ ...executionContext(project), unitId, locale });
      if (result.target.unitId !== unitId || result.target.locale !== locale) throw new Error("Invalid term scope association");
      return result.target;
    } });
}
