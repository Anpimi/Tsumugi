import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { pluginCommands, type PluginTextReviewListEntry, type PluginTextReviewListView, type PluginTextReviewSelection } from "./pluginCommands";
import { checkerIdentity } from "./ReviewCheckers";

export function textReviewSelectionIdentity(choice: Pick<PluginTextReviewSelection, "package" | "resourceId" | "environmentDigest">): string {
  const plugin = choice.package.plugin;
  return JSON.stringify([plugin.publisher, plugin.id, plugin.version, choice.package.packageDigest, choice.resourceId, choice.environmentDigest]);
}

type Discovery = { kind: "loading" } | { kind: "ready"; view: PluginTextReviewListView } | { kind: "failed"; error: CommandFailure };
export function TextReviewSelections({ value, onChange, disabled, active, scopeKey, onOpenExtensions, onSnapshotRevision }: {
  value: PluginTextReviewSelection[]; onChange: (value: PluginTextReviewSelection[]) => void;
  disabled: boolean; active: boolean; scopeKey: string; onOpenExtensions?: () => void;
  onSnapshotRevision?: (revision: string) => void;
}) {
  const { t } = useTranslation();
  const [discovery, setDiscovery] = useState<Discovery>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const observed = useRef(onSnapshotRevision);
  useEffect(() => { observed.current = onSnapshotRevision; }, [onSnapshotRevision]);
  useEffect(() => {
    if (!active || disabled) return;
    let current = true;
    setDiscovery({ kind: "loading" });
    void pluginCommands.textReviews().then(view => { if (current) { setDiscovery({ kind: "ready", view }); observed.current?.(view.settingsRevision); } })
      .catch(error => { if (current) setDiscovery({ kind: "failed", error: commandFailure(error) }); });
    return () => { current = false; };
  }, [active, disabled, scopeKey, refresh]);
  const entries = discovery.kind === "ready" ? discovery.view.entries : [];
  const selectableIdentity = (entry: PluginTextReviewListEntry) => entry.environmentDigest === null ? null
    : textReviewSelectionIdentity({ ...entry, environmentDigest: entry.environmentDigest });
  const absent = value.filter(choice => !entries.some(entry => selectableIdentity(entry) === textReviewSelectionIdentity(choice)));
  const remove = (choice: PluginTextReviewSelection) => onChange(value.filter(candidate => textReviewSelectionIdentity(candidate) !== textReviewSelectionIdentity(choice)));
  return <section aria-label={t("review.advisoryChecks")}>
    <h4>{t("review.advisoryChecks")}</h4><p>{t("review.actionLocalChecks")}</p>
    <div className="form-actions"><button type="button" className="secondary-button" disabled={disabled}
      onClick={() => setRefresh(previous => previous + 1)}>{t("review.refreshCheckers")}</button>
      {onOpenExtensions ? <button type="button" className="text-button" disabled={disabled} onClick={onOpenExtensions}>{t("review.openExtensions")}</button> : null}</div>
    {discovery.kind === "loading" ? <p role="status">{t("review.loadingCheckers")}</p> : discovery.kind === "failed" ? <div role="alert">
      <p>{t("review.checkersReadFailed")}</p><CommandFailureDetails failure={discovery.error} /></div> : entries.length === 0 ? <p>{t("review.noAdvisoryChecks")}</p> : null}
    {entries.map(entry => {
      const identity = selectableIdentity(entry);
      const environmentDigest = entry.environmentDigest;
      const selected = value.find(choice => identity === textReviewSelectionIdentity(choice));
      const provider = entry.package.plugin;
      const checkerKey = entry.availability.kind === "ready" ? checkerIdentity({
        provider: entry.availability.view.binding.checker.provider, profile: entry.availability.view.binding.declaration.profile,
      }) : null;
      const alreadySelected = checkerKey !== null && !selected && entries.some(other =>
        other.availability.kind === "ready"
        && checkerIdentity({ provider: other.availability.view.binding.checker.provider, profile: other.availability.view.binding.declaration.profile })
          === checkerKey
        && value.some(choice => selectableIdentity(other) === textReviewSelectionIdentity(choice)));
      return <fieldset key={JSON.stringify([provider.publisher, provider.id, provider.version, entry.package.packageDigest, entry.resourceId, entry.environmentDigest])}>
        <legend>{provider.publisher}/{provider.id} {provider.version}</legend>
        {alreadySelected ? <p>{t("review.checkerAlreadySelected")}</p> : null}
        {entry.availability.kind === "ready" && environmentDigest !== null ? entry.availability.view.binding.declaration.rules.map(declared => {
          const checked = selected?.rules.some(rule => rule.id === declared.rule.id && rule.schemaVersion === declared.rule.schemaVersion && rule.behaviorVersion === declared.rule.behaviorVersion) ?? false;
          return <div key={JSON.stringify([declared.rule.id, declared.rule.schemaVersion, declared.rule.behaviorVersion])}>
            <label className="source-check"><input type="checkbox" checked={checked} disabled={disabled || alreadySelected}
              onChange={event => {
                const rules = event.target.checked ? [...(selected?.rules ?? []), declared.rule]
                  : (selected?.rules ?? []).filter(rule => rule.id !== declared.rule.id || rule.schemaVersion !== declared.rule.schemaVersion || rule.behaviorVersion !== declared.rule.behaviorVersion);
                const others = value.filter(choice => textReviewSelectionIdentity(choice) !== identity);
                onChange(rules.length ? [...others, { package: entry.package, resourceId: entry.resourceId, environmentDigest, rules }] : others);
              }} />{declared.title}</label><p>{declared.description}</p>
          </div>;
        }) : <div role="status"><p>{t("review.selectedCheckerUnavailable")}</p>
          {entry.availability.kind === "unavailable" ? <CommandFailureDetails failure={commandFailure(entry.availability.error)} /> : null}
          {selected ? <button type="button" className="text-button" disabled={disabled} onClick={() => remove(selected)}>{t("review.removeAdvisoryCheck")}</button> : null}</div>}
        <details><summary>{t("execution.diagnostic")}</summary><p>{entry.resourceId}</p><code>{entry.package.packageDigest}</code>
          {entry.environmentDigest ? <p><code>{entry.environmentDigest}</code></p> : null}</details>
      </fieldset>;
    })}
    {absent.map(choice => <div key={textReviewSelectionIdentity(choice)} role="status"><p>{t("review.selectedCheckerUnavailable")}: {choice.package.plugin.publisher}/{choice.package.plugin.id} {choice.package.plugin.version}</p>
      <ul>{choice.rules.map(rule => <li key={JSON.stringify([rule.id, rule.schemaVersion, rule.behaviorVersion])}>{rule.id}</li>)}</ul>
      <button type="button" className="text-button" disabled={disabled} onClick={() => remove(choice)}>{t("review.removeAdvisoryCheck")}</button></div>)}
  </section>;
}
