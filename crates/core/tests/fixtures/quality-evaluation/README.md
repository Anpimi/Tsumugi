# Fixed two-domain quality evaluation materials

This small, self-authored corpus is distributed under the repository's MIT
license. It contains no captured user data or third-party translations. It is
source material for the current SMAPI flat-JSON and WebVTT caption profiles,
not a runnable game mod, a general language benchmark, or evidence of model
quality. The synthetic SMAPI manifest's DLL is not supplied or executed.

`cases.json` is the edition-1 reading interface. Languages are explicitly `en`
and `zh-CN`; neither filenames nor text infer project languages. Each domain
has six entries in each of two generations. The `expected` arrays are an
independently written, ordered extraction oracle: literal display key, decoded
source text, canonical native identity and SDK policy. They are not target
translations or a semantic quality score. `Welcome` deliberately retains its
display case while its canonical identity is `welcome`.

| Domain | Source profile | Generation files |
| --- | --- | --- |
| `stardew-smapi` | `smapi-i18n-flat` 1/1 | `smapi/s1/` and `smapi/s2/`: `manifest.json`, `i18n/default.json` |
| `webvtt` | `webvtt-captions` 1/1 | `webvtt/s1.vtt` and `webvtt/s2.vtt`, each captured as `source.vtt` |

All files use UTF-8 without a BOM and LF line endings. JSON source text uses
an escaped newline; the corresponding caption payload has two physical lines.
The files stay within the existing profiles: flat string values, explicit
ASCII keys/cue IDs, nonempty plain caption payloads and increasing cue starts.
There is no markup, entity decoding, nested JSON or inferred speaker metadata.

The two domains intentionally use the same six source messages so that changing
format does not silently change the language task. They exercise a repeated
approved term, a context-dependent sense of “bank”, a placeholder, Unicode and
a short ambiguous action. `terms` and `contexts` are explicit evaluation inputs
targeted by version and key. They do not automatically become adopted project
resources, source facts, model-visible context or permission to share data.

S2 keeps the greeting and Waystation text, changes a required count, proposes an
explicit key/cue rename, removes a ferry message and adds a different ferry
message. SMAPI also keeps the river message unchanged; WebVTT changes only its
end time. There are seven maintenance relationships for six entries per
generation. `maintenance` states the intended human decisions, not an automatic
matching, adoption, approval or QA result. Equal text is insufficient to approve
the rename or to carry a deleted entry to the new key.

## Consume through the existing owners

Start with the [public plugin authoring guide](../../../../../docs/plugin-authoring.md),
its [SDK commands](../../../../../docs/plugin-authoring.md#check-contracts-without-running-a-plugin)
and [explicit loading flow](../../../../../docs/plugin-authoring.md#load-a-development-package-explicitly).
Inspect the selected prebuilt packages with the existing
`tsumugi-plugin-package inspect <prebuilt-directory>` CLI. Package identity and
digest belong to those selected materials, not to this corpus's edition.

Use `versions[].files` as the complete capture recipe, with paths relative to
this directory and the listed logical paths and roles. Prepare and run the
original source extractor, then prepare and run its independently authorized
source semantic checker. Compare every extracted entry, its order and native
identity to the literal oracle; retain the complete raw artifacts and original
references. The existing source comparison and explicit identity decisions own
any later S2 adoption. Do not write fixture rows directly into a project store.

The existing real-worker compatibility target consumes all four captures. From
the repository root, provide `TSUMUGI_TEST_SMAPI_PACKAGE`,
`TSUMUGI_TEST_SMAPI_DIGEST`, `TSUMUGI_TEST_WEBVTT_PACKAGE`,
`TSUMUGI_TEST_WEBVTT_DIGEST`, `TSUMUGI_TEST_RUNTIME_TOOL`,
`TSUMUGI_TEST_RUNTIME_HOST` and `TSUMUGI_TEST_RUNTIME_APPROVAL` for explicitly
selected matching packages and the approved captured runtime, then run:

```text
cargo test --locked --offline \
  --manifest-path crates/plugin-host/compatibility/Cargo.toml \
  --features javascript-conformance --test quality_corpus \
  fixed_quality_material_is_complete_and_independently_checked \
  -- --exact --ignored --nocapture --test-threads=1
```

This target requires the existing Unix actual-worker environment. It checks the
source proposals and independent source-checker refusal of altered content; it
does not adopt the source, apply maintenance decisions or call a model. Missing
materials and a skipped target are not successful consumption evidence.

The large [SMAPI source fixture](../stardew-lookup/README.md),
[upstream maintenance fixture](../upstream-maintenance/README.md) and
[caption conformance fixture](../webvtt/README.md) retain their separate
structural, provenance and scale purposes. This corpus does not replace them.

## Evaluation protocol and evidence boundary

Follow [the review protocol](review-protocol.md). Structure, terminology,
context, human editing and maintenance reuse have separate records; there is no
automatic aggregate score. The [drill packet](drill/packet.json),
[illustrative record](drill/review-example.json) and [reveal mapping](drill/reveal.json)
are self-authored, drill-only examples, not generated outputs or observed human
ratings. Keep the reveal file away from a reviewer until their record is fixed.
These JSON files are test materials, not a new product persistence format.

The current request budget is **0**. No Provider, model, account, model
parameters or future request allowance has been selected. Actual generation,
independent human assessment, quality, editing time, maintenance effectiveness,
Provider compatibility, cache behavior and fees are **NOT-RUN**. A future run
must first freeze its actual supported Ai/Arena parameters and shared budget in
the original preview and receive explicit consent. Corpus preparation and the
offline drill do not grant that consent.
