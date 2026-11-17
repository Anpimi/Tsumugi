# Application Versioning and Changelog Maintenance

## Version Source and Release Boundary

`[workspace.package].version` in [Cargo.toml](../Cargo.toml) is the single source of truth for the desktop application's version. Both `tsumugi-core` and `tsumugi-desktop` inherit this field. The Tauri configuration omits `version` so it reads the Cargo package version directly, and the frontend `package.json` is marked `private` without an independent release number.

Whenever you change the workspace version, refresh both lockfiles using the local cache. The plugin compatibility workspace has its own lockfile and resolves Core and Host from this checkout.

```sh
cargo update --workspace --offline
cargo update --manifest-path crates/plugin-host/compatibility/Cargo.toml --workspace --offline
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

The first managed target, `0.2.0-alpha.1`, consolidated the initial `0.1.0` development history through commit `7febd7e`. The published `0.2.0-alpha.1` snapshot remains frozen. The next development target is `0.3.0-alpha.1`, which changes the supported project format.

## Maintaining Changelogs

1. **Assess impact**: Before completing a change, check how it affects user-visible workflows, data compatibility, or migration requirements against the current `Unreleased` batch.
2. **Update `CHANGELOG.md`**: Record user-relevant additions, changes, and fixes under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories (`Added`, `Changed`, `Fixed`). Document any breaking changes and concrete user steps. Group related changes into cohesive entries rather than copying raw commit messages.
3. **Sync `CHANGELOG.zh-CN.md`**: Update [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md) in the same change. The English changelog is authoritative; version headers, release dates, categories, and migration instructions must match across both files. Purely internal refactors, test updates, or doc edits that do not alter shipped behavior do not need changelog entries.
4. **Apply version updates when needed**: If the target version changes, update `[workspace.package].version`, refresh `Cargo.lock`, update version references in the documentation, and verify that both Cargo packages and the desktop bundle resolve to the new version.

When preparing an official release, move the `Unreleased` entries under `## [VERSION] - YYYY-MM-DD` in both changelogs, leave a clean `## [Unreleased]` heading at the top, and verify that the Cargo manifest, release title, source commit, and artifact digests align.

## Component and Transition Profiles

### Experimental Plugin SDK (`crates/plugin-sdk`)

`crates/plugin-sdk/Cargo.toml` manages its own independent version (currently `0.1.0-alpha.9`), while inheriting the workspace Rust edition, MSRV, license, and authors. It has no dependency on `tsumugi-core` or `tsumugi-plugin-host`. See the [SDK README](../crates/plugin-sdk/README.md) for build and consumer verification commands.

Consumers pin SDK artifacts by exact commit and SHA-256 digest rather than relying on mutable version labels. Before distributing a new SDK archive, review all contract changes since the previous archive (such as new platform enum variants that affect exhaustive Rust matches) and advance the SDK prerelease version.

`EncodedPayload::utf8` uses `PayloadText` in this development batch. Rust consumers that supplied an explicit `Arc<str>` can construct the field from `String` or `&str` using `into()`. The serialized field is the original UTF-8 string and retains its existing digest and wire schema.

### Standalone Plugin Host (`crates/plugin-host`)

`tsumugi-plugin-host` inherits the workspace version. By default it builds without `tsumugi-core`, providing package/runtime inspection, local Store and TUF trust management, and headless SDK process channels. Enabling the optional `core-adapter` feature connects those channels and the internal Pi member runtime to Core's execution, grant, and process-lifecycle tracking without introducing a separate database store.

### Local Plugin Settings

Application-wide package approvals and enablement use independent settings format **3** in the original package store. Format 2 remains readable and is upgraded only by a successful settings write; reads and failed writes preserve it. Format 3 retains the complete last caller request when supplied by the installation/settings owner, its I/O completion state, and known settings action identities within the existing bounded snapshot. Approval removal and uninstallation retain their existing coordinator recovery semantics and cannot replace an incomplete action. Confirming the exact completed last action does not advance the business revision or restore execution grants. Older snapshots without caller proof cannot establish a completed desktop request, and missing earlier action history is not reconstructed. Older clients reject format 3. Package settings are versioned independently from the project schema, draft journal, plugin SDK, and member protocol.

### Core Storage and Desktop Domain Transition

