# Caption conformance fixture

These self-authored examples are distributed under the project's MIT license. They are synthetic, not captured from a person or third-party video.

The independent S1 oracle is six cues, in order: `keep` = `Hello\nWorld`, `timed` = `Wait`, `word` = `Old`, `layout` = `Layout`, `rename` = `Same`, `removed` = `Gone`. S2 keeps only `keep` unchanged; `timed` changes its start, `word` changes text, and `layout` changes its setting. `renamed` requires an explicit identity decision. `added` is new and `removed` disappears. S1's Chinese byte oracle is `expected-zh-CN.vtt`; everything outside the cue payloads must remain identical.
