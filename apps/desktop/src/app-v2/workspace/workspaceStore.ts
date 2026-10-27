import { createStore, type StoreApi } from "zustand/vanilla";

export const viewKinds = ["entries", "knowledge", "runs", "delivery", "decisions", "extensions", "settings"] as const;
export type ViewKind = typeof viewKinds[number];

/** Only presentation state belongs here. Project facts, drafts and grants have other owners. */
export interface WorkspaceView {
  id: string;
  kind: ViewKind;
  locale: string;
  preset: string;
  query: string;
  searchInput: string;
  scroll: { top: number; left: number };
  selection: string[];
  focus: string | null;
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
    locale: input.locale,
    preset: input.preset ?? "all",
    query: input.query ?? "",
    searchInput: input.searchInput ?? input.query ?? "",
    scroll: { top: input.scroll?.top ?? 0, left: input.scroll?.left ?? 0 },
    selection: [...(input.selection ?? [])],
    focus: input.focus ?? null,
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
      set({ views: { ...state.views, [viewId]: { ...view, ...patch, ...(patch.selection ? { selection: [...patch.selection] } : {}), ...(patch.scroll ? { scroll: { ...patch.scroll } } : {}) } } });
      return true;
    },
  }));
}
