import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { createToolQuery } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { pluginCommands, type PluginToolRequest, type PluginToolView } from "./pluginCommands";
import { matchingPluginEnvironments, pluginEnvironmentVersion } from "./pluginEnvironments";
import { matchesTool, queryField, readPluginToolChoices } from "./pluginToolChoices";
import { useSessionQuery } from "./SessionReadProvider";

interface PlanToolEntryDraft {
  id: number; choice: string; runtime: string; target: string; selections: string[];
}
export interface PlanToolDraft {
  entries: PlanToolEntryDraft[]; maxInvocations: number;
}
interface CapturedPlanTool {
  tool: PluginToolRequest; target: string; selections: string[]; view: PluginToolView; readKey: readonly unknown[];
}
export interface PlanToolChoiceHandle {
  capture: () => { entries: CapturedPlanTool[]; maxInvocations: number } | null;
}
interface PlanToolEntryHandle { capture: () => CapturedPlanTool; focus: () => void }
type ToolInventory = Awaited<ReturnType<typeof readPluginToolChoices>>;
const emptyEntry = (id: number): PlanToolEntryDraft => ({ id, choice: "", runtime: "", target: "", selections: [] });
export const emptyPlanToolDraft = (): PlanToolDraft => ({ entries: [emptyEntry(0)], maxInvocations: 10 });
const unavailable = () => { throw { reason: "work-plan-tool-unavailable", outcome: "rejected" }; };

/** Stable draft rows keep each provider's options and captured origin separate. */
export function WorkPlanToolChoice({ open, disabled, value, onChange, ref }: {
  open: boolean; disabled: boolean; value: PlanToolDraft | null;
  onChange: (value: PlanToolDraft | null) => void; ref?: Ref<PlanToolChoiceHandle>;
}) {
  const { t } = useTranslation();
  const [refresh, setRefresh] = useState(0), [focusTarget, setFocusTarget] = useState<number | "add" | null>(null);
  const entryRefs = useRef(new Map<number, PlanToolEntryHandle>()), nextId = useRef(1);
  const addButton = useRef<HTMLButtonElement>(null);
  const inventory = useSessionQuery({ key: ["tool-query-inventory", refresh], scopes: [], enabled: open && value !== null && !disabled,
    read: readPluginToolChoices });
  const draftEntries = value?.entries ?? [];
  const duplicateIds = new Set(draftEntries.filter(entry => entry.choice && entry.runtime && draftEntries.some(other =>
    other.id !== entry.id && other.choice === entry.choice && other.runtime === entry.runtime)).map(entry => entry.id));
  const validLimit = value !== null && Number.isInteger(value.maxInvocations) && value.maxInvocations >= 1 && value.maxInvocations <= 300;
  useImperativeHandle(ref, () => ({ capture() {
    if (!value) return null;
    if (!open || disabled || !validLimit || value.entries.length === 0 || value.entries.length > 32
      || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length
      || duplicateIds.size || inventory.error || inventory.isFetching) return unavailable();
    const entries = value.entries.map(entry => {
      const handle = entryRefs.current.get(entry.id);
      if (!handle) return unavailable();
      return handle.capture();
    });
    return structuredClone({ entries, maxInvocations: value.maxInvocations });
  } }));
  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget === "add") addButton.current?.focus();
    else entryRefs.current.get(focusTarget)?.focus();
    setFocusTarget(null);
  }, [focusTarget, value?.entries.length]);
  function editEntry(id: number, update: Partial<PlanToolEntryDraft>) {
    if (value && !disabled) onChange({ ...value, entries: value.entries.map(entry => entry.id === id ? { ...entry, ...update } : entry) });
  }
  function addEntry() {
    if (!value || disabled || value.entries.length >= 32) return;
    const id = Math.max(nextId.current, ...value.entries.map(entry => entry.id + 1));
    nextId.current = id + 1;
    onChange({ ...value, entries: [...value.entries, emptyEntry(id)] });
    setFocusTarget(id);
  }
  function removeEntry(id: number) {
    if (!value || disabled) return;
    onChange({ ...value, entries: value.entries.filter(entry => entry.id !== id) });
    setFocusTarget("add");
  }
  return <section aria-label={t("ai.tools.choiceTitle")} aria-busy={inventory.isFetching}>
    <label className="source-check"><input type="checkbox" checked={value !== null} disabled={disabled}
      onChange={event => onChange(event.target.checked ? emptyPlanToolDraft() : null)} />{t("ai.tools.enable")}</label>
    {value ? <>
      <p>{t("ai.tools.captureHelp")}</p><p>{t("ai.tools.independentHelp")}</p>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => {
        onChange({ ...value }); setRefresh(current => current + 1);
      }}>{t("toolQuery.refresh")}</button>
      {inventory.isFetching ? <p role="status">{t("execution.working")}</p> : null}
      {inventory.error ? <div role="alert"><p>{t("ai.tools.readFailed")}</p><CommandFailureDetails failure={commandFailure(inventory.error)} /></div> : null}
      {inventory.isSuccess && inventory.data?.choices.length === 0 ? <p role="status">{t("toolQuery.unavailable")}</p> : null}
      {value.entries.map((entry, index) => <PlanToolEntry key={entry.id} ref={handle => {
        if (handle) entryRefs.current.set(entry.id, handle); else entryRefs.current.delete(entry.id);
      }} entry={entry} number={index + 1} open={open} disabled={disabled} duplicate={duplicateIds.has(entry.id)}
        inventory={inventory.data} inventoryError={inventory.error} inventoryFetching={inventory.isFetching}
        inventoryUpdatedAt={inventory.dataUpdatedAt} refresh={refresh}
        onChange={update => editEntry(entry.id, update)} onRemove={() => removeEntry(entry.id)} />)}
      {value.entries.length === 0 ? <p role="status">{t("ai.tools.emptyChoice")}</p> : null}
      <button type="button" className="secondary-button" ref={addButton} disabled={disabled || value.entries.length >= 32}
        onClick={addEntry}>{t("ai.tools.addProvider")}</button>
      {value.entries.length >= 32 ? <p role="status">{t("ai.tools.providerLimit")}</p> : null}
      <label className="field">{t("ai.tools.limit")}<input type="number" min={1} max={300} disabled={disabled}
        aria-invalid={!validLimit} value={Number.isFinite(value.maxInvocations) ? value.maxInvocations : ""}
        onChange={event => onChange({ ...value, maxInvocations: event.target.valueAsNumber })} /></label>
      <p>{t("ai.tools.limitHelp")}</p>{!validLimit ? <p role="status">{t("ai.tools.completeChoice")}</p> : null}
    </> : null}
  </section>;
}

