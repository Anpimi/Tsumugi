import { useTranslation } from "react-i18next";
import { PluginPermissions } from "./PluginPermissions";
import type { AiConfig } from "./aiCommands";
import type { WorkPlanView } from "./workPlanCommands";

/** Sharing comes from the captured plan; this preview never reads package text. */
export function ToolGuidanceSharing({ plan, config, toolHandles }: {
  plan: WorkPlanView; config: Pick<AiConfig, "endpoint" | "model">; toolHandles?: readonly string[];
}) {
  const { t } = useTranslation();
  const tools = plan.tools?.entries.filter(tool => !toolHandles || toolHandles.includes(tool.handle)) ?? [];
  if (!tools.length) return null;
  if (!plan.options.toolGuidance) return <p>{t("ai.toolGuidanceSharing.humanOnly")}</p>;
  const hasGuidance = tools.some(tool => tool.binding.declaration.skill || tool.binding.resources.length);
  return <section aria-label={t("ai.toolGuidanceSharing.title")}>
    <h6>{t("ai.toolGuidanceSharing.title")}</h6>
    <p>{t("ai.toolGuidanceSharing.destination", { endpoint: config.endpoint, model: config.model })}</p>
    <p>{t("ai.toolGuidanceSharing.disclosure")}</p><p>{t("ai.toolGuidanceSharing.bounds")}</p>
    {hasGuidance ? <ul>{tools.map(tool => {
      const provider = tool.binding.capability.provider;
      return <li key={tool.handle}><strong>{tool.binding.declaration.title}</strong><p className="ai-text">{tool.binding.declaration.description}</p>
        <p className="ai-text">{provider.plugin.publisher}/{provider.plugin.id} {provider.plugin.version}</p>
        <PluginPermissions permissions={tool.binding.capability.declaration.permissions}/>
        {tool.binding.declaration.skill ? <p className="ai-text">{t("ai.toolGuidanceSharing.skill", { id: tool.binding.declaration.skill })}</p> : <p>{t("ai.toolGuidance.noSkill")}</p>}
        {tool.binding.resources.length ? <ul>{tool.binding.resources.map(resource => <li className="ai-text" key={resource.contributionId}>
          {t("ai.toolGuidanceSharing.resource", { id: resource.contributionId, contract: resource.schema.id,
            schema: String(resource.schema.schemaVersion), behavior: String(resource.schema.behaviorVersion) })}
        </li>)}</ul> : <p>{t("ai.toolGuidance.noReferences")}</p>}
        <details><summary>{t("ai.toolGuidanceSharing.identity")}</summary>
          <p className="ai-text">{provider.packageDigest}</p><p className="ai-text">{tool.resourceId} · {tool.binding.declaration.name}</p><p className="ai-text">{provider.componentId} / {provider.contributionId}</p>
        </details>
      </li>;
    })}</ul> : <p>{t("ai.toolGuidanceSharing.noDeclared")}</p>}
  </section>;
}
