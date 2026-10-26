# Content and Invocation Exchange

Exchange protocol `1` defines the wire envelopes and semantic invariants for passing extracted source content, invocation requests and results, and QA check coverage between the Host and plugin components. Its schema is generated from the Rust types into [`content-exchange.schema.json`](../schemas/content-exchange.schema.json).

`ExchangeDocument` wraps a single typed body (`content`, `request`, `result`, `check-set`, or `check-results`). `parse_exchange` enforces protocol version `1`, rejects unknown or duplicate fields, and validates internal references and byte budgets:

| Envelope / Collection | Limit |
| --- | --- |
| Complete encoded `content` frame | 4 MiB (including JSON escaping and envelope framing) |
| Other `ExchangeDocument` frames | 2 MiB |
| Combined invocation inputs | 4 MiB |
| Captured source material / build artifacts | 2 MiB each |
| Content units, occurrences, order entries, relations | 2,000 items each |
| Domain extension blocks (`DomainBlock`) | 4,000 items (allowing both identity and context blocks per unit/occurrence) |

## Three-Layer `ContentExchange` Model

`ContentExchange` separates translatable content into three distinct layers so format-specific syntax and byte fidelity are preserved alongside generic translation units:

| Layer | Fields | Purpose |
|---|---|---|
| Generic semantics | Units, source revision references, decoded text, occurrences, order, typed relations, and protected fragments | Translatable text units, structural relationships, and inline protected placeholders |
| Domain extensions | Target reference, namespaced schema/behavior ID, handling mode (`required`, `preserve`, `optional`), and UTF-8 payload | Format- or domain-specific metadata (such as native identity evidence or source context facts) |
| Original fidelity | Captured UTF-8 artifacts, logical path, role, SHA-256 digest, and source character/byte ranges | Unmodified original file bytes (including BOMs, line endings, and surrounding syntax) |

- **Occurrences vs. Protected Fragments**: Each occurrence references a source artifact and a character/byte range in that artifact's raw string. Protected fragments reference ranges within a unit's decoded text.
- **Native Identity Evidence**: `NativeIdentityEvidence.value` holds the domain's canonical matching key, while `display` preserves the original spelling and source range (or `null` for derived keys). Core matches units using the canonical value directly without re-normalizing it.
- **Domain Extension Handling**: Domain block payloads are stored as exact UTF-8 strings without parsing and re-serializing their internal fields. Blocks marked `required` must be listed as supported when calling `require_supported_extensions`. Blocks marked `preserve` (and unrecognized `optional` blocks) must be carried through unchanged.
- **Preservation Helpers**: `verify_content_preservation` checks that immutable source artifacts and preserved domain blocks are untouched. `verify_fixed_content_scope` additionally checks that units, source revisions, native occurrence evidence, ordering, and relations remain identical across fixed-segmentation transformations.

## Unicode Text Coordinates

Text ranges (`TextRange`) are half-open intervals `[start, end)` tagged with an explicit coordinate encoding:

- `utf8-byte`: byte offsets into the UTF-8 string; must not split a UTF-8 scalar value.
- `utf16`: UTF-16 code unit offsets; must not split a surrogate pair.
- `grapheme`: extended Unicode grapheme cluster offsets (using the pinned Unicode segmentation rules); converting from byte or UTF-16 offsets rejects boundaries that fall inside a grapheme cluster.

Coordinate conversions (`convert_text_range`) operate on the exact target string without normalizing, rounding, or truncating text. Ranges computed against raw JSON source files must not be applied directly to unescaped decoded unit strings. The conformance test suite (`source-unicode.contract.json`) verifies offset conversions across CJK text, skin-tone and ZWJ emoji sequences, combining marks, escaped JSON strings, UTF-8 BOMs, and CRLF line endings.

## Invocation Requests and Channel Correlation

`InvocationRequest` pins the full context for a single capability call:

- Project, operation, attempt, item, dispatch, and scope identifiers.
- Input payload (`EncodedPayload` with exact UTF-8 and SHA-256) and scope/environment/configuration digests.
- Provider identity (`ProviderBinding`: package digest, component ID, contribution ID, live instance ID, and activation generation).
- Capability/profile references, input/output/error schema references, and `maxResultBytes`.

When a worker replies, `receive_invocation_result` verifies the result frame against both the original `InvocationRequest` and the Host's independently tracked channel `ProviderBinding`. Any mismatch in project, item, dispatch, scope, package digest, instance ID, activation generation, configuration digest, or schema/behavior version is rejected. Outcomes are classified explicitly into `Succeeded`, `Failed`, or `Unknown`.

## Mandatory Check Coverage (`FixedCheckSet`)

Core constructs an immutable `FixedCheckSet` via `capture_required_checks`, combining mandatory Core QA rules with any domain check rules required by the active source or build profile. Each captured requirement records the rule's schema/behavior version, implementation identity (`Core` or `Plugin` with its `ProviderSelectionBinding`), input and scope digests, target IDs, mandatory/waivable policy, and any permitted `not-applicable` reason and basis digest.

`FixedCheckSet::evaluate` checks a set of returned `CheckResult` items against the captured policy:

- Every required rule must match its exact version, provider identity, input/scope digests, and complete target set.
- Unknown, duplicate, stale, out-of-scope, or partially covering results are rejected, as are `not-applicable` results where the policy does not allow them.
- Rules not present in the results remain `Missing`; `Failed`, `Cancelled`, and `Unavailable` results are tracked as distinct incomplete states. An empty result array never satisfies a non-empty `FixedCheckSet`.
- `CheckCoverage.complete` indicates that every mandatory rule either completed across all targets or returned an explicitly permitted `not-applicable` result. A complete check set may still contain blocking error findings that Core will use to gate adoption or release.

## Conformance CLI Commands

See the [SDK README](../README.md) for full CLI invocation examples:

- `validate-exchange <file>`: validates wire formatting and internal references of an `ExchangeDocument`.
- `match-result <request.json> <result.json> <channel.json>`: runs `receive_invocation_result` against request, result, and channel fixture files.
- `check-coverage <set.json> <results.json>`: runs `FixedCheckSet::evaluate` and reports coverage status.
