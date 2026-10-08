import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext } from "./executionCommands";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { translationCommands, type TranslationSaveReceipt, type TranslationSaveRequest, type TranslationSelection } from "./translationCommands";

interface DraftIdentity { unitId: string; locale: string; sourceRevisionId: string; key: string; sourceText: string }
interface DraftPending { request: TranslationSaveRequest; submittedSeq: number }
export interface TranslationDraft extends DraftIdentity {
  baseSelectionId: string | null;
  baseRevisionId: string | null;
  baseText: string | null;
  text: string;
  editSeq: number;
  pending: DraftPending | null;
  saving: boolean;
  outcomeUnknown: boolean;
  receiptCheck: "found" | "missing" | null;
  newerDraftSaved: boolean;
  failure: CommandFailure | null;
}

interface SaveResult { saved: boolean; savedCurrent: boolean; submittedSeq: number; submittedText: string }
interface DraftSession {
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
  const mounted = useRef(false);
  const inFlight = useRef(false);
  useLayoutEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function update(change: (current: TranslationDraft | null) => TranslationDraft | null) {
    const next = change(currentDraft.current);
    currentDraft.current = next;
    if (mounted.current) setDraft(next);
    return next;
  }
  function current() { return currentDraft.current; }
  function begin(identity: DraftIdentity, selection: TranslationSelection | null, baseText: string | null, suggestedText?: string) {
    const existing = currentDraft.current;
    if (inFlight.current || existing?.pending || (existing && (existing.text !== (existing.baseText ?? "") || existing.newerDraftSaved))) return false;
    update(() => ({ ...identity, baseSelectionId: selection?.eventId ?? null, baseRevisionId: selection?.revisionId ?? null,
      baseText, text: suggestedText ?? baseText ?? "", editSeq: 0, pending: null, saving: false,
      outcomeUnknown: false, receiptCheck: null, newerDraftSaved: false, failure: null }));
    return true;
  }
  function edit(text: string) {
    update(value => value ? { ...value, text, editSeq: value.editSeq + 1, newerDraftSaved: false } : value);
  }
  function revert() {
    update(value => value ? { ...value, text: value.baseText ?? "", editSeq: value.editSeq + 1, newerDraftSaved: false } : value);
  }
  function clear() { if (!inFlight.current && !currentDraft.current?.pending) update(() => null); }
  function selected(selection: TranslationSelection | null, text: string | null, expectedSeq: number) {
    update(value => value && !value.pending && !value.saving ? { ...value,
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
    if (!start || inFlight.current || !projectRef.current.metadata.targetLocales.includes(start.locale)) return empty;
    inFlight.current = true;
    const submittedSeq = start.pending?.submittedSeq ?? start.editSeq;
    const submittedText = start.pending?.request.text ?? start.text;
    update(value => value ? { ...value, saving: true, failure: null, receiptCheck: null } : value);
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
    if (!pending || inFlight.current) return empty;
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

  return <DraftContext.Provider value={{ draft, current, begin, edit, revert, clear, save, checkSavedAction, selected, unchanged }}>
    {children}
  </DraftContext.Provider>;
}
