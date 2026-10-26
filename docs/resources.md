# Glossary and context

Open a project with an imported source snapshot and at least one target language, then select **Glossary and context** in the sidebar to manage project terminology, per-entry context notes, external exchange previews, and source fact overrides.

The query workspace can also retrieve term proposals from a compatible external MCP server under separate discovery and data-sharing consent; saved results enter the standard resource preview and decision flow with their external provenance intact. See [MCP terminology retrieval](mcp-retrieval.md) for supported profiles, limits, and recovery behavior.

## Managing terms and per-entry context

### Project glossary terms

In the **Terms** tab, you can create or edit glossary entries with a target language, source phrase, optional aliases, preferred target form, scope (project-wide or bound to a specific source unit), protected-form flag, and reason:

- Every save records a new revision while preserving earlier values in **History**.
- Unit-scoped terms take precedence over project-wide terms. If multiple terms conflict at the same scope, they are surfaced as an explicit conflict rather than resolved silently.
- Terms act as translation guidance and QA rules; saving a term does not rewrite existing translations automatically.

### Per-entry human context and translation memory

In **Context and memory**, select a source unit to write a manual context note and reason:

- **Editing from the translation workspace**: Expand **Terms, context and history** in the translation editor and click **Edit context for this entry** to jump to that unit and target language in the resource workspace while preserving your unsaved translation draft. Any existing resource draft or unconfirmed action must be resolved before navigating or returning via **Return to …**. Save your changes explicitly with **Save context**.
- **Fixing context input**: **Fix current input** snapshots the current source facts, manual context note, and applicable adopted terms within a 16 KiB budget, listing both included and omitted items without dispatching a model request.
- **Translation memory suggestions**: Suggestions are drawn from saved translation revisions in the current project, ranking exact source-text matches ahead of similar strings and indicating whether each match is current. Clicking **Use as draft** copies the text into the translation editor for review and saving.
- **Affected work**: The **Affected work** view lists selected translations that may depend on modified terms or unit context, showing the before/after values, reason, and coverage limits so you can open affected entries in the editor or review them in **Review and QA**.

## Inspecting and overriding source observations

Expand **References** in the translation editor to view **Original source observations** for the current entry and language. The panel separates extracted source facts from inferences (showing inference rationale, adjacent original text, and local source ranges) and keeps empty, unsupported, or uninterpreted blocks visible without inventing missing speaker, role, or scene metadata. Reference pages load independently of your editable draft in batches of up to 20 entries and 128 KiB (**Load more source observations** fetches additional pages).

### Correcting or rejecting a source fact

Within the editor's references panel, you can override individual source observations for the current entry, target language, and source snapshot:

- **Change this fact** records a human replacement value of the same typed kind, while **Reject this inference** excludes a specific inferred fact. Enter a decision author (up to 512 UTF-8 bytes) and reason (up to 4,096 bytes; replacement values also allow up to 4,096 bytes), then save. **Restore the original fact** appends a restoration decision without erasing prior rejection records.
- Fact decisions are scoped strictly to the current entry, language, and observed source snapshot—they do not carry over automatically when source content updates. The editor reads fact positions from a single loaded source page (up to 128 positions), and decision history is paged at up to 100 records per read.
- **Effect on AI and Arena preparation**: At the Core preparation boundary, replaced and rejected original facts are excluded even if their extracted/inferred category is enabled. Human replacement values are shared only when **Share saved context** is enabled (even if the original fact category is turned off). AI preparation loads the scope's latest decision set (capped at 128 decisions and 32 KiB, failing explicitly rather than truncating if exceeded; disabling both saved-context sharing and original fact categories bypasses this capture). Only effective values and their semantic origins are sent to the provider; decision authors, reasons, excluded values, and local coordinates stay local. Recording a new fact decision requires refreshing any unaccepted AI preparation for that scope.

## Local glossary updates (JSON)

The **Resource updates** tab lets you import a local UTF-8 JSON glossary file (`tsumugi-glossary-v1`). The file is captured into the project with its SHA-256 digest before previewing (so the captured bytes remain available even if the external file is later moved or deleted):

