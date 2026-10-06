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
parser. This experimental SDK remains unpublished. Core qualification and
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
