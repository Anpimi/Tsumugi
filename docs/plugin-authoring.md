# Experimental plugin authoring

This walkthrough takes a plugin author from a fixed SDK snapshot to a prebuilt
package, read-only inspection, and explicit development loading in Tsumugi. It
uses the existing Rust JSON catalog and JavaScript WebVTT examples rather than a
second loader or transport implementation.

The SDK and these packages are **experimental, matching development snapshots**.
`tsumugi-plugin-sdk` is currently `0.1.0-alpha.1` and has not been published to
crates.io. A matching package version alone does not establish compatibility:
different undistributed snapshots can have the same alpha version and different
contracts. Record the selected SDK archive and its provenance, the actual Host
and runtime, and the package bytes used for each check.

## Obtain a complete matching snapshot

The public projects are [Tsumugi](https://github.com/Anpimi/Tsumugi) and
[tsumugi-plugins](https://github.com/Anpimi/tsumugi-plugins). Tsumugi owns the SDK,
generated schemas, contract CLI and process Host. The plugin repository owns the
domain implementations, independent tests and explicit package recipes. A plugin
does not import Core, the desktop application, its state or a project database.

Use complete matching development snapshots supplied with their provenance.
Repository links identify the projects; they do not promise that the current
default branch, a version tag, or an SDK producer commit already contains or
publishes these candidates. If the selected source or artifact is unavailable,
obtain that complete snapshot before continuing. Do not substitute an arbitrary
`main`, `latest`, an earlier archive with the same filename, or an unrelated Host.

The plugin snapshot must contain `sdk.lock.json`, its selected tracked
`artifacts/sdk/<producer-commit>/...crate`, `tooling/prepare-sdk.py`,
`examples/flat-json/` and `plugins/webvtt/`. The Tsumugi snapshot must contain
`crates/plugin-sdk/`, `crates/plugin-host/` and this guide. The included archive
makes the SDK consumable without fetching its producer commit or requiring a
second source checkout to build the plugin. The producer commit is provenance,
not a claim that `git fetch` can retrieve it.

For the commands below, set these paths to your selected source directories:

```sh
TSUMUGI_SOURCE=/absolute/path/to/matching/Tsumugi
PLUGIN_SOURCE=/absolute/path/to/matching/tsumugi-plugins
```

Use Rust 1.98 or newer and Python 3.11 or newer for the Rust example and package
tools. The JavaScript example requires Node `>=26.10.0 <27`; building the
JavaScript Host or desktop also uses the repository's pinned pnpm 12.8.1. Follow
the [application development prerequisites](../README.md#development) when
building the desktop. Dependency fetching needs network access or a prepared
cache. Cargo's `--offline` option is useful only after those dependencies exist;
it does not make an empty machine an offline source builder.

The package tools use Unix filesystem operations. The current process launcher
has macOS evidence; Windows plugin execution is refused pending an owned process
cleanup implementation. Linux directory capture is implemented, but this guide
does not establish Linux execution acceptance. Build native workers for the
actual target OS and CPU. The supported bundled JavaScript environment currently
requires Apple silicon and macOS 13.5 or later, independently of the desktop's
base platform requirements.

## Consume the pinned SDK

From the plugin repository:

```sh
cd "$PLUGIN_SOURCE"
python3 tooling/prepare-sdk.py
cargo test --locked -p tsumugi-sdk-probe
cargo run --locked -p tsumugi-sdk-probe -- plugins/webvtt/manifest.json
```

Preparation verifies the archive selected by `sdk.lock.json` against its SHA-256,
then materializes its exact files in the ignored
`.cache/sdk/tsumugi-plugin-sdk-0.1.0-alpha.1/` directory and stages declared SDK
helpers. It reports `Prepared tsumugi-plugin-sdk-0.1.0-alpha.1 from the verified
SDK artifact`. It does not fetch or execute the SDK producer, start a worker or
install a plugin. The probe compiles against that archive; its final command
prints the validated `org.tsumugi / webvtt @ 0.1.0-alpha.1` identity and component
and contribution counts. Its tests exercise public data contracts with synthetic
inputs, rather than a running plugin or an accepted desktop workflow.

Read the lock's `archive`, `sha256`, `sourceRepository`, `sourceCommit`, license
and publication status together. Keep the lock, dependency lockfiles and archive
with a reproducible source snapshot. See the plugin repository's
[SDK provenance documentation](https://github.com/Anpimi/tsumugi-plugins/tree/main/artifacts/sdk)
in the matching snapshot for artifact ownership and replacement rules.

Do not edit the verified cache, generated validators or archive to change a
contract. SDK changes belong in Tsumugi; select a new immutable archive and
update the consumer lock explicitly. A cache mismatch is an error. Preserve an
old cache outside the selected SDK package directory before deliberately
replacing it; preparation verifies existing contents and refuses unexpected or
changed files. Repeatedly rerunning it does not repair an unreviewed cache.

## Choose an implementation

A manifest declares one package identity, its components, contributions,
permissions and limits. A component owns activation, scope and cleanup. Each
callable contribution declares its exact contract, input/output/error schemas,
profiles and project effect. A Resource or Skill can be inert data; it needs no
worker solely to be read. See the [declaration contract](../crates/plugin-sdk/docs/declarations.md).

Use your own namespaced publisher, plugin and contribution IDs when creating a
new package. Preserve exact profile identities and their behavior; changing an
ID or lowering a validator's requirements is not an implementation of an existing
contract. To appear in a current workbench, supply the Resource contract that
workbench consumes, with exact capability selections, rather than adding a
plugin-name switch. Source import, translation import, review and build each
have separate SDK declarations and checks.

### Rust: the flat JSON catalog

In the matching plugin snapshot, start with `examples/flat-json/README.md` and
`examples/flat-json/src/definition.rs`. One typed definition produces its manifest
and Source/Translation/Review/Build Resources. The worker implements the SDK's
`NativeComponent` using the optional `native-worker` feature; the SDK supplies
framing, result correlation, cancellation and disposal. Do not write another
native protocol codec. The [native component guide](../crates/plugin-sdk/docs/native-worker.md)
describes the entry point and its limits.

From the plugin repository:

```sh
cd "$PLUGIN_SOURCE"
cargo test --locked -p tsumugi-flat-json-example
cargo build --locked -p tsumugi-flat-json-example --bin flat-json-worker
mkdir -p .generated artifacts/candidates
target/debug/flat-json-worker --metadata > .generated/flat-json-metadata.json
python3 tooling/package-flat-json.py .generated/flat-json-metadata.json \
  target/debug/flat-json-worker artifacts/candidates/flat-json
```

The tests execute author code over synthetic catalogs, including independent
source, placeholder and actual-output checks. `--metadata` also **executes the
built author binary**, in its metadata mode; its output is an object containing
the generated manifest and Resource files. Running the binary without that
option serves the framed Host protocol and is not a command-line file converter.
If you set `CARGO_TARGET_DIR`, substitute the actual built worker path above.

The packager copies explicit metadata, the nonempty executable, the exact SDK
lock and licenses into a **new** `artifacts/candidates/flat-json` directory. It
runs no binary or build script. Existing outputs are refused, including partial
attempts. Inspect a failed attempt and use a fresh output path; do not overwrite
an installed or previously verified tree to make packaging succeed. For
distribution, use Rust's path-remapping options for checkout/cache paths and
review the resulting target artifact separately.

This example accepts a bounded flat JSON object of strings in captured
`source.json`, with exact Unicode keys and brace placeholders such as `{name}`.
It also demonstrates existing-translation extraction and independent checking.
It does not promise preservation of source JSON formatting in built output;
consult its README for the complete profile and unsupported input.

### JavaScript: the WebVTT component

Start with `plugins/webvtt/manifest.json`, `components/component.mjs`,
`components/webvtt.mjs`, `package-files.json` and `docs/contracts.md` in the plugin
snapshot. It is an ESM `.mjs` package with no transpilation step or third-party
runtime dependencies. Preparation supplies the exact SDK helper modules used by
its tests and package recipe:

```sh
cd "$PLUGIN_SOURCE"
python3 tooling/prepare-sdk.py
node --test plugins/webvtt/tests/*.test.mjs
mkdir -p artifacts/candidates
python3 tooling/package-plugin.py plugins/webvtt artifacts/candidates/webvtt
```

The Node tests **execute the component and domain code**; they do not create a
real Host channel. Packaging copies only the explicit file recipe, generated SDK
helpers, lock and licenses into the new output directory. It executes no package
scripts or worker. Review partial outputs and select a fresh destination on
failure, as for the Rust package.

The current facade exports a component with `activate(api)`. Register a handler
for each member of the Host's frozen roster using
`api.register(contribution.id, handler)` during activation. Read the selected
members from `api.contributions`; `api.instance` is the component principal.
Missing, duplicate, unknown or late registrations fail activation. The old
`api.contribution` and `register(handler)` API has no fallback. WebVTT's operation
map is a concrete example of dispatching only the selected declarations.

Handlers receive captured `EncodedPayload` data and invocation metadata,
including the actual provider, profile and cancellation signal. They return
`{ kind: 'succeeded' | 'failed' | 'unknown', utf8 }` using the declared output or
error contract. The Host supplies the envelope, identity and digest. Observe
invocation and component cancellation and register owned cleanup with
`api.onDispose`. Exceptions terminate the channel; they are not automatically
converted into valid domain errors.

The generated JavaScript validators check structure. The WebVTT component's
`JSON.parse` does not prove rejection of duplicate decoded keys in arbitrary raw
operation JSON; use the SDK's strict receiver at that trust boundary. Preserve
the domain checks as well. WebVTT deliberately supports a bounded plain-caption
profile, preserves non-payload bytes when building, and has no translation-file
import. Domain tests should include malformed inputs and independently expected
bytes, not only output generated by the implementation under test.

For a component that uses an existing application service, see the same plugin
repository's [Philosophy Generation client](https://github.com/Anpimi/tsumugi-plugins/blob/main/examples/philosophy/README.md#generation-service-client).
It keeps the knowledge query/check component independent and adds one bounded
Attempt-scoped client for the [original work-plan generation service](work-plans.md).
The service retains model configuration, authorization, child identity and the
shared budget; an enqueue receipt is distinct from a finished model result.

## Check contracts without running a plugin

These commands run the trusted SDK CLI from the selected Tsumugi source. Cargo
can compile dependencies and their build code; the CLI itself only checks data
and starts no plugin. From the Tsumugi repository:

```sh
cd "$TSUMUGI_SOURCE"
cargo run --locked -p tsumugi-plugin-sdk --features schema \
  --bin tsumugi-plugin-contract -- \
  validate "$PLUGIN_SOURCE/artifacts/candidates/webvtt/manifest.json"
cargo run --locked -p tsumugi-plugin-sdk --features schema \
  --bin tsumugi-plugin-contract -- \
  validate-source-import-declaration "$PLUGIN_SOURCE/plugins/webvtt/profiles/source-import.json"
cargo run --locked -p tsumugi-plugin-sdk --features schema \
  --bin tsumugi-plugin-contract -- \
  check-schema crates/plugin-sdk/schemas/plugin-manifest.schema.json
cargo run --locked -p tsumugi-plugin-sdk --features schema \
  --bin tsumugi-plugin-contract -- profile-process
```

Successful `validate` commands print the accepted typed JSON. `check-schema`
prints `Schema is current.`; `profile-process` prints the current SDK process
version and bounds. Failure writes an error to stderr and exits nonzero. The
manifest receiver rejects unknown/duplicate typed fields, unsupported protocol,
missing owners, duplicate identities, undeclared permissions, invalid bounds and
unsafe relative paths. JSON Schema alone cannot prove those relationships.

The [SDK README](../crates/plugin-sdk/README.md) provides the existing exchange
commands: `validate-exchange`, `match-result <request> <result> <channel-binding>`
and `check-coverage <captured-set> <results>`. The CLI also has strict receivers
and generated schemas for the domain declarations below. Run it with no arguments
to see its actual usage; it exits nonzero for missing or unsupported arguments.

| Authoring concern | SDK contract |
|---|---|
| Exact original bytes, text offsets, results and check coverage | [Content exchange](../crates/plugin-sdk/docs/exchange.md) |
| Captured source, independent source checking and source Resource | [Source extraction](../crates/plugin-sdk/docs/source-extraction.md) |
| Existing translations and independent mandatory checking | [Translation import](../crates/plugin-sdk/docs/translation-import.md) |
| Selected text and mandatory domain rules | [Review](../crates/plugin-sdk/docs/review.md) |
| Fixed targets, built bytes and independent artifact checking | [Build](../crates/plugin-sdk/docs/build.md) |
| Read-only query capability and supporting Resource/Skill selection | [Tools](../crates/plugin-sdk/docs/tools.md) |
| Current process frames, facade and service limits | [Process](../crates/plugin-sdk/docs/process.md) |
| Exact Node or Native application environment | [Environment](../crates/plugin-sdk/docs/environment.md) |

Schemas under `crates/plugin-sdk/schemas/` and JavaScript declarations/helpers
are derived from the Rust SDK. Modify their source and use its existing
generation workflow; do not hand-edit generated files in a plugin. Static
`match-result` channel fixtures exercise association, not the identity of an
actual child process. A complete check set is distinct from a passing semantic
report: an error finding can block acceptance even after a checker finishes.

## Inspect the complete prebuilt package

Use the existing Host tool, rather than a manifest hash or a plugin-owned digest
algorithm:

```sh
cd "$TSUMUGI_SOURCE"
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- \
  inspect "$PLUGIN_SOURCE/artifacts/candidates/flat-json"
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- \
  inspect "$PLUGIN_SOURCE/artifacts/candidates/webvtt"
```

Each successful invocation prints JSON with `plugin`, `packageDigest`,
`manifestSha256`, `fileCount` and `byteCount`. The counts include `manifest.json`.
The package digest covers the complete captured manifest/files, canonical paths
and executable flags. It is different from an archive transport SHA-256 or the
manifest's SHA-256. Retain that output with the exact package and source/SDK pins.

The inspector captures an ordinary prebuilt directory through the same bounded
owner used by loading. It validates the manifest and required package files,
rejects symbolic/hard links, special files, path aliases, changed input and
oversized trees, and does not execute an entrypoint, download, install or run a
script. Current directory capture bounds are 256 non-manifest files plus
`manifest.json`, 64 MiB total, depth 16 and a ten-second observed deadline. The
example packager has its own narrower 256-file bound including the manifest.
Review the capture's source/platform limitations in
the [Host guide](../crates/plugin-host/README.md#captured-package-and-actual-channel).

A digest identifies bytes; it does not authenticate the claimed publisher or
approve those bytes. Rebuild/repackage into a fresh directory and reinspect after
changes. Editing a source tree cannot update an already captured package or its
installed bytes.

## Load a development package explicitly

Development loading uses the normal **Extensions** controls with a prebuilt local
folder. There is no automatic source watcher or install-time source compilation.
Use synthetic files and a disposable current-format project for development;
opening an earlier experimental project is not a format migration mechanism.

1. Open **Extensions → Choose plugin folder** and select the prebuilt directory,
   not the source repository or archive. Review the claimed publisher, version,
   runtime, requested permissions, exact fingerprint and file/byte counts.
   Compare the fingerprint to the independently inspected package you intended.
2. Review the explicit local trust checkbox, then choose **Approve and install**.
   This saves approval before installation; it authenticates no publisher and
   runs no installation script or worker. A new manual package starts disabled.
3. Find it under **Installed packages** and choose **Enable**. This permits new
   capability selection; it grants neither a runtime nor execution permission.
   **Inspect approved package** displays the approved installed declaration.
4. Approve the correct execution environment separately. For the Rust example,
   review **Native application environment**, its current identity and checkbox,
   then **Approve application Host**. No Node runtime is installed or borrowed.
   For JavaScript, review the exact application-provided **JavaScript runtime**,
   its platform requirements and fingerprint, then **Approve and install
   runtime**. Use **Verify installed environment** to check its retained bytes.
5. In the appropriate project workbench, select the installed package's Resource
   and approved compatible environment. Capture the input, review the exact
   attempt and separately consent to running that code. An independent semantic
   checker needs its own consent; successful extraction alone cannot adopt data.

For a small source exercise, create a new directory containing `source.json`
with `{"greeting":"Hello {name}"}` for the Rust example, or `source.vtt` with:

```vtt
WEBVTT

greeting
00:00:00.000 --> 00:00:01.000
Hello
```

Confirm the project source language and use **Choose source folder → Check source
files**. Capture is read-only and runs no plugin. After reviewing the fixed
inputs, **Import for preview** runs the extractor only with its separate consent.
Review the saved proposal, prepare and separately run the independent source
checks, record their validation, then explicitly apply the complete checked
snapshot. The observable result is adopted source text, with its original saved
execution/check evidence; the external source file remains unchanged. See
[source import](source-import.md) for updates, identity decisions and recovery,
[translation import](translation-import.md), [review and QA](review-qa.md) and
[build/export](build-release.md) for the later independent operations.

The JavaScript control offers only supported application-provided runtime
materials. A build reporting that no runtime is bundled cannot use a Node on
`PATH` as a substitute. To prepare a matching developer application, use the
existing [JavaScript Host build and fixed runtime preparation](../runtimes/javascript-host/README.md),
and follow its explicit desktop bundle instructions. Host preparation/inspection
alone does not install that environment in the desktop. Manual
[offline Packs](offline-packs.md) and [signed offline repositories](offline-repositories.md)
have their own selection and trust flows; they reuse installation rather than
granting a package additional authority.

Workers run as the operating-system user. Native binaries and Node code can
access files, network and OS APIs outside the supplied captured input; this is
**not an OS sandbox**. A facade, `captured-input` declaration, installation,
enablement, environment approval or successful static check does not remove
that access or replace current execution consent. Keep real projects and secrets
out of test inputs and diagnostics. Returned proposals remain unapplied until
the application's independent checks and explicit adoption succeed.

To stop future selection, **Disable** preserves approval and installed bytes.
**Revoke approval** is a separate confirmed action that stops new work and
requests cancellation of dependent work. Uninstall the reviewed installation
only after revoking its approval and completing cleanup. Project content, saved
results and exported files remain; uninstall is not rollback of adopted results.

## Exercise the existing real-process pairings

These opt-in commands **run author code in actual child processes** over
synthetic data. Review the prebuilt package and fingerprint first; supply the
actual `packageDigest` from Host inspection as an independently reviewed input,
not the manifest or archive hash. From the matching Tsumugi snapshot, the Rust
example uses the existing test:

```sh
cd "$TSUMUGI_SOURCE"
TSUMUGI_TEST_NATIVE_PACKAGE="$PLUGIN_SOURCE/artifacts/candidates/flat-json" \
TSUMUGI_TEST_NATIVE_DIGEST='<reviewed-packageDigest>' \
cargo test --locked -p tsumugi-plugin-host --features core-adapter \
  --test native_catalog -- --ignored --nocapture --test-threads=1
```

This suite installs/reopens fixed bytes in a temporary Store, captures its actual
Native Host and exercises source/check/review/build/artifact channels and Core
adoption. The environment variable names select only this test's package; they
do not configure the desktop or grant an ordinary project attempt.

For WebVTT, first prepare and independently approve the complete tool/clean Host
trees and descriptor through the [existing runtime preparation workflow](../runtimes/javascript-host/README.md#prepare-the-fixed-macos-tool-and-host-artifact).
Then use the existing JavaScript pairing:

```sh
cd "$TSUMUGI_SOURCE"
TSUMUGI_TEST_PLUGIN_PACKAGE="$PLUGIN_SOURCE/artifacts/candidates/webvtt" \
TSUMUGI_TEST_PLUGIN_DIGEST='<reviewed-packageDigest>' \
TSUMUGI_TEST_RUNTIME_TOOL=/absolute/path/to/approved/tool-tree \
TSUMUGI_TEST_RUNTIME_HOST=/absolute/path/to/approved/clean-host-tree \
TSUMUGI_TEST_RUNTIME_APPROVAL=/absolute/path/to/approved/environment.json \
cargo test --locked -p tsumugi-plugin-host --features javascript-conformance \
  --test official -- --test-threads=1
```

The full `official` suite covers source extraction/independent source checking
and build/artifact checking using captured Node/Host bytes. It does not establish
Core adoption or a desktop journey. Missing required selections fail rather than
silently skipping. Confirm that tests were discovered and actually ran; a
zero-test, filtered or wholly skipped result proves no pairing. Test fixture
approval does not authenticate a publisher or authorize a subsequent execution.

For both domains' actual Core adoption boundaries, use the
[prebuilt-package compatibility runner](../crates/plugin-host/scripts/README.md).
It inspects independently pinned WebVTT and SMAPI packages and the approved
runtime, then selects the existing source-adoption and translation-adoption
tests exactly once each. Its separate report preserves actual counts and
failure logs; it does not install packages or establish Desktop GUI acceptance.

Neither these recipes nor this document claim that your chosen combination has
passed. Record the actual source revisions/dirty changes, SDK selector, target,
package/runtime fingerprints, command, executed tests and result. Domain tests,
SDK validation, package inspection, real process/Core integration, rendered
desktop use and clean-system release acceptance provide different evidence.

## Diagnose the failing boundary

Keep the original error classification and stage. SDK CLI diagnostics use names
such as `InvalidSchema at manifest`; the Host inspector prints `HostError` names
such as `PackagePath`. Desktop diagnostics additionally provide a diagnostic
reference, code, stage, outcome and applicable recovery action. Report those
identifiers and the relevant version/fingerprint pins, with a minimal synthetic
reproduction; do not include credentials, complete user inputs or private paths.

| Failure | What to check and how to continue |
|---|---|
| SDK archive digest mismatch or cache differs from selected artifact | Compare the complete lock and tracked archive. Obtain the intact selected snapshot. Preserve and deliberately replace a mismatched cache; do not edit verified bytes or switch to another same-version archive. |
| `InvalidSchema`, `UnsupportedProtocol`, `MissingOwner`, `UndeclaredPermission` | Validate original JSON with the SDK CLI. Correct the owned declaration, fields, component references or permission relationship; JSON Schema success alone is insufficient. |
| `IncompatibleContract` or ambiguous provider selection | Compare exact contract/profile IDs and both version fields using the [explicit package diagnostic](capability-compatibility.md), then select the explicit provider. Do not select by registration order or accept an unknown profile. |
| `PackagePath`, `MissingArtifact`, `PackageLimit`, `InvalidContract` | Inspect the prebuilt directory and explicit recipe. Include entrypoints/Resources/helpers/licenses, use portable ordinary files and executable flags, and stay within bounds. Repackage to a new destination. |
| `PackageChanged` or `PackageMismatch` | Stop editing the candidate during capture. Repackage and inspect the intended immutable bytes. A matching manifest or transport hash cannot replace the complete package digest. |
| `plugin-selection-expired` or `plugin-candidate-changed` | Choose the package folder again and review its current fingerprint before approving it. |
| `plugin-approval-mismatch`, unavailable capability or `RuntimeMismatch` | Read current extension state; check exact installed approval, enablement, package bytes and runtime family/fingerprint. Approve the actual Native Host or install the supported Node/Host environment separately. |
| No bundled runtime, unsupported platform or unavailable Native Host identity | Use an intact matching supported application/environment. A local Node, declared version, copied descriptor or successful compilation cannot stand in for the approved runtime. |
| `HandshakeMismatch`, `InvalidFrame`, `RequestMismatch`, `ResultMismatch` | Compare SDK/process/runtime snapshots, complete activation and actual invocation binding. Rebuild and recapture old workers/Host materials; use the SDK facade, reserve stdout for frames and put bounded diagnostics on stderr. Do not rewrite identity fields to force acceptance. |
| `DependencyUnavailable` | Check required declared services, scope, contract and permission against the actual Host's supported broker. A declaration or optional-service API does not make a service available. |
| `Timeout`, `Cancelled`, `AuthorityRevoked`, `Closed` or `OutputLimit` | Inspect the saved original attempt and declared/Host bounds. Observe cancellation and cleanup in author code. Expired or closed permission cannot be renewed on that original attempt; prepare a fresh reviewed attempt when appropriate. |
| Domain error or blocking check findings | Read the original declared error/report and fix the source or implementation. Completed execution and complete check coverage do not mean semantic acceptance. Preserve the proposal/evidence while resolving the failure. |
| `stale-revision` or changed settings | Use **Read current state**, preserve newer input, and review the current package/environment choice before preparing a new action. |
| `plugin-operation-pending`, recovery required or outcome unknown | Keep the original request and use **Read current state** and **Retry original operation**, or the workbench's original-operation reconciliation. A lost response does not prove nothing happened. Do not create a new installation/start just to retry, renew its expiry, or manually remove Store files. |

An already installed snapshot is independent of its former source folder. Changes
to package approval or runtime availability can block new execution while saved
project results remain readable. A historical acknowledgement is data, not a
new grant or proof that a previous process is still running.

## Compatibility and support boundary

Keep these identities separate:

| Identity | Current meaning |
|---|---|
| SDK package SemVer and archive SHA-256/provenance | Select the exact experimental source artifact; `0.1.0-alpha.1` alone is insufficient. |
| Manifest and content-exchange envelope protocols | Separately versioned SDK data formats; currently protocol 1. |
| Capability, payload schema and profile references | Exact `(id, schemaVersion, behaviorVersion)` matches; there is no implicit range or behavior fallback. |
| Process protocol | Currently 3, with the complete frozen component roster. Process 1/2 workers and captured runtime descriptions are refused. |
| Package identity and `packageDigest` | Claim plus complete prebuilt bytes/executable flags; separate from source trust and origin. |
| Runtime descriptor/digest and platform | Exact approved Node/Host trees or the actual approved Native application Host; separate from package approval. |
| Project storage and installation formats | Application/Store-owned formats; changing the SDK version does not migrate historical development data. |

Project and Attempt channels select one callable. The basic Rust native facade
supports one member and no service calls. The limited shared Application Tool
profile supports a read-only JavaScript roster or a native singleton, without
required dependencies or ProjectService permission; it requires separate
lifetime consent as well as each project's exact query consent. It can retain
state and earlier input across projects until stopped. See the
[Host's Application profile](../crates/plugin-host/README.md#application-tool-lifetime)
and [desktop tool guide](plugin-tools.md) before choosing that scope. Process 3
support does not enable arbitrary Application components, native multi-callable
workers, generation, domain operations or service compositions.

A declaration can describe more than a particular application consumer supports.
Use only a documented, implemented consumer; declared UI, service, Skill or IDE
concepts do not imply arbitrary UI loading, shell hooks, model access or universal
IDE compatibility. The public SDK facade does not expose Cordis internals or
provide compatibility with another product's loader. Runtime/platform and full
release acceptance remain separate gates. Follow the
[versioning policy](versioning.md) and the owning plugin's version/changelog when
preparing a distributable artifact; local successful checks do not publish one.
