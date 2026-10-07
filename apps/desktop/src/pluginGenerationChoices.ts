import { pluginCommands, readEnabledPluginPackages } from "./pluginCommands";
import { approvedPluginEnvironments } from "./pluginEnvironments";
import { contractIdentity } from "./reviewIdentity";

const generationContract = (id: string) => contractIdentity({ id: `tsumugi.work-plan-generation${id}`, schemaVersion: 1, behaviorVersion: 1 });

/** Presentation candidates only; the native owner recaptures compatibility,
 * permissions, provenance and the exact approved runtime before execution. */
export async function readPluginGenerationChoices() {
  const inventory = await pluginCommands.inventory();
  const packages = await readEnabledPluginPackages(inventory);
  const choices = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => {
    const component = item.manifest.components.find(component => component.id === contribution.componentId);
    if (!component || component.scope !== "project" || component.runtime !== "javascript"
      || !component.dependencies.some(dependency => dependency.required && dependency.selection === "single"
        && contractIdentity(dependency.contract) === generationContract(""))
      || contribution.contribution.kind !== "capability") return [];
    const declaration = contribution.contribution.declaration;
    if (declaration.effect !== "external"
      || !declaration.permissions.some(permission => permission.kind === "project-service" && contractIdentity(permission.contract) === generationContract(""))
      || !item.manifest.permissions.some(permission => permission.kind === "project-service" && contractIdentity(permission.contract) === generationContract(""))
      || contractIdentity(declaration.inputSchema) !== generationContract("-input")
      || contractIdentity(declaration.outputSchema) !== generationContract("-receipt")
      || contractIdentity(declaration.errorSchema) !== generationContract("-error")) return [];
    return [{ key: `${item.packageDigest}:${contribution.id}`, declaration,
      label: `${item.manifest.plugin.publisher}/${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
      provider: { plugin: item.manifest.plugin, packageDigest: item.packageDigest,
        componentId: component.id, contributionId: contribution.id } }];
  }));
  return { choices, runtimes: approvedPluginEnvironments(inventory).filter(choice => choice.environment.profile === "node-system-libraries-v1") };
}
