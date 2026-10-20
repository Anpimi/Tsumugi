import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useQuery, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { pluginInventoryReadKey as inventoryKey, pluginRepositoriesReadKey as repositoriesKey, useApplicationQueryClient, usePluginReadReservation } from "./ApplicationReadProvider";
import { Dialog, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome, isCommandError } from "./projectCommands";
import { pluginCommands, type PluginCandidateView, type PluginApprovalRemovalRequest, type PluginUninstallRequest, type PluginInstallRequest, type PluginEnableRequest, type PluginNativeHostApprovalRequest, type PluginRuntimeInstallRequest, type PluginDefaultsInstallRequest, type PluginPackageDetailsView } from "./pluginCommands";
import "./PluginManager.css";
import { PluginPermissions } from "./PluginPermissions";
import { OfflinePackReview } from "./OfflinePackReview";
import { RepositoryControls } from "./RepositoryControls";
import { RepositoryReview } from "./RepositoryReview";
import type { PluginPackCandidateView, PluginPackInstallRequest } from "./pluginCommands";
import type { PluginRepositorySelectionView, PluginRepositoryVerifiedView, PluginRepositorySourceView, PluginRepositoryRefreshRequest, PluginRepositoryResumeRequest, PluginRepositoryInstallRequest } from "./pluginCommands";
import type { TranslationKey } from "./i18n/types";
import { validateRequestPackInstall, validateRequestRepositoryInstall } from "./generated/plugins.validators";

function usePluginReadVisibility(client: QueryClient, queryKey: QueryKey, visible: boolean) {
  useEffect(() => {
    const hide = () => {
      const filter = { queryKey, exact: true }, cache = client.getQueryCache(), query = cache.find(filter);
      if (!query || query.isActive()) return;
      void client.cancelQueries(filter).then(() => {
        // Reopening or another observer may have taken over while cancellation
        // finished. A retired visibility effect cannot invalidate that read.
        if (cache.find(filter) === query && !query.isActive()) void client.invalidateQueries({ ...filter, refetchType: "none" });
      });
    };
    if (!visible) hide();
    return visible ? hide : undefined;
  }, [client, queryKey, visible]);
}
type CleanupIntent = { kind: "approval-removal"; request: PluginApprovalRemovalRequest } | { kind: "uninstall"; request: PluginUninstallRequest };
type RepositoryIntent = { kind: "repository-refresh"; request: PluginRepositoryRefreshRequest; selection: PluginRepositorySelectionView }
  | { kind: "repository-resume"; request: PluginRepositoryResumeRequest }
  | { kind: "repository-install"; request: PluginRepositoryInstallRequest; repository: PluginRepositoryVerifiedView };
