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
before publishing. Desktop installed-builder/checker commands connect these
contracts to Core execution and Release adoption. The native workbench and
domain-package cutover are still being integrated.

Schemas, JavaScript types and standalone structural validators are generated
from Rust. The Rust receivers also check relationships, hashes, paths and UTF-8
byte limits that JSON Schema alone cannot prove. Example data can be inspected
without running a plugin:

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-build-declaration crates/plugin-sdk/tests/fixtures/build.declaration.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-build-input
pnpm --dir runtimes/javascript-host generate:contracts
```

The `build.*` manifest/declaration fixtures are synthetic metadata. The public
build tests retain both caption and JSON source evidence and distinguish
structural association from semantic acceptance. The failure contract has bounded
public classifications and detail; diagnostic text must not disclose user data,
local paths or secrets. This is still the undistributed experimental SDK alpha.1.

## Current Core capture boundary

Core's experimental `prepare_plugin_build` captures an immutable `ReleasePlan`
from the existing review eligibility and saved source result owners. It preserves
the current selection, decision, QA, waiver, fallback, context and term evidence,
source snapshot/result digests, exact build/check bindings, runtime descriptor,
configuration and output scope. Original operation-local unit/revision references
are mapped to Core identities before decided texts are projected into BuildInput.
No plugin ID or domain parser selects this generic projection.

The existing execution ledger independently compares a new plan with qualified
project evidence in a read snapshot before registration. A modified payload or
internally consistent forged plan cannot
be accepted solely because it passes data validation. Explicit Core grants remain
necessary. Before the first write, an immediate transaction checks the same
connection's [data version](https://www.sqlite.org/pragma.html#pragma_data_version)
and [total changes](https://www.sqlite.org/c3ref/total_changes.html). An intervening
database change conservatively refuses new registration; the transient check adds
no stored version or authority. Full plan decoding and qualification remain
outside that write transaction. All requested locales share one adoption unit,
and output collisions
are checked across locales using the same SDK path policy. Capture is read-only;
missing or stale approval/QA is refused. Source text is used only through a current
explicit fallback decision.

`find_plugin_build` reconciles the original attempt and exact request after later
edits or reopening; it does not recapture newer choices or restore execution
authority. These APIs have not yet replaced the desktop's built-in build runners.
Desktop commands separately consent and execute the installed builder and checker
through RunnerProxy, then commit Core proof before Release adoption. Native build
controls and domain-package migration remain integration requirements; saved
artifact delivery uses the existing native directory owner. Core artifact proof
and immutable release adoption are described below. The existing release store
remains the owner; this capture adds no parallel database, planner or authorization mechanism.

## Current Core artifact-proof boundary

`ResultValidationCapture::prepare_artifact_check` derives one independent check
input per immutable builder result. Core validates the actual ArtifactSet against
the original ReleasePlan and exact output scope, then captures a mandatory union
of generic structural checks and every selected domain artifact rule. Each rule
covers every actual artifact ID and binds the original full input/result digests.
The checker receives only ArtifactCheckInput. BOMs, Unicode, line endings, opaque
source evidence, configuration and actual returned bytes remain fixed.

The checker uses the normal plugin execution port with its own captured provider,
runtime, input and current consent. Producer permission cannot authorize it.
Preparation evaluates exact rule/target/basis coverage and blocking findings;
missing, unavailable, failed, cancelled or not-applicable mandatory checks remain
invalid. A checker cannot assert Core findings or another provider's results.
A generic ResultValidator cannot bypass this independent proof.

`ProjectStore::commit_artifact_validation` uses the same short mutation boundary
and provenance owner as source validation, rechecking both current grants, exact
saved inputs/results and current result pointers. All locales retain separate
proofs within one release adoption unit. Reopening reconstructs the captured
policy and checker input, detects missing/substituted proof and does not restore
execution authority. Historical result bytes remain fixed after later edits.
Validation alone does not publish a Release or replace desktop built-in build
runners. The release adoption boundary below is a separate action.

## Current Core immutable-release boundary

`ReleaseAdoptionHandler` prepares the entire declared ArtifactSet for all locales
outside the write transaction and records it through the existing release store.
Adoption rechecks current producer/checker grants, cancellation, exact mandatory
proof and unsuperseded results in the normal execution transaction. A missing
locale or incomplete check cannot become a successful release. A committed action
returns its original receipt after revocation or reopening.

The qualified plan freezes at registration. Later project edits do not rewrite
its decided texts, review evidence or output paths. A permitted partial continuation
reuses original successful results and proofs, checking their original current
permissions as well as the new attempt. Replay eligibility still comes from the
trusted Host's stored effect policy; unknown external effects require new explicit
consent and cannot be replayed merely because the package claims to be read-only.

The release manifest binds the original input digest, exact result IDs and the
complete frozen plan. The original source snapshot/attempt/result references and
raw digests are rechecked at adoption capture, commit and read, without replacing
them with the current project source. Each artifact retains its locale, operation-local ID, role,
logical path, exact UTF-8 bytes and digest. Reads and reopening reconstruct the
original results and mandatory proof, compare every stored artifact and require
the original adoption receipt. Recomputed hashes cannot conceal substituted
bytes. Reading a historical release does not execute a checker or restore a grant.

`release_artifact_by_path` selects the exact saved locale/path pair.
`release_artifact` accepts a locale only when it has one artifact and explicitly
rejects ambiguity. The existing `ReleasedArtifact.entry_count` reports the frozen
source-unit count for generic builds; it does not claim a parsed per-file domain
record count. Empty artifact bytes and the SDK's complete bounds are retained.
Delivery records include every saved output and distinguish partial and unknown
outcomes; an unresolved action must be reconciled before another delivery to the
same destination. These record APIs perform no destination-directory IO.

The current-only project format is schema 20. Schema 19 and earlier development
directories are preserved and refused without migration. The still-running built-in
build workflow has an explicit current-format manifest tag in the same store;
it remains until desktop installed-builder/checker integration replaces it.
Desktop delivery captures exact saved locale/path bytes on the project owner,
performs preview, file IO and reconciliation on its bounded IO worker, and records
all results through these Core APIs. Held native directory handles cover every
nested parent; previews and reconciliation do not create directories. Conflicts
retain the observed hash, temp bytes are flushed and checked before commit, and
pending or unknown actions are reconciled without re-executing plugins. Accepted
IO survives a lost caller, while quiescing cancels further writes and waits for IO
to finish before project close. A failed outcome commit leaves the original pending
action for reconciliation and reports an unknown result. Native UI acceptance, domain-package migration
and removal of the built-in production runners remain pending.
