# Experimental plugin authoring

This guide walks through building, inspecting, and loading a Tsumugi plugin package using two complete reference implementations: a Rust flat-JSON catalog plugin and a JavaScript WebVTT subtitle plugin.

> **Experimental status**: `tsumugi-plugin-sdk` is currently at `0.1.0-alpha.1` and is not yet published to crates.io. Because multiple development snapshots may share the `0.1.0-alpha.1` version string while evolving their contracts, always pair your plugin checkout with the exact matching Tsumugi SDK artifact, Host binary, and runtime environment.

## Obtain a complete matching snapshot

Tsumugi plugin development spans two public repositories:
- **[Tsumugi](https://github.com/Anpimi/Tsumugi)**: Owns the Plugin SDK, generated JSON Schemas, contract validation CLI, and process Host.
- **[tsumugi-plugins](https://github.com/Anpimi/tsumugi-plugins)**: Owns domain plugin implementations, standalone tests, and packaging scripts. Plugins depend only on the SDK contracts and never import Tsumugi Core, the desktop app, or project databases directly.

Make sure you have a matching pair of source checkouts:
- Your `tsumugi-plugins` checkout must include `sdk.lock.json`, the pinned SDK archive under `artifacts/sdk/<producer-commit>/...crate`, `tooling/prepare-sdk.py`, `examples/flat-json/`, and `plugins/webvtt/`. Bundling the `.crate` archive lets you build and test plugins without needing a second checkout or fetching the producer commit over the network.
- Your `Tsumugi` checkout must include `crates/plugin-sdk/` and `crates/plugin-host/`.

Set these shell variables to point to your local checkouts for the commands in this guide:

```sh
TSUMUGI_SOURCE=/absolute/path/to/matching/Tsumugi
PLUGIN_SOURCE=/absolute/path/to/matching/tsumugi-plugins
```

### Toolchain and platform requirements

- **Rust and packaging tools**: Rust 1.98+ and Python 3.11+.
- **JavaScript plugins and Host**: Node.js `>=26.10.0 <27`. Building the JavaScript Host or desktop app also requires the repository's pinned `pnpm` `12.8.1` (see the [application development prerequisites](../README.md#development)).
- **Offline builds**: Cargo's `--offline` flag works once dependencies are cached locally, so fetch dependencies ahead of time if you plan to build without network access.
- **Operating systems**: Packaging and directory inspection rely on Unix filesystem semantics (macOS and Linux). Process execution is currently supported on macOS (Windows execution is disabled pending process-tree cleanup support, and Linux execution is not yet verified). Native Rust workers must be compiled for the target OS and CPU architecture. The bundled JavaScript runtime currently requires Apple silicon (`aarch64`) running macOS 13.5 or later.

## Consume the pinned SDK

In the plugin repository, unpack and verify the pinned SDK archive:

```sh
cd "$PLUGIN_SOURCE"
python3 tooling/prepare-sdk.py
cargo test --locked -p tsumugi-sdk-probe
cargo run --locked -p tsumugi-sdk-probe -- plugins/webvtt/manifest.json
```

`prepare-sdk.py` checks the `.crate` archive referenced in `sdk.lock.json` against its SHA-256 digest, extracts it into `.cache/sdk/tsumugi-plugin-sdk-0.1.0-alpha.1/`, and stages the JavaScript SDK helpers, printing:

```text
Prepared tsumugi-plugin-sdk-0.1.0-alpha.1 from the verified SDK artifact
```

The `tsumugi-sdk-probe` crate compiles against that extracted SDK; its test suite checks the public data contracts against synthetic inputs, and running it against `plugins/webvtt/manifest.json` prints the validated `org.tsumugi / webvtt @ 0.1.0-alpha.1` identity along with component and contribution counts.

Keep `sdk.lock.json` (`archive`, `sha256`, `sourceRepository`, `sourceCommit`, license, and publication fields), dependency lockfiles, and the `.crate` artifact committed together. For details on updating the SDK archive, see the plugin repository's [SDK provenance documentation](https://github.com/Anpimi/tsumugi-plugins/tree/main/artifacts/sdk). Never hand-edit files inside `.cache/sdk/` or generated validators—`prepare-sdk.py` verifies existing cache contents on each run and fails if any file was modified. If you need to replace a dirty cache, move or delete the old `.cache/sdk/tsumugi-plugin-sdk-0.1.0-alpha.1/` directory first.

## Choose an implementation

Every plugin package has a `manifest.json` declaring its identity, components, contributions, permissions, and resource limits:
- **Components** manage activation, lifecycle scope, and cleanup.
- **Callable contributions** declare their contract ID, input/output/error schemas, supported profiles, and project side-effect class.
- **Resources and Skills** can be purely declarative JSON files that Tsumugi reads without spawning a worker process.

See the [declaration contract](../crates/plugin-sdk/docs/declarations.md) for the full specification. When authoring your own plugin, use your own namespaced publisher, plugin, and contribution IDs, while keeping standard contract and profile IDs intact so Tsumugi workbenches can discover your capabilities. Source import, translation import, review, and build each use their own dedicated SDK declarations and semantic checks.

### Rust: the flat JSON catalog

The Rust example (`examples/flat-json/README.md` and `examples/flat-json/src/definition.rs`) defines its manifest and Source, Translation, Review, and Build Resources from a single typed Rust definition. Its worker binary implements `NativeComponent` via the SDK's `native-worker` feature, which handles frame encoding, request/response correlation, cancellation, and disposal for you (see the [native component guide](../crates/plugin-sdk/docs/native-worker.md)).

To test, build, and package the Rust plugin:

```sh
cd "$PLUGIN_SOURCE"
cargo test --locked -p tsumugi-flat-json-example
cargo build --locked -p tsumugi-flat-json-example --bin flat-json-worker
mkdir -p .generated artifacts/candidates
target/debug/flat-json-worker --metadata > .generated/flat-json-metadata.json
python3 tooling/package-flat-json.py .generated/flat-json-metadata.json \
  target/debug/flat-json-worker artifacts/candidates/flat-json
```

How this build works:
- Running `flat-json-worker --metadata` executes the binary in metadata emission mode to output the generated manifest and Resource JSON files. (Invoking `flat-json-worker` without `--metadata` starts the framed Host protocol listener rather than a standalone CLI converter. If you override `CARGO_TARGET_DIR`, adjust the binary path accordingly.)
- `package-flat-json.py` assembles the metadata files, compiled binary, `sdk.lock.json`, and license files into a fresh `artifacts/candidates/flat-json` directory without executing any code. The script refuses to overwrite an existing output directory—if a previous packaging run failed, inspect and remove the old directory or choose a new target path. For distributable builds, configure Rust path remapping (`--remap-path-prefix`) so local checkout paths are not embedded in the binary.

The `flat-json` plugin reads a flat JSON object of string key-value pairs from `source.json`, preserving Unicode keys and `{name}` brace placeholders, and includes existing-translation import and independent semantic checks. (Formatting whitespace in the original JSON is not preserved on build; see `examples/flat-json/README.md` for details.)

### JavaScript: the WebVTT component

The JavaScript example (`plugins/webvtt/`) is an ES module (`.mjs`) plugin with zero third-party runtime dependencies and no transpilation step. Key files include `manifest.json`, `components/component.mjs`, `components/webvtt.mjs`, `package-files.json`, and `docs/contracts.md`.

To prepare the SDK helpers, run the Node unit tests, and package the plugin:

```sh
cd "$PLUGIN_SOURCE"
python3 tooling/prepare-sdk.py
node --test plugins/webvtt/tests/*.test.mjs
mkdir -p artifacts/candidates
python3 tooling/package-plugin.py plugins/webvtt artifacts/candidates/webvtt
```

`package-plugin.py` copies the files listed in `package-files.json`, the generated SDK helper modules, `sdk.lock.json`, and license files into `artifacts/candidates/webvtt` (which must not already exist).

Key implementation details for JavaScript components:
- **Activation and registration**: Export a component object with `activate(api)`. During `activate`, iterate over `api.contributions` (the Host's frozen capability roster for that component; `api.instance` holds the component principal) and register a handler for every assigned contribution via `api.register(contribution.id, handler)`. Missing, duplicate, unknown, or post-activation registrations cause activation to fail; the legacy single-contribution `api.contribution` / `register(handler)` API is no longer supported.
- **Handler contract**: Each handler receives the captured `EncodedPayload` and invocation metadata (provider, profile, and cancellation signal) and returns `{ kind: 'succeeded' | 'failed' | 'unknown', utf8 }` formatted according to the declared output or error schema. Register cleanup hooks with `api.onDispose` and respect cancellation signals. Unhandled exceptions terminate the worker channel rather than returning a domain error.
- **Validation and domain checks**: Use the SDK's strict receiver at the boundary (plain `JSON.parse` does not reject duplicate object keys) alongside generated structural validators and domain checks. WebVTT supports a bounded plain-caption profile, preserves non-payload file segments during builds, and can import existing translated cues from `translations/<canonical-locale>.vtt` when matched by cue ID and verified by an independent semantic check (see [translation import](translation-import.md)).
- **Using host services**: For an example of a JavaScript component that calls back into an application service, see the [Philosophy Generation client](https://github.com/Anpimi/tsumugi-plugins/blob/main/examples/philosophy/README.md#generation-service-client), which pairs an independent knowledge query/check component with an Attempt-scoped client for the [original work-plan generation service](work-plans.md).

## Check contracts without running a plugin

You can validate manifests, resource declarations, and schemas statically using the `tsumugi-plugin-contract` CLI in the Tsumugi repository:

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

- `validate` and `validate-*` parse the input through the SDK's strict typed receivers—rejecting unknown or duplicate fields, unsupported protocols, missing component owners, duplicate IDs, undeclared permissions, invalid bounds, and unsafe relative paths that plain JSON Schema cannot catch—and print the normalized JSON on success.
- `check-schema` verifies that committed JSON Schema files match the Rust SDK definitions (`Schema is current.`).
- `profile-process` prints the active process protocol version and frame bounds.

The CLI also includes payload exchange utilities (`validate-exchange`, `match-result <request> <result> <channel-binding>`, and `check-coverage <captured-set> <results>`); see the [SDK README](../crates/plugin-sdk/README.md) or run `tsumugi-plugin-contract` with no arguments for usage details. Note that a complete `check-coverage` result only confirms that every item was checked—blocking error findings in a check report will still prevent adoption.

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

All files under `crates/plugin-sdk/schemas/` and the JavaScript SDK helpers are generated from the Rust SDK source. Always update the Rust definitions and regenerate rather than editing generated files by hand.

## Inspect the complete prebuilt package

Before loading or testing a prebuilt package directory, inspect it with `tsumugi-plugin-package`:

```sh
cd "$TSUMUGI_SOURCE"
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- \
  inspect "$PLUGIN_SOURCE/artifacts/candidates/flat-json"
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- \
  inspect "$PLUGIN_SOURCE/artifacts/candidates/webvtt"
```

The command outputs a JSON summary with `plugin`, `packageDigest`, `manifestSha256`, `fileCount`, and `byteCount` (counts include `manifest.json`). `packageDigest` hashes the complete manifest, relative file paths, file contents, and executable permissions—it differs from both `manifestSha256` and any outer `.tar` or `.zip` checksum.

The inspector uses the same directory reader as the Host loader: it validates the manifest and required files, rejects symlinks, hard links, special files, path aliases, concurrent modifications, and oversized trees, and never executes plugin code. Package directories are limited to `manifest.json` plus at most 256 additional files, 64 MiB total size, a maximum directory depth of 16, and a 10-second read timeout (the example packaging scripts enforce a slightly stricter 256-file ceiling including `manifest.json`). For details on directory capture semantics, see the [Host guide](../crates/plugin-host/README.md#captured-package-and-actual-channel). Whenever you change plugin source files, repackage into a fresh directory and re-run `inspect`.

## Load a development package explicitly

Tsumugi loads prebuilt package directories through the **Extensions** panel; it does not watch source directories or compile plugins on the fly. When testing in development, use a disposable project created with the current project schema and synthetic sample data.

1. **Select the package folder**: Open **Extensions → Choose plugin folder** and pick your prebuilt output directory (such as `artifacts/candidates/webvtt`). Verify that the displayed publisher, version, runtime, permissions, file/byte counts, and `packageDigest` match your `inspect` output.
2. **Approve and install**: Check the local trust acknowledgment and click **Approve and install**. The package is copied into the store in a disabled state without running any install scripts or workers.
3. **Enable the plugin**: Under **Installed packages**, click **Enable** to make its capabilities selectable in project workbenches. You can click **Inspect approved package** at any time to view the installed declaration.
4. **Approve an execution environment**:
   - For **Rust (native)** plugins: Review **Native application environment**, verify its identity, check the confirmation box, and click **Approve application Host**.
   - For **JavaScript** plugins: Review the bundled **JavaScript runtime**, platform requirements, and fingerprint, then click **Approve and install runtime** (use **Verify installed environment** to re-check its bytes on disk). Tsumugi only uses its supported, application-provided Node runtime—it will not fall back to a `node` binary on your system `PATH`. To build a desktop bundle with the JavaScript runtime included, follow the [JavaScript Host build and fixed runtime preparation](../runtimes/javascript-host/README.md) guide.
5. **Run in a workbench**: Open your project workbench, select the plugin's Resource and the approved environment, capture your input files, and confirm execution for each step.

### Try a sample import

Create a temporary directory containing either `source.json` with `{"greeting":"Hello {name}"}` (for the Rust plugin) or `source.vtt` (for the WebVTT plugin):

```vtt
WEBVTT

greeting
00:00:00.000 --> 00:00:01.000
Hello
```

In your project:
1. Confirm the project source language and select **Choose source folder → Check source files** to capture a read-only snapshot of the input files.
2. Click **Import for preview** and consent to run the extractor.
3. Review the extracted entries, run the independent source checker (which requires its own execution consent), and apply the verified snapshot to adopt the source entries into your project without modifying the external files on disk.

For subsequent workflow stages, see [source import](source-import.md), [translation import](translation-import.md), [review and QA](review-qa.md), and [build/export](build-release.md). For bulk or signed local distribution, see [offline Packs](offline-packs.md) and [signed offline repositories](offline-repositories.md).

### Security and lifecycle notes

- **No OS sandbox**: Plugin workers run as child processes under your current OS user account and have normal user-level access to the filesystem, network, and OS APIs. Always review code before approving it, and keep sensitive projects or credentials out of test environments.
- **Disabling and uninstalling**: Clicking **Disable** prevents new selections while keeping the package installed. To uninstall, first click **Revoke approval** (which blocks new tasks and requests cancellation of running work) and wait for cleanup to complete. Uninstalling a plugin does not roll back already adopted project data or exported files.

## Exercise the existing real-process pairings

The Tsumugi repository includes opt-in integration tests that spawn real plugin worker processes against synthetic fixtures. Run `tsumugi-plugin-package inspect` first and pass the verified `packageDigest` via environment variables.

### Native (Rust) integration test

```sh
cd "$TSUMUGI_SOURCE"
TSUMUGI_TEST_NATIVE_PACKAGE="$PLUGIN_SOURCE/artifacts/candidates/flat-json" \
TSUMUGI_TEST_NATIVE_DIGEST='<reviewed-packageDigest>' \
cargo test --locked -p tsumugi-plugin-host --features core-adapter \
  --test native_catalog -- --ignored --nocapture --test-threads=1
```

This test installs the package into a temporary store, captures the Native Host, and exercises source extraction, checking, review, build, artifact verification, and Core adoption.

### JavaScript integration test

First prepare and approve the Node runtime tool tree, clean Host tree, and environment descriptor using the [existing runtime preparation workflow](../runtimes/javascript-host/README.md#prepare-the-fixed-macos-tool-and-host-artifact), then run:

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

The `official` test suite verifies source extraction, source checking, build, and artifact checking over real Node worker processes. Verify in the test output that the test cases actually executed and passed (none skipped or filtered out).

For end-to-end Core adoption checks across both WebVTT and SMAPI packages in an isolated consumer workspace, see the [prebuilt-package compatibility runner](../crates/plugin-host/scripts/README.md).

## Diagnose the failing boundary

When reporting or debugging an error, note the exact stage and error identifier:
- **SDK CLI errors** report the validation failure and path (for example, `InvalidSchema at manifest`).
- **Host inspector errors** report a `HostError` variant (for example, `PackagePath`).
- **Desktop errors** include a diagnostic reference, error code, stage, outcome, and suggested recovery action.

| Failure | What to check and how to continue |
|---|---|
| SDK archive digest mismatch or cache differs from selected artifact | Verify `sdk.lock.json` and the tracked `.crate` file. Move or delete the modified `.cache/sdk/` directory and re-run `prepare-sdk.py` rather than editing cached files in place. |
| `InvalidSchema`, `UnsupportedProtocol`, `MissingOwner`, `UndeclaredPermission` | Run `tsumugi-plugin-contract validate` on the JSON file and fix the field types, component references, or permission declarations. |
| `IncompatibleContract` or ambiguous provider selection | Run the [explicit package diagnostic](capability-compatibility.md) (`tsumugi-plugin-package diagnose`) to compare `(id, schemaVersion, behaviorVersion)` for both the contract and profile, and select the matching provider explicitly. |
| `PackagePath`, `MissingArtifact`, `PackageLimit`, `InvalidContract` | Check the package directory contents and `package-files.json` recipe. Ensure all entrypoints, Resources, SDK helpers, and licenses are ordinary portable files within size/count limits, then repackage to a new directory. |
| `PackageChanged` or `PackageMismatch` | Ensure nothing modifies the package directory while it is being read. Repackage into a clean directory and re-run `inspect` to get the current `packageDigest`. |
| `plugin-selection-expired` or `plugin-candidate-changed` | Re-select the package folder in **Extensions** and verify its current fingerprint before approving. |
| `plugin-approval-mismatch`, unavailable capability or `RuntimeMismatch` | Refresh extension state and verify that the package is installed, approved, and enabled, and that the matching Native Host or JavaScript runtime is approved. |
| No bundled runtime, unsupported platform or unavailable Native Host identity | Use a desktop build and platform that include the required runtime environment; a system `node` binary on `PATH` cannot substitute for the bundled runtime. |
| `HandshakeMismatch`, `InvalidFrame`, `RequestMismatch`, `ResultMismatch` | Check that the plugin, Host, and runtime were built from matching SDK snapshots (Process protocol 3), that `activate` registers every assigned contribution, and that workers write only protocol frames to `stdout` (use `stderr` for logs). |
| `DependencyUnavailable` | Verify that any required service declared by the component is supported and permitted in the target scope by the Host broker. |
| `Timeout`, `Cancelled`, `AuthorityRevoked`, `Closed` or `OutputLimit` | Check the declared and Host execution limits, ensure your worker handles cancellation signals and `onDispose` cleanup, and start a fresh attempt if the previous grant expired. |
| Domain error or blocking check findings | Inspect the domain error or check report and fix the input file or plugin logic. Passing execution and coverage checks does not bypass blocking semantic findings. |
| `stale-revision` or changed settings | Click **Read current state** to refresh the UI without losing unsaved text, then review the updated package and runtime settings. |
| `plugin-operation-pending`, recovery required or outcome unknown | Click **Read current state** and **Retry original operation** (or use the workbench's reconciliation control) to resolve the pending request rather than starting a duplicate install or manually deleting store files. |

## Compatibility and support boundary

Tsumugi tracks several distinct version and identity boundaries:

| Identity | Current meaning |
|---|---|
| SDK package SemVer and archive SHA-256/provenance | Identifies the exact experimental SDK snapshot (`0.1.0-alpha.1` plus archive hash and producer commit). |
| Manifest and content-exchange envelope protocols | Independently versioned SDK data formats (currently protocol `1`). |
| Capability, payload schema and profile references | Matched by exact `(id, schemaVersion, behaviorVersion)` tuple with no implicit range matching or fallback. |
| Process protocol | Currently version `3` with a frozen per-component capability roster. Process protocol `1` and `2` workers and runtime descriptors are rejected. |
| Package identity and `packageDigest` | Declared plugin metadata plus the digest of all packaged files and executable permissions, independent of installation origin. |
| Runtime descriptor/digest and platform | The approved Node/Host directory trees or Native application Host binary, managed separately from plugin packages. |
| Project storage and installation formats | Owned by Tsumugi Core and PackageStore; updating the SDK does not automatically migrate older development project databases. |

Scope and runtime constraints:
- **Project and Attempt scopes**: Bind a single callable capability per channel. The Rust `native-worker` facade supports a single callable capability with no host service calls.
- **Shared Application scope**: Supports read-only Tool components (either a JavaScript component whose callables are all read-only, or a single-callable native worker) with no required service dependencies or `ProjectService` permissions. Running an Application-scoped tool requires both lifetime consent and per-project query consent, and the worker process remains in memory across projects until stopped. See the [Host's Application profile](../crates/plugin-host/README.md#application-tool-lifetime) and [desktop tool guide](plugin-tools.md) before using Application scope.
- **Consumer support**: Declaring UI slots, services, Skills, or IDE concepts in a manifest only takes effect where Tsumugi implements a corresponding consumer. When preparing a plugin release, follow the [versioning policy](versioning.md) and maintain your plugin's own version and changelog.
