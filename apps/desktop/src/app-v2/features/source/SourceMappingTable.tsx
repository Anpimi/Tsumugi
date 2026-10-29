import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Field, TextArea, Select } from "../../../design-system/Field";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { LineageChoice, SourceChangePage, SourceOccurrence } from "../../../sourceCommands";
import styles from "./SourceMaintenance.module.css";

/** A projection of the original frozen comparison and the Source owner's edits. */
export default function SourceMappingTable({ page, choices, disabled, onChoice, onHistorical, onDetails }: {
  page: SourceChangePage;
  choices: Record<number, LineageChoice>;
  disabled: boolean;
  onChoice: (ordinal: number, choice: LineageChoice | null) => void;
  onHistorical: (ordinal: number) => void;
  onDetails: (row: SourceChangePage["rows"][number]) => void;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" });
  const label = (entry: SourceOccurrence) => entry.nativeIdentity?.display.value || entry.key || t("entry", { number: entry.ordinal + 1 });
  function content(entry: SourceOccurrence | null, previous: boolean) {
    return entry ? <><strong>{label(entry)}</strong><pre><TokenizedText text={entry.text}/></pre>{entry.text === "" ? <p className={styles.meta}>{t("emptyText")}</p> : null}</>
      : <p className={styles.meta}>{t(previous ? "noPrevious" : "noNext")}</p>;
  }
  return <div className={styles.tableScroll}><table className={styles.table} aria-label={t("mappingTable")}>
    <thead><tr><th scope="col">{t("kind")}</th><th scope="col">{t("previous")}</th><th scope="col">{t("next")}</th><th scope="col">{t("decision")}</th></tr></thead>
    <tbody>{page.rows.map((row, index) => {
      const ordinal = row.new?.ordinal, selected = ordinal === undefined ? undefined : choices[ordinal];
      const automatic = row.kind === "unchanged" || row.kind === "moved", fallback = automatic ? "automatic" : "unresolved";
      const entry = row.new ? label(row.new) : row.old ? label(row.old.occurrence) : t("entry", { number: index + 1 });
      const value = selected ? `${selected.decision}:${selected.oldOccurrenceId}` : fallback;
      return <tr key={row.new?.operationOccurrenceId ?? row.old?.occurrenceId ?? index}>
        <th scope="row">{t(`counts.${row.kind === "rename-candidate" ? "renameCandidate" : row.kind}`)}</th>
        <td>{content(row.old?.occurrence ?? null, true)}</td><td>{content(row.new, false)}</td>
        <td><div className={styles.decision}>{ordinal !== undefined ? <>
          <Field label={t("mappingField", { entry })}><Select disabled={disabled} value={value} onChange={event => {
            const value = event.target.value;
            if (value === fallback) { onChoice(ordinal, null); return; }
            for (const candidate of row.candidates) {
              if (!candidate.occurrenceId) continue;
              for (const decision of ["continue", "reject"] as const) if (value === `${decision}:${candidate.occurrenceId}`) {
                onChoice(ordinal, { newOrdinal: ordinal, oldOccurrenceId: candidate.occurrenceId, decision, reason: "" }); return;
              }
            }
          }}>
            <option value={fallback}>{t(automatic ? "automatic" : "unresolved")}</option>
            {row.candidates.flatMap(candidate => candidate.occurrenceId ? (["continue", "reject"] as const).map(decision =>
              <option key={`${decision}:${candidate.occurrenceId}`} value={`${decision}:${candidate.occurrenceId}`}>{t(decision, { entry: label(candidate.occurrence) })}</option>) : [])}
            {selected && !row.candidates.some(candidate => candidate.occurrenceId === selected.oldOccurrenceId) ? <option value={value}>{t("savedHistorical")}</option> : null}
          </Select></Field>
          {selected ? <Field label={t("reason", { entry })} required error={new TextEncoder().encode(selected.reason).byteLength > 4096 ? t("reasonTooLong") : undefined}>
            <TextArea rows={3} readOnly={disabled} value={selected.reason} onChange={event => onChoice(ordinal, { ...selected, reason: event.target.value })}/>
          </Field> : null}
          <Button size="sm" disabled={disabled} onClick={() => onHistorical(ordinal)}>{t("chooseHistorical")}</Button>
        </> : <p className={styles.meta}>{t("removedHelp")}</p>}
          <Button size="sm" disabled={disabled} onClick={() => onDetails(row)}>{t("details")}</Button>
        </div></td>
      </tr>;
    })}</tbody>
  </table></div>;
}
