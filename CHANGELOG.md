# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow the [Versioning Policy](docs/versioning.md).

## [Unreleased]

Current workspace version metadata: **`0.2.0-alpha.1`**. Because the published `0.2.0-alpha.1` snapshot is frozen, newer source integrations accumulate here until the next distributed prerelease advances the version counter.

*(Includes the initial `0.1.0` development backfill from commits `e76ef39` through `7febd7e`, 2026-09-17 to 2026-10-02, alongside subsequent source integrations.)*

### Added

- Project settings in the opt-in workspace can rename an existing project and change its target languages, with separate saves, version checks and recovery of uncertain results. Removing a language keeps its saved translations and history. Renaming its folder requires an explicit choice. Knowledge exchange also restores the bounded, read-only TMX and TBX native file previews; full exchange import, adoption and export remain unavailable.

- The opt-in workspace provides run templates and initial team setup in a proposal draft. Configure each member’s role, connection, scope and limits before saving a new revision. The Runs activity opens recorded work plans and context experiments; saved candidates can return to their original conversation and expanded plan without restarting work.

- A project brief in the opt-in assistant reads language progress, delivery-blocking entries and the shared decision count without calling a model. Missing or inconsistent counts stay unknown. Empty projects offer source import; a retained entry position can be opened explicitly. Local recent-project preferences keep that navigation hint across sessions.

- Context experiments in the opt-in workspace can start from a saved manual edit and compare two context settings using fixed calibration and holdout entries. Review the connection, material and budget, start explicitly, check each result and record a human preference before adopting a future default. Settings, unfinished judgments and original requests stay in the shared local journal. Reopening does not resume work or restore consent. The original evaluation can be stopped through the existing task controls.

- Team plans in the opt-in workspace can allow members to ask questions. Answer with text or a listed choice, or close a question without answering. Unfinished answers and original requests stay in the local journal; a delayed result keeps newer input. Questions appear in the shared inbox and open the original conversation when one is linked. Answering also works after a plan stops and does not start work or increase its budget. The local journal upgrades to format 16 on its first successful write; older clients cannot read the upgraded journal.

- A plan's history in the opt-in workspace shows its recorded authorizations, controls, recovery steps and confirmed starts. Original attempts and saved results remain available without renewing permission. New plans capture the adopted context-strategy default for their target language without changing connection, sharing or budget settings.

- Paused or taken-over team plans in the opt-in workspace can review a new member roster and a specific follow-up task, confirm its actual request, then start it explicitly. Unfinished recovery settings, original preparation and confirmation requests, and recorded confirmations stay in the local journal. Newer input survives delayed results. Lost preparation responses can be stopped by their original request; missing records alone do not clear uncertain actions, and reopening does not restore execution permission.

- Team plans in the opt-in workspace can send guidance to a selected member and publish or reply to a discussion after reviewing the recipient, entry and text. Guidance and discussion drafts and uncertain original requests are kept locally; newer input is preserved while a result is checked. Reopening does not restore permission or resend a request. Saving a message does not mean a member has read it and does not start new work.

- Team plans in the opt-in workspace can show recorded members, work results, messages and original discussion posts. Saved translation candidates open their exact versions in the existing entry workflow. Reading team history does not restart work or restore expired permissions; incomplete pages and uncertain results remain explicit.

- Delivery in the opt-in workspace presents readiness, build, artifact checks, export and history as one checklist. Build settings stay with the project when a view is closed. Saved releases remain available for export without a model connection; failed or uncertain exports keep their original release and request for checking. Delivery issues use the same decision records as the shared inbox and open the relevant entry or original record.

- Installed reference tools are available from workspace settings, entry details and commands. Query drafts and original pending requests stay available when the panel is hidden or a view is removed. Switching providers keeps unfinished work in its original query. Plugin query and build forms use host controls, with explicit previews and separate execution consent.

- The opt-in workspace now has application settings for interface language, system appearance, model connections and shortcuts. Connection drafts survive project changes, and shortcut conflicts are checked by the existing command registry. Extensions use Installed, Discover and Sources tabs with package permission comparisons. External terminology lookup and material sharing are reachable from settings and commands, with separate consent and recovery for each operation.

