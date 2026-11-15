# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow the [Versioning Policy](docs/versioning.md).

## [Unreleased]

The current workspace targets **`0.3.0-alpha.1`**. The published `0.2.0-alpha.1` snapshot remains frozen.

*(Includes the initial `0.1.0` development backfill from commits `e76ef39` through `7febd7e`, 2026-09-17 to 2026-10-02, alongside subsequent source integrations.)*

### Added

- Paired translation preparation uses the installed declaration's native file-group choosers and the original capture boundary. It captures exact translated files and the retained originals from the adopted source, shows both groups before execution, and requires separate language and process confirmations. Original single-file capture and saved inputs keep their representation.
- Checked paired translation proposals retain per-file value and display evidence through preview and candidate adoption. The preview lists every imported file, and saved revisions retain the exact value-file provenance. Existing single-file records keep their original encoding; older application snapshots cannot read the new paired projection format. Domain extraction and independent checks require matching plugin consumers.
- The experimental plugin SDK adds explicit paired translation contracts with captured original material, selected binary file groups and independent byte budgets. Original single-file schemas remain unchanged. Domain matching requires corresponding plugin consumers.

- Verified plugin releases include a companion JSON report per language with original input fingerprints, captured properties and dependencies, explicit output settings, output file identities and the exact translation/source-retention scope. Reports use the existing export preview, conflict checks and recovery. New releases use manifest version 3; older release records retain their original file sets, and older application snapshots cannot read the new representation. Opaque settings, review history and translation text are not copied into reports.
- Build staged artifacts from explicitly selected, checked and approved translations, retaining captured source text for all other entries without changing saved translations or approvals. Build review, saved details and export setup retain the scope and identify source retention; complete-build readiness and independent artifact checks remain enforced. New plugin release manifests reference the original fixed input to support large captured sources; current readers preserve earlier release records, while older application snapshots cannot read the new manifest and staged-plan versions.
- Source previews, upstream comparisons and saved source details show plugin-provided capture counts, record groups, format properties and dependencies for the complete captured selection. Empty fields and explicit empty dependency lists remain distinguishable; these details do not imply complete resource coverage or translation completion.
- Export supported local draft text separately from a project backup. The UTF-8 rescue file supports manual recovery and leaves original pending requests on the device.
- Save a committed project backup from Project settings and restore it from the welcome screen into a new folder. Restore validates a current-format copy before publishing the new project and preserves the original backup. The restored project uses a separate local draft journal.
- Source import shows the current stage, captures files after language confirmation, and prepares the independent check after extraction in the same sheet. Extraction, checker execution, and final adoption each keep explicit confirmation. A stopped check can be prepared again from the saved extraction with fresh checker consent. If the selected package or runtime becomes unavailable, source import explains which one is missing and retains the captured preparation.
- From an entry, ask the assistant to explain or revise its selected saved translation. Review the source, saved translation and sharing settings before sending. Unconfirmed editor changes stay local. Save a revision suggestion as a candidate, recover the original save, and compare it with the current translation. Suggestions based on an earlier source or saved selection remain readable for comparison, including with the original saved translation when the current entry is unavailable.
- Team members can read short excerpts of cited translation revisions and source text to fit relevant evidence into a model request. Excerpts identify the original evidence, byte position and next available position.
- Questions now save and prepare their own message through one primary action, with explicit material review before sending and a separate save-only option. Reviewed work plans offer **Confirm and start**, preserving original confirmation and start receipts for recovery; newer input, composition and focus remain protected.
- Save and replace API keys in macOS Keychain from Model connections. Keep environment-variable credentials as an explicit option, check or remove current and previous keys independently, and recover original saves without exposing or persisting key input. New captures use immutable non-secret references; existing captures never silently change identity. Saved connections use format 2 and the local draft journal uses format 19.
- Extensions reports missing or incompatible AI member files without starting workers or testing a model connection, and links to the existing included-resource setup. Source-only builds explain their missing bundled extensions; the distribution guide separates platform capabilities and provides a complete offline preparation sequence and a public manual first-run sample.

- Generate terminology proposals from an explicitly reviewed planning request. Save their exact model and entry provenance, compare them in Knowledge, and edit targets before adopting through the original resource decisions and recovery. Old proposals remain readable; saving or viewing does not run a model or adopt terms. The local draft journal uses format 19.

- Glossary proposals can be edited before adoption. The original proposal, current-term comparison and receipt remain attached; delayed or uncertain results preserve newer edits and can be checked after reopening.
- Typed team review reports can be explicitly recorded as advisory findings with their original source, translation and result. Open the original issues to reject or restore a finding, make an eligible waiver, or edit a translation; prepare a scoped Agent repair without sending it. Older conclusions remain readable without being converted into findings.
- Planning replies expose typed links to the terms shared in the original request and its entries’ saved source files. Inspect original and current term values or the file association, and locate the current entry context. Historical source links remain readable and cannot navigate as current evidence.