/** Read-only metadata uses the existing session query owner, never a draft copy. */
function PlanToolEntry({ entry, number, open, disabled, duplicate, inventory, inventoryError, inventoryFetching,
  inventoryUpdatedAt, refresh, onChange, onRemove, ref }: {
  entry: PlanToolEntryDraft; number: number; open: boolean; disabled: boolean; duplicate: boolean;
  inventory: ToolInventory | undefined; inventoryError: unknown; inventoryFetching: boolean;
  inventoryUpdatedAt: number; refresh: number; onChange: (update: Partial<PlanToolEntryDraft>) => void;
  onRemove: () => void; ref?: Ref<PlanToolEntryHandle>;
}) {
  const { t } = useTranslation(), providerInput = useRef<HTMLSelectElement>(null);
  const choice = inventory?.choices.find(item => item.key === entry.choice);
  const runtimes = matchingPluginEnvironments(inventory?.runtimes ?? [], choice?.runtimeKinds ?? []);
  const request: PluginToolRequest | null = choice && runtimes.some(item => item.environmentDigest === entry.runtime)
    ? { package: choice.package, resourceId: choice.resourceId, environmentDigest: entry.runtime } : null;
  const environment = useSessionQuery({ key: ["tool-query-environment", entry.choice, entry.runtime, refresh, inventoryUpdatedAt], scopes: [],
    enabled: open && !disabled && !!request && !inventoryError && !inventoryFetching,
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
  const target = entry.target || (typeof targetDefault === "string" ? targetDefault : "");
  const valid = query && query.target.options.some(option => option.value === target)
    && entry.selections.length >= query.selections.minSelected && entry.selections.length <= query.selections.maxSelected
    && new Set(entry.selections).size === entry.selections.length
    && entry.selections.every(selected => query.selections.options.some(option => option.value === selected));
  useImperativeHandle(ref, () => ({ focus() { providerInput.current?.focus(); }, capture() {
    if (!open || disabled || duplicate || !valid || !request || !environment.data || !matchesTool(environment.data, request)
      || inventoryError || inventoryFetching || environment.error || environment.isFetching) return unavailable();
    return structuredClone({ tool: request, target, selections: entry.selections, view: environment.data,
      readKey:["tool-query-environment",entry.choice,entry.runtime,refresh,inventoryUpdatedAt] });
  } }));
  return <fieldset disabled={disabled} aria-busy={environment.isFetching}>
    <legend>{t("ai.tools.providerNumber", { number, defaultValue: enUS.ai.tools.providerNumber })}</legend>
    <label className="field">{t("toolQuery.provider")}<select ref={providerInput} value={entry.choice}
      onChange={event => onChange({ choice: event.target.value, runtime: "", target: "", selections: [] })}>
      <option value="">{t("toolQuery.chooseProvider")}</option>
      {entry.choice && !choice ? <option value={entry.choice}>{t("ai.tools.providerUnavailable")}</option> : null}
      {inventory?.choices.map(item => <option key={item.key} value={item.key}>{item.package.plugin.publisher}/{item.label}</option>)}
    </select></label>
    <label className="field">{t("sourcePlugin.runtime")}<select value={entry.runtime} onChange={event => onChange({ runtime: event.target.value })}>
      <option value="">{t("sourcePlugin.chooseRuntime")}</option>
      {entry.runtime && !runtimes.some(item => item.environmentDigest === entry.runtime)
        ? <option value={entry.runtime}>{t("ai.tools.runtimeUnavailable")}</option> : null}
      {runtimes.map(item => <option key={item.environmentDigest} value={item.environmentDigest}>
        {t(item.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", {
          version: pluginEnvironmentVersion(item.environment), system: item.environment.platform.operatingSystem, architecture: item.environment.platform.architecture })}
      </option>)}
    </select></label>
    {duplicate ? <p role="alert">{t("ai.tools.duplicateProvider")}</p> : null}
    {environment.isFetching ? <p role="status">{t("execution.working")}</p> : null}
    {environment.error ? <div role="alert"><p>{t("ai.tools.readFailed")}</p><CommandFailureDetails failure={commandFailure(environment.error)} /></div> : null}
    {!query && !environment.error && !inventoryError && !inventoryFetching && !environment.isFetching
      ? <p role="status">{t("ai.tools.completeProvider")}</p> : null}
    {query ? <>
      <h4>{environment.data?.binding.declaration.title}</h4><p>{environment.data?.binding.declaration.description}</p>
      {environment.data ? <p>{t(`toolQuery.scopes.${environment.data.componentScope}`)}</p> : null}
      {environment.data?.componentScope === "application" ? <p>{t("ai.tools.applicationCaptureHelp")}</p> : null}
      <label className="field">{query.target.label}<select value={target} onChange={event => onChange({ target: event.target.value })}>
        {query.target.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label><p>{query.target.description}</p>
      <fieldset><legend>{query.selections.label}</legend><p>{query.selections.description}</p>
        {query.selections.options.map(option => <label className="source-check" key={option.value}><input type="checkbox" checked={entry.selections.includes(option.value)}
          onChange={event => onChange({ selections: event.target.checked ? [...entry.selections, option.value] : entry.selections.filter(selected => selected !== option.value) })} />
          {option.label}<span>{option.description}</span></label>)}
      </fieldset>
      {!valid ? <p role="status">{t("ai.tools.completeProvider")}</p> : null}
    </> : null}
    <button type="button" className="text-button" onClick={onRemove}>{t("ai.tools.removeProvider", { number, defaultValue: enUS.ai.tools.removeProvider })}</button>
  </fieldset>;
}
