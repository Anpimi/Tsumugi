# Component reference candidates

The isolated Storybook presents editing, release readiness and package permission
workspaces with public corpus excerpts and synthetic translation examples. It
does not call native bridges, install packages, record approval or write projects.
Its light and dark themes are design candidates, not production theme changes.

Run `pnpm install --frozen-lockfile` from the repository root, then
`pnpm --dir apps/desktop storybook`. The server binds only `127.0.0.1:16061` and
refuses to silently choose another port. The launcher disables Storybook telemetry
before its CLI starts. `pnpm --dir apps/desktop build:storybook` creates
`apps/desktop/storybook-static`; this directory is ignored and is not part of the
desktop bundle.

For an immutable local comparison, build the references and run
`pnpm --dir apps/desktop exec vite preview --outDir storybook-static --host 127.0.0.1 --port 16061 --strictPort`.
Stop the reference development server before using the same port. This previews
the built references without file watchers; rebuild before comparing changes.

The Stories panel contains the three workspaces, empty/search/loading/error,
permission, dirty/saving/conflict/unknown and partial examples. Controls select
light/dark, Chinese/English interface labels and 100%/200% text scale. Compare
1280×800 and 960×640 viewports. Text scale is a reference control, not evidence of
physical system DPI or browser zoom behavior.

The editor intentionally permits newer input while its local save simulation is
pending. A submitted A becoming saved must leave newer B unsaved. Changing a
story scenario resets its fixture; ordinary typing and theme/language changes
do not reset the draft. Saved, selected, human approved and QA passed are distinct
labels. Release blockers have an entry link; previous output remains visible.
Package approval shows only an approved-state layout, with no installation or
execution. All actions identify their preview scope.

Source excerpts come from the existing
`crates/core/tests/fixtures/stardew-lookup/i18n/default.json` corpus; that file is
JSONC with a BOM, not a plain JSON document. Candidate styles are scoped under
`.state-workbench`, keep the existing application mark and system fonts, and use
the existing Lucide family. They are not imported by the application entry point.

Build, token checks, rendered checks and native acceptance are separate evidence.
These references are not adopted designs and do not establish application,
accessibility, physical IME, platform or release acceptance. Development tooling
and unadopted references do not change the current application alpha version or
require a user-facing changelog entry by themselves.
