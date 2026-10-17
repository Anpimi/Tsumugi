import { useTranslation } from "react-i18next";
import { executionCommands, type ApplicationScopeBasis } from "./executionCommands";
import type { WorkPlanToolSpec } from "./generated/ai.responses";
import { jsonIdentity, matchesApplicationToolRoster } from "./pluginToolChoices";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { PluginPermissions } from "./PluginPermissions";

export function applicationToolGroups(tools: readonly WorkPlanToolSpec[]) {
  const groups: { basis: ApplicationScopeBasis; tools: WorkPlanToolSpec[]; capabilities: WorkPlanToolSpec["applicationCapabilities"] }[] = [];
  for (const tool of tools) {
    const basis = tool.execution.applicationScope;
    if (!basis) continue;
    const group = groups.find(group => jsonIdentity(group.basis) === jsonIdentity(basis));
    if (group) group.tools.push(tool);
    else groups.push({ basis, tools: [tool], capabilities: tool.applicationCapabilities });
  }
  return groups;
}

export function validWorkPlanApplicationTools(tools: readonly WorkPlanToolSpec[]): boolean {
  const groups = applicationToolGroups(tools);
  return tools.every(tool => jsonIdentity(tool.execution.capability) === jsonIdentity(tool.binding.capability)
    && jsonIdentity(tool.execution.profile) === jsonIdentity(tool.binding.declaration.profile)
    && matchesApplicationToolRoster({ binding: tool.binding,
      componentScope: tool.execution.componentScope, environment: tool.execution.environment }, tool.execution.applicationScope, tool.applicationCapabilities))
    && groups.every(group => group.tools.every(tool =>
      jsonIdentity(tool.applicationCapabilities) === jsonIdentity(group.capabilities)
      && jsonIdentity(tool.execution.capability.provider.plugin) === jsonIdentity(group.tools[0].execution.capability.provider.plugin)
      && tool.execution.capability.provider.packageDigest === group.tools[0].execution.capability.provider.packageDigest
      && tool.execution.capability.provider.componentId === group.tools[0].execution.capability.provider.componentId
      && tool.settingsRevision === group.tools[0].settingsRevision
      && jsonIdentity(tool.packageOrigin) === jsonIdentity(group.tools[0].packageOrigin)
      && jsonIdentity(tool.runtimeOrigin) === jsonIdentity(group.tools[0].runtimeOrigin)
      && jsonIdentity(tool.execution.environment) === jsonIdentity(group.tools[0].execution.environment)))
    && new Set(groups.map(group => group.basis.instanceId)).size === groups.length;
}

/** Observes the fixed instances; reads never reserve or replace an instance. */
export function useWorkPlanApplicationTools(tools: readonly WorkPlanToolSpec[], enabled: boolean) {
  const reads = useSessionReads(), groups = applicationToolGroups(tools);
  const key = ["work-plan-tool-applications", groups.map(group => group.basis)] as const;
  const observation = useSessionQuery({ key, scopes: ["execution"], enabled: enabled && groups.length > 0,
    read: () => Promise.all(groups.map(group => executionCommands.applicationInstance({ basis: group.basis }))) });
  function current() {
    if (groups.length === 0) return true;
    const query = reads.client.getQueryState(reads.key(key));
    return query?.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && !query.error
      && query.data === observation.data && observation.data?.length === groups.length
      && observation.data.every((instance, index) => jsonIdentity(instance.basis) === jsonIdentity(groups[index].basis)
        && (instance.state === "reserved" || instance.state === "active"));
  }
  return { groups, observation, current };
}

export function WorkPlanApplicationToolDetails({ group }: { group: ReturnType<typeof applicationToolGroups>[number] }) {
  const { t } = useTranslation();
  return <>
    <h5>{group.tools[0].binding.capability.provider.plugin.id} · {group.tools[0].binding.capability.provider.componentId}</h5>
    <p>{t("toolQuery.applicationHelp")}</p>
    {group.tools[0].execution.environment.profile === "native-application-host-v1" ? <p>{t("toolQuery.applicationNativeHelp")}</p> : null}
    <p>{t("toolQuery.applicationCapabilities")}</p>
    <ul>{group.capabilities.map(member => <li key={member.contributionId}>{member.contributionId}
      <PluginPermissions permissions={member.capability.permissions} /></li>)}</ul>
    <p>{t("ai.tools.applicationStopHelp")}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><pre className="ai-text">{JSON.stringify({ basis: group.basis, capabilities: group.capabilities }, null, 2)}</pre></details>
  </>;
}

export function WorkPlanApplicationToolObservation({ observation }: { observation: ReturnType<typeof useWorkPlanApplicationTools>["observation"] }) {
  const { t } = useTranslation();
  return <>
    {observation.isFetching ? <p role="status">{t("toolQuery.applicationLoading")}</p> : null}
    {observation.error ? <div role="alert"><CommandFailureDetails failure={commandFailure(observation.error)} /></div> : null}
    {observation.data?.map(instance => <p role="status" key={jsonIdentity(instance.basis)}>{t(`toolQuery.applicationStates.${instance.state}`)}</p>)}
    {observation.data?.some(instance => instance.state !== "reserved" && instance.state !== "active") ? <p role="alert">{t("ai.tools.applicationRetired")}</p> : null}
    <button type="button" className="secondary-button" disabled={observation.isFetching} onClick={() => { void observation.refetch(); }}>{t("toolQuery.applicationRefresh")}</button>
  </>;
}
