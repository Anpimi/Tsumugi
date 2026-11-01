import { useTranslation } from "react-i18next";
import { conversationCommands, type ConversationProposalRevision } from "../../../conversationCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { planningUnitLabels } from "./proposalDraft";
import { Badge } from "../../../design-system/Badge";
import styles from "./ConversationPanel.module.css";

type Entries = Extract<ConversationProposalRevision["content"], { kind: "term-proposal" }>["entries"];

/** These are the fixed model entries. Target editing belongs to resource review. */
export function ConversationTermEntries({ entries, locale, labels }: {
  entries: Entries; locale?: string; labels?: ReadonlyMap<string, { key: string; text: string }>;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  return <section aria-label={t("termEntries")}><h4>{t("termEntries")}</h4>{entries.map((entry, index) => <article key={index}>
    <h5>{t("termEntry", { number: index + 1 })}</h5>
    <dl><dt>{t("termSource")}</dt><dd className={styles.text}>{entry.source}</dd>
      <dt>{t("termTarget")}</dt><dd className={styles.text}>{entry.target}</dd>
      <dt>{t("termAliases")}</dt><dd className={styles.text}>{entry.aliases.length ? entry.aliases.join(", ") : t("termNoAliases")}</dd>
      <dt>{t("termScope")}</dt><dd>{labels?.get(entry.unitId)?.key ?? t("termSourceEntry", { unitId: entry.unitId })}{locale ? <p>{t("termLocale", { locale })}</p> : null}</dd>
      <dt>{t("termReason")}</dt><dd className={styles.text}>{entry.reason}</dd></dl>
    {entry.protected ? <Badge>{t("termProtected")}</Badge> : null}
    {labels?.get(entry.unitId)?.text ? <p className={styles.text}>{labels.get(entry.unitId)?.text}</p> : null}
  </article>)}</section>;
}

export function ConversationSavedTermEntries({ revision, active }: { revision: ConversationProposalRevision; active: boolean }) {
  const reads = useSessionReads();
  const original = useSessionQuery({ key: ["conversation", revision.conversationId, "planning", revision.origin.attemptId], scopes: ["project", "execution"],
    enabled: active && !reads.retired && revision.content.kind === "term-proposal",
    read: () => conversationCommands.readPlanning({ ...reads.context, conversationId: revision.conversationId, attemptId: revision.origin.attemptId }) });
  if (revision.content.kind !== "term-proposal") return null;
  const run = original.data?.resultId === revision.origin.resultId ? original.data : null;
  return <ConversationTermEntries entries={revision.content.entries} locale={run?.preview.scope.kind === "units" ? run.preview.scope.locale : undefined} labels={planningUnitLabels(run?.preview.input ?? "")}/>;
}
