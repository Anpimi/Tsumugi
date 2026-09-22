# Lookup Anything source fixture

Files `manifest.json` and `i18n/default.json` are unchanged from
[Pathoschild/StardewMods](https://github.com/Pathoschild/StardewMods/tree/76565e83ede4bc8b3c293f1c659032ba9c39c213/LookupAnything),
revision `76565e83ede4bc8b3c293f1c659032ba9c39c213`. The upstream MIT license is included.
These are source-tree files, not an installed mod or a game-runtime compatibility test.
The manifest intentionally retains its upstream `%ProjectVersion%` build placeholder.

| File | Bytes | SHA-256 |
|---|---:|---|
| manifest.json | 363 | 58273bb818cab2899e0fc0a45e1f40856cab286e07e9a9af2dbca37199118148 |
| i18n/default.json | 37385 | 29c4c299dee077481a98c1de612a678a6a16e55988ba88a73fa8f1cd92deb609 |

`oracle.json` was prepared before the Rust extractor using Newtonsoft.Json 13 and
manual checks of empty strings, placeholders, escaped quotes, and the equal text
under distinct barrel/box keys. It contains all 532 source entries in original order.
English is an explicit fixture language declaration, not inferred from `default`.
Each key remains an independent unit; matching text does not imply shared identity.
Keep upstream bytes, BOM and line endings unchanged. Do not regenerate the oracle
using the extractor under test.
