# Bundled integrations and compatibility

The desktop application includes two trusted local integrations. Choose a source format in **Source content** before selecting the folder. A project's current source cannot switch between these formats.

| Integration | Captured input | Export | Support |
|---|---|---|---|
| Stardew SMAPI 0.1.0 | `manifest.json`, `i18n/default.json` | `i18n/<language>.json` | Flat JSONC language files; see [source import](source-import.md) |
| WebVTT 0.1.0 | `source.vtt` | `<language>.vtt` in the export folder | Caption profile 1; see below |

Caption profile 1 supports UTF-8 with an optional BOM, LF/CRLF/CR line endings, explicit nonempty ASCII cue identifiers, and plain text with multiple lines. IDs that differ only in ASCII case are rejected as duplicates; the original spelling is preserved. Timing uses `mm:ss.mmm` or `hh:mm:ss.mmm`, with increasing start order and end after start. Overlapping cues are permitted. Supported settings are `line`, `position`, `size`, `align`, and declared `region`. NOTE blocks and leading STYLE/REGION blocks are retained as original data. CSS is not executed by the workbench.

Anonymous cues, cue payload markup or entities, vertical settings, unknown settings, invalid timestamps and empty payloads are rejected. This is a limited editing profile, not a complete WebVTT renderer. Inputs are bounded to 128 KiB and 2,000 cues; individual text is limited to 16 KiB. The format reference is [W3C WebVTT syntax](https://www.w3.org/TR/2026/CRD-webvtt1-20260520/#syntax).

After importing and applying a snapshot, use **Translations → Edit translations** to save normal revisions. Use **Review and QA** to run checks and record explicit approvals. Existing translated WebVTT file import is not provided. **Build and export** uses the saved source template and approved project text. It changes only cue payloads, preserving timing, settings, identifiers, order and every other original byte. Enter a safe `.vtt` name for each language. No external subtitle source is reread during building. Empty text, blank lines, arrows and markup that could change the file structure are rejected before release.

To maintain subtitles, choose **Update source content** and review a new `source.vtt`. Timing and layout changes require renewed source correspondence and review even when the words match. Explicit continuation keeps the content unit, appends a new source revision and retains earlier translations and releases. Unchanged cues retain applicable work. Renamed IDs do not inherit identity from matching words alone. Earlier snapshots and releases remain readable after reopening.

These are bundled, in-process implementations with captured input access. There is no third-party plugin loader or operating-system sandbox. Core project/storage and Tauri/capability interfaces are internal; caption profile 1 is experimental. Capability and exchange version 1 are implementation versions, not promises of public SDK compatibility. Unknown required versions are rejected. New attempts record their actual implementation versions; saved releases keep their original bytes and checks. The application stays in the unreleased 0.1.0 batch and uses schema 10 without new subtitle tables.