```json
{
  "format": "tsumugi-glossary-v1",
  "resourceId": "my-terms",
  "revision": "G1",
  "license": "MIT",
  "sourceLocale": "en",
  "targetLocale": "zh-CN",
  "entries": [
    {
      "id": "barrel",
      "source": "Barrel",
      "aliases": ["Cask"],
      "target": "桶",
      "protected": false,
      "nativeKey": "data.item.barrel.name",
      "reason": "Reviewed terminology"
    }
  ]
}
```

- **Schema and limits**: `nativeKey` is optional; when provided, it must match a unit in the current source snapshot and scopes the term to that unit (omit `nativeKey` for project-wide scope). All other fields shown above are required. `resourceId`, `revision`, and each entry `id` allow ASCII letters, digits, `.`, `_`, or `-` (up to 128 bytes). Nonempty text fields are capped at 16 KiB, each entry allows up to 16 aliases, and the file must contain 1–512 entries within 128 KiB total. Malformed JSON, duplicate IDs, invalid locales, or oversized files are rejected as a whole.
- **Review and adoption**: Uploading a newer revision with the same `resourceId` treats omitted entries as removals. Review each row individually using **Keep current**, **Ignore update**, **Adopt**, or **Replace override** (when a manual project override already exists).

## External terminology and memory previews (TMX and TBX)

In **Resource updates**, you can inspect local `.tmx` and `.tbx` files in read-only preview mode against your project's source language and a selected target language. These previews do not store files in the project, import memories or termbases, adopt terms or translations, or share data with a model, and they leave your existing resource drafts untouched. Only open files you have permission to use.

### TMX exchange preview (`tmx-1.4b-plain-text-preview`)

Choose **Choose TMX file to preview** to inspect a plain-text TMX 1.4b file:

- **Supported XML profile**: Requires UTF-8 (with optional BOM), `tmx version="1.4"`, a single `header` with required attributes followed by a single `body`, and either no XML namespace or `http://www.lisa.org/tmx14`. Prefixed namespaces, DTDs, processing instructions, custom/external entities, XInclude, and UTF-16 are rejected, and no external resources are fetched.
- **Mapping and loss reporting**: Each translation unit requires one matching source variant, one target variant, and an applicable source direction (`*all*` does not guess direction). Decoded segment whitespace and line breaks are preserved, while duplicate `tuid` attributes remain separate rows. Missing, blank, ambiguous, inline-coded, or unsupported rows are excluded with explicit reasons. Extra languages, duplicate IDs, notes, properties, and unmapped metadata are tallied in a classified loss report with up to 16 sample file locations.

### TBX terminology preview (`tbx-basic-dca-subset-preview`)

Choose **Choose TBX file to preview** to inspect a UTF-8 `.tbx` file conforming to a subset of [TBX-Basic V4](https://www.terminorgs.net/downloads/TBX-Basic-V4.pdf):

- **Supported XML profile**: Requires default namespace `urn:iso:std:iso:30042:ed-2`, `type="TBX-Basic"`, `style="dca"`, and an explicit document language (which describes the document itself and never fills in missing term languages). The structure must contain a header with file description followed by a `text`/`body` with concepts, language sections, and term sections (plus at most one trailing `back` section retained as unmapped metadata). Leading `xml-model` processing instructions are ignored without fetching external schemas; DTDs, entities, XInclude, other processing instructions, and older `martif` dialects are rejected.
- **Concept inspection and exclusions**: For each concept, the preview displays candidate terms in the project source and target languages without automatically picking a preferred pair, merging duplicate IDs, or creating aliases. Recognized usage values (`preferred`, `admitted`, `deprecated`) and direct term source annotations are displayed alongside raw values (secondary usage fields are flagged as duplicates). Terms with inline markup, empty/whitespace-only text, or unsupported nested structures are excluded from mapping and summarized in the classified loss report (with up to 16 position samples).

### Shared preview limits

Both TMX and TBX previews paginate mapped items and loss categories at 20 items per page and enforce strict ceilings: 128 KiB input file size, 512 units/concepts, 1,024 language sections/variants (and 1,024 term sections for TBX), 8,192 XML elements, maximum element depth 16, 32 attributes per element, 16 KiB decoded text per segment/term, and 1 MiB for the complete desktop response. Any file exceeding these bounds fails cleanly without returning a truncated report.

---

Resource and context history are stored in the project's SQLite database. See the [README](../README.md#development) for current database schema compatibility.
