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

## Context, suggestions, and affected work

Choose a source unit in Context and memory to save a manual context note and reason. **Fix current input** records the current source facts, manual note, and applicable adopted terms within a 16 KiB budget; it lists included and omitted items. No context is sent to a model by this action. Translation memory suggestions come from this project's saved translation revisions. Exact source-text matches rank before similar text; each suggestion shows its source and whether it is current. **Use as draft** opens the translation editor with the suggested text for review and saving. A suggestion does not establish content identity, select a translation, or grant human approval. Older translations did not record context usage, so suggestions and project-wide impact are based on source-text matches alone.

Affected work lists current selected translations with possible dependencies on changed terms or unit context. It shows the old and new values, reason, and coverage limit; a possible text match needs human review. Open translation takes you to the existing editor. This view does not create review decisions, run QA, or build or publish a translated Mod. Resource and context history are stored in the project's SQLite database. Schema 3, 4, and 5 projects are backed up before upgrading to schema 6.
