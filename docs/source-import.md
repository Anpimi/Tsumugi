# Source import

On Windows, open a new project and choose **Source content → Choose Mod folder**. The bundled `stardew-smapi` integration, version `0.1.0`, reads exactly `manifest.json` and `i18n/default.json`. It does not load Mod code, contact a service, or modify the Mod.

Confirm that the original strings use the project's source language. `default.json` does not imply English. **Check source files** is read-only. **Import for preview** captures the files again and saves a task with immutable originals. Review the files, string count, native keys, source locations and any warnings. Applying requires confirmation of the entire captured set, including pages not displayed.

Only the first source snapshot can be applied. Each native key receives its own content identity; equal text is not merged. Project names and target-language changes do not invalidate source confirmation. A competing source snapshot does. Existing content cannot be replaced or merged by this import.

## Supported input

- One Mod folder, with a manifest identifying either an entry DLL or a content pack, and flat localization strings. No DLL is executed.
- UTF-8, optional BOM, JSON comments and trailing commas. Duplicate or case-colliding keys are rejected. Native keys and the manifest namespace must use printable ASCII; text can contain Unicode. Empty strings are preserved; an empty localization object is rejected.
- `$schema` is retained as editor metadata, not a string to translate. Original files are kept byte-for-byte, including comments and fields not extracted.
- Split `i18n/default/` layouts, archives, inline Content Patcher text, linked paths and other resource formats are unsupported. Build-time manifest version placeholders produce a warning; importing does not establish game compatibility.

Limits are cumulative: 16 KiB manifest, 128 KiB combined input, at most 256 direct entries in each inspected directory, 2,000 strings, 1,024-byte native keys, 256-byte namespace and 16 KiB per string. The encoded input also must fit 1 MiB and the complete encoded result 2 MiB; these limits may be reached before the string-count limit. Oversized input fails as a whole. Preview pages contain at most 100 rows and 256 KiB without truncating text.

Files are read through authorized native directory handles. Ordinary writes, renames and deletion are denied while both input files are captured. Reparse points and duplicate physical inputs are rejected. This is not a sandbox against privileged software. The trusted in-process extractor receives only captured bytes, not project write access.

## Saved tasks and recovery

**Back** keeps an unstarted selection while the project stays open. Leaving the project asks before discarding it. Once import starts, its task and output remain available from **Tasks**. Closing a view does not cancel a persisted task. Active work participates in the existing stop-before-close or directory-move flow.

If a start acknowledgement is lost, check or resume that same import. If applying is uncertain, query its saved receipt before retrying the same action. Repeated confirmed actions return the original receipt and identities. Cancelled output can only be applied with fresh explicit authorization. Unknown execution is never replayed automatically. Failed source files should be corrected and imported as a new task.

After capture, the external Mod can be moved or removed: preview, adoption and reopening use project-owned bytes. Moving the closed project keeps content identities and receipts intact. Corrupt stored evidence and unsupported database schemas are rejected rather than repaired or shown as empty content.

New projects use schema 6. Valid schema 3, 4, and 5 databases receive a SQLite backup in their project directory before automatic upgrade. Other schema versions are rejected without resetting the project. This remains part of the unreleased 0.1.0 batch.
