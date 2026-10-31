# Workbench preview

## Desktop workspace

The default desktop entry opens or creates projects and provides entries, knowledge, runs, delivery, and the decision inbox. It uses the normal Core and Host commands and the application's existing project and local draft storage. The standard application identifier is `com.tsumugi.workbench`; preferences and local journals from earlier separate preview or QA profiles are not copied automatically.

```sh
pnpm --dir apps/desktop tauri dev
pnpm --dir apps/desktop build
```

The browser build explains that project files require the desktop app. For editing and local recovery, see [Translation Import and Editing](../../docs/translation-import.md) and [Local draft journal](../../docs/local-drafts.md). For work plans, reviews and delivery, see [Agent Work Plans](../../docs/work-plans.md), [Review and QA](../../docs/review-qa.md) and [Local Build and Export](../../docs/build-release.md).

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

The visual preview has its own HTML entry and build output; the desktop application's production entry opens the workspace described above. Shared components live in `src/design-system`; screen samples live in `src/app-v2/preview`. Screen code uses shared controls, semantic colors, and type tokens. ESLint and Stylelint enforce those limits in the new screen directory.

The contrast check reads the actual theme tokens. Tertiary text is limited to plain surfaces; selected and hovered row metadata uses secondary text. Untranslated status marks use the non-text contrast threshold. This keeps the original palette while making text readable on each background.

Browser samples do not establish native window, screen-reader, or physical IME behavior. They also do not prove that project reads, confirmation, draft recovery, or model execution have been connected.