Projects and backups must use SQLite schema **80** (`DELETE` journaling, `FULL` synchronization). Opening validates the current format and its persisted references. Restoration validates the backup format before creating a destination folder, validates an unpublished copy, then publishes the restored project and its separate draft-instance identity. Older formats are refused. Keep older projects and backups intact and re-import original source files into a new project. Local drafts, machine credentials, and application settings have separate owners.

Schema 80 keeps exact source and output bytes with their original digests and references. Successful source import, plugin translation extraction, and build results retain the original SDK payload as raw UTF-8 after their local JSON header. The header retains the binding and the schema and digest reference. Reading a result checks the complete stored record and the raw payload before any typed domain reader can use it. Independent source and artifact checker inputs retain their original producer bindings and the exact SDK request payload's digest and byte length. Dispatch reconstructs the full request from the original evidence. Opening checks the same reconstruction without retaining the encoded request body. This storage change preserves the SDK request contracts and Process 4.

One decoded file is limited to 128 MiB, a source or artifact set to 256 MiB, encoded source/artifact sets to 384 MiB, and content to 512 MiB with up to 100,000 fields. Material-backed SDK invocations allow 1 GiB; Core fixed inputs and stored plugin results each allow 768 MiB. Inputs use the existing content-addressed chunk owner with 64 KiB chunks. Ordinary inputs retain 4 MiB, result defaults retain 256 KiB, and ordinary result/attempt ceilings retain 8 MiB. These ceilings are enforced independently. The application stays in the same unpublished `0.3.0-alpha.1` development batch.

Paired translation proposals use internal projection format **2** through the original Core translation projection runner. It stores file metadata and per-entry file references; raw material remains in the checked producer result. This non-plugin projection shares immutable entry data and has a 516 MiB fixed-input ceiling and 768 MiB aggregate attempt-result ceiling; individual results remain limited to 2 MiB. Original single-file projection format 1 retains its smaller material limits. Native paired capture selections and their original/translated file previews remain volatile session metadata. Paired capture requests omit the legacy file name and reference only the held native selection; original single-file requests and previews keep their encoding. This does not change the draft journal format. Older application snapshots reject projection format 2; they cannot reopen projects containing these new records.

Paired preview evidence and release eligibility summaries use their own aggregate encoding budgets. Review and build eligibility can address the current source's full field scope. The resource-impact selection and history limits still apply independently to release qualification.

Existing conversation planning retains capability 1, recipe 1 and preview 2. An explicit knowledge purpose for a fixed entry selection uses capability 2, recipe 2 and preview 3 through the same provider and consent flow. Terminology uses an explicit terminology purpose with capability 3, recipe 3 and preview 4 through the same planning permission and provider flow. It returns bounded, entry-scoped proposals and preserves the original model result in the resource capture; saving a proposal does not adopt terms. The selected-revision scope uses capability 4, recipe conversation-selected-revision-1 and preview 5 in the original conversation ledger. The original planning profiles keep their encodings. Development snapshots from before this profile cannot interpret its new records. These profiles do not change the plugin SDK or member protocol; generated knowledge is a proposal, not authority to write resources.

By default, `tsumugi-core` requires SDK plugin provenance for domain operations. The desktop crate currently enables the transitional `legacy-desktop-domain` feature so existing built-in SMAPI/WebVTT commands and current-project receipt recovery remain available alongside plugin-backed workflows. Both paths share the same Store, runtime, usage ledger, and receipt checks, and plugin-bound inputs never fall back to built-in validation. Remove `legacy-desktop-domain` only after all remaining built-in command callers and receipt recovery paths have completed their migration.

### ChatGPT Subscription and Member Protocol

macOS ChatGPT sign-in stores credentials in the macOS Keychain while keeping request reservations, unknown-usage tracking, cancellation, and result adoption in Core. Internal member protocol **4** pairs regenerated wire contracts with the matching `agent-service` runtime; frozen protocol 3 archives remain unchanged for existing pins.

### System API-key References

Non-secret saved connection profiles use format **2**. Format 1 remains readable without modification; a successful new connection change advances the format in the same transaction. Exact historical receipts and old configuration encodings remain unchanged. Earlier clients reject format 2. API keys themselves are stored only in a separate macOS Keychain service, scoped to a non-secret installation identity. New keys receive immutable references; an existing reference cannot be silently replaced with another key. Removing one key does not remove ChatGPT OAuth accounts or another key. Local draft journal format **19** admits these references through the original bounded draft types; older supported records remain readable and upgrade on a successful write. No secret is part of the connection database, project or draft journal.
