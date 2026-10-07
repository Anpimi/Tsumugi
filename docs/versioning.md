# Application versioning and changelog maintenance

Text-checker discovery follows its active scope and explicit refresh, without
restarting when an action locks or unlocks interaction. This corrects Review and
WorkPlan preparation without changing IPC, SDK/process contracts, schemas,
settings, dependencies or execution authority. The same undistributed
application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch and bilingual Unreleased
entries require no additional bump or historical migration.

Installed package choice discovery now orders metadata reads to respect the
existing exclusive Store lock. Source/build refresh and workbench re-entry use
the completed current scan before reading an execution environment. This fixes
desktop discovery without changing IPC, SDK/process contracts, schemas, stored
settings, dependencies or execution authority. It remains the same undistributed
application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch; both Unreleased
changelogs record the fix, with no additional version bump or migration.

New-project path previews now use the native separator already supplied by
Tauri. Actual project creation still uses its existing native join operation;
no stored locator, schema, IPC or dependency changes are required. This fix
shares the same undistributed version batch and bilingual Unreleased entries.

Experimental joint Review QA now captures mandatory source-format checks and
explicit action-local advisory text rules in one fixed union. Each checker has
its own original execution input, task, grant and result provenance. Current QA
and checked selection use mandatory coverage while retaining advisory findings,
diagnostics and invocation failures. Desktop consumers must regenerate the
internal multi-checker IPC contracts; the previous single-checker shape is not
a compatibility path. The current-only project format advances to schema 30;
earlier development directories are refused unchanged, without migration.
Application `0.2.0-alpha.1` and SDK `0.1.0-alpha.1` remain the same undistributed
batch, with synchronized Unreleased entries and no additional SemVer bump.
SDK/process wire contracts, installed settings/Store layouts and dependency versions
are unchanged. This does not publish a release or adopt knowledge Resources.

The experimental SDK's advisory text-review declaration, input and report use
new schema/behavior 1/1 identities and reuse the original CheckResult and finite
ReviewCheckError contracts. They add same-package Host resource-pin validation
and generated public JavaScript bindings. The Component facade now exposes the
Host-validated immutable provider; components requiring it need a current built
and captured Host. Process protocol 1, project formats, installed settings/Store
layouts, dependencies and version sources are unchanged. This remains the same
undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch, with
synchronized Unreleased changelogs and no additional SemVer bump or historical
migration. Joint project QA and qualification are separate integration work.

Provider child tasks now retain their parent item's exact captured dependencies,
including identities and expected revisions. This corrects the existing enqueue
scope check without changing project schema 28, settings format 2, IPC, SDK,
process profiles or dependency versions. Application `0.2.0-alpha.1` and SDK
`0.1.0-alpha.1` remain the same undistributed batch; synchronized Unreleased
entries require no additional bump or historical migration.

Editor source/selected-draft lookup adds literal text to the same Resource query
draft without another execution or persistence contract. This uses existing
internal view handles and the same undistributed version batch; no extra bump,
profile/schema/Store/IPC/dependency change or migration is required.

Resource workbench reference queries consume the existing bounded SDK helper,
installed environment choices and original tool prepare/start/discard ledger
commands. They add manual single/batch controls, draft and consent protection,
reference results and task cancellation without new IPC shapes, SDK/process
profiles, project schema 28, installed settings 2, Store formats or dependencies.
This remains the same undistributed application `0.2.0-alpha.1` / SDK
`0.1.0-alpha.1` batch; bilingual Unreleased entries require no extra bump or
historical migration. Component/browser evidence and native/Agent acceptance
must be reported separately.

The experimental read-only tool declaration now has an optional bounded text
query presentation. Its input/output references must exactly match the original
capability; generated JavaScript and internal Desktop DTOs include the new
shape. The public helper constructs original opaque payloads without another
executor or authority, and consumers must regenerate contracts. Tools without
this presentation remain callable through their declared capability. This stays
in the same undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1`
batch; tool schema/behavior 1/1, process frames, project schema 28, installed
settings 2 and dependencies are unchanged. Synchronized Unreleased entries
require no extra bump or historical wire/format migration. Product interfaces
and Agent scope/budget integration still require their own acceptance.

Desktop read-only tool discovery and fixed single/batch query preparation now
extend the generated internal plugin/execution IPC contracts. Consumers must
regenerate their DTOs and validators; no historical wire fallback is supplied.
Execution uses the original Core ledger, per-attempt consent and RunnerProxy,
with current installed-settings and runtime checks. Query output grants no
project adoption or Agent authority. Project schema 28, installed settings
format 2, SDK/process contracts, dependencies and version sources are unchanged.
This remains the same undistributed application `0.2.0-alpha.1` / SDK
`0.1.0-alpha.1` batch, with synchronized Unreleased changelogs and no extra
version bump or historical migration. Product query interfaces and Agent
integration have separate acceptance requirements.

The experimental SDK's additive read-only tool selector uses its own
`tsumugi.capability-tool-declaration` schema/behavior 1/1. Generated public
JavaScript contracts and Host metadata binding extend existing owners without
changing process frames, project schema 28, installed Store/settings formats,
desktop IPC or dependencies. This remains the same undistributed application
`0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch, with synchronized Unreleased
changelogs and no additional version bump or historical migration. Knowledge
examples explicitly select the SDK artifact containing this contract; their
earlier package-specific tool descriptions are not a compatibility path.

