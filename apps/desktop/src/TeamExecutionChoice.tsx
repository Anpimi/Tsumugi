import { useEffect, useRef, useState, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { TeamMemberChoice } from "./TeamMemberChoice";
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
