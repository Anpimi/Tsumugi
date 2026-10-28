# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow the [Versioning Policy](docs/versioning.md).

## [Unreleased]

Current workspace version metadata: **`0.2.0-alpha.1`**. Because the published `0.2.0-alpha.1` snapshot is frozen, newer source integrations accumulate here until the next distributed prerelease advances the version counter.

*(Includes the initial `0.1.0` development backfill from commits `e76ef39` through `7febd7e`, 2026-09-17 to 2026-10-02, alongside subsequent source integrations.)*

### Added

- A read-only decision inbox API gathers current translation candidates, resource proposals, human review, advisory findings, unresolved source mappings, unknown execution results and delivery blockers from their original records. Pages share a read basis and report bounded or unavailable sources; no inbox-specific approval or resolved state is stored. Local journal requests are checked against their original receipts without clearing input or restoring permission. Current submission observations separate work in progress from requests needing a check; missing lifecycle data is reported as incomplete. The shared inbox interface is still being connected.

- Project planning IPC can run one explicitly permitted model request against the original material preview, model destination, sharing scope, budget and expiry. It uses the existing execution and usage records; cancellation, uncertain writes, stopping and reopening cannot restore an old permission. Results are checked explanations or plan suggestions, without creating or authorizing a work plan.

- The opt-in desktop workspace adds a conversation panel for creating and selecting threads, paging and saving messages, recovering local input and uncertain requests, and reading recorded planning replies and proposals by thread. Saving a message does not call a model. Select 1–16 saved messages, optionally attach 1–100 selected entries and a fixed target language, review their exact material, connection and limits, and explicitly send one planning question with no automatic retries. The attached set keeps its original exclusions as filters change. Sharing options control the included terms and context; current translation text is not sent. The original request reaches the local journal before submission; an uncertain result stays available for receipt checks without being sent again.

  A valid suggestion can be saved as a proposal, edited locally, and saved as a new immutable version. History stays readable, newer local edits are retained during a save, and an externally changed version requires an explicit comparison and choice before continuing. A saved version can be used to prepare and explicitly confirm a work plan after reviewing its materials, permissions and duration. Confirmation does not start execution.

  The panel can show a linked plan’s status, the most recently started work and accumulated model usage, and explicitly start, pause, stop, or take over the plan. Progress belongs to that recorded start; a later continuation confirmation alone does not replace it.

  For an ordinary started plan, expand **View generated results** to read its recorded translations and statuses, then open a saved candidate in the entry to handle it through the existing draft and review controls. Results are paged, pending or invalid entries do not hide other results, and reading again does not send another model request. Team member progress and results are not yet shown.

  Ordinary paused or taken-over plans can be continued after a fresh review; team and MCP plans use their dedicated recovery flow or a new plan. Start requires the direct confirmation receipt retained in the current session.

- Core stores immutable conversation proposal revisions from successful, valid planning proposal results, retaining references to the original result and digests. Human adjustments create new revisions with conflict checks; requests and receipts support recovery of the original action. Current materials are checked on creation, revision, or explicit validation, while stale history remains readable.

- Core, desktop IPC, and the frontend command adapter provide a path to prepare and explicitly authorize a work plan from an exact proposal revision. Confirmation retains the full human confirmation evidence and links the revision to the existing work-plan authorization and receipt. Stale revisions, stale materials, and unresolved questions cannot be authorized. Each authorized plan has its own budget and remains fixed if the proposal changes. Recovery reads history without renewing permission or replaying work. The conversation panel shows confirmation links as history; they do not establish that a plan is active or its permission still valid. Planning permission does not authorize execution.

- Schema 65 upgrades valid schema 61, 62, 63, or 64 projects in one transaction while preserving existing content, conversations, planning history, proposal revisions, plans, discussions, and receipts. Planning attempts can be discovered by thread without renewing permission or replaying work. An interrupted upgrade leaves the complete original schema or complete schema 65; older clients cannot open upgraded projects.

