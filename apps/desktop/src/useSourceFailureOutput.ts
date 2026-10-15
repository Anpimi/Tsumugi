import type { ProjectView } from "./projectCommands";
import { executionCommands, executionContext, type ExecutionOutputView } from "./executionCommands";
import { useSessionQuery } from "./SessionReadProvider";

export interface FailedSourceResult { attemptId: string; resultId: string; itemId: string }

/** Read an immutable failed producer or checker result without changing its task. */
export function useSourceFailureOutput(project: ProjectView, open: boolean, selected: FailedSourceResult | null) {
  const context = executionContext(project);
  return useSessionQuery<ExecutionOutputView>({
    key: ["source-failure-output", selected?.attemptId, selected?.resultId, selected?.itemId],
    scopes: ["execution"], enabled: open && selected !== null,
    read: async () => {
      if (!selected) throw new Error("No failed source result selected");
      const output = await executionCommands.output({ ...context, attemptId: selected.attemptId, resultId: selected.resultId });
      // A result reused by continuation may retain its original attempt ID.
      if (output.projectId !== context.projectId || output.resultId !== selected.resultId
        || output.itemId !== selected.itemId || output.outcome !== "failed") throw new Error("Invalid source failure association");
      return output;
    },
  });
}
