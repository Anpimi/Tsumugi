# Two-Domain Quality Evaluation Corpus

This directory contains a self-authored, MIT-licensed evaluation corpus covering both the Stardew SMAPI (`smapi-i18n-flat` `1/1`) and WebVTT (`webvtt-captions` `1/1`) source profiles across two source generations (`S1` and `S2`).

## Corpus Layout (`cases.json`)

`cases.json` (edition `1`) defines the evaluation cases for explicit project languages `en` → `zh-CN`:

| Domain | Source Profile | Generation Files |
| --- | --- | --- |
| `stardew-smapi` | `smapi-i18n-flat` `1/1` | `smapi/s1/` and `smapi/s2/`: `manifest.json`, `i18n/default.json` |
| `webvtt` | `webvtt-captions` `1/1` | `webvtt/s1.vtt` and `webvtt/s2.vtt` (captured as `source.vtt`) |

- **Format & Encoding**: All source files use UTF-8 without BOM and LF line endings. Multi-line text uses an escaped `\n` in SMAPI JSON and two physical lines in WebVTT cues.
- **Extraction Oracles (`expected`)**: Each generation contains six entries with independently authored extraction expectations: literal display key (`Welcome` retains its uppercase display spelling while its canonical identity is `welcome`), decoded source text, canonical native identity, and SDK revision policy.
- **Parallel Linguistic Challenges**: Both domains use the exact same six English messages to isolate format differences from translation behavior. Together they cover a repeated glossary term, a context-sensitive polysemous word ("bank" as river bank), an inline placeholder, Unicode characters, and a short ambiguous UI action ("Open").
- **Targeted Terms & Context (`terms` and `contexts`)**: Explicit evaluation inputs scoped by generation and key so tests can verify whether approved terminology and context notes were adopted and disclosed.
- **Upstream Maintenance (`S1` → `S2`, `maintenance`)**: `S2` retains the greeting and Waystation entries, updates a required count (`2` → `3`), renames a key/cue (`panel-old` → `panel-new` with the same text `"Open"`), deletes a ferry message (`obsolete`), and adds a new ferry message (`newcomer`). For the river message, SMAPI keeps it unchanged while WebVTT updates only its cue end timestamp. `maintenance` records the seven expected human maintenance relationships across the six entries.

For larger-scale and edge-case structural tests, see the companion [Lookup Anything fixture](../stardew-lookup/README.md), [upstream maintenance fixture](../upstream-maintenance/README.md), and [WebVTT caption fixture](../webvtt/README.md).

## Running the Compatibility Corpus Check

See the [plugin authoring guide](../../../../../docs/plugin-authoring.md) ([checking contracts](../../../../../docs/plugin-authoring.md#check-contracts-without-running-a-plugin) and [loading development packages](../../../../../docs/plugin-authoring.md#load-a-development-package-explicitly)) for background on building and inspecting domain plugin packages with `tsumugi-plugin-package inspect`.

To verify all four corpus snapshots (`smapi/s1`, `smapi/s2`, `webvtt/s1.vtt`, `webvtt/s2.vtt`) through the real JavaScript worker extractors and independent semantic checkers, provide the prebuilt plugin packages and approved runtime environment variables from the repository root:

```text
cargo test --locked --offline \
  --manifest-path crates/plugin-host/compatibility/Cargo.toml \
  --features javascript-conformance --test quality_corpus \
  fixed_quality_material_is_complete_and_independently_checked \
  -- --exact --ignored --nocapture --test-threads=1
```

Required environment variables:

- `TSUMUGI_TEST_SMAPI_PACKAGE` and `TSUMUGI_TEST_SMAPI_DIGEST`
- `TSUMUGI_TEST_WEBVTT_PACKAGE` and `TSUMUGI_TEST_WEBVTT_DIGEST`
- `TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST`, and `TSUMUGI_TEST_RUNTIME_APPROVAL`

This test runs the extractors and semantic checkers against `cases.json` (including negative checks against mutated content) without calling external AI providers.

## Review Protocol and Offline Drill Examples

See [`review-protocol.md`](review-protocol.md) for the blinded human evaluation procedure across structure, terminology, context, editing effort, and `S2` maintenance reuse:

- [`drill/packet.json`](drill/packet.json), [`drill/review-example.json`](drill/review-example.json), and [`drill/reveal.json`](drill/reveal.json) are self-authored offline drill examples illustrating how reviewer packets are separated from candidate identity reveals.
- By default in this repository, the live model request budget is `0` and live provider evaluations remain `NOT-RUN` until an operator configures an `AiConfig` / `ArenaConfig` preview and explicitly approves a run.
