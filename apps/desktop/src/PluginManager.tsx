import { useEffect, useImperativeHandle, useRef, useState, type Ref, type KeyboardEvent } from "react";
import { useQuery, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { pluginInventoryReadKey as inventoryKey, pluginRepositoriesReadKey as repositoriesKey, useApplicationQueryClient, usePluginReadReservation } from "./ApplicationReadProvider";
import { Dialog, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, commandFailure, type CommandFailure } from "./CommandFailure";
import { hasUnknownOutcome, isCommandError } from "./projectCommands";
import { pluginCommands, type PluginCandidateView, type PluginApprovalRemovalRequest, type PluginUninstallRequest, type PluginInstallRequest, type PluginEnableRequest, type PluginNativeHostApprovalRequest, type PluginRuntimeInstallRequest, type PluginDefaultsInstallRequest, type PluginPackageDetailsView, type PluginInventoryView } from "./pluginCommands";
import "./PluginManager.css";
import { PackagePermissionReview } from "./PluginPermissions";
import { Button } from "./design-system/Button";
import { Field } from "./design-system/Field";
import { Banner } from "./design-system/Feedback";
import { Sheet } from "./design-system/Dialog";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "./design-system/Tabs";
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

type Manifest = PluginPackageDetailsView["manifest"];
type ReviewMember = { manifest: Manifest; packageDigest: string; origin: { sourceId: string; publisherId: string } };
const manualOrigin = { sourceId: "manual-local", publisherId: "manual-approval" };

async function readPermissionBaselines(inventory: PluginInventoryView | undefined, members: ReviewMember[]) {
  const result = new Map<string, Manifest>();
  if (!inventory) return { revision: "", manifests: result };
  await Promise.all(members.map(async member => {
    // A baseline must have both an exact approval and a sealed installed image
    // from the same publisher/source. Ambiguous prior versions are not guessed.
    const approved = inventory.packageDecisions.filter(decision => decision.plugin.id === member.manifest.plugin.id
      && decision.plugin.publisher === member.manifest.plugin.publisher && decision.origin.sourceId === member.origin.sourceId
      && decision.origin.publisherId === member.origin.publisherId && inventory.packages.some(record => record.state === "sealed"
        && record.packageDigest === decision.packageDigest && record.plugin.id === decision.plugin.id
        && record.plugin.publisher === decision.plugin.publisher && record.plugin.version === decision.plugin.version
        && record.origin.sourceId === decision.origin.sourceId && record.origin.publisherId === decision.origin.publisherId));
    const exact = approved.find(decision => decision.packageDigest === member.packageDigest && decision.plugin.version === member.manifest.plugin.version);
    const previous = exact ?? (approved.length === 1 ? approved[0] : undefined);
    if (!previous) return;
    try {
      const view = await pluginCommands.package({ plugin: previous.plugin, packageDigest: previous.packageDigest });
      if (view.packageDigest === previous.packageDigest && view.manifest.plugin.id === previous.plugin.id
        && view.manifest.plugin.publisher === previous.plugin.publisher && view.manifest.plugin.version === previous.plugin.version) {
        result.set(member.packageDigest, view.manifest);
      }
    } catch {
      // The visible review explicitly reports that all requests need approval
      // when an approved image cannot be read. It never reuses another package.
    }
  }));
  return { revision: inventory.settingsRevision, manifests: result };
}

/** Application configuration stays mounted across project switches and panel
 * close. A rejected/unknown mutation retains its original request for recovery. */
export interface PluginManagerHandle {
  open: (returnTo?: HTMLElement) => void;
  exitState: () => { blocked: boolean; revision: string };
}
export function PluginManager({ disabled, onBusyChange, hideTrigger = false, presentation = "dialog", onOpenChange, ref }: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  hideTrigger?: boolean;
  presentation?: "dialog" | "workbench";
  onOpenChange?: (open: boolean) => void;
  ref?: Ref<PluginManagerHandle>;
}) {
  const { t } = useTranslation();
  const client = useApplicationQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const panelFocus = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const workbench = presentation === "workbench";
  const [tab, setTab] = useState("installed");
  const tabRef = useRef(tab);
  const tabFocus = useRef<"installed" | "catalog" | "source" | null>(null);
  const installedFocus = useRef<HTMLHeadingElement>(null);
  function navigateTab(value: string, target: "installed" | "catalog" | "source") {
    if (composing.current) return;
    tabFocus.current = target;
    changeTab(value);
  }
  function changeTab(value: string) {
    if (composing.current) return;
    tabRef.current = value;
    setTab(value);
    if (value === "sources") setRepositoriesVisible(true);
  }
  function changeOpen(value: boolean) {
    if (running.current || (!value && composing.current)) return;
    setOpen(value);
    onOpenChange?.(value);
  }
  function preventCompositionAction(event: KeyboardEvent) {
    if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
      && ["Enter", " ", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
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
  const [permissionBaselines, setPermissionBaselines] = useState<{ revision: string; manifests: Map<string, Manifest> } | null>(null);
  const [failure, setFailure] = useState<CommandFailure | null>(null);
  const [intent, renderIntent] = useState<Intent | null>(null);
  const [recovery, renderRecovery] = useState<"none" | "retained" | "unknown">("none");
  const intentRef = useRef<Intent | null>(null);
  const recoveryRef = useRef(recovery);
  const exitRevision = useRef(0);
  function setIntent(value: Intent | null) {
    if (intentRef.current !== value) exitRevision.current += 1;
    intentRef.current = value;
    renderIntent(value);
  }
  function setRecovery(value: typeof recovery | ((previous: typeof recovery) => typeof recovery)) {
    const next = typeof value === "function" ? value(recoveryRef.current) : value;
    if (recoveryRef.current !== next) exitRevision.current += 1;
    recoveryRef.current = next;
    renderRecovery(next);
  }
  useImperativeHandle(ref, () => ({
    open: returnTo => {
      returnFocus.current = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      changeOpen(true);
    },
    exitState: () => ({ blocked: running.current || recoveryRef.current !== "none", revision: String(exitRevision.current) }),
  }));
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
  useEffect(() => {
    const target = tabFocus.current;
    if (!target) return;
    tabFocus.current = null;
    if (target === "installed") installedFocus.current?.focus();
    else if (target === "catalog") repositoryReviewFocus.current?.focus();
    else repositoryTrigger.current?.focus();
  }, [tab]);
  const cleanupIntent = cleanupSelection?.intent;
  useEffect(() => {
    if (cleanupIntent) cleanupFocus.current?.focus();
    else if (returnCleanupFocus.current) {
      returnCleanupFocus.current = false;
      if (cleanupTrigger.current?.isConnected && !cleanupTrigger.current.disabled) cleanupTrigger.current.focus();
      else (closeButton.current ?? panelFocus.current)?.focus();
    }
  }, [cleanupIntent]);
  useEffect(() => { setVerifiedRuntime(null); }, [query.dataUpdatedAt]);
  useEffect(() => { if (open && pack && (!workbench || tabRef.current === "discover")) packFocus.current?.focus(); }, [open, pack, workbench]);
  useEffect(() => { if (open && (repositoriesVisible || repositorySelection) && (!workbench || tabRef.current === "sources")) repositoryFocus.current?.focus(); }, [open, repositoriesVisible, repositorySelection, workbench]);
  useEffect(() => { if (open && repository && (!workbench || tabRef.current === "discover")) repositoryReviewFocus.current?.focus(); }, [open, repository, workbench]);
  useEffect(() => {
    if (!busy && focusAfterSuccess.current) {
      focusAfterSuccess.current = false;
      if (workbench && tabRef.current === "installed") installedFocus.current?.focus();
      else (closeButton.current ?? panelFocus.current)?.focus();
    }
  }, [busy, workbench]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [client]);

  async function operation(work: () => Promise<void>) {
    if (disabled || running.current) return;
    running.current = true;
    exitRevision.current += 1;
    setBusy(true);
    setFailure(null);
    setSaved(null);
    try { await work(); }
    catch (error) { if (mounted.current) setFailure(commandFailure(error)); }
    finally { running.current = false; exitRevision.current += 1; if (mounted.current) setBusy(false); }
  }
  async function submit(next: Intent) {
    await operation(async () => {
      setIntent(next);
      await Promise.all([client.cancelQueries({ queryKey: inventoryKey, exact: true }), client.cancelQueries({ queryKey: repositoriesKey, exact: true })]);
      if (next.kind !== "repository-refresh" && next.kind !== "repository-resume") {
        // Readers must not use the previous installed roster while settings are changing.
        await client.invalidateQueries({ queryKey: inventoryKey, exact: true, refetchType: "none" });
      }
      try {
        if (next.kind === "repository-refresh" || next.kind === "repository-resume") {
          const result = next.kind === "repository-refresh" ? await pluginCommands.refreshRepository(next.request, next.selection) : await pluginCommands.resumeRepository(next.request);
          if (!mounted.current) return;
          setRepository(result);
          const baselines = await readPermissionBaselines(query.data, result.packages);
          if (!mounted.current) return;
          setPermissionBaselines(baselines);
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
        setPermissionBaselines(null);
        if (workbench && tabRef.current === "discover") navigateTab("installed", "installed");
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
  const unavailable = disabled || busy || originalRequired || query.isFetching || repositoriesQuery.isFetching || !query.data || query.isError;
  const blocked = unavailable || cleanupSelection !== null;
  const trustBlocked = disabled || busy || originalRequired || query.isFetching || repositoriesQuery.isFetching || cleanupSelection !== null;
  const inventory = query.data;
  const approvedManifests = !query.isError && !query.isFetching && permissionBaselines?.revision === inventory?.settingsRevision ? permissionBaselines?.manifests : undefined;
  const trustIntent = intent?.kind === "repository-refresh" || intent?.kind === "repository-resume";
  const retainedMessage = trustIntent ? "plugins.repositoryPending" : intent?.kind === "approval-removal" || intent?.kind === "uninstall" ? "plugins.cleanupPending" : "plugins.pending";
  const discoveryContent = <>
      {workbench ? <p className="plugin-tab-help">{t("plugins.discoverHelp")}</p> : null}
      <div className="execution-actions plugin-entry-actions"><Button type="button" variant={candidate || pack || repository || inventory?.defaultsOffer ? "secondary" : "primary"} disabled={blocked} onClick={() => void operation(async () => {
        setConsent(false);
        const selected = await pluginCommands.select();
        if (mounted.current && selected) {
          setCandidate(selected); setConsent(false); setPack(null); setPackMembers([]); clearRepositoryReview(); setIntent(null); setPermissionBaselines(null);
          const baselines = await readPermissionBaselines(query.data, [{ ...selected, origin: manualOrigin }]);
          if (mounted.current) setPermissionBaselines(baselines);
        }
      })}>{t("plugins.choose")}</Button>
        <Button type="button" ref={packTrigger} variant="secondary" disabled={blocked} onClick={() => void operation(async () => {
          setPackMembers([]);
          const selected = await pluginCommands.selectPack();
          if (mounted.current && selected) {
            setPack(selected); setPackMembers([]); setCandidate(null); setConsent(false); clearRepositoryReview(); setIntent(null); setPermissionBaselines(null);
            const baselines = await readPermissionBaselines(query.data, selected.packages.map(member => ({ ...member, origin: manualOrigin })));
            if (mounted.current) setPermissionBaselines(baselines);
          }
        })}>{t("plugins.choosePack")}</Button>
        {!workbench ? <Button variant="secondary" disabled={disabled || busy} aria-expanded={repositoriesVisible} aria-controls="plugin-repositories" onClick={() => setRepositoriesVisible(true)}>{t("plugins.repositoryTitle")}</Button> : null}
      </div>
      {repository ? <>{!inventory || query.isError ? <p role="alert">{t("plugins.repositoryInventoryUnavailable")}</p> : null}<RepositoryReview repository={repository} approvedManifests={approvedManifests} selected={repositoryMembers} rollbacks={repositoryRollbacks} inventory={inventory} disabled={blocked || intent !== null}
        discardDisabled={busy || originalRequired || intent !== null} headingRef={repositoryReviewFocus} onSelect={selectRepositoryMember} onRollback={(digest, checked) => setRepositoryRollbacks(current => checked ? [...current, digest] : current.filter(item => item !== digest))}
        onInstall={installRepositoryMembers} onDiscard={() => { clearRepositoryReview(); if (workbench) navigateTab("sources", "source"); else if (repositoryTrigger.current && !repositoryTrigger.current.disabled) repositoryTrigger.current.focus(); else (closeButton.current ?? panelFocus.current)?.focus(); }}/></> : null}
      {inventory?.defaultsOffer ? <section className="plugin-section" aria-label={t("plugins.defaultsTitle")}>
        <h3>{t("plugins.defaultsTitle")}</h3><p>{t("plugins.defaultsDescription")}</p>
        <ul className="plugin-list">{inventory.defaultsOffer.packages.map(package_ => <li key={package_.packageDigest}>
          <strong>{package_.displayName}</strong> · {package_.plugin.version}
          <details><summary>{t("plugins.fingerprint")}</summary><code>{package_.packageDigest}</code></details>
        </li>)}</ul>
        <p>{t("plugins.defaultsEffect")}</p>
        {inventory.defaultsOffer.availability !== "available" ? <p>{t(inventory.defaultsOffer.availability === "resources-unavailable" ? "plugins.defaultsUnavailable" : "plugins.runtimeUnavailable")}</p> : <>
          <Field className="plugin-consent" label={t("plugins.defaultsConsent")}><input type="checkbox" disabled={blocked || intent !== null}
            checked={defaultsConsent === inventory.defaultsOffer.selectionDigest}
            onChange={event => setDefaultsConsent(event.target.checked ? inventory.defaultsOffer?.selectionDigest ?? null : null)}/></Field>
          <Button type="button" variant={candidate || pack || repository ? "secondary" : "primary"} disabled={blocked || intent !== null || defaultsConsent !== inventory.defaultsOffer.selectionDigest}
            onClick={() => { if (inventory.defaultsOffer) void submit({ kind: "defaults", request: {
              id: inventory.defaultsOffer.id, selectionDigest: inventory.defaultsOffer.selectionDigest,
              expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
            } }); }}>{t("plugins.installDefaults")}</Button>
        </>}
      </section> : null}
      {pack && inventory ? <OfflinePackReview pack={pack} approvedManifests={approvedManifests} selected={packMembers} inventory={inventory} disabled={blocked || intent !== null} headingRef={packFocus}
        onSelect={(digest, checked) => setPackMembers(current => checked ? [...current, digest] : current.filter(member => member !== digest))}
        onDiscard={() => { setPack(null); setPackMembers([]); packTrigger.current?.focus(); }}
        onInstall={installSelectedPack}/> : null}
      {candidate ? <section className="plugin-section plugin-install-review" aria-label={t("plugins.candidate")}><h3>{t("plugins.candidate")}</h3>
        <div className="plugin-review-layout"><div className="plugin-package-plan">
        <p className="plugin-package-name"><strong>{candidate.manifest.plugin.id}</strong> · {candidate.manifest.plugin.version}</p>
        <p>{t("plugins.declaredPublisher", { publisher: candidate.manifest.plugin.publisher })}</p>
        <p>{t("plugins.manualTrust")}</p>
        <h4>{t("plugins.runtime")}</h4><ul>{candidate.manifest.components.map(component => <li key={component.id}>{component.id}: {t(`plugins.runtimes.${component.runtime}`)}</li>)}</ul>
        </div><PackagePermissionReview manifest={candidate.manifest} approvedManifest={approvedManifests?.get(candidate.packageDigest)} review/></div>
        <details><summary>{t("plugins.fingerprint")}</summary><p><code>{candidate.packageDigest}</code></p><p>{t("plugins.files", { count: candidate.fileCount, bytes: candidate.byteCount })}</p></details>
        <p>{t("plugins.installEffect")}</p>
        <Field className="plugin-consent" label={t("plugins.consent")}><input type="checkbox" checked={consent} disabled={disabled || busy || originalRequired} onChange={event => setConsent(event.target.checked)}/></Field>
        <div className="execution-actions plugin-install-actions"><Button type="button" variant="primary" disabled={blocked || !consent || intent !== null} onClick={() => {
          if (query.data) void submit({ kind: "install", request: { ticket: candidate.ticket, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } });
        }}>{t("plugins.install")}</Button>
          <Button type="button" variant="secondary" disabled={disabled || busy || originalRequired} onClick={() => { setCandidate(null); setConsent(false); }}>{t("plugins.discard")}</Button></div>
      </section> : null}
  </>;
  const sourceContent = <>
      {workbench ? <p className="plugin-tab-help">{t("plugins.sourcesHelp")}</p> : null}
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
      {workbench && repository ? <Banner tone="success" action={<Button variant="secondary" onClick={() => navigateTab("discover", "catalog")}>{t("plugins.openCatalog")}</Button>}>{t("plugins.sourceCatalogReady")}</Banner> : null}
  </>;
  const installedContent = <>
      {cleanupSelection ? <section className="plugin-section plugin-cleanup-review" aria-labelledby="plugin-cleanup-title">
        <h3 id="plugin-cleanup-title" tabIndex={-1} ref={cleanupFocus}>{t(cleanupSelection.original ? "plugins.originalRemovalTitle" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.revokeTitle" : "plugins.uninstallTitle", {
          name: cleanupSelection.intent.request.package.plugin.id, version: cleanupSelection.intent.request.package.plugin.version,
        })}</h3>
        <p>{t(cleanupSelection.original ? "plugins.originalRemovalEffect" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.revokeEffect" : "plugins.uninstallEffect")}</p>
        <details><summary>{t("plugins.fingerprint")}</summary><code>{cleanupSelection.intent.request.package.packageDigest}</code>
          <p>{t("plugins.origin", { source: cleanupSelection.intent.request.origin.sourceId, publisher: cleanupSelection.intent.request.origin.publisherId })}</p>
          {cleanupSelection.intent.kind === "uninstall" ? <p>{t("plugins.installationReference", { action: cleanupSelection.intent.request.originalInstallAction })}</p> : null}
        </details>
        <Field className="plugin-consent" label={t(cleanupSelection.original ? "plugins.originalRemovalConsent" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.revokeConsent" : "plugins.uninstallConsent")}><input type="checkbox" checked={cleanupSelection.consent} disabled={disabled || busy || originalRequired || intent !== null}
          onChange={event => setCleanupSelection({ ...cleanupSelection, consent: event.target.checked })}/></Field>
        <div className="execution-actions"><Button type="button" variant="primary" disabled={unavailable || intent !== null || !cleanupSelection.consent}
          onClick={() => void submit(cleanupSelection.intent)}>{t(cleanupSelection.original ? "plugins.confirmOriginalRemoval" : cleanupSelection.intent.kind === "approval-removal" ? "plugins.confirmRevoke" : "plugins.confirmUninstall")}</Button>
          <Button type="button" variant="secondary" disabled={disabled || busy || originalRequired || intent !== null} onClick={() => {
            returnCleanupFocus.current = true; setCleanupSelection(null);
          }}>{t("plugins.cancelCleanup")}</Button></div>
      </section> : null}
      {inventory ? <section className="plugin-section" aria-label={t("plugins.installed")}><h3 ref={installedFocus} tabIndex={-1}>{t("plugins.installed")}</h3>
        {!inventory.packages.length ? <p>{t("plugins.empty")}</p> : <ul className="plugin-list">{inventory.packages.map(record => {
          const decision = inventory.packageDecisions.find(value => value.packageDigest === record.packageDigest && value.plugin.id === record.plugin.id && value.plugin.publisher === record.plugin.publisher && value.plugin.version === record.plugin.version);
          return <li key={record.packageDigest}><div><strong>{record.plugin.id}</strong> · {record.plugin.version}</div>
            <p>{t("plugins.declaredPublisher", { publisher: record.plugin.publisher })}</p>
            <p>{t(record.state === "recovery-required" ? "plugins.recovery" : !decision ? "plugins.unapproved" : decision.enabled ? "plugins.enabled" : "plugins.disabled")}</p>
            <details><summary>{t("plugins.fingerprint")}</summary><code>{record.packageDigest}</code><p>{t("plugins.origin", { source: record.origin.sourceId, publisher: record.origin.publisherId })}</p></details>
            {decision ? <div className="execution-actions"><Button type="button" variant="secondary" disabled={blocked || intent !== null || (!decision.enabled && record.state !== "sealed")} onClick={() => {
              if (query.data) void submit({ kind: "enable", request: { package: { plugin: record.plugin, packageDigest: record.packageDigest }, enabled: !decision.enabled, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } });
            }}>{t(decision.enabled ? "plugins.disable" : "plugins.enable")}</Button>
              <Button type="button" variant="link" disabled={blocked} onClick={() => void operation(async () => { const view = await pluginCommands.package({ plugin: record.plugin, packageDigest: record.packageDigest }); if (mounted.current) setDetails(view); })}>{t("plugins.details")}</Button>
              <Button type="button" variant="secondary" disabled={blocked || intent !== null} onClick={event => reviewCleanup({ kind: "approval-removal", request: {
                package: { plugin: decision.plugin, packageDigest: decision.packageDigest }, origin: decision.origin,
                expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
              } }, event.currentTarget)}>{t("plugins.revoke")}</Button></div> : null}
            <Button type="button" variant="secondary" disabled={blocked || intent !== null || record.state !== "sealed" || inventory.packageDecisions.some(value => value.packageDigest === record.packageDigest
              || (value.plugin.id === record.plugin.id && value.plugin.publisher === record.plugin.publisher && value.plugin.version === record.plugin.version))}
              onClick={event => reviewCleanup({ kind: "uninstall", request: { package: { plugin: record.plugin, packageDigest: record.packageDigest }, origin: record.origin,
                originalInstallAction: record.originalInstallAction, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
              } }, event.currentTarget)}>{t("plugins.uninstall")}</Button>
            {inventory.packageDecisions.some(value => value.packageDigest === record.packageDigest
              || (value.plugin.id === record.plugin.id && value.plugin.publisher === record.plugin.publisher && value.plugin.version === record.plugin.version)) ? <p>{t("plugins.revokeFirst")}</p> : null}
          </li>;
        })}</ul>}
        {inventory.packageDecisions.filter(decision => !inventory.packages.some(record => record.packageDigest === decision.packageDigest)).map(decision => <div key={decision.packageDigest}><p>{t("plugins.approvedMissing", { name: decision.plugin.id, version: decision.plugin.version })}</p>
          {decision.enabled ? <Button type="button" disabled={blocked || intent !== null} onClick={() => { if (query.data) void submit({ kind: "enable", request: { package: { plugin: decision.plugin, packageDigest: decision.packageDigest }, enabled: false, expectedRevision: query.data.settingsRevision, actionId: crypto.randomUUID() } }); }}>{t("plugins.disable")}</Button> : null}
          <Button type="button" variant="secondary" disabled={blocked || intent !== null} onClick={event => reviewCleanup({ kind: "approval-removal", request: {
            package: { plugin: decision.plugin, packageDigest: decision.packageDigest }, origin: decision.origin,
            expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID(),
          } }, event.currentTarget)}>{t("plugins.revoke")}</Button></div>)}
      </section> : null}
      {inventory?.uninstallations.length ? <section className="plugin-section" aria-label={t("plugins.previousRemovals")}>
        <details><summary>{t("plugins.previousRemovals")}</summary><p>{t("plugins.removalObservation")}</p>
          <ul className="plugin-list">{inventory.uninstallations.map(record => <li key={record.actionId}>
            <p><strong>{record.installation.plugin.id}</strong> · {record.installation.plugin.version}</p>
            <p>{t(record.state === "recovery-required" ? "plugins.removalPending" : "plugins.removalRecorded")}</p>
            <Button type="button" variant="secondary" disabled={blocked || intent !== null} onClick={event => reviewCleanup({ kind: "uninstall", request: {
              package: { plugin: record.installation.plugin, packageDigest: record.installation.packageDigest }, origin: record.installation.origin,
              originalInstallAction: record.installation.originalInstallAction, expectedRevision: record.settingsRevision, actionId: record.actionId,
            } }, event.currentTarget, true)}>{t("plugins.confirmRemoval")}</Button>
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
              <Field className="plugin-consent" label={t("plugins.nativeHostConsent")}><input type="checkbox" checked={nativeHostConsent === offer.environmentDigest} disabled={blocked || intent !== null}
                onChange={event => setNativeHostConsent(event.target.checked ? offer.environmentDigest : null)}/></Field>
              <Button type="button" variant="secondary" disabled={blocked || intent !== null || nativeHostConsent !== offer.environmentDigest} onClick={() => {
                void submit({ kind: "native-host", request: { environmentDigest: offer.environmentDigest, approved: true, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID() } });
              }}>{t("plugins.nativeHostApprove")}</Button>
            </>}
          </>;
        })() : <p>{t(`plugins.nativeHostAvailability.${inventory.nativeHostOffer.reason}`)}</p>}
        {inventory.runtimeDecisions.filter(decision => decision.environment.profile === "native-application-host-v1").map(decision => <div key={decision.environmentDigest}>
          <p>{decision.environment.profile === "native-application-host-v1" ? t("plugins.nativeHostApproved", { version: decision.environment.hostVersion }) : null}</p>
          <details><summary>{t("plugins.runtimeFingerprint")}</summary><code>{decision.environmentDigest}</code></details>
          <p>{t("plugins.nativeHostRevokeEffect")}</p>
          <Button type="button" variant="link" disabled={blocked || intent !== null} onClick={() => {
            void submit({ kind: "native-host", request: { environmentDigest: decision.environmentDigest, approved: false, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID() } });
          }}>{t("plugins.nativeHostRevoke")}</Button>
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
              <Field className="plugin-consent" label={t("plugins.runtimeConsent")}><input type="checkbox" checked={runtimeConsent === offer.environmentDigest} disabled={blocked || intent !== null} onChange={event => setRuntimeConsent(event.target.checked ? offer.environmentDigest : null)}/></Field>
              <Button type="button" variant="secondary" disabled={blocked || intent !== null || runtimeConsent !== offer.environmentDigest} onClick={() => {
                void submit({ kind: "runtime", request: { id: offer.id, environmentDigest: offer.environmentDigest, expectedRevision: inventory.settingsRevision, actionId: crypto.randomUUID() } });
              }}>{t(record ? "plugins.confirmRuntime" : "plugins.installRuntime")}</Button>
            </>}
          </div>;
        })}
        <h4>{t("plugins.installedRuntimes")}</h4>
        {!inventory.runtimes.length ? <p>{t("plugins.runtimeEmpty")}</p> : <ul className="plugin-list">{inventory.runtimes.map(record => {
          const approved = inventory.runtimeDecisions.some(decision => decision.origin.sourceId === record.origin.sourceId && decision.origin.publisherId === record.origin.publisherId && decision.environmentDigest === record.environmentDigest);
          return <li key={record.environmentDigest}><p>{t("plugins.bundledRuntime", { version: record.environment.toolVersion })}</p>
            <p>{t(record.state === "recovery-required" ? "plugins.runtimeRecovery" : approved ? "plugins.runtimeApproved" : "plugins.unapproved")}</p>
            <details><summary>{t("plugins.runtimeFingerprint")}</summary><code>{record.environmentDigest}</code></details>
            {approved && record.state === "sealed" ? <Button type="button" variant="secondary" disabled={blocked || intent !== null} onClick={() => void operation(async () => {
              setVerifiedRuntime(null); await pluginCommands.lookupRuntime({ environmentDigest: record.environmentDigest }); if (mounted.current) setVerifiedRuntime(record.environmentDigest);
            })}>{t("plugins.verifyRuntime")}</Button> : null}
            {verifiedRuntime === record.environmentDigest ? <p className="plugin-feedback" data-tone={query.isError || query.isFetching ? "warning" : "success"} role="status">{t("plugins.runtimeVerified")}</p> : null}
          </li>;
        })}</ul>}
        {inventory.runtimeDecisions.map(decision => decision.environment.profile === "node-system-libraries-v1" && !inventory.runtimes.some(record => record.environmentDigest === decision.environmentDigest)
          ? <p key={decision.environmentDigest}>{t("plugins.runtimeApprovedMissing", { version: decision.environment.toolVersion })}</p> : null)}
      </section> : null}
      {details ? <section className="plugin-section plugin-installed-details" aria-label={t("plugins.details")}><h3>{details.manifest.plugin.id} · {details.manifest.plugin.version}</h3><PackagePermissionReview manifest={details.manifest}/>
        <ul>{details.manifest.contributions.map(contribution => <li key={contribution.id}>{contribution.id} · {t(`plugins.contributions.${contribution.contribution.kind}`)}</li>)}</ul>
      </section> : null}
  </>;
  const content = <div className="plugin-manager-body" ref={panelFocus} tabIndex={-1} aria-busy={busy}
      onKeyDownCapture={preventCompositionAction}
      onCompositionStartCapture={() => { composing.current = true; }}
      onCompositionEndCapture={() => { composing.current = false; }}
      onClickCapture={event => { if (composing.current && event.detail === 0) { event.preventDefault(); event.stopPropagation(); } }}>
      <p className="plugin-boundaries">{t("plugins.permissionBoundary")}</p>
      <div className="plugin-refresh"><Button variant="ghost" disabled={disabled || busy || query.isFetching} onClick={() => void query.refetch()}>{t("plugins.refresh")}</Button></div>
      {busy || query.isFetching ? <Banner tone="info" role="status">{t("plugins.loading")}</Banner> : null}
      {query.isError ? <Banner tone={query.data ? "warning" : "error"} role="alert"><p>{t("plugins.readFailed")}</p>{query.data ? <p>{t("plugins.stale")}</p> : null}<CommandFailureDetails failure={commandFailure(query.error)}/></Banner> : null}
      {saved ? <Banner tone="success" role="status">{t(saved)}</Banner> : null}
      {failure ? <Banner tone={originalRequired ? "warning" : "error"} role="alert" ref={failureFocus} tabIndex={-1}><p>{t(recovery === "retained" ? retainedMessage : failureMessage(failure, unknown, trustIntent))}</p>
        <CommandFailureDetails failure={failure}/>{intent ? <Button type="button" variant="secondary" disabled={disabled || busy || query.isFetching || repositoriesQuery.isFetching} onClick={() => void submit(intent)}>{t("plugins.retryOriginal")}</Button> : null}
        {!originalRequired && intent ? <Button type="button" variant="link" disabled={disabled || busy} onClick={() => { setIntent(null); setFailure(null); setCleanupSelection(null); setCandidate(null); setPack(null); setPackMembers([]); clearRepositoryReview(); setConsent(false); setRuntimeConsent(null); setNativeHostConsent(null); void query.refetch(); if (repositoriesVisible) void repositoriesQuery.refetch(); }}>{t("plugins.reviewCurrent")}</Button> : null}
      </Banner> : null}
      {workbench ? <TabsRoot value={tab} onValueChange={changeTab}>
        <TabsList aria-label={t("plugins.tabsLabel")}>
          <TabsTrigger value="installed">{t("plugins.installedTab")}</TabsTrigger>
          <TabsTrigger value="discover">{t("plugins.discoverTab")}</TabsTrigger>
          <TabsTrigger value="sources">{t("plugins.sourcesTab")}</TabsTrigger>
        </TabsList>
        <TabsContent value="installed" forceMount hidden={tab !== "installed"}>{installedContent}</TabsContent>
        <TabsContent value="discover" forceMount hidden={tab !== "discover"}>{discoveryContent}</TabsContent>
        <TabsContent value="sources" forceMount hidden={tab !== "sources"}>{sourceContent}</TabsContent>
      </TabsRoot> : <>{discoveryContent}{sourceContent}{installedContent}</>}
    </div>;
  const restoreTrigger = (event: Event) => {
    if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); }
    composing.current = false;
  };
  if (workbench) return <Sheet open={open} closeDisabled={busy} onOpenChange={changeOpen} title={t("plugins.title")}
    description={t("plugins.workbenchDescription")} closeLabel={t("plugins.close")} className="plugin-manager plugin-manager-workbench"
    trigger={hideTrigger ? undefined : <Button variant="secondary" disabled={disabled}>{t("plugins.open")}</Button>}
    onOpenAutoFocus={event => { if (failure && failureFocus.current) { event.preventDefault(); failureFocus.current.focus(); } }}
    onCloseAutoFocus={restoreTrigger}
    onEscapeKeyDown={event => { if (running.current || composing.current || event.isComposing || event.keyCode === 229) event.preventDefault(); }}
    onInteractOutside={event => { if (running.current) event.preventDefault(); }}>
    {content}
  </Sheet>;
  return <Dialog open={open} onOpenChange={changeOpen}>
    {!hideTrigger ? <DialogTrigger asChild><Button variant="secondary" disabled={disabled}>{t("plugins.open")}</Button></DialogTrigger> : null}
    <DialogPortal><DialogOverlay className="dialog-backdrop"/><DialogContent className="execution-dialog plugin-manager"
      onOpenAutoFocus={event => { if (failure && failureFocus.current) { event.preventDefault(); failureFocus.current.focus(); } }}
      onCloseAutoFocus={restoreTrigger}
      onEscapeKeyDown={event => { if (running.current || composing.current || event.isComposing || event.keyCode === 229) event.preventDefault(); }}
      onInteractOutside={event => { if (running.current) event.preventDefault(); }}>
      <div className="execution-heading"><div><DialogTitle>{t("plugins.title")}</DialogTitle><DialogDescription>{t("plugins.description")}</DialogDescription></div>
        <Button ref={closeButton} variant="secondary" disabled={disabled || busy} onClick={() => changeOpen(false)}>{t("plugins.close")}</Button></div>
      {content}
    </DialogContent></DialogPortal>
  </Dialog>;
}
