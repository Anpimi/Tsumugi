# Local resource update fixture

`g1.json` and `g2.json` are test glossaries authored for this repository. Their
source phrases and native keys come from the MIT-licensed Lookup Anything fixture
in `../stardew-lookup/` (upstream revision
`76565e83ede4bc8b3c293f1c659032ba9c39c213`). They are not an upstream
glossary or an output of the bundled SMAPI integration.

The two complete files model a user-authorized local resource changing from G1
to G2. `oracle.json` is a manually stated expected result. It must not be
regenerated from the glossary or matching implementation under test.
