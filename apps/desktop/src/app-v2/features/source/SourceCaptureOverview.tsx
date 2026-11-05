import { useTranslation } from "react-i18next";
import { Disclosure } from "../../../design-system/Disclosure";
import { Banner } from "../../../design-system/Feedback";
import { TokenizedText } from "../../../design-system/TokenizedText";
import type { ContentPage, Coverage } from "../../../sourceCommands";
import styles from "./SourceCaptureOverview.module.css";

const countKeys = ["items", "itemsWithFields", "declaredFields", "nonEmptyFields"] as const;

/** The parent supplies one immutable result or snapshot; this view owns no reads or writes. */
export default function SourceCaptureOverview({ summary, coverage }: {
  summary: ContentPage["captureSummary"]; coverage: Coverage[];
}) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "sourceMaintenance" });
  if (!summary) return null;
  const numbers = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language);
  return <section className={styles.body} aria-label={t("captureTitle")}>
    <h3>{t("captureTitle")}</h3><p className={styles.help}>{t("captureHelp")}</p>
    {summary.materials.map(material => {
      const file = coverage.find(file => file.artifactId === material.source.artifactId);
      if (!file) return <Banner key={material.source.artifactId} tone="error" role="alert">{t("captureSourceMissing")}</Banner>;
      return <section key={material.source.artifactId} className={styles.material} aria-label={file.logicalPath}>
        <h4><TokenizedText text={file.logicalPath}/></h4>
        <dl className={styles.counts}>{countKeys.map(key => <div key={key}>
          <dt>{t(`captureCounts.${key}`)}</dt><dd>{numbers.format(material.counts[key])}</dd>
        </div>)}</dl>
        {material.properties.length ? <Disclosure className={styles.disclosure} title={t("captureProperties")}>
          <dl className={styles.properties}>{material.properties.map(property => <div key={property.label}>
            <dt><TokenizedText text={property.label}/></dt><dd>{property.values.length
              ? property.values.map((value, index) => <p key={`${index}:${value}`}><TokenizedText text={value}/></p>)
              : t("captureNoValues")}</dd>
          </div>)}</dl>
        </Disclosure> : null}
        {material.groups.length ? <Disclosure className={styles.disclosure} title={t("captureGroups")}>
          <div className={styles.tableScroll} role="region" aria-label={t("captureGroupsFor", { file: file.logicalPath })} tabIndex={0}>
            <table className={styles.table}><thead><tr><th scope="col">{t("captureGroup")}</th>
              {countKeys.map(key => <th scope="col" key={key}>{t(`captureCounts.${key}`)}</th>)}
            </tr></thead><tbody>{material.groups.map(group => <tr key={group.label}>
              <th scope="row"><TokenizedText text={group.label}/></th>
              {countKeys.map(key => <td key={key}>{numbers.format(group.counts[key])}</td>)}
            </tr>)}</tbody></table>
          </div>
        </Disclosure> : null}
      </section>;
    })}
  </section>;
}
