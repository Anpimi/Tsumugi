# Existing Translation Import Contracts

The SDK provides four schema/behavior `1/1` contracts for importing and verifying existing translations from domain files:

- `tsumugi.translation-extraction-input` (`TranslationExtractionInput`)
- `tsumugi.translation-exchange` (`TranslationExchange`)
- `tsumugi.translation-extraction-check-input` (`TranslationExtractionCheckInput`)
- `tsumugi.translation-import-declaration` (`TranslationImportDeclaration`)

These contracts share artifact, native identity, text range, provider binding, and check coverage types with [source extraction](source-extraction.md), and reuse `tsumugi.source-extraction-error` for extraction failures.

## Extraction Input and Proposal (`TranslationExtractionInput` & `TranslationExchange`)

`TranslationExtractionInput` (up to 2 MiB encoded) supplies the translation extractor with:

- The domain `profile` and an operation-local `importId`.
- The current project `sourceSetId` and `sourceSnapshotId`.
- The explicit `targetLanguage` and `languageEvidence` (`user-confirmed`), which the application verifies against the project's registered target languages before invoking the plugin (a locale hint in a filename such as `zh.json` is kept distinct from a canonical project target language such as `zh-CN`).
- `nativeScope`: the namespace and native-identity policy captured from the project's adopted source.
- The captured UTF-8 translation source `artifacts` (with SHA-256 digests and relative logical paths).

`TranslationExchange` (up to 2 MiB encoded) returns:

- The unmodified input artifacts and metadata, plus the domain file's `declaredLanguage`.
- `entries` (up to 2,000 `ImportedTranslation` items) and a complete `order` array.
- Each `ImportedTranslation` contains a unique operation-local ID, decoded translation text (up to 16 KiB; `""` is a valid empty string), a `SourceReference` pointing to a valid Unicode scalar range in the captured artifact, and `NativeIdentityEvidence` (canonical `value` plus original `display` spelling/reference) matching the input's `nativeScope`.

`validate_translation_extraction` verifies that `TranslationExchange` preserves the input scope and artifacts, that all entry IDs and `order` match 1-to-1, and that all source references and native identities are well-formed.

## Independent Checks and Core Matching (`TranslationExtractionCheckInput`)

Before Core matches imported entries against project source units, an independent read-only checker validates the extraction via `TranslationExtractionCheckInput` (up to 4 MiB encoded):

- Contains the original `TranslationExtractionInput`, the proposed `TranslationExchange`, and mandatory, non-waivable plugin check requirements targeting `importId`.
- The checker re-parses the raw artifact bytes independently of the extractor and returns `CheckResults` (`tsumugi.check-results`), which Core evaluates with `FixedCheckSet::evaluate`.

Once check coverage is complete with zero blocking findings, Core matches the canonical native identities against the current source snapshot inside its mutation transaction—handling unresolved or ambiguous keys, conflicts with already selected translations, and per-entry user adoption decisions.

## Resource Selection (`TranslationImportDeclaration`)

A plugin package declares its translation import capability in a non-executable JSON resource with schema `tsumugi.translation-import-declaration/1/1`:

- Specifies a relative `logicalDirectory`, a lowercase ASCII alphanumeric file `extension`, an artifact `role`, and a `maxBytes` ceiling for selecting a single file within a user-granted directory (no globs or discovery scripts).
- Binds the domain `profile`, `extractor` contribution ID, a separate read-only `checker` contribution ID, and a non-empty list of mandatory `semanticRules` within the same package.
- `TranslationImportBinding::validate_input` checks that a `TranslationExtractionInput` contains exactly one file matching the declared directory, extension, role, profile, and byte limit (format-specific file rules, such as rejecting `default.json` as a translation file in SMAPI, are enforced by the domain checker).

## CLI and Code Generation

From a built `tsumugi-plugin-contract` binary:

```sh
tsumugi-plugin-contract validate-translation-extraction-input input.json
tsumugi-plugin-contract validate-translation-exchange proposal.json
tsumugi-plugin-contract match-translation-extraction input.json proposal.json
tsumugi-plugin-contract validate-translation-extraction-check-input check.json
tsumugi-plugin-contract validate-translation-import-declaration declaration.json
```

Schema generation commands (`schema-translation-extraction-input`, `schema-translation-exchange`, `schema-translation-extraction-check-input`, `schema-translation-import-declaration`, `schema-translation-types`, and their `check-<kind>-schema` counterparts) feed `generate-contracts.mjs` to emit TypeScript definitions and standalone JavaScript structural validators.
