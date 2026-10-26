# Local Resource Update Fixture

`g1.json` and `g2.json` are synthetic test glossaries whose source phrases and native keys are drawn from the MIT-licensed [Lookup Anything fixture](../stardew-lookup/README.md) (upstream commit `76565e83ede4bc8b3c293f1c659032ba9c39c213`).

The pair models an update to a project glossary from revision `G1` to `G2`. `oracle.json` contains the manually verified expected impact and matching results; do not regenerate `oracle.json` from the glossary comparison implementation under test.
