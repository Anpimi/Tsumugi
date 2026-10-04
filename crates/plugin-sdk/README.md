# Experimental plugin declaration SDK

`tsumugi-plugin-sdk` is a data-only Rust library and declaration harness. Its
current package version is `0.1.0-alpha.1`; declaration protocol `1` is a separate
version. It has no dependency on Core, SQLite, the desktop application or Cordis.
It does not start code, install packages or grant permissions.

See [the declaration contract](docs/declarations.md) for fields,
compatibility and host responsibilities. The three JSON fixtures in
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

The schema is generated from the Rust/Serde source. The CLI `validate` command
also checks owner references, duplicate identities, SemVer syntax, requested
permissions, bounds and package-relative paths. Structural JSON Schema validation
alone cannot prove those relationships or runtime authorization.

The crate has its own experimental version and can be packaged independently.
It has not been published. Plugin authors may use an explicitly pinned development
SDK snapshot; a production distribution must use a verified SDK artifact.
