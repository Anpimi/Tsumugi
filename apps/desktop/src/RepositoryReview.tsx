import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { PluginPermissions } from "./PluginPermissions";
import type { PluginInventoryView, PluginRepositoryVerifiedView } from "./pluginCommands";

export function RepositoryReview({ repository, selected, rollbacks, inventory, disabled, discardDisabled, headingRef, onSelect, onRollback, onInstall, onDiscard }: {
  repository: PluginRepositoryVerifiedView;
  selected: readonly string[];
  rollbacks: readonly string[];
  inventory: PluginInventoryView | undefined;
  disabled: boolean;
  discardDisabled: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onSelect: (digest: string, checked: boolean) => void;
  onRollback: (digest: string, checked: boolean) => void;
  onInstall: () => void;
  onDiscard: () => void;
}) {
  const { t, i18n } = useTranslation();
  const known = inventory ? [...inventory.packageDecisions, ...inventory.packages, ...inventory.uninstallations.map(item => item.installation)] : [];
  const conflicts = (member: PluginRepositoryVerifiedView["packages"][number]) => known.some(item => item.plugin.id === member.manifest.plugin.id
    && (item.plugin.publisher !== member.manifest.plugin.publisher || item.origin.sourceId !== member.origin.sourceId || item.origin.publisherId !== member.origin.publisherId));
  const chosen = repository.packages.filter(member => selected.includes(member.packageDigest));
  const includesRollback = chosen.some(member => member.kind === "rollback");
  const rollbackMissing = chosen.some(member => member.kind === "rollback" && !rollbacks.includes(member.packageDigest));
  const expiry = Number(repository.expiresAtUnixMilliseconds);
  const expiryDate = Number.isSafeInteger(expiry) && expiry >= 0 && expiry <= 8_640_000_000_000_000 ? new Date(expiry) : null;
  return <section className="plugin-section" aria-labelledby="repository-review-heading">
    <h3 id="repository-review-heading" tabIndex={-1} ref={headingRef}>{t("plugins.repositoryCatalog", { name: repository.displayName })}</h3>
    <p>{t("plugins.repositoryVerified")}</p>
    <p>{t("plugins.repositoryOneVersion")}</p>
    {expiryDate ? <p>{t("plugins.repositoryExpiry", { date: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "medium" }).format(expiryDate) })}</p>
      : <p role="alert">{t("plugins.repositoryMetadataInvalid")}</p>}
    <details><summary>{t("plugins.repositoryMetadataVersions")}</summary>
      <p>{t("plugins.repositorySource", { source: repository.sourceId })}</p>
      <p>{t("plugins.repositoryVersions", { root: repository.rootVersion, timestamp: repository.timestampVersion, snapshot: repository.snapshotVersion, targets: repository.targetsVersion })}</p>
      <code>{repository.captureDigest}</code>
    </details>
    <ul className="plugin-list">{repository.packages.map(member => {
      const plugin = member.manifest.plugin;
      const conflict = conflicts(member);
      const checked = selected.includes(member.packageDigest);
      return <li key={member.packageDigest}>
        <h4>{plugin.id} · {plugin.version}</h4>
        <p>{t("plugins.declaredPublisher", { publisher: plugin.publisher })}</p>
        <p>{t("plugins.repositoryPublisher", { publisher: member.origin.publisherId })}</p>
        <p>{t(`plugins.repositoryKinds.${member.kind}`)}</p>
        {conflict ? <p role="alert">{t("plugins.repositorySourceConflict")}</p> : null}
        <h5>{t("plugins.runtime")}</h5>
        <ul>{member.manifest.components.map(component => <li key={component.id}>{component.id}: {t(`plugins.runtimes.${component.runtime}`)}</li>)}</ul>
        <h5>{t("plugins.permissionsTitle")}</h5>
        <PluginPermissions permissions={member.manifest.permissions}/>
        {member.manifest.contributions.map(contribution => contribution.contribution.kind === "capability"
          ? <div key={contribution.id}><p>{t("plugins.capability", { name: contribution.id })}</p><PluginPermissions permissions={contribution.contribution.declaration.permissions}/></div> : null)}
        <details><summary>{t("plugins.fingerprint")}</summary><code>{member.packageDigest}</code><p>{t("plugins.files", { count: member.fileCount, bytes: member.byteCount })}</p></details>
        <label className="plugin-consent"><input type="checkbox" checked={checked} disabled={disabled || (conflict && !checked)}
          onChange={event => onSelect(member.packageDigest, event.target.checked)}/>{t("plugins.repositoryMemberConsent", { name: plugin.id, version: plugin.version })}</label>
        {member.kind === "rollback" ? <><p>{t("plugins.repositoryRollbackHelp")}</p>
          <label className="plugin-consent"><input type="checkbox" checked={rollbacks.includes(member.packageDigest)} disabled={disabled || !checked || conflict}
            onChange={event => onRollback(member.packageDigest, event.target.checked)}/>{t("plugins.repositoryRollbackConsent", { name: plugin.id, version: plugin.version })}</label>
        </> : null}
      </li>;
    })}</ul>
    <p>{t("plugins.repositoryInstallEffect")}</p>
    <p>{t("plugins.packPartial")}</p>
    <div className="execution-actions"><button type="button" className="primary-button" disabled={disabled || chosen.length === 0 || rollbackMissing || chosen.some(conflicts) || expiryDate === null} onClick={onInstall}>
      {t(includesRollback ? "plugins.repositoryInstallRollback" : "plugins.repositoryInstall")}
    </button><button type="button" className="secondary-button" disabled={discardDisabled} onClick={onDiscard}>{t("plugins.repositoryDiscard")}</button></div>
  </section>;
}
