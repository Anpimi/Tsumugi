# Application versioning and changelog maintenance

## Version source and release boundary

`[workspace.package].version` in [Cargo.toml](../Cargo.toml) is the application's single version source. `tsumugi-core` and `tsumugi-desktop` inherit it. Tauri's configuration omits `version` so it reads the desktop Cargo package version; the frontend package is marked `private` and has no independent release version. Regenerate the workspace package entries in `Cargo.lock` with Cargo when changing the application version, using `cargo update --workspace --offline` with the existing dependency cache.

The release unit is the desktop application built from one verified source commit. Database schemas, bundled integration implementations, caption profiles and capability/exchange contracts have separate versions. Evaluate their compatibility when their behavior changes; do not change them merely to match an application version.

The supported user-facing scope is the documented project workflow and import/export formats. Internal Rust, storage and IPC interfaces are not a stable public SDK. The application remains in initial development.

## Choosing the next version

Use [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Choose a normal release target relative to the preceding normal release, then advance prereleases within that target. During `0.y.z` development, apply this project convention:

| Situation | Version choice |
|---|---|
| Compatible bug fixes only | Increment patch, for example `0.2.0` to `0.2.1` |
| New functionality, or incompatible documented behavior/data/format changes | Increment minor and reset patch, for example `0.2.0` to `0.3.0` |
| Another distributed prerelease for the same target | Advance the prerelease counter, for example `0.2.0-alpha.1` to `0.2.0-alpha.2` |
| Documentation, tests or tooling with no shipped behavior or compatibility change | No application bump by itself |

Use `alpha.N` while the target is under development. A move to `beta.N`, `rc.N` or the normal version requires an explicit readiness decision. Once a stable public compatibility contract is established at `1.0.0`, incompatible changes increment major; compatible features increment minor; compatible fixes increment patch.

Assess the whole unreleased batch, including earlier commits. A new feature in a fix batch changes its target; a new incompatibility requires a fresh compatibility review even if a version was already chosen. Routine commits and internal validation builds can share a pending version. Freeze that version when an explicitly designated prerelease/release snapshot is distributed or tagged; subsequent snapshots must use a new version. Record the source commit and artifact digest to distinguish internal builds.

The first managed target is `0.2.0-alpha.1`. It consolidates development commits through `7febd7e`, including new workflows and storage incompatibilities, after the original `0.1.0` scaffold version. There are no historical release tags to reconstruct. These changes remain **Unreleased**; the version assignment does not assert publication or completed release acceptance.

## Maintaining each change

1. Assess user-visible behavior, compatibility, project migrations and the application's release impact before completing a change. Check the existing unreleased entries and version target.
2. Describe user-relevant additions, changes and fixes under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md), using the appropriate Keep a Changelog category. State incompatible behavior and concrete migration steps. Consolidate related entries instead of copying commit subjects or listing merge commits.
3. Update [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md) in the same change. English is authoritative; version headings, dates, categories, scope and migration facts must agree. A change without release impact needs no artificial entry or bump; record that assessment in its review or delivery notes.
4. If the batch's target changes, update the Cargo workspace version, regenerate its lockfile entries, and synchronize current-version statements. Verify the resolved versions of both workspace packages and the version metadata of the actual desktop build. Select behavior checks according to the changed risk; a version-only change does not require an unrelated full test suite.

Before an authorized application release, move the batch into `## [VERSION] - YYYY-MM-DD` in both changelogs using the actual release date, leave a fresh `Unreleased` section, and align the manifest version, release title, source commit and artifact identity. Preserve published entries. Tags and release publication are separate operations from local development commits.