- The opt-in workspace prepares a project from a native folder selection or drop, or from manually entered settings. Choose an installed source format and approved runtime, then check its declared files without running plugins or calling a model. Confirm the source language and edit the location and target languages before creation. The new project can pass the checked folder to the existing import workflow; running the import requires separate confirmation. Failed preparation or creation keeps the settings. An uncertain creation result keeps the original request and offers an explicit action to open its destination without repeating creation. The start screen shows recent opening times and supports Enter to continue the latest project.

- The opt-in workspace can import an upstream source version, review source changes and entry matches, and apply the complete version. Its Agent brief distinguishes previews, the currently applied version and historical versions. Saved source details and affected entries remain accessible without a model connection, and uncertain matches can stay unresolved while earlier human work is retained. Adopted matches can be corrected separately, with both sides’ saved translations available for comparison. Translations and approvals stay with their original entries; using a translation elsewhere requires a separate selection and review. Requests whose results are unknown are kept for checking or explicit cancellation.

- **Knowledge** in the opt-in workspace supports human-maintained character profiles, style rules and background notes alongside terms. Each item keeps its author, reason, scope and version history. Scopes can cover the project, selected source files or one entry. Explicit variants of the same item follow scope priority; conflicts and missing files remain visible. Saved changes, withdrawal and restoration check the current version, retain newer input, and keep the original request when a result needs checking. Shared context previews include the actual selected knowledge and explain omissions; provider requests include only the permitted kinds, names and content. Complete exchange import/export is still being connected.

  Term editing, scope selection and history use the saved project terms. Term proposals can be reviewed through their original actions, with confirmation before replacing manual values or stopping use of removed terms.

  Select entries and ask the assistant to suggest character, style or background material. Before sending, review what will be shared, the model and request limits. Once saved, compare each suggestion with existing material, edit its text, and choose whether to adopt, keep or reject it; a broader scope requires confirmation. The adopted version retains the person's name, reason and model provenance. Unfinished resource review input and original pending requests can be kept in the local journal. After reopening, compare again and reconfirm any broader scope before adopting.

  Browse saved translations across the project in translation memory and inspect their source, current status and review history. Choose an entry to compare with a saved translation, then place it in the usual translation draft for editing and confirmation. Replacing existing input requires confirmation. The new translation retains its reference to the original; a historical approval is not transferred to it.

- **Your decisions** in the opt-in workspace brings together pending candidates, resource proposals, saved proposal questions, reviews, source matches, uncertain results and delivery blockers. The activity badge, grouped list and Agent tray share project-wide reads and counts. When a source is bounded or unavailable, the total stays incomplete.

  Items open their exact original records and keep other tabs and input. Saved proposal questions stay grouped by proposal until a newer saved version no longer lists them; ordinary chat messages do not count as answers. Exact proposal versions can be opened beyond the first history page. Team-member questions still report incomplete coverage.

  Source results awaiting adoption keep their original result identity and paged comparison evidence. Expired producer or checker permission marks that evidence stale without renewing permission. Local requests are checked against their original receipts without clearing input or resubmitting work. In-flight requests and active exports remain progress. Interrupted or uncertain deliveries keep the original release, action and affected languages; older records can be read without choosing a directory. Checking actual destination files still requires fresh directory permission through the delivery workflow. The shared refresh notices when a delivery job ends even if its final result could not be saved.

  These reads do not store a separate approval or resolved state. Term proposals can be handled in Knowledge, source corrections in the source workflow, and delivery recovery in Delivery.

- Project planning IPC can run one explicitly permitted model request against the original material preview, model destination, sharing scope, budget and expiry. It uses the existing execution and usage records; cancellation, uncertain writes, stopping and reopening cannot restore an old permission. Results are checked explanations or plan suggestions, without creating or authorizing a work plan.

