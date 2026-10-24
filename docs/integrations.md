# Bundled integrations and compatibility

Desktop source selects installed, independently approved plugin capabilities in
**Source content**, before selecting a folder. Package approval, runtime approval
and permission for each execution are separate. The explicitly bundled plugin
profile includes the fixed packages below; a source build without those resources
does not silently select a built-in implementation. See [plugin installation](plugin-distribution.md).
A current source retains its captured domain and identity policy.

| Integration | Captured input | Export | Support |
|---|---|---|---|
| Stardew SMAPI 0.1.0-alpha.1 | `manifest.json`, `i18n/default.json` | `i18n/<language>.json` | Flat JSONC language files; see [source import](source-import.md) |
| WebVTT 0.1.0-alpha.1 | `source.vtt` | `<language>.vtt` in the export folder | Caption profile 1; see below |

Caption profile 1 supports UTF-8 with an optional BOM, LF/CRLF/CR line endings, explicit nonempty ASCII cue identifiers, and plain text with multiple lines. IDs that differ only in ASCII case are rejected as duplicates; the original spelling is preserved. Timing uses `mm:ss.mmm` or `hh:mm:ss.mmm`, with increasing start order and end after start. Overlapping cues are permitted. Supported settings are `line`, `position`, `size`, `align`, and declared `region`. NOTE blocks and leading STYLE/REGION blocks are retained as original data. CSS is not executed by the workbench.

Anonymous cues, cue payload markup or entities, vertical settings, unknown settings, invalid timestamps and empty payloads are rejected. This is a limited editing profile, not a complete WebVTT renderer. Inputs are bounded to 128 KiB and 2,000 cues; individual text is limited to 16 KiB. The format reference is [W3C WebVTT syntax](https://www.w3.org/TR/2026/CRD-webvtt1-20260520/#syntax).

After importing and applying a snapshot, use **Translations → Edit translations** to save normal revisions. Use **Review and QA** to run checks and record explicit approvals. Existing translated WebVTT files use the separately captured import, independent check and per-entry adoption flow described in [translation import](translation-import.md). **Build and export** uses the saved source template and approved project text. It changes only cue payloads, preserving timing, settings, identifiers, order and every other original byte. Enter a safe `.vtt` name for each language. No external subtitle source is reread during building. Empty text, blank lines, arrows and markup that could change the file structure are rejected before release.

To maintain subtitles, choose **Update source content** and review a new `source.vtt`. Timing and layout changes require renewed source correspondence and review even when the words match. Explicit continuation keeps the content unit, appends a new source revision and retains earlier translations and releases. Unchanged cues retain applicable work. Renamed IDs do not inherit identity from matching words alone. Earlier snapshots and releases remain readable after reopening.

Executable plugins run through captured native or JavaScript Host channels with
explicit unsandboxed-execution consent. They have the current user's operating-system
permissions; package declarations and Core grants are application controls, not an
operating-system sandbox. Removing or revoking an installation does not erase saved
project evidence or silently grant a replacement package its earlier authority. Core project/storage and Tauri/capability interfaces are internal; caption profile 1 is experimental. Capability and exchange version 1 are implementation versions, not promises of public SDK compatibility. Unknown required versions are rejected. New attempts record their actual implementation versions; saved releases keep their original bytes and checks. See the [README](../README.md#development) for the current database schema and the [versioning policy](versioning.md) for application release versions.
