# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Application versions follow the project's [versioning policy](docs/versioning.md).

## [Unreleased]

Development target: **0.2.0-alpha.1**.

This initial backfill summarizes development commits `e76ef39` through `7febd7e` (2026-09-17 through 2026-10-02), which used `0.1.0` as their development version. No historical release tags exist, so these changes form one unreleased batch without invented release versions or dates.

### Added

- Task, AI, Arena and import progress share a session cache and coalesced updates. Missed notifications are reconciled from the project, and hidden views stop their own reads without cancelling running work.

- Bounded review summaries, consistent editor snapshots, and a fixed search range with continuous previous/next navigation and save-and-next across result pages.

- Review checks compute outside database transactions and the project command queue, then recheck their inputs before saving; late checks cannot replace newer translation or check evidence.

- Windows desktop application with English and Simplified Chinese interfaces, project creation, opening, renaming, closing, recent-project reconciliation, and editable target languages.
- Durable task history with cancellation, interrupted-work recovery, saved results, explicit result adoption, and safe project shutdown.
- Bounded SMAPI source import from `manifest.json` and flat JSONC `i18n/default.json`, preserving original files and requiring confirmation of the complete source snapshot.
- SMAPI translation-file preview and checked adoption, immutable manual translation revisions, per-language selections, and interrupted-save/import recovery.
- Project glossary imports, saved context, translation-memory suggestions, and resource-change impact beside the translation editor.
- Human approval and change requests, persisted QA attempts, scoped waivers, a work queue, and build-readiness checks against current project evidence.
- Verified SMAPI language-file builds, immutable releases, and local export with destination checks, explicit replacement choices, and recovery of uncertain outcomes.
- Upstream source comparison, explicit identity continuation, per-language impact estimates, snapshot history, and append-only corrections preserving earlier translations and releases.
- Experimental WebVTT caption profile 1, supporting source updates, translation editing, review, and output preserving timing, settings, cue identifiers, and non-text bytes.
- Configurable OpenAI-compatible translation requests with explicit data-sharing consent, request previews, budgets, saved candidates, partial-failure reporting, and recovery.
- Arena comparison of two to four schemes or saved candidates, blind labels, explicit identity reveal, candidate selection, and atomic manual merges with recorded contributions.
- Persistent translation workspaces with search across all current content keys, source and selected translation text; direct entry from review, source impact and Arena; and return to the originating view without losing its position.

### Changed

- Source, translation, AI candidate, and build adoption validate domain output before opening their write transaction; commit rechecks current scope, cancellation and receipts atomically.
- Project storage now uses schema 11. Valid schema 3 through 10 projects receive a SQLite backup before automatic upgrade. Schema 1 and 2 projects from early development are unsupported; preserve their directories and create a new project to reimport their source files. Unsupported or corrupt databases are rejected without reset. Downgrading an upgraded project is not supported.
- The desktop workspace keeps view inputs and navigation context, places current guidance beside translations, and exposes task inspection and advanced build or AI details when needed.
- Application metadata now identifies the `0.2.0-alpha.1` development batch. Storage schemas, bundled integration versions, and capability/profile versions retain their independent meanings.

### Fixed

- Project lifecycle responses, change notifications, execution results, source content and translations are checked against generated Rust contracts; malformed confirmations remain unconfirmed, and revision counters retain their full integer range, including source history revisions.

- Manual translation saves confirm the committed revision and the next edit basis directly, preserve newer input, and keep history refresh separate from save confirmation. Translation counters and history cursors use exact decimal strings across desktop IPC.
- Translation, resource, AI and Arena mutations retain their original action after an unrecognized or disconnected IPC response; diagnostic wording no longer decides whether an action may be retried.
- Desktop project operations, search, review and export run on a bounded project thread instead of blocking window events. Cancellation remains available while review checks run, and queued requests recheck the active session before accessing project data.
- Project lifecycle cancellation, retry intent, folder moves, stale recent paths, action feedback, and shutdown while tasks are active.
- Translation draft preservation and save ordering during navigation, return to an editor, and late responses; responsive review checks and saves.
- Editor keyboard shortcuts and workspace selection interfering with text editing or unexpectedly reopening the first item.
- Source import limits, unsupported-value feedback, identity guidance, long native keys, and retained input when reopening source updates.
- QA waiver scope and validator evidence, historical handling of late QA replies, and changed-versus-unchanged source qualification.
- Caption ordering, Unicode payload boundaries, and timing/layout semantics in upstream impact estimates.
- Arena selection preservation and recovery after an uncertain manual merge.
