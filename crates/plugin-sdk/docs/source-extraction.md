# Experimental source extraction

Source extraction uses the existing bounded invocation/process transport. It
does not add filesystem handles, permissions, project revisions or another wire
envelope. An independently selected capability fixes the following exact payload
contracts. These versions are independent of SDK SemVer:

| Payload | Contract ID | Schema / behavior |
|---|---|---|
| `SourceExtractionInput` | `tsumugi.source-extraction-input` | 1 / 1 |
| `ContentExchange` | `tsumugi.content-exchange` | 2 / 1 |
| `SourceExtractionError` | `tsumugi.source-extraction-error` | 1 / 1 |
| `SourceExtractionCheckInput` | `tsumugi.source-extraction-check-input` | 1 / 1 |
| `CheckResult[]` | `tsumugi.check-results` | 1 / 1 |

The SDK exports the IDs and the constructors `source_extraction_input_contract`,
`content_exchange_contract` and `source_extraction_error_contract`. A domain
profile is a separate `ContractRef`; these payload IDs do not select a parser.

## Captured material and proposals

`SourceExtractionInput` carries `profile`, `sourceSetId`, `sourceLanguage` and
`artifacts`. Artifacts retain exact captured UTF-8 bytes, including BOM, newline
sequences, combining marks and emoji, with their IDs, logical paths, roles and
SHA-256 digests. Logical paths cannot grant access to a local file. The platform
still captures the authorized material; the SDK does no IO.

`SourceExtractionInput::validate` and `ContentExchange::validate` use one shared
material validator for bounded labels, artifact count, aggregate bytes, unique
IDs/paths, safe logical paths and actual byte digests. The generic ceilings remain
2 MiB and 2,000 artifacts; a selected domain may require smaller limits. The
receiver also limits the entire encoded input to 2 MiB. The SDK checks a bounded
language label, while the existing host locale owner checks canonical supported
languages. Strict Serde receivers reject unknown/duplicate fields and invalid
UTF-8. JSON Schema alone does not check byte digests or these associations.

`validate_source_extraction(input, exchange)` verifies both structures and fixes
the result to the captured profile, source set, language and exact complete
artifact set. Reordering artifacts does not change that set; occurrence order is
explicit in `ContentExchange.order`. New or missing material, changed metadata,
normalization or recomputed digests cannot replace captured evidence.

The function validates source references and coordinate boundaries through the
existing content validator. It does **not** parse a domain grammar, prove complete
cue/key extraction, validate decoded text against raw syntax, interpret domain
blocks or grant adoption. A structurally associated result still needs the
selected domain's semantic checks and the host's current authorization.

During extraction, unit IDs and `sourceRevisionId` are operation-local proposal
references. Only Core allocates or maps authoritative project units/revisions and
decides explicit lineage. `NativeIdentityEvidence.value` is the domain-provided
canonical matching value; Core must not normalize or casefold it again. The
required `display` carries the original domain-confirmed spelling and a captured
source reference, or explicit `null` for a derived identity. The SDK checks its
nonempty bounded value and reference boundaries; the domain checks its meaning.
Matching uses the exact namespace, complete policy reference and canonical value.

`SourceRevisionPolicy` is captured by the trusted policy owner before receiving
a proposal. It selects unique exact domain-block schemas whose opaque payload
bytes contribute to semantic source revisions, alongside unit text and protected
fragments. It never comes from the proposal. Core can compare those bytes without
parsing their domain schema or treating operation-local IDs as revision evidence.

## Fixed source checks

`SourceExtractionCheckInput` carries the entire captured `source`, entire
`proposal`, and independently fixed `requirements`. The receiver enforces the
generic source association and unique nonempty plugin requirements. Each is
mandatory, cannot be waived or declared not applicable, and covers exactly the
captured source-set ID. Rules, digests and selected provider are preserved.

`CheckImplementation::Plugin.provider` is the four-field
`ProviderSelectionBinding`; an active instance is unavailable at policy capture.
The trusted Host separately supplies full actual-channel evidence. A claim in a
request or response cannot authenticate that channel or package.

