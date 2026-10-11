# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Application versions follow the project's [versioning policy](docs/versioning.md).

## [Unreleased]

Development target: **0.2.0-alpha.1**.

This initial backfill summarizes development commits `e76ef39` through `7febd7e` (2026-09-17 through 2026-10-02), which used `0.1.0` as their development version. No historical release tags exist, so these changes form one unreleased batch without invented release versions or dates.

### Added

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

- Execution recovery uses the host-verified effect policy captured at enqueue. External operations require a fresh explicit preview or authorization; upgraded historical operations preserve uncertain exposure and do not replay automatically. Earlier AI/Arena requests without durable per-request evidence hold their full configured limit after upgrade.

- Source, translation, AI candidate, and build adoption validate domain output before opening their write transaction; commit rechecks current scope, cancellation and receipts atomically.
- Project storage now uses schema 12. Valid schema 3 through 11 projects receive a SQLite backup before automatic upgrade. Schema 1 and 2 projects from early development are unsupported; preserve their directories and create a new project to reimport their source files. Unsupported or corrupt databases are rejected without reset. Downgrading an upgraded project is not supported.
- The desktop workspace keeps view inputs and navigation context, places current guidance beside translations, and exposes task inspection and advanced build or AI details when needed.
- Application metadata now identifies the `0.2.0-alpha.1` development batch. Storage schemas, bundled integration versions, and capability/profile versions retain their independent meanings.

### Fixed

- AI generation and candidate saving keep their original preview, complete selected scope and requests across view remounts. Explicit recovery checks the original attempt or action; confirmed saves remain recorded when result reads fail, and late confirmations preserve newer settings.

- Task, Source, AI and Arena cancellation share the original request across workspace changes and remounts. Explicit retries reuse its identity, and a checked cancellation acknowledgement is kept separate from later task reads and actual worker stopping.

- Translation import preparations, fixed match previews, complete-file confirmations and original uncertain actions survive leaving their view. Checked adoption keeps newer manual input, and import, manual saves and revision selection share one write reservation. Uncertain revision selections retain their captured text and can reconcile the original action after source or language changes.

- Source content, history, identity evidence and translation impact refresh with current project facts. Paged searches retry their original filter and cursor, hidden views stop reads, and removed languages block stale navigation. Automatic comparison reads preserve fixed identity decisions and confirmation evidence; viewing current content remains separate from reading an earlier applied snapshot, including beside newer decisions retained after a late confirmation.

- Source selections, declarations, fixed previews and identity decisions survive view remounts. Original uncertain actions retain their exact request for checked recovery; preparation and adoption confirmations must match that request and its frozen unit. Confirmed application remains saved when a later content read fails, and late confirmations keep newer decisions.

- Current glossary, context, translation-memory and impact reads refresh with project changes, retain paged read recovery, and stop when their view closes. Fresh resource actions recheck their exact target and current read evidence after preparation; automatic comparison refreshes retain the original captured comparison until it is explicitly read again.

- Resource term and context drafts, captured file comparisons and fixed input evidence survive navigation and view remounts. Late saves keep newer edits; removed languages block new work while original uncertain saves, decisions and context captures can be retried with the same request. A captured file remains available when its preview read fails.

- Review fallback and waiver actions recheck the displayed entry, issue and existing exception before dispatch. Batch approvals keep their displayed confirmation scope, recheck availability before starting, and retain the stop control while an entry is being recorded.

- Build-readiness assessments keep the explicitly selected languages, refresh after relevant project changes, and show loading and retry separately. Changing the language selection or leaving the assessment prevents late reads from replacing current results or interfering with review drafts and pending actions.

- Review work queues open without waiting for summaries, show loading separately from empty results, and refresh after relevant project changes. Leaving the queue releases its view wait; a failed page can be retried at its original cursor without replacing captured review work.
- Review history loads independently of the selected entry and current evidence. Failed history pages have their own retry and first-page recovery, while new review results return to current history without replacing reasons, fixed selections or pending actions.

- Save-and-next retains newer edits and original uncertain save requests, and stops late navigation after leaving the workspace or changing the target language.

- Validate project names and target languages before saving from the leave dialog, keeping invalid drafts available to edit.

- Review reasons, reviewer details, fixed selections and original pending actions survive closing the panel or remounting its view. Late confirmations preserve newer edits, while checks and batches retain their original cancellation controls. Returning to an entry retains the content its reason refers to; changed content can be compared and explicitly accepted without losing the reason. Stale checks remain separate from current evidence, and actual project leave still requires confirmation.

- Review retains reasons and original unknown actions when a target language is removed. It blocks new work for that language, checks the scope again after waiting, and reports unstarted entries when a batch stops. An uncertain request remains reserved for exact reconciliation even after its language is restored.

- Translation drafts and their original save requests belong to the project session. Leaving the editing view keeps newer input and pending confirmations; a late save acknowledgement updates its basis without replacing edits made while saving.

- AI preparation keeps connection settings, selected scope, preview and consent when navigating between workspaces. Source, resource or sharing changes require a fresh preview and consent; late previews cannot restore obsolete preparation.

- Target-language changes recheck the active translation scope. Drafts for removed languages remain available with a return-to-settings recovery action, while new reads and writes for an unavailable language are blocked.

- Ctrl+S and Command+S save the active translation draft from its list or reference panel. Project-name shortcuts use the same required-name validation as the save button and keep invalid input available for correction. Composition, modal dialogs, pending saves and unknown outcomes prevent unintended shortcut mutations; an uncertain translation save can only be checked or retried explicitly.

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
