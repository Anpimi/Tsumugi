# Bundled integrations and compatibility

In **Source content**, you select an installed, approved plugin capability before choosing a source folder. Approving a package, approving a runtime, and authorizing each individual execution are separate steps. The bundled plugin profile ships with the packages listed below; building from source without bundling those resources does not fall back to a built-in implementation. See [plugin installation](plugin-distribution.md) for details on managing packages.

| Integration | Captured input | Export | Support |
|---|---|---|---|
| Stardew SMAPI 0.1.0-alpha.1 | `manifest.json`, `i18n/default.json` | `i18n/<language>.json` | Flat JSONC language files; see [source import](source-import.md) |
| WebVTT 0.1.0-alpha.1 | `source.vtt` | `<language>.vtt` in the export folder | Caption profile 1; see below |

## WebVTT Caption Profile 1

The experimental WebVTT integration implements Caption Profile 1, a focused editing subset of the [W3C WebVTT syntax](https://www.w3.org/TR/2026/CRD-webvtt1-20260520/#syntax) (rather than a full WebVTT media renderer):

- **Accepted syntax and limits**: Input files must be UTF-8 (with an optional BOM) using LF, CRLF, or CR line endings, up to 128 KiB and 2,000 cues in total, with each individual cue text up to 16 KiB. Every cue requires a nonempty ASCII identifier (IDs differing only by ASCII case are rejected as duplicates, while original casing is preserved) and plain-text payloads (which may span multiple lines).
- **Timing and cue settings**: Timestamps use `mm:ss.mmm` or `hh:mm:ss.mmm` with non-decreasing start times and end times strictly after start times; overlapping cues are allowed. Supported cue settings are `line`, `position`, `size`, `align`, and declared `region`. `NOTE` blocks and leading `STYLE` or `REGION` blocks are preserved as original file data (embedded CSS is never executed by the workbench).
- **Rejected constructs**: Anonymous cues, cue payload markup or HTML entities, vertical cue settings, unrecognized settings, invalid timestamps, and empty cue payloads are rejected.

### Editing, building, and maintaining WebVTT subtitles

1. **Translate and review**: After importing and applying a source snapshot, edit cue translations under **Translations → Edit translations**, run checks and record approvals in **Review and QA**, or import existing translated `.vtt` files through the workflow in [translation import](translation-import.md).
2. **Build and export**: **Build and export** combines the saved source template with your approved project translations. It replaces only the cue text payloads while preserving timing, cue settings, identifiers, cue ordering, and all other original bytes, without rereading external subtitle files. Enter a valid `.vtt` filename for each target language; empty translations, blank lines, timestamp arrows (`-->`), or markup that could alter the file structure are rejected before a release can be created.
3. **Update source subtitles**: Choose **Update source content** to compare a new `source.vtt` snapshot. Unchanged cues retain their existing work, while timing or layout modifications require re-verifying source correspondence and review even if the source words are identical. Cues with renamed IDs do not inherit identity automatically from matching text alone. Confirming the continuation appends a new source revision while preserving earlier snapshots, translations, and releases.

## Execution model and version compatibility

Executable plugins run through native or JavaScript Host channels and require explicit unsandboxed execution consent per attempt. Because plugin processes run with the current OS user's permissions, package capability declarations and Core grants act as application-level controls rather than an operating-system sandbox. Uninstalling or revoking a plugin preserves existing project records and never transfers prior permissions to a replacement package.

Core project/storage interfaces and Tauri capability bindings are internal, and capability and exchange version `1` identify the current implementation contract rather than a stable public SDK guarantee (unrecognized required versions are rejected). New attempts record the exact implementation versions used, while saved releases preserve their original artifact bytes and check proofs. See the [README](../README.md#development) for database schema compatibility and the [versioning policy](versioning.md) for application release versioning.
