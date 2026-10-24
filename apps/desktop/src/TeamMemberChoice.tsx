import { useState, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { AiConnectionEditor } from "./AiConnectionFields";
import { ModelConnectionPicker } from "./ModelConnectionPicker";
import { SourceContextChoice } from "./SourceContextPreparation";
import { TeamWorkKindValues } from "./generated/ai.enums";
import type { AiConfig } from "./aiCommands";
import type { ConnectionReadView } from "./connectionCommands";
import type { PlanToolDraft } from "./WorkPlanToolChoice";
import type { TeamMemberDraft } from "./TeamExecutionDraft";

export function TeamMemberChoice({ member, number, selected, unitNames, tools, disabled, open, editSeq, onEdit, onConfig, onConnection, onOpenSettings, onRemove, nameRef, toolNames, toolRows }: {
  member: TeamMemberDraft; number: number; selected: string[]; unitNames: ReadonlyMap<string, string>; tools: PlanToolDraft | null; disabled: boolean; open: boolean; editSeq: number;
  onEdit: (change: Partial<TeamMemberDraft>) => void; onConfig: (change: SetStateAction<AiConfig>) => void;
  onConnection: (view: ConnectionReadView | null, id: string, editSeq: number) => boolean; onOpenSettings?: () => void; onRemove: () => void;
  nameRef: (element: HTMLInputElement | null) => void; toolNames?: ReadonlyMap<number, string>; toolRows?: readonly number[];
}) {
  const { t } = useTranslation(), [connectionOpen, setConnectionOpen] = useState(false), [presetName, setPresetName] = useState("custom");
  const allUnits = [...new Set([...selected, ...member.unitIds])], allTools = [...new Set([...(toolRows ?? tools?.entries.map(entry => entry.id) ?? []), ...member.toolRowIds])];
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
        {toolNames?.get(id) ?? t((toolRows?.includes(id) ?? tools?.entries.some(entry => entry.id === id)) ? "ai.team.toolNumber" : "ai.team.removedTool", { number: String(id + 1) })}</label>) : <p>{t("ai.team.noTools")}</p>}
    </fieldset>
    <fieldset><legend>{t("ai.team.kinds")}</legend>{TeamWorkKindValues.map(kind => <label className="source-check" key={kind}><input type="checkbox" checked={member.kinds.includes(kind)}
      onChange={event => onEdit({ kinds: event.target.checked ? [...member.kinds, kind] : member.kinds.filter(value => value !== kind) })}/>{t(`ai.team.workKinds.${kind}`)}</label>)}</fieldset>
    <button type="button" className="secondary-button" onClick={onRemove}>{t("ai.team.remove")}</button>
  </fieldset>;
}