The experimental Host's public captured Resource and Skill readers extend the
existing immutable package owner without changing SDK/process contracts, project
schema, installed Store layout or dependency versions. This is an additive Host
API in the same undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1`
batch, with no extra version bump or historical migration. Independent knowledge
examples own their initial version and do not advance the application version.

## Version source and release boundary

`[workspace.package].version` in [Cargo.toml](../Cargo.toml) is the application's single version source. `tsumugi-core` and `tsumugi-desktop` inherit it. Tauri's configuration omits `version` so it reads the desktop Cargo package version; the frontend package is marked `private` and has no independent release version. Regenerate the workspace package entries in `Cargo.lock` with Cargo when changing the application version, using `cargo update --workspace --offline` with the existing dependency cache.

The release unit is the desktop application built from one verified source commit. Database schemas, bundled integration implementations, caption profiles and capability/exchange contracts have separate versions. Evaluate their compatibility when their behavior changes; do not change them merely to match an application version.

The supported user-facing scope is the documented project workflow and import/export formats. Internal Rust, storage and IPC interfaces are not a stable public SDK. The application remains in initial development.

The experimental standalone plugin SDK has its own package version
in `crates/plugin-sdk/Cargo.toml`, currently `0.1.0-alpha.1`. Its declaration
protocol and schema/behavior identities are separate from that SemVer and the
application version. SDK source is in this repository and has not been published;
its package is a separate release unit. An SDK-only data contract change does not
bump the application when the desktop runtime and stored data are unchanged.

The experimental process Host inherits the workspace version as an internal
application component. Its conformance-worker binary is test tooling, not a
separate published plugin. The private JavaScript Host workspace has no separate
release version; it is an internal runtime for the same application release unit.
Its generated wire profile records the independently versioned SDK. The process
protocol is SDK-owned and independently versioned; adding the experimental Host does not by itself distribute a desktop build.
Its optional Core execution adapter changes stored result evidence and adds plugin
grants in schema 16. This remains the same unreleased `0.2.0-alpha.1` batch;
earlier development databases are refused rather than migrated. It does not
establish a stable public Core API or distribute a production plugin catalog.
The Host's directory capture and in-memory package catalog stay in this same
unreleased batch. They add source approval and fixed declaration selection without
changing the SDK wire profile or project schema. The managed local package store
adds strict receipts, private immutable objects, exclusive promotion and original
action reconciliation in the same unreleased batch. It does not change the SDK
wire protocol or schema 16 and provides no historical development-format migration.
The SDK runtime-description data helpers add environment protocol 1 and complete
artifact digest rules within the same unreleased SDK alpha.1. They do not alter
process frames, the current project format or desktop execution. A data-only
addition does not advance the application version or claim runtime distribution.
The Host now captures complete approved Node/tool and built Host trees, materializes
those immutable bytes for each owned process, and accepts no external launcher-path
fallback. Core stores the SDK descriptor and derives its environment key; distinct
environments for the same package coexist. This changes the required fixed-input
shape and advances the current-only project format to schema 17. Schema 16 and
other earlier development formats are refused unchanged, without migration. The
experimental launcher and RunnerProxy APIs are incompatible with the earlier
free-digest/path API. This remains the same undistributed application
`0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch; it is not a production runtime release.
Authenticated network updates and desktop runtime controls remain pending. Exhaustive
matches on the experimental Host error enum must handle its added capture errors.
The same managed local store now retains approved runtime artifact trees and
reopens them only after checking the independent complete descriptor and origin.
This does not change SDK/process profiles, current schema 17 or desktop assembly.
It stays in the same unreleased application/SDK batch and adds no development
format migration or new distributed version.
Exhaustive matches on the experimental installation error enum must now handle
`MissingRuntime` separately from a missing plugin package.
The public source-extraction data contract and generated JavaScript content types
remain in the same experimental SDK alpha.1 development batch. Candidate package
inspection shares the Host's existing capture and digest owner, without changing
the package format, runtime profile, project schema or desktop assembly. Neither
addition distributes an application/SDK release or requires a historical migration;
the application and SDK version sources therefore remain unchanged.

The SDK's additive build-input/artifact/check/declaration/error contracts have
independent schema/behavior 1/1 identities in this same undistributed alpha.1
batch. Host build-resource inspection reuses captured package bytes and the
existing portable-path policy; it does not switch desktop build execution,
change stored project data, process frames, installed Store formats or dependencies.
The application and SDK versions therefore remain unchanged, with the public
experimental feature recorded in both Unreleased changelogs. No release or
historical development-format migration is implied.

Core's experimental plugin ReleasePlan capture adds qualified build inputs to the
existing execution ledger and keeps the current source/review/release owners.
BuildInput now requires exact `outputPaths`; pre-path experimental build inputs
are refused rather than given an implicit output scope. Consumers of this
undistributed contract must supply the complete paths and validate returned
coverage. BuildBinding can be serialized as fixed internal metadata, with its
validation still required; serialization grants no execution permission.
No database table, SDK/process profile, dependency, Store layout or desktop
build assembly changes in this unit. Application `0.2.0-alpha.1`, SDK
`0.1.0-alpha.1` and schema 18 remain in the same unreleased batch, with no
additional bump, release or historical migration.

