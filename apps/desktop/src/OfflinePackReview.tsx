import { useTranslation } from "react-i18next";
import type { Ref } from "react";
import type { PluginPackCandidateView, PluginInventoryView } from "./pluginCommands";
import { PackagePermissionReview } from "./PluginPermissions";
import { Button } from "./design-system/Button";
import { Field } from "./design-system/Field";
import type { PluginPackageDetailsView } from "./pluginCommands";

/** Review uses captured declarations. Each checkbox approves one exact member,
 * never all present or future members under a Pack's name. */
export function OfflinePackReview({ pack, approvedManifests, selected, inventory, disabled, headingRef, onSelect, onInstall, onDiscard }: {
  pack: PluginPackCandidateView;
  approvedManifests?: ReadonlyMap<string, PluginPackageDetailsView["manifest"]>;
  selected: readonly string[];
  inventory: PluginInventoryView;
  disabled: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  onSelect: (digest: string, checked: boolean) => void;
  onInstall: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const knownPackages = [...inventory.packageDecisions, ...inventory.packages, ...inventory.uninstallations.map(item => item.installation)];
  const sourceConflict = (id: string, publisher: string) => knownPackages.some(item => item.plugin.id === id
    && (item.origin.sourceId !== "manual-local" || item.origin.publisherId !== "manual-approval" || item.plugin.publisher !== publisher));
  const selectedConflict = pack.packages.some(member => selected.includes(member.packageDigest)
    && sourceConflict(member.manifest.plugin.id, member.manifest.plugin.publisher));
  return <section className="plugin-section" aria-labelledby="offline-pack-heading">
    <h3 ref={headingRef} id="offline-pack-heading" tabIndex={-1}>{t("plugins.packTitle", { name: pack.displayName })}</h3>
    <p>{t("plugins.packTrust")}</p>
    <p>{t("plugins.packSnapshot")}</p>
    <ul className="plugin-list">{pack.packages.map(member => {
      const plugin = member.manifest.plugin;
      const prior = knownPackages.some(item => item.plugin.id === plugin.id);
      return <li key={member.packageDigest}>
        <h4>{plugin.id} · {plugin.version}</h4>
        <p>{t("plugins.declaredPublisher", { publisher: plugin.publisher })}</p>
        <p>{t(prior ? "plugins.packExisting" : "plugins.packNewMember")}</p>
        {sourceConflict(plugin.id, plugin.publisher)
          ? <p role="alert">{t("plugins.packSourceConflict")}</p> : null}
        <h5>{t("plugins.runtime")}</h5>
        <ul>{member.manifest.components.map(component => <li key={component.id}>{component.id}: {t(`plugins.runtimes.${component.runtime}`)}</li>)}</ul>
        <PackagePermissionReview manifest={member.manifest} approvedManifest={approvedManifests?.get(member.packageDigest)} review/>
        <details><summary>{t("plugins.fingerprint")}</summary><code>{member.packageDigest}</code><p>{t("plugins.files", { count: member.fileCount, bytes: member.byteCount })}</p></details>
        <Field className="plugin-consent" label={t("plugins.packMemberConsent", { name: plugin.id, version: plugin.version })}><input type="checkbox" disabled={disabled} checked={selected.includes(member.packageDigest)}
          onChange={event => onSelect(member.packageDigest, event.target.checked)}/></Field>
      </li>;
    })}</ul>
    <p>{t("plugins.installEffect")}</p>
    <p>{t("plugins.packPartial")}</p>
    <div className="execution-actions"><Button type="button" variant="primary" disabled={disabled || selected.length === 0 || selectedConflict} onClick={onInstall}>{t("plugins.packInstall")}</Button>
      <Button type="button" variant="secondary" disabled={disabled} onClick={onDiscard}>{t("plugins.discard")}</Button></div>
  </section>;
}
