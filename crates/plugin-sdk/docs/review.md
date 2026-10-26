# Domain and Advisory Text Review Contracts

The SDK provides two complementary sets of review contracts at schema/behavior `1/1`:

1. **Domain Review Checks**: Mandatory, format-aware checks (`ReviewDeclaration`, `ReviewCheckInput`, `ReviewCheckError`) that validate source content and selected translations against domain-specific structural and semantic rules before release preparation.
2. **Advisory Text Review Checks**: Format-independent editorial or terminology checks (`TextReviewDeclaration`, `TextReviewCheckInput`, `TextReviewCheckReport`) that run on projected plain text alongside supporting package resources.

Both families emit results compatible with Core's `FixedCheckSet` coverage evaluator (`tsumugi.check-results`).

---

## 1. Mandatory Domain Review Checks

| Data Type | Contract ID | Schema / Behavior |
| --- | --- | --- |
| `ReviewCheckInput` | `tsumugi.review-check-input` | `1 / 1` |
| `ReviewDeclaration` | `tsumugi.review-declaration` | `1 / 1` |
| `ReviewCheckError` | `tsumugi.review-check-error` | `1 / 1` |
| Check Results | `tsumugi.check-results` | `1 / 1` |

### Input Scope (`ReviewCheckInput`)

`ReviewCheckInput` provides the checker with:

- The complete original `ContentExchange` (up to 2 MiB encoded).
- An explicit `targetLanguage` wire label.
- A non-empty `selections` list (up to 2,000 items) mapping each selected source unit ID and source revision ID to its current translation (`null` when untranslated, or a UTF-8 string up to 16 KiB—including `""` when an empty string was explicitly selected).
- The mandatory domain check `requirements` assigned to a single provider and covering the exact selected unit subset.

The complete `ReviewCheckInput` frame is bounded to 4 MiB encoded (including JSON escaping).

### Declaration Resource (`ReviewDeclaration`)

A plugin declares its mandatory review rules in a non-executable JSON resource (`tsumugi.review-declaration/1/1`, up to 32 KiB):

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

- A declaration lists 1 to 32 distinct rules with exact `schemaVersion` and `behaviorVersion` numbers.
- The referenced `checker` capability must support the declared `profile`, use the `ReviewCheckInput` / `tsumugi.check-results` / `ReviewCheckError` schemas, have a `read-only` effect, and request only `captured-input` permission.
- `ReviewDeclaration::bind` binds the resource to the package's `ValidatedManifest` and digest (`PackageImage::review_declaration` reads and binds this resource from an archive).
- `ReviewBinding::validate_input` verifies that a `ReviewCheckInput` includes every declared rule at its exact version for that checker.

### Coverage and Missing-Translation Applicability

Core merges mandatory Core rules and domain review rules into a `FixedCheckSet` via `capture_required_checks` and evaluates returned results with `FixedCheckSet::evaluate`:

- All domain review rules are mandatory and non-waivable.
- A rule with `requiresTranslation: true` may return a `not-applicable` result with reason `missing-translation` **only** when every unit in the evaluated selection has `translation: null` and the result matches the policy owner's captured basis SHA-256. Scopes with any present translation (including `""`) or rules with `requiresTranslation: false` must execute normally.
- `ReviewCheckError` carries a finite classification, an optional unit ID, and a diagnostic description (up to 4 KiB, which must not include local paths, raw user text, or secrets).

---

## 2. Advisory Text Review Checks

Advisory text checks operate on source and translation strings independently of the underlying file format (so a terminology or style package does not need to implement a format parser).

| Data Type | Contract ID | Schema / Behavior |
| --- | --- | --- |
| `TextReviewDeclaration` | `tsumugi.text-review-declaration` | `1 / 1` |
| `TextReviewCheckInput` | `tsumugi.text-review-input` | `1 / 1` |
| `TextReviewCheckReport` | `tsumugi.text-review-report` | `1 / 1` |
| Error | `tsumugi.review-check-error` | `1 / 1` |

### Declaration and Resource Pins (`TextReviewDeclaration`)

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

- Only `disposition: "advisory"` is supported, and every requirement in `TextReviewCheckInput` must set `mandatory: false` and `waivable: false`.
- `TextReviewDeclaration::bind` resolves the `checker` capability (`read-only`, `captured-input` permission) and up to 32 `supportingResources` within the same manifest and package digest, recording each resource's schema in `TextReviewResourceBinding`.
- When preparing an invocation, the Host hashes the actual bytes of each supporting resource and passes a pin (`contributionId`, `schema`, `sha256`) in `TextReviewCheckInput`.

### Input and Report Validation (`TextReviewCheckInput` & `TextReviewCheckReport`)

`TextReviewCheckInput` (up to 4 MiB encoded) carries `profile`, `sourceLanguage`, `targetLanguage`, resource pins, `selections` (up to 2,000 items, each with `unitId`, `sourceRevisionId`, `sourceText`, and nullable `translationText` up to 16 KiB), and the explicitly selected `requirements` (1 to 32 rules from a single provider). The same `missing-translation` N/A rule applies when `requiresTranslation: true` and all translations in the selection are `null`.

`TextReviewCheckReport` (up to 2 MiB encoded) contains:

- `results`: exactly one `CheckResult` per selected requirement, matching the original `CheckKey`, provider, input/scope digests, and full target unit coverage.
- `diagnostics`: up to 2,000 structured annotations, each referencing a completed finding in `results` by `(key, code, target)`. A diagnostic may attach:
  - `location`: `{ field: "source" | "translation", range: TextRange }` using `utf8-byte`, `utf16`, or `grapheme` coordinates. `validate_against` checks every range against the original string in `TextReviewCheckInput` via `convert_text_range` (rejecting out-of-bounds offsets, split code points/surrogates, or locations pointing to `null` translations).
  - `detail` (up to 4 KiB) and `suggestion` (up to 16 KiB).
  - `resourceEntry`: `{ contributionId, entryId }` referencing one of the pinned supporting resources.

After verifying the channel response with `receive_invocation_result`, callers validate the report against the captured input using `TextReviewBinding::validate_report`.

### CLI Commands

The `tsumugi-plugin-contract` CLI supports schema generation and validation for all review contracts:

- `schema-text-review-{declaration,input,report,types}` and `check-text-review-*-schema`
- `validate-text-review-{declaration,input,report} <file>`
- `match-text-review-report <input-file> <report-file>` (validates report coverage, findings, and text ranges against the input fixture).