- Conversation mode (⌘⇧L on Mac or Ctrl+Shift+L on Windows) places the assistant in the main area, with a readable width up to 760 px and the current view beside it. Returning preserves unfinished input and the previous position. Narrow windows keep a direct return action, and moving between the drawer and inline dock retains the same conversation.

- The desktop assistant shows removable entry, language and filter context, shares its five planning commands with the command palette, and can open guidance for a recorded team member. Enter saves a message and Shift+Enter adds a line; composition input and execution consent remain separate. Completed replies support six-line folding, full-text copying and checked links to their original entries. Team discussion and recorded run states use compact summaries.

- Saved run results offer a fixed candidate-batch comparison with source, current translation and the original candidate. Both viewing and bulk adoption open that preview first; a separate confirmation adds only eligible candidates to drafts, preserving existing input, human selections and protected entries.

- Entries expose an accessible key-copy action with success and failure feedback. Shared decisions can open an exact term proposal in its existing review panel and route an execution record to its matching recovery owner; unmatched records remain available for reading.

- Entry details in the desktop workspace can edit context notes, capture saved context and adopted terms as fixed input, and inspect original source facts. Human fact corrections, rejection of inferred facts and restoration retain their history. Draft actions are distinguished from saved decisions, and recovery names the original entry without an internal ID. A saved manual translation correction can explicitly become a unit-scoped term candidate for review. Unfinished input and original uncertain requests use the existing local recovery workflow; these actions do not call a model.

- Appearance settings in the desktop workspace can set source and translation text to 14–20 px while keeping other controls at their existing size. The choice stays on the current device, and changing it preserves unfinished input.

- The visible assistant panel can create a conversation with ⌘N on Mac or Ctrl+N on Windows. The button, command palette and rebindable shortcut use the same local conversation action; creating a conversation does not call a model. An existing custom use of this shortcut keeps its assignment.

- Project settings in the desktop workspace can rename an existing project and change its target languages, with separate saves, version checks and recovery of uncertain results. Removing a language keeps its saved translations and history. Renaming its folder requires an explicit choice. Knowledge exchange also restores the bounded, read-only TMX and TBX native file previews; full exchange import, adoption and export remain unavailable.

- The desktop workspace provides run templates and initial team setup in a proposal draft. Configure each member’s role, connection, scope and limits before saving a new revision. The Runs activity opens recorded work plans and context experiments; saved candidates can return to their original conversation and expanded plan without restarting work.

- A project brief in the desktop assistant reads language progress, delivery-blocking entries and the shared decision count without calling a model. Missing or inconsistent counts stay unknown. Empty projects offer source import; a retained entry position can be opened explicitly. Local recent-project preferences keep that navigation hint across sessions.

- Context experiments in the desktop workspace can start from a saved manual edit and compare two context settings using fixed calibration and holdout entries. Review the connection, material and budget, start explicitly, check each result and record a human preference before adopting a future default. Settings, unfinished judgments and original requests stay in the shared local journal. Reopening does not resume work or restore consent. The original evaluation can be stopped through the existing task controls.

- Team plans in the desktop workspace can allow members to ask questions. Answer with text or a listed choice, or close a question without answering. Unfinished answers and original requests stay in the local journal; a delayed result keeps newer input. Questions appear in the shared inbox and open the original conversation when one is linked. Answering also works after a plan stops and does not start work or increase its budget. The local journal upgrades to format 18 on its first successful write; older clients cannot read the upgraded journal.

- A plan's history in the desktop workspace shows its recorded authorizations, controls, recovery steps and confirmed starts. Original attempts and saved results remain available without renewing permission. New plans capture the adopted context-strategy default for their target language without changing connection, sharing or budget settings.

- Paused or taken-over team plans in the desktop workspace can review a new member roster and a specific follow-up task, confirm its actual request, then start it explicitly. Unfinished recovery settings, original preparation and confirmation requests, and recorded confirmations stay in the local journal. Newer input survives delayed results. Lost preparation responses can be stopped by their original request; missing records alone do not clear uncertain actions, and reopening does not restore execution permission.

- Team plans in the desktop workspace can send guidance to a selected member and publish or reply to a discussion after reviewing the recipient, entry and text. Guidance and discussion drafts and uncertain original requests are kept locally; newer input is preserved while a result is checked. Reopening does not restore permission or resend a request. Saving a message does not mean a member has read it and does not start new work.