- The opt-in desktop workspace can approve a fixed selection of up to 100 saved translations, with a full-text preview, the reviewer’s name, and per-entry results. You can stop after the current entry or reopen the batch after closing views. Uncertain results stay separate from failures; checking them never resumes the remaining approvals without a new confirmation. Existing per-entry reasons and translation drafts are kept.

- Entry issues in the opt-in desktop workspace can prepare AI meaning and style reviews, preview shared text and budgets, and record results through the existing task confirmation flow. Uncertain starts and recordings remain available after entry views close. Entry details also offer explicit permission to use source text when no translation is selected, with the reviewer and reason retained.

- Entry issues can open the exact source or translation range in the editor, including emoji and text after line breaks. Existing drafts are preserved, stale locations are rejected, and returning keeps the original issue scope without rerunning checks.

- The opt-in desktop workspace adds rule-check preparation, per-checker execution consent, and recovery of the original check after entry views close. Issues support waivers for eligible required findings and rejection, restoration, or repair requests for advisory findings. Entry history shows recorded reviews, checks, waivers, and source fallbacks alongside translation versions.

- The opt-in desktop workspace adds human review to entry details and issues. Approvals and change requests use the selected translation, retain reasons across views, and require an explicit choice when the reviewed content changes. Uncertain submissions stay available for checking or retrying with their original contents. Review does not select translations or run QA.

- In the opt-in desktop workspace, open a saved AI candidate's original automatic-processing result, including its recorded checks and selection receipt. Reads stay tied to that revision, preserve earlier results, and do not start work or renew authorization. Current selection and QA remain separate facts.

- The opt-in desktop workspace can keep AI candidates as drafts, reject them, or restore rejected candidates across a fixed entry selection. Preview shows which entries will be skipped, including protected entries, non-AI selections, and existing drafts. Results remain visible per version, and the batch pauses when an action needs checking or a draft write is unconfirmed.

- In the opt-in desktop workspace, compare two to four saved translations, hide or reveal their sources, and reopen the same comparison. A human merge starts as a local draft with its contributing versions retained; confirmation uses the original merge checks and recovery. Entry details also offer explicit protection and release controls.

- The opt-in desktop workspace adds AI, translation-memory, and revision panels. Compare texts, keep a candidate as a local draft, and confirm it in the row editor. Rejected candidates retain the recorded name and reason, and uncertain decisions keep their original recovery actions. Source columns can compare with the previous adopted source version; the entry glyph includes local drafts, review issues, and manual protection.

- The opt-in desktop workspace adds entry status filters, a clear choice between selecting this page and all matching entries, and keyboard navigation through the editing queue. A captured selection stays fixed as filters change, and the entry table supports a full-page display when needed.

- The opt-in desktop workspace now offers translation import from the entries view. Choose the file, language, plug-in, and runtime, review the matches, and confirm individual entries or a fixed batch. Partial results and actions needing a receipt check remain visible for recovery.

- In the opt-in desktop workspace, edit translations in the active row, confirm and move to the next entry, or use focus mode. A bounded local journal stores unconfirmed input, with a shared recovery panel for drafts and uncertain confirmations. A draft is retained on disk only after its write is acknowledged. Recovery after closing and reopening a project has been observed in a native macOS build; recovery after restarting the app still needs verification. See [Local draft journal](docs/local-drafts.md) for storage and recovery limits.

- An opt-in desktop workspace with real project reads, separate entry views, bounded pagination, selection filters, search, entry details, and guarded project switching and window closing. Entries show a status glyph and manual protection; details include applicable terms and changes that need review. Pages share one read basis; content changes require a refresh before paging or freezing the filtered scope. An editing queue retains its original members while showing current entry facts. The conversation panel provides the project chat entry point.

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

- The local draft journal uses format 7 to retain work-plan start requests and up to 32 separate pause, stop, or takeover requests alongside unfinished input and other pending requests. Controls can be requested while the primary request is unresolved; each is saved before dispatch and can be checked or, when offered, explicitly retried as the same request. Recovery distinguishes a recorded action from an old request that can no longer apply, preserves other requests and newer input, and does not restore permission or automatically resubmit work. Valid formats 1–6 remain readable and upgrade atomically on the first successful write; reads do not upgrade them, and format 4, 5, and 6 payloads are not reconstructed. Older builds reject format 7 without resetting it. See [Local draft journal](docs/local-drafts.md).

