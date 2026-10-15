# Source context facts

`tsumugi.source-context-facts/1/1` describes bounded context associated with a
captured source. Use it as a `DomainBlock` in the existing content exchange.
The block's `target` supplies snapshot, unit or occurrence applicability; facts
do not allocate project units, revisions, entities or human decisions.

A fact has an operation-local `id`, a presentation `kind`, literal `text`, and
an explicit `origin`. Kinds are `speaker`, `role`, `scene`, `time`, `location`
and `note`. The domain owns interpretation and literal spelling. The SDK does
not infer a speaker from a key, parse a caption time, normalize text or convert
an interpretation into an extracted fact.

- `extracted` requires captured source references.
- `inferred` requires both source references and a nonempty rationale. References
  describe its basis; they do not establish that the interpretation is true.
- Human project context remains in the application's separate revision owner.
  There is no `manual`, `approved`, consent or execution-grant field here.

Each reference identifies a captured artifact and a nonempty half-open range,
with explicit `utf8-byte`, `utf16` or `grapheme` coordinates. The receiving
content exchange checks artifact membership and exact Unicode boundaries with
the existing SDK text conversion. Neither a path nor a reference authorizes
reading another artifact or another project.

The independent domain checker must verify claimed extraction and interpretation
against the original source. Producer identity, checker evidence, actual source
revision, applicability, sharing selection and input capture remain trusted
application responsibilities. Structural validity supplies none of that authority.

## Constructing and checking a block

```js
import { encodeSourceContextFacts } from './source-context.mjs';
import { SOURCE_CONTEXT_FACTS_PROFILE } from './source-context-profile.mjs';

const block = {
  target: { kind: 'occurrence', id: occurrence.id },
  schema: SOURCE_CONTEXT_FACTS_PROFILE.contract,
  handling: 'optional',
  payloadUtf8: encodeSourceContextFacts({
    facts: [{
      id: 'voice-1',
      kind: 'speaker',
      text: speakerNameFromTheSource,
      origin: { kind: 'extracted', sources: [originalVoiceSourceReference] },
    }],
  }),
};
```

The JavaScript encoder snapshots a plain data value and checks the actual
encoded budget, explicit origins, identities and range ordering. Its generated
validator, types and frozen limits come from the Rust owner. It cannot establish
artifact membership or Unicode boundaries without the captured material.

Rust callers can use `parse_source_context_facts` for the bounded body and
`parse_source_context_block` with their captured artifacts for the exact contract
and coordinate associations. `ContentExchange::validate` checks supported context
blocks as part of the original content receiver. It preserves the original
payload bytes, including whitespace; it does not rewrite the block.

Facts have no implicit sharing policy. Applications must preview the actual
selected material and require applicable consent before sending it. A block
relevant to source revision identity must be included in the producer's captured
`SourceRevisionPolicy.revisionBasis`. Later facts must not rewrite an original
generation input or restore a historical execution grant.

Unknown versions retain the existing extension handling: preserve opaque bytes
where permitted and refuse an operation requiring an unsupported interpreter.
A malformed supported `1/1` block is refused rather than reclassified as unknown.
An empty `facts` array is an explicit empty observation, distinct from no block.

## Limits and conformance

The current profile allows 32 facts, 8 distinct source references per fact,
4096 UTF-8 bytes per text or inference rationale, and 64 KiB for the complete
serialized body. Counts, text and complete encoded-byte limits are independent;
the receiver never truncates or silently drops an entry. JSON Schema character
bounds alone cannot establish UTF-8 byte budgets or source associations.

```sh
cargo test -p tsumugi-plugin-sdk --features schema --locked --test source_context --test source_extraction
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-context-facts
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-source-context-facts crates/plugin-sdk/tests/fixtures/source-context-facts.json
```

The cross-language conformance test accepts an already-built absolute SDK CLI
through `TSUMUGI_PLUGIN_CONTRACT`; it installs nothing and uses synthetic data.
These SDK contracts alone do not implement domain collection, project capture,
provider sharing or a desktop context workflow.
