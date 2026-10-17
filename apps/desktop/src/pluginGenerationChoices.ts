import { pluginCommands, readEnabledPluginPackages } from "./pluginCommands";
import { approvedPluginEnvironments } from "./pluginEnvironments";
import { contractIdentity } from "./reviewIdentity";
import type { CapabilityDeclaration, CapabilityDependency } from "./generated/plugins.responses";
import type { WorkPlanToolSpec } from "./generated/ai.responses";

const generationContract = (id: string) => contractIdentity({ id: `tsumugi.work-plan-generation${id}`, schemaVersion: 1, behaviorVersion: 1 });

/** Presentation candidates only; the native owner recaptures compatibility,
 * permissions, provenance and the exact approved runtime before execution. */
export async function readPluginGenerationChoices() {
  const inventory = await pluginCommands.inventory();
  const packages = await readEnabledPluginPackages(inventory);
  const choices = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => {
    const component = item.manifest.components.find(component => component.id === contribution.componentId);
    if (!component || (component.scope !== "project" && component.scope !== "attempt") || component.runtime !== "javascript"
      || !component.dependencies.some(dependency => dependency.required && dependency.selection === "single"
        && contractIdentity(dependency.contract) === generationContract(""))
      || contribution.contribution.kind !== "capability") return [];
    const declaration = contribution.contribution.declaration;
    const supportsPreparedTools = contractIdentity(declaration.inputSchema) === contractIdentity({ id: "tsumugi.generation-component-input", schemaVersion: 1, behaviorVersion: 1 });
    if (declaration.effect !== "external"
      || !declaration.permissions.some(permission => permission.kind === "project-service" && contractIdentity(permission.contract) === generationContract(""))
      || !item.manifest.permissions.some(permission => permission.kind === "project-service" && contractIdentity(permission.contract) === generationContract(""))
      || (!supportsPreparedTools && contractIdentity(declaration.inputSchema) !== generationContract("-input"))
      || contractIdentity(declaration.outputSchema) !== generationContract("-receipt")
      || contractIdentity(declaration.errorSchema) !== generationContract("-error")) return [];
    return [{ key: `${item.packageDigest}:${contribution.id}`, declaration, dependencies: component.dependencies, supportsPreparedTools,
      label: `${item.manifest.plugin.publisher}/${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
      provider: { plugin: item.manifest.plugin, packageDigest: item.packageDigest,
        componentId: component.id, contributionId: contribution.id } }];
  }));
  return { choices, runtimes: approvedPluginEnvironments(inventory).filter(choice => choice.environment.profile === "node-system-libraries-v1") };
}

/** Presentation uses the caller's actual manifest; Host checks it again before capture and launch. */
export function generationDeclaresPreparedTool(choice: { declaration: CapabilityDeclaration; dependencies: readonly CapabilityDependency[] }, tool: WorkPlanToolSpec) {
  const contract = contractIdentity(tool.binding.capability.declaration.contract);
  return choice.dependencies.some(dependency => contractIdentity(dependency.contract) === contract)
    && choice.declaration.permissions.some(permission => permission.kind === "project-service" && contractIdentity(permission.contract) === contract);
}
