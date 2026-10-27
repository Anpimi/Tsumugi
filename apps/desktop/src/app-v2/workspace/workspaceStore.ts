import { createStore, type StoreApi } from "zustand/vanilla";
import type { EntryReviewNavigation } from "../features/review/navigationTypes";
import { copyWorkspaceSelection, type WorkspaceSelection } from "./workspaceSelection";

export const viewKinds = ["entries", "knowledge", "runs", "delivery", "decisions", "extensions", "settings"] as const;
export type ViewKind = typeof viewKinds[number];

/** Only presentation state belongs here. Project facts, drafts and grants have other owners. */
export interface WorkspaceView {
  id: string;
  kind: ViewKind;
  entryMode: "table" | "import";
  entryPageMode: boolean;
  compareSource: boolean;
  detailTab: "detail" | "context" | "candidates" | "issues" | "history";
  reviewHistoryOffset: number;
  reviewNavigation: EntryReviewNavigation | null;
  candidateAfterOrdinal: string;
  candidateInitialRevisionId: string | null;
  candidateCompareOpen: boolean;
  candidateComparisonId: string | null;
  candidateCompareRefs: readonly string[];
  candidateCompareBlind: boolean;
  locale: string;
  preset: string;
  query: string;
  searchInput: string;
  scroll: { top: number; left: number };
  selection: WorkspaceSelection | null;
  focus: string | null;
  editing: boolean;
  queueActive: boolean;
  queueAnchor: string | null;
  queueScopeId: string | null;
  focusMode: boolean;
  dock: "agent" | "details";
  dockOpen: boolean;
  dockSize: number | null;
  afterOrdinal: number;
  cursor: string | null;
  pinned: boolean;
}

export type NewWorkspaceView = Partial<Omit<WorkspaceView, "id" | "kind" | "locale">> & {
  id?: string;
  kind: ViewKind;
  locale: string;
};
export type ViewPatch = Partial<Omit<WorkspaceView, "id" | "kind" | "pinned">>;

export interface WorkspaceState {
  views: Record<string, WorkspaceView>;
  viewOrder: string[];
  activeViewId: string | null;
  open: (input: NewWorkspaceView) => string;
  activate: (viewId: string) => boolean;
  close: (viewId: string) => boolean;
  pin: (viewId: string, pinned?: boolean) => boolean;
  patch: (viewId: string, patch: ViewPatch) => boolean;
}

export type WorkspaceStore = StoreApi<WorkspaceState>;

export function validWorkspaceViewId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id);
}

export function getWorkspaceView(state: Pick<WorkspaceState, "views">, id: string | null): WorkspaceView | null {
  return id !== null && Object.hasOwn(state.views, id) ? state.views[id] : null;
}

export function makeWorkspaceView(input: NewWorkspaceView, id: string): WorkspaceView {
  if (!validWorkspaceViewId(id)) throw new Error("Invalid workspace view ID");
  return {
    id,
    kind: input.kind,
    entryMode: input.entryMode ?? "table",
    entryPageMode: input.entryPageMode ?? false,
    compareSource: input.compareSource ?? false,
    detailTab: input.detailTab ?? "detail",
    reviewHistoryOffset: input.reviewHistoryOffset ?? 0,
    reviewNavigation: input.reviewNavigation ?? null,
    candidateAfterOrdinal: input.candidateAfterOrdinal ?? "0",
    candidateInitialRevisionId: input.candidateInitialRevisionId ?? null,
    candidateCompareOpen: input.candidateCompareOpen ?? false,
    candidateComparisonId: input.candidateComparisonId ?? null,
    candidateCompareRefs: Object.freeze([...(input.candidateCompareRefs ?? [])]),
    candidateCompareBlind: input.candidateCompareBlind ?? false,
    locale: input.locale,
    preset: input.preset ?? "all",
    query: input.query ?? "",
    searchInput: input.searchInput ?? input.query ?? "",
    scroll: { top: input.scroll?.top ?? 0, left: input.scroll?.left ?? 0 },
    selection: copyWorkspaceSelection(input.selection ?? null),
    focus: input.focus ?? null,
    editing: input.editing ?? input.focus != null,
    queueActive: input.queueActive ?? input.focus != null,
    queueAnchor: input.queueAnchor ?? input.focus ?? null,
    queueScopeId: input.queueScopeId ?? null,
    focusMode: input.focusMode ?? false,
    dock: input.dock ?? "agent",
    dockOpen: input.dockOpen ?? true,
    dockSize: input.dockSize ?? null,
    afterOrdinal: input.afterOrdinal ?? 0,
    cursor: input.cursor ?? null,
    pinned: input.pinned ?? false,
  };
}

