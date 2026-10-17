# Source import

Each executable source/translation role captures its own complete Project or
Attempt binding from the installed component. Producer, semantic checker and
format Review scopes may differ. An Attempt checker uses its own execution
attempt; the producer result cannot choose or widen that scope. Source, required
checks, original grants and saved validation evidence remain unchanged owners.

The Source content view uses an enabled installed source package and an independently approved installed runtime. In **Extensions**, review and install the exact package, enable it separately, and independently approve and install its supported runtime. Installation and enablement do not authorize code execution. The first captured JavaScript runtime targets Apple silicon on macOS 13.5 or later; other runtime profiles and the complete official domain-package distribution remain under development. A build without an installed supported environment explains the unavailable operation and keeps existing project content available.

Choose the installed source format and runtime, then **Choose source folder**. The native chooser authorizes the directory; requests cannot supply a directory path. The package's non-executable source Resource fixes material paths, limits, profile, revision policy, and independent extractor/checker contributions. The workbench does not select a parser by plugin name or file extension.

Confirm that the files use the project's source language. **Check source files** captures and fingerprints only the declared material. It neither runs a plugin nor grants execution permission. Review the fixed file list, exact package/runtime and requested permissions. **Import for preview** requires explicit consent to the extractor for that input and up to ten minutes. It uses those captured bytes without rereading the external source, even if the source files subsequently change.

The plugin runs as the current OS user and can access files and network outside the captured material. A child process is not an OS sandbox. Approval of the package or runtime does not substitute for this per-attempt decision.

A successful extraction creates a saved proposal; it cannot be applied yet. **Review independent check execution** prepares the complete fixed source and proposal for the exact checker and required semantic rules without running it. Separately consent to **Run independent source checks**, then **Record fixed check validation**. Core rechecks both executions and their current permissions before recording the proof. Pending, incomplete or invalid mandatory checks block application and retain the proposal. Only valid checks enable confirmation and application of the entire captured set, including pages not displayed.

When a project already has source content, choose **Update source content** to capture another complete declared set of files. The comparison identifies same-key text changes, unchanged content, reordered positions, additions, removals, possible renames, and ambiguous one-to-many or many-to-one relationships. Equal text under another key is only a candidate; it never inherits identity automatically. Reviewers can confirm or reject a candidate with their name and reason. Unresolved or rejected entries become new content identities. The original snapshot, translations, decisions, and releases remain stored. Project names and target-language changes do not invalidate the source comparison itself; an enabled maintenance notice still requires its chosen target language. A competing source snapshot invalidates source confirmation.

Identity continuation uses the saved native evidence and the fixed versioned revision policy. A same-key text change needs an explicit continuation decision to retain its unit, and its earlier translation approval and QA do not carry over. A same-key, same-text entry can retain its unit and source revision even when reordered. Review and QA must establish current eligibility before another release.

Search and paging change only the displayed comparison. The confirmation always covers the complete captured source, including removed entries and unresolved relationships. **Review estimated impact** shows a per-language estimate before confirmation. After adoption, **Current translation impact** derives the current qualification and all pending reasons from saved source, translation, review and resource facts. Its work-queue action opens the existing review workflow, and an entry can open its translation editor directly. Returning to Source content refreshes the same impact page. An estimate cannot grant approval or overwrite a newer translation edit.

**Source snapshot history** lists verified snapshots, original fingerprints and identity evidence. Search an earlier snapshot to inspect its native text, decisions, reviewer and reason. To correct an identity decision, import the current source package again, choose the earlier snapshot as the historical decision basis, and record an explicit continuation or rejection. You can search that fixed historical source for another item rather than relying on equal-text suggestions. Correction appends a new checked snapshot and receipt; it preserves unrelated current identities and earlier decisions, translations and releases. Reimporting identical files without an explicit identity decision is rejected as unchanged.

## Optional maintenance notice

Before applying checked source content, you can enable one maintenance notice
and choose its target language. It is off by default. The choice belongs to that
exact source action and expires after five minutes; replaying the action does not
extend its deadline. The notice checks the first 100 source occurrences, which
can include repeated entries. Entries beyond that window have not been assessed.

Applying source content and evaluating its notice have separate outcomes. A
failed, stopped or expired notice does not undo saved source content. The notice
records its original source snapshot and complete assessment. A competing source
update makes unfinished work superseded. Reopening the project shows saved
history without restarting a pending notice or restoring permission.

Use the original source action to inspect an uncertain notice or stop new work.
If preparation has not yet been recorded, its state remains unconfirmed; ending
a local wait does not prove it stopped. Stopping closes new admission while
already accepted work drains, and does not cancel the source adoption itself.

Viewing a notice shows read-only saved impact. It does not change the AI draft
or its language. Creating or explicitly replacing a maintenance draft requires a
fresh check and respects current Source and AI edits and unresolved operations.
The existing AI workbench still requires its own plan, preview, sharing choices
and execution consent. The notice does not run a model, plugin or worker, select
translations, grant approval or publish a release.

## Inspect original source records

In the translation editor, expand **Terms, context and history** to read source
facts, neighboring text and additional captured source information. Choose
**View original record** for an additional record to load its complete stored
text, such as the original settings associated with a subtitle cue. Source
details identify its scope and captured format. This advanced reference is
read-only; viewing remains local under the existing separate AI sharing controls.

Each record is checked against the current source snapshot and entry before it
is read. Changing the source or selected entry keeps newer translation drafts
and prevents an earlier response from appearing under the new entry. Unavailable
records offer a retry in place. Ordinary reference pages contain descriptions;
the full text is loaded only when a record is opened and is never truncated to
fit a page. Existing source capture and format limits still apply.

