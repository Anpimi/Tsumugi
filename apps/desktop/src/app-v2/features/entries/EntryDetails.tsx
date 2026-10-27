import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { EmptyState, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { Button } from "../../../design-system/Button";
import { TokenizedText } from "../../../design-system/TokenizedText";
import { readEntryDetails } from "./entryReads";
import styles from "../../WorkbenchLayout.module.css";

export default function EntryDetails({ unitId, locale, disabled }: { unitId: string | null; locale: string; disabled: boolean }) {
  const { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const reads = useSessionReads();
  const query = useSessionQuery({ key: ["workbench-entry-details", unitId, locale], scopes: ["source", "translation", "resources", "review"],
    enabled: !!unitId && !!locale && !disabled, read: () => { if (!unitId) throw new Error("No entry selected"); return readEntryDetails(reads, unitId, locale); } });
  if (!unitId) return <EmptyState icon={<FileText />} title={t("chooseEntry")} description={t("chooseEntryHelp")} />;
  if (query.isError) return <ErrorState title={t("readFailed")} description={t("readFailedHelp")} action={<Button disabled={disabled} onClick={() => void query.refetch()}>{t("refresh")}</Button>} />;
  if (!query.data) return <LoadingState label={t("loadingDetails")} />;
  const target = query.data.target;
  const decision = target.currentDecision;
  const check = target.currentCheck;
  const review = !decision ? t("notReviewed") : decision.basis !== target.basis ? t("needsReview") : decision.kind === "approve" ? t("approved") : t("changesRequested");
  const checkStatus = !check ? t("notChecked") : check.basis !== target.basis ? t("checkOutdated") : t(`checkOutcome.${check.outcome}`);
  return <div className={styles.details}>
    <h2>{t("detail")}</h2><span className={styles.key}>{target.nativeKey}</span>
    <dl><div><dt>{t("selectedTranslation")}</dt><dd>{target.selectionId === null ? t("noTranslation") : t("selected")}</dd></div>
      <div><dt>{t("humanReview")}</dt><dd>{review}</dd></div><div><dt>{t("ruleChecks")}</dt><dd>{checkStatus}</dd></div>
      <div><dt>{t("context")}</dt><dd>{target.termConflict ? t("termConflict") : t("noTermConflict")}</dd></div></dl>
    <p className={styles.meta}>{t("factsHelp")}</p>
    <h3>{t("source", { locale: "" })}</h3><p><TokenizedText text={target.sourceText} /></p>
    <h3>{t("translation", { locale })}</h3><p><TokenizedText text={target.translationText ?? t("noTranslation")} /></p>
  </div>;
}
