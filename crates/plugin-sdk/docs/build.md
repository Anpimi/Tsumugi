# Experimental build and artifact data

The data-only SDK owns five schema/behavior `1/1` contracts:
`tsumugi.build-input`, `tsumugi.artifact-set`, `tsumugi.artifact-check-input`,
`tsumugi.build-declaration` and `tsumugi.build-error`. These are independent of
the application's ReleasePlan, process frames and database schema.

`BuildInput` carries the complete fixed `ContentExchange`, one already decided
target text for every source unit, its exact source revision reference, a target
language, optional domain configuration as a collection of exact `EncodedPayload`
values, the complete allowed relative output paths, and captured output limits. Multiple occurrences of one unit share its
decided text. The receiver rejects omitted, duplicated, unrelated or changed
revision references. Target text is never silently copied from the source.
It preserves the original artifacts, protected fragments, occurrence order and
opaque domain blocks; it does not interpret their domain grammar.

Core must derive this data from its qualified, immutable ReleasePlan. A plugin
receives no ProjectStore, SQL, local directory, candidate selection authority,
review history or power to alter eligibility. Configuration schemas and byte
digests are checked; their domain semantics belong to the selected component.
Locale syntax checks are deliberately limited to the wire label. The application's
existing locale owner establishes canonical, supported language choices.

`ArtifactSet` returns actual UTF-8 strings with IDs, roles, logical paths and
SHA-256 values, plus the fixed profile, source set and target language. UTF-8
bytes include BOMs and original line endings. The current contract supports
text artifacts; it makes no binary-output claim. Artifact hashes are recomputed
from those exact bytes. Paths use the Host's same portable relative-file policy:
no absolute/traversing paths, separators with aliases, reserved device names,
trailing dots/spaces or non-ASCII filenames. Case aliases and parent/child file
collisions are rejected independently of collection order. Host filesystem
containment, held handles and safe writes remain separate requirements.

The contract accepts at most 32 artifacts, depth 16 and 2 MiB of encoded output.
The trusted input can set smaller artifact-count and total raw-byte ceilings.
Each decided text keeps the existing 16 KiB bound. Build and artifact-check inputs
have distinct 4 MiB encoded limits; each original ContentExchange remains subject
to its own 2 MiB limit. Configurations are limited to 32 distinct schemas.
No returned value may expand the original limits.
Returned paths must exactly cover the captured paths, preserving their spelling;
extra safe-looking paths, omitted outputs and case substitutions are refused.

`ArtifactCheckInput` contains the fixed build input, the complete actual output
and the caller's independently fixed domain requirements. Requirements are
mandatory, nonwaivable, have no not-applicable escape, select one exact checker,
share the same captured input/scope basis and each cover all actual artifact IDs.
The trusted caller must establish those digests from its ledger and captured
scope. Receiving a syntactically valid requirement does not authenticate it.
Results use the existing `tsumugi.check-results` contract and FixedCheckSet
coverage owner; the Core checks remain part of the trusted union.

An optional non-executable Resource with schema
`tsumugi.build-declaration/1/1` identifies a profile, separate builder/checker
contributions, output ceilings and the required artifact rules. Binding uses
the same immutable package's complete manifest and independently expected digest.
The builder must accept BuildInput and return ArtifactSet as a proposal; the
checker accepts ArtifactCheckInput and returns read-only check results. Both use
BuildError and may request only captured-input permission. A successful binding
is data, with no execution or publication grant. `BuildBinding` checks the exact
profile/limits, capability payload ceilings, checker provider and full rule set.
PackageImage reads only the explicitly selected captured Resource and never
executes the component while resolving it.

`validate_build_artifacts` checks generic identity, byte hashes and bounds. It
deliberately accepts structurally valid bytes without establishing their domain
syntax. Only an independent semantic check against actual output can supply
domain evidence. Core must additionally verify actual channel identity, both
current execution authorizations, complete check coverage and release eligibility
before publishing. A consuming application must own these capture, execution
and Release adoption boundaries, including explicit path selection and separate
execution consent. This SDK package provides data validation, not those application
commands or a desktop build workflow.

Schemas, JavaScript types and standalone structural validators are generated
from Rust. The Rust receivers also check relationships, hashes, paths and UTF-8
byte limits that JSON Schema alone cannot prove. Example data can be inspected
without running a plugin:

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-build-declaration crates/plugin-sdk/tests/fixtures/build.declaration.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-build-input
node crates/plugin-sdk/scripts/generate-contracts.mjs
```

The `build.*` manifest/declaration fixtures are synthetic metadata. The public
build tests retain both caption and JSON source evidence and distinguish
structural association from semantic acceptance. The failure contract has bounded
public classifications and detail; diagnostic text must not disclose user data,
local paths or secrets. This is the experimental SDK source; select artifacts by exact provenance as described in the [SDK README](../README.md).