- The opt-in desktop workspace adds a conversation panel for creating and selecting threads, paging and saving messages, recovering local input and uncertain requests, and reading recorded planning replies and proposals by thread. Saving a message does not call a model. Select 1–16 saved messages, optionally attach 1–100 selected entries and a fixed target language, review their exact material, connection and limits, and explicitly send one planning question with no automatic retries. The attached set keeps its original exclusions as filters change. Sharing options control the included terms and context; current translation text is not sent. The original request reaches the local journal before submission; an uncertain result stays available for receipt checks without being sent again.

  A valid suggestion can be saved as a proposal, edited locally, and saved as a new immutable version. History stays readable, newer local edits are retained during a save, and an externally changed version requires an explicit comparison and choice before continuing. A saved version can be used to prepare and explicitly confirm a work plan after reviewing its materials, permissions and duration. Confirmation does not start execution.

  The panel can show a linked plan’s status, the most recently started work and accumulated model usage, and explicitly start, pause, stop, or take over the plan. Progress belongs to that recorded start; a later continuation confirmation alone does not replace it.

  For an ordinary started plan, expand **View generated results** to read its recorded translations and statuses, then open a saved candidate in the entry to handle it through the existing draft and review controls. Results are paged, pending or invalid entries do not hide other results, and reading again does not send another model request.

  Ordinary paused or taken-over plans can be continued after a fresh review; team and MCP plans use their dedicated recovery flow or a new plan. Start requires the direct confirmation receipt retained in the current session.

- Core stores immutable conversation proposal revisions from successful, valid planning proposal results, retaining references to the original result and digests. Human adjustments create new revisions with conflict checks; requests and receipts support recovery of the original action. Current materials are checked on creation, revision, or explicit validation, while stale history remains readable.

- Core, desktop IPC, and the frontend command adapter provide a path to prepare and explicitly authorize a work plan from an exact proposal revision. Confirmation retains the full human confirmation evidence and links the revision to the existing work-plan authorization and receipt. Stale revisions, stale materials, and unresolved questions cannot be authorized. Each authorized plan has its own budget and remains fixed if the proposal changes. Recovery reads history without renewing permission or replaying work. The conversation panel shows confirmation links as history; they do not establish that a plan is active or its permission still valid. Planning permission does not authorize execution.

- Schema 71 upgrades valid schema 61 through 70 projects in one transaction while preserving content, context notes, resource change identities, conversations, planning history, proposal revisions, plans, discussions, and receipts. The 66-to-67 transition leaves existing records unchanged; schema 68 adds optional translation reuse provenance. Schema 69 preserves published source checker proofs when later checks replace the current link; upgrades backfill only verifiable current proofs. Schema 70 records independent entry-match corrections and their closed requests without rewriting earlier source snapshots or decisions. Schema 71 adds explicitly enabled member questions and local human responses to the original team records. Existing notes are not reclassified as character, style or background resources. Historical captures and execution inputs retain their original encoding. Planning attempts remain readable without renewing permission or replaying work. An interrupted upgrade leaves the complete original schema or complete schema 71; older clients cannot open upgraded projects.

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

- The local draft journal uses format 16 to retain source-maintenance and resource drafts with their original pending requests alongside translation and conversation input. Requests are saved before dispatch, and reopening does not automatically resubmit work or restore permission. If another window changed a resource draft, compare the inputs and resolve pending requests before applying a saved version. An uncertain resource file picker remains a warning and is not reopened automatically. Valid formats 1–15 remain readable and upgrade atomically on the first successful write; reads do not upgrade them, and existing proposal edits and control requests are retained. Older builds reject format 16 without resetting it. See [Local draft journal](docs/local-drafts.md).

