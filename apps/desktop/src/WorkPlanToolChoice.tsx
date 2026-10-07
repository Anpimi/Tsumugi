import { useImperativeHandle, useMemo, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { createToolQuery } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { pluginCommands, type PluginToolRequest, type PluginToolView } from "./pluginCommands";
import { matchingPluginEnvironments, pluginEnvironmentVersion } from "./pluginEnvironments";
import { matchesTool, queryField, readPluginToolChoices } from "./pluginToolChoices";
import { useSessionQuery } from "./SessionReadProvider";

export interface PlanToolDraft {
  choice: string; runtime: string; target: string; selections: string[]; maxInvocations: number;
}
export interface PlanToolChoiceHandle {
  capture: () => { tool: PluginToolRequest; target: string; selections: string[]; maxInvocations: number; view: PluginToolView } | null;
}
export const emptyPlanToolDraft = (): PlanToolDraft => ({ choice: "", runtime: "", target: "", selections: [], maxInvocations: 10 });

/** Chooses fixed read-only references; Core derives the text from captured units. */
export function WorkPlanToolChoice({ open, disabled, value, onChange, ref }: {
  open: boolean; disabled: boolean; value: PlanToolDraft | null;
  onChange: (value: PlanToolDraft | null) => void; ref?: Ref<PlanToolChoiceHandle>;
}) {
  const { t } = useTranslation();
  const [refresh, setRefresh] = useState(0);
  const inventory = useSessionQuery({ key: ["tool-query-inventory", refresh], scopes: [], enabled: open && value !== null && !disabled,
    read: readPluginToolChoices });
  const choice = inventory.data?.choices.find(item => item.key === value?.choice);
  const runtimes = matchingPluginEnvironments(inventory.data?.runtimes ?? [], choice?.runtimeKinds ?? []);
  const request: PluginToolRequest | null = choice && value && runtimes.some(item => item.environmentDigest === value.runtime)
    ? { package: choice.package, resourceId: choice.resourceId, environmentDigest: value.runtime } : null;
  const environment = useSessionQuery({ key: ["tool-query-environment", value?.choice ?? "", value?.runtime ?? "", refresh, inventory.dataUpdatedAt], scopes: [],
    enabled: open && !disabled && !!request && !inventory.error && !inventory.isFetching,
    read: async () => {
      if (!request) throw new Error("Missing tool choice");
      const result = await pluginCommands.tool(request);
      if (!matchesTool(result, request)) throw new Error("Tool environment identity changed");
      return result;
    } });
  const query = useMemo(() => {
    try { return environment.data ? createToolQuery(environment.data.binding).query : null; } catch { return null; }
  }, [environment.data]);
  const targetDefault = query ? queryField(query.inputTemplate, query.target.path) : undefined;
  const target = value?.target || (typeof targetDefault === "string" ? targetDefault : "");
  const valid = value && query && query.target.options.some(option => option.value === target)
    && value.selections.length >= query.selections.minSelected && value.selections.length <= query.selections.maxSelected
    && new Set(value.selections).size === value.selections.length
    && value.selections.every(selected => query.selections.options.some(option => option.value === selected))
    && Number.isInteger(value.maxInvocations) && value.maxInvocations >= 1 && value.maxInvocations <= 300;
  useImperativeHandle(ref, () => ({ capture() {
    if (!value) return null;
    if (!valid || !request || !environment.data || inventory.error || environment.error || inventory.isFetching || environment.isFetching)
      throw { reason: "work-plan-tool-unavailable", outcome: "rejected" };
    return structuredClone({ tool: request, target, selections: value.selections, maxInvocations: value.maxInvocations, view: environment.data });
  } }));
  function edit(update: Partial<PlanToolDraft>) { if (value) onChange({ ...value, ...update }); }
  const failure = inventory.error ?? environment.error;
  return <section aria-label={t("ai.tools.choiceTitle")} aria-busy={inventory.isFetching || environment.isFetching}>
    <label className="source-check"><input type="checkbox" checked={value !== null} disabled={disabled}
      onChange={event => onChange(event.target.checked ? emptyPlanToolDraft() : null)} />{t("ai.tools.enable")}</label>
    {value ? <>
      <p>{t("ai.tools.captureHelp")}</p>
      <label className="field">{t("toolQuery.provider")}<select value={value.choice} disabled={disabled}
        onChange={event => edit({ choice: event.target.value, runtime: "", target: "", selections: [] })}>
        <option value="">{t("toolQuery.chooseProvider")}</option>{inventory.data?.choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>
      <label className="field">{t("sourcePlugin.runtime")}<select value={value.runtime} disabled={disabled}
        onChange={event => edit({ runtime: event.target.value })}>
        <option value="">{t("sourcePlugin.chooseRuntime")}</option>{runtimes.map(item => <option key={item.environmentDigest} value={item.environmentDigest}>
          {t(item.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", {
            version: pluginEnvironmentVersion(item.environment), system: item.environment.platform.operatingSystem, architecture: item.environment.platform.architecture })}
        </option>)}
      </select></label>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { edit({ target: "", selections: [] }); setRefresh(current => current + 1); }}>{t("toolQuery.refresh")}</button>
      {inventory.isFetching || environment.isFetching ? <p role="status">{t("execution.working")}</p> : null}
      {failure ? <div role="alert"><p>{t("toolQuery.failed")}</p><CommandFailureDetails failure={commandFailure(failure)} /></div> : null}
      {!query && !failure && !inventory.isFetching && !environment.isFetching ? <p role="status">{t("toolQuery.unavailable")}</p> : null}
      {query ? <>
        <h4>{environment.data?.binding.declaration.title}</h4><p>{environment.data?.binding.declaration.description}</p>
        <label className="field">{query.target.label}<select value={target} disabled={disabled} onChange={event => edit({ target: event.target.value })}>
          {query.target.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label><p>{query.target.description}</p>
        <fieldset disabled={disabled}><legend>{query.selections.label}</legend><p>{query.selections.description}</p>
          {query.selections.options.map(option => <label className="source-check" key={option.value}><input type="checkbox" checked={value.selections.includes(option.value)}
            onChange={event => edit({ selections: event.target.checked ? [...value.selections, option.value] : value.selections.filter(selected => selected !== option.value) })} />
            {option.label}<span>{option.description}</span></label>)}
        </fieldset>
      </> : null}
      <label className="field">{t("ai.tools.limit")}<input type="number" min={1} max={300} disabled={disabled} value={Number.isFinite(value.maxInvocations) ? value.maxInvocations : ""}
        onChange={event => edit({ maxInvocations: event.target.valueAsNumber })} /></label><p>{t("ai.tools.limitHelp")}</p>
      {query && !valid ? <p role="status">{t("ai.tools.completeChoice")}</p> : null}
    </> : null}
  </section>;
}
