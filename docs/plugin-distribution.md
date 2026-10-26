# Fixed offline extension preparation

For side-loading local collections of packages, see [manual offline Packs](offline-packs.md); for signed local update catalogs, see [signed offline repositories](offline-repositories.md).

The optional Apple silicon (`aarch64`) macOS desktop bundle includes a pinned Node/Host runtime (requiring macOS 13.5 or later) along with two prebuilt plugins: **WebVTT** and **SMAPI**. End users running the packaged desktop app do not need Node.js, Rust, Python, `pnpm`, or Git installed. The steps below describe how developers stage and build that offline-ready desktop bundle from pre-fetched release artifacts.

The current configuration bundles the unsigned experimental plugin archives built for the [Mac application prerelease](experimental-release.md).

## Inputs and ownership

### Desktop catalog (`bundled-plugins.macos-aarch64.json`)

The desktop application tracks its bundled plugins in [`bundled-plugins.macos-aarch64.json`](../apps/desktop/src-tauri/bundled-plugins.macos-aarch64.json). Each entry pins:
- The plugin identity and version
- The public source repository and commit hash
- The full Host `packageDigest`
- The transport `.tar` filename (`archiveName`) and its SHA-256 digest
- The exact SDK artifact and version

The catalog also locks the target platform, runtime profile, and SDK process protocol. Both the build script and the desktop installer verify these exact pins rather than assuming compatibility from matching `0.1.0-alpha.1` version strings.

The pinned WebVTT and SMAPI packages preserve source-extraction context facts and source revisions via the SDK helpers, and the WebVTT package also supports importing existing translated captions from a target-language `.vtt` file (with independent semantic checks and per-entry adoption). When updating a bundled plugin, update its source commit, SDK artifact, transport SHA-256, and `packageDigest` together.

### Plugin release archives

The public [plugin repository](https://github.com/Anpimi/tsumugi-plugins) owns plugin builds, packaging recipes, domain dependencies, and reproducible uncompressed `.tar` archives.

Before running the preparation script, download the matching release archives and place them in a local directory as `webvtt.tar` and `stardew-smapi.tar`:
- [WebVTT (`webvtt/v0.1.0-alpha.1`)](https://github.com/Anpimi/Tsumugi-plugins/releases/tag/webvtt/v0.1.0-alpha.1)
- [SMAPI (`stardew-smapi/v0.1.0-alpha.1`)](https://github.com/Anpimi/Tsumugi-plugins/releases/tag/stardew-smapi/v0.1.0-alpha.1)

Verify their transport SHA-256 checksums against `bundled-plugins.macos-aarch64.json`. The preparation script operates strictly offline—if an archive is missing, it fails immediately rather than fetching source code or building a replacement. Note that the transport SHA-256 covers the `.tar` file bytes, while `packageDigest` is computed by the Rust Host over the unpacked manifest, files, and executable flags.

## Prepare and build

1. **Prepare the JavaScript Host and Node runtime**: Follow the [runtime preparation instructions](../runtimes/javascript-host/README.md#prepare-the-fixed-macos-tool-and-host-artifact) on a trusted build machine to stage the compiled Host, production dependencies, and pinned Node distribution.
2. **Stage the plugin archives**: Place `webvtt.tar` and `stardew-smapi.tar` (matching `archiveName` in the catalog) into an existing local directory.
3. **Build the Host inspector and stage bundled resources**: Ensure Python 3.11+, Cargo's offline cache, and the [Pi member artifact](../runtimes/agent-service/README.md) dependencies (including the platform `esbuild` binary) are available locally, then run from the repository root:

```sh
cargo build --locked --offline -p tsumugi-plugin-host --bin tsumugi-plugin-package
python3 runtimes/javascript-host/scripts/prepare-desktop-plugins.py \
  --artifacts /absolute/approved/plugin-candidates \
  --inspector /absolute/project/target/debug/tsumugi-plugin-package \
  --inspector-sha256 <reviewed-inspector-sha256> \
  --output /absolute/project/apps/desktop/src-tauri/resources/bundled-plugins
pnpm --dir runtimes/agent-service check:contracts
pnpm --dir runtimes/agent-service package:runtime --output "$PWD/apps/desktop/src-tauri/resources/member-runtime"
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json
```

### How staging and verification work

- **Path and destination rules**: All CLI paths must be absolute and free of symlink ancestors (except macOS `/tmp` and `/var` system aliases). The parent directory `apps/desktop/src-tauri/resources` must exist, while both `bundled-plugins` and `member-runtime` must not exist yet (neither the frontend build nor Cargo's `build.rs` generates `member-runtime`).
- **Archive and package validation**: Each `.tar` input must be a regular, single-link file containing only portable relative file paths—no path traversal, symlinks, hard links, special/sparse files, duplicate paths, or unlisted files. Each package may contain at most 256 files, 16 path segments, and 64 MiB (with a 64 MiB cap across the combined bundle).
- **Isolated inspection and atomic promotion**: `prepare-desktop-plugins.py` copies the input archives and the verified `tsumugi-plugin-package` binary (checked against `--inspector-sha256`) into an owner-only staging directory. It runs only that inspector binary—never plugin code, Node, or package scripts—to verify each package's identity, `packageDigest`, manifest hash, file count, byte count, and `sdk.lock.json` pins. Once verified, it sets deterministic permissions (`0755` for directories and executables, `0644` for regular files, independent of `umask`) and atomically renames the staged directory to `--output` without overwriting existing paths.
- **Desktop packaging**: `preparation.json` records the public catalog pins, inspector hash, and package digests without embedding local filesystem paths. During `tauri build`, the Rust build re-verifies the staged plugin packages, JavaScript runtime, and `member-runtime` tree (ensuring its entrypoint and protocol match Core's generated profile) and bundles them into the macOS `aarch64` application.

## Failures and existing installations

If an archive is corrupted, a digest or SDK lock mismatches, an unexpected file is present, or the output directory already exists, `prepare-desktop-plugins.py` aborts without creating `--output`. When a run fails after staging begins, the temporary `.tsumugi-plugins-*` sibling directory may be left behind so you can inspect the failure; review and delete it before retrying, and never overwrite an already verified output directory in place.

Inside the packaged desktop app, users can install these bundled plugins via **Extensions → Use included extensions**:
- Setup uses the same PackageStore installation and revisioned settings flow as manually added plugins, keeping any existing enablement choices and in-flight task environments untouched.
- If an installation is interrupted, the pending request is retained so the user can reconcile or retry it, and already installed plugins remain usable even if bundled installation resources are absent in a later build.
- Running a plugin in a project still requires an approved runtime environment and per-operation execution consent.

Before distributing a release build, test the final `.app` / installer bundle on a clean Apple silicon macOS system with network access disabled and no developer tools installed—covering initial setup, app restarts, both WebVTT and SMAPI workflows, missing/corrupted resource handling, and update/uninstall behavior.

[简体中文](plugin-distribution.zh-CN.md)
