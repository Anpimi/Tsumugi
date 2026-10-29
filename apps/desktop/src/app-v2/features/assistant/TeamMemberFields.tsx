import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiBudgetInputs, AiConnectionEditor } from "../../../AiConnectionFields";
import { connectionAiConfig, editedAiConfig, type AiConfig } from "../../../aiCommands";
import { useConnectionFacts } from "../../../ApplicationReadProvider";
import { Button } from "../../../design-system/Button";
import { Disclosure } from "../../../design-system/Disclosure";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { TeamWorkKindValues } from "../../../generated/ai.enums";
import type { TeamExecutionMember } from "../../../generated/ai.requests";
import { ModelConnectionPicker } from "../../../ModelConnectionPicker";
import { SourceContextChoice } from "../../../SourceContextPreparation";
import styles from "./ConversationTeamRecovery.module.css";
import formStyles from "./ConversationPanel.module.css";

export type EditableTeamMember = Pick<TeamExecutionMember, "displayName" | "role" | "config" | "unitIds" | "toolHandles" | "kinds">;

/** Shared input controls. The enclosing proposal or recovery session owns edits. */
export function TeamMemberFields({ member, number, scope, tools, editSeq, active, editable, current, onChange, onRemove, focusName = false }: {
  member: EditableTeamMember; number: number; scope: readonly { unitId: string; nativeKey: string }[];
  tools: readonly { handle: string; title: string }[]; editSeq: string; active: boolean;
  editable: () => boolean; current: () => boolean; onChange: (patch: Partial<EditableTeamMember>) => void; onRemove: () => void;
  focusName?: boolean;
}) {
  const { t } = useTranslation(), id = useId(), facts = useConnectionFacts();
  const [connectionOpen, setConnectionOpen] = useState(false), [presetName, setPresetName] = useState("custom");
  const change = (patch: Partial<EditableTeamMember>) => { if (editable()) onChange(patch); };
  const config = (value: AiConfig | ((before: AiConfig) => AiConfig)) => change({ config: editedAiConfig(member.config, typeof value === "function" ? value(member.config) : value) });
  const handles = [...new Set([...tools.map(tool => tool.handle), ...member.toolHandles])];
  return <fieldset className={`${styles.member} ${formStyles.configuration}`} disabled={!editable()}><legend>{t("ai.team.memberNumber", { number: String(number) })}</legend>
    <Field label={t("ai.team.name")}><TextInput autoFocus={focusName} value={member.displayName} onChange={event => change({ displayName: event.target.value })}/></Field>
    <Field label={t("ai.team.role")}><TextArea value={member.role} onChange={event => change({ role: event.target.value })}/></Field>
    <ModelConnectionPicker config={member.config} label={t("ai.team.connection")} active={active} disabled={!editable()} editSeq={Number(editSeq)} onSelect={(view, profileId) => {
      if (!editable() || !current()) return false;
      const profile = view?.snapshot.profiles.find(value => value.id === profileId && !value.archived), reference = view?.references.find(value => value.profileId === profileId);
      if (profileId && (!profile || !reference || view !== facts.current())) return false;
      change({ config: profile && reference ? connectionAiConfig(member.config, profile.connection, reference) : { ...member.config, connectionProfile: null } }); return true;
    }}/>
    <AiConnectionEditor config={member.config} setConfig={config} presetName={presetName} setPresetName={setPresetName}
      connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={null} idPrefix={id}/>
    <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={member.config.shareTerms} onChange={event => config(before => ({ ...before, shareTerms: event.target.checked }))}/><span>{t("ai.shareTerms")}</span></label>
    <label className={styles.check}><TextInput type="checkbox" className={styles.checkbox} checked={member.config.shareContext} onChange={event => config(before => ({ ...before, shareContext: event.target.checked }))}/><span>{t("ai.shareContext")}</span></label>
    <SourceContextChoice value={member.config.sourceContext} onChange={sourceContext => config(before => ({ ...before, sourceContext }))}/>
    <Disclosure title={t("ai.team.memberLimits")}><p>{t("ai.team.memberLimitsHelp")}</p><AiBudgetInputs config={member.config} setConfig={config}
      fields={["maxItems", "maxRequests", "maxOutputTokens", "maxRetries", "timeoutSeconds"]} idPrefix={id}/></Disclosure>
    <fieldset className={styles.fields}><legend>{t("ai.team.units")}</legend>{[...new Set([...scope.map(unit => unit.unitId), ...member.unitIds])].map(unitId => <label className={styles.check} key={unitId}>
      <TextInput type="checkbox" className={styles.checkbox} checked={member.unitIds.includes(unitId)} onChange={event => change({ unitIds: event.target.checked ? [...member.unitIds, unitId] : member.unitIds.filter(value => value !== unitId) })}/>
      <span>{scope.find(unit => unit.unitId === unitId)?.nativeKey ?? t("ai.team.removedEntry", { number: String(member.unitIds.indexOf(unitId) + 1) })}</span></label>)}</fieldset>
    <fieldset className={styles.fields}><legend>{t("ai.team.tools")}</legend>{handles.length ? handles.map((handle, index) => <label key={handle} className={styles.check}>
      <TextInput type="checkbox" className={styles.checkbox} checked={member.toolHandles.includes(handle)} onChange={event => change({ toolHandles: event.target.checked ? [...member.toolHandles, handle] : member.toolHandles.filter(value => value !== handle) })}/>
      <span>{tools.find(tool => tool.handle === handle)?.title ?? t("ai.team.removedTool", { number: String(index + 1) })}</span></label>) : <p>{t("ai.team.noTools")}</p>}</fieldset>
    <fieldset className={styles.fields}><legend>{t("ai.team.kinds")}</legend>{TeamWorkKindValues.map(kind => <label key={kind} className={styles.check}>
      <TextInput type="checkbox" className={styles.checkbox} checked={member.kinds.includes(kind)} onChange={event => change({ kinds: event.target.checked ? [...member.kinds, kind] : member.kinds.filter(value => value !== kind) })}/><span>{t(`ai.team.workKinds.${kind}`)}</span></label>)}</fieldset>
    <Button size="sm" disabled={!editable()} onClick={() => { if (editable()) onRemove(); }}>{t("ai.team.remove")}</Button>
  </fieldset>;
}
