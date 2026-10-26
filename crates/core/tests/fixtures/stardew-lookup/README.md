# Lookup Anything Source Fixture

`manifest.json`, `i18n/default.json`, and `i18n/zh.json` are unmodified source files from [Pathoschild/StardewMods (`LookupAnything`)](https://github.com/Pathoschild/StardewMods/tree/76565e83ede4bc8b3c293f1c659032ba9c39c213/LookupAnything) at commit `76565e83ede4bc8b3c293f1c659032ba9c39c213` (included under the upstream MIT license). `manifest.json` intentionally retains its upstream `%ProjectVersion%` build placeholder.

| File | Bytes | SHA-256 |
|---|---:|---|
| `manifest.json` | 363 | `58273bb818cab2899e0fc0a45e1f40856cab286e07e9a9af2dbca37199118148` |
| `i18n/default.json` | 37385 | `29c4c299dee077481a98c1de612a678a6a16e55988ba88a73fa8f1cd92deb609` |
| `i18n/zh.json` | 40486 | `d5b840327b886dab3afccef1b2eb30668699dd70ed0b52ab662b4a7` |

## Extraction Oracles

Keep the upstream files (including UTF-8 BOMs, comments, trailing commas, and line endings) byte-for-byte unchanged, and do not regenerate the oracle files using the Tsumugi extractors under test:

- **Source Oracle (`oracle.json`)**: Generated independently using `Newtonsoft.Json` 13 and manually verified for empty strings, `{{...}}` placeholders, escaped quotes, and duplicate source strings across distinct barrel/box keys. Contains all 532 source entries in original file order with an explicit `en` source language (each key is a distinct unit even when values are identical).
- **Translation Oracle (`translation-oracle.json`)**: Generated independently using .NET `System.Text.Json` (with comment and trailing-comma support enabled) and cross-checked against `oracle.json`. Maps all 532 translated keys in `i18n/zh.json` to their expected source occurrences, decoded values, and input order. While the SMAPI filename `zh.json` declares the mod's `"zh"` locale, the test project explicitly maps it to the `zh-CN` BCP 47 project target locale rather than silently equating `"zh"` and `"zh-CN"`.
