# Translation import and editing

Choose **Translations** in the sidebar to open the translation editor in the main workspace, or import existing localized files to match and adopt into your project. All saved imports, candidates, and revision histories are stored in the project's SQLite database; see the [README](../README.md#development) for current database schema compatibility.

## Editing translations manually

The **Translations** workspace displays a searchable, paged list of source entries alongside the active entry's editor:

- **Search and navigation**: Filter across the current source snapshot by native key, source text, or selected translation. Paging or searching does not alter confirmed batch selections. Use **Previous** and **Next** to move between entries on the current page. Switching to another workspace and returning preserves your active search query, page, and selected entry (automatically refreshing source and selection state if no unsaved draft is open, while keeping any text typed during a refresh).
- **Saving revisions**: Press **Save revision** (or `Ctrl+S`) to record a new immutable manual revision and select it as the active translation for that unit and target locale (empty strings are permitted, and you can re-select an earlier revision from history at any time without deleting newer revisions). Expand **Terms, context and history** to inspect applicable glossary terms, context notes, and prior revisions.
- **Draft protection and recovery**: Typing while an earlier save is still in flight keeps your newer text as a separate unsaved draft. If a save acknowledgement is lost or uncertain, retry the action to reconcile its receipt before leaving; if another revision was selected concurrently, compare the refreshed history before saving. Closing or switching projects while an unsaved draft is open prompts you to **Save and continue**, **Keep editing**, or **Discard**.

Once translations are selected, use **Review and QA** to run checks and record human approvals, and **Build and export** to generate localized output files.

## Importing existing translation files

Before importing a translation file, make sure the project has an adopted source snapshot and includes the target locale. Click **Import file** in the **Translations** view, select the source directory, choose the translation file, and confirm its mapping to your project's target locale:

- **Stardew SMAPI profile**: Select the Mod folder containing a flat `i18n/<language>.json` file (for example, `i18n/zh.json` mapped to project locale `zh-CN`). Files named `default.json`, split `i18n/` subdirectories, non-string JSON values, duplicate keys (ignoring ASCII case), unsupported encodings, and files larger than 128 KiB are rejected.
- **WebVTT caption profile**: Select the parent folder containing `translations/<canonical-locale>.vtt` (such as `translations/zh.vtt`)—do not select the `translations/` subfolder directly. Confirm a project target locale sharing the same base language. Files are capped at 128 KiB, 2,000 cues, and 16 KiB per cue payload (a valid empty `.vtt` file imports zero entries). Cues are matched strictly by explicit cue ID (with ASCII case folding) without modifying the source timeline, and the captured file must pass its mandatory semantic check before entries can be applied.

### Running the import task and previewing matches

Starting an import captures an immutable copy of the file into the project database and launches a persistent task in **Tasks** (the original file on disk is only read and can be moved or deleted afterward without affecting the saved attempt):

- **Start recovery**: If the start acknowledgement is lost or uncertain, the app checks the saved request once in read-only mode (and **Check saved import start** repeats that lookup). **Retry the same import** is offered only when the check confirms that the original request was never started.
- **Matching preview**: The preview matches imported keys against the current source snapshot (ignoring ASCII case; identical text or similar filenames never create a match on their own). It summarizes unique matches, unmatched keys, ambiguous keys, conflicts, and entries whose source has changed. If the project's source snapshot is updated after the file was captured, start a fresh import against the new snapshot.

### Adopting imported translations

From a verified import preview, you can adopt matched translations in batch or per entry:

- **Batch adoption**: **Apply unique matches** saves matched entries as unselected translation candidates by default, or optionally selects them only for entries that do not yet have a selected translation. Each entry commits individually, and the summary tracks committed, conflicted, and uncertain items (check an uncertain item's receipt before retrying).
- **Single-entry actions**: Use the row actions on any unique match to add it as a candidate, select it when no translation is currently selected, or replace an existing selection after comparing the texts. Every write re-verifies the latest source snapshot and current selection before committing, and preserves the imported file, native key, and execution provenance in revision history.