type Intent = CleanupIntent | RepositoryIntent | { kind: "pack"; request: PluginPackInstallRequest } | { kind: "native-host"; request: PluginNativeHostApprovalRequest } | { kind: "defaults"; request: PluginDefaultsInstallRequest } | { kind: "install"; request: PluginInstallRequest } | { kind: "enable"; request: PluginEnableRequest } | { kind: "runtime"; request: PluginRuntimeInstallRequest };
const reasonMessages: Partial<Record<string, TranslationKey>> = {
  "plugin-repository-expired": "plugins.repositoryExpired",
  "plugin-repository-clock": "plugins.repositoryClock",
  "plugin-repository-rollback": "plugins.repositoryRollbackRejected",
  "plugin-repository-signature": "plugins.repositorySignatureFailed",
  "plugin-repository-metadata": "plugins.repositoryMetadataInvalid",
  "plugin-repository-state": "plugins.repositoryStateFailed",
  "plugin-repository-selection": "plugins.repositorySelectionInvalid",
  "plugin-repository-rollback-consent": "plugins.repositoryRollbackRequired",
  "plugin-pack-selection": "plugins.packSelectionInvalid",
  "plugin-source-conflict": "plugins.packSourceConflict",
  "plugin-publisher-conflict": "plugins.packSourceConflict",
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
function failureMessage(failure: CommandFailure, unknown: boolean, trust = false): TranslationKey {
  if (unknown) return trust ? "plugins.repositoryUnknown" : "plugins.unknown";
  if (typeof failure === "string" && reasonMessages[failure]) return reasonMessages[failure];
  if (typeof failure !== "string") {
    if (failure.code === "stale-revision") return trust ? "plugins.repositoryTrustConflict" : "plugins.conflict";
    const known = failure.reason ? reasonMessages[failure.reason] : undefined;
    if (known) return known;
  }
  return "plugins.failed";
}

/** Declarations describe requested access, independently of recorded approval. */
function PackagePermissionReview({ manifest }: { manifest: PluginPackageDetailsView["manifest"] }) {
  const { t } = useTranslation();
  return <section className="plugin-permission-review" aria-label={t("plugins.permissionsTitle")}>
    <h4>{t("plugins.permissionsTitle")}</h4>
    <div className="plugin-permission-group" role="group" aria-label={t("plugins.packagePermissions")}>
      <h5>{t("plugins.packagePermissions")}</h5><PluginPermissions permissions={manifest.permissions}/>
    </div>
    {manifest.contributions.map(contribution => contribution.contribution.kind === "capability"
      ? <div className="plugin-permission-group" key={contribution.id} role="group" aria-label={t("plugins.capability", { name: contribution.id })}>
        <h5>{t("plugins.capability", { name: contribution.id })}</h5><PluginPermissions permissions={contribution.contribution.declaration.permissions}/>
      </div> : null)}
  </section>;
}


/** Application configuration stays mounted across project switches and panel
 * close. A rejected/unknown mutation retains its original request for recovery. */
export interface PluginManagerHandle { open: () => void }
export function PluginManager({ disabled, onBusyChange, ref }: { disabled: boolean; onBusyChange: (busy: boolean) => void; ref?: Ref<PluginManagerHandle> }) {
  const { t } = useTranslation();
  const client = useApplicationQueryClient();
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }));
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  usePluginReadReservation(running);
  const mounted = useRef(true);
  const [candidate, setCandidate] = useState<PluginCandidateView | null>(null);
  const [consent, setConsent] = useState(false);
  const [pack, setPack] = useState<PluginPackCandidateView | null>(null);
  const [packMembers, setPackMembers] = useState<string[]>([]);
  const packFocus = useRef<HTMLHeadingElement>(null);
  const packTrigger = useRef<HTMLButtonElement>(null);
  const [repositoriesVisible, setRepositoriesVisible] = useState(false);
  const [repositorySelection, setRepositorySelection] = useState<PluginRepositorySelectionView | null>(null);
  const [repositoryConsent, setRepositoryConsent] = useState(false);
  const [repository, setRepository] = useState<PluginRepositoryVerifiedView | null>(null);
  const [repositoryMembers, setRepositoryMembers] = useState<string[]>([]);
  const [repositoryRollbacks, setRepositoryRollbacks] = useState<string[]>([]);
  const repositoryFocus = useRef<HTMLHeadingElement>(null);
  const repositoryReviewFocus = useRef<HTMLHeadingElement>(null);
  const repositoryTrigger = useRef<HTMLButtonElement>(null);
  // Bind consent to the complete environment, rather than an old checkbox.
  const [nativeHostConsent, setNativeHostConsent] = useState<string | null>(null);
  const [runtimeConsent, setRuntimeConsent] = useState<string | null>(null);
  const [defaultsConsent, setDefaultsConsent] = useState<string | null>(null);
  const [verifiedRuntime, setVerifiedRuntime] = useState<string | null>(null);
  const [details, setDetails] = useState<PluginPackageDetailsView | null>(null);
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [recovery, setRecovery] = useState<"none" | "retained" | "unknown">("none");
  const unknown = recovery === "unknown";
  const originalRequired = recovery !== "none";
  const [saved, setSaved] = useState<TranslationKey | null>(null);
  const [cleanupSelection, setCleanupSelection] = useState<{ intent: CleanupIntent; consent: boolean; original: boolean } | null>(null);
  const cleanupFocus = useRef<HTMLHeadingElement>(null);
  const cleanupTrigger = useRef<HTMLButtonElement | null>(null);
  const returnCleanupFocus = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const failureFocus = useRef<HTMLDivElement>(null);
  const focusAfterSuccess = useRef(false);
  const query = useQuery({ queryKey: inventoryKey, enabled: open, queryFn: async ({ signal }) => {
    const result = await pluginCommands.inventory();
    if (signal.aborted) throw new Error("Plugin read cancelled");
    return result;
  } }, client);
  const repositoriesQuery = useQuery({ queryKey: repositoriesKey, enabled: open && repositoriesVisible, queryFn: async ({ signal }) => {
    const result = await pluginCommands.repositories();
    if (signal.aborted) throw new Error("Repository read cancelled");
    return result;
  } }, client);
  usePluginReadVisibility(client, inventoryKey, open);
  usePluginReadVisibility(client, repositoriesKey, open && repositoriesVisible);
  useEffect(() => { onBusyChange(busy || originalRequired); }, [busy, originalRequired, onBusyChange]);
  useEffect(() => {
    if (open && failure) failureFocus.current?.focus();
  }, [open, failure]);
  const cleanupIntent = cleanupSelection?.intent;
  useEffect(() => {
    if (cleanupIntent) cleanupFocus.current?.focus();
    else if (returnCleanupFocus.current) {
      returnCleanupFocus.current = false;
      if (cleanupTrigger.current?.isConnected && !cleanupTrigger.current.disabled) cleanupTrigger.current.focus();
      else closeButton.current?.focus();
    }
  }, [cleanupIntent]);
  useEffect(() => { setVerifiedRuntime(null); }, [query.dataUpdatedAt]);
  useEffect(() => { if (pack) packFocus.current?.focus(); }, [pack]);
  useEffect(() => { if (repositoriesVisible || repositorySelection) repositoryFocus.current?.focus(); }, [repositoriesVisible, repositorySelection]);
  useEffect(() => { if (repository) repositoryReviewFocus.current?.focus(); }, [repository]);
  useEffect(() => {
    if (!busy && focusAfterSuccess.current) { focusAfterSuccess.current = false; closeButton.current?.focus(); }
  }, [busy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [client]);

  async function operation(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    setSaved(null);
    try { await work(); }
    catch (error) { if (mounted.current) setFailure(commandFailure(error)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit(next: Intent) {
    await operation(async () => {
      setIntent(next);
      await Promise.all([client.cancelQueries({ queryKey: inventoryKey, exact: true }), client.cancelQueries({ queryKey: repositoriesKey, exact: true })]);
      try {
        if (next.kind === "repository-refresh" || next.kind === "repository-resume") {
          const result = next.kind === "repository-refresh" ? await pluginCommands.refreshRepository(next.request, next.selection) : await pluginCommands.resumeRepository(next.request);
          if (!mounted.current) return;
          setRepository(result);
          setRepositorySelection(null);
          setRepositoryConsent(false);
          setRepositoryMembers([]);
          setRepositoryRollbacks([]);
          setCandidate(null);
          setPack(null);
          setPackMembers([]);
          setConsent(false);
          setIntent(null);
          setRecovery("none");
          setSaved("plugins.repositoryTrustSaved");
          void client.invalidateQueries({ queryKey: repositoriesKey });
          return;
        }
        const result = next.kind === "repository-install" ? await pluginCommands.installRepository(next.request, next.repository) : next.kind === "pack" ? await pluginCommands.installPack(next.request) : next.kind === "approval-removal" ? await pluginCommands.removeApproval(next.request) : next.kind === "uninstall" ? await pluginCommands.uninstall(next.request) : next.kind === "defaults" ? await pluginCommands.installDefaults(next.request) : next.kind === "install" ? await pluginCommands.install(next.request) : next.kind === "runtime" ? await pluginCommands.installRuntime(next.request) : next.kind === "native-host" ? await pluginCommands.nativeHostApproval(next.request) : await pluginCommands.enable(next.request);
        if (!mounted.current) return;
        client.setQueryData(inventoryKey, result);
        setIntent(null);
        setRecovery("none");
        setCleanupSelection(null);
        setCandidate(null);
        setPack(null);
        setPackMembers([]);
        clearRepositoryReview();
        setConsent(false);
        setRuntimeConsent(null);
        setNativeHostConsent(null);
        setDefaultsConsent(null);
        setVerifiedRuntime(null);
        setDetails(null);
        setSaved(next.kind === "approval-removal" ? "plugins.approvalRemoved" : next.kind === "uninstall" ? "plugins.installationRemoved" : "plugins.saved");
        if (next.kind === "approval-removal" || next.kind === "uninstall" || next.kind === "pack" || next.kind === "repository-install") focusAfterSuccess.current = true;
      } catch (error) {
        if (mounted.current) setRecovery(previous => {
          if (previous === "unknown" || hasUnknownOutcome(error)) return "unknown";
          if (previous === "retained" || (isCommandError(error)
            && error.recoveryRequired && error.recoveryGuidance === "reconcile-original")) return "retained";
          return "none";
        });
        throw error;
      }
    });
  }
  function clearRepositoryReview() {
    setRepositorySelection(null);
    setRepositoryConsent(false);
    setRepository(null);
    setRepositoryMembers([]);
    setRepositoryRollbacks([]);
  }
  function selectRepositoryMember(digest: string, checked: boolean) {
    const member = repository?.packages.find(item => item.packageDigest === digest);
    if (!member || !repository) return;
    const versions = new Set(repository.packages.filter(item => item.manifest.plugin.id === member.manifest.plugin.id).map(item => item.packageDigest));
    setRepositoryMembers(current => checked ? [...current.filter(item => !versions.has(item)), digest] : current.filter(item => item !== digest));
    setRepositoryRollbacks(current => current.filter(item => checked ? !versions.has(item) : item !== digest));
  }
  function installRepositoryMembers() {
    if (!repository || !query.data) return;
    const members = repository.packages.filter(member => repositoryMembers.includes(member.packageDigest));
    if (members.some(member => member.kind === "rollback" && !repositoryRollbacks.includes(member.packageDigest))) {
      setFailure("plugin-repository-rollback-consent"); return;
    }
    const request = { ticket: repository.ticket, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID(),
      members: members.map(member => ({ package: { plugin: member.manifest.plugin, packageDigest: member.packageDigest }, kind: member.kind })),
    };
    if (!validateRequestRepositoryInstall(request)) { setFailure("plugin-repository-selection"); return; }
    void submit({ kind: "repository-install", request, repository });
  }
  function resumeRepository(source: PluginRepositorySourceView) {
    if (source.actionId === null || source.expectedRevision === null) return;
    void submit({ kind: "repository-resume", request: { sourceId: source.sourceId, expectedRevision: source.expectedRevision, actionId: source.actionId } });
  }
  function installSelectedPack() {
    if (!pack || !query.data) return;
    const request = {
      ticket: pack.ticket, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID(),
      members: pack.packages.filter(member => packMembers.includes(member.packageDigest)).map(member => ({ plugin: member.manifest.plugin, packageDigest: member.packageDigest })),
    };
    // Use the generated bounded contract to narrow the selected subset without
    // asserting that an arbitrary array is a valid one-to-sixteen-member tuple.
    if (!validateRequestPackInstall(request)) { setFailure("plugin-pack-selection"); return; }
    void submit({ kind: "pack", request });
  }
  function reviewCleanup(next: CleanupIntent, trigger: HTMLButtonElement, original = false) {
    cleanupTrigger.current = trigger;
    setCleanupSelection({ intent: next, consent: false, original });
    setFailure(null);
    setSaved(null);
  }
  const unavailable = busy || originalRequired || query.isFetching || repositoriesQuery.isFetching || !query.data || query.isError;
  const blocked = unavailable || cleanupSelection !== null;
  const trustBlocked = busy || originalRequired || query.isFetching || repositoriesQuery.isFetching || cleanupSelection !== null;
  const inventory = query.data;
  const trustIntent = intent?.kind === "repository-refresh" || intent?.kind === "repository-resume";
  const retainedMessage = trustIntent ? "plugins.repositoryPending" : intent?.kind === "approval-removal" || intent?.kind === "uninstall" ? "plugins.cleanupPending" : "plugins.pending";
  return <Dialog open={open} onOpenChange={next => { if (!running.current) setOpen(next); }}>
    <DialogTrigger asChild><button type="button" className="secondary-button" disabled={disabled}>{t("plugins.open")}</button></DialogTrigger>
    <DialogPortal><DialogOverlay className="dialog-backdrop"/><DialogContent className="execution-dialog plugin-manager" aria-busy={busy}
      onOpenAutoFocus={event => { if (failure && failureFocus.current) { event.preventDefault(); failureFocus.current.focus(); } }}
      onEscapeKeyDown={event => { if (running.current) event.preventDefault(); }} onInteractOutside={event => { if (running.current) event.preventDefault(); }}>
      <div className="execution-heading"><div><DialogTitle>{t("plugins.title")}</DialogTitle><DialogDescription>{t("plugins.description")}</DialogDescription></div>
        <button type="button" ref={closeButton} className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>{t("plugins.close")}</button></div>
      <div className="plugin-manager-body">
      <p className="plugin-boundaries">{t("plugins.permissionBoundary")}</p>
      <div className="execution-actions plugin-entry-actions"><button type="button" className="primary-button" disabled={blocked} onClick={() => void operation(async () => {
        setConsent(false);
        const selected = await pluginCommands.select();
        if (mounted.current && selected) { setCandidate(selected); setConsent(false); setPack(null); setPackMembers([]); clearRepositoryReview(); setIntent(null); }
      })}>{t("plugins.choose")}</button>
        <button type="button" ref={packTrigger} className="secondary-button" disabled={blocked} onClick={() => void operation(async () => {
          setPackMembers([]);
          const selected = await pluginCommands.selectPack();
          if (mounted.current && selected) { setPack(selected); setPackMembers([]); setCandidate(null); setConsent(false); clearRepositoryReview(); setIntent(null); }
        })}>{t("plugins.choosePack")}</button>
        <button type="button" className="secondary-button" disabled={busy} aria-expanded={repositoriesVisible} aria-controls="plugin-repositories" onClick={() => setRepositoriesVisible(true)}>{t("plugins.repositoryTitle")}</button>
        <button type="button" className="secondary-button" disabled={busy || query.isFetching} onClick={() => void query.refetch()}>{t("plugins.refresh")}</button></div>
      {busy || query.isFetching ? <p role="status">{t("plugins.loading")}</p> : null}
      {query.isError ? <div className="plugin-feedback" role="alert"><p>{t("plugins.readFailed")}</p>{query.data ? <p>{t("plugins.stale")}</p> : null}<CommandFailureDetails failure={commandFailure(query.error)}/></div> : null}
      {saved ? <p className="plugin-feedback" role="status">{t(saved)}</p> : null}
      {failure ? <div className="plugin-feedback" role="alert" ref={failureFocus} tabIndex={-1}><p>{t(recovery === "retained" ? retainedMessage : failureMessage(failure, unknown, trustIntent))}</p>
        <CommandFailureDetails failure={failure}/>{intent ? <button type="button" className="secondary-button" disabled={busy || query.isFetching || repositoriesQuery.isFetching} onClick={() => void submit(intent)}>{t("plugins.retryOriginal")}</button> : null}
        {!originalRequired && intent ? <button type="button" className="text-button" disabled={busy} onClick={() => { setIntent(null); setFailure(null); setCleanupSelection(null); setCandidate(null); setPack(null); setPackMembers([]); clearRepositoryReview(); setConsent(false); setRuntimeConsent(null); setNativeHostConsent(null); void query.refetch(); if (repositoriesVisible) void repositoriesQuery.refetch(); }}>{t("plugins.reviewCurrent")}</button> : null}
      </div> : null}
      {repositoriesVisible ? <RepositoryControls sources={repositoriesQuery.data} reading={repositoriesQuery.isFetching} readFailure={repositoriesQuery.isError ? commandFailure(repositoriesQuery.error) : null}
        selection={repositorySelection} consent={repositoryConsent} disabled={trustBlocked || intent !== null} readDisabled={busy} headingRef={repositoryFocus} chooseRef={repositoryTrigger}
        onChoose={() => void operation(async () => {
          setRepositoryConsent(false); setRepositoryMembers([]); setRepositoryRollbacks([]);
          const selected = await pluginCommands.selectRepository();
          if (mounted.current && selected) {
            setRepositorySelection(selected); setRepository(null); setCandidate(null); setConsent(false); setPack(null); setPackMembers([]); setIntent(null);
          }
        })}
        onRead={() => void repositoriesQuery.refetch()} onConsent={setRepositoryConsent}
        onRefresh={() => { if (repositorySelection && repositoryConsent) void submit({ kind: "repository-refresh", selection: repositorySelection,
          request: { ticket: repositorySelection.ticket, expectedRevision: repositorySelection.revision, actionId: crypto.randomUUID() } }); }} onResume={resumeRepository}/> : null}
      {repository ? <>{!inventory || query.isError ? <p role="alert">{t("plugins.repositoryInventoryUnavailable")}</p> : null}<RepositoryReview repository={repository} selected={repositoryMembers} rollbacks={repositoryRollbacks} inventory={inventory} disabled={blocked || intent !== null}
        discardDisabled={busy || originalRequired || intent !== null} headingRef={repositoryReviewFocus} onSelect={selectRepositoryMember} onRollback={(digest, checked) => setRepositoryRollbacks(current => checked ? [...current, digest] : current.filter(item => item !== digest))}
        onInstall={installRepositoryMembers} onDiscard={() => { clearRepositoryReview(); if (repositoryTrigger.current && !repositoryTrigger.current.disabled) repositoryTrigger.current.focus(); else closeButton.current?.focus(); }}/></> : null}
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
      {pack && inventory ? <OfflinePackReview pack={pack} selected={packMembers} inventory={inventory} disabled={blocked || intent !== null} headingRef={packFocus}
        onSelect={(digest, checked) => setPackMembers(current => checked ? [...current, digest] : current.filter(member => member !== digest))}
        onDiscard={() => { setPack(null); setPackMembers([]); packTrigger.current?.focus(); }}
        onInstall={installSelectedPack}/> : null}
      {candidate ? <section className="plugin-section plugin-install-review" aria-label={t("plugins.candidate")}><h3>{t("plugins.candidate")}</h3>
        <div className="plugin-review-layout"><div className="plugin-package-plan">
        <p className="plugin-package-name"><strong>{candidate.manifest.plugin.id}</strong> · {candidate.manifest.plugin.version}</p>
        <p>{t("plugins.declaredPublisher", { publisher: candidate.manifest.plugin.publisher })}</p>
        <p>{t("plugins.manualTrust")}</p>
        <h4>{t("plugins.runtime")}</h4><ul>{candidate.manifest.components.map(component => <li key={component.id}>{component.id}: {t(`plugins.runtimes.${component.runtime}`)}</li>)}</ul>
        </div><PackagePermissionReview manifest={candidate.manifest}/></div>
        <details><summary>{t("plugins.fingerprint")}</summary><p><code>{candidate.packageDigest}</code></p><p>{t("plugins.files", { count: candidate.fileCount, bytes: candidate.byteCount })}</p></details>
        <p>{t("plugins.installEffect")}</p>
        <label className="plugin-consent"><input type="checkbox" checked={consent} disabled={busy || originalRequired} onChange={event => setConsent(event.target.checked)}/>{t("plugins.consent")}</label>
        <div className="execution-actions plugin-install-actions"><button type="button" className="primary-button" disabled={blocked || !consent || intent !== null} onClick={() => {
          if (query.data) void submit({ kind: "install", request: { ticket: candidate.ticket, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } });
        }}>{t("plugins.install")}</button>
          <button type="button" className="secondary-button" disabled={busy || originalRequired} onClick={() => { setCandidate(null); setConsent(false); }}>{t("plugins.discard")}</button></div>
      </section> : null}
      {cleanupSelection ? <section className="plugin-section plugin-cleanup-review" aria-labelledby="plugin-cleanup-title">
        <h3 id="plugin-cleanup-title" tabIndex={-1} ref={cleanupFocus}>{t(cleanupSelection.original ? "plugins.originalRemovalTitle" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.revokeTitle" : "plugins.uninstallTitle", {
          name: cleanupSelection.intent.request.package.plugin.id, version: cleanupSelection.intent.request.package.plugin.version,
        })}</h3>
        <p>{t(cleanupSelection.original ? "plugins.originalRemovalEffect" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.revokeEffect" : "plugins.uninstallEffect")}</p>
        <details><summary>{t("plugins.fingerprint")}</summary><code>{cleanupSelection.intent.request.package.packageDigest}</code>
          <p>{t("plugins.origin", { source: cleanupSelection.intent.request.origin.sourceId, publisher: cleanupSelection.intent.request.origin.publisherId })}</p>
          {cleanupSelection.intent.kind === "uninstall" ? <p>{t("plugins.installationReference", { action: cleanupSelection.intent.request.originalInstallAction })}</p> : null}
        </details>
        <label className="plugin-consent"><input type="checkbox" checked={cleanupSelection.consent} disabled={busy || originalRequired || intent !== null}
          onChange={event => setCleanupSelection({ ...cleanupSelection, consent: event.target.checked })}/>{t(cleanupSelection.original ? "plugins.originalRemovalConsent" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.revokeConsent" : "plugins.uninstallConsent")}</label>
        <div className="execution-actions"><button type="button" className="primary-button" disabled={unavailable || intent !== null || !cleanupSelection.consent}
          onClick={() => void submit(cleanupSelection.intent)}>{t(cleanupSelection.original ? "plugins.confirmOriginalRemoval" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.confirmRevoke" : "plugins.confirmUninstall")}</button>
          <button type="button" className="secondary-button" disabled={busy || originalRequired || intent !== null} onClick={() => {
            returnCleanupFocus.current = true; setCleanupSelection(null);
          }}>{t("plugins.cancelCleanup")}</button></div>
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
              <button type="button" className="text-button" disabled={blocked} onClick={() => void operation(async () => { const view = await pluginCommands.package({ plugin: record.plugin, packageDigest: record.packageDigest }); if (mounted.current) setDetails(view); })}>{t("plugins.details")}</button>
              <button type="button" className="secondary-button" disabled={blocked || intent !== null} onClick={event => reviewCleanup({ kind: "approval-removal", request: {
                package: { plugin: decision.plugin, packageDigest: decision.packageDigest }, origin: decision.origin,
                expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
              } }, event.currentTarget)}>{t("plugins.revoke")}</button></div> : null}
            <button type="button" className="secondary-button" disabled={blocked || intent !== null || record.state !== "sealed" || inventory.packageDecisions.some(value => value.packageDigest === record.packageDigest
              || (value.plugin.id === record.plugin.id && value.plugin.publisher === record.plugin.publisher && value.plugin.version === record.plugin.version))}
              onClick={event => reviewCleanup({ kind: "uninstall", request: { package: { plugin: record.plugin, packageDigest: record.packageDigest }, origin: record.origin,
                originalInstallAction: record.originalInstallAction, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
              } }, event.currentTarget)}>{t("plugins.uninstall")}</button>
            {inventory.packageDecisions.some(value => value.packageDigest === record.packageDigest
              || (value.plugin.id === record.plugin.id && value.plugin.publisher === record.plugin.publisher && value.plugin.version === record.plugin.version)) ? <p>{t("plugins.revokeFirst")}</p> : null}
          </li>;
        })}</ul>}
        {inventory.packageDecisions.filter(decision => !inventory.packages.some(record => record.packageDigest === decision.packageDigest)).map(decision => <div key={decision.packageDigest}><p>{t("plugins.approvedMissing", { name: decision.plugin.id, version: decision.plugin.version })}</p>
          {decision.enabled ? <button type="button" disabled={blocked || intent !== null} onClick={() => { if (query.data) void submit({ kind: "enable", request: { package: { plugin: decision.plugin, packageDigest: decision.packageDigest }, enabled: false, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } }); }}>{t("plugins.disable")}</button> : null}
          <button type="button" className="secondary-button" disabled={blocked || intent !== null} onClick={event => reviewCleanup({ kind: "approval-removal", request: {
            package: { plugin: decision.plugin, packageDigest: decision.packageDigest }, origin: decision.origin,
            expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
          } }, event.currentTarget)}>{t("plugins.revoke")}</button></div>)}
      </section> : null}
      {inventory?.uninstallations.length ? <section className="plugin-section" aria-label={t("plugins.previousRemovals")}>
        <details><summary>{t("plugins.previousRemovals")}</summary><p>{t("plugins.removalObservation")}</p>
          <ul className="plugin-list">{inventory.uninstallations.map(record => <li key={record.actionId}>
            <p><strong>{record.installation.plugin.id}</strong> · {record.installation.plugin.version}</p>
            <p>{t(record.state === "recovery-required" ? "plugins.removalPending" : "plugins.removalRecorded")}</p>
            <button type="button" className="secondary-button" disabled={blocked || intent !== null} onClick={event => reviewCleanup({ kind: "uninstall", request: {
              package: { plugin: record.installation.plugin, packageDigest: record.installation.packageDigest }, origin: record.installation.origin,
              originalInstallAction: record.installation.originalInstallAction, expectedRevision: record.settingsRevision, actionId: record.actionId,
            } }, event.currentTarget, true)}>{t("plugins.confirmRemoval")}</button>
          </li>)}</ul>
        </details>
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
      {details ? <section className="plugin-section plugin-installed-details" aria-label={t("plugins.details")}><h3>{details.manifest.plugin.id} · {details.manifest.plugin.version}</h3><PackagePermissionReview manifest={details.manifest}/>
        <ul>{details.manifest.contributions.map(contribution => <li key={contribution.id}>{contribution.id} · {t(`plugins.contributions.${contribution.contribution.kind}`)}</li>)}</ul>
      </section> : null}
      </div>
    </DialogContent></DialogPortal>
  </Dialog>;
}