- **Clearer desktop interface wording**: Revised English and Simplified Chinese labels, guidance, validation messages, and recovery feedback across the workbench, including AI workflows and context strategies.
- **Project storage schema 61**: Unified project content, execution attempts, recovery-intent associations, plugin grants, team coordination records, context strategies, and provider usage ledgers under SQLite schema **61** (`DELETE` journaling, `FULL` synchronization). Earlier development schemas and unsupported SQLite storage modes are refused on open without modifying or resetting the project directory (`PersistenceError::UnsupportedStorage` in Rust; `unsupported-schema` with `reason: "storage-mode"` over IPC). Keep older project directories intact and re-import the original source files into a new project.
- **Plugin-backed domain execution and legacy transition**: Core domain execution now requires verified SDK plugin provenance by default. The desktop app enables the transitional `legacy-desktop-domain` profile for existing built-in workflows while sharing the same Store, runtime, usage ledger, and receipt checks; plugin-bound inputs never fall back to built-in validation.
- **Pre-commit domain validation and recovery policies**: Source, translation, AI candidate, and build adoptions validate domain output before opening write transactions and re-verify scope, cancellation, and receipts atomically on commit. Interrupted operations use the effect policy recorded at enqueue time and require fresh preview/consent before repeating external calls.
- **Non-blocking project operations and shared session state**: Desktop project commands, full-text search, QA checks, and exports run on a dedicated project thread without blocking window events. Task, AI, Arena, and import progress share a coalesced session cache that reconciles missed notifications and pauses background polling in hidden views.

### Fixed

- Project update listeners retry registration without creating duplicate subscriptions. Periodic reads continue while the listener is unavailable, and a successful registration checks for changes made during the gap. Both workspaces distinguish this fallback from a failed project read and offer an explicit refresh.

- Repeating an already recorded translation save or revision selection returns its original result, including while the project is stopping, without changing the current translation. Recovery also rejects damaged save results before clearing an uncertain commit.

- **Mac Keychain and Responses handling**: Refuse protected-account access cleanly when macOS requires interactive Keychain prompts, require explicit sign-out state persistence before re-authenticating after a write failure, and treat native Responses refusal content as a failed attempt even when refusal delta events are omitted.
- **Plugin and member process diagnostics**: Preserve detailed failure phases across plugin dispatch, package staging, readiness, invocation, and post-close handling, as well as member process timeouts, crashes, and channel errors. Keep recorded generation progress visible after reference queries consume the remaining tool allowance.
- **Read-only reconciliation for uncertain operations**: Across project metadata, source and translation imports, manual translation saves, glossary/context edits, review decisions, QA checks, waivers, AI requests, Arena rounds/merges, task cancellation/resumption, builds, and exports, uncertain or interrupted IPC acknowledgements are reconciled through read-only checks of the original request without automatically replaying writes. Explicit retry is enabled only after confirming the original operation did not take effect, and anonymous resume/retry IPC calls are rejected.
- **Workspace draft and state preservation**: Preserve unsaved drafts, search filters, cursor positions, fixed previews, and pending confirmations when switching views, unmounting inactive panels, or handling late responses. Saving in the background updates the edit baseline without overwriting newer user typing, and closing or switching projects checks all views for unfinished work.
- **Removed target languages and source entries**: Keep existing drafts and pending reconciliations accessible when a target language is removed while blocking new writes for that language. Preserve historical translations, QA results, and review decisions for source units removed in upstream updates while excluding them from active editing and build readiness.
- **Wire contract validation and numeric precision**: Validate all IPC responses, notifications, and error payloads against generated Rust schemas, reject non-canonical revision strings (such as signed or zero-padded numbers), and preserve full integer precision and exact decimal string counters across Rust and TypeScript.
- **Format and editor edge cases**: Fix editor keyboard shortcuts during IME composition and modal dialogs, source import size/type diagnostics, caption cue ordering, UTF-8 byte boundary handling across CJK/emoji/CRLF/BOM inputs, and upstream timing/layout impact calculation.
