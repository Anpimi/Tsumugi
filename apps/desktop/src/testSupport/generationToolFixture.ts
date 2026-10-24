import { createToolQuery } from "../../../../crates/plugin-sdk/javascript/tool-query.mjs";
import type { WorkPlanGenerationPreflight } from "../generated/ai.responses";
import type { WorkPlanGenerationPrepareRequest } from "../generated/ai.requests";
import { workPlanToolStatus } from "./workPlanToolFixture";

/** Synthetic Host capture, derived from the same original plan material as a tool query. */
export function generationToolFixture(query: WorkPlanGenerationPrepareRequest["toolQueries"][number]): WorkPlanGenerationPreflight["preparedTools"][number] {
  const tool = workPlanToolStatus.plan.tools!.entries.find(tool => tool.handle === query.toolHandle);
  const item = workPlanToolStatus.plan.preview!.items.find(item => item.unitId === query.unitIds[0]);
  if (!tool || !item) throw new Error("Missing captured tool or original entry");
  return { query: structuredClone(query), handleId: "prepared-tool-0", callId: query.attemptId, inputDigest: "c".repeat(64),
    tool: structuredClone(tool), input: { schema: structuredClone(tool.binding.capability.declaration.inputSchema), sha256: "b".repeat(64),
      utf8: JSON.stringify(createToolQuery(tool.binding).prepare({ text: item.sourceText, target: tool.target, selections: tool.selections })) } };
}