- Team plans in the desktop workspace can show recorded members, work results, messages and original discussion posts. Saved translation candidates open their exact versions in the existing entry workflow. Reading team history does not restart work or restore expired permissions; incomplete pages and uncertain results remain explicit.

- Delivery in the desktop workspace presents readiness, build, artifact checks, export and history as one checklist. Build settings stay with the project when a view is closed. Saved releases remain available for export without a model connection; failed or uncertain exports keep their original release and request for checking. Delivery issues use the same decision records as the shared inbox and open the relevant entry or original record.

- Installed reference tools are available from workspace settings, entry details and commands. Query drafts and original pending requests stay available when the panel is hidden or a view is removed. Switching providers keeps unfinished work in its original query. Plugin query and build forms use host controls, with explicit previews and separate execution consent.

- The desktop workspace now has application settings for interface language, system appearance, model connections and shortcuts. Connection drafts survive project changes, and shortcut conflicts are checked by the existing command registry. Extensions use Installed, Discover and Sources tabs with package permission comparisons. External terminology lookup and material sharing are reachable from settings and commands, with separate consent and recovery for each operation.

- The desktop workspace prepares a project from a native folder selection or drop, or from manually entered settings. Choose an installed source format and approved runtime, then check its declared files without running plugins or calling a model. Confirm the source language and edit the location and target languages before creation. The new project can pass the checked folder to the existing import workflow; running the import requires separate confirmation. Failed preparation or creation keeps the settings. An uncertain creation result keeps the original request and offers an explicit action to open its destination without repeating creation. The start screen shows recent opening times and supports Enter to continue the latest project.

- The desktop workspace can import an upstream source version, review source changes and entry matches, and apply the complete version. Its Agent brief distinguishes previews, the currently applied version and historical versions. Saved source details and affected entries remain accessible without a model connection, and uncertain matches can stay unresolved while earlier human work is retained. Adopted matches can be corrected separately, with both sides’ saved translations available for comparison. Translations and approvals stay with their original entries; using a translation elsewhere requires a separate selection and review. Requests whose results are unknown are kept for checking or explicit cancellation. Empty entry views provide source import directly; importer and runtime read failures retain their diagnostic details and retry action.

- **Knowledge** in the desktop workspace supports human-maintained character profiles, style rules and background notes alongside terms. Each item keeps its author, reason, scope and version history. Scopes can cover the project, selected source files or one entry. Explicit variants of the same item follow scope priority; conflicts and missing files remain visible. Saved changes, withdrawal and restoration check the current version, retain newer input, and keep the original request when a result needs checking. Shared context previews include the actual selected knowledge and explain omissions; provider requests include only the permitted kinds, names and content. Complete exchange import/export is still being connected.

  Term editing, scope selection and history use the saved project terms. Term proposals can be reviewed through their original actions, with confirmation before replacing manual values or stopping use of removed terms.

  Select entries and ask the assistant to suggest character, style or background material. Before sending, review what will be shared, the model and request limits. Once saved, compare each suggestion with existing material, edit its text, and choose whether to adopt, keep or reject it; a broader scope requires confirmation. The adopted version retains the person's name, reason and model provenance. Unfinished resource review input and original pending requests can be kept in the local journal. After reopening, compare again and reconfirm any broader scope before adopting.

  Browse saved translations across the project in translation memory and inspect their source, current status and review history. Choose an entry to compare with a saved translation, then place it in the usual translation draft for editing and confirmation. Replacing existing input requires confirmation. The new translation retains its reference to the original; a historical approval is not transferred to it.

- **Your decisions** in the desktop workspace brings together pending candidates, resource proposals, saved proposal questions, reviews, source matches, uncertain results and delivery blockers. The activity badge, grouped list and Agent tray share project-wide reads and counts. When a source is bounded or unavailable, the total stays incomplete.

  Items open their exact original records and keep other tabs and input. Saved proposal questions stay grouped by proposal until a newer saved version no longer lists them; ordinary chat messages do not count as answers. Exact proposal versions can be opened beyond the first history page. Team-member questions still report incomplete coverage.

  Source results awaiting adoption keep their original result identity and paged comparison evidence. Expired producer or checker permission marks that evidence stale without renewing permission. Local requests are checked against their original receipts without clearing input or resubmitting work. In-flight requests and active exports remain progress. Interrupted or uncertain deliveries keep the original release, action and affected languages; older records can be read without choosing a directory. Checking actual destination files still requires fresh directory permission through the delivery workflow. The shared refresh notices when a delivery job ends even if its final result could not be saved.

  These reads do not store a separate approval or resolved state. Term proposals can be handled in Knowledge, source corrections in the source workflow, and delivery recovery in Delivery.

