# Fixed offline extension preparation

For explicitly selected local collections, see [manual offline Packs](offline-packs.md).
For authenticated local update catalogs, see [signed offline repositories](offline-repositories.md).
The optional Apple silicon macOS desktop bundle carries a fixed Node/Host
runtime and two independent prebuilt packages: WebVTT and SMAPI. Its bundled
runtime requires macOS 13.5 or later. End users of an assembled application do
not need a development Node, Rust, Python, pnpm or Git installation. Preparing
and building that application is a separate developer operation; an empty
machine is not promised an offline source build.

The current selection remains an experimental, undistributed candidate. The
preparation command does not claim a signed release, authenticated network
updates, complete Host/Worker compatibility or a clean-system offline run.

## Inputs and ownership

The application owns
[`bundled-plugins.macos-aarch64.json`](../apps/desktop/src-tauri/bundled-plugins.macos-aarch64.json).
Each entry fixes an independent plugin identity/version, declared public source
repository and commit, complete Host package digest, transport archive name and
SHA-256, and exact SDK artifact/version. The selection also fixes the platform,
runtime profile and SDK process protocol. The build and application setup reject
a different runtime profile/protocol rather than infer compatibility from the
unchanged alpha version.

The current candidates retain source-extraction context facts and their exact
source revision through the pinned SDK helpers. Updating a candidate requires
refreshing its source commit, SDK artifact, transport and complete Host package
digests together; selecting an older archive by the same alpha version can lose
these capabilities.

The public [plugin repository](https://github.com/Anpimi/tsumugi-plugins) owns
package production, recipes, domain dependencies and deterministic uncompressed
candidate `.tar` files. Obtain the reviewed bytes matching this catalog through
your approved artifact supply process. There is currently no published artifact
URL in this catalog, and the preparer performs no network access, source checkout
or dependency compilation. A missing archive is a failure, not permission to
fetch a branch or rebuild a different candidate.

Transport SHA-256 identifies exact archive bytes. `packageDigest` is a different
identity computed by the existing Rust Host over complete package content and
executable flags. Neither digest authenticates a publisher. Declared source
commits and embedded SDK provenance do not independently prove a build's origin.
Application build pins, local approval, installation receipts, project selection
and execution grants retain their respective owners.

## Prepare and build

First prepare the current compiled Host, production dependencies and fixed Node
distribution using the [runtime preparation instructions](../runtimes/javascript-host/README.md#prepare-the-fixed-macos-tool-and-host-artifact).
Use a trusted builder; only the fixed tool files and clean Host runtime are
included from that preparation. Preparation reports and local package-manager caches do
not grant authority or supply runtime dependencies.

Place the two complete, approved archives in one existing directory. Their
filenames must match `archiveName` in the catalog. Build and explicitly review
the `tsumugi-plugin-package` inspector and its SHA-256, then run with Python 3.11
or newer. Also prepare the application's standalone
[Pi member artifact](../runtimes/agent-service/README.md) from the same checkout.
Its frozen dependencies and platform esbuild binary must already be available
offline. Run these commands from the repository root; neither preparer invokes
an installer or fetches runtime dependencies:

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

The resource parent must exist and both output directories must be new. Member
packaging compiles source directly; the frontend build and Cargo build script
do not create or refresh that artifact. Explicitly review previous output or
use a fresh checkout rather than overwriting it. All supplied paths
are absolute and may not traverse symlink ancestors, apart from the fixed macOS
`/tmp` and `/var` OS aliases. Archive files must be ordinary, bounded single-link
files. The preparer captures the actual archive bytes before interpreting them;
only those captured bytes are materialized, never a later replacement path.

Archive transport accepts regular files with canonical portable paths only. It
refuses traversal, aliases, duplicates, overlapping paths, links, sparse/special
members and extra/missing recipe files. Each package has at most 256 files, at
most 16 path components and at most 64 MiB; the whole selected bundle also has a
64 MiB file-content ceiling. SDK lock contents must match the exact selected SDK
artifact and version. The pinned Host inspector independently validates the
actual manifest and complete package digest; a matching transport hash alone is
not sufficient.

All files are prepared beneath a new owner-only staging directory. Only a
captured inspector copy with the reviewed executable hash runs; no plugin,
selected Node, Host component or package script runs. The inspector has bounded
time and output. Its identity, digest, manifest bytes, file count and byte count
must match the selected package. The preparer rechecks captured inputs and the
complete prepared files/executable flags before atomically promoting the entire
set with the platform's no-replace rename operation. Final package directories
are `0755`, ordinary files `0644`, and executable files `0755`; the executable
flags remain identical to the inspected artifact, independent of builder umask.

`preparation.json` inside the output records public selection pins, inspector
hash and package observations without local source paths. The desktop build
captures the actual package/runtime resources again and embeds source-owned
metadata; it never trusts this report as approval. Tauri places complete package,
tool and Host trees at their logical resource paths. The separate member tree
is captured through the same Host artifact owner used at execution; a missing
entrypoint or a protocol different from Core's generated profile fails the
build. It uses only the independently approved Node tool and does not become a
plugin Process channel. The exact Node distribution pin remains owned by the
existing runtime preparation. The current build supports
the selected macOS arm64 builder and target only.

## Failures and existing installations

A corrupt archive, wrong source/identity/SDK artifact, changed input, unexpected
file, invalid Host inspection or missing dependency stops preparation. No old
catalog, embedded parser, development checkout, PATH runtime or source compilation
is used as fallback. A preparation failure leaves the final destination absent
and may retain the new `.tsumugi-plugins-*` staging directory beside it for
review. Existing destinations are refused before reading inputs; even an empty
directory created concurrently cannot be replaced. Remove only an explicitly
reviewed failed attempt, or choose a fresh destination. Never overwrite an
already verified resource set to make a retry succeed. A rare staging cleanup
failure after successful promotion is reported separately; the completed output
remains available for inspection.

In the application, review **Extensions → Use included extensions**. Setup uses
the same capture, revisioned settings and Store installation boundary as manual
packages, preserving existing activation choices. Uncertain results retain the
original request for reconciliation. Installed bytes and local decisions can
remain available after the original acquisition resources disappear. New
execution still requires the actual selected environment, current approval,
supported platform and a separately authorized Core operation. Bundle updates
do not replace an in-flight attempt's captured environment.

Before distributing, verify the final installation/portable artifact, both
packages and the complete runtime on a clean supported system with networking
unavailable and no developer toolchain. Exercise setup, reopen, both domains,
damaged/missing resources, existing decisions and uninstall/update boundaries.
Build preparation and transport tests are narrower evidence than that acceptance.

[简体中文](plugin-distribution.zh-CN.md)
