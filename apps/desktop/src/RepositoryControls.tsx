import { Button } from "./design-system/Button";
import { Field } from "./design-system/Field";
import { Banner } from "./design-system/Feedback";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import type { PluginRepositorySelectionView, PluginRepositorySourcesView, PluginRepositorySourceView } from "./pluginCommands";

export function RepositoryControls({ sources, reading, readFailure, selection, consent, disabled, readDisabled, headingRef, chooseRef, onChoose, onRead, onConsent, onRefresh, onResume }: {
  sources: PluginRepositorySourcesView | undefined;
  reading: boolean;
  readFailure: CommandFailure | null;
  selection: PluginRepositorySelectionView | null;
  consent: boolean;
  disabled: boolean;
  readDisabled: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  chooseRef: Ref<HTMLButtonElement>;
  onChoose: () => void;
  onRead: () => void;
  onConsent: (checked: boolean) => void;
  onRefresh: () => void;
  onResume: (source: PluginRepositorySourceView) => void;
}) {
  const { t } = useTranslation();
  const pendingSelection = selection !== null && sources?.sources.some(source => source.sourceId === selection.sourceId && source.state === "pending");
  return <section id="plugin-repositories" className="plugin-section" aria-labelledby="repository-heading">
    <h3 id="repository-heading" tabIndex={-1} ref={headingRef}>{t("plugins.repositoryTitle")}</h3>
    <p>{t("plugins.repositoryDescription")}</p>
    <div className="execution-actions">
      <Button ref={chooseRef} type="button" variant="secondary" disabled={disabled || reading} onClick={onChoose}>{t("plugins.repositoryChoose")}</Button>
      <Button type="button" variant="secondary" disabled={reading || readDisabled} onClick={onRead}>{t("plugins.repositoryRead")}</Button>
    </div>
    {reading ? <p role="status">{t("plugins.repositoryReading")}</p> : null}
    {readFailure ? <Banner tone="error" role="alert"><p>{t("plugins.repositoryReadFailed")}</p><CommandFailureDetails failure={readFailure}/></Banner> : null}
    {sources?.sources.length === 0 ? <p>{t("plugins.repositoryEmpty")}</p> : null}
    {sources?.sources.length ? <ul className="plugin-list">{sources.sources.map(source => {
      const name = source.displayName ?? t("plugins.repositoryUnnamed");
      return <li key={source.sourceId}>
      <strong>{name}</strong>
      <p>{t(`plugins.repositoryStates.${source.state}`)}</p>
      <details><summary>{t("plugins.repositorySourceDetails")}</summary><code>{source.sourceId}</code>
        <p>{t("plugins.repositoryRootFingerprint")}: <code>{source.rootFingerprint}</code></p></details>
      {source.state !== "rejected" && source.actionId !== null && source.expectedRevision !== null ? <Button type="button" variant="secondary" disabled={disabled || reading || readFailure !== null}
        onClick={() => onResume(source)} aria-label={t(source.state === "pending" ? "plugins.repositoryResumeNamed" : "plugins.repositoryReviewNamed", { source: name })}>
        {t(source.state === "pending" ? "plugins.repositoryResume" : "plugins.repositoryReviewSaved")}
      </Button> : null}
    </li>; })}</ul> : null}
    {selection ? <section aria-labelledby="repository-root-heading">
      <h4 id="repository-root-heading">{t("plugins.repositoryRootTitle")}</h4>
      <p>{t("plugins.repositoryRootHelp")}</p>
      <details><summary>{t("plugins.repositorySourceDetails")}</summary><code>{selection.sourceId}</code></details>
      <p>{t("plugins.repositoryRootFingerprint")}: <code>{selection.rootFingerprint}</code></p>
      {pendingSelection ? <p role="alert">{t("plugins.repositoryResumeFirst")}</p> : null}
      <Field className="plugin-consent" label={t("plugins.repositoryTrustConsent")}><input type="checkbox" checked={consent} disabled={disabled || reading} onChange={event => onConsent(event.target.checked)}/></Field>
      <Button type="button" variant="primary" disabled={disabled || reading || !consent || pendingSelection} onClick={onRefresh}>{t("plugins.repositoryRefresh")}</Button>
    </section> : null}
  </section>;
}
