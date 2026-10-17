import planFixture from "../../test/fixtures/workPlanCommands.contract.json";
import agentFixture from "../../test/fixtures/workPlanAgent.contract.json";
import toolFixture from "../../test/fixtures/workPlanAgentTools.contract.json";
import { validateResponseWorkPlanStatus } from "../generated/ai.validators";
import type { WorkPlanToolSpec } from "../generated/ai.responses";
import type { ApplicationScopeBasis } from "../executionCommands";
import { nativeEnvironment, nativeOrigin } from "./pluginNativeFixture";
import { fixtureIdentity } from "./executionFixture";

const captured: unknown = {
  ...planFixture.responses.status,
  lease: agentFixture.responses.scope.lease,
  expiresAt: String(Math.floor(Date.now() / 1000) + 600),
  state: "active", effects: ["save-candidate", "query-tools"],
  toolInvocations: { reserved: 0, limit: 2 },
  plan: {
    ...planFixture.responses.plan,
    maintenance: null,
    planId: agentFixture.requests.open.lease.planId,
    tools: { maxInvocations: 2, entries: [toolFixture.spec] },
    scope: agentFixture.responses.scope.scope,
    preview: planFixture.responses.plan.preview && {
      ...planFixture.responses.plan.preview,
      items: agentFixture.responses.scope.scope.map(unit => ({ ...planFixture.responses.plan.preview!.items[0], unitId: unit.unitId, nativeKey: unit.nativeKey, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId,
        sourceText: unit.nativeKey === "barrel" ? "Captured original 👩🏽‍💻 e\u0301" : "Second captured original" })),
    },
  },
};
if (!validateResponseWorkPlanStatus(captured)) throw new Error("Invalid captured tool-plan fixture");
export const workPlanToolStatus = captured;

export function applicationWorkPlanTool(basis: ApplicationScopeBasis = { instanceId: fixtureIdentity(1800), activationGeneration: 1 }, native = false): WorkPlanToolSpec {
  const tool = structuredClone(workPlanToolStatus.plan.tools!.entries[0]);
  tool.execution.componentScope = "application";
  tool.execution.applicationScope = structuredClone(basis);
  tool.applicationCapabilities = [{ contributionId: tool.binding.capability.provider.contributionId, capability: structuredClone(tool.binding.capability.declaration) },
    ...(!native ? [{ contributionId: "secondary.call", capability: structuredClone(tool.binding.capability.declaration) }] : [])];
  if (native) { tool.execution.environment = structuredClone(nativeEnvironment); tool.runtimeOrigin = structuredClone(nativeOrigin); }
  return tool;
}
