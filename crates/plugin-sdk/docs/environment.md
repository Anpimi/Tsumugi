# Runtime Environment Descriptors

`ExecutionEnvironmentDescriptor` describes the verified runtime environment used to execute a plugin component under environment protocol `1` and process protocol `3`. It supports two distinct profiles:

- `node-system-libraries-v1` (`RuntimeEnvironmentDescriptor`) for JavaScript components running on an approved Node.js distribution and JavaScript Host tree.
- `native-application-host-v1` (`NativeHostEnvironmentDescriptor`) for native Rust components launched directly by the application Host.

Parsers reject unknown profiles, unknown or duplicate JSON fields, missing fields, and unsupported protocol or SDK versions.

## Node Runtime Profile (`node-system-libraries-v1`)

`RuntimeEnvironmentDescriptor` records:

- `platform.operatingSystem`: `macos`, `linux`, or `windows`.
- `platform.architecture`: `aarch64` or `x86_64`.
- `protocolVersion` (`1`), exact `sdkVersion`, and `processProtocol` (`3`).
- `profile`: `"node-system-libraries-v1"` and SemVer `toolVersion`.
- `tool` and `host`: each containing a full `treeDigest` and logical relative `entrypoint` (such as `bin/node` and `dist/main.js`).

The `tool` tree is a standalone Node distribution linked only against the target operating system's standard system libraries, and the `host` tree contains the compiled JavaScript Host bootstrap alongside its bundled runtime dependencies and license notices. Logical executable flags (including on `.exe` files for `windows`) are recorded as artifact metadata.

When staging a runtime, the Host independently verifies the platform and profile, rejects symlinks and case-aliasing collisions, confirms that the tool entrypoint is marked executable, and recomputes both complete tree digests against the approved descriptor before launching a worker.

### Artifact Digest Calculation (`runtime_artifact_digest`)

`runtime_artifact_digest` takes an ordered map of logical relative paths to `RuntimeArtifactFile { bytes, executable }`. It rejects empty file trees, trees exceeding 2,048 files or 256 MiB of aggregate content, and invalid package-relative paths. Every file in the directory tree—including transitive dependencies and licenses—participates in the hash; empty directories are omitted.

The SHA-256 digest is computed over the following byte stream (all integers are unsigned 64-bit big-endian):

1. The ASCII domain tag `tsumugi-runtime-artifact-v1` followed by a `0x00` byte.
2. For each file in ascending lexicographical path order:
   - Path UTF-8 byte length (`u64`) and path UTF-8 bytes.
   - Executable flag byte (`0` or `1`).
   - Content byte length (`u64`) and raw content bytes.

### Node Environment Digest (`descriptor.digest()`)

`descriptor.digest()` validates the `RuntimeEnvironmentDescriptor` and computes SHA-256 over:

1. The ASCII domain tag `tsumugi-runtime-environment-v1` followed by a `0x00` byte.
2. The unsigned 64-bit big-endian byte length of the canonical UTF-8 JSON.
3. The canonical UTF-8 JSON bytes (no whitespace, with top-level keys ordered as `protocolVersion`, `platform`, `sdkVersion`, `processProtocol`, `profile`, `toolVersion`, `tool`, `host`; `platform` ordered as `operatingSystem`, `architecture`; and each artifact ordered as `treeDigest`, `entrypoint`).

Consumers always parse and validate incoming JSON before computing the canonical digest rather than hashing raw wire text. The resulting `environmentDigest` is carried in `InvocationRequest` contexts to correlate responses with the exact runtime configuration.

## Native Application Host Profile (`native-application-host-v1`)

For native worker components, `NativeHostEnvironmentDescriptor` records the identity of the parent Host executable rather than Node and JavaScript Host trees. It supports `macos` and `linux` (`windows` is rejected for this profile) and contains:

- `protocolVersion` (`1`), `platform` (`operatingSystem`, `architecture`), exact `sdkVersion`, and `processProtocol` (`3`).
- `profile`: `"native-application-host-v1"` and SemVer `hostVersion`.
- `executable`: a tagged `{ kind, value }` pair observed from the running Host process:
  - `darwin-code-directory-hash-v1` (macOS): the process's 20-byte Mach-O CodeDirectory hash as 40 lowercase hex characters.
  - `linux-executable-sha256-v1` (Linux): the SHA-256 digest (via `native_host_executable_sha256`) of the complete executable read from `/proc/self/exe` (nonempty, up to 256 MiB) as 64 lowercase hex characters.

All-zero hashes and mismatched OS/algorithm pairs are rejected. The native worker binary itself is hashed separately as part of the plugin's `PackageImage` and `ProviderBinding`.

### Native Environment Digest

The canonical digest for `NativeHostEnvironmentDescriptor` is the SHA-256 of:

1. The ASCII domain tag `tsumugi-native-host-environment-v1` followed by a `0x00` byte.
2. The unsigned 64-bit big-endian byte length of the canonical UTF-8 JSON.
3. The canonical UTF-8 JSON bytes (no whitespace, with keys ordered as `protocolVersion`, `platform`, `sdkVersion`, `processProtocol`, `profile`, `hostVersion`, `executable`; `platform` ordered as `operatingSystem`, `architecture`; and `executable` ordered as `kind`, `value`).
