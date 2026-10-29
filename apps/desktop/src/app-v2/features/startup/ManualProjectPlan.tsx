import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { join } from "@tauri-apps/api/path";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button, IconButton } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner } from "../../../design-system/Feedback";
import { CommandFailureDetails, commandFailure, type CommandFailure } from "../../../CommandFailure";
import { useApplicationQueryClient } from "../../../ApplicationReadProvider";
import { matchingPluginEnvironments } from "../../../pluginEnvironments";
import { sourceReads } from "../../../sourceQueries";
import { sameSourceEnvironment } from "../../../sourceCommands";
import { startupCommands, type StartupClaimRequest } from "../../../startupCommands";
import type { PluginSourceRequest } from "../../../pluginCommands";
import { isCommandError } from "../../../projectCommands";
import { isSafeChildDirectoryName, previewDestination } from "../../../projectLocation";
import { languageName } from "../../../i18n/languageNames";
import type { LeaveIntent, ProjectLifecycle } from "../../platform/projectLifecycle";
import { useProjectLifecycle } from "../../platform/useProjectLifecycle";
import type { InteractionGate } from "../../workspace/interactionGate";
import StartupSourcePreparation, { type StartupSourceInventory, type StartupSourcePlan } from "./StartupSourcePreparation";
import styles from "./ManualProjectPlan.module.css";

interface Draft { name: string; parent: string; folder: string; source: string; targets: string[]; target: string; sourcePlan: StartupSourcePlan | null; sequence: number }
type FieldName = "name" | "parent" | "folder" | "source" | "targets";
const empty = (): Draft => ({ name: "", parent: "", folder: "", source: "", targets: [], target: "", sourcePlan: null, sequence: 0 });
const emptySource = (): StartupSourcePlan => ({ directory: null, folderName: "", choice: "", runtime: "", preflight: null, expired: false });
const dirty = (draft: Draft) => !!(draft.name || draft.parent || draft.folder || draft.source || draft.targets.length || draft.target || draft.sourcePlan);
const languages = ["en-US", "zh-Hans", "zh-Hant", "ja-JP", "ko-KR", "es-ES", "fr-FR", "de-DE", "pt-BR"];

