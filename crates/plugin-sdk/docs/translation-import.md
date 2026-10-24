# Existing translation data

The experimental SDK provides four data contracts at schema/behavior `1/1`:
`tsumugi.translation-extraction-input`, `tsumugi.translation-exchange`,
`tsumugi.translation-extraction-check-input` and
`tsumugi.translation-import-declaration`. They share captured artifact, native
identity, text-range, provider and required-check types with source extraction.
Errors reuse the bounded `tsumugi.source-extraction-error` material-extraction
contract. The process protocol, application data format and SDK package version
remain independent of these identities.

## Fixed capture and complete proposal

`TranslationExtractionInput` fixes a profile, operation-local `importId`, current
`sourceSetId`/`sourceSnapshotId`, explicit `targetLanguage`, `nativeScope` and the
complete original UTF-8 artifacts. `nativeScope` contains the namespace and exact
native-identity policy captured from adopted source. `languageEvidence` records
`user-confirmed`; a wire value alone cannot establish that a person consented.
Only the trusted application can approve capture, runtime execution or adoption.

The application must verify that the source is current, its profile/native scope
match, and the chosen canonical target is a registered language in that project.
Import cannot create a project language or silently infer a regional mapping.
For example, a filename declaration `zh` and a chosen project target `zh-CN`
remain distinct evidence, even after the user explicitly confirms the mapping.

`TranslationExchange` retains every captured byte and metadata field once, adds
the domain's `declaredLanguage`, and supplies `entries` and a complete `order`.
Each `ImportedTranslation` has an operation-local ID, decoded text, an explicitly
encoded original `SourceReference`, and `NativeIdentityEvidence` including the
original display spelling/reference. Empty text is a value; an empty proposal
retains its original file and scope with empty entries/order. No entry can carry
an authoritative project unit or source-revision allocation.

Both input and proposal are bounded by 2 MiB of complete encoded UTF-8 data.
Proposals admit at most 2000 entries and 16 KiB per decoded text. IDs/order must
be unique with exact coverage, references must land on scalar boundaries in
captured artifacts, native evidence must use the fixed scope, and original hashes
must match actual bytes. `validate_translation_extraction` compares the fixed
input/proposal scope and complete artifact collections. It does not decode a
domain file, interpret filename languages, normalize native keys, prove complete
domain extraction or resolve current project matches.

## Independent checks and project decisions

`TranslationExtractionCheckInput` contains the original input, complete proposal
and an independently frozen set of mandatory, nonwaivable plugin requirements
targeting `importId`. It admits 4 MiB of complete encoded data. The domain checker
returns the existing `CheckResults`, reparsing original material independently
of the extractor. Caller policy must compare exact rule/version, package
selection, original digests, full target coverage and the actual Host channel.
Completed coverage with error findings still blocks adoption. A checker cannot
replace the fixed policy or authorize project writes.

After these checks, Core owns current-source matching by the selected native
policy, unresolved/ambiguous results, selected-translation conflicts, candidate
and revision IDs, and explicit per-entry decisions. Current source/revision,
target language, selection and result/proof bases must be rechecked inside the
existing mutation transaction. Preserve unselected evidence, original action
identity, idempotent receipts and uncertain-outcome recovery; this SDK creates
no second project, candidate or execution ledger.

## Resource selection

`TranslationImportDeclaration` describes one material selected relative to an
explicitly granted directory: a portable `logicalDirectory`, lowercase alphanumeric
`extension`, role and byte limit. It binds an exact profile, extractor, separate
read-only checker and nonempty semantic rules. The resource grants no path or
execution authority, runs no discovery program and contains no glob syntax.
`TranslationImportBinding.validate_input` enforces one immediate selected file,
extension, role, profile and raw byte limit. Domain restrictions such as the
meaning of `default.json` remain in the selected domain checker.

The Host reads only its captured resource bytes and binds both contributions to
that exact package. Metadata selection does not start a Worker, approve a
publisher, install a package, restore grants or adopt results. Desktop capture,
the independent domain implementation and Core matching/adoption integration
remain required consumers; these data helpers alone do not complete migration.

## Public harness

From a built `tsumugi-plugin-contract` binary:

```sh
tsumugi-plugin-contract validate-translation-extraction-input input.json
tsumugi-plugin-contract validate-translation-exchange proposal.json
tsumugi-plugin-contract match-translation-extraction input.json proposal.json
tsumugi-plugin-contract validate-translation-extraction-check-input check.json
tsumugi-plugin-contract validate-translation-import-declaration declaration.json
```

Rust owns the types, semantic data checks and schemas. Generate schemas with
`schema-translation-extraction-input`, `schema-translation-exchange`,
`schema-translation-extraction-check-input`, `schema-translation-import-declaration`
and `schema-translation-types`; corresponding `check-<kind>-schema` commands
refuse stale files. The SDK's `generate:contracts` command
generates SDK declaration types and standalone structural validators. JSON.parse
and JSON Schema cannot replace strict Rust duplicate-field rejection, exact
hash/reference association, actual channel checks or domain semantics.