- Project planning IPC can run one explicitly permitted model request against the original material preview, model destination, sharing scope, budget and expiry. It uses the existing execution and usage records; cancellation, uncertain writes, stopping and reopening cannot restore an old permission. Results are checked explanations or plan suggestions, without creating or authorizing a work plan.

- The desktop workspace adds a conversation panel for creating and selecting threads, paging and saving messages, recovering local input and uncertain requests, and reading recorded planning replies and proposals by thread. Saving a message does not call a model. Select 1–16 saved messages, optionally attach 1–100 selected entries and a fixed target language, review their exact material, connection and limits, and explicitly send one planning question with no automatic retries. The attached set keeps its original exclusions as filters change. Sharing options control the included terms and context; current translation text is not sent. The original request reaches the local journal before submission; an uncertain result stays available for receipt checks without being sent again.

  A valid suggestion can be saved as a proposal, edited locally, and saved as a new immutable version. History stays readable, newer local edits are retained during a save, and an externally changed version requires an explicit comparison and choice before continuing. A saved version can be used to prepare and explicitly confirm a work plan after reviewing its materials, permissions and duration. Confirmation does not start execution.

  The panel can show a linked plan’s status, the most recently started work and accumulated model usage, and explicitly start, pause, stop, or take over the plan. Progress belongs to that recorded start; a later continuation confirmation alone does not replace it.

  For an ordinary started plan, expand **View generated results** to read its recorded translations and statuses, then open a saved candidate in the entry to handle it through the existing draft and review controls. Results are paged, pending or invalid entries do not hide other results, and reading again does not send another model request.

  Ordinary paused or taken-over plans can be continued after a fresh review; team and MCP plans use their dedicated recovery flow or a new plan. Start requires the direct confirmation receipt retained in the current session.

- Core stores immutable conversation proposal revisions from successful, valid planning proposal results, retaining references to the original result and digests. Human adjustments create new revisions with conflict checks; requests and receipts support recovery of the original action. Current materials are checked on creation, revision, or explicit validation, while stale history remains readable.

- Core, desktop IPC, and the frontend command adapter provide a path to prepare and explicitly authorize a work plan from an exact proposal revision. Confirmation retains the full human confirmation evidence and links the revision to the existing work-plan authorization and receipt. Stale revisions, stale materials, and unresolved questions cannot be authorized. Each authorized plan has its own budget and remains fixed if the proposal changes. Recovery reads history without renewing permission or replaying work. The conversation panel shows confirmation links as history; they do not establish that a plan is active or its permission still valid. Planning permission does not authorize execution.

- Project records retain context notes, resource change identities, conversations, planning history, proposal revisions, plans, discussions, and receipts. Published source checker proofs remain independently readable. Entry-match corrections preserve earlier source snapshots and decisions. Glossary decisions and receipts retain edited targets.

- The desktop workspace can approve a fixed selection of up to 100 saved translations, with a full-text preview, the reviewer’s name, and per-entry results. You can stop after the current entry or reopen the batch after closing views. Uncertain results stay separate from failures; checking them never resumes the remaining approvals without a new confirmation. Existing per-entry reasons and translation drafts are kept.

- Entry issues in the desktop workspace can prepare AI meaning and style reviews, preview shared text and budgets, and record results through the existing task confirmation flow. Uncertain starts and recordings remain available after entry views close. Entry details also offer explicit permission to use source text when no translation is selected, with the reviewer and reason retained.

- Entry issues can open the exact source or translation range in the editor, including emoji and text after line breaks. Existing drafts are preserved, stale locations are rejected, and returning keeps the original issue scope without rerunning checks.

- The desktop workspace adds rule-check preparation, per-checker execution consent, and recovery of the original check after entry views close. Issues support waivers for eligible required findings and rejection, restoration, or repair requests for advisory findings. Entry history shows recorded reviews, checks, waivers, and source fallbacks alongside translation versions.

- The desktop workspace adds human review to entry details and issues. Approvals and change requests use the selected translation, retain reasons across views, and require an explicit choice when the reviewed content changes. Uncertain submissions stay available for checking or retrying with their original contents. Review does not select translations or run QA.

- In the desktop workspace, open a saved AI candidate's original automatic-processing result, including its recorded checks and selection receipt. Reads stay tied to that revision, preserve earlier results, and do not start work or renew authorization. Current selection and QA remain separate facts.

- The desktop workspace can keep AI candidates as drafts, reject them, or restore rejected candidates across a fixed entry selection. Preview shows which entries will be skipped, including protected entries, non-AI selections, and existing drafts. Results remain visible per version, and the batch pauses when an action needs checking or a draft write is unconfirmed.

