# Review and QA

Format and advisory checker selections retain the exact component scope with
their complete Core execution binding. Each checker can independently use Project
or Attempt scope; an Attempt belongs to that check execution. Resource pins,
rule subsets, required coverage and nonwaivable format rules are unchanged.
Rebinding installed packages must match the saved complete identity; a result or
new installation cannot substitute a scope or restore an old grant.

Open a project with an imported source snapshot and a target language, then choose **Review and QA**. The Review tab shows source entries for one target language. Select an entry to compare its current source and selected translation, inspect earlier decisions and checks, or open the translation editor. Saving or selecting a translation does not approve it.

The sidebar keeps Review and QA in the main workspace. Opening an entry in Translations and returning keeps the review page and selected entry, and refreshes their current evidence. This also works for an entry that does not yet have a selected translation. The work queue and build blockers provide actions to locate the affected content; diagnosis identifiers remain available in details.

An AI result can open this entry and language for its current selected
translation after a fresh source and Review-target check. The original Review
draft keeps its actor, reason and captured basis. Changed current evidence still
uses the normal comparison and explicit adoption flow; navigating cannot resolve
an uncertain action or silently discard checker preparation and consent. An
unselected AI candidate and its candidate checks remain separate from current
Review and QA.

Enter a reviewer name before recording an approval or requesting changes. A change request needs a reason and keeps the translation intact. Each decision records the exact selected revision, source revision, and relevant term and context revisions. A later selection or relevant guidance change leaves the old decision in history and requires a new decision. Run **Current checks** separately; a passed check never grants human approval. The current bundled SMAPI checks cover selected translation, named `{{token}}` names and counts, malformed markers and control characters, and applicable terms. Missing or outdated checks block build readiness. You can request cancellation while a check runs. Failed or cancelled attempts remain in history, do not supply required coverage, and need a new run after the cause is resolved. If the cancellation arrives after the check commits, its completed result remains authoritative.

You can select entries across list pages and approve up to 100 at a time. The confirmation shows the fixed set. Each entry is checked again when written, so a changed entry is reported separately and other successful entries remain recorded. **Stop after the current entry** prevents further writes; it does not undo a recorded decision. If a response may have been lost, retry the same action to retrieve its receipt before making another decision. Reason drafts are kept when a save returns after you continue typing.

The current balanced policy permits a source text fallback for one entry with no selected translation. Record a reviewer and reason, run current checks, and expect the fallback to appear as an allowed exception in readiness. A selected translation always needs its own current human approval. Only a protected term form warning can be waived, with a reviewer and reason for that issue and current evidence; withdrawing the waiver restores the blocker. A validator update makes earlier checks and their waivers historical; rerun the checks and review any warning again. Missing validators, empty translations, marker or format problems, and term conflicts cannot be waived.

**Work queue** derives current work from selected revisions, decisions, checks, findings, waivers, and changed resource guidance. It can show several reasons for one entry; opening an entry returns to its current review. **Build readiness** evaluates an explicit set of target languages, initially all project targets. It reports each language's blockers and allowed exceptions over the complete current source scope. A ready result permits build preparation under this policy. It does not build a translated Mod, check output bytes, publish, or remain valid after relevant project changes. **Build and export** re-evaluates the current basis, validates actual output bytes, and saves a local language-file release.

Candidate-only AI plans can record their authorized checks without selecting a
translation. These saved candidate findings and execution receipts are separate
from current QA and human approval. Selecting that candidate later still requires
the ordinary current checks for its new selection basis.

Review history and check evidence live in the project's SQLite database. See the [README](../README.md#development) for the current schema and development compatibility. Readiness and queue reads do not alter project content. Updating the complete SMAPI flat source keeps applicable approvals and checks for entries with the same unit and source revision; changed or unresolved entries require current work before a new build.

In **Advisory findings**, use the same reviewer and reason to **Reject as false
positive**, **Restore finding**, or **Record repair request and open editor**.
Only an advisory requirement proven by the saved check's fixed requirement set
and matching result, or a separately recorded typed AI semantic review, is
eligible. Required format checks, mechanical Core checks and
mechanical waivers remain under their existing policies. A disposition cannot
change check coverage, remove a mandatory failure, supply approval or make a
build ready.

Each action appends an immutable decision bound to the exact check run, finding,
review basis, actor and reason. The original finding and provider/input/scope
provenance remain inspectable, including after rejection. A later run with exactly
the same rule, input, scope, finding and rich
diagnostics associates the existing decision while preserving both run origins.
Changed input, scope, provider/rule identity, suggestion, location or other
finding evidence starts a new finding and is not rejected by an earlier human
decision. Optional diagnostic absence is recorded as such; it is distinct from
a later diagnostic. Current findings and their disposition history share bounded
pages; repair
status accompanies the page containing its request. Older requests remain
reachable through **More finding history**. Restoring a rejected finding requires an
explicit new reason and the current preceding decision.

A manual repair request is recorded before opening the existing editor. Opening
the editor, saving a translation, or completing another task does not resolve
it. Review continues to show **awaiting a current recheck** until a later check
has completed the same exact rule on the current content. A rule with new
findings is shown separately from a rule with no findings. Missing, unavailable,
failed, cancelled, outdated or differently versioned rule evidence cannot close
this loop. Current mandatory checks and human approval still apply.

Uncertain writes retain the original request. Recovery first reads that action's
receipt and only retries the unchanged action when no receipt was found. A late
receipt clears only the submitted reason, so newer reason edits survive. Review
keeps uncertain actions visible and blocks leaving until their outcome is
confirmed; the manual editor continues to protect its own drafts independently.

## AI meaning and style review

Expand **AI meaning and style review** for the current selected saved translation
or the explicit entry/language pairs chosen in Review. Choose meaning, style or
both. The bounded batch shares one original Task request budget; successful,
failed and unknown items retain separate outcomes. Model connection settings and
the existing term/context sharing controls are reused. Preview shows the exact
saved source, translation, selected guidance, destination and budgets. Confirm
this review independently before sending; changing the range, rules, connection
or relevant saved input requires a new preview and consent.

Results are typed review findings rather than candidate translations. A model
report with no findings is advisory evidence, not independent proof of quality.
For each successful current item, explicitly prepare and confirm **Record these
advisory findings** through the original Task adoption flow. No result is automatically
recorded, selected or approved. Cancellation and lost responses use the same Task
ledger and original action receipts; an unavailable read does not prove absence
or authorize a replacement request.

Recorded findings appear beside plugin advisory findings while retaining their
own current run. Their model, endpoint, recipe and original execution provenance
remain inspectable. False-positive and repair decisions bind that exact origin;
a different model or changed prompt does not inherit them. A repair needs a real
current semantic recheck of the same rule; a saved edit or a completed repair
task cannot close it. Mechanical QA, human approval and build readiness keep
their existing independent requirements.

A recorded current semantic finding with an exact location can open that source
or selected-translation passage in the existing editor, then return to the same
review or pending-work queue. The location is checked against its complete saved
diagnostic, original model and execution evidence, current semantic run and
selected revision. A newer review on the same text still replaces the old run.
Changed evidence, unavailable reads, missing ranges or newer editor drafts keep
the original work available for refresh or recovery. Locating a finding is
read-only and does not record a repair request or approve a translation.