## Materials and limits

Supported format semantics and material paths come from the selected package. Native capture rejects links, path traversal, observed replacement and duplicate physical inputs; files must meet their declared byte limits and the shared encoded capture budget. Unsupported or incomplete inputs fail as a whole. Source payloads have a 2 MiB encoded ceiling, content exchanges a 4 MiB ceiling, the complete fixed check input a 4 MiB ceiling, and the stored execution result an 8 MiB ceiling. Metadata and references count toward these limits. Preview pages contain at most 100 rows and 256 KiB without truncating text.

Editor reference pages retain their separate 128 KiB ceiling. One explicitly
opened source record uses a separate 8 MiB encoded response limit, including its
source identity; this local read limit does not expand the SDK's 2 MiB raw block
limit or the original capture limits.

Source details display the original identity label, captured file and half-open range with its explicit UTF-8-byte, UTF-16 or grapheme encoding. Canonical matching values do not replace the original label. Historical details load on demand and offer **Refresh** when unavailable; switching snapshots discards a late response for the earlier source.

Files are read through authorized native directory handles. Windows denies ordinary writes, renames and deletion while the declared input files are captured. macOS opens each path component relative to a directory descriptor without following symlinks, then checks file identities, timestamps, directory entries and repeated bytes before accepting the capture. Detected concurrent changes reject the capture; POSIX advisory locks are not treated as write exclusion. The system `/var` and `/tmp` aliases are mapped to their `/private` locations. Reparse points, user-controlled symlinks and duplicate physical inputs are rejected. This is not a sandbox against privileged software. The Host sends fixed captured material to the declared process component; Core alone records project adoption. Process permissions are described above.

## Saved tasks and recovery

**Back** keeps an unstarted selection while the project stays open. Leaving the project asks before discarding it. Once import starts, its task and output remain available from **Tasks**. Closing a view does not cancel a persisted task. Active work participates in the existing stop-before-close or directory-move flow.

If an extraction or checker start acknowledgement is lost, check or resume that same attempt with its original input, grant and expiry. If check validation acknowledgement is lost, reconcile that same checker result before preparing another check. If applying is uncertain, query its saved receipt before retrying the same action. Repeated confirmed actions return the original receipt and identities. Cancelled, expired or closed grants require a new reviewed attempt; they cannot be renewed on the original attempt. A cancelled checker can be prepared again without replacing the captured proposal. Unknown execution is never replayed automatically. Failed source files should be corrected and imported as a new task.

After capture, the external source folder can be moved or removed: preview, adoption and reopening use project-owned bytes. Moving the closed project keeps content identities and receipts intact. Closing a project ends its current execution authority; persisted history does not restore a grant. Corrupt stored evidence and unsupported database schemas are rejected rather than repaired or shown as empty content.

See the [README](../README.md#development) for the current database schema. This development build opens its current format only; earlier experimental projects are preserved and refused without conversion or reset. Application release versions and future upgrade support follow the [versioning policy](versioning.md).

## Legacy source fixture profile (explicit test builds)

- One Mod folder, with a manifest identifying either an entry DLL or a content pack, and flat localization strings. No DLL is executed.
- UTF-8, optional BOM, JSON comments and trailing commas. Duplicate or case-colliding keys are rejected. Native keys and the manifest namespace must use printable ASCII; text can contain Unicode. Empty strings are preserved; an empty localization object is rejected.
- `$schema` is retained as editor metadata, not a string to translate. Original files are kept byte-for-byte, including comments and fields not extracted.
- Split `i18n/default/` layouts, archives, inline Content Patcher text, linked paths and other resource formats are unsupported. Build-time manifest version placeholders produce a warning; importing does not establish game compatibility.

Limits are cumulative: 16 KiB manifest, 128 KiB combined input, at most 256 direct entries in each inspected directory, 2,000 strings, 1,024-byte native keys, 256-byte namespace and 16 KiB per string. The saved source capture must fit 1 MiB, the SDK source and content proposal each 2 MiB, the complete fixed check input 4 MiB and the complete persisted execution result 8 MiB. Encoded limits include references and evidence and may be reached before the string-count limit. Oversized input fails as a whole. Preview pages contain at most 100 rows and 256 KiB without truncating text.

The former SMAPI source fixture remains available for isolated regression checks through `execution-test-host`; it is not the normal Source content path or a fallback for unavailable plugins.

Saved tasks and original receipts remain readable after reopening. New plugin execution still requires its original explicit preparation and current authorization; a saved result or continuation receipt does not restore a grant. Old anonymous resume/retry is refused. See the [execution test-host guide](execution-test-host.md#continuation-identity-and-current-storage) for the exact continuation boundary and the [README](../README.md#development) for current development compatibility.

## Native fault checks

The explicit `execution-test-host` feature reads one-shot controls from `source-fixture-control/` beside its executable. Normal builds do not contain these hooks. JSON files named `estimate.json`, `prepare.json`, `adopt-before.json` or `adopt-after.json` are consumed at that boundary. `{"wait":true}` writes a `.reached` marker and waits up to 60 seconds for the matching `.release` file. `{"fail":true}` returns an unconfirmed response. A `source` object with `manifest`, `strings` and `language` captures and commits a competing complete source through the real runner and adoption handler. Use only synthetic projects. The post-adoption failure is delivered after the real commit and returns `outcome-unknown`; the original action remains available for receipt lookup, which must find exactly one saved snapshot.
