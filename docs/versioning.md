# Application Versioning and Changelog Maintenance

## Version Source and Release Boundary

`[workspace.package].version` in [Cargo.toml](../Cargo.toml) is the single source of truth for the desktop application's version. Both `tsumugi-core` and `tsumugi-desktop` inherit this field. The Tauri configuration omits `version` so it reads the Cargo package version directly, and the frontend `package.json` is marked `private` without an independent release number.

Whenever you change the workspace version, refresh the workspace entries in `Cargo.lock` using the local cache:

```sh
cargo update --workspace --offline
```

A desktop release is built from a single verified source commit. Database schemas, bundled format integrations, caption profiles, and capability/exchange contracts carry their own version numbers. Update those internal versions only when their own format or behavior changes—not merely to match an application bump.

The supported public surface is the documented desktop workflow and its import/export formats. Internal Rust APIs, SQLite storage tables, and Tauri IPC payloads are not a stable public SDK.

## Choosing the Next Version

Tsumugi follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Pick the target release version relative to the previous release, and advance prerelease identifiers within that target. While the project is in `0.y.z` initial development, apply the following rules:

| Change Scope | Version Rule |
|---|---|
| Backwards-compatible bug fixes only | Increment patch (e.g., `0.2.0` → `0.2.1`) |
| New features, or incompatible changes to documented behavior, data, or formats | Increment minor and reset patch (e.g., `0.2.0` → `0.3.0`) |
| Subsequent prerelease distributions for the same target | Advance the prerelease counter (e.g., `0.2.0-alpha.1` → `0.2.0-alpha.2`) |
| Documentation, tests, or internal tooling with no shipped behavior or compatibility change | No version bump required |

Active development on a target uses `alpha.N` identifiers; moving to `beta.N`, `rc.N`, or a stable release requires an explicit release readiness decision. Once `1.0.0` establishes a stable compatibility contract, breaking changes will increment the major version.

Always evaluate the **entire unreleased batch** rather than bumping per commit. If a bug-fix batch gains a new feature or breaking change, re-evaluate the target version for the whole batch. Once a prerelease or release build is published or tagged, that version identifier is frozen—any subsequent distribution must advance the version counter.

The first managed target, `0.2.0-alpha.1`, consolidated the initial `0.1.0` development history through commit `7febd7e`. Because the published `0.2.0-alpha.1` snapshot is frozen, newer source changes accumulate under **Unreleased** until the next distributed prerelease advances the version to `0.2.0-alpha.2` (or `0.3.0-alpha.1`).

## Maintaining Changelogs

1. **Assess impact**: Before completing a change, check how it affects user-visible workflows, data compatibility, or migration requirements against the current `Unreleased` batch.
2. **Update `CHANGELOG.md`**: Record user-relevant additions, changes, and fixes under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories (`Added`, `Changed`, `Fixed`). Document any breaking changes and concrete user steps. Group related changes into cohesive entries rather than copying raw commit messages.
3. **Sync `CHANGELOG.zh-CN.md`**: Update [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md) in the same change. The English changelog is authoritative; version headers, release dates, categories, and migration instructions must match across both files. Purely internal refactors, test updates, or doc edits that do not alter shipped behavior do not need changelog entries.
4. **Apply version updates when needed**: If the target version changes, update `[workspace.package].version`, refresh `Cargo.lock`, update version references in the documentation, and verify that both Cargo packages and the desktop bundle resolve to the new version.

When preparing an official release, move the `Unreleased` entries under `## [VERSION] - YYYY-MM-DD` in both changelogs, leave a clean `## [Unreleased]` heading at the top, and verify that the Cargo manifest, release title, source commit, and artifact digests align.

## Component and Transition Profiles

### Experimental Plugin SDK (`crates/plugin-sdk`)

`crates/plugin-sdk/Cargo.toml` manages its own independent version (currently `0.1.0-alpha.1`), while inheriting the workspace Rust edition, MSRV, license, and authors. It has no dependency on `tsumugi-core` or `tsumugi-plugin-host`. See the [SDK README](../crates/plugin-sdk/README.md) for build and consumer verification commands.

Consumers pin SDK artifacts by exact commit and SHA-256 digest rather than relying on mutable version labels. Before distributing a new SDK archive, review all contract changes since the previous archive (such as new platform enum variants that affect exhaustive Rust matches) and advance the SDK prerelease version.

### Standalone Plugin Host (`crates/plugin-host`)

`tsumugi-plugin-host` inherits the workspace version. By default it builds without `tsumugi-core`, providing package/runtime inspection, local Store and TUF trust management, and headless SDK process channels. Enabling the optional `core-adapter` feature connects those channels and the internal Pi member runtime to Core's execution, grant, and process-lifecycle tracking without introducing a separate database store.

### Core Storage and Desktop Domain Transition

Current projects use SQLite schema **61** (`DELETE` journaling, `FULL` synchronization), which unifies project content, execution history, plugin grants, team work plans, context strategies, and provider usage ledgers. Older development schemas are rejected on open without modifying or resetting the project folder; users should keep old folders intact and re-import original source files into a new project.

By default, `tsumugi-core` requires SDK plugin provenance for domain operations. The desktop crate currently enables the transitional `legacy-desktop-domain` feature so existing built-in SMAPI/WebVTT commands and current-project receipt recovery remain available alongside plugin-backed workflows. Both paths share the same Store, runtime, usage ledger, and receipt checks, and plugin-bound inputs never fall back to built-in validation. Remove `legacy-desktop-domain` only after all remaining built-in command callers and receipt recovery paths have completed their migration.

### ChatGPT Subscription and Member Protocol

macOS ChatGPT sign-in stores credentials in the macOS Keychain while keeping request reservations, unknown-usage tracking, cancellation, and result adoption in Core. Internal member protocol **4** pairs regenerated wire contracts with the matching `agent-service` runtime; frozen protocol 3 archives remain unchanged for existing pins.
