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

[Source extraction](docs/source-extraction.md) defines bounded captured-material
input, exact content-result association and finite public errors. Its JavaScript
content/text declarations are generated from the Rust schemas alongside the
existing process bindings.
An optional package Resource uses the same SDK's source-import declaration to
fix material paths, a profile and independent extractor/checker selections.
The Host interprets only its captured bytes; directory access and current grants
remain separate application decisions.

[Build and artifact data](docs/build.md) defines fixed decided targets, actual
UTF-8 output, complete independent check scope and a captured build Resource.
The SDK and Host metadata APIs are available; the production desktop ReleasePlan
path is still being integrated. These contracts grant no execution or publication
permission.

[Existing translation data](docs/translation-import.md) adds complete captured
translation proposals, original native evidence and independent mandatory checks.
A captured Resource selects one file and exact extractor/checker contributions.
These helpers grant no execution or adoption authority; domain execution, current
project matching and desktop integration remain required consumers.

[Domain review checks](docs/review.md) define fixed source/selected-text scopes,
versioned mandatory domain rules and an immutable checker Resource. Results reuse
the existing check coverage contract. Core qualification and desktop execution
remain separate consumers; reading metadata grants no execution or review approval.

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
