import { useSessionInfiniteQuery, useSessionQuery } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands, type TranslationMemoryFilter, type TranslationMemoryPage } from "../../../resourceCommands";

export type MemoryDonorRef = { unitId: string; locale: string; revisionId: string };
export const memoryPageSize = 50;
export const memoryPageKey = (filter: TranslationMemoryFilter) => ["knowledge-translation-memory", filter, memoryPageSize] as const;
export const memoryEntryKey = (donor: MemoryDonorRef | null) => ["knowledge-translation-memory-entry", donor?.unitId, donor?.locale, donor?.revisionId] as const;
export function useTranslationMemory(project: ProjectView, filter: TranslationMemoryFilter, enabled: boolean) {
  return useSessionInfiniteQuery<TranslationMemoryPage, string | null>({ key: memoryPageKey(filter), scopes: ["source", "translation", "review", "resources"], enabled,
    initialPageParam: null, nextPage: last => last.nextCursor ?? undefined,
    read: cursor => resourceCommands.translationMemoryPage({ ...executionContext(project), filter, cursor, limit: memoryPageSize }) });
}
export function useMemoryEntry(project: ProjectView, donor: MemoryDonorRef | null, enabled: boolean) {
  return useSessionQuery({ key: memoryEntryKey(donor), scopes: ["source", "translation", "review", "resources"], enabled: enabled && !!donor,
    read: () => {
      if (!donor) throw new Error("A saved translation identity is required");
      return resourceCommands.translationMemoryEntry({ ...executionContext(project), ...donor });
    } });
}