Core now extends its existing source-check provenance table into a single
plugin-check provenance owner for both sources and actual build artifacts. This
advances the current-only project format to schema 19. Schema 18 and other earlier
development directories are refused without writes or migration; preserve them
and use a new current-format project. Experimental Core consumers must use the
independent artifact-check capture/preparation/commit APIs for plugin builds;
generic validators cannot grant their mandatory proof. SDK contracts, process
frames and installed Store formats are unchanged. This remains the same
undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch, with no
additional SemVer bump, publication or historical migration. Actual desktop
plugin build execution remained separate at that proof-only boundary.

Core immutable release adoption now records a tagged current manifest and all
artifacts per locale in the existing release tables, binding original inputs,
results, mandatory proof and receipts. This advances the current-only project
format to schema 20. Schema 19 and earlier development directories are refused
unchanged, without conversion; preserve them and create a new current-format
project. Exact-path reads support complete ArtifactSets, while locale-only reads
explicitly refuse ambiguous multi-file outputs. The generic entry count denotes
frozen source units, not parsed domain records. SDK shapes, generated desktop DTOs,
installed Store formats, dependencies and version sources are unchanged. This
remains the same undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1`
batch, with no extra SemVer bump or historical migration. Desktop installed build
execution and saved filesystem delivery now use
the existing owners; native build controls and domain cutover still require
acceptance evidence.

The read-only runtime inspector and fixed macOS arm64 preparation command use
the existing capture/SDK hash owners. They add build tooling and a source-owned
Node distribution pin, not new wire fields, Store formats, project migrations or
desktop runtime distribution. SDK metadata now exposes its existing package
version as a constant without changing its value. This remains the same
undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch, with no
additional version bump. The prepared Node requires macOS 13.5; the base
application minimum is unchanged until runtime bundling is integrated and its
availability is checked independently.

Read-only Desktop build-environment resolution adds generated IPC from the same
SDK BuildDeclaration and exact enabled-package/approved-runtime capture used by
source imports. It changes no project data, schema20, Store layout, SDK/process
contract, dependency, distributed runtime or execution authority. Application
`0.2.0-alpha.1` and SDK `0.1.0-alpha.1` therefore remain unchanged in this same
undistributed batch. Both Unreleased changelogs record the additive environment
read. Desktop installed builder/checker commands now connect fixed input,
separate exact consent, RunnerProxy execution and artifact proof to the existing
Release adoption owner. Their generated IPC is additive, and the Core locale
choice merely derives its wire schema at its existing owner. This same
undistributed batch keeps application/SDK versions, schema20, process/Store
formats and dependency metadata unchanged. Desktop build controls now select installed capabilities, capture explicit complete
paths, separately authorize builder/checker attempts and reconcile original
proof/adoption identities. The macOS Quit menu and Command-Q also use the existing coordinated
window-close workflow.
These changes add desktop behavior without new wire contracts,
project formats, dependencies or version sources. Domain-package migration and
complete native acceptance remain pending; both Unreleased changelogs are
synchronized and this undistributed batch retains the same versions. Generic saved-artifact delivery extends the existing
native selection and delivery owners without changing DTOs, project schema,
SDK/process/Store formats, dependencies or version sources. Exact locale/path
reads, nested held directories, per-file outcomes and IO continuation are part of
this same undistributed alpha.1 batch; both Unreleased changelogs are synchronized,
with no additional bump or historical migration.

Core's experimental complete-translation qualification now uses the existing
execution ledger, live plugin grants and durable producer/checker proof links.
Its fixed material/check inputs retain the 1 MiB bound and complete ledger
results the 2 MiB bound; exceeding the whole encoded budget refuses qualification
instead of splitting or truncating a file. Current source/locale checks run at
the existing enqueue boundary, while native values remain plugin-owned.
This additive library route allocates no translation revision or selection and
does not complete per-entry projection, desktop integration or native acceptance.
It changes no database table, SDK/process profile, installed Store format,
dependency or version source. Both Unreleased changelogs are synchronized, with
application `0.2.0-alpha.1`, SDK `0.1.0-alpha.1` and schema20 unchanged in this
same undistributed batch; there is no additional bump or historical migration.

The optional public SDK `native-worker` component-side entry point is additive
within the same undistributed SDK `0.1.0-alpha.1` batch. It reuses process protocol
1 and all existing wire shapes and adds no dependency, manifest generation,
stored project field, current schema change or application runtime assembly.
Default SDK features remain data-only. The application `0.2.0-alpha.1`, SDK and
schema 26 version sources therefore remain unchanged, with both Unreleased
changelogs synchronized. Complete Native/Core environment binding and real
third-domain acceptance remain separate work; no historical migration or release
is implied.

## Choosing the next version

The experimental Host's independent environment decisions now use the SDK's
`ExecutionEnvironmentDescriptor` for both Node and Native application Hosts.
This breaks the Rust `RuntimeApproval.environment` field type and advances only
the current local plugin-settings format to 2. Format 1 settings are refused
unchanged without migration; Node runtime receipts and artifact trees, SDK wire
profiles, process protocol, schema 27 and dependency metadata are unchanged.
The desktop inventory exposes the same strict decision union and displays Native
Host approval as metadata, separately from installed Node trees. The desktop now
observes its current Host and exposes explicit approval/revocation through that
same settings owner; native execution selection remains in development. This stays in
the same undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch,
with synchronized Unreleased changelogs and no additional SemVer bump or release.

The experimental Native/Core route adds the SDK's strict
`native-application-host-v1` descriptor and changes Core's fixed environment
port to `ExecutionEnvironmentDescriptor`. Actual native Host identity is bound
separately from package bytes and per-attempt grants; Node descriptors and digest
rules, process protocol 1 and installed runtime Store shapes are unchanged.
Admitting the stored native fixed-input variant advances the current-only
project format to schema 27. Schema 26 and all earlier development directories
are refused unchanged, without migration. Experimental Rust consumers must use
the new execution-environment type; Node and Native data values convert into it.
This remains the same undistributed application `0.2.0-alpha.1` / SDK
`0.1.0-alpha.1` batch, so no additional SemVer bump or release is implied. Both
Unreleased changelogs are synchronized. The public Host's independent Rust catalog
tests separately cover extraction/check/build through real Native channels and
normal Core source/review/release gates. Desktop approval/discovery uses the
current Host; Native execution selection and complete independent-domain
acceptance remain separate work; test tooling adds
no version, stored shape or production domain branch.

The initial package source-import Resource used the experimental contract
`tsumugi.source-import-declaration/1/1`, generated from the same data-only SDK.
The current required 2/2 contract is assessed below.
It fixes a material recipe and independent extractor/checker declarations before
execution. Host resource lookup and generic authorized material capture add no
manifest fields, process/exchange version, Store layout or project schema change.
Read-only Desktop source-environment resolution extends generated IPC using the
same SDK types, current package enablement and independent installed-runtime
approval. It creates no project mutation or execution grant and changes no
application, SDK, process or data-format version.
The desktop source workbench now uses the installed Resource path for native
selection, fixed material capture and separately consented extractor/checker
execution through Core. Six generated source commands extend the same IPC domain.
Normal builds no longer register the former built-in source preflight/start
commands or their source runners; explicit test builds retain legacy fixtures.
This is an incompatible initial-development source entry-point change, not
a migration of earlier projects. Translation/build assembly and default domain
package distribution remain incomplete. No dependency versions, SDK/process
contracts, Store layout or schema 18 change in this unit.
Application `0.2.0-alpha.1`, SDK `0.1.0-alpha.1` and schema 18 remain in the same
undistributed batch, with no additional bump or earlier development migration.

Opt-in Apple silicon macOS runtime bundling and independent Desktop runtime
approval/install/selection extend the same unreleased application batch. Build
metadata comes from actual Host capture and the source-owned complete tool pin;
the optional bundle raises its minimum to macOS 13.5 while base builds retain
their minimum. Generated IPC adds runtime offers, exact decision digests and
runtime operations. This changes no SDK/process profile, Store layout or schema
18 and adds no external dependency or historical data migration. Application
`0.2.0-alpha.1` and SDK `0.1.0-alpha.1` remain the version sources; no additional
bump or distribution-ready production claim follows from this opt-in build.

The source-check SDK additions remain in the same undistributed SDK alpha.1
batch. Content output schema 2 requires original identity display evidence;
plugin check keys now capture package selection separately from active channel
identity. These experimental wire shapes are deliberately incompatible with
earlier development snapshots; there is no automatic conversion. The source,
error and new check payload schemas and process frames retain their independent
identities. SDK metadata therefore remains `0.1.0-alpha.1`; actual producer
commits and artifact digests distinguish internal consumer snapshots.
The SDK's bounded invocation payload now admits 4 MiB, with a separate
24 MiB + 64 KiB process frame ceiling for worst-case JSON quoting and typed
metadata. Source/content each retain their 2 MiB encoded ceiling. These limit
changes retain the current process shape and protocol, within the same
undistributed SDK batch; they do not create a new release boundary.
Generic SDK source-unit mappings and persisted mandatory checker links now
advance the current-only project format to schema 18. Core fixed inputs admit
4 MiB and complete stored results admit 8 MiB, while source/content payload
ceilings remain independent. The experimental source-read DTO now requires
original identity and explicitly encoded source references. These incompatible
development contracts remain within the same undistributed application
`0.2.0-alpha.1` batch; schema 17 and earlier directories are preserved and
refused without migration. Stable upgrade support follows the completed
refactor rather than converting earlier experimental snapshots.

Bounded application-directory provisioning uses that same Host store and its
existing on-disk layout. It adds no SDK/wire or project-format change, remains
in this undistributed application batch, and does not establish desktop catalog
controls, trusted runtime distribution or a new release boundary. Metadata-only
package/runtime inventory extends this same store without changing its layout,
SDK/wire profile or schema 18. It does not persist approval or enablement, and
there is no additional version bump or earlier development-format migration.
Trusted application settings add a separate bounded decision file under the
existing Store lock and filesystem owner, without changing installation receipts,
SDK wire shapes or schema 18. Pure SDK identity/digest validation helpers expose
existing syntax rules without changing declaration data. The experimental Host
installation error enum adds `CorruptSettings` and `RevisionConflict`; exhaustive
callers must handle those classifications. These APIs remain in the same
undistributed application/SDK alpha.1 batch, with no further bump or historical
format migration. They do not establish production Desktop controls or a new
runtime distribution.
The desktop now owns that Store at its Tauri application-data location. Its global
Extensions panel reviews a locally selected package, records explicit manual trust,
installs fixed bytes with new packages disabled, and separately changes exact
enablement. Installation records and trusted decisions remain distinct. Backend
selection verifies installed bytes and the complete requested capability binding;
uncertain changes retain the original request for reconciliation. The generated
desktop IPC adds package operations and installation/settings error stages within
the same unreleased batch, without changing schema 18, Store formats, SDK contracts
or version sources. This does not ship bundled runtime artifacts, production plugin
execution, authenticated network updates or a new release boundary.

Use [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Choose a normal release target relative to the preceding normal release, then advance prereleases within that target. During `0.y.z` development, apply this project convention:

| Situation | Version choice |
|---|---|
| Compatible bug fixes only | Increment patch, for example `0.2.0` to `0.2.1` |
| New functionality, or incompatible documented behavior/data/format changes | Increment minor and reset patch, for example `0.2.0` to `0.3.0` |
| Another distributed prerelease for the same target | Advance the prerelease counter, for example `0.2.0-alpha.1` to `0.2.0-alpha.2` |
| Documentation, tests or tooling with no shipped behavior or compatibility change | No application bump by itself |

Use `alpha.N` while the target is under development. A move to `beta.N`, `rc.N` or the normal version requires an explicit readiness decision. Once a stable public compatibility contract is established at `1.0.0`, incompatible changes increment major; compatible features increment minor; compatible fixes increment patch.

Assess the whole unreleased batch, including earlier commits. A new feature in a fix batch changes its target; a new incompatibility requires a fresh compatibility review even if a version was already chosen. Routine commits and internal validation builds can share a pending version. Freeze that version when an explicitly designated prerelease/release snapshot is distributed or tagged; subsequent snapshots must use a new version. Record the source commit and artifact digest to distinguish internal builds.

The first managed target is `0.2.0-alpha.1`. It consolidates development commits through `7febd7e`, including new workflows and storage incompatibilities, after the original `0.1.0` scaffold version. There are no historical release tags to reconstruct. These changes remain **Unreleased**; the version assignment does not assert publication or completed release acceptance.

The desktop's optional included-extension setup adds a required nullable
`defaultsOffer` to the experimental inventory DTO and a fixed-selection setup
request. Earlier DTO consumers must regenerate their contracts. The opt-in
runtime bundle configuration now selects `bundled-plugins` and requires the
independently prepared, source-pinned package trees alongside the runtime.
These incompatible development changes stay in the same undistributed
application `0.2.0-alpha.1` batch. They change no SDK wire identity, Store layout,
current project schema or independent plugin version; there is no additional
version bump or historical conversion. The current bundle catalog selects
independent WebVTT and SMAPI development candidates with current source/review
resources and their complete pinned SDK helpers. Updating this fixed set changes
no application/SDK/plugin version, wire profile, Store layout or schema; it stays
in the same undistributed batch and does not establish complete release acceptance.

## Maintaining each change

Core now stores complete plugin translation results with a schema/digest
reference and their original SDK bytes once. Fixed checker inputs share captured
material and structurally associated fields, reconstructing the unchanged full
SDK contract for the actual channel. This changes persisted execution shapes and
advances the current-only project format to schema 21. Schema 20 and earlier
projects are refused unchanged, without migration; preserve their directories
and use a new current-format project. SDK/process identities, installed Store
formats and dependency metadata are unchanged. Application `0.2.0-alpha.1` and
SDK `0.1.0-alpha.1` stay in the same undistributed batch, with no additional
SemVer bump or publication. The 1 MiB fixed input, 2 MiB ledger result and 8 MiB
attempt bounds remain independent complete encoded limits.

Repeated translation projection execution and adoption now reuse bounded,
verified decoding at the existing ledger owner. Every reuse compares complete
persisted bytes and row associations; current result coverage, cancellation and
live producer/checker authority are still checked for new writes. Worker
completion and original-action reconciliation share that verified input path.
This changes no persisted representation, schema 21, SDK/process/Store format,
dependency or version source. The same undistributed application
`0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch needs no additional version bump;
both Unreleased changelogs record the bounded decoding improvement.

