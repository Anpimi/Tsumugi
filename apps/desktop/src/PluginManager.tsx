import { useEffect, useRef, useState } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { Dialog, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure, type CommandFailure } from "./CommandFailure";
import { isCommandError } from "./projectCommands";
import { pluginCommands, type PluginCandidateView, type PluginInstallRequest, type PluginEnableRequest, type PluginNativeHostApprovalRequest, type PluginRuntimeInstallRequest, type PluginDefaultsInstallRequest, type PluginPackageDetailsView, type PermissionRequest } from "./pluginCommands";
import "./PluginManager.css";
import type { TranslationKey } from "./i18n/types";

const inventoryKey = ["application", "plugins", "inventory"] as const;
type Intent = { kind: "native-host"; request: PluginNativeHostApprovalRequest } | { kind: "defaults"; request: PluginDefaultsInstallRequest } | { kind: "install"; request: PluginInstallRequest } | { kind: "enable"; request: PluginEnableRequest } | { kind: "runtime"; request: PluginRuntimeInstallRequest };
const reasonMessages: Partial<Record<string, TranslationKey>> = {
  "plugin-defaults-unavailable": "plugins.defaultsUnavailable",
  "plugin-defaults-changed": "plugins.defaultsChanged",
  "plugin-selection-expired": "plugins.selectionExpired",
  "plugin-candidate-changed": "plugins.candidateChanged",
  "plugin-recovery-required": "plugins.recovery",
  "plugin-settings-corrupt": "plugins.settingsInvalid",
  "plugin-directory-unavailable": "plugins.directoryUnavailable",
  "plugin-store-busy": "plugins.busy",
  "plugin-operation-pending": "plugins.pending",
  "plugin-approval-mismatch": "plugins.approvalMismatch",
  "plugin-runtime-unavailable": "plugins.runtimeUnavailable",
  "plugin-runtime-changed": "plugins.runtimeChanged",
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

export function PluginPermissions({ permissions }: { permissions: PermissionRequest[] }) {
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
  // Bind consent to the complete environment, rather than an old checkbox.
  const [nativeHostConsent, setNativeHostConsent] = useState<string | null>(null);
  const [runtimeConsent, setRuntimeConsent] = useState<string | null>(null);
  const [defaultsConsent, setDefaultsConsent] = useState<string | null>(null);
  const [verifiedRuntime, setVerifiedRuntime] = useState<string | null>(null);
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
  useEffect(() => { setVerifiedRuntime(null); }, [query.dataUpdatedAt]);
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
        const result = next.kind === "defaults" ? await pluginCommands.installDefaults(next.request) : next.kind === "install" ? await pluginCommands.install(next.request) : next.kind === "runtime" ? await pluginCommands.installRuntime(next.request) : next.kind === "native-host" ? await pluginCommands.nativeHostApproval(next.request) : await pluginCommands.enable(next.request);
        if (!mounted.current) return;
        client.setQueryData(inventoryKey, result);
        setIntent(null);
        setUnknown(false);
        setCandidate(null);
        setConsent(false);
        setRuntimeConsent(null);
        setNativeHostConsent(null);
        setDefaultsConsent(null);
        setVerifiedRuntime(null);
        setDetails(null);
        setSaved(true);
      } catch (error) {
        if (mounted.current) setUnknown(previous => previous || !isCommandError(error) || error.code === "outcome-unknown");
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
        <CommandFailureDetails failure={failure}/>{intent ? <button type="button" className="secondary-button" disabled={busy || query.isFetching} onClick={() => void submit(intent)}>{t("plugins.retryOriginal")}</button> : null}
        {!unknown && intent ? <button type="button" className="text-button" disabled={busy} onClick={() => { setIntent(null); setFailure(null); setCandidate(null); setConsent(false); setRuntimeConsent(null); setNativeHostConsent(null); void query.refetch(); }}>{t("plugins.reviewCurrent")}</button> : null}
      </div> : null}
      {inventory?.defaultsOffer ? <section className="plugin-section" aria-label={t("plugins.defaultsTitle")}>
        <h3>{t("plugins.defaultsTitle")}</h3><p>{t("plugins.defaultsDescription")}</p>
        <ul className="plugin-list">{inventory.defaultsOffer.packages.map(package_ => <li key={package_.packageDigest}>
          <strong>{package_.displayName}</strong> · {package_.plugin.version}
          <details><summary>{t("plugins.fingerprint")}</summary><code>{package_.packageDigest}</code></details>
        </li>)}</ul>
        <p>{t("plugins.defaultsEffect")}</p>
        {inventory.defaultsOffer.availability !== "available" ? <p>{t(inventory.defaultsOffer.availability === "resources-unavailable" ? "plugins.defaultsUnavailable" : "plugins.runtimeUnavailable")}</p> : <>
          <label className="plugin-consent"><input type="checkbox" disabled={blocked || intent !== null}
            checked={defaultsConsent === inventory.defaultsOffer.selectionDigest}
            onChange={event => setDefaultsConsent(event.target.checked ? inventory.defaultsOffer?.selectionDigest ?? null : null)}/>{t("plugins.defaultsConsent")}</label>
          <button type="button" className="primary-button" disabled={blocked || intent !== null || defaultsConsent !== inventory.defaultsOffer.selectionDigest}
            onClick={() => { if (inventory.defaultsOffer) void submit({ kind: "defaults", request: {
              id: inventory.defaultsOffer.id, selectionDigest: inventory.defaultsOffer.selectionDigest,
              expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
            } }); }}>{t("plugins.installDefaults")}</button>
        </>}
      </section> : null}
      {candidate ? <section className="plugin-section" aria-label={t("plugins.candidate")}><h3>{t("plugins.candidate")}</h3>
        <p><strong>{candidate.manifest.plugin.id}</strong> · {candidate.manifest.plugin.version}</p>
        <p>{t("plugins.declaredPublisher", { publisher: candidate.manifest.plugin.publisher })}</p>
        <p>{t("plugins.manualTrust")}</p>
        <h4>{t("plugins.runtime")}</h4><ul>{candidate.manifest.components.map(component => <li key={component.id}>{component.id}: {t(`plugins.runtimes.${component.runtime}`)}</li>)}</ul>
        <h4>{t("plugins.permissionsTitle")}</h4><PluginPermissions permissions={candidate.manifest.permissions}/>
        {candidate.manifest.contributions.map(contribution => contribution.contribution.kind === "capability" ? <div key={contribution.id}><p>{t("plugins.capability", { name: contribution.id })}</p><PluginPermissions permissions={contribution.contribution.declaration.permissions}/></div> : null)}
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
      {inventory ? <section className="plugin-section" aria-label={t("plugins.nativeHostTitle")}>
        <h3>{t("plugins.nativeHostTitle")}</h3>
        {inventory.nativeHostOffer.availability === "available" ? (() => {
          const offer = inventory.nativeHostOffer;
          const approved = inventory.runtimeDecisions.some(decision => decision.environmentDigest === offer.environmentDigest
            && decision.origin.sourceId === offer.origin.sourceId && decision.origin.publisherId === offer.origin.publisherId);
          return <>
            <h4>{t("plugins.nativeHostVersion", { version: offer.environment.hostVersion })}</h4>
            <p>{t("plugins.nativeHostEffect")}</p>
            <details><summary>{t("plugins.runtimeFingerprint")}</summary><code>{offer.environmentDigest}</code><p>{offer.environment.executable.kind}: <code>{offer.environment.executable.value}</code></p></details>
            {approved ? <p>{t("plugins.nativeHostCurrentApproved")}</p> : <>
              <label className="plugin-consent"><input type="checkbox" checked={nativeHostConsent === offer.environmentDigest} disabled={blocked || intent !== null}
                onChange={event => setNativeHostConsent(event.target.checked ? offer.environmentDigest : null)}/>{t("plugins.nativeHostConsent")}</label>
              <button type="button" className="primary-button" disabled={blocked || intent !== null || nativeHostConsent !== offer.environmentDigest} onClick={() => {
                void submit({ kind: "native-host", request: { environmentDigest: offer.environmentDigest, approved: true, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID() } });
              }}>{t("plugins.nativeHostApprove")}</button>
            </>}
          </>;
        })() : <p>{t(`plugins.nativeHostAvailability.${inventory.nativeHostOffer.reason}`)}</p>}
        {inventory.runtimeDecisions.filter(decision => decision.environment.profile === "native-application-host-v1").map(decision => <div key={decision.environmentDigest}>
          <p>{decision.environment.profile === "native-application-host-v1" ? t("plugins.nativeHostApproved", { version: decision.environment.hostVersion }) : null}</p>
          <details><summary>{t("plugins.runtimeFingerprint")}</summary><code>{decision.environmentDigest}</code></details>
          <p>{t("plugins.nativeHostRevokeEffect")}</p>
          <button type="button" className="text-button" disabled={blocked || intent !== null} onClick={() => {
            void submit({ kind: "native-host", request: { environmentDigest: decision.environmentDigest, approved: false, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID() } });
          }}>{t("plugins.nativeHostRevoke")}</button>
        </div>)}
      </section> : null}
      {inventory ? <section className="plugin-section" aria-label={t("plugins.runtimeTitle")}><h3>{t("plugins.runtimeTitle")}</h3>
        {!inventory.runtimeOffers.length ? <p>{t("plugins.runtimeNotBundled")}</p> : inventory.runtimeOffers.map(offer => {
          const record = inventory.runtimes.find(record => record.environmentDigest === offer.environmentDigest);
          return <div key={offer.environmentDigest}>
            <h4>{t("plugins.bundledRuntime", { version: offer.environment.toolVersion })}</h4>
            <p>{t("plugins.runtimeSystem", { version: offer.minimumSystemVersion })}</p><p>{t("plugins.runtimeEffect")}</p>
            <details><summary>{t("plugins.runtimeFingerprint")}</summary><code>{offer.environmentDigest}</code><p>{t("plugins.files", { count: offer.fileCount, bytes: offer.byteCount })}</p></details>
            {offer.availability !== "available" ? <p>{t(`plugins.runtimeAvailability.${offer.availability}`)}</p> : <>
              <label className="plugin-consent"><input type="checkbox" checked={runtimeConsent === offer.environmentDigest} disabled={blocked || intent !== null} onChange={event => setRuntimeConsent(event.target.checked ? offer.environmentDigest : null)}/>{t("plugins.runtimeConsent")}</label>
              <button type="button" className="primary-button" disabled={blocked || intent !== null || runtimeConsent !== offer.environmentDigest} onClick={() => {
                void submit({ kind: "runtime", request: { id: offer.id, environmentDigest: offer.environmentDigest, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID() } });
              }}>{t(record ? "plugins.confirmRuntime" : "plugins.installRuntime")}</button>
            </>}
          </div>;
        })}
        <h4>{t("plugins.installedRuntimes")}</h4>
        {!inventory.runtimes.length ? <p>{t("plugins.runtimeEmpty")}</p> : <ul className="plugin-list">{inventory.runtimes.map(record => {
          const approved = inventory.runtimeDecisions.some(decision => decision.origin.sourceId === record.origin.sourceId && decision.origin.publisherId === record.origin.publisherId && decision.environmentDigest === record.environmentDigest);
          return <li key={record.environmentDigest}><p>{t("plugins.bundledRuntime", { version: record.environment.toolVersion })}</p>
            <p>{t(record.state === "recovery-required" ? "plugins.runtimeRecovery" : approved ? "plugins.runtimeApproved" : "plugins.unapproved")}</p>
            <details><summary>{t("plugins.runtimeFingerprint")}</summary><code>{record.environmentDigest}</code></details>
            {approved && record.state === "sealed" ? <button type="button" className="secondary-button" disabled={blocked || intent !== null} onClick={() => void operation(async () => {
              setVerifiedRuntime(null); await pluginCommands.lookupRuntime({ environmentDigest: record.environmentDigest }); if (mounted.current) setVerifiedRuntime(record.environmentDigest);
            })}>{t("plugins.verifyRuntime")}</button> : null}
            {verifiedRuntime === record.environmentDigest ? <p role="status">{t("plugins.runtimeVerified")}</p> : null}
          </li>;
        })}</ul>}
        {inventory.runtimeDecisions.map(decision => decision.environment.profile === "node-system-libraries-v1" && !inventory.runtimes.some(record => record.environmentDigest === decision.environmentDigest)
          ? <p key={decision.environmentDigest}>{t("plugins.runtimeApprovedMissing", { version: decision.environment.toolVersion })}</p> : null)}
      </section> : null}
      {details ? <section className="plugin-section" aria-label={t("plugins.details")}><h3>{details.manifest.plugin.id} · {details.manifest.plugin.version}</h3><PluginPermissions permissions={details.manifest.permissions}/>
        <ul>{details.manifest.contributions.map(contribution => <li key={contribution.id}>{contribution.id} · {t(`plugins.contributions.${contribution.contribution.kind}`)}</li>)}</ul>
      </section> : null}
    </DialogContent></DialogPortal>
  </Dialog>;
}
