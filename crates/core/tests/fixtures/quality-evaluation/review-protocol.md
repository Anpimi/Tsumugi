# Review protocol

This protocol defines how to use the fixed corpus. It reports no observed
review, model output or quality result. The current model request budget is 0.
The drill files are authored examples only.

## Freeze the inputs before collecting outputs

Record the corpus edition, domain, generation, exact keys and languages, selected
plugin/runtime identities, complete source artifacts and resulting capture
references. Retain the supplied literal extraction oracle independently of the
worker output. Do not tune the corpus or its criteria after seeing a scheme's
results; create a new edition for a changed evaluation question.

Freeze the approved terms and explicitly targeted human context alongside each
evaluation case. Record which of those resources were actually adopted and
shared in the original preview. A context note in `cases.json` is neither an
extracted source fact nor permission to send it. Do not promote subtitle timing
to a speaker, role or scene, or infer a project language from a filename.

For future generation, record the complete supported `AiConfig`/`ArenaConfig`
captured by the existing preview: actual non-secret connection provenance,
endpoint/model, output-token parameter, output limit, request/retry/time limits,
concurrency, selected entries, sharing choices and complete disclosed input.
Record the actual transport and artifacts used. Credentials are never part of
the packet. Do not invent unsupported temperature/seed controls or claim a
model name makes outputs deterministic. Unknown configuration keeps the run
NOT-RUN; it is not replaced with a fake runnable profile. Only the original
preview, budget and explicit consent can authorize physical requests.

## Separate the reviewer packet from the reveal

The operator retains the full captured input/output, candidate provenance and
label mapping. Give an independent reviewer only the source, target language,
approved terms, relevant context and candidate texts under stable neutral
labels. Do not include endpoint/model, scheme name, generation order, task IDs,
origin-kind fields, resource-strategy names or filenames encoding those facts
in the reviewer packet or its review form. Displaying the source being
translated is necessary; exposing the candidate's producer is not.

The existing [offline Arena comparison](../../../../../docs/ai-translation.md#arena-comparison)
can preserve anonymous labels and an explicit reveal for saved candidates
without a model request. Its normal generation preview reveals destinations to
the operator. An operator who has seen that preview or the mapping is not a
blinded reviewer. Keep roles and mapping custody explicit; do not call this a
scientific double-blind experiment or infer general quality from the drill.

Freeze each review record before revealing producer identities. Preserve the
original record if the reviewer later changes their opinion. Record reveal
status and exclusions, including accidentally exposed identities or insufficient
context. Do not quietly replace missing ratings with “pass”.

## Record separate dimensions

For every candidate, retain the exact text and record observations separately:

| Dimension | Required observation |
| --- | --- |
| Structure | Original extractor/checker evidence and format-specific constraints; placeholder and raw-artifact preservation. A structural pass alone makes no semantic claim. |
| Terminology | Use of the explicitly approved term at every applicable occurrence, or a reasoned discrepancy. No global string-replacement score. |
| Context and meaning | The intended river-bank sense, exact quantities, action intent and other targeted facts; record ambiguity or missing evidence rather than guessing. |
| Human editing | Candidate before editing, resulting text, reviewer explanation and separately reported elapsed time/edit count with its measurement basis. |
| Maintenance reuse | What was retained, rechecked, replaced, retired or explicitly matched after S2, tied to the original entry and source basis. |

There is no weighted total, automatic winner or universal reference translation.
The approved term and intended facts constrain the task; other faithful target
wording can be acceptable. A preference must include reasons and may be “no
preference” or “insufficient evidence”. The original Review/QA, selection and
approval owners still determine product eligibility; a human comparison cannot
waive mandatory checks or approve a release.

Editing time and modified-character count are manual reports, not system
telemetry. State whether time includes source/context reading, pauses and
revision. If reporting an edit count, use the same stated convention for all
compared schemes: inserted plus deleted Unicode code points, counting a
replacement as deletion plus insertion. Preserve before/after text so that the
report remains interpretable; do not silently normalize Unicode or claim that
code points are graphemes. Missing or unmeasured values stay null/NOT-RUN. The
drill's example edit is illustrative and has no measured time or edit count.

## Assess S2 without rewriting S1

Keep original S1 candidates, judgments and source evidence. Read the maintenance
relationships before deciding reuse. Unchanged text does not by itself establish
current applicability; the original source/resource/selection checks still
apply. The count changes from two to three. A timing-only caption change keeps
the payload text but requires evaluation of the new source/timing basis; it is
not permission to rewrite the source timing from a translation.

`panel-old` to `panel-new` is only a proposed continuation of the same “Open”
action. Require an explicit identity decision; equal text or array position is
not proof. `obsolete` is removed and `newcomer` is a new message with different
meaning. Do not automatically transfer the old translation or approval.

For each relationship, record the actual decision, evidence, resulting candidate
and any fresh check or human action. “Task completed” is not “issue resolved”,
and a retained candidate is not a selected, approved or published translation.

## Report only the evidence obtained

Two distinct checks are useful before a real quality run: complete consumption
of S1/S2 by the actual source extractor plus independent source checker, and an
offline exercise of packet/record/reveal separation. Neither proves semantic
quality, Core maintenance adoption or independent human assessment.

A real report must separately identify actual outputs and parameters, structural
results, reviewer observations, human self-reports, maintenance decisions and
known/unknown usage and fees. Failed, excluded and NOT-RUN cases remain visible.
Do not turn anonymous Arena votes, synthetic responses or missing usage into a
quality or billing claim. No model request, native workflow or release is
authorized by this protocol.
