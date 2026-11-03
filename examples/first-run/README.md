# Offline first-run sample

This original two-cue WebVTT example is distributed under the repository's MIT license. It contains no external project or game material. Copy this folder to a writable local location before selecting it in the application.

1. Open the complete Apple Silicon macOS bundle and review/install its included extensions in Settings → Extensions. Each source operation still requires its own execution permission.
2. Create a project with source language `en` and target language `zh-CN`. In Source content, choose the WebVTT source capability and select the copied folder containing `source.vtt`.
3. Review the captured two cues, authorize extraction and the independent checks through their existing controls, then confirm adoption. The application must not silently reread changed external files.
4. Find `welcome`, enter `欢迎来到翻译工作台。`, and explicitly save it. Close and reopen the project; confirm the saved translation is still selected. Enter a translation for `reminder` when preparing an export.
5. Follow [Build and export](../../docs/build-release.md) to run required checks, record approvals, prepare a release and export a new `zh-CN.vtt` to an empty output folder. Reopen that output as text to check both cue IDs, timings and translations. Export never writes over this source automatically.

No model connection is required. This sample establishes a bounded manual task only; it does not establish AI quality, clean-machine acceptance, or Skyrim SE support. For bundle preparation and recovery, see [distribution instructions](../../docs/plugin-distribution.md).
