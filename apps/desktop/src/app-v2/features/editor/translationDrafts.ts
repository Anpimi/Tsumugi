import { draftCommands, sameDraftBasis, sameDraftValue, type DraftBasis, type DraftHead, type DraftKey, type DraftPending, type DraftReadView, type DraftSummary, type DraftValue } from "../../../draftCommands";
import { executionCommands, type SessionRequest } from "../../../executionCommands";
import { hasUnknownOutcome } from "../../../projectCommands";
import type { SessionReads } from "../../../sessionReads";
import { translationCommands, type TranslationRevision, type TranslationSaveReceipt, type TranslationSelection } from "../../../translationCommands";
import type { LifecycleParticipant } from "../../platform/projectLifecycle";
import { DraftKernel, nextEditSeq } from "../../workspace/draftKernel";

export interface DraftFailure {
  kind: "read" | "journal" | "journal-conflict" | "confirmation" | "recovery" | "basis-conflict";
  cause: unknown;
}
export interface DraftEntry {
  key: DraftKey;
  head: DraftHead;
  value: DraftValue | null;
  current: DraftReadView["current"];
  durableSeq: string | null;
  journalPending: boolean;
  busy: boolean;
  checking: boolean;
  recovery: "unchecked" | "pending" | "mismatch" | null;
  replayAllowed: boolean;
  failure: DraftFailure | null;
  currentFailure: unknown | null;
  basisCurrent: boolean;
  newerInputAfterConfirmation: boolean;
}
export interface TranslationDraftSnapshot {
  hydration: "idle" | "loading" | "ready" | "failed";
  revision: number;
  failure: DraftFailure | null;
  retired: boolean;
  mutationReserved: boolean;
  summaries: readonly DraftSummary[];
}
export interface TranslationDraftPorts {
  read: typeof draftCommands.read;
  write: typeof draftCommands.write;
  clear: typeof draftCommands.clear;
  list: typeof draftCommands.list;
  identity: typeof executionCommands.identity;
  save: typeof translationCommands.save;
  select: typeof translationCommands.select;
  recoverSave: typeof translationCommands.recoverSave;
  recoverSelection: typeof translationCommands.recoverSelection;
  writerId: () => string;
}
export interface TranslationDraftOptions {
  context: SessionRequest;
  reads: Pick<SessionReads, "invalidate">;
  onReveal?: (key: DraftKey) => void;
  ports?: Partial<TranslationDraftPorts>;
}
export interface ConfirmationResult { confirmed: boolean; savedCurrent: boolean }
interface RecordState {
  entry: DraftEntry;
  needsWrite: boolean;
  writing: boolean;
  scheduled: boolean;
  flush: Promise<boolean> | null;
  reading: Promise<DraftEntry | undefined> | null;
  writeAttempt: { expectedRevision: string; value: DraftValue } | null;
  clearAttempt: { expectedRevision: string } | null;
}
const unconfirmed = (): ConfirmationResult => ({ confirmed: false, savedCurrent: false });
const identity = (key: DraftKey) => JSON.stringify([key.projectId, key.unitId, key.locale]);
function freezeValue(value: DraftValue | null) {
  if (!value) return;
  Object.freeze(value.basis);
  if (value.pending) { Object.freeze(value.pending.request); Object.freeze(value.pending); }
  Object.freeze(value);
}
function immutableEntry(entry: DraftEntry): DraftEntry {
  freezeValue(entry.value); freezeValue(entry.head.value);
  Object.freeze(entry.key); Object.freeze(entry.head.key); Object.freeze(entry.head);
  if (entry.current.kind === "current") Object.freeze(entry.current.basis);
  Object.freeze(entry.current);
  return Object.freeze(entry);
}

/** A project-session owner. Views borrow entries; they never own their lifetime. */
export class TranslationDrafts {
  private readonly context: SessionRequest;
  private readonly ports: TranslationDraftPorts;
  private readonly writerId: string;
  private readonly kernel = new DraftKernel();
  private readonly records = new Map<string, RecordState>();
  private readonly opening = new Map<string, Promise<DraftEntry | undefined>>();
  private readonly listeners = new Set<() => void>();
  private hydration: Promise<boolean> | null = null;
  private inputRevision = 0;
  private retiredReservation = false;
  private state: TranslationDraftSnapshot = { hydration: "idle", revision: 0, failure: null, retired: false, mutationReserved: false, summaries: [] };