- In the desktop workspace, compare two to four saved translations, hide or reveal their sources, and reopen the same comparison. A human merge starts as a local draft with its contributing versions retained; confirmation uses the original merge checks and recovery. Entry details also offer explicit protection and release controls.

- The desktop workspace adds AI, translation-memory, and revision panels. Compare texts, keep a candidate as a local draft, and confirm it in the row editor. Rejected candidates retain the recorded name and reason, and uncertain decisions keep their original recovery actions. Source columns can compare with the previous adopted source version; the entry glyph includes local drafts, review issues, and manual protection.

- The desktop workspace adds entry status filters, a clear choice between selecting this page and all matching entries, and keyboard navigation through the editing queue. A captured selection stays fixed as filters change, and the entry table supports a full-page display when needed.

- The desktop workspace now offers translation import from the entries view. Choose the file, language, plug-in, and runtime, review the matches, and confirm individual entries or a fixed batch. Partial results and actions needing a receipt check remain visible for recovery.

- In the desktop workspace, edit translations in the active row, confirm and move to the next entry, or use focus mode. A bounded local journal stores unconfirmed input, with a shared recovery panel for drafts and uncertain confirmations. A draft is retained on disk only after its write is acknowledged. Recovery after closing and reopening a project has been observed in a native macOS build; recovery after restarting the app still needs verification. See [Local draft journal](docs/local-drafts.md) for storage and recovery limits.

- The desktop workspace provides real project reads, separate entry views, bounded pagination, selection filters, search, entry details, and guarded project switching and window closing. Entries show a status glyph and manual protection; details include applicable terms and changes that need review. Pages share one read basis; content changes require a refresh before paging or freezing the filtered scope. An editing queue retains its original members while showing current entry facts. The conversation panel provides the project chat entry point.

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

- **Breaking**: Opening projects and restoring backups require SQLite schema 77. Keep older projects and backups intact, and import the original source files into a new project. The app refuses older backups before creating a restore folder.

- Saving and reading plugin releases reuse validated build and source data within each operation. Preparing source and artifact checks captures each new checker input once. Reopening projects and reading saved releases verify the original checker input against its reconstructed bytes without decoding a temporary copy. Export verifies the saved files against the preview and registers the pending delivery in one transaction. Saved releases still verify the exact original source, artifacts, and independent check.
- Source, translation, and artifact checks reuse an already decoded result when its verified input matches exactly. Reading a result from storage still checks the original bytes and digest.
- Opening projects with plugin history checks producer results, independent check links, and saved releases in the same attempt scan. It reuses verified frames and input digests within the database snapshot while checking original evidence, receipts, and artifact bytes. Original source and artifact checker frames can also be reused within that snapshot after verifying their stored bytes and associations. Saved releases reuse the checked build plan and matching decoded output when available in the same scan.
- Core uses the existing accelerated SHA-256 implementation for project evidence, review versions, and SDK artifact and invocation payload digests. Stored and wire digests retain their original values and verification.
- Opening a project verifies captured source sets with their import attempts in one database snapshot and reuses the verified revision of the current source snapshot. It still rejects orphaned source sets and mismatched capture bytes.
- Build and independent artifact checks reuse validated inputs and decoded artifact sizes within each operation. Format, digest and size checks still apply to the original bytes.

- Experimental SDK `0.1.0-alpha.7` adds a bounded, read-only capture summary with per-material counts, groups, format properties and source references. The summary describes only the declared captured projection and cannot enter source-revision semantics or authorize execution.
- Experimental SDK `0.1.0-alpha.6` avoids decoding the complete binary material again for each field, native label and context reference during one validation. Every range, material digest and subsequent validation still uses the exact captured bytes; capacity and process deadlines are unchanged.
- **Breaking**: Experimental SDK `0.1.0-alpha.9` uses Process 4 with bounded 64 KiB transport chunks; rebuild native plugins and use the matching JavaScript Host. Material and field limits are independent: up to 100,000 fields, 128 MiB per file and 256 MiB per material set, with larger encoded source, check and build budgets. Large captures avoid repeated whole-message serialization and quadratic field scans; complete original bytes and independent checks remain required. Capacity ceilings do not establish arbitrary Mod or game compatibility.

- Review and release eligibility use the current source's larger field scope. Paired translation previews can summarize results and selections beyond the ordinary request size.

- Artifact-capable source, build and mandatory review bindings can declare a format-process permission with a safe relative program path. Historical text-only bindings retain capture-only permissions; network, project-service and staged-output permissions remain outside these domain bindings. Process approval and execution stay with the existing Host and application boundaries.

