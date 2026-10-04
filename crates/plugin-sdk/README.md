# Experimental plugin SDK

`tsumugi-plugin-sdk` is a data-only Rust library and conformance harness. Its
current package version is `0.1.0-alpha.1`; declaration and exchange protocols `1` are separate
versions. It has no dependency on Core, SQLite, the desktop application or Cordis.
It does not start code, install packages or grant permissions.

See [the declaration contract](docs/declarations.md) for fields,
compatibility and host responsibilities, and [content exchange](docs/exchange.md)
for invocation, fidelity, text offsets and check coverage. The manifest fixtures in
[`tests/fixtures`](tests/fixtures) are synthetic declarations, not executable
plugin packages. Their `example.*` schemas and capabilities are fixture names;
the harness does not claim they are implemented domain APIs.

From the repository root:

```sh
cargo test -p tsumugi-plugin-sdk --features schema --locked
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema > crates/plugin-sdk/schemas/plugin-manifest.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-schema crates/plugin-sdk/schemas/plugin-manifest.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate crates/plugin-sdk/tests/fixtures/smapi.manifest.json
```

Exchange harness examples:

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-exchange > crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-exchange-schema crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-exchange crates/plugin-sdk/tests/fixtures/webvtt.content.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- match-result crates/plugin-sdk/tests/fixtures/invocation.request.json crates/plugin-sdk/tests/fixtures/invocation.result.json crates/plugin-sdk/tests/fixtures/invocation.channel.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-coverage crates/plugin-sdk/tests/fixtures/checks.set.json crates/plugin-sdk/tests/fixtures/checks.results.json
```

The schemas are generated from the Rust/Serde source. The CLI `validate` command
also checks owner references, duplicate identities, SemVer syntax, requested
permissions, bounds and package-relative paths. Structural JSON Schema validation
alone cannot prove those relationships or runtime authorization.

The crate has its own experimental version and can be packaged independently.
It has not been published. Plugin authors may use an explicitly pinned development
SDK snapshot; a production distribution must use a verified SDK artifact.

The [local process protocol](docs/process.md) adds SDK-owned handshake, invocation,
cancel/close and heartbeat frames. The [experimental process Host](../plugin-host/README.md)
binds those frames to captured packages and actual child pipes; the SDK remains
data-only and has no runtime or Core dependency.

`bind_capability` captures an exact validated declaration and its owner with an
independently supplied package digest. `ProviderSelectionBinding` identifies that
fixed choice without an instance or activation generation; `ProviderBinding`
adds those fields for an actual channel. Neither data value grants execution or
adoption authority, and a digest does not authenticate a package publisher.

[Captured runtime descriptions](docs/environment.md) define the experimental
`node-system-libraries-v1` profile, complete tool/Host artifact hashes, and an
SDK-owned environment digest derived from the full validated descriptor.
These data helpers contain no filesystem capture or loader. Host integration
must independently approve and retain the actual runtime bytes.
