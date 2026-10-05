import { useEffect, useRef, useState } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure, type CommandFailure } from "./CommandFailure";
import { isCommandError } from "./projectCommands";
import { pluginCommands, type PluginCandidateView, type PluginInstallRequest, type PluginEnableRequest, type PluginPackageDetailsView, type PermissionRequest } from "./pluginCommands";
import "./PluginManager.css";
import type { TranslationKey } from "./i18n/types";

const inventoryKey = ["application", "plugins", "inventory"] as const;
type Intent = { kind: "install"; request: PluginInstallRequest } | { kind: "enable"; request: PluginEnableRequest };
const reasonMessages: Partial<Record<string, TranslationKey>> = {
  "plugin-selection-expired": "plugins.selectionExpired",
  "plugin-candidate-changed": "plugins.candidateChanged",
  "plugin-recovery-required": "plugins.recovery",
  "plugin-settings-corrupt": "plugins.settingsInvalid",
  "plugin-directory-unavailable": "plugins.directoryUnavailable",
  "plugin-store-busy": "plugins.busy",
  "plugin-operation-pending": "plugins.pending",
  "plugin-approval-mismatch": "plugins.approvalMismatch",
};
function failureMessage(failure: CommandFailure, unknown: boolean): TranslationKey {
  if (unknown) return "plugins.unknown";
  if (typeof failure !== "string") {
    if (failure.code === "stale-revision") return "plugins.conflict";
    const known = failure.reason ? reasonMessages[failure.reason] : undefined;
    if (known) return known;
  }
  return "plugins.failed";
}

function Permissions({ permissions }: { permissions: PermissionRequest[] }) {
  const { t } = useTranslation();
  if (!permissions.length) return <p>{t("plugins.noPermissions")}</p>;
  return <ul>{permissions.map((permission, index) => <li key={index}>{t(`plugins.permissions.${permission.kind}`)}
    {permission.kind === "network" ? <>: <code>{permission.destination}</code></> : null}
    {permission.kind === "process" ? <>: <code>{permission.program}</code></> : null}
    {permission.kind === "project-service" ? <>: <code>{permission.contract.id}</code> ({permission.contract.schemaVersion}/{permission.contract.behaviorVersion})</> : null}
  </li>)}</ul>;
}

/** Application configuration stays mounted across project switches and panel
 * close. A rejected/unknown mutation retains its original request for recovery. */