/** Closing the active tab selects its right neighbour, then its left neighbour. */
export function viewAfterClose(state: Pick<WorkspaceState, "viewOrder" | "activeViewId">, viewId: string): string | null {
  if (state.activeViewId !== viewId) return state.activeViewId;
  const index = state.viewOrder.indexOf(viewId);
  return state.viewOrder[index + 1] ?? state.viewOrder[index - 1] ?? null;
}

export function createWorkspaceStore({ initialLocale, initialViews, createId = () => crypto.randomUUID() }: {
  initialLocale: string;
  initialViews?: NewWorkspaceView[];
  createId?: () => string;
}): WorkspaceStore {
  const startingViews = (initialViews ?? [{ kind: "entries", locale: initialLocale }]).map(input => makeWorkspaceView(input, input.id ?? createId()));
  if (new Set(startingViews.map(view => view.id)).size !== startingViews.length) throw new Error("Workspace view IDs must be unique");
  return createStore<WorkspaceState>((set, get) => ({
    views: Object.fromEntries(startingViews.map(view => [view.id, view])),
    viewOrder: [...startingViews.filter(view => view.pinned), ...startingViews.filter(view => !view.pinned)].map(view => view.id),
    activeViewId: startingViews[0]?.id ?? null,
    open: input => {
      const id = input.id ?? createId();
      const state = get();
      if (getWorkspaceView(state, id)) { get().activate(id); return id; }
      const view = makeWorkspaceView(input, id);
      const order = view.pinned ? [...state.viewOrder.filter(key => state.views[key].pinned), id, ...state.viewOrder.filter(key => !state.views[key].pinned)] : [...state.viewOrder, id];
      set({ views: { ...state.views, [id]: view }, viewOrder: order, activeViewId: id });
      return id;
    },
    activate: viewId => {
      if (!getWorkspaceView(get(), viewId)) return false;
      if (get().activeViewId !== viewId) set({ activeViewId: viewId });
      return true;
    },
    close: viewId => {
      const state = get();
      const view = getWorkspaceView(state, viewId);
      if (!view || view.pinned) return false;
      const views = { ...state.views };
      delete views[viewId];
      set({ views, viewOrder: state.viewOrder.filter(id => id !== viewId), activeViewId: viewAfterClose(state, viewId) });
      return true;
    },
    pin: (viewId, pinned) => {
      const state = get();
      const view = getWorkspaceView(state, viewId);
      if (!view) return false;
      const views = { ...state.views, [viewId]: { ...view, pinned: pinned ?? !view.pinned } };
      set({ views, viewOrder: [...state.viewOrder.filter(id => views[id].pinned), ...state.viewOrder.filter(id => !views[id].pinned)] });
      return true;
    },
    patch: (viewId, patch) => {
      const state = get();
      const view = getWorkspaceView(state, viewId);
      if (!view) return false;
      const changedScope = patch.query !== undefined && patch.query !== view.query || patch.locale !== undefined && patch.locale !== view.locale
        || patch.preset !== undefined && patch.preset !== view.preset;
      const target = patch.focus !== undefined ? patch.focus : view.focus;
      const changedTarget = target !== view.focus || patch.locale !== undefined && patch.locale !== view.locale;
      const next = { ...view, ...patch, ...(patch.candidateCompareRefs ? { candidateCompareRefs: Object.freeze([...patch.candidateCompareRefs]) } : {}), ...(patch.selection !== undefined ? { selection: copyWorkspaceSelection(patch.selection) } : {}), ...(patch.scroll ? { scroll: { ...patch.scroll } } : {}),
        ...(changedTarget || changedScope ? { reviewNavigation: patch.reviewNavigation ?? null } : {}),
        ...(changedTarget ? { reviewHistoryOffset: patch.reviewHistoryOffset ?? 0, candidateAfterOrdinal: patch.candidateAfterOrdinal ?? "0", candidateInitialRevisionId: patch.candidateInitialRevisionId ?? null, candidateCompareOpen: patch.candidateCompareOpen ?? false, candidateComparisonId: patch.candidateComparisonId ?? null, candidateCompareRefs: Object.freeze([...(patch.candidateCompareRefs ?? [])]) } : {}),
        ...(changedScope ? { cursor: null, afterOrdinal: 0, queueScopeId: null, queueAnchor: target,
          queueActive: patch.queueActive ?? patch.focus != null, editing: patch.editing ?? patch.focus != null,
          focusMode: (patch.editing ?? patch.focus != null) ? patch.focusMode ?? view.focusMode : false } : {}) };
      set({ views: { ...state.views, [viewId]: next } });
      return true;
    },
  }));
}
