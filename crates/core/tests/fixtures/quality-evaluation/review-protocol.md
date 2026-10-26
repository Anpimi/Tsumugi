# Quality Evaluation Review Protocol

This document defines the procedure for running blinded translation evaluations and upstream maintenance assessments with the [two-domain quality evaluation corpus](README.md). The checked-in files in `drill/` are synthetic examples for testing the review workflow offline (the default model request budget in the repository is `0`, and live model runs are marked `NOT-RUN` unless explicitly executed).

## 1. Freeze Inputs Before Generating Candidates

Before collecting any candidate translations:

1. **Pin Corpus & Runtime Provenance**: Record the corpus edition, domain, generation (`S1` or `S2`), entry keys, source and target languages (`en` → `zh-CN`), plugin package digests, runtime environment digest, and raw source artifact digests alongside the extraction oracle. Do not modify corpus entries or evaluation criteria after inspecting outputs; bump the corpus edition if the evaluation design changes.
2. **Pin Adopted Resources**: Record which `terms` and `contexts` entries from `cases.json` were actually adopted into the project and selected for sharing in the execution preview.
3. **Pin Model & Arena Configuration**: For live model runs, record the complete `AiConfig` / `ArenaConfig` snapshot from the execution preview—non-secret endpoint and model identifiers, output-token parameters and limits, request/retry/timeout ceilings, concurrency, selected units, and disclosed shared context (never include API keys or credentials in evaluation packets). Any unconfigured run remains `NOT-RUN`.

## 2. Blind the Reviewer Packet (`packet.json` vs. `reveal.json`)

To prevent producer bias during human evaluation, separate operator provenance from the reviewer's materials:

- **Reviewer Packet (`drill/packet.json`)**: Contains only the source text, target language, approved glossary terms, applicable context notes, and candidate translations under neutral labels. Omit model/endpoint names, scheme labels, generation order, task IDs, origin types, resource-strategy names, or identifying filenames.
- **Candidate Reveal (`drill/reveal.json`)**: Maps each neutral candidate label back to its producer, configuration, and capture digests. Keep `reveal.json` hidden from the reviewer until their evaluation record (`drill/review-example.json`) is finalized and frozen.
- **Role Separation**: In [offline Arena comparisons](../../../../../docs/ai-translation.md#arena-comparison), candidates can be reviewed under anonymous labels before triggering the reveal step. Because the operator who runs the generation preview sees the target endpoints, that operator cannot act as a blinded reviewer. If a reviewer's record is later amended after reveal, keep the pre-reveal record intact alongside the amendment and note any accidental unblinding or exclusions.

## 3. Record Five Independent Dimensions

Evaluate each candidate across five distinct dimensions rather than collapsing results into a single weighted score:

| Dimension | What to Record |
| --- | --- |
| **Structure** | Extractor and semantic checker results, format constraints, inline placeholder preservation, and raw artifact byte fidelity. |
| **Terminology** | Whether every applicable occurrence uses the approved glossary translation, or the reviewer's rationale when a departure is appropriate. |
| **Context & Meaning** | Accuracy on context-dependent senses (such as "bank" as river bank), exact counts, and UI action intent; note any source ambiguity explicitly. |
| **Human Editing** | Pre-edit candidate text, final edited text, reviewer notes, and (when measured) elapsed editing time and character edit distance. |
| **Maintenance Reuse (`S2`)** | Which `S1` translations were retained, re-verified, updated, retired, or explicitly linked to a renamed key after adopting `S2`. |

When reporting human editing metrics:

- State the timing convention clearly (e.g., whether reading context and pauses are included) and keep unmeasured values as `null` / `NOT-RUN`.
- Compute character edit distance consistently across all schemes as `inserted + deleted` Unicode code points (treating a replacement as a deletion plus an insertion) on the unnormalized before/after strings.

## 4. Evaluate `S2` Maintenance Without Overwriting `S1`

Preserve all `S1` candidates, review records, and source evidence when evaluating the `S2` update:

- **Unchanged Text & Timing Updates**: Re-run applicable source, resource, and review checks against `S2`. In WebVTT, a cue whose timestamp changed (`river`) keeps its payload text but must be verified against the updated cue timing.
- **Numeric Updates**: Verify that the updated count (`2` → `3`) is reflected in the `S2` translation.
- **Key / Cue Renames (`panel-old` → `panel-new`)**: Require an explicit human identity match decision rather than auto-linking by identical source text (`"Open"`) or file position.
- **Deletions & Additions (`obsolete` / `newcomer`)**: Retire `obsolete` and treat `newcomer` as a fresh unit without carrying over `obsolete`'s translation or approval state.

## 5. Reporting Results

A complete evaluation report lists:

1. The frozen configuration, package/runtime digests, and `S1`/`S2` extractor + semantic checker verification results.
2. Per-candidate structural results, reviewer dimension records, human edit logs, and `S2` maintenance decisions.
3. Actual provider token usage and fee receipts (keeping missing usage fields or unrun cases explicitly marked as unknown or `NOT-RUN`).
