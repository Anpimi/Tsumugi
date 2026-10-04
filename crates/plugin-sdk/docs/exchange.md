# Experimental content and invocation exchange

Exchange protocol `1` is independent of the SDK's `0.1.0-alpha.1`, manifest
protocol and each schema/behavior/profile identity. It is an experimental data
contract, not a stable runtime API. The desktop still uses built-in integrations.
Nothing in this unit loads plugins or changes project persistence.

`ExchangeDocument` wraps one typed content, request, result, check-set or
check-results body. Rust/Serde is the source of the generated
[`content-exchange.schema.json`](../schemas/content-exchange.schema.json).
`parse_exchange` rejects unsupported protocol, unknown/duplicate envelope fields,
malformed references and semantic integrity errors. The whole encoded UTF-8 frame
is limited to 2 MiB, including escaping and framing, with bounded collections.
These transport ceilings do not enlarge any domain profile's smaller limits.

## Three layers of content

`ContentExchange` separates these representations:

| Layer | Fields | Meaning |
|---|---|---|
| Generic semantics | Units, source revision references, decoded text, occurrences, order, typed relations and protected fragments | Operation-local proposals or captured references, as defined by the capability |
| Domain extensions | Target, namespaced schema/behavior identity, handling and exact UTF-8 payload | Domain-owned interpretation, without an open property bag |
| Original fidelity | Captured UTF-8 artifacts, logical path, role, SHA-256 and source ranges | Immutable original bytes, including BOM, line endings and unedited records |

An occurrence references an artifact and a range in its exact original string.
Protected fragments instead reference decoded unit text. The decoder checks
digests, references, complete occurrence order, owners, duplicate identities and
range boundaries. Relations can represent hierarchy or another graph; timing,
layout, native identity policy and other domain meanings remain profile-owned.
The host's existing locale owner validates supported canonical language values;
the SDK only bounds their wire labels.

Native identity `value` is the domain-provided canonical matching value, not
necessarily the original literal. Literal identity and semantic revision basis
remain in versioned domain blocks. Core must not normalize that value again or
accept operation-local extraction revision references as authoritative project
revisions. The [source extraction contract](source-extraction.md) fixes raw
material separately from a proposed `ContentExchange`.

Domain payloads are strings intentionally preserved without parsing and
reserializing their members. `required` blocks need the exact interpreter for an
operation that uses them; `require_supported_extensions` checks that requirement.
Stored text and opaque evidence can still be read. `preserve` payloads must remain
exact even if understood. Unknown `optional` blocks may be uninterpreted but are
also preserved by the default fidelity check. This is preservation of bytes,
not a claim that an arbitrary payload is valid domain JSON or understood.

`verify_content_preservation` compares immutable captured artifacts and required
opaque preservation. `verify_fixed_content_scope` additionally compares units,
source revisions, native occurrence evidence, order and relations for a
fixed-segmentation transformation. It rejects self-consistent but out-of-scope
output. Extraction and explicit split/merge operations need their own output
contract and Core identity adoption. These helpers do not validate decoded text
against JSONC/caption grammar, protected structure semantics or domain layout.
Domain validation and independent fidelity oracles remain necessary.

## Explicit text coordinates

Ranges are half open, with `utf8-byte`, `utf16` or `grapheme` encoding. Conversion
uses the same exact string. UTF-8 ranges cannot split a code point; UTF-16 cannot
split a surrogate pair. Graphemes use extended Unicode grapheme clusters from the
pinned segmentation dependency. Conversion to graphemes rejects a scalar boundary
inside a cluster. No conversion rounds, normalizes or truncates user text.
Byte ranges in original JSON strings must not be reused in decoded strings.

The public Unicode oracles cover Chinese, a skin-tone/ZWJ emoji, combining marks,
escaped source strings, BOM, CRLF and empty/end ranges. `source-unicode.contract.json`
and the companion sample were copied from this repository's self-authored MIT
fixtures so the standalone package retains their independent expected offsets.
The exchange fixtures represent those samples; they are not real executing
plugin packages or proof of full domain conformance.

## Captured request and actual channel

`InvocationRequest` fixes project/operation/attempt/item/dispatch/scope, input,
scope/environment/configuration digests, package/component/contribution/instance
and activation generation, capability/profile, input/output/error schemas and
the maximum complete result frame. `EncodedPayload` preserves exact UTF-8 and
its SHA-256. Matching that digest does not validate the payload's domain schema.

`receive_invocation_result` compares the response with both the captured request
and an independently supplied actual channel binding. A self-reported plugin ID
is insufficient. Wrong project, item, dispatch, scope, package, instance, generation,
configuration, schema or behavior identity is rejected. Success, failure and
unknown outcomes remain distinct. None grants adoption or safe replay authority.

Only the runtime host can authenticate an actual package/channel, enforce current
permissions and revocation, check complete delegation and budgets, validate payload
schema/meaning and recheck current project dependencies in Core's mutation boundary.
The SDK has no authorizer, database, credential access or execution ledger.
Its binding values are claims until compared at that actual host boundary.

## Mandatory check coverage

The trusted Core policy owner captures a `FixedCheckSet` using
`capture_required_checks`: mandatory Core rules unioned with adopted domain rules.
The captured value is immutable; a received check-set projection cannot replace it.
Empty Core sets, weakened Core requirements and duplicate rule/implementation
identities are rejected. Rule schema/behavior and implementation identities,
input/scope digests, targets, mandatory/waivable policy and an explicitly allowed
not-applicable reason/basis are separate captured facts.

`evaluate` requires exact versions, implementations, input/scope basis and full
target coverage for each returned rule. Unknown, duplicate, stale, extra-target,
partial or illegal not-applicable results are rejected. Missing rules remain
`Missing`; failed, cancelled and unavailable are distinct incomplete states.
An empty result array does not complete a mandatory set. A completed rule with
zero findings is legitimate only with its full captured identity and coverage.

`CheckCoverage.complete` means the mandatory rules have completed coverage or an
explicitly allowed not-applicable result. It can include blocking findings. It
does not mean no errors, accepted waivers, human approval or release eligibility.
Core retains those decisions. Results must first be bound to their actual
producer; this data evaluator cannot authenticate a plugin's claims.

## Public harness and remaining boundaries

The [SDK README](../README.md) lists CLI commands. `validate-exchange` checks wire
integrity only. `match-result` additionally compares an independent channel-binding
fixture; that CLI fixture does not authenticate a live channel. `check-coverage`
treats its check-set file as an explicitly supplied captured policy fixture and
reports coverage, not a release decision. All semantic errors use static fields
and classifications rather than echoing rejected text.

Manifest/resource limits and production execution limits remain separate. Real
Host/Worker loading, source verification, OS enforcement, domain payload validators,
project adoption, runtime cleanup and cross-language execution are still required
before declaring corresponding runtime guarantees. No historical development
schema upgrade, compatibility fallback or parallel persistence is added here.