- Build resource `2/1` adds bounded, explicitly selected output settings to the existing build configuration payloads. Delivery shows per-language choices and the fixed or saved values, clears stale readiness when choices change, and keeps settings tied to their exact builder. Missing or unknown choices are rejected at the SDK/Core boundary; exact historical `1/1` resources retain their original opaque configuration semantics.
- Experimental plugin SDK `0.1.0-alpha.2` introduces typed text/binary artifacts and separate source-byte coordinates. Binary digests and output limits describe decoded bytes. Rust consumers use `CapturedArtifact` and `SourceRange`; source-import declarations explicitly select UTF-8 or binary material. The affected payload contracts and generated bindings advance together. Supported text-only captures and SDK `0.1.0-alpha.1` bindings retain their original encoding and identity; older bindings cannot accept binary artifacts.
- Experimental SDK `0.1.0-alpha.3` introduces source-import resource `5/2`, which can declare bounded file sets with explicit names, extensions, counts, roles and encodings, plus a shared limit on actual captured bytes. Per-file ceilings remain independent; all groups may be optional, with at least one selected file required. SDK resolution and Core capture combine selected and fixed files into one immutable input; required sets cannot be silently skipped. Exact resources `2/2`, `3/2` and `4/2` retain their original shapes and byte-reservation rules. The desktop resolves explicit choices from native file dialogs in both project import and startup preparation, explains per-file and shared limits, and clears stale preparation when selection restarts. Format-worker integration remains separate.

- The desktop workspace is now the default application entry. The former desktop UI and separate opt-in Workbench commands have been removed; use the standard desktop development and build commands. The standard application identifier remains `com.tsumugi.workbench`. Preferences and local journals from earlier separate preview or QA profiles are not copied automatically. Selected translations can be reviewed with AI across fixed entries and languages, with per-pair choices, preview and separate consent. Team tool records expose paged original results, and Delivery history opens the full saved build evidence without choosing a new destination folder.

- The local draft journal uses format 18 to retain source-maintenance and resource drafts with their original pending requests alongside translation and conversation input. Requests are saved before dispatch, and reopening does not automatically resubmit work or restore permission. If another window changed a resource draft, compare the inputs and resolve pending requests before applying a saved version. An uncertain resource file picker remains a warning and is not reopened automatically. Valid formats 1–17 remain readable and upgrade atomically on the first successful write; reads do not upgrade them, and existing proposal edits and control requests are retained. Older builds reject format 18 without resetting it. See [Local draft journal](docs/local-drafts.md).

- **Clearer desktop interface wording**: Revised English and Simplified Chinese labels, guidance, validation messages, and recovery feedback across the workbench, including AI workflows and context strategies.
- **Project storage schema 61**: Unified project content, execution attempts, recovery-intent associations, plugin grants, team coordination records, context strategies, and provider usage ledgers under SQLite schema **61** (`DELETE` journaling, `FULL` synchronization). Earlier development schemas and unsupported SQLite storage modes are refused on open without modifying or resetting the project directory (`PersistenceError::UnsupportedStorage` in Rust; `unsupported-schema` with `reason: "storage-mode"` over IPC). Keep older project directories intact and re-import the original source files into a new project.
- **Plugin-backed domain execution and legacy transition**: Core domain execution now requires verified SDK plugin provenance by default. The desktop app enables the transitional `legacy-desktop-domain` profile for existing built-in workflows while sharing the same Store, runtime, usage ledger, and receipt checks; plugin-bound inputs never fall back to built-in validation.
- **Pre-commit domain validation and recovery policies**: Source, translation, AI candidate, and build adoptions validate domain output before opening write transactions and re-verify scope, cancellation, and receipts atomically on commit. Interrupted operations use the effect policy recorded at enqueue time and require fresh preview/consent before repeating external calls.
- **Non-blocking project operations and shared session state**: Desktop project commands, full-text search, QA checks, and exports run on a dedicated project thread without blocking window events. Task, AI, Arena, and import progress share a coalesced session cache that reconciles missed notifications and pauses background polling in hidden views.

### Fixed

- Keep export folder checks responsive by pausing background review reads on the delivery workbench. Reuse unchanged evidence when saving a verified build, and reduce history decoding and material allocations when opening large projects.
- Keep independent artifact check results responsive by pausing builder detail refreshes until the verdict is recorded. Reuse the captured checker input for progress reads and reduce duplicate work when validating large source proposals.
- Show the save action promptly after recording an independent file check. Reuse the committed build qualification and reduce repeated artifact validation on open and whole-file verification time on warm reopen for large projects.
- Reduce peak memory when opening large projects by releasing completed source check frames during history validation and comparing saved build output without making a second JSON tree.

