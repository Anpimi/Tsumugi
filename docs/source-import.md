# Source import

The source import workflow imports and maintains project source snapshots using an installed source plugin and runtime. See the [README](../README.md#development) for current database schema compatibility and the [versioning policy](versioning.md) for application release versioning.

## Preparing extensions and capturing source files

Before importing source files, open **Extensions** to review, install, and enable the source package, and independently approve and install its required runtime (the initial bundled JavaScript runtime targets Apple silicon Macs running macOS 13.5 or later). Each executable role—producer, semantic checker, and format reviewer—maintains its own `Project` or `Attempt` execution binding.

When preparing a new project from the welcome screen, choose a source folder in the project form or drop one folder. Canceling the system picker keeps the previous folder and its completed file check if that selection is still current. If a drop contains multiple items, the form keeps your settings and shows how to choose again. A folder picker that is already open can still finish. When you drop several times in succession, the latest processed drop determines which folder is offered or whether the form asks you to choose again.

To import a source snapshot, choose **Import an upstream version** in the Project menu, or **Import source content** in an empty Entries view:

1. **Select format and directory**: Select the installed source format and runtime, click **Choose source folder**, and confirm the project’s source language. When the desktop receives a native folder drop, choose **Use the dropped folder**. If the drop contained multiple items, drop one folder again or use the folder picker. The importer and runtime selections stay in place. The package's declarative source Resource defines the relative file paths, byte limits, and revision rules. The application never infers a parser from plugin names or file extensions.
   If the format declares file groups, a native file dialog opens for each group after the folder is chosen. The import sheet lists each group's name, required or optional status, extensions, file count and per-file byte limit. A shared total, when declared, limits the actual bytes across all selected files. Choose files inside that folder; cancel an optional group to skip it, or cancel a required group to cancel this selection. At least one file is needed across the groups; skipping every group cancels an all-optional selection. Review the selected names before confirming the language. Starting a new selection retires the previous preparation and consent, including when the picker is cancelled or rejects the new files; other draft input is kept.
2. **Capture and fingerprint**: Confirm the source language to capture and fingerprint the declared input files. If capture needs another try, use **Check source files**. Capture does not execute plugin code.
3. **Extract for preview**: Review the captured file list, package/runtime identities, and requested permissions, then grant explicit execution consent (valid for up to 10 minutes) and click **Import for preview**. The extractor plugin processes the captured bytes stored in the project rather than rereading the external filesystem. Note that plugin child processes run under your current OS user account and are not sandboxed at the OS kernel level.
4. **Run mandatory source checks and apply**: A successful extraction produces a saved source proposal. When the extraction finishes in the same import sheet, the proposal is prepared for independent review automatically. Use **Review independent check** when returning to an existing proposal or when preparation needs another try. Review the checker and its permissions, consent to **Run independent check**, and then choose **Record this check result**. If you stop the check, wait for the stopped status, then choose **Prepare a new check for this proposal**. This reuses the saved extraction and requires fresh checker consent. If the selected package or runtime becomes unavailable, the work surface identifies the missing dependency and clears its consent. Restore the selected dependency and review again, or discard the preparation before choosing a different one. Once Core verifies that both the extraction and mandatory semantic checks succeeded under valid grants, confirm and apply the complete source snapshot across all pages.

## Reviewing the captured scope

When the source plugin supplies capture details, the preview, upstream comparison and saved source details show counts for each captured file: source records, records with declared fields, declared fields and nonempty fields. These counts cover the complete captured selection, including empty fields, even when the current page or comparison filter shows fewer entries.

Expand **Format and dependencies** to inspect the plugin's literal properties and **View record groups** to inspect its grouped counts. An explicit empty dependency list shows **None**; a plugin that supplies no capture summary shows no summary. Plugin property labels and values remain plain text in the publisher's language. These details describe the plugin's declared projection of captured material, not all resources or translation completion. Viewing them neither runs a plugin nor changes source adoption, translations or sharing permissions. Historical details retain their original saved capture information after reopening.

## Updating source content and maintaining identity

When a project already has an adopted source snapshot, use **Import an upstream version** in the Project menu to capture an updated set of source files and compare it against the current snapshot:

- **Change classification**: The comparison identifies unchanged strings, same-key text edits, reordered entries, additions, removals, candidate renames, and ambiguous (`1:N` or `N:1`) mappings. Identical text under a different key is surfaced as a candidate rename and requires a reviewer's name and reason to confirm or reject; unresolved or rejected items become new content units.
- **Continuation rules**: Under the versioned revision policy, an unchanged string with the same key keeps its content unit, source revision, and existing translation approvals/QA even if reordered. A same-key string whose source text changed requires an explicit continuation decision to retain its content unit, and its prior translation approval and QA checks are invalidated until re-verified in the entry’s **Issues** tab.
- **Impact estimation and work queue**: Before applying the update, **Review what will be kept** summarizes per-language effects across the complete snapshot. After applying, the source brief shows current impact and **View affected entries** opens the related entries for review and editing.
- **Snapshot history and identity correction**: **Source snapshot history** retains all verified snapshots, file fingerprints, and continuation decisions. To amend an earlier identity decision, reimport the current source files, select the earlier snapshot as the historical comparison basis, and record the updated continuation or rejection decision (reimporting identical files without an identity change is rejected as a no-op). For an adopted match, open its saved source details and choose **Correct this entry match** to review and record a correction; saved translations and approvals remain with their original entries.

### Optional maintenance notice

Before applying a checked source snapshot, you can optionally enable a **maintenance notice** for one target language:

- The notice option belongs to that specific source adoption action, expires after 5 minutes, and evaluates the first 100 source occurrences (which may include repeated entries).
- Applying the source snapshot and evaluating the maintenance notice succeed or fail independently: if the notice fails, stops, or is superseded by another source update, the applied source snapshot remains intact.
- Viewing a completed notice displays a read-only impact summary. Preparing or replacing an AI maintenance draft from the notice requires a fresh check and uses the standard **AI translation** preview, data-sharing, and consent flow.

## Inspecting original source records in the editor

In the entry details, open **Terms and context** to view extracted source facts and applicable context; source details also retain neighboring strings and captured format metadata:

- Source details display the original native key label, captured filename, and half-open character/byte range (`UTF-8` bytes, `UTF-16` code units, or graphemes).
- Clicking **View raw record** loads the full stored record text on demand (up to an 8 MiB encoded response limit, without truncating text to fit a summary page). Each read verifies that the current source snapshot and entry selection have not changed.

## Capture security and payload limits

### Native file capture guarantees

Tsumugi captures fixed and explicitly selected source files through the same native directory owner. File choices stay with the native selection identity and are resolved against the installed declaration before reading:
- Symbolic links, reparse points, parent-directory traversal (`..`), and duplicate physical file inputs are rejected.
- On Windows, the capture handle denies concurrent writes, renames, and deletions while files are read. On macOS, each path component is opened relative to its parent directory descriptor (`O_NOFOLLOW`, mapping `/var` and `/tmp` to `/private`), and file identities, timestamps, directory entries, and byte contents are re-verified before accepting the capture.
- Once files are captured into the project database, external source folders can be moved or deleted without affecting previews, adoption, or project reopening.

### Payload and profile ceilings

- **General pipeline limits**: The current SDK separately caps encoded source extraction inputs at 4 MiB, content exchanges at 8 MiB and combined invocation payloads at 16 MiB. Core bounds complete fixed plugin frames at 32 MiB plus 64 KiB and plugin execution results at 32 MiB; ordinary operations retain their 4 MiB input and 8 MiB result ceilings. The selected source declaration independently limits raw material bytes. A capture summary is limited to 64 KiB and still counts toward the complete exchange and preview response. Preview pages return up to 100 rows and 256 KiB per page without truncating individual strings, while editor reference pages are capped at 128 KiB.
- **Bundled Stardew SMAPI profile limits**: Expects a single Mod folder containing `manifest.json` (declaring an entry DLL or content pack; no DLL is ever executed) and a flat `i18n/default.json` localization file (UTF-8 with optional BOM, JSON comments, and trailing commas allowed; `$schema` is preserved as metadata). Duplicate or case-colliding keys, empty localization objects, split `i18n/default/` directories, archives, and inline Content Patcher files are rejected. Cumulative SMAPI limits are: 16 KiB `manifest.json`, 128 KiB combined input, 256 direct directory entries per inspected folder, 2,000 strings, 1,024-byte printable ASCII native keys, 256-byte ASCII namespace, 16 KiB per string, and 1 MiB saved source capture.

## Task persistence and recovery

Started imports run as persistent background tasks; the source preparation workflow shows their status and recovery actions:

- **Lost start or apply confirmations**: If a start acknowledgement is lost or uncertain, the app queries the original saved request once in read-only mode (and **Check the action result** repeats the relevant check). **Retry this action** is enabled only when the lookup confirms the request was never started. Similarly, if applying a snapshot returns an uncertain response, query the saved receipt before retrying.
- **Reopening and grant lifecycles**: Closing a project or restarting the app preserves all saved tasks, captured bytes, and receipts, and ends active execution grants. Cancelled, expired, or closed plugin grants require preparing a new authorized attempt (a cancelled checker can be re-prepared against an already captured source proposal without re-running extraction). See the [execution test-host guide](execution-test-host.md#continuation-identity-and-current-storage) for continuation storage details.

## Native fault checks

When built with the `execution-test-host` feature (absent from production builds), the source import pipeline reads one-shot fault-injection controls from a `source-fixture-control/` directory next to the executable, and retains the legacy SMAPI source fixture for isolated regression tests.

Control files (`estimate.json`, `prepare.json`, `adopt-before.json`, and `adopt-after.json`) are consumed when execution reaches the corresponding boundary:
- `{"wait":true}` writes a `.reached` marker file and pauses up to 60 seconds for a matching `.release` file.
- `{"fail":true}` returns an unconfirmed response (`outcome-unknown` after `adopt-after.json` commits, allowing you to verify that receipt lookup finds the single committed snapshot).
- Supplying a `source` object (`manifest`, `strings`, and `language`) commits a competing source snapshot through the real runner and adoption handler to test concurrent update handling. Always run fault checks against disposable synthetic projects.
