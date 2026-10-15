import { useWorkProtectionSession, type WorkProtectionSession } from "./WorkProtectionSession";
import { useSessionAlive } from "./SessionReadProvider";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { sourceCommands } from "./sourceCommands";
import { translationCommands, confirmTranslationSelection, type TranslationRevision, type TranslationSelectRequest, type TranslationSaveReceipt, type TranslationSaveRequest, type TranslationSelection } from "./translationCommands";

interface DraftIdentity { unitId: string; locale: string; sourceRevisionId: string; key: string; sourceText: string }
interface DraftPending { request: TranslationSaveRequest; submittedSeq: number }
interface SelectionPending { request: TranslationSelectRequest; submittedSeq: number; text: string; receiptChecked: boolean }
export interface TranslationDraft extends DraftIdentity {
  baseSelectionId: string | null;
  baseRevisionId: string | null;
  baseText: string | null;
  text: string;
  editSeq: number;
  pending: DraftPending | null;
  pendingSelection: SelectionPending | null;
  selecting: boolean;
  saving: boolean;
  outcomeUnknown: boolean;
  receiptCheck: "found" | "missing" | null;
  receiptKind: "save" | "selection" | null;
  newerDraftSaved: boolean;
  failure: CommandFailure | null;
}

interface SaveResult { saved: boolean; savedCurrent: boolean; submittedSeq: number; submittedText: string }
interface DraftSession {
  protection: WorkProtectionSession;
  draft: TranslationDraft | null;
  current: () => TranslationDraft | null;
  begin: (identity: DraftIdentity, selection: TranslationSelection | null, baseText: string | null, suggestedText?: string) => boolean;
  edit: (text: string) => void;
  revert: () => void;
  clear: () => void;
  save: () => Promise<SaveResult>;
  checkSavedAction: () => Promise<SaveResult>;
  selected: (selection: TranslationSelection | null, text: string | null, expectedSeq: number) => void;
  unchanged: (seq: number, text: string) => boolean;
  mutationReserved: boolean;
  reserveMutation: () => symbol | null;
  releaseMutation: (token: symbol) => void;
  selectRevision: (revision: TranslationRevision, proof?: () => boolean, dispose?: () => void) => Promise<boolean>;
  checkSelection: () => Promise<boolean>;
  retrySelection: () => Promise<boolean>;
}

const DraftContext = createContext<DraftSession | null>(null);
export function useTranslationDraftSession() {
  const session = useContext(DraftContext);
  if (!session) throw new Error("Translation drafts require a project session owner");
  return session;
}

