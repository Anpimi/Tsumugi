# Glossary and context

The query workspace can explicitly retrieve term proposals from a compatible
external MCP server. Discovery and sharing require separate consent; saved
results enter the existing resource preview and decision flow with their exact
external provenance. See [MCP terminology retrieval](mcp-retrieval.md) for the
supported profile, limits and recovery behavior.

## Correct a source fact for the current entry

Expand the translation editor's references to inspect original source facts and
their provenance. **Change this fact** creates a human replacement with the same
typed kind; **Reject this inference** excludes that particular inferred fact.
Supply a decision author and reason, then explicitly save. Each decision applies
only to this entry, target language and exact observed source. It preserves the
original block target, extracted/inferred classification, original value and
source references. It creates no entity-wide rule, global memory or training
permission. Free-text context remains a separate supplement.

The fact decision history remains readable after source changes. Decisions are
never silently carried to a new source snapshot. Inspect the current facts and
explicitly create a new decision against their new evidence. **Restore the
original fact** appends another decision; it does not erase a prior rejection.
An existing resource or translation draft is kept independently. If an action's
result is uncertain, check its original receipt before retrying; retry uses the
same request. An acknowledgement for an earlier edit does not clear newer input.

AI and Arena apply these decisions at the shared Core preparation boundary.
Replaced and rejected original facts are excluded even when their original
extracted/inferred category is selected. Human replacement values are included
only when **Share saved context** is selected, including when the original fact
category is not selected. The new preview distinguishes human values and pins
the relevant decisions, including an initially empty decision query. Restoration
makes the original eligible under its original category selection again. The
provider receives only authorized effective values and their semantic origin;
local decision identities, reasons, original excluded values and coordinates
remain local. Decision authors are at most 512 UTF-8 bytes; reasons and human
replacement values are each at most 4,096 bytes. History is paged (at most 100
records per read). The editor reads exact fact positions from one loaded source
page (at most 128 positions) and keeps single-fact editing and restoration
available even when other facts exceed an AI capture budget. AI preparation
requires the complete scope's latest decision set, bounded at 128 decisions and
32 KiB; exceeding a bound fails explicitly without returning a silently truncated
successful capture. Turning off both saved-context sharing and original fact
categories allows preparation without that capture. Restoration retains its
history and does not reduce the number of captured latest decisions. Budgets
still apply to whole items and complete requests.

New related decisions require a fresh, unaccepted preparation. Unrelated entries
and languages do not invalidate all work. Already accepted fixed inputs and
historical results retain their original capture; reading history grants no
new execution authority. Source facts use the existing SDK contract; human
project decisions belong to Core's existing project resource authority.

Open a project with a source snapshot and at least one target language, then choose **Glossary and context**. The Terms tab creates or edits project terms with a target language, source phrase, optional aliases, preferred target form, project or source-unit scope, protected-form flag, and reason. Each save creates a revision; the earlier value remains in History. A unit-scoped term takes precedence over a project-wide term. Conflicting terms at the same scope are shown as a conflict, not silently chosen. Terms are guidance; saving one does not rewrite translations.

In a translation editor, expand **Terms, context and history** and choose
**Edit context for this entry**. The resource workspace opens the exact entry
and target language after checking the current source and context revision.
Your translation draft remains in its original editor. An existing resource
draft or unconfirmed action cannot be replaced by this navigation; finish or
resolve it in the resource workspace first. If evidence changes during the
read, refresh the translation editor before trying again.

Opening context neither saves nor shares it with AI. Edit the human context and
its reason, then explicitly choose **Save context**. Concurrent resource changes
retain your text and require reviewing the current save basis. Saving A while
typing B retains B as unsaved input. Use **Return to …** to return to the retained
translation editor; unsaved resource input is retained too. An unconfirmed action
must be resolved before this return. Human context supplements the project; it
does not edit extracted source observations or accept/reject an AI inference.
Existing resource invalidation makes related AI preparation require a new
preview without clearing its model settings or renewing an old execution grant.

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

## TBX terminology preview

In **Resource updates**, choose **Choose TBX file to preview** for a separate
read-only terminology report. The `tbx-basic-dca-subset-preview` profile recognizes
a subset of the fields described by [TBX-Basic V4](https://www.terminorgs.net/downloads/TBX-Basic-V4.pdf).
It does not establish the file's dialect version or validate complete TBX Core,
language or Schematron compliance. Other dialects and older `martif` documents
are unavailable.

Select UTF-8 `.tbx` data with the exact default namespace
`urn:iso:std:iso:30042:ed-2`, `type="TBX-Basic"`, `style="dca"`, and an explicit
document language. The supported hierarchy is a header with file description,
then a text/body containing concepts, language sections and term sections. A
single trailing `back` section is retained only as unmapped metadata. The
document language describes the file; it never supplies a missing language for
a term. Only leading `xml-model` processing instructions are accepted as ignored
schema hints. No hinted file or network address is opened, and no schema is
executed. DTDs, custom/external entities, XInclude, other processing instructions
and unsupported namespaces are refused.

For each concept, inspect all candidates in the exact project source and selected
target languages. Multiple language sections or terms remain ambiguous; the
preview does not choose a preferred term, combine all possible pairs, create
aliases or set protected forms. A term's reported usage status and direct source
annotation remain unverified file content. Recognized usage values are
`preferred`, `admitted`, and `deprecated`; all readable raw values remain visible,
and every second or later usage field is reported as a duplicate. A context or definition source is not
presented as the term's source. Repeated concept/term identifiers and repeated
text retain independent file positions and cannot merge project identities.

Whole decoded plain-text terms remain available for inspection, including empty
or XML-whitespace-only terms that are excluded from mapping. Inline markup is
not flattened. Markup in a mapped usage/source field and unknown nested term
structure also exclude the selected term. Missing, ambiguous or structurally
unsupported terms have explicit reasons. Extra languages, unmapped/unknown data categories, duplicate or unknown
usage statuses, inline content and ignored schema hints have complete classified
counts, with at most 16 original-position samples across the report. Unlisted
locations remain counted. Source permission, quality and content license remain
unknown; a possible mapping is not an adopted or human-approved project term.

Concepts and loss categories each use local 20-item pages. Candidate terms are
inspected on demand in bounded pages. Limits are 128 KiB input, 512 concepts,
1,024 language sections, 1,024 term sections, 8,192 elements, depth 16,
32 attributes per element, 16 KiB decoded text per term and 1 MiB for the complete
desktop response. Exceeded limits reject the whole file. Cancellation, failure
and relevant project/language/source changes follow the TMX preview's local
recovery behavior and preserve existing resource drafts.

Previewing does not save a capture, import a termbase, adopt terms, create
translations, grant approval or share anything with a model. The existing local
JSON glossary adoption and project translation memory retain their separate
documented behavior.

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
