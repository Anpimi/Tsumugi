# Workbench preview

## Desktop workspace

The new desktop entry reads existing project folders through the application's normal Core and Host commands. It supports entry views, project-wide text search, language selection, filters for entries with or without a selected translation, and details. An explicitly selected empty translation belongs to the selected filter. Each view keeps its own unsubmitted search and position; views share the project's read cache. Project switching and window closing go through the existing session exit checks.

```sh
pnpm --dir apps/desktop tauri:workbench
```

This entry uses a separate application identifier and local preferences. It does not migrate project storage or replace the default desktop entry. Open an existing project folder; there is no project creation or editing in this entry yet. Agent chat, review actions, delivery, and durable draft recovery are still being connected. The browser build explains that project files require the desktop app.

```sh
pnpm --dir apps/desktop build:workbench
```

Pages use opaque cursors tied to a fixed query and read basis. A content change or expired scope requires an explicit refresh; paging never silently captures a different result set. Each page response contains at most 100 rows and 256 KiB of encoded JSON. Text previews contain at most 256 Unicode scalars and report truncation; details keep the complete text. The Core reuses its current review projection and scope capture. Candidate, protection, applicability, and terminology summaries are not part of this first read contract yet.

## Visual samples

This development preview shows the entry table with an Agent panel, the decision inbox, delivery, and a run document. It uses display fixtures. Typing and navigation work locally; confirmation, model requests, file operations, and permission changes are disabled. Closing the preview discards its input.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/desktop dev:workbench-preview
pnpm --dir apps/desktop storybook
```

Open `http://127.0.0.1:1421/workbench-preview.html`. Choose a screen with `screen=entries|decisions|delivery|runs`, a theme with `theme=light|dark`, and an interface language with `lng=zh-CN|en-US`. `fontScale=2` doubles text size. Entry samples also accept `state=empty|loading|error|conflict|pending|unknown`.

Storybook offers the same screens and component states, with controls for theme, language, and text size. Review at 1280×800 and 960×640. Below 1100px the Agent panel opens as a drawer; below a 760px content width the source and translation stack vertically.

```sh
pnpm --dir apps/desktop build:workbench-preview
pnpm --dir apps/desktop build-storybook
pnpm --dir apps/desktop lint:workbench
pnpm --dir apps/desktop check:workbench-contrast
```

The preview has its own HTML entry and build output. The desktop application's production entry still uses the existing UI. Shared components live in `src/design-system`; screen samples live in `src/app-v2/preview`. Screen code uses shared controls, semantic colors, and type tokens. ESLint and Stylelint enforce those limits in the new screen directory.

The contrast check reads the actual theme tokens. Tertiary text is limited to plain surfaces; selected and hovered row metadata uses secondary text. Untranslated status marks use the non-text contrast threshold. This keeps the original palette while making text readable on each background.

Browser samples do not establish native window, screen-reader, or physical IME behavior. They also do not prove that project reads, confirmation, draft recovery, or model execution have been connected.
