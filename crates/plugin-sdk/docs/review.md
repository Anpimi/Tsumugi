# Experimental domain review checks

Review checks run before release preparation. Their results do not approve a
translation, waive a finding, qualify a release or validate built artifact bytes.
Those decisions remain with the application and its project policy.

| Data | Contract ID | Schema / behavior |
| --- | --- | --- |
| `ReviewCheckInput` | `tsumugi.review-check-input` | 1 / 1 |
| `ReviewDeclaration` | `tsumugi.review-declaration` | 1 / 1 |
| `ReviewCheckError` | `tsumugi.review-check-error` | 1 / 1 |
| Results | `tsumugi.check-results` | 1 / 1, existing contract |

The SDK owns these data definitions and generates JSON Schema, JavaScript types
and standalone structural validators. It contains no database, loader or domain
parser. This experimental SDK is not published to crates.io. Core qualification and
desktop execution still require integration with these contracts.

## Fixed evidence and scope

`ReviewCheckInput` carries the complete original `ContentExchange`, one explicit
target language, a nonempty `selections` subset and captured domain requirements.
Each selection references an exact source unit and its source revision. Selected
text stays byte-for-byte UTF-8: `null` means no selected translation, while `""`
means a selected empty translation. The data validator accepts both so the
applicable policy/checker can report the corresponding finding. It never silently
substitutes source text, normalizes Unicode or invents approval.

Captured artifacts and opaque domain blocks remain unchanged. Their presence
does not prove that the domain content is valid. IDs in this exchange are
operation-local, not permission to allocate or mutate project identities.
The application must retain the mapping to its actual source/selection revisions,
resources, decisions, policy and fixed runtime environment.

All domain requirements in one invocation belong to one exact provider. Each is
mandatory, nonwaivable and covers precisely the selected unit subset. Domain
rule findings cannot acquire a waiver through this declaration. The Core policy
separately owns protected terminology warnings and permitted issue exceptions.

Collections retain the existing 2,000-item limit; selected text is bounded to
16 KiB per item. Original content has the 2 MiB encoded limit and the full request
has the existing 4 MiB encoded invocation limit. Bounds include JSON escaping.
These generic ceilings do not enlarge a domain profile's smaller limits.

## Captured declaration and exact provider

A manifest `resource` contribution references a `ReviewDeclaration` JSON file:

```json
{
  "profile": { "id": "example.plain-text", "schemaVersion": 1, "behaviorVersion": 1 },
  "checker": "review-check",
  "rules": [
    { "rule": { "id": "example.source-structure", "schemaVersion": 1, "behaviorVersion": 1 }, "requiresTranslation": false },
    { "rule": { "id": "example.selected-text", "schemaVersion": 1, "behaviorVersion": 1 }, "requiresTranslation": true }
  ]
}
```

The declaration has one to 32 distinct rule IDs with exact versions. Its checker
must support the exact profile and input/output/error contracts, declare a
read-only effect, and request only captured-input permission. `bind` captures
the provider from the same validated manifest and independently supplied package
digest. `ReviewBinding::validate_input` compares all declared rules, their exact
versions and the checker against an already captured input. It does not accept a
response array as the policy or replace a missing rule with another version.

`PackageImage::review_declaration` uses the Host's existing immutable Resource
reader. Wrong resource versions, executable Resource files, malformed metadata
or mismatched checker contracts are refused. Resource inspection does not load
the checker, authenticate its publisher or grant permission to execute.

## Coverage, missing text and failures

The trusted policy owner builds its union using the existing
`capture_required_checks`: mandatory Core rules plus adopted domain requirements.
Keep that independent `FixedCheckSet` when receiving results. The Host must first
bind each result to the actual invocation/channel; `FixedCheckSet::evaluate`
then checks exact rules/providers/versions, input and scope digests, target
coverage and permitted applicability evidence. Empty results or missing,
failed, cancelled and unavailable mandatory checks remain incomplete coverage.
Completed coverage may still contain blocking findings.

Only a declaration with `requiresTranslation: true` permits a captured N/A
requirement for a scope where every selected translation is absent. Its reason
is `missing-translation` and its basis is a fixed SHA-256 captured by the policy
owner. The returned N/A must match that exact captured basis. Mixed scopes with
present text cannot use this exception. Source-only rules still run even when
the application separately permits a source fallback. A fallback decision does
not erase missing-translation findings or remove any Core requirement.

`ReviewCheckError` has finite classifications, an optional operation-local unit
reference and a public description of at most 4 KiB. Do not put local paths,
raw project text, credentials or sensitive content into diagnostics. Type and
length validation cannot authenticate or sanitize arbitrary diagnostic prose.

The application must capture current inputs/checks/environment consistently,
compute outside its write transaction, then recheck currentness and authority
in its existing short mutation boundary. Historical evidence does not restore
execution permission. These contracts do not implement that persistence or
the independent check of actual release artifacts.

## Advisory text checks alongside required format checks

The separate text-review contract projects captured text for a checker whose
profile is independent of the original file format. It does not weaken
`ReviewBinding`, replace a source format's checks or require that a knowledge
package implement source extraction. Both kinds of results can participate in
the same host-owned `FixedCheckSet`, retaining separate providers and evidence.
The SDK defines the exchange; current-QA persistence, qualification and desktop
policy still require application integration.

| Data | Contract ID | Schema / behavior |
| --- | --- | --- |
| `TextReviewDeclaration` | `tsumugi.text-review-declaration` | 1 / 1 |
| `TextReviewCheckInput` | `tsumugi.text-review-input` | 1 / 1 |
| `TextReviewCheckReport` | `tsumugi.text-review-report` | 1 / 1 |
| Error | `tsumugi.review-check-error` | 1 / 1, existing contract |

