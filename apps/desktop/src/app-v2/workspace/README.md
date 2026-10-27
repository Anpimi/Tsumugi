# Workspace state and navigation

Create a new `createWorkspaceStore({ initialLocale })` for each opened project session. A view contains only display choices: its language, submitted query, unfinished search input, row selection, scroll position, page position, focused row and right panel. Project reads, editable translation drafts, pending writes and grants stay with their existing owners.

`query` is the submitted search. `searchInput` keeps unfinished typing when switching tabs. `scroll` is `{ top, left }`, `selection` is `string[]`, `focus` is a row ID or `null`, `dock` is `"agent" | "details"`, and `afterOrdinal` is the page position. Two tabs can show the same entity while keeping these choices separate. They must still share the same entity draft and project reads.

## Connect the router

`createWorkspaceRouter({ store, gate, guard, onError, component })` returns `router`, `navigation`, `ready` and `dispose`. Pass `router` to TanStack's `RouterProvider`; `component` renders the current work surface. Wait for `ready` before treating the initial address as restored.

The default is TanStack's hash history, which works without a web server rewriting URLs. Only the view ID, kind, language, preset, submitted query and focused row go in the address. The already-open project session supplies the project context. A URL cannot restore a project session, scope capture, grant or consent. Browser back and forward go through the same guard as buttons and router links.

The guard receives `{ kind, viewId, from, to }` and `current()`. Connect it to the project lifecycle owner's `prepareLeave(intent, current)`, which returns a temporary `SessionExitPermit` or `null`. The workspace holds that permit until the history notification commits the display change, checks both `current()` functions immediately before committing, and releases it afterwards. Closing a tab uses the same guard. Closing a project or window still belongs to the project lifecycle controller.

Use these methods from controls:

- `navigation.open({ kind, locale, ... })` opens another view.
- `navigation.activate(viewId)` switches tabs.
- `navigation.update(viewId, patch)` changes language, query, preset or focused row through the guard.
- `navigation.close(viewId)` closes an unpinned tab. Closing the active tab selects its right neighbour, then its left neighbour. Closing the last tab leaves the project open.

Use `store.getState().patch(viewId, patch)` for local display memory such as unfinished search input, page position, scroll, selection and panel size. The store's low-level `open`, `activate` and `close` methods are commit operations; controls should use `navigation` so they do not skip the guard. Do not install another history blocker or use `ignoreBlocker` from a feature. The workspace already holds the lifecycle permit for its approved history commit.

Tests may inject TanStack history. Its memory history does not call blockers for back and forward in the installed version, so the navigation tests use hash history and jsdom's popstate path. That is browser simulation, not a native-window test.

## Track input and dialogs

`InteractionGate` records the visible view, the current input owner, composition, the dialog stack and one navigation intent. Call `setVisibleOwner`, `setInputOwner` and `setComposing` from explicit UI events. Call `releaseOwner` when an input unmounts. `pushDialog(id)` returns a cleanup function; only the top dialog can dispatch its own commands. This state does not grant permission to write project data.

## Use the existing command registry

`registerWorkspaceCommands` registers the shell actions in the existing `WorkbenchCommands`. It takes `commands`, `store`, `gate`, `viewId`, a real project `scope`, `getCurrentScope`, `navigation`, optional action callbacks, and `onError`. Use a separate original registry instance for each view because that registry indexes registrations by command ID. When no tab is active, register the project commands with `viewId: null` and the real project scope; `defaultLocale` lets “New entry view” work there too. No placeholder session token is needed.

Missing action callbacks remain unavailable. The callbacks for opening or closing projects and windows call the project lifecycle controller. No fake save, model or export commands are registered here. Existing business commands keep their own typed payloads and Core checks.

`createWorkspaceCommandDispatcher({ gate, getContext, modifier })` provides `list`, `dispatch` and `handleKeyDown`. `modifier` is `"meta"` or `"ctrl"`, supplied by the platform. Every menu or button captures the view ID and passes it in `dispatch(id, { viewId, source })`; a stale menu cannot silently target a different tab. A palette registered in the dialog stack also passes its `dialogId`. Keyboard events use this same dispatcher. Native menus must not duplicate those accelerators. The macOS-only Cmd+Q menu item dispatches the guarded window-close command; it never uses the native Quit item, which can bypass the frontend guard. Native menus retain the system Edit actions and restore the original Host menu on disposal.
