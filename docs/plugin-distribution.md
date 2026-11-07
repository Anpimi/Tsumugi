# Fixed offline extension preparation

For side-loading local collections of packages, see [manual offline Packs](offline-packs.md); for signed local update catalogs, see [signed offline repositories](offline-repositories.md).

The optional Apple silicon (`aarch64`) macOS desktop bundle includes a pinned Node/Host runtime (requiring macOS 13.5 or later) along with two prebuilt plugins: **WebVTT** and **SMAPI**. End users running the packaged desktop app do not need Node.js, Rust, Python, `pnpm`, or Git installed. The steps below describe how developers stage and build that offline-ready desktop bundle from pre-fetched release artifacts.

The current configuration bundles the unsigned experimental plugin archives built for the [Mac application prerelease](experimental-release.md).

## Platform and build support

This matrix describes current source capabilities and packaging constraints, not a new release or a clean-machine acceptance result. A capability can still be unavailable in a particular build or installation.

| Capability | Apple Silicon macOS 13.5+ | Other desktop targets |
|---|---|---|
| Desktop shell and manual editing of saved content | Existing macOS source path | Windows x64 and Intel Mac source paths; current full-package acceptance not established |
| SMAPI / WebVTT import, checks and export | Pinned packages, approved Node/Host and per-operation consent required | No fixed complete package selected; source compilation alone supplies no format packages |
| Skyrim SE development integration | [Separate package with a matching Native Host](integrations.md#skyrim-se-development-package); local synthetic workflow evidence | Windows desktop processing and actual Skyrim SE loading remain unverified |
| Direct OpenAI-compatible API-key requests | Existing Core transport; macOS Keychain or an explicitly selected environment variable | Transport source exists; no complete-platform acceptance claim |
| Pi members and dynamic teams | Included member artifact plus installed, approved bundled Node; explicit request permission | Windows member execution returns unsupported-platform; no complete Windows Agent package. Intel/Linux complete bundles are not selected |
| ChatGPT subscription sign-in | macOS Keychain implementation; an account and separate request consent are required | Unsupported by the current desktop credential implementation |
| Complete offline application bundle | `tauri.runtime.conf.json`, macOS arm64 builder and target, all resources below | Current bundle configuration rejects other targets |

Saving a connection is not a model compatibility test. Installing resources does not approve an external request. The macOS desktop key-entry and existing environment-variable workflows are documented in [AI translation](ai-translation.md). Keychain availability does not establish provider or complete-platform acceptance.

## First run and offline sample

1. Open the complete app and choose **Settings → Extensions**. **Installed** reports whether the member files match this application's protocol. This read does not execute a plugin, access credentials or call a model.
2. Choose **Review included setup → Discover**, review the included WebVTT/SMAPI packages and runtime, then explicitly approve **Install bundled extensions**. Existing enable/disable choices are retained. If installation is interrupted or its result is unknown, use **Retry original operation**, then refresh the same inventory; do not reinstall unrelated packages.
3. Use the original runtime approval controls in **Installed** if runtime installation or approval is still missing. Missing or incompatible member files require an intact complete app; installing Node alone is insufficient. A source shell without the resources must be rebuilt using the sequence below.
4. Copy the public [first-run sample](../examples/first-run/README.md) to a writable local folder. Create a project, choose WebVTT in **Source content**, select the sample folder, review captured material and separately authorize producer/checker execution, then confirm adoption. Edit and explicitly save a translation; close and reopen the project to check it remains saved. No connection or model request is needed.
5. For export, follow [Build and export](build-release.md) with the same sample; checks, approvals and the final export decision remain separate. This manual sample does not establish model quality, clean-machine support or game compatibility.

## Inputs and ownership

### Desktop catalog (`bundled-plugins.macos-aarch64.json`)

The desktop application tracks its bundled plugins in [`bundled-plugins.macos-aarch64.json`](../apps/desktop/src-tauri/bundled-plugins.macos-aarch64.json). Each entry pins:
- The plugin identity and version
- The public source repository and commit hash
- The full Host `packageDigest`
- The transport `.tar` filename (`archiveName`) and its SHA-256 digest
- The exact SDK artifact and version

The catalog also locks the target platform, runtime profile, and SDK process protocol. Both the build script and the desktop installer verify these exact pins rather than assuming compatibility from matching `0.1.0-alpha.1` version strings.

The application build uses the SDK's supported Process3 versions to check the catalog. A compatible older package keeps its exact SDK artifact, source commit, and package and transport digests.

The pinned WebVTT and SMAPI packages preserve source-extraction context facts and source revisions via the SDK helpers, and the WebVTT package also supports importing existing translated captions from a target-language `.vtt` file (with independent semantic checks and per-entry adoption). When updating a bundled plugin, update its source commit, SDK artifact, transport SHA-256, and `packageDigest` together.

### Plugin release archives

The public [plugin repository](https://github.com/Anpimi/tsumugi-plugins) owns plugin builds, packaging recipes, domain dependencies, and reproducible uncompressed `.tar` archives.

Before running the preparation script, download the matching release archives and place them in a local directory as `webvtt.tar` and `stardew-smapi.tar`:
- [WebVTT (`webvtt/v0.1.0-alpha.1`)](https://github.com/Anpimi/Tsumugi-plugins/releases/tag/webvtt/v0.1.0-alpha.1)
- [SMAPI (`stardew-smapi/v0.1.0-alpha.1`)](https://github.com/Anpimi/Tsumugi-plugins/releases/tag/stardew-smapi/v0.1.0-alpha.1)

Verify their transport SHA-256 checksums against `bundled-plugins.macos-aarch64.json`. The preparation script operates strictly offline—if an archive is missing, it fails immediately rather than fetching source code or building a replacement. Note that the transport SHA-256 covers the `.tar` file bytes, while `packageDigest` is computed by the Rust Host over the unpacked manifest, files, and executable flags.

## Prepare and build

Use a trusted Apple Silicon macOS 13.5+ builder with Rust 1.98+, Node 26.10.x, pnpm 12 and Python 3.11+. Fetch the locked dependencies and the exact archives before working offline. The Node archive is fixed by [`node-distribution.macos-aarch64.json`](../runtimes/javascript-host/scripts/node-distribution.macos-aarch64.json). The plugin archives must match the catalog above. No preparation command downloads a replacement.

From the repository root, first install the frozen dependencies and build the Host. A production deploy must include its compiled `dist` tree:

```sh
pnpm install --frozen-lockfile
pnpm --dir runtimes/javascript-host build
pnpm --filter @tsumugi/javascript-host deploy --prod --ignore-scripts /absolute/new/host-deploy
cargo build --locked --offline -p tsumugi-plugin-host --bin tsumugi-plugin-runtime --bin tsumugi-plugin-package
mkdir -p apps/desktop/src-tauri/resources
node runtimes/javascript-host/scripts/prepare-desktop-runtime.mjs \
  --node-archive /absolute/approved/node-v26.10.0-darwin-arm64.tar.xz \
  --host-source /absolute/new/host-deploy \
  --inspector "$PWD/target/debug/tsumugi-plugin-runtime" \
  --output "$PWD/apps/desktop/src-tauri/resources/javascript-runtime"
```

Use the actual Cargo target directory if `CARGO_TARGET_DIR` is set. Review the locally built package inspector before recording its digest for the existing preparation boundary (`shasum -a 256 <inspector>` on macOS):

```sh
python3 runtimes/javascript-host/scripts/prepare-desktop-plugins.py \
  --artifacts /absolute/approved/plugin-candidates \
  --inspector /absolute/project/target/debug/tsumugi-plugin-package \
  --inspector-sha256 <reviewed-inspector-sha256> \
  --output "$PWD/apps/desktop/src-tauri/resources/bundled-plugins"
pnpm --dir runtimes/agent-service check:contracts
pnpm --dir runtimes/agent-service package:runtime --output "$PWD/apps/desktop/src-tauri/resources/member-runtime"
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json
```

Without an overridden target directory, the output is `target/release/bundle/macos/Tsumugi.app`. Keep the application source commit, the selected catalog, Node pin and member protocol with the candidate record. Ordinary `tauri build` does not select this configuration and is not a complete resource build. A local candidate is not an uploaded, signed or notarized release; advance the frozen prerelease version before a new distribution as described in [versioning](versioning.md).

### How staging and verification work

- **Path and destination rules**: All CLI paths must be absolute and free of symlink ancestors (except macOS `/tmp` and `/var` system aliases). The parent directory `apps/desktop/src-tauri/resources` must exist, while `javascript-runtime`, `bundled-plugins` and `member-runtime` must not exist yet (neither the frontend build nor Cargo's `build.rs` generates `member-runtime`).
- **Archive and package validation**: Each `.tar` input must be a regular, single-link file containing only portable relative file paths—no path traversal, symlinks, hard links, special/sparse files, duplicate paths, or unlisted files. Each package may contain at most 256 files, 16 path segments, and 64 MiB (with a 64 MiB cap across the combined bundle).
- **Isolated inspection and atomic promotion**: `prepare-desktop-plugins.py` copies the input archives and the verified `tsumugi-plugin-package` binary (checked against `--inspector-sha256`) into an owner-only staging directory. It runs only that inspector binary—never plugin code, Node, or package scripts—to verify each package's identity, `packageDigest`, manifest hash, file count, byte count, and `sdk.lock.json` pins. Once verified, it sets deterministic permissions (`0755` for directories and executables, `0644` for regular files, independent of `umask`) and atomically renames the staged directory to `--output` without overwriting existing paths.
- **Desktop packaging**: `preparation.json` records the public catalog pins, inspector hash, and package digests without embedding local filesystem paths. During `tauri build`, the Rust build re-verifies the staged plugin packages, JavaScript runtime, and `member-runtime` tree (ensuring its entrypoint and protocol match Core's generated profile) and bundles them into the macOS `aarch64` application.

## Failures and existing installations

If an archive is corrupted, a digest or SDK lock mismatches, an unexpected file is present, or the output directory already exists, `prepare-desktop-plugins.py` aborts without creating `--output`. When a run fails after staging begins, the temporary `.tsumugi-plugins-*` sibling directory may be left behind so you can inspect the failure; review and delete it before retrying, and never overwrite an already verified output directory in place.

Inside the packaged desktop app, users can install these bundled plugins via **Settings → Extensions → Discover → Install bundled extensions**:
- Setup uses the same PackageStore installation and revisioned settings flow as manually added plugins, keeping any existing enablement choices and in-flight task environments untouched.
- If an installation is interrupted, the pending request is retained so the user can reconcile or retry it, and already installed plugins remain usable even if bundled installation resources are absent in a later build.
- Running a plugin in a project still requires an approved runtime environment and per-operation execution consent.

Before distributing a release build, test the final `.app` / installer bundle on a clean Apple silicon macOS system with network access disabled and no developer tools installed—covering initial setup, app restarts, both WebVTT and SMAPI workflows, missing/corrupted resource handling, and update/uninstall behavior.

[简体中文](plugin-distribution.zh-CN.md)