The checker returns the existing strict `CheckResult[]` shape. The trusted caller
unions its mandatory Core checks with domain requirements, then evaluates exact
rule, provider, input/scope digest and coverage. Complete coverage can still have
error findings: it does not itself approve the source. Failed, unavailable,
cancelled, incomplete or blocking checks cannot authorize adoption. Domain checks
execute outside project write transactions; the mutation boundary rechecks the
captured evidence and current authorization.

`parse_content_exchange`, `parse_source_extraction_check_input`, and
`parse_check_results` bound the complete raw JSON and reject duplicate or unknown
typed fields. These are data receivers and perform no execution or project IO.
Content schema 2 requires display evidence; previous experimental shapes are
rejected rather than migrated.

## Public errors

`SourceExtractionError` has a finite kebab-case `code`, nullable `artifactId`, and
`detail`. Codes are `invalid-input`, `unsupported-profile`, `invalid-source`,
`unsupported-structure`, `limit-exceeded`, and `cancelled`. They remain separate
from transport failure, process crash and an unknown outcome.

Details must be nonempty, contain no NUL, and fit 4,096 UTF-8 bytes. The complete
encoded error is limited to 32 KiB. An artifact ID is a captured identifier, not a
path; a caller must associate it with the captured input. Producers use public
diagnostics and must not include local paths, raw source text or secrets. The SDK
cannot authenticate provenance or determine that arbitrary text is safe to share.

## Generated JavaScript types and conformance

Rust is the sole source for the standalone input/error schemas and the build-time
`content-types.schema.json` type catalog. The catalog is not an accepted invocation
payload or another exchange protocol. The existing Host generator converts it
into [`content.d.ts`](../javascript/content.d.ts), including extraction, content,
identity, domain-block and explicit text-range types. Do not edit these generated
declarations or create a handwritten mirror.

The same generator emits `javascript/validate-source-extraction-input.mjs` and
`javascript/validate-source-extraction-check-input.mjs` from their standalone
schemas. Each default export is a structural validation
function with an `errors` property, generated by the existing Ajv emitter. The
artifact has no Ajv or other runtime import; generation rejects an emitter output
that would require one. The SDK's [MIT license](../LICENSE) applies, and the
generated validator includes the installed, locked Ajv emitter's version and
complete MIT notice. An author may copy the fixed generated artifact together
with the SDK license, preserving the source/emitter attribution rather than
copying the SDK's record shape into a handwritten validator.

This validator operates on already-parsed JavaScript values. `JSON.parse` silently
replaces duplicate object fields, so it cannot substitute for the strict Rust
Serde receiver for raw JSON. Generated structural validation also does not check
actual hashes, logical path semantics, byte/count ceilings or domain meaning.
Hosts still use the SDK semantic validator; plugins still enforce their selected
profile and smaller domain limits. Hosts must serialize invocation payloads from
SDK-validated typed captured data, rather than treating arbitrary raw JSON as
trusted. This data contract alone does not connect a production Core producer.

From the repository root, after building the SDK harness:

```sh
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-exchange > crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-extraction-input > crates/plugin-sdk/schemas/source-extraction-input.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-extraction-error > crates/plugin-sdk/schemas/source-extraction-error.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-extraction-check-input > crates/plugin-sdk/schemas/source-extraction-check-input.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-check-results > crates/plugin-sdk/schemas/check-results.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-content-types > crates/plugin-sdk/schemas/content-types.schema.json
pnpm --dir runtimes/javascript-host generate:contracts
pnpm --dir runtimes/javascript-host check:contracts
cargo test --locked --offline -p tsumugi-plugin-sdk --features schema
TSUMUGI_PLUGIN_CONTRACT="$PWD/target/debug/tsumugi-plugin-contract" node --test crates/plugin-sdk/tests/source-extraction.test.mjs
```

These commands use existing installed build dependencies and do not install them.
When a custom Cargo target directory is used, supply the actual absolute harness
path. The CLI also provides `validate-source-extraction-input`,
`validate-source-extraction-error`, and `match-source-extraction <input> <exchange>`.
The latter expects the existing `ExchangeDocument` content wrapper; a live
invocation instead carries its `ContentExchange` as the selected encoded payload.

The public JavaScript/Rust fixture checks exact Unicode bytes and hashes, strict
receiver behavior, schema currentness and rejection of independently rewritten
material. It is data conformance, not proof of a domain implementation, process
identity, source approval or project adoption.