- **Clearer desktop interface wording**: Revised English and Simplified Chinese labels, guidance, validation messages, and recovery feedback across the workbench, including AI workflows and context strategies.
- **Project storage schema 61**: Unified project content, execution attempts, recovery-intent associations, plugin grants, team coordination records, context strategies, and provider usage ledgers under SQLite schema **61** (`DELETE` journaling, `FULL` synchronization). Earlier development schemas and unsupported SQLite storage modes are refused on open without modifying or resetting the project directory (`PersistenceError::UnsupportedStorage` in Rust; `unsupported-schema` with `reason: "storage-mode"` over IPC). Keep older project directories intact and re-import the original source files into a new project.
- **Plugin-backed domain execution and legacy transition**: Core domain execution now requires verified SDK plugin provenance by default. The desktop app enables the transitional `legacy-desktop-domain` profile for existing built-in workflows while sharing the same Store, runtime, usage ledger, and receipt checks; plugin-bound inputs never fall back to built-in validation.
- **Pre-commit domain validation and recovery policies**: Source, translation, AI candidate, and build adoptions validate domain output before opening write transactions and re-verify scope, cancellation, and receipts atomically on commit. Interrupted operations use the effect policy recorded at enqueue time and require fresh preview/consent before repeating external calls.
- **Non-blocking project operations and shared session state**: Desktop project commands, full-text search, QA checks, and exports run on a dedicated project thread without blocking window events. Task, AI, Arena, and import progress share a coalesced session cache that reconciles missed notifications and pauses background polling in hidden views.

### Fixed

- Closing the original workspace with an uncertain review result returns to its originating review controls before the shared translation reservation. A failed initial context-experiment journal read, without new input, no longer traps project exit.

- Source update summaries count moves, possible renames and uncertain matches once. Rejected or unresolved identity matches remain visible after a manual translation is saved.

- Fixed the editor losing focus or selection when an earlier confirmation completes while newer text remains in the draft.

- Fixed a conversation action that could be submitted before its original request was saved during rapid edits. Submission now waits for the previous save and confirms the new request is retained first.

- Project update listeners retry registration without creating duplicate subscriptions. Periodic reads continue while the listener is unavailable, and a successful registration checks for changes made during the gap. Both workspaces distinguish this fallback from a failed project read and offer an explicit refresh.

- Repeating an already recorded translation save or revision selection returns its original result, including while the project is stopping, without changing the current translation. Recovery also rejects damaged save results before clearing an uncertain commit.

- **Mac Keychain and Responses handling**: Refuse protected-account access cleanly when macOS requires interactive Keychain prompts, require explicit sign-out state persistence before re-authenticating after a write failure, and treat native Responses refusal content as a failed attempt even when refusal delta events are omitted.
- **Plugin and member process diagnostics**: Preserve detailed failure phases across plugin dispatch, package staging, readiness, invocation, and post-close handling, as well as member process timeouts, crashes, and channel errors. Keep recorded generation progress visible after reference queries consume the remaining tool allowance.
- **Read-only reconciliation for uncertain operations**: Across project metadata, source and translation imports, manual translation saves, glossary/context edits, review decisions, QA checks, waivers, AI requests, Arena rounds/merges, task cancellation/resumption, builds, and exports, uncertain or interrupted IPC acknowledgements are reconciled through read-only checks of the original request without automatically replaying writes. Explicit retry is enabled only after confirming the original operation did not take effect, and anonymous resume/retry IPC calls are rejected.
- **Workspace draft and state preservation**: Preserve unsaved drafts, search filters, cursor positions, fixed previews, and pending confirmations when switching views, unmounting inactive panels, or handling late responses. Saving in the background updates the edit baseline without overwriting newer user typing, and closing or switching projects checks all views for unfinished work.
- **Removed target languages and source entries**: Keep existing drafts and pending reconciliations accessible when a target language is removed while blocking new writes for that language. Preserve historical translations, QA results, and review decisions for source units removed in upstream updates while excluding them from active editing and build readiness.
- **Wire contract validation and numeric precision**: Validate all IPC responses, notifications, and error payloads against generated Rust schemas, reject non-canonical revision strings (such as signed or zero-padded numbers), and preserve full integer precision and exact decimal string counters across Rust and TypeScript.
- **Format and editor edge cases**: Fix editor keyboard shortcuts during IME composition and modal dialogs, source import size/type diagnostics, caption cue ordering, UTF-8 byte boundary handling across CJK/emoji/CRLF/BOM inputs, and upstream timing/layout impact calculation.
