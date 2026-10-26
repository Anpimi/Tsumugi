# Source Context Facts

The `tsumugi.source-context-facts/1/1` contract defines a structured `DomainBlock` payload for attaching source-derived contextual facts to a `ContentExchange` snapshot, unit, or occurrence.

## Data Model and Origins

Each fact in a `tsumugi.source-context-facts` block includes:

- `id`: an operation-local identifier.
- `kind`: one of `speaker`, `role`, `scene`, `time`, `location`, or `note`.
- `text`: the literal context string (up to 4,096 UTF-8 bytes), preserved as provided by the domain extractor without normalization.
- `origin`: how the fact was obtained from the source material:
  - `extracted`: requires 1 to 8 `SourceReference` ranges pointing to the exact source artifacts where the fact appears.
  - `inferred`: requires 1 to 8 `SourceReference` ranges plus a non-empty `rationale` string (up to 4,096 UTF-8 bytes) explaining the inference.

User-authored project context is managed separately by Core's project revision store rather than through `source-context-facts` blocks.

Every `SourceReference` specifies a captured artifact ID and a non-empty half-open `TextRange` (`utf8-byte`, `utf16`, or `grapheme`). When validating a `ContentExchange`, the receiver verifies that every referenced artifact exists in the exchange and that every range aligns with valid Unicode scalar or grapheme boundaries via the SDK's text coordinate converter.

## Constructing and Parsing Context Blocks

### JavaScript Encoding

Plugin authors can construct and validate context blocks in JavaScript using `encodeSourceContextFacts` and `SOURCE_CONTEXT_FACTS_PROFILE`:

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

`encodeSourceContextFacts` snapshots the input object and validates fact counts, IDs, origins, range ordering, and the 64 KiB serialized byte limit before returning the UTF-8 JSON string.

### Rust Parsing and Revision Policy

In Rust:

- `parse_source_context_facts` validates the standalone JSON payload against the `1/1` schema and byte limits.
- `parse_source_context_block` additionally verifies the `DomainBlock` contract reference and resolves all `SourceReference` coordinates against the captured source artifacts.
- `ContentExchange::validate` automatically validates any `tsumugi.source-context-facts/1/1` blocks present in a `ContentExchange` while preserving the original `payloadUtf8` bytes (including whitespace). Malformed `1/1` blocks fail validation rather than falling back to unknown-extension handling. An empty `facts: []` array represents an explicit empty observation.

If a domain profile treats context facts as part of a unit's semantic revision identity, its `SourceRevisionPolicy.revisionBasis` must list `tsumugi.source-context-facts/1/1`. When forwarding context facts to external model endpoints, the application's execution preview discloses the selected context alongside source text for user consent.

## Limits and Conformance CLI

| Item | Limit |
| --- | --- |
| Facts per block | 32 |
| Source references per fact | 8 distinct references |
| `text` / inference `rationale` length | 4,096 UTF-8 bytes each |
| Complete serialized block payload | 64 KiB |

Run the conformance tests and CLI commands from the repository root:

```sh
cargo test -p tsumugi-plugin-sdk --features schema --locked --test source_context --test source_extraction
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-context-facts
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-source-context-facts crates/plugin-sdk/tests/fixtures/source-context-facts.json
```
