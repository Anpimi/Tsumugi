# Workbench components

Import components from their files. Import `global.css` once from the standalone preview entry. The production entry does not load these styles yet.

Set `data-theme="light"` or `data-theme="dark"` on `document.documentElement`. Radix menus and dialogs render outside their parent element, so setting the theme only on a preview wrapper leaves those menus in the wrong theme. Set `--font-scale` on the same root to inspect larger text; `2` doubles fonts and line heights. The default UI text is 13px and editor text is 15px. Editor settings can set `--editor-font-size` to a value from 14px to 20px.

| File | Exports and use |
| --- | --- |
| `Button` | `Button`, `IconButton`. Variants: `primary`, `secondary`, `ghost`, `danger`, `link`. Sizes: `xs`, `sm`, `md`, `lg`. `pending` prevents repeated clicks. `icon` or children accept Lucide icons. `kbd` shows the shortcut. An icon button requires a complete `label` for its tooltip and accessible name. |
| `Field` | `Field`, `TextInput`, `TextArea`. A field takes `label`, optional `description`, `error`, `required`, and one input element. It connects the label and messages to that input. A render function is also supported when the input needs a wrapper. Inputs accept native props and refs; `TextArea editor` uses the editor text size. |
| `Tabs` | `TabsRoot`, `TabsList`, `TabsTrigger`, `TabsContent` wrap Radix. `Tabs` also accepts `items`, a list `label`, and the Radix value props. |
| `Tooltip` | `Tooltip` takes one element and `content`. Keep essential instructions visible elsewhere. |
| `Menu` | `Menu` takes `trigger` and `items`. `ContextMenu` takes a child element and the same items. Items have `id`, `label`, optional `kbd`, `icon`, `disabled`, `danger`, and `onSelect`. Separators use `{ id, type: "separator" }`. |
| `StatusGlyph` | `StatusGlyph` and `StatusGlyphState`. Pass `state` and a complete `label`. `protected` adds a lock, with a separate `protectedLabel`. The component only displays the state it receives; the calling feature decides which state applies. |
| `Badge`, `Kbd`, `Spinner`, `ProgressBar` | Available from their own files, and explicitly exported by `Feedback`. Badge text uses 12px; `kind="count"` uses 11px. Progress needs a complete `label`; use `value` and `max`, or `indeterminate` when the total is unknown. It never announces a guessed percentage. |
| `Feedback` | `Banner` takes `tone`, children, and an optional `action`. `EmptyState` and `ErrorState` take `title`, `description`, and `action`; `LoadingState` takes `label`. The caller chooses when a message should announce itself with `role="status"` or `role="alert"`. |
| `TokenizedText` | `TokenizedText text={...}` highlights placeholders and tags and marks line breaks without changing the text. `tone="ai"` marks an AI proposal. `tokenizeText` returns the same text in parts for callers that need to inspect it. |
| `SplitView` | `SplitView`, `SplitPanel`, `SplitHandle` wrap `Group`, `Panel`, and `Separator` from react-resizable-panels 4. A handle requires a `label`. Props and refs follow version 4: numeric sizes are pixels, while percentage sizes must be strings such as `"65%"`. The wrapper does not save layout or open drawers. |
| `Dialog` | `Dialog` and `Sheet` take controlled `open`/`onOpenChange`, `title`, `closeLabel`, optional `description`, `trigger`, `footer`, and content. Radix manages Tab and Escape. The wrapper restores focus when opened by a separate button too. Use the Radix focus and outside-interaction callbacks when a particular action needs to keep the dialog open. |
| `CommandPalette` | Takes controlled `open`/`onOpenChange`, `title`, `placeholder`, `emptyLabel`, `closeLabel`, and `groups`. Each group has `label` and `commands`; each command has `id`, `label`, `onSelect`, and optional `keywords`, `kbd`, `disabled`. It searches and presents commands; the caller still checks whether the selected action can run. |

All user-facing strings come from the caller. Pass complete translated messages instead of joining fragments inside a component. The stories include Chinese and English text, placeholders, disabled controls, loading, errors, conflicts, and unknown progress. They show sample data and do not write a project or call a model.
