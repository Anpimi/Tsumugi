import type { SessionRequest } from "./executionCommands";
import type { ChangeScope } from "./sessionReads";
import { resourceCommands } from "./resourceCommands";

/** Current context is a read projection; only an explicit action changes a draft's basis. */
export const resourceReads = {
  context: (session: SessionRequest, unitId: string, locale: string, sourceRevisionId: string) => ({
    key: ["resource-context", unitId, locale, sourceRevisionId],
    scopes: ["source", "resources"] as ChangeScope[],
    read: async () => {
      const revision = await resourceCommands.context({ ...session, unitId, locale });
      if (revision && (revision.unitId !== unitId || revision.locale !== locale)) throw new Error("Invalid context reference");
      return revision;
    },
  }),
};
