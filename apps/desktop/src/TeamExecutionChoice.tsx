import { useEffect, useRef, useState, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { AiConnectionEditor } from "./AiConnectionFields";
import { ModelConnectionPicker } from "./ModelConnectionPicker";
import { SourceContextChoice } from "./SourceContextPreparation";
import { TeamWorkKindValues } from "./generated/ai.enums";
import type { AiConfig } from "./aiCommands";
import type { ConnectionReadView } from "./connectionCommands";
import type { PlanToolDraft } from "./WorkPlanToolChoice";
import { newTeamExecution, newTeamMember, teamDraftProblem, type TeamExecutionDraft, type TeamMemberDraft } from "./TeamExecutionDraft";

export function TeamExecutionChoice({ value, config, selected, unitNames, tools, discussionsEnabled, disabled, open, editSeq, onChange, onConfig, onConnection, onOpenSettings }: {
  value: TeamExecutionDraft | null; config: AiConfig; selected: string[]; unitNames: ReadonlyMap<string, string>; tools: PlanToolDraft | null;
  discussionsEnabled: boolean; disabled: boolean; open: boolean; editSeq: number;
  onChange: (value: TeamExecutionDraft | null) => void;
  onConfig: (key: number, change: SetStateAction<AiConfig>) => void;
  onConnection: (key: number, view: ConnectionReadView | null, id: string, editSeq: number) => boolean;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation(), nextKey = useRef(1), addRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<number, HTMLInputElement>()), [focusKey, setFocusKey] = useState<number | "add" | null>(null);
  useEffect(() => { if (focusKey === null) return; if (focusKey === "add") addRef.current?.focus(); else rowRefs.current.get(focusKey)?.focus(); setFocusKey(null); }, [focusKey, value?.members.length]);
  function edit(key: number, change: Partial<TeamMemberDraft>) {
    if (!disabled && value) onChange({ ...value, members: value.members.map(member => member.key === key ? { ...member, ...change } : member) });
  }
  const problem = value && teamDraftProblem(value, config, selected, tools?.entries.map(entry => entry.id) ?? []);
  return <section aria-label={t("ai.team.title")}>
    <label className="source-check"><input type="checkbox" checked={value !== null} disabled={disabled}
      onChange={event => onChange(event.target.checked ? newTeamExecution(config, selected) : null)}/>{t("ai.team.enable")}</label>
    {value ? <>
      <p>{t("ai.team.help")}</p><p>{t("ai.team.sharedBudget")}</p>
      {!discussionsEnabled ? <p role="status">{t("ai.team.discussionRequired")}</p> : null}
      <label className="field">{t("ai.team.initial")}<select value={value.initialKey} disabled={disabled} onChange={event => onChange({ ...value, initialKey: Number(event.target.value) })}>
        {value.members.map((member, index) => <option key={member.key} value={member.key}>{member.displayName || t("ai.team.memberNumber", { number: String(index + 1) })}</option>)}
      </select></label>
      <label className="field">{t("ai.team.initialUnit")}<select value={value.initialUnitId} disabled={disabled}
        onChange={event => onChange({ ...value, initialUnitId: event.target.value })}>
        <option value="">{t("ai.team.chooseInitialUnit")}</option>
        {[...new Set([...(value.members.find(member => member.key === value.initialKey)?.unitIds ?? []), ...(value.initialUnitId ? [value.initialUnitId] : [])])].map((id, index) =>
          <option key={id} value={id}>{unitNames.get(id) ?? t("ai.team.selectedEntry", { number: String(index + 1) })}</option>)}
      </select></label><p>{t("ai.team.initialHelp")}</p>
      {(["maxActivations", "maxConcurrency", "maxNoProgress"] as const).map(key => {
        const max = key === "maxActivations" ? Math.min(300, config.maxRequests) : key === "maxConcurrency" ? Math.min(8, config.concurrency, value.limits.maxActivations) : value.limits.maxActivations;
        return <label className="field" key={key}>{t(`ai.team.${key}`)}<input type="number" min={1} max={max} disabled={disabled}
          value={Number.isFinite(value.limits[key]) ? value.limits[key] : ""} aria-invalid={problem === "limits" || undefined}
          onChange={event => onChange({ ...value, limits: { ...value.limits, [key]: event.target.valueAsNumber } })}/></label>;
      })}
      <p>{t("ai.team.completionLimitHelp")}</p>
      {value.members.map((member, index) => <TeamMemberChoice key={member.key} member={member} number={index + 1} selected={selected} unitNames={unitNames} tools={tools}
        disabled={disabled} open={open} editSeq={editSeq} onEdit={change => edit(member.key, change)} onConfig={change => onConfig(member.key, change)}
        onConnection={(view, id, seq) => onConnection(member.key, view, id, seq)} onOpenSettings={onOpenSettings}
        nameRef={element => { if (element) rowRefs.current.set(member.key, element); else rowRefs.current.delete(member.key); }}
        onRemove={() => { const members = value.members.filter(row => row.key !== member.key); onChange({ ...value, members, initialKey: member.key === value.initialKey ? members[0]?.key ?? -1 : value.initialKey }); setFocusKey("add"); }}/>) }
      <button type="button" className="secondary-button" ref={addRef} disabled={disabled || value.members.length >= 8} onClick={() => {
        const key = Math.max(nextKey.current, ...value.members.map(member => member.key + 1)); nextKey.current = key + 1;
        onChange({ ...value, members: [...value.members, newTeamMember(key, config, selected)] }); setFocusKey(key);
      }}>{t("ai.team.add")}</button>
      {problem ? <p role="status">{t(`ai.team.problems.${problem}`)}</p> : null}
    </> : null}
  </section>;
}

function TeamMemberChoice({ member, number, selected, unitNames, tools, disabled, open, editSeq, onEdit, onConfig, onConnection, onOpenSettings, onRemove, nameRef }: {
  member: TeamMemberDraft; number: number; selected: string[]; unitNames: ReadonlyMap<string, string>; tools: PlanToolDraft | null; disabled: boolean; open: boolean; editSeq: number;
  onEdit: (change: Partial<TeamMemberDraft>) => void; onConfig: (change: SetStateAction<AiConfig>) => void;
  onConnection: (view: ConnectionReadView | null, id: string, editSeq: number) => boolean; onOpenSettings?: () => void; onRemove: () => void;
  nameRef: (element: HTMLInputElement | null) => void;
}) {
  const { t } = useTranslation(), [connectionOpen, setConnectionOpen] = useState(false), [presetName, setPresetName] = useState("custom");
  const allUnits = [...new Set([...selected, ...member.unitIds])], allTools = [...new Set([...(tools?.entries.map(entry => entry.id) ?? []), ...member.toolRowIds])];
  return <fieldset disabled={disabled}><legend>{t("ai.team.memberNumber", { number: String(number) })}</legend>
    <label className="field">{t("ai.team.name")}<input ref={nameRef} value={member.displayName} onChange={event => onEdit({ displayName: event.target.value })}/></label>
    <label className="field">{t("ai.team.role")}<textarea value={member.role} onChange={event => onEdit({ role: event.target.value })}/></label>
    <ModelConnectionPicker config={member.config} label={t("ai.team.connection")} active={open} disabled={disabled} editSeq={editSeq} onSelect={onConnection} onOpenSettings={onOpenSettings}/>
    <AiConnectionEditor config={member.config} setConfig={onConfig} presetName={presetName} setPresetName={setPresetName} connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={null} idPrefix={`team-${member.key}`}/>
    <label className="source-check"><input type="checkbox" checked={member.config.shareTerms} onChange={event => onConfig(before => ({ ...before, shareTerms: event.target.checked }))}/>{t("ai.shareTerms")}</label>
    <label className="source-check"><input type="checkbox" checked={member.config.shareContext} onChange={event => onConfig(before => ({ ...before, shareContext: event.target.checked }))}/>{t("ai.shareContext")}</label>
    <SourceContextChoice value={member.config.sourceContext} onChange={sourceContext => onConfig(before => ({ ...before, sourceContext }))}/>
    <details><summary>{t("ai.team.memberLimits")}</summary><p>{t("ai.team.memberLimitsHelp")}</p>
      {(["maxItems", "maxRequests", "maxOutputTokens", "maxRetries", "timeoutSeconds"] as const).map(key => <label className="field" key={key}>{t(`ai.${key}`)}
        <input type="number" min={key === "maxRetries" ? 0 : 1} value={Number.isFinite(member.config[key]) ? member.config[key] : ""}
          onChange={event => onConfig(before => ({ ...before, [key]: event.target.valueAsNumber }))}/></label>)}
    </details>
    <fieldset><legend>{t("ai.team.units")}</legend><p>{t("ai.team.unitHelp")}</p>
      {allUnits.length ? allUnits.map((id, index) => <label className="source-check" key={id}><input type="checkbox" checked={member.unitIds.includes(id)}
        onChange={event => onEdit({ unitIds: event.target.checked ? [...member.unitIds, id] : member.unitIds.filter(value => value !== id) })}/>
        {unitNames.get(id) ?? t(selected.includes(id) ? "ai.team.selectedEntry" : "ai.team.removedEntry", { number: String(index + 1) })}</label>) : <p>{t("ai.team.selectSource")}</p>}
    </fieldset>
    <fieldset><legend>{t("ai.team.tools")}</legend><p>{t("ai.team.toolHelp")}</p>
      {allTools.length ? allTools.map(id => <label className="source-check" key={id}><input type="checkbox" checked={member.toolRowIds.includes(id)}
        onChange={event => onEdit({ toolRowIds: event.target.checked ? [...member.toolRowIds, id] : member.toolRowIds.filter(value => value !== id) })}/>
        {t(tools?.entries.some(entry => entry.id === id) ? "ai.team.toolNumber" : "ai.team.removedTool", { number: String(id + 1) })}</label>) : <p>{t("ai.team.noTools")}</p>}
    </fieldset>
    <fieldset><legend>{t("ai.team.kinds")}</legend>{TeamWorkKindValues.map(kind => <label className="source-check" key={kind}><input type="checkbox" checked={member.kinds.includes(kind)}
      onChange={event => onEdit({ kinds: event.target.checked ? [...member.kinds, kind] : member.kinds.filter(value => value !== kind) })}/>{t(`ai.team.workKinds.${kind}`)}</label>)}</fieldset>
    <button type="button" className="secondary-button" onClick={onRemove}>{t("ai.team.remove")}</button>
  </fieldset>;
}