export function TranslationDraftSession({ project, children }: { project: ProjectView; children: ReactNode }) {
  const [draft, setDraft] = useState<TranslationDraft | null>(null);
  const currentDraft = useRef<TranslationDraft | null>(null);
  const projectRef = useRef(project);
  const mounted = useSessionAlive();
  const inFlight = useRef(false);
  const mutation = useRef<symbol | null>(null);
  const selectionReservation = useRef<symbol | null>(null);
  const selectionVersion = useRef(0);
  const selectionReadCleanup = useRef<(() => void) | null>(null);
  const [mutationReserved, setMutationReserved] = useState(false);
  useLayoutEffect(() => {
    const previous = projectRef.current, locale = currentDraft.current?.locale;
    if (selectionReservation.current && (previous.metadata.sourceLocale !== project.metadata.sourceLocale
      || (locale && previous.metadata.targetLocales.includes(locale) !== project.metadata.targetLocales.includes(locale)))) selectionVersion.current++;
    projectRef.current = project;
  }, [project]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mutation.current = null; selectionReservation.current = null; }; }, []);
  useLayoutEffect(() => () => { selectionReadCleanup.current?.(); selectionReadCleanup.current = null; }, []);

  const protection = useWorkProtectionSession(project, { reserve: reserveMutation, release: releaseMutation });

  function reserveMutation() {
    if (!mounted.current || protection.blocked() || mutation.current || inFlight.current || currentDraft.current?.pending || currentDraft.current?.pendingSelection || currentDraft.current?.saving) return null;
    const token = Symbol("translation mutation"); mutation.current = token; setMutationReserved(true); return token;
  }
  function releaseMutation(token: symbol) {
    if (mutation.current !== token) return;
    mutation.current = null;
    if (mounted.current) setMutationReserved(false);
  }

  function update(change: (current: TranslationDraft | null) => TranslationDraft | null) {
    if (!mounted.current) return currentDraft.current;
    const next = change(currentDraft.current);
    currentDraft.current = next;
    if (mounted.current) setDraft(next);
    return next;
  }
  function current() { return currentDraft.current; }
  function begin(identity: DraftIdentity, selection: TranslationSelection | null, baseText: string | null, suggestedText?: string) {
    const existing = currentDraft.current;
    if (!mounted.current || protection.blocked() || mutation.current || inFlight.current || existing?.selecting || existing?.pending || existing?.pendingSelection || (existing && (existing.text !== (existing.baseText ?? "") || existing.newerDraftSaved))) return false;
    update(() => ({ ...identity, baseSelectionId: selection?.eventId ?? null, baseRevisionId: selection?.revisionId ?? null,
      baseText, text: suggestedText ?? baseText ?? "", editSeq: 0, pending: null, pendingSelection: null, selecting: false, saving: false,
      outcomeUnknown: false, receiptCheck: null, receiptKind: null, newerDraftSaved: false, failure: null }));
    return true;
  }
  function edit(text: string) {
    update(value => value ? { ...value, text, editSeq: value.editSeq + 1, newerDraftSaved: false } : value);
  }
  function revert() {
    update(value => value ? { ...value, text: value.baseText ?? "", editSeq: value.editSeq + 1, newerDraftSaved: false } : value);
  }
  function clear() { if (!protection.blocked() && !mutation.current && !inFlight.current && !currentDraft.current?.selecting && !currentDraft.current?.pending && !currentDraft.current?.pendingSelection) update(() => null); }
  function selected(selection: TranslationSelection | null, text: string | null, expectedSeq: number) {
    update(value => value && !value.pending && !value.pendingSelection && !value.saving ? { ...value,
      baseSelectionId: selection?.eventId ?? null, baseRevisionId: selection?.revisionId ?? null,
      baseText: text, text: value.editSeq === expectedSeq ? text ?? "" : value.text,
      editSeq: value.editSeq + 1, newerDraftSaved: false, receiptCheck: null, failure: null } : value);
  }
  function unchanged(seq: number, text: string) {
    const value = currentDraft.current;
    return !!value && value.editSeq === seq && value.text === text;
  }
  function confirm(request: TranslationSaveRequest, submittedSeq: number, receipt: TranslationSaveReceipt): SaveResult {
    const before = currentDraft.current;
    if (!mounted.current || !before || before.pending?.request.actionId !== request.actionId
      || before.unitId !== request.unitId || before.locale !== request.locale || before.sourceRevisionId !== request.sourceRevisionId) {
      return { saved: false, savedCurrent: false, submittedSeq, submittedText: request.text };
    }
    const savedCurrent = before.editSeq === submittedSeq && before.text === request.text;
    update(value => value ? { ...value, baseSelectionId: receipt.selection.eventId,
      baseRevisionId: receipt.selection.revisionId, baseText: receipt.revision.text,
      text: savedCurrent ? receipt.revision.text : value.text, pending: null, saving: false,
      outcomeUnknown: false, newerDraftSaved: !savedCurrent, failure: null } : value);
    return { saved: true, savedCurrent, submittedSeq, submittedText: request.text };
  }
  async function save(): Promise<SaveResult> {
    const start = currentDraft.current;
    const empty = { saved: false, savedCurrent: false, submittedSeq: start?.editSeq ?? 0, submittedText: start?.text ?? "" };
    if (!mounted.current || protection.blocked() || !start || inFlight.current || mutation.current || start.pendingSelection || !projectRef.current.metadata.targetLocales.includes(start.locale)) return empty;
    inFlight.current = true;
    const submittedSeq = start.pending?.submittedSeq ?? start.editSeq;
    const submittedText = start.pending?.request.text ?? start.text;
    update(value => value ? { ...value, saving: true, failure: null, receiptCheck: null, receiptKind: "save" } : value);
    try {
      const context = executionContext(projectRef.current);
      const request = start.pending?.request ?? { ...context, actionId: await executionCommands.identity(context),
        unitId: start.unitId, locale: start.locale, sourceRevisionId: start.sourceRevisionId,
        expectedSelectionId: start.baseSelectionId, text: submittedText };
      if (!mounted.current) return empty;
      if (!projectRef.current.metadata.targetLocales.includes(request.locale)) {
        update(value => value ? { ...value, saving: false } : value);
        return empty;
      }
      update(value => value ? { ...value, pending: { request, submittedSeq } } : value);
      const receipt = await translationCommands.save(request);
      return confirm(request, submittedSeq, receipt);
    } catch (error) {
      if (mounted.current) update(value => value ? { ...value, saving: false,
        pending: hasUnknownOutcome(error) ? value.pending : null,
        outcomeUnknown: hasUnknownOutcome(error), failure: commandFailure(error) } : value);
      return empty;
    } finally { inFlight.current = false; }
  }
  async function checkSavedAction(): Promise<SaveResult> {
    const pending = currentDraft.current?.pending;
    const empty = { saved: false, savedCurrent: false, submittedSeq: pending?.submittedSeq ?? 0,
      submittedText: pending?.request.text ?? "" };
    if (!mounted.current || !pending || inFlight.current) return empty;
    inFlight.current = true;
    update(value => value ? { ...value, saving: true, failure: null } : value);
    const request = pending.request;
    try {
      const selection = await translationCommands.action({ ...executionContext(projectRef.current),
        actionId: request.actionId, unitId: request.unitId, locale: request.locale });
      if (!mounted.current) return empty;
      if (!selection) { update(value => value ? { ...value, receiptCheck: "missing" } : value); return empty; }
      if (selection.actionId !== request.actionId || selection.unitId !== request.unitId || selection.locale !== request.locale) {
        update(value => value ? { ...value, failure: "invalid-save-receipt" } : value); return empty;
      }
      const receipt = await translationCommands.save(request);
      if (!mounted.current) return empty;
      if (receipt.selection.eventId !== selection.eventId || receipt.selection.revisionId !== selection.revisionId) {
        update(value => value ? { ...value, failure: "invalid-save-receipt" } : value); return empty;
      }
      const result = confirm(request, pending.submittedSeq, receipt);
      if (result.saved) update(value => value ? { ...value, receiptCheck: "found" } : value);
      return result;
    } catch (error) {
      if (mounted.current) update(value => value ? { ...value, failure: commandFailure(error), outcomeUnknown: true } : value);
      return empty;
    } finally {
      inFlight.current = false;
      if (mounted.current) update(value => value ? { ...value, saving: false } : value);
    }
  }

  function confirmSelection(pending: SelectionPending, selection: TranslationSelection) {
    const before = currentDraft.current;
    if (!mounted.current || before?.pendingSelection !== pending || before.unitId !== pending.request.unitId
      || before.locale !== pending.request.locale || before.sourceRevisionId !== pending.request.sourceRevisionId) return false;
    const sameInput = before.editSeq === pending.submittedSeq;
    update(value => value ? { ...value, baseSelectionId: selection.eventId, baseRevisionId: selection.revisionId,
      baseText: pending.text, text: sameInput ? pending.text : value.text, pendingSelection: null, selecting: false,
      newerDraftSaved: !sameInput, outcomeUnknown: false, receiptCheck: "found", failure: null } : value);
    const token = selectionReservation.current;
    selectionReservation.current = null;
    if (token) releaseMutation(token);
    return true;
  }
  async function dispatchSelection(pending: SelectionPending, recovering = false) {
    if (!mounted.current) return false;
    update(value => value ? { ...value, pendingSelection: { ...pending, receiptChecked: false }, selecting: true, failure: null, receiptCheck: null, receiptKind: "selection" } : value);
    const original = currentDraft.current?.pendingSelection;
    if (!original) return false;
    try {
      const selection = await translationCommands.select(original.request);
      return confirmSelection(original, selection);
    } catch (error) {
      if (mounted.current) update(value => value?.pendingSelection === original ? { ...value, selecting: false,
        pendingSelection: recovering || hasUnknownOutcome(error) ? original : null, outcomeUnknown: recovering || hasUnknownOutcome(error), failure: commandFailure(error) } : value);
      if (!recovering && !hasUnknownOutcome(error)) {
        const token = selectionReservation.current; selectionReservation.current = null; if (token) releaseMutation(token);
      }
      return false;
    }
  }
  async function selectRevision(revision: TranslationRevision, proof: () => boolean = () => true, dispose?: () => void) {
    const before = currentDraft.current;
    if (!before || !proof() || before.text !== (before.baseText ?? "") || before.newerDraftSaved
      || !projectRef.current.metadata.targetLocales.includes(before.locale) || revision.unitId !== before.unitId || revision.locale !== before.locale) { dispose?.(); return false; }
    const token = reserveMutation(); if (!token) { dispose?.(); return false; }
    let disposed = false;
    const cleanup = () => { if (!disposed) { disposed = true; dispose?.(); } };
    selectionReadCleanup.current = cleanup;
    selectionReservation.current = token;
    const meta = projectRef.current.metadata.sourceLocale;
    const ticket = selectionVersion.current, selectedRevisionId = revision.revisionId, selectedText = revision.text;
    const current = () => mounted.current && proof() && ticket === selectionVersion.current && currentDraft.current?.unitId === before.unitId
      && currentDraft.current?.locale === before.locale && currentDraft.current?.sourceRevisionId === before.sourceRevisionId
      && currentDraft.current?.baseSelectionId === before.baseSelectionId && currentDraft.current?.editSeq === before.editSeq
      && meta === projectRef.current.metadata.sourceLocale && projectRef.current.metadata.targetLocales.includes(before.locale);
    update(value => value ? { ...value, selecting: true, failure: null } : value);
    try {
      const context = executionContext(projectRef.current);
      const scope = await sourceCommands.scope(context);
      if (!current()) return false;
      const actionId = await executionCommands.identity(context);
      if (!current()) return false;
      const latest = await sourceCommands.scope(context);
      if (!current() || latest.currentSnapshot !== scope.currentSnapshot || latest.revision !== scope.revision) return false;
      return await dispatchSelection({ request: { ...context, actionId, unitId: before.unitId, locale: before.locale,
        sourceRevisionId: before.sourceRevisionId, expectedSelectionId: before.baseSelectionId, revisionId: selectedRevisionId },
        submittedSeq: before.editSeq, text: selectedText, receiptChecked: false });
    } catch (error) { if (mounted.current) update(value => value ? { ...value, failure: commandFailure(error) } : value); return false; }
    finally {
      cleanup(); if (selectionReadCleanup.current === cleanup) selectionReadCleanup.current = null;
      if (!currentDraft.current?.pendingSelection) {
        selectionReservation.current = null; releaseMutation(token);
        if (mounted.current) update(value => value ? { ...value, selecting: false } : value);
      }
    }
  }
  async function checkSelection() {
    const pending = currentDraft.current?.pendingSelection;
    if (!pending || currentDraft.current?.selecting || !mounted.current) return false;
    update(value => value ? { ...value, selecting: true, failure: null, receiptCheck: null,
      pendingSelection: { ...pending, receiptChecked: false } } : value);
    const original = currentDraft.current!.pendingSelection!;
    try {
      const selection = await translationCommands.action({ projectId: original.request.projectId, sessionToken: original.request.sessionToken,
        actionId: original.request.actionId, unitId: original.request.unitId, locale: original.request.locale });
      if (!mounted.current || currentDraft.current?.pendingSelection !== original) return false;
      if (!selection) {
        update(value => value ? { ...value, pendingSelection: { ...original, receiptChecked: true }, receiptCheck: "missing" } : value); return false;
      }
      confirmTranslationSelection(original.request, selection);
      // Replay only the original request: Core checks its digest before current eligibility.
      const confirmed = await translationCommands.select(original.request);
      if (confirmed.eventId !== selection.eventId || confirmed.sequence !== selection.sequence) throw new Error("Invalid selection acknowledgement");
      return confirmSelection(original, confirmed);
    } catch (error) { if (mounted.current) update(value => value ? { ...value, failure: commandFailure(error), outcomeUnknown: true } : value); return false; }
    finally { if (mounted.current) update(value => value ? { ...value, selecting: false } : value); }
  }
  async function retrySelection() {
    const pending = currentDraft.current?.pendingSelection;
    if (!pending?.receiptChecked || currentDraft.current?.selecting || !mounted.current) return false;
    return dispatchSelection(pending, true);
  }

  return <DraftContext.Provider value={{ protection, draft, current, begin, edit, revert, clear, save, checkSavedAction, selected, unchanged,
    mutationReserved, reserveMutation, releaseMutation, selectRevision, checkSelection, retrySelection }}>
    {children}
  </DraftContext.Provider>;
}
