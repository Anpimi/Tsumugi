# Upstream Maintenance Fixture

This directory contains two synthetic Stardew Valley SMAPI flat-JSON source generations (`s1` and `s2`) alongside a pre-computed comparison oracle (`oracle.json`).

The fixture tests upstream source maintenance across six scenarios:

1. Unchanged native key and text continuity.
2. Modified source text under an existing key.
3. A single unambiguous key rename candidate.
4. Ambiguous split/merge candidates.
5. Key reuse with replaced text.
6. Identical source text shared by distinct native keys.

The companion tests also run against the 532-key [Lookup Anything fixture](../stardew-lookup/README.md) to verify behavior on a real-world SMAPI localization table.