The SDK's existing-translation input/proposal/check/Resource data contracts use
their own schema/behavior 1/1 identities within the same undistributed SDK
`0.1.0-alpha.1` batch. They reuse captured material/native reference and required
check owners, and add Host metadata inspection without starting a component or
changing Desktop, process frames, Store layout or the then-current schema 20. Application
`0.2.0-alpha.1` therefore remains unchanged. Public consumers must select the
actual immutable SDK source artifact containing these additions; no compatibility
conversion, production translation cutover or release is claimed.

The preceding Core translation projection unit added per-entry EX items and
adoption units through the existing ledger and revision/selection/receipt owner.
The experimental translation preview's key range is required nullable because native display evidence
may have no source location; consumers must preserve explicit absence. This adds
no table or alternate persistence/proof owner, and does not change the SDK/process
profile, Store format, the then-current schema 20 or desktop import assembly. It
remains in the same undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch,
with no additional bump, release or historical development-format migration.

1. Assess user-visible behavior, compatibility, project migrations and the application's release impact before completing a change. Check the existing unreleased entries and version target.
2. Describe user-relevant additions, changes and fixes under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md), using the appropriate Keep a Changelog category. State incompatible behavior and concrete migration steps. Consolidate related entries instead of copying commit subjects or listing merge commits.
3. Update [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md) in the same change. English is authoritative; version headings, dates, categories, scope and migration facts must agree. A change without release impact needs no artificial entry or bump; record that assessment in its review or delivery notes.
4. If the batch's target changes, update the Cargo workspace version, regenerate its lockfile entries, and synchronize current-version statements. Verify the resolved versions of both workspace packages and the version metadata of the actual desktop build. Select behavior checks according to the changed risk; a version-only change does not require an unrelated full test suite.

