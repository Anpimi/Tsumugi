# Source import

On Windows or macOS, open a new project and choose **Source content → Choose Mod folder**. The bundled `stardew-smapi` integration, version `0.1.0`, reads exactly `manifest.json` and `i18n/default.json`. It does not load Mod code, contact a service, or modify the Mod.

Confirm that the original strings use the project's source language. `default.json` does not imply English. **Check source files** is read-only. **Import for preview** captures the files again and saves a task with immutable originals. Review the files, string count, native keys, source locations and any warnings. Applying requires confirmation of the entire captured set, including pages not displayed.

When a project already has source content, choose **Update source content** to capture another complete pair of files. The comparison identifies same-key text changes, unchanged content, reordered positions, additions, removals, possible renames, and ambiguous one-to-many or many-to-one relationships. Equal text under another key is only a candidate; it never inherits identity automatically. Reviewers can confirm or reject a candidate with their name and reason. Unresolved or rejected entries become new content identities. The original snapshot, translations, decisions, and releases remain stored. Project names and target-language changes do not invalidate source confirmation; a competing source snapshot does.

The current SMAPI profile has no game-runtime context beyond the saved native key and source files. A same-key text change needs an explicit continuation decision to retain its unit, and its earlier translation approval and QA do not carry over. A same-key, same-text entry can retain its unit and source revision even when reordered. Review and QA must establish current eligibility before another release.

Search and paging change only the displayed comparison. The confirmation always covers the complete captured source, including removed entries and unresolved relationships. **Review estimated impact** shows a per-language estimate before confirmation. After adoption, **Current translation impact** derives the current qualification and all pending reasons from saved source, translation, review and resource facts. Its work-queue action opens the existing review workflow, and an entry can open its translation editor directly. Returning to Source content refreshes the same impact page. An estimate cannot grant approval or overwrite a newer translation edit.

**Source snapshot history** lists verified snapshots, original fingerprints and identity evidence. Search an earlier snapshot to inspect its native text, decisions, reviewer and reason. To correct an identity decision, import the current source package again, choose the earlier snapshot as the historical decision basis, and record an explicit continuation or rejection. You can search that fixed historical source for another item rather than relying on equal-text suggestions. Correction appends a new checked snapshot and receipt; it preserves unrelated current identities and earlier decisions, translations and releases. Reimporting identical files without an explicit identity decision is rejected as unchanged.

## Supported input

- One Mod folder, with a manifest identifying either an entry DLL or a content pack, and flat localization strings. No DLL is executed.
- UTF-8, optional BOM, JSON comments and trailing commas. Duplicate or case-colliding keys are rejected. Native keys and the manifest namespace must use printable ASCII; text can contain Unicode. Empty strings are preserved; an empty localization object is rejected.
- `$schema` is retained as editor metadata, not a string to translate. Original files are kept byte-for-byte, including comments and fields not extracted.
- Split `i18n/default/` layouts, archives, inline Content Patcher text, linked paths and other resource formats are unsupported. Build-time manifest version placeholders produce a warning; importing does not establish game compatibility.

Limits are cumulative: 16 KiB manifest, 128 KiB combined input, at most 256 direct entries in each inspected directory, 2,000 strings, 1,024-byte native keys, 256-byte namespace and 16 KiB per string. The encoded input also must fit 1 MiB and the complete encoded result 2 MiB; these limits may be reached before the string-count limit. Oversized input fails as a whole. Preview pages contain at most 100 rows and 256 KiB without truncating text.

Files are read through authorized native directory handles. Windows denies ordinary writes, renames and deletion while both input files are captured. macOS opens each path component relative to a directory descriptor without following symlinks, then checks file identities, timestamps, directory entries and repeated bytes before accepting the capture. Detected concurrent changes reject the capture; POSIX advisory locks are not treated as write exclusion. The system `/var` and `/tmp` aliases are mapped to their `/private` locations. Reparse points, user-controlled symlinks and duplicate physical inputs are rejected. This is not a sandbox against privileged software. The trusted in-process extractor receives only captured bytes, not project write access.

## Saved tasks and recovery

**Back** keeps an unstarted selection while the project stays open. Leaving the project asks before discarding it. Once import starts, its task and output remain available from **Tasks**. Closing a view does not cancel a persisted task. Active work participates in the existing stop-before-close or directory-move flow.

If a start acknowledgement is lost, check or resume that same import. If applying is uncertain, query its saved receipt before retrying the same action. Repeated confirmed actions return the original receipt and identities. Cancelled output can only be applied with fresh explicit authorization. Unknown execution is never replayed automatically. Failed source files should be corrected and imported as a new task.

After capture, the external Mod can be moved or removed: preview, adoption and reopening use project-owned bytes. Moving the closed project keeps content identities and receipts intact. Corrupt stored evidence and unsupported database schemas are rejected rather than repaired or shown as empty content.

See the [README](../README.md#development) for the current database schema and supported upgrades. Supported older databases receive a SQLite backup in their project directory before automatic upgrade. Other schema versions are rejected without resetting the project. Application release versions follow the [versioning policy](versioning.md).

## Native fault checks

The explicit `execution-test-host` feature reads one-shot controls from `source-fixture-control/` beside its executable. Normal builds do not contain these hooks. JSON files named `estimate.json`, `prepare.json`, `adopt-before.json` or `adopt-after.json` are consumed at that boundary. `{"wait":true}` writes a `.reached` marker and waits up to 60 seconds for the matching `.release` file. `{"fail":true}` returns an unconfirmed response. A `source` object with `manifest`, `strings` and `language` captures and commits a competing complete source through the real runner and adoption handler. Use only synthetic projects. The post-adoption failure is delivered after the real commit and returns `outcome-unknown`; the original action remains available for receipt lookup, which must find exactly one saved snapshot.
