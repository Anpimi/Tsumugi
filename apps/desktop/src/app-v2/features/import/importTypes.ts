import type { useTranslationImportSession } from "../../../TranslationImportSession";
import type { useExecutionTaskSession } from "../../../ExecutionTaskSession";

export interface ImportOwners {
  imports: ReturnType<typeof useTranslationImportSession>;
  observation: { loading: boolean; failure: unknown | null; retry: () => void };
  tasks: ReturnType<typeof useExecutionTaskSession>;
}