- Keep release history and export receipts responsive after saving a build by retiring its live task reads. Read large saved execution frames with fewer copies and qualify independent checks against their original evidence.

- Preparing or checking a new build keeps verified release history available. Saved releases are revalidated when their evidence changes, and opening large projects compares stored source evidence without decoding a second copy.

- Reduce historical decoding and avoid rebuilding full plugin requests when opening projects with large plugin imports or builds. After saving a verified build, history reuses the evidence verified by that commit. Recording an export receipt keeps still-valid build history available.
- Reduce memory copies when opening projects with large saved execution inputs. Reuse validated source materials when checking import history and read saved build bindings without loading every source text again.
- Reduce historical frame decoding when opening large projects and reuse verified source-check evidence when recording an import check.

- Reopen a cleanly closed project faster in the same desktop process by checking its exact database bytes before reusing the completed history validation.

- Avoid repeatedly processing large evidence when opening a project or reading, saving, and exporting plugin releases.

- Reuse the checked review scope for plugin builds and store their frozen source only once. Older development builds cannot read new build attempts saved in this format.

- Keep repeated task details responsive for large imports. Apply captured sources within their declared material limits, including after worker permissions expire if the saved independent check passed. Cancelled or revoked work remains ineligible.

- Read large-material plugin recipes in the desktop app using the current SDK limits.

- Preparing source content for a new project while another project is open now explicitly closes the current project through its normal unsaved-work and running-operation checks before opening the folder chooser. Cancelled or unsuccessful closes never start source selection; the new project settings remain available, including when the folder chooser is cancelled.

- Closing Reference queries returns keyboard focus to the workspace when resizing hides the original entry point.

- Open the project's current saved source from the upstream import sheet after restoring a backup or opening the project without a local import receipt.
- After rereading a source match, the correction panel stops asking you to reread it and keeps your newer edits visible for confirmation.

- Delivery shows when the selected build was saved and whether it uses the project's current saved source. If a newer build is available, you can switch to it explicitly. Existing export preparation stays with its original build until you clear it or finish the export.
- Switching back to the window when the project is unchanged no longer rereads delivery history. The decision inbox also reuses its existing result when execution status is unchanged.
- Recording or checking an export updates its delivery history without rereading the saved build list.

- Canceling the replacement source-folder picker during new-project setup keeps the previous folder and its completed file check.

- The first source import preview can page through all captured entries. A page that could not be read can be retried without changing the full import scope.
- Paging through an already checked source import reuses its verified projection while rechecking the saved source and validation evidence.

- Source import offers the folder picker again after rejecting a drop of multiple items. The selected importer and runtime are retained. New-project setup shows the rejection in the project form and lets an open folder picker finish. Consecutive drops update the form in the order the host processes them. A valid folder drop into an open project can use the last available slot in the host queue.

- Adopting and editing a candidate returns keyboard focus to the translation editor when the entry is already open for editing.

- Work-plan setup explains when a proposal's project materials have changed and directs you back to the conversation to prepare a new question. Any preview and consent for the stale proposal are cleared.

- The decision inbox checks for review history in batches and reuses captured source validation during each read, reducing work during project opening and translation confirmation.

- Resource impact subsets group only the requested source entries, avoiding repeated full-scope grouping in status filters while retaining the original limits and evidence.

- Opening projects batches historical translation source bindings and action proofs while retaining every revision identity, ordinal and selection-chain check.

- The untranslated and needs review segment filters reuse current selection membership, and saved legacy QA rows share frozen source-input validation within each read, reducing repeated work while preserving current evidence and fixed scope checks.
- Segment status filters and pages reuse the source positions already established for the current list, reducing repeated source scans when reviewing large projects.
- Current review and decision views look up saved QA, approvals, and waivers by the requested entries and their review basis, reducing work as review history grows.
- Pending candidates, human review, and review findings share the bounded entry list and source positions for one Items needing a decision read, including across target languages.
- The Items needing a decision count waits for the first entries view, startup drafts for translations, conversations, source and resources, and translation confirmation to settle. Delivery keeps its own readiness and recovery checks available and reads the broader inbox only when you open Items needing a decision.
- Typing and saving a local draft, including in the recovery panel, updates the editor and its status without refreshing unrelated entry rows when their view stays the same. Changes to other drafts leave the active editor alone. The recovery button updates independently when the first draft becomes available.
- Keep the active row's unchanged source text out of translation input, paste and draft-write updates.
- While a paste is waiting for the clipboard, the affected editor actions update independently of the translation field.
- Paste exact clipboard text into a recovered translation draft on macOS. Escape cancels a pending paste and keeps the recovery panel open.
- Editing a translation updates its recovery summary without rebuilding the full local draft list.
- Update translation confirmation activity when a submission changes, removing a scan of loaded drafts from typing and local draft saves.
- Reuse the pending-request count and recovery target during draft edits.
- Publish each local draft write's result together with its saved or failed status.
- Confirm and next keeps advancing through the fixed queue when an unfocused row leaves the viewport during the save.
- Keep the native Edit menu in place and suspend workspace commands as a group when they are temporarily unavailable during paste or translation confirmation.
- Complete macOS builds bundle the pinned WebVTT and SMAPI `0.1.0-alpha.2` packages for Process 4.
- Enable the native reference commands when the project reference tools are ready. The native workspace menu also follows input composition and open dialogs.
- Update the affected buttons and menu during paste without refreshing the entry table for the temporary interaction lock.
- Avoid flashing a progress banner during quick macOS clipboard reads. Escape cancels a pending paste, and slower reads also show a Cancel button.

