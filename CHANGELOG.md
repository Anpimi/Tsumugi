# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow the [Versioning Policy](docs/versioning.md).

## [Unreleased]

Current workspace version metadata: **`0.2.0-alpha.1`**. Because the published `0.2.0-alpha.1` snapshot is frozen, newer source integrations accumulate here until the next distributed prerelease advances the version counter.

*(Includes the initial `0.1.0` development backfill from commits `e76ef39` through `7febd7e`, 2026-09-17 to 2026-10-02, alongside subsequent source integrations.)*

### Added

- **macOS & Windows desktop workbench**: Native desktop builds for Windows x64 and macOS (Apple Silicon and Intel targets) with English and Simplified Chinese UI, project creation/opening/renaming/closing, recent-project path reconciliation, editable target locales, descriptor-based file authorization, and `Ctrl+S` / `Cmd+S` editor shortcuts.
- **SMAPI and WebVTT localization workflows**:
  - SMAPI source import from `manifest.json` and flat JSONC `i18n/default.json`, plus translation import and preview for `i18n/<locale>.json`.
  - Upstream source comparison, content identity continuation, per-language impact estimates, snapshot history, and append-only lineage corrections that preserve earlier translations and releases.
  - Experimental WebVTT caption profile 1 supporting source updates, translation editing, review, and local `.vtt` export while preserving timing, cue settings, cue IDs, and non-text bytes.
- **Translation editor, glossary, and review**:
  - Persistent translation editor with full-project search across native keys, source text, and active translations; continuous previous/next and save-and-next navigation across pages; and side-by-side reference panels for terms, context, and revision history.
  - Project glossary imports, unit context capture, translation memory suggestions, and impact tracking for changed terms or context.
  - Human review approvals and change requests, non-blocking QA check runs, scoped waivers, work queues, and per-language build-readiness assessments.
  - Verified SMAPI language-file builds, immutable release records, and local folder export with destination checks and overwrite confirmation.
- **AI translation, Arena, and Agent work plans**:
  - Configurable OpenAI-compatible Chat Completions connections with explicit data-sharing previews, request budgets, rate limiting, durable request reservations, and candidate saving.
  - Separate macOS ChatGPT subscription sign-in with OpenID verification, Keychain-backed credential storage, and Responses API execution through Pi without a hard output-token cap.
  - Arena comparison for two to four generated schemes or saved candidates, supporting optional blind labels, explicit identity reveal, and manual merges with provenance tracking.
  - Multi-step Agent work plans powered by `pi-agent-core` and `pi-ai` (`1.3.0`, member protocol 4), supporting dynamic team discussions, read-only capability and MCP tools, bounded time and request budgets, human guidance or takeover, and project-local context-strategy experiments.
- **Plugin SDK, standalone Host, and desktop plugin management**:
  - Standalone `tsumugi-plugin-sdk` crate with Rust data contracts, a conformance CLI, synthetic examples, and generated JavaScript bindings.
  - Standalone `tsumugi-plugin-host` crate with package and runtime inspection, local Store and TUF offline trust management, and isolated Native/JavaScript worker channels, plus optional Core and Pi member adapters.
  - Desktop plugin management and per-project domain selection with independent package and runtime approvals for source/translation import, QA checks, builds, and artifact verification.

### Changed

- **Clearer desktop interface wording**: Revised English and Simplified Chinese labels, guidance, validation messages, and recovery feedback across the workbench, including AI workflows and context strategies.
- **Project storage schema 61**: Unified project content, execution attempts, recovery-intent associations, plugin grants, team coordination records, context strategies, and provider usage ledgers under SQLite schema **61** (`DELETE` journaling, `FULL` synchronization). Earlier development schemas and unsupported SQLite storage modes are refused on open without modifying or resetting the project directory (`PersistenceError::UnsupportedStorage` in Rust; `unsupported-schema` with `reason: "storage-mode"` over IPC). Keep older project directories intact and re-import the original source files into a new project.
- **Plugin-backed domain execution and legacy transition**: Core domain execution now requires verified SDK plugin provenance by default. The desktop app enables the transitional `legacy-desktop-domain` profile for existing built-in workflows while sharing the same Store, runtime, usage ledger, and receipt checks; plugin-bound inputs never fall back to built-in validation.
- **Pre-commit domain validation and recovery policies**: Source, translation, AI candidate, and build adoptions validate domain output before opening write transactions and re-verify scope, cancellation, and receipts atomically on commit. Interrupted operations use the effect policy recorded at enqueue time and require fresh preview/consent before repeating external calls.
- **Non-blocking project operations and shared session state**: Desktop project commands, full-text search, QA checks, and exports run on a dedicated project thread without blocking window events. Task, AI, Arena, and import progress share a coalesced session cache that reconciles missed notifications and pauses background polling in hidden views.

### Fixed

- **Mac Keychain and Responses handling**: Refuse protected-account access cleanly when macOS requires interactive Keychain prompts, require explicit sign-out state persistence before re-authenticating after a write failure, and treat native Responses refusal content as a failed attempt even when refusal delta events are omitted.
- **Plugin and member process diagnostics**: Preserve detailed failure phases across plugin dispatch, package staging, readiness, invocation, and post-close handling, as well as member process timeouts, crashes, and channel errors. Keep recorded generation progress visible after reference queries consume the remaining tool allowance.
- **Read-only reconciliation for uncertain operations**: Across project metadata, source and translation imports, manual translation saves, glossary/context edits, review decisions, QA checks, waivers, AI requests, Arena rounds/merges, task cancellation/resumption, builds, and exports, uncertain or interrupted IPC acknowledgements are reconciled through read-only checks of the original request without automatically replaying writes. Explicit retry is enabled only after confirming the original operation did not take effect, and anonymous resume/retry IPC calls are rejected.
- **Workspace draft and state preservation**: Preserve unsaved drafts, search filters, cursor positions, fixed previews, and pending confirmations when switching views, unmounting inactive panels, or handling late responses. Saving in the background updates the edit baseline without overwriting newer user typing, and closing or switching projects checks all views for unfinished work.
- **Removed target languages and source entries**: Keep existing drafts and pending reconciliations accessible when a target language is removed while blocking new writes for that language. Preserve historical translations, QA results, and review decisions for source units removed in upstream updates while excluding them from active editing and build readiness.
- **Wire contract validation and numeric precision**: Validate all IPC responses, notifications, and error payloads against generated Rust schemas, reject non-canonical revision strings (such as signed or zero-padded numbers), and preserve full integer precision and exact decimal string counters across Rust and TypeScript.
- **Format and editor edge cases**: Fix editor keyboard shortcuts during IME composition and modal dialogs, source import size/type diagnostics, caption cue ordering, UTF-8 byte boundary handling across CJK/emoji/CRLF/BOM inputs, and upstream timing/layout impact calculation.
