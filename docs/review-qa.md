# Review and QA

In **Review and QA**, you inspect selected translations against current source content, run format and advisory checks, manage review findings and waivers, record human approvals, and evaluate build readiness before generating localized release files.

Review history and check evidence are stored in the project's SQLite database; see the [README](../README.md#development) for current database schema compatibility.

## Reviewing entries and recording decisions

Open a project with an imported source snapshot and target language, then select **Review and QA** in the sidebar:

- **Navigating between Review and the editor**: Selecting an entry displays its current source, selected translation, prior review decisions, and check results. Opening the entry in **Translations** (or jumping here from an AI translation result) and returning preserves your review page, selected entry, and draft reviewer/reason while refreshing current evidence.
- **Approvals and change requests**: Enter a reviewer name to approve a selected translation or request changes (change requests require a reason and leave the current translation text intact). You can also select entries across multiple pages and batch-approve up to 100 entries at once; each entry is re-verified as it is written, and clicking **Stop after the current entry** halts remaining writes in the batch without undoing already recorded decisions.
- **Revision binding**: Every review decision is bound to the exact selected translation revision, source revision, and applicable term and context revisions. Selecting a different translation revision, updating source text (with a changed unit or source revision), or modifying applicable resource guidance moves the earlier decision to history and requires a fresh review.

## Running QA checks and managing waivers

Format and advisory checkers maintain their own Core execution bindings (`Project` or `Attempt` scope, pinned resources, rule subsets, and required coverage). Rebinding an installed checker requires matching its complete package identity.

### Current checks

Run **Current checks** to validate the selected translations (you can cancel a running check at any time; cancelled or failed runs remain in history and must be rerun once fixed). Note that candidate checks recorded during candidate-only AI plans remain attached to those candidates—once a candidate is selected as the active translation, run **Current checks** for the active selection.

For the bundled Stardew SMAPI integration, current checks verify:
- Presence of a selected translation
- Named `{{token}}` placeholder names and counts
- Malformed markers and control characters
- Applicable glossary terms

### Fallbacks and waivers

Under the balanced release policy, most mechanical failures—such as missing validators, empty translations, placeholder/format errors, and term conflicts—cannot be waived and must be fixed in the translation editor. Two explicit exceptions are supported:

1. **Source-text fallback**: For an entry that intentionally has no selected translation, record a reviewer and reason and run current checks so the entry is tracked as an allowed fallback exception in build readiness.
2. **Protected term form warning**: You can waive a protected term form warning by recording a reviewer and reason against the current check evidence (withdrawing the waiver restores the blocker). If the validator version updates, earlier checks and waivers become historical and must be rerun and re-evaluated.

## Work queue and build readiness

- **Work queue**: Aggregates entries that require attention across the project based on selected revisions, review decisions, check status, findings, waivers, and updated resource guidance. Selecting an item opens its current review or jumps to the affected content.
- **Build readiness**: Evaluates a chosen set of target languages (defaulting to all project target languages) across the complete current source snapshot, reporting all remaining blockers and allowed exceptions per language. Once a language passes build readiness, proceed to **Build and export** to run the build plugin, verify output bytes, and create a release.

## Dispositions for advisory findings

Under **Advisory findings**, reviewers can manage non-mandatory findings produced by plugin advisory rules or recorded AI semantic reviews. Using your reviewer name and reason, you can choose **Reject as false positive**, **Restore finding** (which requires a new reason against the preceding rejection), or **Record repair request and open editor**:

- **Provenance and matching across runs**: Every disposition appends an immutable decision bound to the exact check run, finding, review basis, actor, and reason. If a subsequent check run produces the exact same rule, input, scope, finding, and diagnostics, the existing disposition remains associated while recording both run origins. Any change to input, scope, rule identity, suggestion, or location starts a new finding that requires its own review.
- **Resolving repair requests**: Recording a repair request marks the finding as **awaiting a current recheck** before opening the editor. Editing or saving the translation alone does not clear this status—the finding remains open until a new check run executes the exact same rule against the updated content.
- **Pagination and recovery**: Current findings and their disposition history are paged together (with older repair requests accessible via **More finding history**). If a write response is lost, the view checks the original action receipt before retrying the unchanged request and preserves any newer reason text you typed in the meantime.

## AI meaning and style review

Expand **AI meaning and style review** to run an advisory LLM check for meaning, style, or both on the currently selected saved translation (or an explicit batch of entry/language pairs selected in Review):

1. **Preview and consent**: AI review reuses your configured model connections, term/context sharing controls, and task request budgets. Inspect the preview showing the exact saved source, selected translation, included guidance, destination endpoint, and budget, then confirm consent to dispatch the batch.
2. **Adopting advisory findings**: Model outputs return typed review findings rather than replacement translation candidates (a response with zero findings is recorded as advisory evidence rather than automatic approval). For each completed item, review the output and confirm **Record these advisory findings** through the task adoption flow.
3. **Inspecting and acting on findings**: Recorded AI findings appear alongside plugin advisory findings with their model, endpoint, recipe, and execution provenance attached. False-positive rejections and repair requests bind to that exact model and prompt configuration; resolving a repair request requires rerunning the same semantic review rule on the updated translation.
4. **Locating passages in the editor**: When a recorded semantic finding includes an exact text range, you can jump directly to that source or translation passage in the editor and return to the same review item or work queue entry.
