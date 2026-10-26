# Source import

The **Source content** view imports and maintains project source snapshots using an installed source plugin and runtime. See the [README](../README.md#development) for current database schema compatibility and the [versioning policy](versioning.md) for application release versioning.

## Preparing extensions and capturing source files

Before importing source files, open **Extensions** to review, install, and enable the source package, and independently approve and install its required runtime (the initial bundled JavaScript runtime targets Apple silicon Macs running macOS 13.5 or later). Each executable role—producer, semantic checker, and format reviewer—maintains its own `Project` or `Attempt` execution binding.

To import a source snapshot:

1. **Select format and directory**: In **Source content**, select the installed source format and runtime, choose the project's source language, and click **Choose source folder**. Directory access is granted strictly through the native OS folder picker; the package's declarative source Resource defines which relative file paths, byte limits, and revision rules apply (parsers are never inferred from plugin names or file extensions).
2. **Capture and fingerprint**: Click **Check source files** to capture and fingerprint the declared input files into the project without executing any plugin code.
3. **Extract for preview**: Review the captured file list, package/runtime identities, and requested permissions, then grant explicit execution consent (valid for up to 10 minutes) and click **Import for preview**. The extractor plugin processes the captured bytes stored in the project rather than rereading the external filesystem. Note that plugin child processes run under your current OS user account and are not sandboxed at the OS kernel level.
4. **Run mandatory source checks and apply**: A successful extraction produces a saved source proposal. Click **Review independent check execution** to prepare the proposal for the semantic checker, consent to **Run independent source checks**, and then click **Record fixed check validation**. Once Core verifies that both the extraction and mandatory semantic checks succeeded under valid grants, confirm and apply the complete source snapshot across all pages.

## Updating source content and maintaining identity

When a project already has an adopted source snapshot, use **Update source content** to capture an updated set of source files and compare it against the current snapshot:

- **Change classification**: The comparison identifies unchanged strings, same-key text edits, reordered entries, additions, removals, candidate renames, and ambiguous (`1:N` or `N:1`) mappings. Identical text under a different key is surfaced as a candidate rename and requires a reviewer's name and reason to confirm or reject; unresolved or rejected items become new content units.
- **Continuation rules**: Under the versioned revision policy, an unchanged string with the same key keeps its content unit, source revision, and existing translation approvals/QA even if reordered. A same-key string whose source text changed requires an explicit continuation decision to retain its content unit, and its prior translation approval and QA checks are invalidated until re-verified in **Review and QA**.
- **Impact estimation and work queue**: Before applying the update, **Review estimated impact** summarizes per-language effects across the complete snapshot. After applying, **Current translation impact** computes the exact review and QA work needed per entry and links directly to **Review and QA** and the translation editor.
- **Snapshot history and identity correction**: **Source snapshot history** retains all verified snapshots, file fingerprints, and continuation decisions. To amend an earlier identity decision, reimport the current source files, select the earlier snapshot as the historical comparison basis, and record the updated continuation or rejection decision (reimporting identical files without an identity change is rejected as a no-op).

### Optional maintenance notice

Before applying a checked source snapshot, you can optionally enable a **maintenance notice** for one target language:

- The notice option belongs to that specific source adoption action, expires after 5 minutes, and evaluates the first 100 source occurrences (which may include repeated entries).
- Applying the source snapshot and evaluating the maintenance notice succeed or fail independently: if the notice fails, stops, or is superseded by another source update, the applied source snapshot remains intact.
- Viewing a completed notice displays a read-only impact summary. Preparing or replacing an AI maintenance draft from the notice requires a fresh check and uses the standard **AI translation** preview, data-sharing, and consent flow.

## Inspecting original source records in the editor

In the translation editor, expand **Terms, context and history** to view extracted source facts, neighboring strings, and captured format metadata:

- Source details display the original native key label, captured filename, and half-open character/byte range (`UTF-8` bytes, `UTF-16` code units, or graphemes).
- Clicking **View original record** loads the full stored record text on demand (up to an 8 MiB encoded response limit, without truncating text to fit a summary page). Each read verifies that the current source snapshot and entry selection have not changed.

## Capture security and payload limits

### Native file capture guarantees

Tsumugi captures declared source files through native directory handles to prevent path traversal and concurrent tampering:
- Symbolic links, reparse points, parent-directory traversal (`..`), and duplicate physical file inputs are rejected.
- On Windows, the capture handle denies concurrent writes, renames, and deletions while files are read. On macOS, each path component is opened relative to its parent directory descriptor (`O_NOFOLLOW`, mapping `/var` and `/tmp` to `/private`), and file identities, timestamps, directory entries, and byte contents are re-verified before accepting the capture.
- Once files are captured into the project database, external source folders can be moved or deleted without affecting previews, adoption, or project reopening.

### Payload and profile ceilings

- **General pipeline limits**: Encoded source payloads are capped at 2 MiB, content exchanges at 4 MiB, complete fixed check inputs at 4 MiB, and persisted execution results at 8 MiB (counting metadata and references). Preview pages return up to 100 rows and 256 KiB per page without truncating individual strings, while editor reference pages are capped at 128 KiB.
- **Bundled Stardew SMAPI profile limits**: Expects a single Mod folder containing `manifest.json` (declaring an entry DLL or content pack; no DLL is ever executed) and a flat `i18n/default.json` localization file (UTF-8 with optional BOM, JSON comments, and trailing commas allowed; `$schema` is preserved as metadata). Duplicate or case-colliding keys, empty localization objects, split `i18n/default/` directories, archives, and inline Content Patcher files are rejected. Cumulative SMAPI limits are: 16 KiB `manifest.json`, 128 KiB combined input, 256 direct directory entries per inspected folder, 2,000 strings, 1,024-byte printable ASCII native keys, 256-byte ASCII namespace, 16 KiB per string, and 1 MiB saved source capture.

## Task persistence and recovery

Started imports run as persistent background tasks accessible in **Tasks**:

- **Lost start or apply confirmations**: If a start acknowledgement is lost or uncertain, the app queries the original saved request once in read-only mode (and **Check saved import start** repeats that check). **Retry the same import** is enabled only when the lookup confirms the request was never started. Similarly, if applying a snapshot returns an uncertain response, query the saved receipt before retrying.
- **Reopening and grant lifecycles**: Closing a project or restarting the app preserves all saved tasks, captured bytes, and receipts, and ends active execution grants. Cancelled, expired, or closed plugin grants require preparing a new authorized attempt (a cancelled checker can be re-prepared against an already captured source proposal without re-running extraction). See the [execution test-host guide](execution-test-host.md#continuation-identity-and-current-storage) for continuation storage details.

## Native fault checks

When built with the `execution-test-host` feature (absent from production builds), the source import pipeline reads one-shot fault-injection controls from a `source-fixture-control/` directory next to the executable, and retains the legacy SMAPI source fixture for isolated regression tests.

Control files (`estimate.json`, `prepare.json`, `adopt-before.json`, and `adopt-after.json`) are consumed when execution reaches the corresponding boundary:
- `{"wait":true}` writes a `.reached` marker file and pauses up to 60 seconds for a matching `.release` file.
- `{"fail":true}` returns an unconfirmed response (`outcome-unknown` after `adopt-after.json` commits, allowing you to verify that receipt lookup finds the single committed snapshot).
- Supplying a `source` object (`manifest`, `strings`, and `language`) commits a competing source snapshot through the real runner and adoption handler to test concurrent update handling. Always run fault checks against disposable synthetic projects.
