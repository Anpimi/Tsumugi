import { useTranslation } from "react-i18next";
import type { SavedPluginBuildView } from "./releaseCommands";

/** Metadata from the Core's original plan/result projection, never execution consent. */
export function SavedPluginBuildSummary({ build, itemId }: { build: SavedPluginBuildView; itemId?: string }) {
  const { t } = useTranslation();
  const locales = itemId ? build.locales.filter(locale => locale.itemId === itemId) : build.locales;
  return <section aria-label={t("releasePlugin.savedTitle")}>
    <h3>{t("releasePlugin.savedTitle")}</h3>
    <p>{t("releasePlugin.savedReadOnly")}</p>
    <p>{t("release.source", { id: build.sourceSnapshotId })} · {build.policyVersion}</p>
    <p>{build.build.binding.declaration.displayName}</p>
    <details><summary>{t("sourcePlugin.fixedDetails")}</summary><dl>
      <dt>{t("releasePlugin.savedInput")}</dt><dd><code>{build.inputDigest}</code></dd>
      <dt>{t("sourcePlugin.packageDigest")}</dt><dd><code>{build.build.binding.builder.provider.packageDigest}</code></dd>
    </dl></details>
    {locales.length === 0 ? <p>{t("releasePlugin.savedEmpty")}</p> : <ul>{locales.map(locale => <li key={locale.itemId}>
      <h4>{locale.choice.locale}</h4><p>{t("releasePlugin.savedTargets", { count: locale.targetCount })}</p>
      <p>{t(`execution.states.${locale.status.execution}`)} · {t(`releasePlugin.validation.${locale.status.validation}`)}</p>
      {locale.status.cancellationRequested ? <p>{t("releasePlugin.cancelled")}</p> : null}
      {locale.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary><code>{locale.status.diagnostic}</code></details> : null}
      <p>{t("releasePlugin.savedPaths")}</p><ul>{locale.choice.outputPaths.map(path => <li key={path}>{path}</li>)}</ul>
      {!locale.result ? <p>{t("releasePlugin.savedNoResult")}</p>
        : locale.result.outcome !== "succeeded" ? <p>{t("releasePlugin.savedFailed")}</p>
        : <ul aria-label={t("releasePlugin.savedArtifacts", { locale: locale.choice.locale })}>{locale.result.artifacts.map(artifact => <li key={artifact.id}>
          <strong>{artifact.logicalPath}</strong><p>{t("releasePlugin.savedRole", { role: artifact.role })} · {t("releasePlugin.bytes", { count: artifact.byteLength })}</p>
          <code aria-label={t("releasePlugin.savedSha", { path: artifact.logicalPath })}>{artifact.sha256}</code>
        </li>)}</ul>}
    </li>)}</ul>}
  </section>;
}