Before an authorized application release, move the batch into `## [VERSION] - YYYY-MM-DD` in both changelogs using the actual release date, leave a fresh `Unreleased` section, and align the manifest version, release title, source commit and artifact identity. Preserve published entries. Tags and release publication are separate operations from local development commits.


Read-only Desktop translation-environment resolution uses the same installed
catalog, approval and immutable runtime owner as source/build resolution. Declared
translation capture extends the existing native directory/file boundary rather
than parsing domain filenames or JSON in the application. The generated IPC is
additive; it does not grant execution authority or complete the translation
workbench. Project schema 21, SDK/process/Store formats, dependencies and version
sources remain unchanged in the same undistributed application
`0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch. Both Unreleased changelogs are
synchronized, with no additional bump or historical migration.

Desktop translation selection and capture now bind declared material to the
current adopted source and an explicitly confirmed existing target language.
Core reads exact native namespace/policy pairs from that source's immutable
result and checks the selected pair at the existing enqueue boundary. The
source-context observation stays within the existing complete 256 KiB read
budget; larger observations are refused rather than truncated. No domain
filename or text parser is added to the application, and capture creates no
execution grant. This additive IPC and strengthened scope association retain
project schema 21, SDK/process/Store formats and dependencies in the same
undistributed application/SDK alpha.1 batch. Both Unreleased changelogs are
synchronized; no additional bump or historical migration is required.
Execution and workbench integration use the existing owners described below.

Desktop translation execution now connects the declared producer, separately
consented checker, durable proof and per-entry projection to the existing Core
ledger and adoption owners. Recovery verifies original checker bytes and exact
projection attempt origins; it never renews execution grants. The additive IPC
and generic projection runner change no SDK/process/Store format, schema 21 or
dependency metadata. Application `0.2.0-alpha.1` and SDK `0.1.0-alpha.1` remain
in this same undistributed batch, with synchronized Unreleased changelogs and no
additional bump or historical migration. The translation workbench now uses the
declared capability path, separate producer/checker consent and checked preview,
while preserving the existing editor and per-entry adoption owner. Pending checks
report incomplete qualification; missing proof for a qualified result remains a
corruption error. This changes desktop behavior without new DTOs, SDK/process/Store
formats, schema, dependencies or version sources. Complete native interaction
acceptance remains pending. Production Desktop IPC now excludes the built-in
translation listing/preflight/import commands, and its execution host no longer
registers their extractor runner. The Desktop importer and native filename
interpretation compile only for tests or the explicit execution-test-host feature.
The frontend and generated production contracts contain only declared
plugin import and generic preview/adoption/editor commands. This removes earlier
development IPC shapes; consumers must regenerate and use the declared plugin
workflow. No project/SDK/process/Store format, dependency or version source changes
are introduced. It remains in the same undistributed alpha.1 batch with both
Unreleased changelogs synchronized and no historical migration.

Normal Core builds now exclude the former built-in translation parser, bundle
and runner APIs. New translation imports use the checked plugin projection;
former captured inputs are refused at enqueue without persisted execution or
change notifications. The importer and its persistence branch compile only for
unit tests or the explicit `execution-test-host` feature. Desktop test fixtures
opt into that existing Core feature through a development dependency; normal
desktop assembly does not enable it. Experimental Rust consumers must use the
declared extraction, independent check and projection APIs. This removes earlier
development APIs without changing current project tables, proof or receipt
shapes, SDK/process/Store formats, dependencies or version sources. The translation cutover originally retained schema 21 in the same
undistributed application/SDK alpha.1 batch, with both
Unreleased changelogs updated and no historical migration. Generic editor,
history and original save receipts retain their existing owner. The filename
decoder still required by the old build path now belongs to that build module;
source and build domain owners await their separate production cutover.

Normal Core build construction, domain artifact validation and desktop built-in
build IPC now leave the production assembly. Their opt-in execution-test fixtures
remain isolated. Removing the built-in frozen-plan variant advances the current-only
project format initially to schema 22; schema 21 and earlier development directories were
refused unchanged, without migration or compatibility decoders. Generic plugin
release-plan serialization, artifact bytes, original receipts and delivery records
retain their existing representation and owner. Application `0.2.0-alpha.1`, SDK
`0.1.0-alpha.1`, SDK/process profiles, Store formats and dependencies remain in the
same undistributed batch; no additional SemVer bump is needed. Both Unreleased
changelogs record the removed experimental APIs and current schema boundary.

Normal Core source imports now require the declared extractor and an independently
selected checker. Former SMAPI/WebVTT source parsers, default capability selection,
built-in capture APIs and source selection/integration IPC compile only for tests
or the explicit execution-test-host feature. Production schemas and frontend
adapters expose declared plugin capture and generic history/adoption commands.
Experimental callers must regenerate contracts and select the declared pipeline.
Removing the supported built-in source record channel advances the current-only
project format to schema 23, even though plugin source bytes, identities, revision
projection, proof and receipt shapes remain unchanged. Earlier development
directories are refused unchanged. Application and SDK alpha.1, SDK/process/Store
formats, dependencies and version sources remain in the same undistributed batch;
no additional SemVer bump or historical migration is introduced. Both Unreleased
changelogs record the source cutoff and current schema boundary.

The additive experimental review-check input/declaration/error contracts use their
own exact 1/1 schema/behavior identities and the existing check-results contract.
The Host reads the captured review Resource without executing code. Generated
JavaScript types and validators come from those Rust definitions. These data and
metadata APIs do not change Core qualification, project schema 23, process frames,
installed Store formats, dependencies or desktop runtime assembly. Application
`0.2.0-alpha.1` and SDK `0.1.0-alpha.1` remain the same undistributed batch, with
no additional SemVer bump, publication or historical migration. Production Review
and automatic-selection consumers still require integration with the captured
Core/domain union and actual checker execution.

The source-import declaration now requires a named Review Resource and an exact
ReviewBinding from the same captured package/profile. Its independently versioned
resource schema/behavior advances to 2/2; callers must supply the captured review
declaration when binding. Core stores the domain rules and complete checker/runtime
selection in the source operation's existing immutable input, so the current-only
project format advances to schema 24. Earlier development directories are refused
unchanged without migration. SDK 0.1.0-alpha.1, application 0.2.0-alpha.1 and
process/Store/dependency versions remain the same undistributed batch. Binding
inspection and reading add no execution grant, approval or release eligibility;
production Review policy/execution cutover remains separate integration work.

Core's read-only Review plan capture reuses the adopted snapshot/proof/mapping
owner and existing consistent Review reads. Its owned SDK required-check union
fixes complete original material, current selected text, resource dependencies
and exact checker/runtime metadata independently of the manual decision basis.
Core choice and terminology logic shares the existing validator; no check is
recorded and no execution grant or release qualification is created by capture.
This additive library boundary changes no stored shape, project schema 24,
SDK/process/Store/dependency identity or desktop DTO. Application 0.2.0-alpha.1
and SDK 0.1.0-alpha.1 remain the same undistributed batch, with no additional
bump or historical migration. Actual domain execution and current-QA/automatic
selection/ReleasePlan consumers still require production integration.

The same Core Review plan now projects an action-bound domain input through the
existing runtime and grant owner. A consistent ledger read requires the actual
current, unsuperseded channel result and matching live authorization before
owned receiving/coverage computation. Complete coverage retains findings and
explicit N/A; it grants no durable current QA, waiver or release qualification.
This additive library execution boundary changes no SQL shape, schema 24, SDK
archive, process/Store/dependency or desktop DTO. The same undistributed app
0.2.0-alpha.1 / SDK 0.1.0-alpha.1 batch needs no additional bump or migration;
current-QA adoption and production consumers remain separate integration work.

Core's current QA adoption now persists its captured required-check union,
actual results and original execution identities in the existing immutable
Review table. The current-only project format advances to schema 25; schema 24
and earlier development directories are refused unchanged without migration.
Current Review reads and eligibility use this evidence independently of manual
approval. Re-adopting unchanged source bytes records a changed Review binding,
while an identical binding remains an unchanged-source rejection. Experimental
CheckRun IPC includes the strict nullable evidence projection; generated
consumers must accept that shape. Legacy synchronous checks refuse plugin-bound
QA; callers must execute and adopt the authorized checker evidence. The SDK, process,
installed Store and dependencies are unchanged. This remains the same
undistributed application 0.2.0-alpha.1 / SDK 0.1.0-alpha.1 batch and requires
no additional version bump or historical conversion. Desktop execution,
automatic-selection and full release consumers still require integration.

Core automatic selection now captures candidate QA before selection and persists
actual evidence with the selection in one transaction. Policy receipts retain
exact required checks and original execution identities, including blocked
candidates. This advances the current-only project format to schema 26; schema
25 and earlier development directories are refused unchanged without migration.
The experimental AutomaticSelectionReceipt includes required nullable captured
evidence and the previously observed selection identity; the candidate basis
names the exact prospective selection. Normal projects require actual evidence.
SDK, process, Store, dependencies and
installed packages are unchanged, and the same undistributed application
0.2.0-alpha.1 / SDK 0.1.0-alpha.1 batch needs no extra bump. Desktop automatic
checker orchestration and complete release/native acceptance remain separate.

Desktop Review now uses prepared exact checker/runtime metadata, separately
consented per-attempt execution and the existing Core evidence commit. The
experimental Review IPC replaces direct synchronous execution with preparation
and a fixed grant; consumers must use the current generated requests. Project
schema 26, SDK/process contracts and installed Store formats are unchanged.
This stays in the same undistributed application `0.2.0-alpha.1` batch, with
no additional version bump, compatibility path or development migration.

WorkPlan checked-selection orchestration now derives the exact checker from its
existing immutable source snapshot. The experimental WorkPlan IPC adds captured
checker availability and explicit local-execution consent; callers must use the
current generated client. Plans retain their existing stored shape and digest;
project schema 26, SDK/process and Store formats are unchanged. This is the same
undistributed application `0.2.0-alpha.1` batch and needs no additional bump or
development migration. Reopened history does not restore local execution consent.

Normal Core QA now excludes the legacy domain parser, fixed four-rule selection
and synchronous check APIs from its default build. Those APIs and projections
remain explicit test-host tooling; normal consumers use actual prepared
execution/evidence adoption. Missing ledger evidence is rejected for current
and historical QA rather than admitted as a legacy projection. Existing valid
current-format history retains its original authority without restoring grants.
This changes experimental Core API availability, not stored fields, schema 26,
SDK/process/Store profiles or dependencies. The same undistributed application
`0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch needs no extra bump or development
migration. Both Unreleased changelogs record the behavior.

