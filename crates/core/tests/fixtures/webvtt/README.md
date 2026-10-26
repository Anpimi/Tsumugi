# WebVTT Caption Conformance Fixture

This directory contains synthetic WebVTT (`webvtt-captions`) test fixtures distributed under the repository's MIT license.

## Generations and Oracles

- **S1 (`s1.vtt`)**: Contains six cues in order:
  1. `keep` = `Hello\nWorld`
  2. `timed` = `Wait`
  3. `word` = `Old`
  4. `layout` = `Layout`
  5. `rename` = `Same`
  6. `removed` = `Gone`
- **S2 (`s2.vtt`)**: Models an upstream caption update relative to S1:
  - `keep`: unchanged.
  - `timed`: start timestamp changed.
  - `word`: cue text changed.
  - `layout`: cue settings changed.
  - `renamed`: replaces `rename` with the same text (`Same`), requiring an explicit user identity decision.
  - `added`: newly added cue.
  - `removed`: deleted in S2.
- **Target Build Oracle (`expected-zh-CN.vtt`)**: The expected UTF-8 output when building S1 for `zh-CN`; all bytes outside the translated cue payloads must remain identical to `s1.vtt`.