  constructor(private readonly options: TranslationDraftOptions) {
    this.context = Object.freeze({ ...options.context });
    this.ports = { ...draftCommands, identity: executionCommands.identity, save: translationCommands.save,
      select: translationCommands.select, recoverSave: translationCommands.recoverSave,
      recoverSelection: translationCommands.recoverSelection, writerId: () => crypto.randomUUID(), ...options.ports };
    this.writerId = this.ports.writerId();
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getEntry = (key: DraftKey): DraftEntry | undefined => this.records.get(identity(key))?.entry;
  private validKey(key: DraftKey) { return key.projectId === this.context.projectId; }
  private summaries(source: readonly DraftSummary[]): readonly DraftSummary[] {
    // Unopened entries retain the Host's metadata. Loaded entries project their
    // actual owner state, including input that has not reached the disk yet.
    const projection = new Map(source.map(summary => [identity(summary.key), summary]));
    for (const [id, record] of this.records) {
      const { value, head, key } = record.entry;
      if (value && (head.value !== null || record.needsWrite || record.writing)) projection.set(id, {
        key, revision: head.revision, editSeq: value.editSeq, sourceRevisionId: value.basis.sourceRevisionId, hasPending: value.pending !== null,
      });
      else projection.delete(id);
    }
    return [...projection.values()].sort((a, b) => a.key.locale.localeCompare(b.key.locale) || a.key.unitId.localeCompare(b.key.unitId));
  }
  private notify(patch: Partial<TranslationDraftSnapshot> = {}) {
    if (!this.kernel.live) return;
    this.state = { ...this.state, ...patch, summaries: this.summaries(patch.summaries ?? this.state.summaries),
      revision: this.state.revision + 1, mutationReserved: this.kernel.reserved };
    this.listeners.forEach(listener => listener());
  }
  private update(record: RecordState, patch: Partial<DraftEntry> = {}) {
    if (!this.kernel.live) return;
    const entry = { ...record.entry, ...patch };
    entry.basisCurrent = entry.value !== null && entry.current.kind === "current" && sameDraftBasis(entry.value.basis, entry.current.basis);
    entry.journalPending = record.needsWrite || record.writing;
    record.entry = immutableEntry(entry);
    this.notify();
  }
  private pending() { return [...this.records.values()].some(record => record.entry.value?.pending); }

  private observe(record: RecordState, view: DraftReadView) {
    const changed = record.entry.head.revision !== view.head.revision;
    const written = record.writeAttempt && view.head.writerId === this.writerId && view.head.value
      && sameDraftValue(record.writeAttempt.value, view.head.value);
    const cleared = record.clearAttempt && view.head.value === null
      && BigInt(view.head.revision) === BigInt(record.clearAttempt.expectedRevision) + 1n;
    if (changed && (written || cleared)) {
      record.writeAttempt = null; record.clearAttempt = null;
      record.needsWrite = view.head.value !== null
        ? !record.entry.value || !sameDraftValue(record.entry.value, view.head.value) : record.needsWrite;
      this.update(record, { head: view.head, current: view.current, currentFailure: null,
        durableSeq: view.head.value?.editSeq ?? null, failure: null });
    } else this.update(record, { current: view.current, currentFailure: null,
      ...(changed ? { failure: { kind: "journal-conflict" as const, cause: new Error("Draft head changed in another writer") } }
        : record.entry.failure?.kind === "read" ? { failure: null } : {}) });
  }

  initialize(): Promise<boolean> {
    if (!this.kernel.live) return Promise.resolve(false);
    if (this.hydration) return this.hydration;
    if (this.state.hydration === "ready") return Promise.resolve(true);
    this.notify({ hydration: "loading", failure: null });
    const loading = (async () => {
      const summaries: DraftSummary[] = [];
      let after: DraftKey | null = null;
      try {
        do {
          const page = await this.ports.list({ ...this.context, after, limit: 100 });
          if (!this.kernel.live) return false;
          summaries.push(...page.items);
          for (const summary of page.items) if (summary.hasPending) {
            if (!await this.open(summary.key)) throw new Error("Pending draft could not be loaded");
          }
          after = page.next;
        } while (after !== null);
        this.notify({ hydration: "ready", summaries, failure: null }); return true;
      } catch (cause) {
        this.notify({ hydration: "failed", failure: { kind: "read", cause } }); return false;
      }
    })();
    this.hydration = loading;
    void loading.finally(() => { if (this.hydration === loading) this.hydration = null; });
    return loading;
  }

  open(key: DraftKey): Promise<DraftEntry | undefined> {
    if (!this.kernel.live || !this.validKey(key)) return Promise.resolve(undefined);
    const id = identity(key), existing = this.records.get(id);
    if (existing?.reading) return existing.reading;
    const waiting = this.opening.get(id); if (waiting) return waiting;
    const reading = this.kernel.enqueue(id, async () => {
      try {
        const view = await this.ports.read({ sessionToken: this.context.sessionToken, key });
        if (!this.kernel.live) return undefined;
        const record = this.records.get(id);
        if (record) {
          // An external writer is never silently adopted over local input.
          this.observe(record, view);
          return record.entry;
        }
        const value = view.head.value ?? (view.current.kind === "current"
          ? { basis: view.current.basis, text: view.current.basis.text ?? "", editSeq: "0", pending: null } : null);
        const created: RecordState = { needsWrite: false, writing: false, scheduled: false, flush: null, reading: null, writeAttempt: null, clearAttempt: null,
          entry: { key: { ...key }, head: view.head, value, current: view.current,
            durableSeq: view.head.value?.editSeq ?? null, journalPending: false, busy: false, checking: false,
            recovery: value?.pending ? "unchecked" : null, replayAllowed: false, failure: null, currentFailure: null,
            basisCurrent: !!value && view.current.kind === "current" && sameDraftBasis(value.basis, view.current.basis), newerInputAfterConfirmation: false } };
        created.entry = immutableEntry(created.entry);
        this.records.set(id, created); this.notify(); return created.entry;
      } catch (cause) {
        const record = this.records.get(id);
        if (record) this.update(record, { currentFailure: cause });
        else this.notify({ failure: { kind: "read", cause } });
        return undefined;
      }
    }).catch(() => undefined);
    this.opening.set(id, reading);
    if (existing) existing.reading = reading;
    void reading.finally(() => {
      if (this.opening.get(id) === reading) this.opening.delete(id);
      if (existing?.reading === reading) existing.reading = null;
    });
    return reading;
  }

  edit(key: DraftKey, text: string): boolean {
    const record = this.records.get(identity(key));
    if (!this.kernel.live || !record?.entry.value) return false;
    this.inputRevision++; record.needsWrite = true;
    this.update(record, { value: { ...record.entry.value, text, editSeq: nextEditSeq(record.entry.value.editSeq) }, newerInputAfterConfirmation: false });
    this.schedule(record); return true;
  }
  private schedule(record: RecordState) {
    if (record.scheduled || !this.kernel.live) return;
    record.scheduled = true;
    queueMicrotask(() => { record.scheduled = false; if (this.kernel.live) void this.flush(record.entry.key); });
  }

  async flush(key?: DraftKey): Promise<boolean> {
    if (!this.kernel.live) return false;
    if (!key) return (await Promise.all([...this.records.values()].map(record => this.flush(record.entry.key)))).every(Boolean);
    const record = this.records.get(identity(key)); if (!record) return false;
    if (record.flush) return record.flush;
    if (!record.needsWrite && !record.clearAttempt && record.entry.failure?.kind !== "journal") return record.entry.failure?.kind !== "journal-conflict";
    const flushing = this.kernel.enqueue(identity(key), async () => {
      if (record.clearAttempt || !record.needsWrite && record.entry.failure?.kind === "journal") {
        try {
          const view = await this.ports.read({ sessionToken: this.context.sessionToken, key: record.entry.key });
          if (!this.kernel.live) return false;
          this.observe(record, view);
          if (record.entry.failure?.kind === "journal-conflict") return false;
          // A failed optional cleanup may leave an already durable draft intact.
          if (!record.needsWrite) { record.clearAttempt = null; this.update(record, { failure: null }); }
        } catch (cause) { this.update(record, { failure: { kind: "journal", cause } }); return false; }
      }
      while (this.kernel.live && record.needsWrite) {
        if (record.entry.failure?.kind === "journal-conflict") return false;
        const attempt = record.writeAttempt ?? (record.entry.value ? { value: record.entry.value, expectedRevision: record.entry.head.revision } : null);
        if (!attempt) return false;
        const { value, expectedRevision } = attempt;
        record.writeAttempt = attempt;
        record.writing = true; this.update(record);
        try {
          const head = await this.ports.write({ sessionToken: this.context.sessionToken,
            write: { key: record.entry.key, expectedRevision, writerId: this.writerId, value } });
          if (!this.kernel.live) return false;
          record.writeAttempt = null;
          record.needsWrite = !record.entry.value || !sameDraftValue(record.entry.value, value);
          this.update(record, { head, durableSeq: value.editSeq,
            ...(record.entry.failure?.kind === "journal" ? { failure: null } : {}) });
        } catch (cause) {
          if (!hasUnknownOutcome(cause)) record.writeAttempt = null;
          this.update(record, { failure: { kind: "journal", cause } }); return false;
        } finally { record.writing = false; this.update(record); }
      }
      return this.kernel.live && !record.needsWrite;
    }).catch(() => false);
    record.flush = flushing;
    void flushing.finally(() => { if (record.flush === flushing) record.flush = null; });
    return flushing;
  }

  reserveMutation(): symbol | null {
    if (this.state.hydration !== "ready" || this.pending()) return null;
    const token = this.kernel.reserve(); if (token) this.notify(); return token;
  }
  ownsMutation(token: symbol) { return this.kernel.owns(token); }
  releaseMutation(token: symbol) { this.kernel.release(token); this.notify(); }

  private fresh(record: RecordState) {
    return this.kernel.live && !!record.entry.value && !record.entry.busy && !record.entry.value.pending
      && record.entry.basisCurrent && record.entry.currentFailure === null && record.entry.failure?.kind !== "journal-conflict";
  }
  confirm(key: DraftKey): Promise<ConfirmationResult> { return this.start(key); }
  selectRevision(key: DraftKey, revision: TranslationRevision): Promise<ConfirmationResult> {
    const value = this.getEntry(key)?.value;
    if (!value || value.text !== (value.basis.text ?? "") || revision.unitId !== key.unitId || revision.locale !== key.locale
      || revision.candidateDecision?.request.disposition === "rejected") return Promise.resolve(unconfirmed());
    return this.start(key, revision);
  }
  private async start(key: DraftKey, revision?: TranslationRevision): Promise<ConfirmationResult> {
    const record = this.records.get(identity(key));
    if (!record || !this.fresh(record)) return unconfirmed();
    const token = this.reserveMutation(); if (!token) return unconfirmed();
    const start = record.entry.value!;
    this.update(record, { busy: true, failure: null, replayAllowed: false });
    try {
      const actionId = await this.ports.identity(this.context);
      if (!this.kernel.owns(token)) return unconfirmed();
      // This read starts after identity allocation. An older UI read cannot
      // authorize a removed locale or silently rebind a changed source.
      const previousRead = this.opening.get(identity(key));
      if (previousRead) await previousRead;
      await this.open(key);
      if (!this.kernel.owns(token)) return unconfirmed();
      if (!record.entry.basisCurrent || record.entry.currentFailure !== null || !sameDraftBasis(record.entry.value!.basis, start.basis)) {
        this.update(record, { failure: { kind: "basis-conflict", cause: new Error("Translation basis changed") } }); return unconfirmed();
      }
      const request = { projectId: this.context.projectId, actionId, unitId: key.unitId, locale: key.locale,
        sourceRevisionId: start.basis.sourceRevisionId, expectedSelectionId: start.basis.selectionId };
      const pending: DraftPending = revision
        ? { kind: "selection", request: { ...request, revisionId: revision.revisionId }, submittedSeq: start.editSeq, text: revision.text }
        : { kind: "save", request: { ...request, text: start.text }, submittedSeq: start.editSeq };
      record.needsWrite = true;
      this.update(record, { value: { ...record.entry.value!, pending }, recovery: "unchecked" });
      if (!await this.flush(key) || !this.kernel.owns(token)) return unconfirmed();
      return await this.dispatch(record, pending, false);
    } catch (cause) { this.update(record, { failure: { kind: "confirmation", cause } }); return unconfirmed(); }
    finally { this.releaseMutation(token); this.update(record, { busy: false }); }
  }

  private async dispatch(record: RecordState, pending: DraftPending, recovering: boolean): Promise<ConfirmationResult> {
    let receipt: TranslationSaveReceipt | TranslationSelection;
    this.update(record, { replayAllowed: false, failure: null });
    try {
      receipt = pending.kind === "save"
        ? await this.ports.save({ ...pending.request, sessionToken: this.context.sessionToken })
        : await this.ports.select({ ...pending.request, sessionToken: this.context.sessionToken });
    } catch (cause) {
      if (!this.kernel.live || record.entry.value?.pending !== pending) return unconfirmed();
      if (!recovering && !hasUnknownOutcome(cause)) {
        record.needsWrite = true;
        this.update(record, { value: { ...record.entry.value, pending: null }, recovery: null, failure: { kind: "confirmation", cause } });
        await this.flush(record.entry.key); return unconfirmed();
      }
      this.update(record, { recovery: "unchecked", failure: { kind: "confirmation", cause } });
      if (!hasUnknownOutcome(cause)) return unconfirmed();
      // Query once. A failed query can never re-enter the write catch.
      return this.lookup(record, pending);
    }
    return this.settle(record, pending, receipt);
  }

  async recover(key: DraftKey): Promise<ConfirmationResult> {
    const record = this.records.get(identity(key)), pending = record?.entry.value?.pending;
    if (!this.kernel.live || !record || !pending || record.entry.busy) return unconfirmed();
    this.update(record, { busy: true });
    try { return await this.lookup(record, pending); }
    finally { this.update(record, { busy: false }); }
  }
  private async lookup(record: RecordState, pending: DraftPending): Promise<ConfirmationResult> {
    this.update(record, { checking: true, replayAllowed: false });
    try {
      const result = pending.kind === "save"
        ? await this.ports.recoverSave({ ...pending.request, sessionToken: this.context.sessionToken })
        : await this.ports.recoverSelection({ ...pending.request, sessionToken: this.context.sessionToken });
      if (!this.kernel.live || record.entry.value?.pending !== pending) return unconfirmed();
      if (result.outcome.kind === "recorded") return this.settle(record, pending, result.outcome.receipt);
      this.update(record, { recovery: result.outcome.kind,
        replayAllowed: result.outcome.kind === "pending" && result.outcome.replay === "explicit-same-request", failure: null });
      return unconfirmed();
    } catch (cause) {
      this.update(record, { recovery: "unchecked", replayAllowed: false, failure: { kind: "recovery", cause } }); return unconfirmed();
    } finally { this.update(record, { checking: false }); }
  }
  async replay(key: DraftKey): Promise<ConfirmationResult> {
    const record = this.records.get(identity(key)), pending = record?.entry.value?.pending;
    if (!this.kernel.live || !record || !pending || record.entry.busy || !record.entry.replayAllowed) return unconfirmed();
    const token = this.kernel.reserve(); if (!token) return unconfirmed();
    this.update(record, { busy: true, replayAllowed: false });
    try {
      if (!await this.flush(key) || !this.kernel.owns(token)) return unconfirmed();
      return await this.dispatch(record, pending, true);
    } finally { this.releaseMutation(token); this.update(record, { busy: false }); }
  }

  private async settle(record: RecordState, pending: DraftPending, receipt: TranslationSaveReceipt | TranslationSelection): Promise<ConfirmationResult> {
    const before = record.entry.value;
    if (!this.kernel.live || before?.pending !== pending) return unconfirmed();
    const selection = "selection" in receipt ? receipt.selection : receipt;
    const text = pending.kind === "save" ? pending.request.text : pending.text;
    const basis: DraftBasis = { sourceRevisionId: pending.request.sourceRevisionId,
      selectionId: selection.eventId, revisionId: selection.revisionId, text };
    const sameInput = before.editSeq === pending.submittedSeq && (pending.kind === "selection" || before.text === text);
    record.needsWrite = true;
    this.update(record, { value: { ...before, basis, text: sameInput ? text : before.text, pending: null }, recovery: null,
      replayAllowed: false, failure: null, newerInputAfterConfirmation: !sameInput });
    this.options.reads.invalidate(["translation", "review"], false);
    const durable = await this.flush(record.entry.key);
    if (!this.kernel.live) return unconfirmed();
    // Historical receipts do not describe the current selection. Observe it separately.
    await this.open(record.entry.key);
    const value = record.entry.value;
    if (durable && sameInput && value && value.editSeq === pending.submittedSeq && value.text === text && record.entry.basisCurrent)
      await this.clearRecord(record, false);
    return { confirmed: true, savedCurrent: durable && !record.needsWrite && record.entry.value?.editSeq === pending.submittedSeq
      && record.entry.value.text === text && record.entry.currentFailure === null && record.entry.basisCurrent };
  }

  async rebase(key: DraftKey): Promise<boolean> {
    const record = this.records.get(identity(key));
    if (!this.kernel.live || !record?.entry.value || record.entry.busy || record.entry.value.pending || record.entry.failure?.kind === "journal-conflict") return false;
    const before = record.entry.value;
    if (!await this.open(key) || !this.kernel.live || record.entry.value !== before || record.entry.current.kind !== "current") return false;
    this.inputRevision++; record.needsWrite = true;
    this.update(record, { value: { ...before, basis: record.entry.current.basis, editSeq: nextEditSeq(before.editSeq) }, failure: null, newerInputAfterConfirmation: false });
    return this.flush(key);
  }

  discard(key: DraftKey): Promise<boolean> {
    const record = this.records.get(identity(key));
    return !this.kernel.live || !record || record.entry.busy || record.entry.value?.pending
      ? Promise.resolve(false) : this.clearRecord(record, true);
  }
  private async clearRecord(record: RecordState, discard: boolean): Promise<boolean> {
    const value = record.entry.value;
    if (!value || value.pending) return false;
    if ((record.writeAttempt || record.clearAttempt) && !await this.flush(record.entry.key)) return false;
    return this.kernel.enqueue(identity(record.entry.key), async () => {
      if (record.entry.value !== value || value.pending || record.entry.failure?.kind === "journal-conflict") return false;
      record.writing = true; this.update(record);
      try {
        record.clearAttempt = { expectedRevision: record.entry.head.revision };
        const head = await this.ports.clear({ sessionToken: this.context.sessionToken,
          clear: { key: record.entry.key, expectedRevision: record.entry.head.revision } });
        if (!this.kernel.live) return false;
        record.clearAttempt = null;
        const unchanged = record.entry.value === value;
        record.needsWrite = !unchanged;
        const current = record.entry.current;
        const reset = discard && unchanged ? current.kind === "current"
          ? { basis: current.basis, text: current.basis.text ?? "", editSeq: nextEditSeq(value.editSeq), pending: null } : null : record.entry.value;
        if (discard && unchanged) this.inputRevision++;
        this.update(record, { head, value: reset, durableSeq: null, failure: null,
          ...(discard && unchanged ? { newerInputAfterConfirmation: false } : {}) });
        if (!unchanged) this.schedule(record);
        return unchanged;
      } catch (cause) {
        if (!hasUnknownOutcome(cause)) record.clearAttempt = null;
        this.update(record, { failure: { kind: "journal", cause } }); return false;
      }
      finally { record.writing = false; this.update(record); }
    }).catch(() => false);
  }

  lifecycleParticipant(onReveal = this.options.onReveal): LifecycleParticipant {
    const unresolved = () => [...this.records.values()].find(record => record.entry.value?.pending || record.entry.journalPending || record.entry.failure?.kind === "journal" || record.entry.failure?.kind === "journal-conflict");
    return { id: "translation-drafts", area: "translation", scope: { kind: "project", ...this.context },
      inspect: intent => {
        if (intent.kind === "restore") return { status: "ready", revision: "initial-presentation" };
        // Retiring execution cannot revoke a permit for unchanged durable input
        // while the checked Core close is followed by application drain.
        const reserved = this.kernel.reserved || this.retiredReservation;
        return { status: this.state.hydration !== "ready" || reserved || this.pending() ? "blocked" : unresolved() ? "dirty" : "ready",
          revision: JSON.stringify([this.state.hydration, this.inputRevision, reserved,
            [...this.records.values()].map(({ entry }) => [identity(entry.key), entry.value?.editSeq, entry.value?.pending, entry.journalPending, entry.failure?.kind])]) };
      },
      prepareLeave: async (_intent, proof, current) => {
        if (!proof() || !current() || this.state.hydration !== "ready" || this.pending() || this.kernel.reserved) return false;
        const input = this.inputRevision;
        const flushed = await this.flush();
        // The coordinator accepts this owner's flush; later input still revokes its permit.
        return flushed && current() && this.kernel.live && input === this.inputRevision && !this.pending() && !unresolved();
      },
      reveal: () => { const record = unresolved(); if (record) onReveal?.(record.entry.key); },
    };
  }

  retire() {
    if (!this.kernel.live) return;
    this.retiredReservation = this.kernel.reserved;
    this.kernel.retire();
    this.state = { ...this.state, retired: true, revision: this.state.revision + 1, mutationReserved: false };
    this.listeners.forEach(listener => listener());
  }
}
