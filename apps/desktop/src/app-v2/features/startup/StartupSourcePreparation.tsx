import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Field } from "../../../design-system/Field";
import { Banner, LoadingState } from "../../../design-system/Feedback";
import { CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import { matchingPluginEnvironments, pluginEnvironmentVersion } from "../../../pluginEnvironments";
import type { sourceReads } from "../../../sourceQueries";
import type { StartupDirectory, StartupPreflight } from "../../../startupCommands";
import styles from "./ManualProjectPlan.module.css";

export interface StartupSourcePlan {
  directory: StartupDirectory | null;
  folderName: string;
  choice: string;
  runtime: string;
  preflight: StartupPreflight | null;
  expired: boolean;
}
export type StartupSourceInventory = Awaited<ReturnType<ReturnType<typeof sourceReads.inventory>["read"]>>;

/** The editable plan displays the existing Source owner's declarations; it never starts an import. */
export default function StartupSourcePreparation({ plan, inventory, loading, inventoryFailed, failure, busy, native, checking, selecting, ready,
  onChoose, onRefresh, onChange, onCheck, onManual }: {
  plan: StartupSourcePlan | null; inventory: StartupSourceInventory | undefined; loading: boolean; inventoryFailed: boolean;
  failure: CommandFailure | null; busy: boolean; native: boolean; checking: boolean; selecting: boolean; ready: boolean;
  onChoose: () => void; onRefresh: () => void; onChange: (choice: string, runtime: string) => void; onCheck: () => void; onManual: () => void;
}) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "startup" });
  const choice = inventory?.choices.find(value => value.key === plan?.choice);
  const runtimes = matchingPluginEnvironments(inventory?.environments ?? [], choice?.runtimeKinds ?? []);
  return <section className={styles.sourcePlan} aria-label={t("sourcePlanTitle")}>
    <h2 className={styles.sectionTitle}>{t("sourcePlanTitle")}</h2>
    <p className={styles.destination}>{t("sourcePlanHelp")}</p>
    <div className={styles.actions}>
      <Button disabled={!native || busy || selecting || checking || loading} pending={selecting} onClick={onChoose}>{t("chooseSourceFolder")}</Button>
      {plan ? <Button disabled={busy || selecting || checking} onClick={onManual}>{t("useManual")}</Button> : null}
    </div>
    {plan ? <>
      {plan.folderName ? <p className={styles.destination}>{t("sourceFolder", { folder: plan.folderName })}</p> : null}
      {plan.expired ? <Banner tone="warning">{t("sourceSelectionExpired")}</Banner> : null}
      {loading ? <LoadingState label={t("readingSourceOptions")}/> : null}
      {inventoryFailed ? <Banner tone="error">{t("sourceOptionsFailed")}</Banner> : null}
      <Button disabled={busy || loading || selecting || checking} onClick={onRefresh}>{t("refreshSourceOptions")}</Button>
      {!loading && !inventoryFailed && inventory?.choices.length === 0 ? <Banner tone="warning">{t("noSourceFormats")}</Banner> : null}
      <Field label={t("sourceFormat")}><select value={plan.choice} disabled={busy || selecting || checking || loading || inventoryFailed}
        onChange={event => onChange(event.target.value, "")}>
        <option value="">{t("chooseSourceFormat")}</option>
        {inventory?.choices.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}
      </select></Field>
      <Field label={t("sourceRuntime")}><select value={plan.runtime} disabled={busy || selecting || checking || loading || inventoryFailed || !choice}
        onChange={event => onChange(plan.choice, event.target.value)}>
        <option value="">{t("chooseSourceRuntime")}</option>
        {runtimes.map(value => <option key={value.environmentDigest} value={value.environmentDigest}>{t(value.environment.profile === "node-system-libraries-v1" ? "runtimeOption" : "nativeRuntimeOption",
          { version: pluginEnvironmentVersion(value.environment), system: value.environment.platform.operatingSystem, architecture: value.environment.platform.architecture })}</option>)}
      </select></Field>
      {choice && !loading && runtimes.length === 0 ? <Banner tone="warning">{t("noSourceRuntime")}</Banner> : null}
      {failure ? <Banner tone="error">{t(plan.directory ? "sourceCheckFailed" : "sourceSelectionFailed")}<CommandFailureDetails failure={failure}/></Banner> : null}
      <Button disabled={!native || busy || selecting || checking || loading || inventoryFailed || !plan.directory || !choice || !runtimes.some(value => value.environmentDigest === plan.runtime)}
        pending={checking} onClick={onCheck}>{t(checking ? "checkingSource" : "checkSource")}</Button>
      {plan.preflight ? <>
        <Banner tone={ready ? "success" : "warning"}>{t(ready ? "sourceReady" : plan.preflight.complete ? "sourceNeedsCheck" : "sourceMissing")}</Banner>
        <p className={styles.destination}>{plan.preflight.source.declaration.displayName}</p>
        <ul className={styles.materials}>{plan.preflight.materials.map(file => <li key={file.logicalPath}>
          <span>{t(file.byteLength === null ? "sourceMaterialMissing" : "sourceMaterialPresent", { path: file.logicalPath })}</span>
          <span className={styles.materialLimit}>{t("sourceMaterialLimit", { bytes: file.maxBytes.toLocaleString(i18n.language) })}</span>
        </li>)}</ul>
      </> : <p className={styles.destination}>{t("sourceNeedsCheck")}</p>}
      <p className={styles.destination}>{t("sourceFixedOnly")}</p>
      <p className={styles.destination}>{t("sourceCreateHelp")}</p>
    </> : null}
  </section>;
}
