# Existing Translation Import Contracts

The SDK provides these contracts for importing and verifying existing translations from domain files:

- `tsumugi.translation-extraction-input/2/1` (`TranslationExtractionInput`)
- `tsumugi.translation-exchange/2/1` (`TranslationExchange`)
- `tsumugi.translation-extraction-check-input/2/1` (`TranslationExtractionCheckInput`)
- `tsumugi.translation-import-declaration/1/1` (`TranslationImportDeclaration`)

These contracts share artifact, native identity, text range, provider binding, and check coverage types with [source extraction](source-extraction.md), and reuse `tsumugi.source-extraction-error` for extraction failures.

The supported schema-1 extraction input, translation exchange and checker input remain a complete text-only family. `TranslationImportBinding` accepts those exact schemas without rewriting historical captures, rejects mixed or unknown versions, and refuses binary artifacts under a schema-1 binding. Payload support does not itself grant filesystem access or add a material-selection workflow.

## Extraction Input and Proposal (`TranslationExtractionInput` & `TranslationExchange`)

`TranslationExtractionInput` (up to 2 MiB encoded) supplies the translation extractor with:

- The domain `profile` and an operation-local `importId`.
- The current project `sourceSetId` and `sourceSnapshotId`.
- The explicit `targetLanguage` and `languageEvidence` (`user-confirmed`), which the application verifies against the project's registered target languages before invoking the plugin (a locale hint in a filename such as `zh.json` is kept distinct from a canonical project target language such as `zh-CN`).
- `nativeScope`: the namespace and native-identity policy captured from the project's adopted source.
- The captured text or binary translation source `artifacts` (with original-byte SHA-256 digests and relative logical paths).

`TranslationExchange` (up to 2 MiB encoded) returns:

- The unmodified input artifacts and metadata, plus the domain file's `declaredLanguage`.
- `entries` (up to 2,000 `ImportedTranslation` items) and a complete `order` array.
- Each `ImportedTranslation` contains a unique operation-local ID, decoded translation text (up to 16 KiB; `""` is a valid empty string), a `SourceReference` with representation-appropriate original source coordinates, and `NativeIdentityEvidence` (canonical `value` plus original `display` spelling/reference) matching the input's `nativeScope`.

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

## Explicit Paired Native Materials

SDK `0.1.0-alpha.8` adds an opt-in family: extraction input, exchange and checker input `3/1`, selected by a translation resource `2/1`. The original helpers still select input/exchange/check `2/1` and resource `1/1`; supported schema-1 text bindings are unchanged. Use the `paired_translation_*_contract`, `parse_paired_translation_*` and generated `paired-translation` modules explicitly. Unknown or mixed families are rejected.

The paired resource replaces `material` with required, non-null `fileSets` and `maxTotalBytes`. It reuses source-import file-set names, roles, encodings, suffixes, counts, safe relative paths and actual-size checks. Roles must uniquely identify groups. The binding reconstructs the selected group order from captured roles, checks the entire ordered capture and rejects omitted required files, extra roles, encoding mismatches, path aliases and aggregate overflow. It does not scan directories or grant access.

The input requires `pairedSource` with the original `sourceLanguage` and exact original `artifacts`. The application obtains them from its authenticated adopted-source capture, keeps original identities, representation, order, paths and bytes, and rechecks them at registration against the current snapshot. A caller-supplied rehashed replacement is insufficient. The proposal carries only the target artifacts; the independent checker receives the complete paired input, the proposal and mandatory requirements. The domain must verify module/version/field identity, declared language, non-text compatibility and complete decoding before candidates can be used. Structural association alone proves none of those domain conclusions.

Each side retains the existing 2 MiB decoded-material cap. Paired encoded input is bounded at 6 MiB, proposal at 8 MiB, and compound checker input at 16 MiB; framing and application ledger budgets are separate. A larger encoded allowance never permits oversized raw captures. Schema-3 bindings may request an explicitly declared safe-relative format `Process`, as well as `CapturedInput`; single-file bindings remain captured-input only. Network, project service and staged-output permissions are rejected. Actual process execution still needs the application's independent approval and grant.

Schemas, Rust parsing and package metadata are API foundations. They do not provide an application file-selection journey, a native format reader, project candidate adoption or game validation by themselves. Historical single-file captures are not backfilled with original material. An earlier SDK cannot interpret the new family; use matching consumers and keep existing package/runtime pins unchanged until deliberately updated.

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

For the paired family, prefix the corresponding commands with `paired-translation`, for example:

```sh
tsumugi-plugin-contract validate-paired-translation-extraction-input input.json
tsumugi-plugin-contract match-paired-translation-extraction input.json proposal.json
tsumugi-plugin-contract validate-paired-translation-extraction-check-input check.json
tsumugi-plugin-contract validate-paired-translation-import-declaration declaration.json
```

The `schema-paired-translation-*` and `check-paired-translation-*-schema` commands cover the input, exchange, checker, resource and aggregate type schemas. Generated structural validators do not replace bounded Rust parsing or the independent domain checker.