A declaration lists available rules and supporting Resource contribution IDs:

```json
{
  "profile": { "id": "example.editorial-text", "schemaVersion": 1, "behaviorVersion": 1 },
  "checker": "text-review-check",
  "disposition": "advisory",
  "supportingResources": ["terms"],
  "rules": [{
    "rule": { "id": "example.preferred-form", "schemaVersion": 1, "behaviorVersion": 1 },
    "requiresTranslation": true,
    "title": "Preferred form",
    "description": "Check the explicitly selected editorial preference."
  }]
}
```

Only `advisory` disposition is supported. Every text-review requirement must
have `mandatory: false` and `waivable: false`. Explicitly selecting a check does
not adopt its resource, make its editorial preference a project requirement or
approve a translation. A plugin cannot request a blocking mode through this
declaration. Adopting a project requirement is a separate application action.
Result severity does not change the captured policy.

The capability must declare the exact text input/report and existing review
error contracts, support the declaration's exact profile, have a read-only
effect, and request exactly captured-input permission. Binding resolves the
checker and every supporting Resource against the same validated manifest and
package digest. Resource schemas are retained in `TextReviewResourceBinding`;
the Host must rebind untrusted metadata against the actual immutable package.
This data contract opens no files and authenticates no publisher.

The Host captures each Resource's exact bytes and supplies a pin containing
`contributionId`, `schema` and `sha256`. The SDK checks pin syntax and exact
Resource identities/schemas. The Host separately verifies SHA-256 against the
actual bytes. A correctly shaped digest is not proof of a Resource's contents,
internal revision, applicability or adoption.

`TextReviewCheckInput` carries the checker `profile`, `sourceLanguage`,
`targetLanguage`, Resource pins, original `selections` and captured
`requirements`. Each selection has `unitId`, `sourceRevisionId`, `sourceText`
and nullable `translationText`. A nonempty, explicitly selected rule subset
belongs to one exact provider and covers precisely those unit IDs. No rule is
automatically selected by installation, query output or text matching. Profile,
rules and Resource references are checked by `TextReviewBinding::validate_input`.
The Host retains the selection and source revision mappings and fixes all
relevant inputs, Resource bytes, configuration and runtime environment.

Missing (`null`) and selected empty (`""`) translations remain different.
An allowed N/A uses the existing `missing-translation` reason with the exact
captured basis, for a rule declaring `requiresTranslation: true` and a scope
where all translations are absent. A source-only rule cannot use this N/A;
mixed or empty-but-selected text cannot use it either. A checker may complete a
rule with no findings after inspecting irrelevant text; it cannot invent an
applicability exception.

## Text reports and diagnostic ranges

`TextReviewCheckReport` contains `results` and `diagnostics`. A successful report
must provide exactly one explicit result per selected requirement, preserving
the original `CheckKey`, provider, input/scope digests and complete target
coverage. Failed, cancelled and unavailable outcomes remain distinct. Missing
or extra results are invalid reports even when the requirements are advisory.
The policy union's advisory coverage semantics do not make an empty successful
response evidence that the requested work ran.

Each diagnostic refers to one actual completed finding by `(key, code, target)`.
It may include a `location`, public `detail`, `suggestion`, or `resourceEntry`.
A Resource entry references a captured Resource contribution and an opaque
entry ID; the SDK verifies that contribution's presence, while the checker owns
the entry's domain meaning. Diagnostics cannot invent findings, attach to a
failed result, claim Core coverage or refer to another provider's rules.

`location` names the exact `source` or `translation` field and carries the
existing `TextRange`. Half-open ranges explicitly declare `utf8-byte`, `utf16`
or `grapheme` encoding. `validate_against` reuses `convert_text_range` on the
captured original string, rejecting out-of-bounds offsets and split code points
or UTF-16 surrogate pairs. A translation location cannot refer to absent text.
Validation does not normalize, round, truncate, replace text or convert a range
to another string. User-facing code must convert offsets for its actual editor.

Declarations and Resource lists retain the 32-rule/list ceiling and 32 KiB
encoded declaration limit. Inputs retain the 2,000-selection limit, 16 KiB per
source/translation string and 4 MiB encoded invocation limit. Reports retain
32 selected-rule results, at most 2,000 diagnostics and a 2 MiB encoded limit.
Diagnostic details are bounded to 4 KiB and suggestions to 16 KiB. Exact
capability input/output limits are also checked by the binding. JSON escaping
counts toward encoded limits; these ceilings do not enlarge smaller plugin
limits. Public diagnostic prose must not contain private paths, raw project
content, credentials or sensitive information. Structural validation does not
sanitize arbitrary prose or establish domain correctness.

Receive each invocation through the original `receive_invocation_result` with
the independently verified actual channel before parsing its report payload.
Then call `TextReviewBinding::validate_report` with the trusted capture. Parsing
alone cannot establish request coverage, actual Resource bytes, scalar range
boundaries or runtime authority. The application keeps its captured policy
union and commits current QA only through its original mutation boundary.
The SDK provides neither a query-to-QA conversion nor execution permission.

The conformance CLI exposes `schema-text-review-{declaration,input,report,types}`,
their corresponding `check-text-review-*-schema` commands, and
`validate-text-review-{declaration,input,report} <file>` for data checks.
`match-text-review-report <input-file> <report-file>` additionally checks result
association and ranges against the captured input, returning the report as JSON.
It does not authenticate an execution channel, a package or a Resource file.
