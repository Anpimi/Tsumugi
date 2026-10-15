# Glossary and context

Open a project with a source snapshot and at least one target language, then choose **Glossary and context**. The Terms tab creates or edits project terms with a target language, source phrase, optional aliases, preferred target form, project or source-unit scope, protected-form flag, and reason. Each save creates a revision; the earlier value remains in History. A unit-scoped term takes precedence over a project-wide term. Conflicting terms at the same scope are shown as a conflict, not silently chosen. Terms are guidance; saving one does not rewrite translations.

## Local glossary updates

The Resource updates tab reads a complete UTF-8 JSON file selected by the user. This is a local resource format, not an output of the bundled SMAPI source integration. The file is captured into the project with its SHA-256 digest before preview. Previewing never adopts a change. A later file revision is another complete set with the same `resourceId`; entries absent from it appear as removals. Keep current and Ignore update preserve the adopted value. Adopt checks that the affected term has not changed since the preview. A manual project override remains unless the user explicitly chooses **Replace override**. Review each row separately; there is no implicit bulk adoption.

Example:

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

`nativeKey` is optional. When present, it must name a unit in the current source snapshot to adopt that entry and limits it to that unit; omit it for project scope. All other shown fields are required. `resourceId`, `revision`, and each entry `id` use ASCII letters, digits, `.`, `_`, or `-` and are at most 128 bytes. Each nonempty text field is at most 16 KiB; an entry has at most 16 aliases. The file must contain 1–512 entries and be at most 128 KiB. Duplicate IDs, invalid source or target language, malformed JSON, unsupported format, and oversized files are rejected as a whole. An unknown `nativeKey` prevents adoption of its entry. The original file is only read; after capture, its bytes remain available in the project even if the external file moves or disappears. Use files only when you have permission to do so.

## TMX exchange preview

In **Resource updates**, choose **Choose TMX file to preview** to inspect a local
`.tmx` file against the project's source language and the selected target language.
This separate read does not capture the file in the project, import a memory,
adopt terms or translations, grant human approval, or share content with a model.
Cancelling or retrying the preview keeps your existing resource drafts.

The restricted `tmx-1.4b-plain-text-preview` profile accepts UTF-8 (optionally
with a BOM), `tmx version="1.4"`, and plain-text segments. It is not a complete
TMX Level 1 or Level 2 implementation. XML must have one header followed by one
body and the required header attributes. Elements use no namespace or the
`http://www.lisa.org/tmx14` default namespace. Prefixed namespace declarations,
processing instructions, DTDs, custom or external entities and XInclude are
refused; no external resource is resolved. UTF-16, malformed XML,
an unsupported root or encoding, and exceeded limits reject the whole file.

Rows retain decoded segment whitespace and line breaks. Each row needs exactly
one matching source and target variant and an applicable source direction;
`*all*` never guesses a direction. Missing, blank, ambiguous, inline-coded or
structurally unsupported rows are excluded, with reasons. Additional languages,
duplicate identifiers, notes, properties and unmapped metadata have classified
counts. At most 16 original-location samples are retained across the complete
loss report; unlisted counts remain visible. Duplicate `tuid` values remain
separate rows and never establish project identity.

The preview shows its file name, exact input digest and language basis, complete
mapped text, and available tool and creation/change metadata as unverified
provenance. Content license and quality remain unknown. **Possible mapping**
does not mean approved, imported or safe to reuse. Translation units and loss
categories each have local 20-item pages. A project, language or relevant source
change hides the old report; choose the file again explicitly.

Limits are 128 KiB input, 512 translation units, 1,024 language variants, 8,192
elements, depth 16, 32 attributes per element, 16 KiB decoded text per segment,
and 1 MiB for the complete desktop response. Exceeded limits never return a
silently truncated successful report. Use files only when you have permission.

## Context, suggestions, and affected work

Choose a source unit in Context and memory to save a manual context note and reason. **Fix current input** records the current source facts, manual note, and applicable adopted terms within a 16 KiB budget; it lists included and omitted items. No context is sent to a model by this action. Translation memory suggestions come from this project's saved translation revisions. Exact source-text matches rank before similar text; each suggestion shows its source and whether it is current. **Use as draft** opens the translation editor with the suggested text for review and saving. A suggestion does not establish content identity, select a translation, or grant human approval. Older translations did not record context usage, so suggestions and project-wide impact are based on source-text matches alone.

The translation editor shows the currently applicable adopted terms and manual context beside the source and selected translation. This is current guidance, not evidence that an older translation used those facts. Return to Context and memory to edit the note or inspect fixed input and omissions.

Expand the editor's **References** to read **Original source observations** for the current
entry and language. The panel distinguishes extracted facts from inferences and
shows inference rationale, adjacent original text and exact local source ranges.
Empty and unsupported blocks remain visible; an unknown required block is an
uninterpreted observation. No speaker, role or scene is invented for absent data.
Reading this panel does not share anything with a model or adopt a human fact.
AI and Arena sharing still requires their own preview and confirmation.

References load separately from the editable draft, in pages of whole blocks
followed by neighboring occurrences. Each page is bounded to 20 entries and
128 KiB including its evidence. Use **Load more source observations** to continue.
Refresh or retry from the panel after a read failure; manual editing remains
available. If the source changed while an older draft was retained, references
stay hidden until you explicitly resolve that source change. A later response
never replaces the draft with a new source or translation.

Affected work lists current selected translations with possible dependencies on changed terms or unit context. It shows the old and new values, reason, and coverage limit; a possible text match needs human review. Open translation takes you to the existing editor. This view does not create review decisions, run QA, or build or publish a translated Mod. Use Review and QA to examine current review and check coverage. Resource and context history are stored in the project's SQLite database. See the [README](../README.md#development) for the current schema. Other development schemas are refused without upgrading or resetting their directories.
