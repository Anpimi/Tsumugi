import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "../../../CommandFailure";
import { hasUnknownOutcome, isCommandError, projectCommands, type ProjectView, type RenameProjectRequest, type SetTargetLocalesRequest } from "../../../projectCommands";
import { isSafeChildDirectoryName } from "../../../projectLocation";
import { normalizeLocator } from "../../../recentProjects";
import { languageName } from "../../../i18n/languageNames";
import { Button } from "../../../design-system/Button";
import { Sheet } from "../../../design-system/Dialog";
import { Field, TextArea, TextInput } from "../../../design-system/Field";
import { Banner } from "../../../design-system/Feedback";
import type { LifecycleParticipant, ProjectLifecycle } from "../../platform/projectLifecycle";
import styles from "./ProjectMetadataSheet.module.css";

type Pending = { previous: ProjectView; raw: string; renameFolder: boolean } & (
  { kind: "name"; request: RenameProjectRequest } | { kind: "languages"; request: SetTargetLocalesRequest });
type Notice = "saved" | "failed" | "unknown" | "readFailed" | "previous" | "stale" | "refreshFailed" | null;
const locales = (raw: string) => raw.split(/[,;\n]/).map(value => value.trim()).filter(Boolean);
const sameTags = (left: readonly string[], right: readonly string[]) => left.map(value => value.toLowerCase()).sort().join("\n") === right.map(value => value.toLowerCase()).sort().join("\n");
function outcome(view: ProjectView, pending: Pending): "committed" | "previous" | "unknown" {
  const before = pending.previous, after = view.metadata;
  if (view.sessionToken !== before.sessionToken || after.projectId !== before.metadata.projectId) return "unknown";
  if (view.reconciliationState !== "settled") return view.reconciliationState;
  if (after.metadataRevision === before.metadata.metadataRevision && after.displayName === before.metadata.displayName
    && after.sourceLocale === before.metadata.sourceLocale && sameTags(after.targetLocales, before.metadata.targetLocales)
    && normalizeLocator(view.locator) === normalizeLocator(before.locator)) return "previous";
  if (BigInt(after.metadataRevision) !== BigInt(pending.request.expectedRevision) + 1n || after.sourceLocale !== before.metadata.sourceLocale) return "unknown";
  const directoryName = pending.kind === "name" ? pending.request.directoryName : null;
  const expectedLocator = directoryName ? before.locator.replace(/([\\/])[^\\/]+[\\/]?$/, (_match, separator: string) => `${separator}${directoryName}`) : before.locator;
  if (normalizeLocator(view.locator) !== normalizeLocator(expectedLocator)) return "unknown";
  return (pending.kind === "name" ? after.displayName === pending.request.displayName && sameTags(after.targetLocales, before.metadata.targetLocales)
    : after.displayName === before.metadata.displayName && sameTags(after.targetLocales, pending.request.targetLocales)) ? "committed" : "unknown";
}
interface State { basis: ProjectView; name: string; renameFolder: boolean; languages: string; sequence: number; busy: boolean; pending: Pending | null; refreshRequired: boolean; notice: Notice; failure: CommandFailure | null; error: "nameRequired" | "nameInvalid" | "folderInvalid" | "languagesRequired" | "languagesInvalid" | null }
export interface ProjectMetadataSheetProps {
  project: ProjectView; visible: boolean; disabled: boolean; current: () => boolean; onClose: () => void; onChanged: () => Promise<boolean>;
  lifecycle: ProjectLifecycle; onReveal: () => void;
}
export default function ProjectMetadataSheet(props: ProjectMetadataSheetProps) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "projectMetadata" });
  const [state, setState] = useState<State>(() => ({ basis: props.project, name: props.project.metadata.displayName, renameFolder: false,
    languages: props.project.metadata.targetLocales.join(", "), sequence: 0, busy: false, pending: null, refreshRequired: false, notice: null, failure: null, error: null }));
  const stateRef = useRef(state), latest = useRef(props), alive = useRef(true), composing = useRef(false), leaveFocus = useRef<HTMLHeadingElement>(null);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [composingInput, setComposingInput] = useState(false);
  const leave = useRef<{ proof: () => boolean; current: () => boolean; resolve: (allowed: boolean) => void } | null>(null);
  function update(change: (before: State) => State) { const next = change(stateRef.current); stateRef.current = next; setState(next); }
  const live = () => alive.current && latest.current.project.sessionToken === stateRef.current.basis.sessionToken
    && latest.current.project.metadata.projectId === stateRef.current.basis.metadata.projectId;
  const blocked = () => stateRef.current.busy || !!stateRef.current.pending || stateRef.current.refreshRequired;
  const dirty = () => { const value = stateRef.current; return value.name !== value.basis.metadata.displayName || value.renameFolder || !sameTags(locales(value.languages), value.basis.metadata.targetLocales); };
  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => { if (leaving !== null) leaveFocus.current?.focus(); }, [leaving]);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; leave.current?.resolve(false); leave.current = null; }; }, []);
  useLayoutEffect(() => {
    if (!live() || BigInt(props.project.metadata.metadataRevision) < BigInt(stateRef.current.basis.metadata.metadataRevision)) return;
    update(before => ({ ...before, basis: props.project,
      name: !before.pending && before.name === before.basis.metadata.displayName ? props.project.metadata.displayName : before.name,
      languages: !before.pending && before.languages === before.basis.metadata.targetLocales.join(", ") ? props.project.metadata.targetLocales.join(", ") : before.languages }));
  }, [props.project]);
  useLayoutEffect(() => {
    const participant: LifecycleParticipant = { id: "project-metadata", area: "overview", scope: { kind: "project", projectId: props.project.metadata.projectId, sessionToken: props.project.sessionToken },
      inspect: intent => ({ status: blocked() ? "blocked" : ["create-project", "open-project", "close-project", "close-window", "restore"].includes(intent.kind) && dirty() ? "dirty" : "ready",
        revision: JSON.stringify([stateRef.current.sequence, stateRef.current.basis.metadata.metadataRevision, stateRef.current.busy, stateRef.current.pending, stateRef.current.refreshRequired]) }),
      reveal: () => latest.current.onReveal(), prepareLeave: async (_intent, proof, current) => {
        if (!live() || blocked()) return false;
        latest.current.onReveal(); setLeaving(stateRef.current.sequence);
        return new Promise(resolve => { leave.current?.resolve(false); leave.current = { proof, current, resolve }; });
      } };
    return props.lifecycle.register(participant);
  }, [props.lifecycle, props.project.metadata.projectId, props.project.sessionToken]);
  function edit(change: Partial<Pick<State, "name" | "renameFolder" | "languages">>) {
    if (!live() || latest.current.disabled) return;
    update(before => ({ ...before, ...change, sequence: before.sequence + 1, error: null }));
  }
  async function refresh() {
    if (!live() || stateRef.current.busy || stateRef.current.pending || !latest.current.current()) return;
    update(before => ({ ...before, busy: true }));
    const success = await latest.current.onChanged().catch(() => false);
    if (live()) update(before => ({ ...before, busy: false, refreshRequired: !success, notice: success ? "stale" : "refreshFailed" }));
  }
  async function settle(view: ProjectView, original: Pending, result: "committed" | "previous") {
    if (!live() || stateRef.current.pending !== original) return;
    update(before => ({ ...before, basis: BigInt(before.basis.metadata.metadataRevision) > BigInt(view.metadata.metadataRevision) ? before.basis : view,
      pending: null, refreshRequired: true, notice: result === "committed" ? "saved" : "previous", failure: null,
      ...(result === "committed" && original.kind === "name" && before.name === original.raw && before.renameFolder === original.renameFolder ? { name: view.metadata.displayName, renameFolder: false } : {}),
      ...(result === "committed" && original.kind === "languages" && before.languages === original.raw ? { languages: view.metadata.targetLocales.join(", ") } : {}) }));
    const success = await latest.current.onChanged().catch(() => false);
    if (live()) update(before => ({ ...before, busy: false, refreshRequired: !success, notice: success ? before.notice : "refreshFailed" }));
  }
  async function check(original = stateRef.current.pending) {
    if (!original || !live() || stateRef.current.busy || !latest.current.current()) return;
    update(before => ({ ...before, busy: true, notice: "unknown" }));
    try {
      const view = await projectCommands.read({ sessionToken: original.previous.sessionToken, expectedRevision: original.request.expectedRevision });
      if (!live() || stateRef.current.pending !== original) return;
      const result = outcome(view, original);
      if (result === "unknown") update(before => ({ ...before, busy: false, notice: "unknown" }));
      else await settle(view, original, result);
    } catch (error) { if (live() && stateRef.current.pending === original) update(before => ({ ...before, busy: false, notice: "readFailed", failure: commandFailure(error) })); }
  }
  async function save(kind: Pending["kind"]) {
    if (!live() || blocked() || latest.current.disabled || !latest.current.current() || composing.current) return;
    const value = stateRef.current;
    const error = kind === "name" ? !value.name.trim() ? "nameRequired" : value.renameFolder && !isSafeChildDirectoryName(value.name) ? "folderInvalid" : null
      : locales(value.languages).length === 0 ? "languagesRequired" : null;
    if (error) { update(before => ({ ...before, error })); return; }
    const previous = structuredClone(value.basis), common = { previous, renameFolder: value.renameFolder };
    const original: Pending = kind === "name" ? { ...common, kind, raw: value.name, request: { sessionToken: previous.sessionToken, expectedRevision: previous.metadata.metadataRevision,
      displayName: value.name, ...(value.renameFolder ? { directoryName: value.name } : {}) } }
      : { ...common, kind, raw: value.languages, request: { sessionToken: previous.sessionToken, expectedRevision: previous.metadata.metadataRevision, targetLocales: locales(value.languages) } };
    update(before => ({ ...before, busy: true, pending: original, failure: null, notice: null, error: null }));
    try {
      const result = await (original.kind === "name" ? projectCommands.rename(original.request) : projectCommands.setTargetLocales(original.request));
      if (!live() || stateRef.current.pending !== original) return;
      if (result.sessionToken !== previous.sessionToken || result.metadata.projectId !== previous.metadata.projectId) throw new Error("Metadata acknowledgement identity changed");
      await settle({ ...previous, locator: result.locator, metadata: result.metadata, reconciliationState: "settled" }, original, "committed");
    } catch (error) {
      if (!live() || stateRef.current.pending !== original) return;
      if (hasUnknownOutcome(error)) {
        update(before => ({ ...before, busy: false, notice: "unknown", failure: commandFailure(error) }));
        await check(original);
      } else {
        const stale = isCommandError(error) && error.code === "stale-revision";
        update(before => ({ ...before, busy: false, pending: null, refreshRequired: stale, notice: stale ? "stale" : "failed", failure: commandFailure(error),
          error: isCommandError(error) && error.code === "invalid-input" ? original.kind === "languages" ? "languagesInvalid" : error.field === "directoryName" ? "folderInvalid" : "nameInvalid" : null }));
        if (stale) await refresh();
      }
    }
  }
  function requestClose() {
    if (composing.current || blocked()) return;
    if (dirty()) setLeaving(stateRef.current.sequence); else latest.current.onClose();
  }
  function finishLeave(discard: boolean) {
    if (blocked() || composing.current) return;
    const original = leave.current;
    const accepted = discard && leaving === stateRef.current.sequence && (!original || original.proof() && original.current());
    if (accepted) update(before => ({ ...before, name: before.basis.metadata.displayName, renameFolder: false, languages: before.basis.metadata.targetLocales.join(", "), sequence: before.sequence + 1, error: null }));
    setLeaving(null); leave.current = null; original?.resolve(accepted);
    if (accepted && !original) latest.current.onClose();
  }
  const unavailable = props.disabled || !live(), locked = unavailable || blocked();
  const removed = state.basis.metadata.targetLocales.filter(tag => !locales(state.languages).some(value => value.toLowerCase() === tag.toLowerCase()));
  return <Sheet open={props.visible} onOpenChange={open => { if (!open) requestClose(); }} title={t("title")} description={t("help")} closeLabel={t("close")} closeDisabled={blocked() || composingInput}
    className={styles.sheet} onEscapeKeyDown={event => { if (composing.current || blocked()) event.preventDefault(); }}>
    <div className={styles.content} onCompositionStartCapture={() => { composing.current = true; setComposingInput(true); }} onCompositionEndCapture={() => { composing.current = false; setComposingInput(false); }}
      onKeyDownCapture={event => { if ((event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) && ["Enter", "Escape"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); } }}>
      <section className={styles.section}>
        <Field label={t("name")} error={state.error && ["nameRequired", "nameInvalid", "folderInvalid"].includes(state.error) ? t(state.error) : undefined}><TextInput value={state.name} disabled={unavailable} onChange={event => edit({ name: event.target.value })}/></Field>
        <Field label={t("renameFolder")} description={t("folderHelp")} className={styles.checkbox}><TextInput type="checkbox" checked={state.renameFolder} disabled={unavailable} onChange={event => edit({ renameFolder: event.target.checked })}/></Field>
        <div className={styles.actions}><Button variant="secondary" disabled={locked || state.name === state.basis.metadata.displayName && !state.renameFolder} onClick={() => { void save("name"); }}>{t("saveName")}</Button></div>
      </section>
      <section className={styles.section}>
        <p>{t("currentLanguages", { languages: state.basis.metadata.targetLocales.map(tag => `${languageName(tag, i18n.resolvedLanguage ?? "en-US")} (${tag})`).join(", ") })}</p>
        <Field label={t("languages")} description={t("languagesHelp")} error={state.error && ["languagesRequired", "languagesInvalid"].includes(state.error) ? t(state.error) : undefined}><TextArea rows={4} value={state.languages} disabled={unavailable} onChange={event => edit({ languages: event.target.value })}/></Field>
        {removed.length ? <Banner tone="warning">{t("removed", { languages: removed.map(tag => languageName(tag, i18n.resolvedLanguage ?? "en-US")).join(", ") })}</Banner> : null}
        <div className={styles.actions}><Button variant="secondary" disabled={locked || sameTags(locales(state.languages), state.basis.metadata.targetLocales)} onClick={() => { void save("languages"); }}>{t("saveLanguages")}</Button></div>
      </section>
      <div>
        {state.busy ? <p role="status">{t(state.pending ? state.notice ? "checking" : "saving" : "refreshing")}</p> : null}
        {state.notice ? <Banner tone={state.notice === "saved" ? "success" : "warning"} role="status"><p>{t(state.notice)}</p><CommandFailureDetails failure={state.failure}/></Banner> : null}
        {state.pending ? <Button disabled={state.busy || unavailable} onClick={() => { void check(); }}>{t("check")}</Button> : null}
        {state.refreshRequired && !state.pending ? <Button disabled={state.busy || unavailable} onClick={() => { void refresh(); }}>{t("refresh")}</Button> : null}
      </div>
      {leaving !== null ? <Banner tone="warning" role="alert"><h3 ref={leaveFocus} tabIndex={-1}>{t("leaveTitle")}</h3><p>{t(leaving === state.sequence ? "leaveHelp" : "leaveChanged")}</p><div className={styles.actions}>
        <Button onClick={() => finishLeave(false)}>{t("stay")}</Button><Button variant="danger" disabled={leaving !== state.sequence || blocked()} onClick={() => finishLeave(true)}>{t("discard")}</Button>
      </div></Banner> : null}
    </div>
  </Sheet>;
}
