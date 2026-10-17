import { useWorkProtectionSession, type WorkProtectionSession } from "./WorkProtectionSession";
import { useCandidateDecisionSession } from "./CandidateDecisionSession";
import { useSessionAlive } from "./SessionReadProvider";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { sourceCommands } from "./sourceCommands";
import { translationCommands, type TranslationRevision, type TranslationSelectRequest, type TranslationSaveReceipt, type TranslationSaveRequest, type TranslationSelection } from "./translationCommands";

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
  checkingAction: "save" | "selection" | null;
  outcomeUnknown: boolean;
  receiptCheck: "found" | "missing" | null;
  receiptKind: "save" | "selection" | null;
  newerDraftSaved: boolean;
  failure: CommandFailure | null;
}

interface SaveResult { saved: boolean; savedCurrent: boolean; submittedSeq: number; submittedText: string }
interface DraftSession {
  candidates: ReturnType<typeof useCandidateDecisionSession>;
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
  const candidates = useCandidateDecisionSession(project, { current, reserve: reserveMutation, release: releaseMutation });

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
      baseText, text: suggestedText ?? baseText ?? "", editSeq: 0, pending: null, pendingSelection: null, selecting: false, saving: false, checkingAction: null,
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
  function confirm(pending: DraftPending, receipt: TranslationSaveReceipt): SaveResult {
    const { request, submittedSeq } = pending;
    const before = currentDraft.current;
    if (!mounted.current || !before || before.pending !== pending
      || before.unitId !== request.unitId || before.locale !== request.locale || before.sourceRevisionId !== request.sourceRevisionId) {
      return { saved: false, savedCurrent: false, submittedSeq, submittedText: request.text };
    }
    const savedCurrent = before.editSeq === submittedSeq && before.text === request.text;
    update(value => value ? { ...value, baseSelectionId: receipt.selection.eventId,
      baseRevisionId: receipt.selection.revisionId, baseText: receipt.revision.text,
      text: savedCurrent ? receipt.revision.text : value.text, pending: null, saving: false, checkingAction: null,
      outcomeUnknown: false, newerDraftSaved: !savedCurrent, failure: null } : value);
    return { saved: true, savedCurrent, submittedSeq, submittedText: request.text };
  }
  function unsaved(pending: DraftPending | null): SaveResult {
    return { saved: false, savedCurrent: false, submittedSeq: pending?.submittedSeq ?? 0, submittedText: pending?.request.text ?? "" };
  }
  async function lookupSavedAction(pending: DraftPending): Promise<SaveResult> {
    const empty = unsaved(pending);
    if (!mounted.current || currentDraft.current?.pending !== pending) return empty;
    update(value => value?.pending === pending ? { ...value, checkingAction: "save", receiptCheck: null, failure: null } : value);
    try {
      const receipt = await translationCommands.saveAction(pending.request);
      if (!mounted.current || currentDraft.current?.pending !== pending) return empty;
      if (receipt === null) {
        update(value => value?.pending === pending ? { ...value, receiptCheck: "missing", outcomeUnknown: true } : value); return empty;
      }
      const result = confirm(pending, receipt);
      if (result.saved) update(value => value ? { ...value, receiptCheck: "found" } : value);
      return result;
    } finally {
      if (mounted.current) update(value => value?.pending === pending ? { ...value, checkingAction: null } : value);
    }
  }
  async function dispatchSave(pending: DraftPending, recovering: boolean): Promise<SaveResult> {
    const empty = unsaved(pending);
    let writeFailure: CommandFailure | null = null;
    try { return confirm(pending, await translationCommands.save(pending.request)); }
    catch (error) {
      if (!mounted.current || currentDraft.current?.pending !== pending) return empty;
      const unknown = hasUnknownOutcome(error); writeFailure = commandFailure(error);
      update(value => value?.pending === pending ? { ...value, pending: recovering || unknown ? pending : null,
        outcomeUnknown: recovering || unknown, failure: unknown ? null : writeFailure } : value);
      if (!unknown) return empty;
    }
    // A failed read cannot enter the write catch or dispatch another mutation.
    try {
      const result = await lookupSavedAction(pending);
      if (mounted.current) update(value => value?.pending === pending ? { ...value, failure: writeFailure } : value);
      return result;
    } catch (error) {
      if (mounted.current) update(value => value?.pending === pending ? { ...value, failure: commandFailure(error), outcomeUnknown: true } : value);
      return empty;
    }
  }
  async function save(): Promise<SaveResult> {
    const start = currentDraft.current;
    const empty = { saved: false, savedCurrent: false, submittedSeq: start?.editSeq ?? 0, submittedText: start?.text ?? "" };
    if (!mounted.current || protection.blocked() || !start || inFlight.current || mutation.current || start.pendingSelection
      || start.pending && start.receiptCheck !== "missing" || !projectRef.current.metadata.targetLocales.includes(start.locale)) return empty;
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
      const pending = start.pending ?? { request, submittedSeq };
      update(value => value ? { ...value, pending } : value);
      return await dispatchSave(pending, start.pending !== null);
    } catch (error) {
      if (mounted.current) update(value => value ? { ...value, failure: commandFailure(error) } : value);
      return empty;
    } finally {
      inFlight.current = false;
      if (mounted.current) update(value => value ? { ...value, saving: false } : value);
    }
  }
  async function checkSavedAction(): Promise<SaveResult> {
    const pending = currentDraft.current?.pending, previousFailure = currentDraft.current?.failure ?? null;
    const empty = unsaved(pending ?? null);
    if (!mounted.current || !pending || inFlight.current) return empty;
    inFlight.current = true;
    update(value => value?.pending === pending ? { ...value, saving: true, failure: null } : value);
    try {
      const result = await lookupSavedAction(pending);
      if (mounted.current) update(value => value?.pending === pending ? { ...value, failure: previousFailure } : value);
      return result;
    }
    catch (error) {
      if (mounted.current) update(value => value?.pending === pending ? { ...value, failure: commandFailure(error), outcomeUnknown: true } : value);
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
      baseText: pending.text, text: sameInput ? pending.text : value.text, pendingSelection: null, selecting: false, checkingAction: null,
      newerDraftSaved: !sameInput, outcomeUnknown: false, receiptCheck: "found", failure: null } : value);
    const token = selectionReservation.current;
    selectionReservation.current = null;
    if (token) releaseMutation(token);
    return true;
  }
  async function lookupSelection(original: SelectionPending) {
    if (!mounted.current || currentDraft.current?.pendingSelection !== original) return false;
    update(value => value?.pendingSelection === original ? { ...value, checkingAction: "selection", failure: null, receiptCheck: null } : value);
    try {
      const selection = await translationCommands.selectionAction(original.request);
      if (!mounted.current || currentDraft.current?.pendingSelection !== original) return false;
      if (selection === null) {
        update(value => value?.pendingSelection === original ? { ...value, pendingSelection: { ...original, receiptChecked: true }, receiptCheck: "missing", outcomeUnknown: true } : value);
        return false;
      }
      return confirmSelection(original, selection);
    } finally {
      if (mounted.current) update(value => value?.pendingSelection?.request === original.request ? { ...value, checkingAction: null, selecting: false } : value);
    }
  }
  async function dispatchSelection(pending: SelectionPending, recovering = false) {
    if (!mounted.current) return false;
    update(value => value ? { ...value, pendingSelection: { ...pending, receiptChecked: false }, selecting: true, failure: null, receiptCheck: null, receiptKind: "selection" } : value);
    const original = currentDraft.current?.pendingSelection;
    if (!original) return false;
    let writeFailure: CommandFailure | null = null;
    try {
      const selection = await translationCommands.select(original.request);
      return confirmSelection(original, selection);
    } catch (error) {
      if (!mounted.current || currentDraft.current?.pendingSelection !== original) return false;
      const unknown = hasUnknownOutcome(error); writeFailure = commandFailure(error);
      if (mounted.current) update(value => value?.pendingSelection === original ? { ...value, selecting: unknown,
        pendingSelection: recovering || unknown ? original : null, outcomeUnknown: recovering || unknown, failure: unknown ? null : writeFailure } : value);
      if (!recovering && !unknown) {
        const token = selectionReservation.current; selectionReservation.current = null; if (token) releaseMutation(token);
      }
      if (!unknown) return false;
    }
    try {
      const confirmed = await lookupSelection(original);
      if (mounted.current) update(value => value?.pendingSelection?.request === original.request ? { ...value, failure: writeFailure } : value);
      return confirmed;
    } catch (error) {
      if (mounted.current) update(value => value?.pendingSelection?.request === original.request ? { ...value, failure: commandFailure(error), outcomeUnknown: true } : value);
      return false;
    }
  }
  async function selectRevision(revision: TranslationRevision, proof: () => boolean = () => true, dispose?: () => void) {
    const before = currentDraft.current;
    if (!before || !proof() || revision.candidateDecision?.request.disposition === "rejected" || before.text !== (before.baseText ?? "") || before.newerDraftSaved
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
    const pending = currentDraft.current?.pendingSelection, previousFailure = currentDraft.current?.failure ?? null;
    if (!pending || currentDraft.current?.selecting || !mounted.current) return false;
    update(value => value ? { ...value, selecting: true, failure: null, receiptCheck: null,
      pendingSelection: { ...pending, receiptChecked: false } } : value);
    const original = currentDraft.current!.pendingSelection!;
    try {
      const confirmed = await lookupSelection(original);
      if (mounted.current) update(value => value?.pendingSelection?.request === original.request ? { ...value, failure: previousFailure } : value);
      return confirmed;
    }
    catch (error) { if (mounted.current) update(value => value?.pendingSelection === original ? { ...value, failure: commandFailure(error), outcomeUnknown: true } : value); return false; }
    finally { if (mounted.current) update(value => value ? { ...value, selecting: false } : value); }
  }
  async function retrySelection() {
    const pending = currentDraft.current?.pendingSelection;
    if (!pending?.receiptChecked || currentDraft.current?.selecting || !mounted.current) return false;
    return dispatchSelection(pending, true);
  }

  return <DraftContext.Provider value={{ candidates, protection, draft, current, begin, edit, revert, clear, save, checkSavedAction, selected, unchanged,
    mutationReserved, reserveMutation, releaseMutation, selectRevision, checkSelection, retrySelection }}>
    {children}
  </DraftContext.Provider>;
}