- Source impact and maintenance reads batch effective bindings and ancestor lookups within the original read transaction, avoiding per-entry SQL queries while retaining frozen mapping versions and unresolved-match checks.

- Match existing translations against the selected native namespace in mixed source captures, so plugin record entries remain available alongside MCM tables without crossing identity scopes.

- Delivery labels saving a completed independent check as “Save check result,” distinguishing it from running the checker again.

- Source adoption and saved source pages reuse binary byte coordinates after complete SDK validation, avoiding another full decode for every field and native label. Text coordinate conversion, captured-byte checks and authorization remain unchanged.

- Request summaries show remaining request capacity after reservations and older holds. When the provider reports no tokens for a total or detail, the summary shows that the figure is unreported. Team previews separate the shared request limit from each member’s request settings.

- Execution details retain the measured size and limit when a team model request exceeds capacity. The details explain how to reduce the shared material before preparing again.

- Assistant preparation checks the size of the complete request, including message formatting and model settings. If the request is too large, the panel shows the measured size and limit before sending.

- Installation, enablement, and runtime settings requests retain their exact last request and I/O completion state in the original package store. A caller holding that request can confirm a completed operation after the plugin owner is recreated without repeating installation, advancing the settings revision, or restoring execution grants. Previously recorded action IDs cannot be reused as new changes. Local settings advance to format 3; format 2 remains readable without rewriting it, while earlier clients refuse format 3. Incomplete operations and old snapshots without request proof remain unresolved rather than being replayed.

- Failed automatic processing in a saved run can explicitly retry its original checks and authorized effects after verifying the original generation, item, result and current permission. It does not generate a new translation. Uncertain protection changes can independently check the complete original request and receipt, even after a newer change, without resubmitting or replacing newer input.

- Loading review controls in the desktop workspace no longer interrupts an in-progress action to open candidate details. Review drafts and unfinished actions still protect project exit.

- Renaming a project folder in the desktop workspace updates the welcome screen's recent projects and Enter shortcut immediately, so closing the project can reopen its new location while retaining the saved entry position.

- Opening a dialog or side panel with its close button focused no longer makes the first Escape dismiss only that button's tooltip. Escape closes the surface and restores the opener's focus.

- Reduce repeated reads and source scans for project progress and items that need a decision, while preserving complete checks, finding history and clear indicators when results are incomplete.

- Fix ⌘S on Mac and Ctrl+S on Windows in the desktop workspace so the current editor confirms its translation. Keys already handled by another control keep their existing behavior.

- Keep the assistant save action reachable with enlarged text by scrolling message fields and recovery guidance separately from its action bar. Workspace controls wrap and compact columns grow with enlarged text to keep their labels readable. The Workbench document language now follows the interface language, including the welcome screen.

- Switching projects keeps the previous project's entry position out of the new workspace. Unfinished input remains with its original project; same-project workspace links can still restore their view.

- Keep the assistant input and save action visible at the bottom of a narrow workspace drawer while long briefs and conversation history scroll separately.

- Closing a source import sheet opened from the project menu restores mouse interaction with the workspace. Menus and dialogs now share modal pointer and focus management.

- Project brief updates no longer expire the fixed queue being edited. Selected and delivery-blocking entry counts come from one delivery assessment; unresolved source matches count as blockers, and several reasons on one entry count once.

- Closing the desktop workspace no longer blocks its own window close when the closed project session is retired. New application input during shutdown still keeps the window open with a recovery message.

- Native plugin workers allow up to 10 seconds for the startup handshake when a runtime has just been extracted. The original operation deadline, permissions and cancellation checks still apply.

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