export default function ManualProjectPlan({ controller, gate, open, onOpenChange, native, drop, onDropConsumed, onCreated }: {
  controller: ProjectLifecycle; gate: InteractionGate; open: boolean; onOpenChange: (open: boolean) => void; native: boolean;
  drop?: { dropTicket: string; folderName: string } | null; onDropConsumed?: () => void; onCreated?: (request: StartupClaimRequest) => void;
}) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "startup" });
  const lifecycle = useProjectLifecycle(controller), [draft, setDraft] = useState<Draft>(empty), current = useRef(draft);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({}), [pickFailed, setPickFailed] = useState(false);
  const [preparing, setPreparing] = useState(false), preparation = useRef(false), composing = useRef(false), mounted = useRef(true);
  const [compositionRevision, setCompositionRevision] = useState(0);
  const submitted = useRef<Draft | null>(null);
  const picker = useRef(0), openRef = useRef(open);
  const sourceFlight = useRef(0), [sourceOperation, setSourceOperation] = useState<"selecting" | "checking" | null>(null);
  const sourceWorking = useRef(false), [sourceFailure, setSourceFailure] = useState<CommandFailure | null>(null), consumedDrop = useRef<string | null>(null), seenDrop = useRef<string | null>(null);
  const client = useApplicationQueryClient(), inventoryOptions = sourceReads.inventory(0);
  const inventory = useQuery({ queryKey: inventoryOptions.key, queryFn: inventoryOptions.read,
  enabled: open && !!draft.sourcePlan, networkMode: "always", retry: false, staleTime: 0, gcTime: 60_000,
  refetchOnWindowFocus: false, refetchOnReconnect: false }, client);
  const sourceReading = useRef(false); sourceReading.current = open && !!draft.sourcePlan && inventory.isFetching;
  const [leave, setLeave] = useState<{ sequence: number; intent: LeaveIntent["kind"] | "dismiss"; current: () => boolean; finish: (allow: boolean) => void } | null>(null);
  const leaveRef = useRef(leave), [changed, setChanged] = useState(false), dialogId = useId(), discardId = useId(), languageList = useId();
  const pendingCreation = lifecycle.pending?.kind === "create" ? lifecycle.pending : null;
  const busy = preparing || lifecycle.phase !== "idle" || !!lifecycle.pending || !!lifecycle.retainedSession || !!lifecycle.cleanup;
  const cause = lifecycle.failure?.cause, failure = submitted.current && isCommandError(cause) && cause.stage === "create" ? cause : null;
  const blocked = () => {
    const state = controller.getSnapshot();
    return preparation.current || sourceWorking.current || sourceReading.current || !!leaveRef.current || state.phase !== "idle" || !!state.pending || !!state.retainedSession || !!state.cleanup;
  };
  function edit(patch: Partial<Omit<Draft, "sequence">>) {
    const next = { ...current.current, ...patch, sequence: current.current.sequence + 1 };
    current.current = next; setDraft(next); setErrors({}); setChanged(false);
  }
  function clear() { sourceFlight.current++; picker.current++; const next = { ...empty(), sequence: current.current.sequence + 1 }; submitted.current = null; current.current = next; setDraft(next); setErrors({}); setSourceFailure(null); }
  function review(intent: LeaveIntent["kind"] | "dismiss", currentIntent: () => boolean = () => true) {
    if (leaveRef.current) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const value = { sequence: current.current.sequence, intent, current: currentIntent, finish: resolve };
      leaveRef.current = value; setLeave(value);
    });
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sourceFlight.current++; leaveRef.current?.finish(false); };
  }, []);
  useLayoutEffect(() => open ? gate.pushDialog(dialogId) : undefined, [open, gate, dialogId]);
  useLayoutEffect(() => { openRef.current = open; if (!open) { picker.current++; sourceFlight.current++; } }, [open]);
  useLayoutEffect(() => leave ? gate.pushDialog(discardId) : undefined, [leave, gate, discardId]);
  useLayoutEffect(() => controller.register({
    id: "startup-project-plan", area: "overview", scope: { kind: "application" },
    inspect: intent => intent.kind === "restore" ? { status: "ready", revision: "retained-startup-project-plan" }
      : ({ status: composing.current ? "blocked" : intent.kind === "create-project"
      || intent.kind === "open-project" && controller.getSnapshot().pending?.kind === "create" ? "ready"
      : preparation.current || sourceWorking.current || sourceReading.current ? "blocked" : dirty(current.current) ? "dirty" : "ready", revision: String(current.current.sequence) }),
    prepareLeave: (intent, proof, currentIntent) => review(intent.kind, () => proof() && currentIntent()),
    reveal: () => onOpenChange(true),
  }), [controller, onOpenChange]);
  async function close() {
    if (blocked() || composing.current) return;
    if (!dirty(current.current) || await review("dismiss")) onOpenChange(false);
  }
  async function chooseParent() {
    if (blocked()) return;
    const sequence = current.current.sequence, selection = ++picker.current;
    try {
      const selected = await pickDirectory({ directory: true, multiple: false });
      if (mounted.current && openRef.current && selection === picker.current && !blocked() && sequence === current.current.sequence && typeof selected === "string") { edit({ parent: selected }); setPickFailed(false); }
    } catch { if (mounted.current && openRef.current && selection === picker.current) setPickFailed(true); }
  }
  function sourceRequest(plan: StartupSourcePlan | null): PluginSourceRequest | null {
    const state = client.getQueryState<StartupSourceInventory>(inventoryOptions.key), choice = state?.data?.choices.find(value => value.key === plan?.choice);
    if (!plan || !choice || state?.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated || state.error
      || !matchingPluginEnvironments(state.data?.environments ?? [], choice.runtimeKinds).some(value => value.environmentDigest === plan.runtime)) return null;
    return { package: choice.package, resourceId: choice.resourceId, environmentDigest: plan.runtime };
  }
  function readySource(plan: StartupSourcePlan | null, source: PluginSourceRequest | null) {
    return !!source && !!plan?.directory && !!plan.preflight?.complete
      && plan.directory.selectionId === plan.preflight.directory.selectionId && sameSourceEnvironment(plan.preflight.source, source);
  }
  const sourceReady = readySource(draft.sourcePlan, sourceRequest(draft.sourcePlan));
  async function chooseSource(ticket?: string, folderName = "") {
    if (!native || blocked() || composing.current) return;
    const before = current.current.sourcePlan ?? emptySource();
    const selectedPlan = { ...before, directory: null, preflight: null, folderName: folderName || before.folderName, expired: !!before.directory || before.expired };
    edit({ sourcePlan: selectedPlan });
    const frame = current.current, flight = ++sourceFlight.current;
    sourceWorking.current = true; setSourceOperation("selecting"); setSourceFailure(null);
    try {
      const selected = ticket ? await startupCommands.droppedDirectory({ dropTicket: ticket }) : await startupCommands.chooseDirectory();
      if (!mounted.current || !openRef.current || flight !== sourceFlight.current || current.current !== frame || composing.current) return;
      if (selected) edit({ sourcePlan: { ...selectedPlan, directory: selected, folderName: selected.folderName, expired: false } });
    } catch (cause) {
      if (mounted.current && openRef.current && flight === sourceFlight.current && current.current === frame) setSourceFailure(commandFailure(cause));
    } finally {
      sourceWorking.current = false; if (mounted.current) setSourceOperation(null);
    }
  }
  useLayoutEffect(() => {
    if (!open || !native || !drop || seenDrop.current === drop.dropTicket) return;
    // A native drop can supersede the Host's former selection before its ticket is consumed.
    seenDrop.current = drop.dropTicket; sourceFlight.current++;
    edit({ sourcePlan: { ...(current.current.sourcePlan ?? emptySource()), directory: null, preflight: null, folderName: drop.folderName, expired: false } });
    setSourceFailure(null);
  }, [open, native, drop?.dropTicket, drop?.folderName]);
  useEffect(() => {
    if (!open || !native || !drop || consumedDrop.current === drop.dropTicket || blocked() || composing.current) return;
    let active = true;
    // An effect replay must not consume a one-use native invitation before cleanup.
    void Promise.resolve().then(() => {
      if (!active || !mounted.current || !openRef.current || consumedDrop.current === drop.dropTicket || blocked() || composing.current) return;
      consumedDrop.current = drop.dropTicket; onDropConsumed?.(); void chooseSource(drop.dropTicket, drop.folderName);
    });
    return () => { active = false; };
  }, [open, native, drop, onDropConsumed, sourceOperation, inventory.isFetching, lifecycle.phase, lifecycle.pending, compositionRevision]);
  function changeSource(choice: string, runtime: string) {
    if (blocked() || composing.current || !current.current.sourcePlan) return;
    edit({ sourcePlan: { ...current.current.sourcePlan, choice, runtime, preflight: null } }); setSourceFailure(null);
  }
  async function refreshSources() {
    if (blocked() || composing.current || !current.current.sourcePlan) return;
    edit({ sourcePlan: { ...current.current.sourcePlan, preflight: null } }); setSourceFailure(null);
    await inventory.refetch();
  }
  async function checkSource() {
    if (!native || blocked() || composing.current) return;
    const plan = current.current.sourcePlan, source = sourceRequest(plan);
    if (!plan?.directory || !source) return;
    edit({ sourcePlan: { ...plan, preflight: null } });
    const frame = current.current, flight = ++sourceFlight.current;
    sourceWorking.current = true; setSourceOperation("checking"); setSourceFailure(null);
    try {
      const preflight = await startupCommands.preflight({ selectionId: plan.directory.selectionId, source });
      if (mounted.current && openRef.current && flight === sourceFlight.current && current.current === frame && !composing.current)
        edit({ sourcePlan: { ...plan, preflight } });
    } catch (cause) {
      if (mounted.current && openRef.current && flight === sourceFlight.current && current.current === frame) setSourceFailure(commandFailure(cause));
    } finally { sourceWorking.current = false; if (mounted.current) setSourceOperation(null); }
  }
  function addLanguage() {
    if (blocked() || composing.current || !current.current.target.trim()) return;
    if (current.current.targets.includes(current.current.target)) { setErrors({ targets: t("duplicateTarget") }); return; }
    edit({ targets: [...current.current.targets, current.current.target], target: "" });
  }
  async function submit() {
    if (!native || blocked() || composing.current) return;
    const frame = current.current, invalid: Partial<Record<FieldName, string>> = {};
    const source = sourceRequest(frame.sourcePlan), directory = frame.sourcePlan?.directory;
    if (frame.sourcePlan && !readySource(frame.sourcePlan, source)) return;
    for (const key of ["name", "parent", "folder", "source"] as const) if (!frame[key].trim()) invalid[key] = t("required");
    if (frame.folder && !isSafeChildDirectoryName(frame.folder)) invalid.folder = t("invalidFolder");
    if (!frame.targets.length) invalid.targets = t("noTargets");
    setErrors(invalid); if (Object.keys(invalid).length) return;
    preparation.current = true; setPreparing(true);
    let createdSource: StartupClaimRequest | undefined;
    try {
      const destination = await join(frame.parent, frame.folder);
      if (!mounted.current || !openRef.current || current.current !== frame || composing.current) return;
      submitted.current = frame;
      const previous = controller.getSnapshot().session;
      const saved = await controller.create({ destination, displayName: frame.name, sourceLocale: frame.source, targetLocales: frame.targets });
      if (!mounted.current) return;
      const state = controller.getSnapshot(), session = state.session;
      if (saved && openRef.current && current.current === frame && !composing.current && session && session !== previous
        && session.project.sessionToken !== previous?.project.sessionToken && session.project.metadata.projectId !== previous?.project.metadata.projectId
        && state.phase === "idle" && !state.pending && !state.retainedSession && !state.cleanup) {
        // The new project already exists. Source handoff is a separate action owned by the workspace.
        clear(); onOpenChange(false);
        if (source && directory) createdSource = { selectionId: directory.selectionId, source, projectId: session.project.metadata.projectId, sessionToken: session.project.sessionToken };
      }
    } catch { if (mounted.current) setErrors({ parent: t("invalidField") }); }
    finally { preparation.current = false; if (mounted.current) setPreparing(false); }
    if (createdSource) onCreated?.(createdSource);
  }
  const error = (key: FieldName, coreField: string = key) => errors[key]
    ?? (failure?.field === coreField && submitted.current?.[key] === draft[key] ? t("invalidField") : undefined);
  return <>
    <Dialog open={open} onOpenChange={value => { if (!value) void close(); }} title={t("title")} description={t("help")} closeLabel={t("close")}>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; setCompositionRevision(value => value + 1); }}>
        {pickFailed ? <Banner tone="error">{t("pickFailed")}</Banner> : null}
        {changed ? <Banner tone="warning">{t("changed")}</Banner> : null}
        {pendingCreation ? <Banner tone="warning" action={<Button disabled={preparing || lifecycle.phase !== "idle"} onClick={() => void controller.openCreatedProject()}>{t("openDestination")}</Button>}>{t("unknown")}<p>{t("unknownLocation", { path: pendingCreation.locator })}</p></Banner>
          : failure ? <Banner tone="error">{t("createFailed")}<CommandFailureDetails failure={commandFailure(cause)}/></Banner> : null}
        <StartupSourcePreparation plan={draft.sourcePlan} inventory={inventory.data} loading={inventory.isFetching} inventoryFailed={!!inventory.error} failure={sourceFailure}
          busy={busy} native={native} checking={sourceOperation === "checking"} selecting={sourceOperation === "selecting"} ready={sourceReady}
          onChoose={() => void chooseSource()} onRefresh={() => void refreshSources()} onChange={changeSource} onCheck={() => void checkSource()}
          onManual={() => { if (!busy && !sourceWorking.current && !leaveRef.current && !composing.current) { sourceFlight.current++; edit({ sourcePlan: null }); setSourceFailure(null); } }}/>
        <Field label={t("name")} required error={error("name", "displayName")}><TextInput value={draft.name} readOnly={busy} onChange={event => edit({ name: event.target.value })}/></Field>
        <Field label={t("parent")} required error={error("parent", "destination")}><TextInput value={draft.parent} readOnly={busy} onChange={event => edit({ parent: event.target.value })}/></Field>
        <Button disabled={!native || busy} onClick={() => void chooseParent()}>{t("chooseParent")}</Button>
        <Field label={t("folder")} description={t("locationHelp")} required error={error("folder")}><TextInput value={draft.folder} readOnly={busy} onChange={event => edit({ folder: event.target.value })}/></Field>
        <p className={styles.destination}>{t("destination")}: {previewDestination(draft.parent, draft.folder)}</p>
        <datalist id={languageList}>{languages.map(value => <option key={value} value={value}>{languageName(value, i18n.language)}</option>)}</datalist>
        <Field label={t("source")} description={t("sourceHelp")} required error={error("source", "sourceLocale")}><TextInput list={languageList} value={draft.source} readOnly={busy} onChange={event => edit({ source: event.target.value })}/></Field>
        <Field label={t("target")}><TextInput list={languageList} value={draft.target} readOnly={busy} onChange={event => edit({ target: event.target.value })} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addLanguage(); } }}/></Field>
        <Button disabled={busy || !draft.target.trim()} onClick={addLanguage}>{t("addTarget")}</Button>
        <div role="group" aria-label={t("targets")} className={styles.languages}>{draft.targets.map(value => <span className={styles.language} key={value}>{languageName(value, i18n.language)} <code>{value}</code><IconButton disabled={busy} label={t("removeTarget", { language: languageName(value, i18n.language) })} onClick={() => edit({ targets: current.current.targets.filter(target => target !== value) })}><X/></IconButton></span>)}</div>
        {error("targets", "targetLocales") ? <p role="alert">{error("targets", "targetLocales")}</p> : null}
        <div className={styles.actions}><Button disabled={busy || !!sourceOperation} onClick={() => void close()}>{t("close")}</Button><Button variant="primary" type="submit" pending={preparing || lifecycle.phase === "creating"} disabled={!native || busy || !!sourceOperation || !!draft.sourcePlan && !sourceReady}>{t("create")}</Button></div>
      </form>
    </Dialog>
    <Dialog open={leave !== null} onOpenChange={value => { if (!value) { leaveRef.current?.finish(false); leaveRef.current = null; setLeave(null); } }} title={t("discardTitle")} description={t(leave?.intent === "close-window" ? "discardExit" : "discardHelp")} closeLabel={t("close")}
      footer={<><Button onClick={() => { leave?.finish(false); leaveRef.current = null; setLeave(null); }}>{t("keep")}</Button><Button variant="danger" onClick={() => {
        if (!leave) return;
        if (current.current.sequence !== leave.sequence || composing.current || !leave.current()) { setChanged(true); leave.finish(false); leaveRef.current = null; setLeave(null); return; }
        clear(); leave.finish(true); leaveRef.current = null; setLeave(null);
      }}>{t("discard")}</Button></>}>
      {changed ? <Banner tone="warning">{t("changed")}</Banner> : null}
    </Dialog>
  </>;
}
