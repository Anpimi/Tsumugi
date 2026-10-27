import { createHashHistory, createRootRoute, createRoute, createRouter, Outlet, type RouteComponent, type RouterHistory } from "@tanstack/react-router";
import type { SessionExitPermit } from "../../sessionNavigation";
import { InteractionGate, type InteractionIntent } from "./interactionGate";
import { getWorkspaceView, makeWorkspaceView, viewAfterClose, viewKinds, type NewWorkspaceView, type ViewKind, type ViewPatch, type WorkspaceStore, type WorkspaceView } from "./workspaceStore";

export interface WorkspaceTransition {
  kind: "navigate" | "close-view" | "language" | "restore";
  viewId?: string;
  from: WorkspaceView | null;
  to: WorkspaceView | null;
}

/** The project lifecycle owner retains authority over whether leaving is safe. */
export type WorkspaceGuard = (transition: WorkspaceTransition, current: () => boolean) => Promise<SessionExitPermit | null>;

export interface WorkspaceSearch {
  kind: ViewKind;
  locale: string;
  preset: string;
  query: string;
  focus?: string;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function validateWorkspaceSearch(input: Record<string, unknown>, defaultLocale: string): WorkspaceSearch {
  const kind = viewKinds.find(value => value === input.kind) ?? "entries";
  return { kind, locale: text(input.locale, defaultLocale), preset: text(input.preset, "all"), query: text(input.query, ""), ...(typeof input.focus === "string" && input.focus !== "" ? { focus: input.focus } : {}) };
}

/** This whitelist is deliberately smaller than workspace or project state. */
export function workspaceViewHref(view: WorkspaceView | null): string {
  if (!view) return "/";
  const search = new URLSearchParams({ kind: view.kind, locale: view.locale, preset: view.preset });
  if (view.query) search.set("query", view.query);
  if (view.focus) search.set("focus", view.focus);
  return `/view/${encodeURIComponent(view.id)}?${search}`;
}

export function parseWorkspaceHref(href: string, defaultLocale: string): NewWorkspaceView | null | undefined {
  const queryIndex = href.indexOf("?");
  const pathname = queryIndex < 0 ? href : href.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : href.slice(queryIndex + 1);
  if (pathname === "/") return null;
  const match = /^\/view\/([A-Za-z0-9][A-Za-z0-9_-]{0,95})\/?$/.exec(pathname);
  if (!match) return undefined;
  const search = validateWorkspaceSearch(Object.fromEntries(new URLSearchParams(query)), defaultLocale);
  return { id: match[1], ...search, focus: search.focus ?? null };
}

function viewFromHref(href: string, store: WorkspaceStore, defaultLocale: string): WorkspaceView | null | undefined {
  const input = parseWorkspaceHref(href, defaultLocale);
  if (input === null || input === undefined) return input;
  const id = input.id;
  if (id === undefined) return undefined;
  const existing = getWorkspaceView(store.getState(), id);
  return makeWorkspaceView({ ...existing, ...input }, id);
}

export function createWorkspaceRouter({ store, gate, guard, onError, history: suppliedHistory, component = () => null }: {
  store: WorkspaceStore;
  gate: InteractionGate;
  guard: WorkspaceGuard;
  onError: (error: unknown) => void;
  history?: RouterHistory;
  component?: RouteComponent;
}) {
  const history = suppliedHistory ?? createHashHistory();
  const state = store.getState();
  const defaultLocale = getWorkspaceView(state, state.activeViewId)?.locale ?? "";
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component });
  const viewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/view/$viewId", validateSearch: input => validateWorkspaceSearch(input, defaultLocale), component });
  const router = createRouter({
    history,
    routeTree: rootRoute.addChildren([indexRoute, viewRoute]),
    parseSearch: search => Object.fromEntries(new URLSearchParams(search)),
    stringifySearch: search => {
      const values = new URLSearchParams();
      for (const key of ["kind", "locale", "preset", "query", "focus"]) {
        const value: unknown = search[key];
        if (typeof value === "string" && value !== "") values.set(key, value);
      }
      return values.size > 0 ? `?${values}` : "";
    },
    defaultPreload: false,
    scrollRestoration: false,
  });
  let disposed = false;
  let authorizing = false;
  let lastAcceptedHref = history.location.href;
  type Ticket = { href: string; to: WorkspaceView | null; permit: SessionExitPermit; intent: InteractionIntent; current: () => boolean; commit?: () => boolean; patch?: ViewPatch; resolve: (accepted: boolean) => void };
  let pending: Ticket | null = null;
  let cancelAuthorization: (() => void) | null = null;
  gate.setVisibleOwner(state.activeViewId);

  function applyView(to: WorkspaceView | null) {
    if (!to) { store.setState({ activeViewId: null }); gate.setVisibleOwner(null); return; }
    const current = getWorkspaceView(store.getState(), to.id);
    if (current) {
      const changedQuery = current.query !== to.query;
      const changedScope = changedQuery || current.locale !== to.locale || current.preset !== to.preset;
      store.getState().patch(to.id, {
        locale: to.locale, preset: to.preset, query: to.query, focus: to.focus,
        ...(changedQuery ? { searchInput: to.query } : {}),
        ...(changedScope ? { afterOrdinal: 0, cursor: null, scroll: { top: 0, left: 0 }, selection: [] } : {}),
      });
      store.getState().activate(to.id);
    } else store.getState().open(to);
    gate.setVisibleOwner(to.id);
  }

  function finish(ticket: Ticket, accepted: boolean) {
    if (pending === ticket) pending = null;
    ticket.permit.release();
    ticket.intent.release();
    ticket.resolve(accepted);
  }

  async function authorize(to: WorkspaceView | null, kind: WorkspaceTransition["kind"], href: string, viewId?: string, commit?: () => boolean, patch?: ViewPatch): Promise<Ticket | null> {
    if (disposed || authorizing || pending) return null;
    const intent = gate.acquireIntent(kind);
    if (!intent) return null;
    authorizing = true;
    const before = store.getState();
    const from = getWorkspaceView(before, before.activeViewId);
    const targetBefore = getWorkspaceView(before, to?.id ?? null);
    const closingView = kind === "close-view" && viewId ? getWorkspaceView(before, viewId) : null;
    let cancelled = false;
    cancelAuthorization = () => { cancelled = true; intent.release(); };
    const current = () => !disposed && !cancelled && intent.current() && store.getState().activeViewId === before.activeViewId && getWorkspaceView(store.getState(), before.activeViewId) === from && getWorkspaceView(store.getState(), to?.id ?? null) === targetBefore && (!closingView || getWorkspaceView(store.getState(), closingView.id) === closingView);
    try {
      const permit = await guard({ kind, viewId, from, to }, current);
      if (!permit) { intent.release(); return null; }
      if (!current() || !permit.current()) { permit.release(); intent.release(); return null; }
      const ticket = { href, to, permit, intent, current, commit, patch, resolve: (_accepted: boolean) => undefined };
      pending = ticket;
      return ticket;
    } catch (error) {
      intent.release();
      onError(error);
      return null;
    } finally {
      authorizing = false;
      cancelAuthorization = null;
    }
  }

  const unsubscribe = history.subscribe(({ location }) => {
    const ticket = pending;
    if (!ticket) {
      if (location.href !== lastAcceptedHref) history.replace(lastAcceptedHref, undefined, { ignoreBlocker: true });
      return;
    }
    if (ticket.href !== location.href) {
      finish(ticket, false);
      if (location.href !== lastAcceptedHref) history.replace(lastAcceptedHref, undefined, { ignoreBlocker: true });
      return;
    }
    if (!ticket.current() || !ticket.permit.current()) {
      finish(ticket, false);
      history.replace(lastAcceptedHref, undefined, { ignoreBlocker: true });
      return;
    }
    try {
      if (ticket.commit && !ticket.commit()) { finish(ticket, false); history.replace(lastAcceptedHref, undefined, { ignoreBlocker: true }); return; }
      applyView(ticket.to);
      if (ticket.patch && ticket.to) store.getState().patch(ticket.to.id, ticket.patch);
      lastAcceptedHref = location.href;
      finish(ticket, true);
    } catch (error) {
      finish(ticket, false);
      onError(error);
    }
  });

  // Browser back/forward, router links and direct router.navigate share this guard.
  const unblock = history.block({ enableBeforeUnload: false, blockerFn: async ({ nextLocation }) => {
    const to = viewFromHref(nextLocation.href, store, defaultLocale);
    if (to === undefined) return true;
    const from = getWorkspaceView(store.getState(), store.getState().activeViewId);
    const kind = from && to?.id === from.id && to.locale !== from.locale ? "language" : "navigate";
    return !await authorize(to, kind, nextLocation.href, to?.id);
  } });

  async function navigate(to: WorkspaceView | null, kind: WorkspaceTransition["kind"], replace = false, viewId?: string, commit?: () => boolean, patch?: ViewPatch): Promise<boolean> {
    const href = workspaceViewHref(to);
    const ticket = await authorize(to, kind, href, viewId, commit, patch);
    if (!ticket) return false;
    // Only this already-approved commit skips the blocker; the permit remains held.
    let resolve: (accepted: boolean) => void = () => undefined;
    const completed = new Promise<boolean>(done => { resolve = done; });
    ticket.resolve = resolve;
    if (!ticket.current() || !ticket.permit.current()) { finish(ticket, false); return false; }
    if (replace) history.replace(href, undefined, { ignoreBlocker: true }); else history.push(href, undefined, { ignoreBlocker: true });
    return completed;
  }

  const navigation = {
    open: (input: NewWorkspaceView) => {
      const id = input.id ?? crypto.randomUUID();
      const existing = getWorkspaceView(store.getState(), id);
      return navigate(existing ?? makeWorkspaceView(input, id), "navigate", false, id);
    },
    activate: (viewId: string) => {
      const view = getWorkspaceView(store.getState(), viewId);
      return view ? navigate(view, "navigate", false, viewId) : Promise.resolve(false);
    },
    update: (viewId: string, patch: ViewPatch) => {
      const view = getWorkspaceView(store.getState(), viewId);
      if (!view) return Promise.resolve(false);
      const next = { ...view, ...patch };
      return navigate(next, next.locale !== view.locale ? "language" : "navigate", true, viewId, undefined, patch);
    },
    close: (viewId: string) => {
      const state = store.getState();
      const view = getWorkspaceView(state, viewId);
      if (!view || view.pinned) return Promise.resolve(false);
      const nextId = viewAfterClose(state, viewId);
      return navigate(getWorkspaceView(state, nextId), "close-view", true, viewId, () => store.getState().close(viewId));
    },
  };
  const restored = viewFromHref(history.location.href, store, defaultLocale);
  const ready = navigate(restored === undefined || restored === null ? getWorkspaceView(state, state.activeViewId) : restored, "restore", true);
  return { router, navigation, ready, dispose: () => {
    disposed = true;
    cancelAuthorization?.();
    if (pending) finish(pending, false);
    unblock();
    unsubscribe();
    if (!suppliedHistory) history.destroy();
  } };
}

export type WorkspaceNavigation = ReturnType<typeof createWorkspaceRouter>["navigation"];