Current QA batch reads now stream original immutable ledger frames within their
existing SQLite snapshot. Release qualification batches requested units and all
locales inside one read snapshot. This reduces retained decoded input memory without
changing any persisted frame, digest, profile, coverage or application-facing
API. Project schema 26, SDK/process/Store formats and dependencies are unchanged.
The same undistributed application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch
needs no extra bump or migration; both Unreleased changelogs record the change.

Repeated source proof reads reuse bounded pure immutable qualification only after
checking all four persisted frames, row associations and the current proof link.
Opening reuses its just-restored attempt input for item validation. No execution
permission or currentness is cached, and no stored shape, schema 26, dependency
or SDK/process/Store/IPC profile changes. This remains the same undistributed
application `0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch without an extra bump
or migration; both Unreleased changelogs describe the behavior.


The source workbench now uses capability-neutral identity and workflow messages.
Opaque plugin diagnostics and errors do not select fixed domain advice; shared
command details retain their original reason or field. This changes presentation
only, with no SDK/process/Store/IPC or schema 26 change and no new dependency.
Both Unreleased changelogs are synchronized. The same undistributed application
`0.2.0-alpha.1` / SDK `0.1.0-alpha.1` batch needs no extra bump or migration.

Native application Host discovery and explicit approval/revocation now use the
existing application settings action, revision CAS and pending-result recovery.
The experimental inventory includes a required strict current-Host availability
union; callers must regenerate IPC and confirm the exact offered digest.
Caller-provided descriptors, paths, origins and execution grants are refused.
Obsolete Native approvals remain removable while Node decisions are preserved.
No runtime tree is installed and no worker or attempt grant is created. Desktop
source/build/translation resolution now uses the same strict SDK
execution-environment union and existing RunnerRuntime. Native choices require
the independently approved exact current application Host and no installed Node
tree; every selected executable provider must match its runtime family.
Receiving an environment view creates no worker or Core grant. Experimental
source/build/translation DTO consumers must regenerate the union fields;
per-attempt execution consent and independent proof remain mandatory. Project
schema 27, settings
format 2, SDK/process/receipt formats, dependencies and the same undistributed
application/SDK alpha.1 batch remain unchanged; no extra bump or historical
migration is required. Both Unreleased changelogs describe the behavior.

Execution envelope depth validation now traverses borrowed serialized fields
without creating a duplicate JSON payload tree. Strict decoding, the same depth
limit, complete byte digests and associations remain authoritative. This changes
internal allocation only: project schema 27, settings format 2, SDK/process/receipt
formats, public DTOs and dependencies are unchanged. Both Unreleased changelogs
are synchronized; the same undistributed application/SDK alpha.1 batch requires
no additional bump or historical migration.

Exact execution input storage now uses immutable 16 KiB byte chunks and bounded
references in the original Core SQLite ledger. The input digest still identifies
the complete original frame; SDK requests, full source material, result links,
per-item proof and permission semantics retain their original contracts. Readers
reconstruct exact bytes within the existing parent SELECT and read snapshot,
including cache hits. Chunk insertion and attempt recording share the original
enqueue transaction. This incompatible stored representation advances the
current-only project format to schema 28. Schema 27 and earlier development
directories are refused unchanged; no historical decoder or migration is added.
The existing rusqlite 0.40.2 dependency enables its SQLite function interface;
there is no new library or dependency version. Application 0.2.0-alpha.1 and SDK
0.1.0-alpha.1 remain the same undistributed batch, so no additional version bump
is required. Both Unreleased changelogs record the storage boundary.

macOS Apple silicon Core builds now enable the existing sha2 0.10.9 hardware
backend with a target-specific dependency feature. The Cargo lockfile adds
upstream sha2-asm 0.6.4, reusing the existing C compiler build dependency. Linked
SDK/Host consumers share that feature; standalone SDK-only consumers retain
their own build configuration. Exact SHA-256 byte identities, project schema 28,
SDK/process/Store/IPC profiles and application/SDK version sources are unchanged.
This stays in the same undistributed application 0.2.0-alpha.1 / SDK
0.1.0-alpha.1 batch and needs no extra bump or historical migration. Both
Unreleased changelogs describe the platform improvement.
