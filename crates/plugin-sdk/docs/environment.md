# Experimental captured runtime description

`RuntimeEnvironmentDescriptor` is data, not a runtime loader or an execution
grant. Environment protocol `1` has one profile, `node-system-libraries-v1`.
The current SDK validates its own exact SDK version and process protocol `3`.
Unknown profiles, fields and protocols are refused; omitted fields have no
defaults. This experimental contract has no historical-format decoder.

The descriptor records:

- `platform.operatingSystem`: `macos`, `linux` or `windows`.
- `platform.architecture`: `aarch64` or `x86_64`.
- `protocolVersion`, exact `sdkVersion`, and `processProtocol`.
- The fixed `profile` and SemVer `toolVersion`.
- `tool` and `host`, each with a complete `treeDigest` and logical `entrypoint`.

The tool is an independently approved Node distribution. The Host artifact
contains the compiled bootstrap and every runtime dependency, metadata and
license required by that bootstrap. `bin/node` and `dist/main.js` are example
logical entrypoints, not defaults. The descriptor contains no machine paths,
credentials or inherited permissions. The installer must establish that the
approved tool distribution uses only the supported platform's system libraries;
arbitrary Homebrew/npm installations do not satisfy that premise. The OS and
system-library contents remain outside the captured artifacts.

`validate()` checks this data contract. It does not prove filesystem containment,
dependency closure, tool availability or publisher identity. The capture owner
must independently approve the expected descriptor, read the actual bytes,
reject links, portable aliases and observed replacement, check the platform and
profile, and compare both complete artifact digests. An artifact's entrypoint
must be present, and the tool entrypoint must be executable. Invocation must
retain those immutable bytes rather than reopen a mutable installation.

Windows is a data-contract choice for independently approved captured Node
artifacts. Logical executable flags remain artifact data, including for `.exe`
entrypoints; a filename does not grant execution permission. Host archive
capture validates the exact current platform and both approved artifact digests.
This does not establish a Windows distribution's DLL closure, filesystem capture,
installation or process execution support. The native Host profile below still
accepts only its existing macOS/Linux identity algorithms and rejects Windows.
Older immutable SDK artifacts retain their original supported platform values;
a consumer of this addition must explicitly select and verify a matching newer
SDK artifact. The SDK version label alone is not an artifact identity.

## Artifact digest profile

`runtime_artifact_digest` accepts an ordered map of logical paths to
`RuntimeArtifactFile { bytes, executable }`. It rejects empty trees, more than
2,048 files, more than 256 MiB of contents, and invalid SDK package paths.
These bounds are separate from plugin package limits. The filesystem capture
owner also bounds directory count, depth and observation time.

SHA-256 is calculated from the following bytes, with integers encoded as
unsigned 64-bit big endian:

1. ASCII `tsumugi-runtime-artifact-v1` followed by a zero byte.
2. For each file in ascending path order: path UTF-8 byte length, path bytes,
   one executable byte (`0` or `1`), content byte length, and actual content bytes.

The whole tree participates, including transitive dependency files and licenses.
Hashing only the bootstrap, a lockfile, or the tool's launcher is insufficient.
Directory names participate through file paths; empty directories are not part
of this digest. Artifact and plugin package digests use separate domain tags.

## Environment digest profile

`descriptor.digest()` first validates the descriptor, then computes SHA-256 over:

1. ASCII `tsumugi-runtime-environment-v1` followed by a zero byte.
2. The unsigned 64-bit big endian byte length of the canonical UTF-8 JSON.
3. The canonical UTF-8 JSON bytes.

The SDK serializes its struct with fields ordered as `protocolVersion`,
`platform`, `sdkVersion`, `processProtocol`, `profile`, `toolVersion`, `tool`,
`host`. Platform fields are ordered `operatingSystem`, `architecture`; each
artifact orders `treeDigest`, `entrypoint`. JSON has no whitespace, omitted
fields or map-dependent order. Consumers must decode and validate incoming
descriptors before deriving their canonical digest, rather than hash incoming
JSON text. Changing any fixed platform, tool, Host or profile choice changes the
environment digest.

The SDK's existing invocation context carries this derived `environmentDigest`.
Matching a result to that value proves correlation only. Trusted Host capture,
actual channel evidence, live execution consent, semantic validation and
explicit project adoption remain separate responsibilities. This data module
does not by itself replace a Host's mutable launcher or implement runtime
installation, distribution, sandboxing or trusted updates.

## Native application Host profile

`ExecutionEnvironmentDescriptor` selects either the existing captured Node
descriptor or a strict `NativeHostEnvironmentDescriptor`. They have distinct
`profile` values and field sets; Node serialization and digest rules above are
unchanged. There is no historical decoder or missing-field default.

Native environment protocol 1 uses `native-application-host-v1`, exact SDK and
process versions, platform/architecture, SemVer `hostVersion` and `executable`.
The application Host observes its own executable identity independently of the
worker. The executable is a tagged `{kind, value}`:

- `darwin-code-directory-hash-v1`: the actual process's 20-byte CodeDirectory
  hash, encoded as 40 lowercase hexadecimal characters, on macOS.
- `linux-executable-sha256-v1`: SHA-256 of the complete executable opened through
  the kernel's `/proc/self/exe` handle, encoded as 64 lowercase hexadecimal
  characters, on Linux. The complete nonempty bytes are bounded to 256 MiB.

All-zero identities, wrong algorithm/platform pairs, unknown or duplicate
fields and unsupported versions are refused. `native_host_executable_sha256`
only hashes data; stable OS-handle capture remains the Host's responsibility.
No tool/Node/bootstrap artifacts, mutable executable pathname, claimed worker
identity, approval flag or caller-supplied environment digest belongs here.
The separate provider still fixes the entire plugin package and native entrypoint.

The native descriptor digest is SHA-256 of ASCII
`tsumugi-native-host-environment-v1`, a zero byte, the unsigned 64-bit big-endian
canonical JSON byte length, then its UTF-8 bytes. The exact struct field order is
`protocolVersion`, `platform`, `sdkVersion`, `processProtocol`, `profile`,
`hostVersion`, `executable`. Platform orders `operatingSystem`, `architecture`;
executable orders `kind`, `value`. There is no JSON whitespace. Consumers decode,
validate and derive the canonical digest rather than hashing incoming JSON text.

This observation identifies the application Host, not its publisher. It captures
neither OS/dynamic-library contents nor an OS sandbox. Independent approval,
package capture, exact current consent, real channel provenance, semantic checks
and explicit adoption remain separate responsibilities.
