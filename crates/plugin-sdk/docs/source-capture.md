# Capture Summary

Experimental SDK `0.1.0-alpha.7` adds `tsumugi.source-capture-summary` **1/1** as a host-rendered, read-only `DomainBlock`. It describes the declared projection of captured material. It does not describe translation progress, release eligibility or complete coverage of an external project.

Use exactly `ContentTarget::Snapshot` and `ExtensionHandling::Preserve`. `SourceRevisionPolicy` rejects this schema in `revision_basis`: changing descriptive totals must not revise every translation unit. Semantic source context continues to use the independent [source context facts](source-context.md) contract and the caller's explicit sharing selection.

`SourceCaptureSummary.materials` contains one entry per reported captured artifact:

- `source` identifies captured parse-input evidence, using the existing text or raw-byte coordinates. References are nonempty; artifact IDs are unique in the summary. They are not filesystem paths or read permissions.
- `properties` carries plain plugin-authored labels and lists of literal values, such as a format version or captured dependencies. Labels are unique within a material. An empty values list explicitly reports absence; omission means no property was supplied. Hosts must render these values as text without executing markup, links or commands.
- `counts` reports source `items`, `itemsWithFields`, `declaredFields` and `nonEmptyFields`. Empty fields remain counted. `itemsWithFields` cannot exceed either items or fields; it is zero exactly when declared fields are zero. Nonempty fields cannot exceed declared fields.
- Optional `groups` partition these same counts by literal labels. When groups are supplied, each of the four totals must equal the material count. Group labels are unique; groups do not imply a common domain grammar.

For example, records, cues or translation keys may be source items. The plugin defines and independently checks its projection. Hosts must not infer format semantics from group labels or assume that undeclared fields and resources have been handled.

The encoded summary is bounded at **64 KiB**: at most 64 materials, 256 groups and 16 properties per material, and 256 values per property. Labels allow 128 UTF-8 bytes without control characters; each nonempty value allows 1,024 UTF-8 bytes and excludes NUL. Existing source and complete-content budgets also apply. `source_capture_summary_profile()` and `profile-source-capture` export these limits from Rust for generated consumers.

`parse_source_capture_summary` checks data shape, bounds, unique identities and consistent counts. `parse_source_capture_summary_block` additionally checks the exact block contract, snapshot target, preserve handling and reference positions against the caller's captured artifacts. The complete content receiver validates artifact bytes and digests first. These checks do not authenticate a plugin's numerical claims: the independently selected source checker must reconstruct and compare the summary from the captured input before adoption.

JavaScript producers can use `validateSourceCaptureSummary` and `encodeSourceCaptureSummary` from `javascript/source-capture.mjs`. These helpers enforce the generated shape, UTF-8 budgets and count invariants; artifact integrity, reference positions, domain truth and execution authorization remain receiver-owned. The emitted text snapshots data without adding project identities or authority.

A receiver without this exact summary profile preserves the opaque block. Absence of a summary is not a zero-count report. Unsupported summaries must not be interpreted by guessing property or format names.
