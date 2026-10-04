# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Application versions follow the project's [versioning policy](docs/versioning.md).

## [Unreleased]

Development target: **0.2.0-alpha.1**.

This initial backfill summarizes development commits `e76ef39` through `7febd7e` (2026-09-17 through 2026-10-02), which used `0.1.0` as their development version. No historical release tags exist, so these changes form one unreleased batch without invented release versions or dates.

### Added

- Experimental standalone plugin declaration SDK and schema/validation harness, with explicit contribution owners, exact schema/profile behavior identities, requested permissions and deterministic provider choice. Declaration validation does not activate plugins or grant runtime authority.

- The AI workbench prepares manual plans without a model, or confirms assisted generation with a fixed scope and authorization expiry. Pause, stop, manual takeover and explicitly renewed continuation preserve saved work and the original shared budget. Explicit policies select missing translations or replace captured translations only after mechanical checks and current authority, basis and protection checks. Results retain candidate and policy evidence without human approval. Reopening reads history with grants paused; uncertain controls and permitted storage retries retain their original action identities.

- Shared AI and Arena connection reuse, independent per-provider request rate limits, fair bounded scheduling, and durable request reservations with known usage and unknown exposure shown after reopening. Trusted Core child tasks inherit scope, connection settings, cancellation and ancestor budgets.

- Added macOS desktop builds and local source, translation, glossary import and verified release export, with descriptor-based file authorization and Command-key editing shortcuts.

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

- Execution recovery uses the host-verified effect policy captured at enqueue. External operations require a fresh explicit preview or authorization; uncertain external requests retain their recorded budget exposure and do not replay automatically.

- Source, translation, AI candidate, and build adoption validate domain output before opening their write transaction; commit rechecks current scope, cancellation and receipts atomically.
- Manual translation saves and selections now persist unit protection. The translation editor confirms persistent protection before enabling draft input, keeps uncertain actions for reconciliation, and releases protection only after confirming the current entry, language, source, selection and protection revision. Dirty or pending saves block release; old acknowledgements cannot clear newer protection.
- Project storage now uses schema 15 for durable work-plan authorization, human control and checked-selection policy receipts. This development build opens schema 15 only and removes automatic upgrades from earlier development schemas. Preserve previous project directories and create a new project to reimport source files. Unsupported versions, unsupported storage settings and corrupt databases are refused without conversion or reset.
- The desktop workspace keeps view inputs and navigation context, places current guidance beside translations, and exposes task inspection and advanced build or AI details when needed.
- Application metadata now identifies the `0.2.0-alpha.1` development batch. Storage schemas, bundled integration versions, and capability/profile versions retain their independent meanings.

### Fixed

- Continued AI work plans display the original shared budget, including prior requests and unresolved exposure, rather than only the new child attempt.

- Unsupported SQLite storage settings now have a distinct refusal instead of being reported as corrupt project data. The original project and its settings are preserved. Core Rust callers with exhaustive error matches must handle `UnsupportedStorage`; the desktop wire uses `unsupported-schema` with `reason: "storage-mode"`.

- IPC validation keeps both primitive integer bounds and narrower declared field constraints.

- Failed edits preserve their submitted and rejecting bases with translated recovery guidance and expandable diagnostics. Command diagnostic references correlate sanitized boundary logs, including failures before queue admission; unknown results continue to retain the original action.

- Project lifecycle responses, change notifications, execution results, source content, translations, resources, reviews, build/delivery, AI and Arena records are checked against generated Rust contracts; malformed confirmations remain unconfirmed, and revision counters retain their full integer range, including source history revisions. Malformed rejection objects also retain the original action for reconciliation, even when their error code is recognized.

- Metadata updates reject noncanonical expected revisions, including signed values and leading zeros, before writing project data.

- AI resource baselines and reported token usage retain full unsigned integer precision. Arena totals remain exact across candidates; start, comparison and merge confirmations must match the submitted attempt or action.

- Term and context saves preserve newer content and source notes when a delayed response arrives or an uncertain original action is checked again.

- Build acknowledgements confirm the submitted attempt, and export previews bind the release and destination selection. Export confirmations bind the submitted action, release and overwrite choice; delivery history cannot include a different release.

- Lost build and export confirmations retain their original request for an exact saved-result check before another action or navigation. Retrying an accepted build preserves its fixed inputs after later edits. A history refresh failure cannot replace a confirmed export or mask its original rejection.

- Review and QA responses retain their complete input evidence; decisions, checks, waivers and fallback confirmations must match the submitted action, unit and language before pending state is cleared.

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
