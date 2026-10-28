import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Menu } from "../../../design-system/Menu";
import { validKnowledgeName, validKnowledgeText, type KnowledgeProposalContent } from "./proposalDraft";
import styles from "./ConversationPanel.module.css";

type Entries = KnowledgeProposalContent["entries"];
type Labels = ReadonlyMap<string, { key: string; text: string }>;

export function ConversationKnowledgeEntries({ entries }: { entries: Entries }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  return <section aria-label={t("knowledgeEntries")}><h4>{t("knowledgeEntries")}</h4>{entries.map((entry, index) => <article key={index}>
    <h5>{global(`knowledge.contextKinds.${entry.kind}`)} · {entry.name}</h5><p className={styles.text}>{entry.text}</p><p>{t("knowledgeEntryScope", { count: entry.unitIds.length })}</p>
  </article>)}</section>;
}

export function ConversationKnowledgeFields({ entries, unitIds, labels, disabled, allowed, change }: {
  entries: Entries; unitIds: readonly string[]; labels: Labels; disabled: boolean; allowed: () => boolean; change: (edit: (before: Entries) => Entries) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  return <fieldset className={styles.proposalFields} disabled={disabled}><legend>{t("knowledgeEntries")}</legend><p>{t("knowledgeEditHelp")}</p>
    {entries.map((entry, index) => <fieldset key={index} className={styles.proposalFields}><legend>{t("knowledgeEntry", { number: index + 1 })}</legend>
      <Menu label={t("knowledgeKind", { number: index + 1 })} trigger={<Button size="sm" disabled={disabled}>{global(`knowledge.contextKinds.${entry.kind}`)}</Button>}
        items={(["character", "style", "background"] as const).map(kind => ({ id: kind, label: global(`knowledge.contextKinds.${kind}`), onSelect: () => { if (allowed()) change(before => before.map((value, position) => position === index ? { ...value, kind } : value)); } }))}/>
      <Field label={t("knowledgeName", { number: index + 1 })} error={!validKnowledgeName(entry.name) ? t("knowledgeNameInvalid") : undefined}>
        <TextInput value={entry.name} onChange={event => change(before => before.map((value, position) => position === index ? { ...value, name: event.target.value } : value))}/>
      </Field>
      <Field label={t("knowledgeText", { number: index + 1 })} error={!validKnowledgeText(entry.text) ? t("knowledgeTextInvalid") : undefined}>
        <TextArea rows={4} value={entry.text} onChange={event => change(before => before.map((value, position) => position === index ? { ...value, text: event.target.value } : value))}/>
      </Field>
      <fieldset className={styles.proposalFields}><legend>{t("knowledgeEvidenceEntries")}</legend>{unitIds.map((unitId, position) => <label className={styles.check} key={unitId}>
        <TextInput type="checkbox" className={styles.checkbox} checked={entry.unitIds.includes(unitId)} onChange={event => change(before => before.map((value, number) => number === index
          ? { ...value, unitIds: event.target.checked ? [...value.unitIds, unitId] : value.unitIds.filter(id => id !== unitId) } : value))}/>
        <span>{labels.get(unitId)?.key || t("proposalEntryNumber", { number: position + 1 })}</span></label>)}
        {!entry.unitIds.length ? <p role="status">{t("knowledgeChooseEvidence")}</p> : null}</fieldset>
      <Button size="sm" onClick={() => { if (allowed()) change(before => before.filter((_, position) => position !== index)); }}>{t("knowledgeRemoveEntry", { number: index + 1 })}</Button>
    </fieldset>)}
    <Button size="sm" disabled={disabled || entries.length >= 16} onClick={() => { if (allowed()) change(before => [...before, { kind: "character", name: "", text: "", unitIds: [] }]); }}>{t("knowledgeAddEntry")}</Button>
  </fieldset>;
}
