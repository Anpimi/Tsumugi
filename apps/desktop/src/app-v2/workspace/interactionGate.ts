export type CommandSource = "keyboard" | "button" | "menu" | "context-menu" | "palette" | "native-menu";

export interface InteractionSnapshot {
  visibleViewId: string | null;
  inputOwner: { viewId: string | null; ownerId: string } | null;
  composingOwners: readonly string[];
  dialogs: readonly string[];
  intentOwner: string | null;
}

export interface InteractionIntent {
  current: () => boolean;
  release: () => void;
}

/** Explicit input and dialog ownership; no DOM queries and no business permission state. */
export class InteractionGate {
  private listeners = new Set<() => void>();
  private intent: symbol | null = null;
  private dialogTokens: { id: string; token: symbol }[] = [];
  private disposed = false;
  private compositionRevision = 0;
  private snapshot: InteractionSnapshot = { visibleViewId: null, inputOwner: null, composingOwners: [], dialogs: [], intentOwner: null };

  getSnapshot = (): InteractionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private update(patch: Partial<InteractionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }

  setVisibleOwner(viewId: string | null) {
    if (viewId === this.snapshot.visibleViewId) return;
    this.update({ visibleViewId: viewId, inputOwner: null });
  }

  setInputOwner(viewId: string | null, ownerId: string | null) {
    if (viewId !== this.snapshot.visibleViewId) return;
    this.update({ inputOwner: ownerId ? { viewId, ownerId } : null });
  }

  setComposing(ownerId: string, composing: boolean) {
    const owners = new Set(this.snapshot.composingOwners);
    if (composing) { owners.add(ownerId); this.compositionRevision += 1; } else owners.delete(ownerId);
    this.update({ composingOwners: [...owners] });
  }

  releaseOwner(ownerId: string) {
    this.update({ composingOwners: this.snapshot.composingOwners.filter(id => id !== ownerId), inputOwner: this.snapshot.inputOwner?.ownerId === ownerId ? null : this.snapshot.inputOwner });
  }

  pushDialog(id: string): () => void {
    const token = Symbol(id);
    this.dialogTokens.push({ id, token });
    this.update({ dialogs: this.dialogTokens.map(dialog => dialog.id) });
    return () => {
      this.dialogTokens = this.dialogTokens.filter(dialog => dialog.token !== token);
      this.update({ dialogs: this.dialogTokens.map(dialog => dialog.id) });
    };
  }

  canDispatch({ viewId, source, inputOwner, dialogId }: { viewId: string | null; source: CommandSource; inputOwner?: string; dialogId?: string }): boolean {
    if (this.disposed || this.intent || viewId !== this.snapshot.visibleViewId || this.snapshot.composingOwners.length > 0) return false;
    const topDialog = this.snapshot.dialogs.at(-1);
    if (topDialog && topDialog !== dialogId) return false;
    if (source === "keyboard" && inputOwner !== undefined && (this.snapshot.inputOwner?.viewId !== viewId || this.snapshot.inputOwner.ownerId !== inputOwner)) return false;
    return true;
  }

  acquireIntent(ownerId: string): InteractionIntent | null {
    if (this.disposed || this.intent || this.snapshot.composingOwners.length > 0 || this.snapshot.dialogs.length > 0) return null;
    const token = Symbol(ownerId);
    const fromView = this.snapshot.visibleViewId;
    const compositionRevision = this.compositionRevision;
    this.intent = token;
    this.update({ intentOwner: ownerId });
    return {
      current: () => !this.disposed && this.intent === token && this.snapshot.visibleViewId === fromView && this.compositionRevision === compositionRevision,
      release: () => {
        if (this.intent !== token) return;
        this.intent = null;
        this.update({ intentOwner: null });
      },
    };
  }

  dispose() {
    this.disposed = true;
    this.intent = null;
    this.dialogTokens = [];
    this.update({ intentOwner: null, dialogs: [], composingOwners: [], inputOwner: null });
    this.listeners.clear();
  }
}