export function PluginManager({ disabled, onBusyChange }: { disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: {
    networkMode: "always", retry: false, staleTime: 0, gcTime: 60_000,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  } } }));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const [candidate, setCandidate] = useState<PluginCandidateView | null>(null);
  const [consent, setConsent] = useState(false);
  const [details, setDetails] = useState<PluginPackageDetailsView | null>(null);
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [saved, setSaved] = useState(false);
  const query = useQuery({ queryKey: inventoryKey, enabled: open, queryFn: async ({ signal }) => {
    const result = await pluginCommands.inventory();
    if (signal.aborted) throw new Error("Plugin read cancelled");
    return result;
  } }, client);
  useEffect(() => { onBusyChange(busy || unknown); }, [busy, unknown, onBusyChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; client.clear(); }; }, [client]);

  async function operation(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    setSaved(false);
    try { await work(); }
    catch (error) { if (mounted.current) setFailure(commandFailure(error)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit(next: Intent) {
    await operation(async () => {
      setIntent(next);
      await client.cancelQueries({ queryKey: inventoryKey });
      try {
        const result = next.kind === "install" ? await pluginCommands.install(next.request) : await pluginCommands.enable(next.request);
        if (!mounted.current) return;
        client.setQueryData(inventoryKey, result);
        setIntent(null);
        setUnknown(false);
        setCandidate(null);
        setConsent(false);
        setDetails(null);
        setSaved(true);
      } catch (error) {
        if (mounted.current) setUnknown(!isCommandError(error) || error.code === "outcome-unknown");
        throw error;
      }
    });
  }
  const blocked = busy || unknown || query.isFetching || !query.data || query.isError;
  const inventory = query.data;
  return <Dialog open={open} onOpenChange={next => { if (!running.current) setOpen(next); }}>
    <DialogTrigger asChild><button type="button" className="secondary-button" disabled={disabled}>{t("plugins.open")}</button></DialogTrigger>
    <DialogPortal><DialogOverlay className="dialog-backdrop"/><DialogContent className="execution-dialog plugin-manager" aria-busy={busy}
      onEscapeKeyDown={event => { if (running.current) event.preventDefault(); }} onInteractOutside={event => { if (running.current) event.preventDefault(); }}>
      <div className="execution-heading"><div><DialogTitle>{t("plugins.title")}</DialogTitle><DialogDescription>{t("plugins.description")}</DialogDescription></div>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>{t("plugins.close")}</button></div>
      <div className="execution-actions"><button type="button" className="primary-button" disabled={blocked} onClick={() => void operation(async () => {
        setConsent(false);
        const selected = await pluginCommands.select();
        if (mounted.current && selected) { setCandidate(selected); setConsent(false); setIntent(null); }
      })}>{t("plugins.choose")}</button>
        <button type="button" className="secondary-button" disabled={busy || query.isFetching} onClick={() => void query.refetch()}>{t("plugins.refresh")}</button></div>
      {busy || query.isFetching ? <p role="status">{t("plugins.loading")}</p> : null}
      {query.isError ? <div role="alert"><p>{t("plugins.readFailed")}</p>{query.data ? <p>{t("plugins.stale")}</p> : null}<CommandFailureDetails failure={commandFailure(query.error)}/></div> : null}
      {saved ? <p role="status">{t("plugins.saved")}</p> : null}
      {failure ? <div role="alert"><p>{t(failureMessage(failure, unknown))}</p>
        <CommandFailureDetails failure={failure}/>{intent ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void submit(intent)}>{t("plugins.retryOriginal")}</button> : null}
        {!unknown && intent ? <button type="button" className="text-button" disabled={busy} onClick={() => { setIntent(null); setFailure(null); setCandidate(null); setConsent(false); void query.refetch(); }}>{t("plugins.reviewCurrent")}</button> : null}
      </div> : null}
      {candidate ? <section className="plugin-section" aria-label={t("plugins.candidate")}><h3>{t("plugins.candidate")}</h3>
        <p><strong>{candidate.manifest.plugin.id}</strong> · {candidate.manifest.plugin.version}</p>
        <p>{t("plugins.declaredPublisher", { publisher: candidate.manifest.plugin.publisher })}</p>
        <p>{t("plugins.manualTrust")}</p>
        <h4>{t("plugins.runtime")}</h4><ul>{candidate.manifest.components.map(component => <li key={component.id}>{component.id}: {t(`plugins.runtimes.${component.runtime}`)}</li>)}</ul>
        <h4>{t("plugins.permissionsTitle")}</h4><Permissions permissions={candidate.manifest.permissions}/>
        {candidate.manifest.contributions.map(contribution => contribution.contribution.kind === "capability" ? <div key={contribution.id}><p>{t("plugins.capability", { name: contribution.id })}</p><Permissions permissions={contribution.contribution.declaration.permissions}/></div> : null)}
        <details><summary>{t("plugins.fingerprint")}</summary><p><code>{candidate.packageDigest}</code></p><p>{t("plugins.files", { count: candidate.fileCount, bytes: candidate.byteCount })}</p></details>
        <p>{t("plugins.installEffect")}</p>
        <label className="plugin-consent"><input type="checkbox" checked={consent} disabled={busy || unknown} onChange={event => setConsent(event.target.checked)}/>{t("plugins.consent")}</label>
        <div className="execution-actions"><button type="button" className="primary-button" disabled={blocked || !consent || intent !== null} onClick={() => {
          if (query.data) void submit({ kind: "install", request: { ticket: candidate.ticket, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } });
        }}>{t("plugins.install")}</button>
          <button type="button" className="secondary-button" disabled={busy || unknown} onClick={() => { setCandidate(null); setConsent(false); }}>{t("plugins.discard")}</button></div>
      </section> : null}
      {inventory ? <section className="plugin-section" aria-label={t("plugins.installed")}><h3>{t("plugins.installed")}</h3>
        {!inventory.packages.length ? <p>{t("plugins.empty")}</p> : <ul className="plugin-list">{inventory.packages.map(record => {
          const decision = inventory.packageDecisions.find(value => value.packageDigest === record.packageDigest && value.plugin.id === record.plugin.id && value.plugin.publisher === record.plugin.publisher && value.plugin.version === record.plugin.version);
          return <li key={record.packageDigest}><div><strong>{record.plugin.id}</strong> · {record.plugin.version}</div>
            <p>{t("plugins.declaredPublisher", { publisher: record.plugin.publisher })}</p>
            <p>{t(record.state === "recovery-required" ? "plugins.recovery" : !decision ? "plugins.unapproved" : decision.enabled ? "plugins.enabled" : "plugins.disabled")}</p>
            <details><summary>{t("plugins.fingerprint")}</summary><code>{record.packageDigest}</code><p>{t("plugins.origin", { source: record.origin.sourceId, publisher: record.origin.publisherId })}</p></details>
            {decision ? <div className="execution-actions"><button type="button" className="secondary-button" disabled={blocked || intent !== null || (!decision.enabled && record.state !== "sealed")} onClick={() => {
              if (query.data) void submit({ kind: "enable", request: { package: { plugin: record.plugin, packageDigest: record.packageDigest }, enabled: !decision.enabled, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } });
            }}>{t(decision.enabled ? "plugins.disable" : "plugins.enable")}</button>
              <button type="button" className="text-button" disabled={blocked} onClick={() => void operation(async () => { const view = await pluginCommands.package({ plugin: record.plugin, packageDigest: record.packageDigest }); if (mounted.current) setDetails(view); })}>{t("plugins.details")}</button></div> : null}
          </li>;
        })}</ul>}
        {inventory.packageDecisions.filter(decision => !inventory.packages.some(record => record.packageDigest === decision.packageDigest)).map(decision => <div key={decision.packageDigest}><p>{t("plugins.approvedMissing", { name: decision.plugin.id, version: decision.plugin.version })}</p>
          {decision.enabled ? <button type="button" disabled={blocked || intent !== null} onClick={() => { if (query.data) void submit({ kind: "enable", request: { package: { plugin: decision.plugin, packageDigest: decision.packageDigest }, enabled: false, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } }); }}>{t("plugins.disable")}</button> : null}</div>)}
      </section> : null}
      {details ? <section className="plugin-section" aria-label={t("plugins.details")}><h3>{details.manifest.plugin.id} · {details.manifest.plugin.version}</h3><Permissions permissions={details.manifest.permissions}/>
        <ul>{details.manifest.contributions.map(contribution => <li key={contribution.id}>{contribution.id} · {t(`plugins.contributions.${contribution.contribution.kind}`)}</li>)}</ul>
      </section> : null}
    </DialogContent></DialogPortal>
  </Dialog>;
}
