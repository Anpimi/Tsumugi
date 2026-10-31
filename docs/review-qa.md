# Review and QA

In the desktop workspace, use entry details and **Issues** to inspect translations, run rule checks, manage findings and waivers, and record human reviews. Use **Delivery** to check build readiness before generating localized release files.

Review history and check evidence are stored in the project's SQLite database; see the [README](../README.md#development) for current database schema compatibility.

<a id="your-decisions-in-the-opt-in-workspace"></a>

## Your decisions in the workspace

Open **Your decisions** from the activity bar, the command palette or the tray above the Agent input. The badge, inbox and tray share the same project-wide counts. “At least” means a source is bounded or unavailable; an incomplete read with no known items is not reported as zero pending decisions.

A candidate opens its exact saved version. A review finding opens the matching page and finding; a pending local request opens its original entry or conversation slot. The original editor and recovery controls still own confirmation, checking and explicit retries. Saved proposal questions open the exact original proposal revision, even outside the loaded history page. They remain a group until a newer saved revision no longer lists questions; ordinary chat messages do not resolve them. Questions from team members still report incomplete coverage. Source results awaiting adoption retain their original result identity and paged comparison evidence; they have no imported entry identity yet. Other items show the original resource proposal, source-mapping evidence, execution result or delivery record. These details are read-only. Handle term proposals in Knowledge, source corrections in the source workflow, and delivery recovery in Delivery; opening a record does not itself approve or retry an action.

Pages retain their read basis. If the underlying list changes, return to the latest list before continuing. Refreshing does not select the next item or clear a pending request. Delivery history can show an older exact record without directory access; checking actual destination files still requires a fresh directory selection in the delivery workflow.

## Reviewing entries and recording decisions

Open a project with an imported source snapshot and target language, then select an entry and open its details or **Issues** tab:

- **Entry details and issues**: Inspect the current source, selected translation, prior review decisions and check results. Open a saved candidate or finding in its entry to continue reviewing it.
- **Approvals and change requests**: Enter a reviewer name to approve a selected translation or request changes (change requests require a reason and leave the current translation text intact). You can also select entries across multiple pages and batch-approve up to 100 entries at once; each entry is re-verified as it is written, and clicking **Stop after this entry** halts remaining writes in the batch without undoing already recorded decisions.
- **Revision binding**: Every review decision is bound to the exact selected translation revision, source revision, and applicable term and context revisions. Selecting a different translation revision, updating source text (with a changed unit or source revision), or modifying applicable resource guidance moves the earlier decision to history and requires a fresh review.

In the desktop workspace, select entries in the table and choose **Approve selected translations**. Each batch is limited to 100 entries; larger selections are rejected without shortening them. Check the saved source and translation and enter your reviewer name before confirming. Batch approval records no per-entry reason; reasons already entered for individual reviews are kept. A selected empty translation can be approved, while an entry with no selected translation must be handled first.

Closing the batch panel keeps the work and its results. **Stop after this entry** prevents later entries from starting, and **End this approval** clears only the remaining review selection. A lost acknowledgement pauses the batch even if the original result is then found. Check the original request, read the remaining entries, and confirm again to continue. Entries that changed must be selected and reviewed again. Completed results remain in the batch and in review history; retained text summaries are labelled when the full text has not been reread.

## Running QA checks and managing waivers

Format and advisory checkers maintain their own Core execution bindings (`Project` or `Attempt` scope, pinned resources, rule subsets, and required coverage). Rebinding an installed checker requires matching its complete package identity.

### Current checks

In the entry’s **Issues** tab, open **Rule checks** and choose **Prepare checks and review permissions**. Preparation may record built-in rule results; review each plugin checker’s permission and choose **Run allowed checkers** to run it for this entry. A cancellation request does not establish that the check stopped; check the original result. Cancelled, failed or inconclusive checks do not establish complete current coverage. Candidate checks recorded during candidate-only AI plans remain attached to those candidates; check the selected translation separately.

For the bundled Stardew SMAPI integration, the applicable rules check:
- Presence of a selected translation
- Named `{{token}}` placeholder names and counts
- Malformed markers and control characters
- Applicable glossary terms

### Fallbacks and waivers

Under the balanced release policy, most mechanical failures—such as missing validators, empty translations, placeholder/format errors, and term conflicts—cannot be waived and must be fixed in the translation editor. Two explicit exceptions are supported:

1. **Source-text fallback**: For an entry that intentionally has no selected translation, record a reviewer and reason under **Human review**, allow source-language text, and run the applicable checks so the entry can be evaluated as a fallback exception in build readiness.
2. **Protected term form warning**: You can waive a protected term form warning by recording a reviewer and reason against the current check evidence (withdrawing the waiver restores the blocker). If the validator version updates, earlier checks and waivers become historical and must be rerun and re-evaluated.

<a id="work-queue-and-build-readiness"></a>

## Finding work and checking build readiness

The work queue aggregates entries requiring attention across the project based on selected revisions, review decisions, check status, findings, waivers and updated resource guidance. Selecting an item opens its current review or the affected content. The **Entries** filters also find entries by review, issue, impact or delivery-blocking status; **Your decisions** groups pending items and opens their original records, with incomplete sources indicated.

In **Delivery**, choose the build languages and use **Check** to evaluate readiness for the selected scope. The readiness section reports blockers and exceptions; open an affected entry or related decision to address an issue. When ready, follow the build, verification and export steps in [Local Build and Export](build-release.md).

## Dispositions for advisory findings

In the entry’s **Issues** tab, **Advisory suggestions** lists non-mandatory findings from plugin rules or recorded AI semantic reviews. Enter your name and reason in **Human review**, then choose **Dismiss as false positive**, **Restore suggestion**, or **Request a fix**:

- **Provenance and matching across runs**: Every disposition appends an immutable decision bound to the exact check run, finding, review basis, actor, and reason. If a subsequent check run produces the exact same rule, input, scope, finding, and diagnostics, the existing disposition remains associated while recording both run origins. Any change to input, scope, rule identity, suggestion, or location starts a new finding that requires its own review.
- **Resolving repair requests**: Recording a repair request marks the finding as awaiting a current recheck; open the editor to make a correction. Editing or saving the translation alone does not clear this status—the finding remains open until a new check run executes the exact same rule against the updated content.
- **Pagination and recovery**: Current findings and their disposition history are paged together (with older repair requests accessible via **More actions**). If a write response is lost, the view checks the original action receipt before retrying the unchanged request and preserves any newer reason text you typed in the meantime.

## AI meaning and style review

In the desktop workspace, open an entry's **Issues** tab for AI review of its currently selected saved translation. Review the text, sharing choices, connection, and request limits before agreeing to start. Recording a completed result uses a separate confirmation and adds advisory findings; it does not edit the translation or approve it. If a start or recording has an uncertain result, its original recovery controls remain available after all entry views close. Checking a result does not start another model request; retrying a missing start can.

Entry details and Issues also offer **Use source-language text** for entries with no selected translation. Enter your name and reason in Human review, then allow or withdraw permission for that entry. A selected empty translation still counts as a selected translation. If the source or permission changes while you are writing a reason, check the current entry and choose **Use current entry** before continuing. Earlier permissions remain in History.

For several translations, select entries and open **Approve selected translations**, then choose **End approval selection and prepare AI review**. Choose the languages and **Use these entries and languages**, then exclude any individual pairs you do not want to send. The fixed selection is limited to 100 entry/language pairs. Preview and separate consent are still required; switching does not undo saved human reviews. Closing and reopening keeps both excluded pairs and language choices that have not yet been applied. A changed language selection must be applied explicitly before previewing or sending.

AI meaning and style review supports advisory checks for meaning, style, or both on the selected saved translation or an explicit batch of entry/language pairs. In an entry’s **Issues** tab, expand **AI meaning and style review** to review the current entry:

1. **Preview and consent**: AI review reuses your configured model connections, term/context sharing controls, and task request budgets. Inspect the preview showing the exact saved source, selected translation, included guidance, destination endpoint, and budget, then confirm consent to start the review.
2. **Adopting advisory findings**: Model outputs return typed review findings rather than replacement translation candidates (a response with zero findings is recorded as advisory evidence rather than automatic approval). Review the completed output and explicitly record its advisory findings in the entry panel.
3. **Inspecting and acting on findings**: Recorded AI findings appear alongside plugin advisory findings with their model, endpoint, recipe, and execution provenance attached. False-positive rejections and repair requests bind to that exact model and prompt configuration; resolving a repair request requires rerunning the same semantic review rule on the updated translation.
4. **Locating passages in the editor**: When a recorded semantic finding includes an exact text range, you can jump directly to that source or translation passage in the editor and return to the same issue list.
