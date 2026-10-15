# Tsumugi

**紡ぎ**

[English](README.md) · [简体中文](README.zh-CN.md)

An extensible localization workbench for translating and maintaining evolving content.

Tsumugi keeps source content, translations, terminology, review, validation, and releases in one project, with a focus on preserving useful work as the source changes over time.

## Overview

Source content changes, translations are revised, and terminology evolves. Work that was complete for one version may need attention in the next.

Tsumugi treats these changes as part of the normal project lifecycle:

```text
Import
  → Translate
  → Review
  → Validate
  → Build
  → Release
  → Update
```

When new source content is imported, Tsumugi keeps existing work by default and compares it against the new source. The goal is to keep what still applies, flag what needs attention, and preserve the history behind those decisions.

## Project Model

A project holds localization work across revisions. It contains source revisions, localization units, target-locale work, terminology, review decisions, validation results, and release history.

Content identity is separate from text equality and physical location. Identical text does not necessarily represent the same content, and content that moves or changes location may still retain its identity across revisions.

Translation, review, applicability, and validation have separate states. A translation may exist without being reviewed. A reviewed translation may later require reassessment if its relevant source or context changes. Editing a translation does not silently carry forward an earlier approval.

## Maintenance

Upstream changes are handled through content lineage and dependency information.

Tsumugi can distinguish between work that:

- remains applicable
- needs validation again
- requires translation or review
- cannot be resolved automatically

Previous translations and decisions remain part of project history even when they are no longer current. Updates build on that history within the same project.

## Extension Model

Tsumugi separates localization semantics from domain-specific knowledge. The Core defines project state, lifecycle rules, authoritative decisions, and the boundaries through which additional capabilities participate.

Extensions provide bounded capabilities through explicit contracts. A single extension may provide several related capabilities, while others may contribute only data or reusable resources.

Extensions do not own the project model. Their results are returned to the Core, validated, and adopted through the same rules as other project changes.

Public extension contracts remain separate from internal storage and implementation details. Executable extensions communicate through language-neutral boundaries and are not tied to the implementation language of the Core.

This lets different localization domains share a workflow and a single source of truth.

## AI

AI is optional. It may produce translation candidates, review signals, comparisons, contextual findings, or other structured results.

Those results use the same project model as manually produced work. AI output does not directly become authoritative project state or human approval.

Manual translation, review, and maintenance remain supported independently of an Agent backend.

## Build and Release

Editing, building, releasing, and delivering are separate operations.

A release is created from fixed project inputs and validated build output:

```text
Project state
    ↓
Release inputs
    ↓
Pre-build validation
    ↓
Build
    ↓
Post-build validation
    ↓
Release
    ↓
Delivery
```

Validation checks both translation state and the artifact the build produced.

A failed build does not become a release, and a failed delivery attempt does not erase an already recorded release.

## Architecture

The current reference architecture is:

```text
React + TypeScript + i18next
        │
      Tauri
        │
    Rust Core
        │
Capability Protocol
        │
Workers / Data Extensions / External Tools
```

The desktop interface requests operations; the Core controls state transitions. The Core owns project semantics, persistence, orchestration, result adoption, and release state.

Long-running or domain-specific operations can run outside the Core through bounded capability contracts. Public contracts are intended to remain independent from the Rust ABI.

## Development

The native translation IPC integration test on Apple silicon macOS uses an
independently fingerprinted prebuilt SMAPI package and the
[prepared desktop runtime](runtimes/javascript-host/README.md#opt-into-the-desktop-extension-bundle).
Set `TSUMUGI_TEST_PLUGIN_PACKAGE` to that package directory and
`TSUMUGI_TEST_PLUGIN_DIGEST` to its complete verified digest, then run:

```text
cargo test -p tsumugi-desktop --features wire-schema,bundled-runtime translation_execution -- --include-ignored
```

This opt-in test runs actual translation producer/checker Workers, durable Core
proof and per-entry adoption in temporary application/project directories. The
interactive picker uses an owned native handle fixture; rendered workbench
acceptance remains separate.

The desktop read-only tool IPC test uses the independently prepared terminology
package selected by `TSUMUGI_TEST_KNOWLEDGE_PACKAGE` and
`TSUMUGI_TEST_KNOWLEDGE_DIGEST`. The source and joint-review tests independently
select their format package with `TSUMUGI_TEST_PLUGIN_PACKAGE` and
`TSUMUGI_TEST_PLUGIN_DIGEST`. Keep these selections separate when running the
desktop execution group. Its actual component workflows require `bundled-runtime`
and a prepared runtime matching the current process protocol; the
`execution-test-host` group alone does not exercise those bundled workflows.

On macOS, the opt-in desktop package-cleanup process test selects the independently
fingerprinted Node tool tree, current built Host tree and matching environment
descriptor with `TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST` and
`TSUMUGI_TEST_RUNTIME_APPROVAL`. Prepare those artifacts using the
[JavaScript Host build and checks](runtimes/javascript-host/README.md#build-and-checks).
It uses temporary installations and projects and does not require the desktop
runtime bundle or run a graphical application:

```text
cargo test -p tsumugi-desktop --features execution-test-host package_cleanup_process -- --ignored --test-threads=1
```

The test exercises actual Node component processes through the registered
uninstall command. Target removal must preserve an independent in-flight process
and its original Core authorization. After explicit reinstallation and project
reopen, confirming a completed original removal must preserve the new instance.
Native GUI and other platform acceptance remain separate checks.

On macOS arm64, with the same three runtime variables, the opt-in missing-package
workflow tests each install one pinned included package, SMAPI or WebVTT, in a
temporary Store and run its actual source extraction, independent checks,
translation QA, build and release:

```text
cargo test -p tsumugi-desktop missing_package -- --ignored --test-threads=1
```

For each format, one case revokes approval and uninstalls that exact installation
through the registered commands. A second case retains approval while moving
only its temporary installation object after the original workers have drained.
Reopening the project must preserve stored source, translation history and
execution provenance, allow manual revisions, reject new package-dependent QA
and builds with the exact approval or missing-package error, and export the
original saved release bytes. The missing-object cases verify physical fixture
restoration; they do not implement application recovery.

The same approved runtime variables also enable a two-version synthetic source
upgrade journey on macOS arm64:

```text
cargo test -p tsumugi-desktop actual_two_version_identity_upgrade -- --ignored --test-threads=1
```

It installs two complete package versions whose separately versioned native-key
policy changes from ASCII folding to exact case. Installation and reopen cannot
adopt a new interpretation. The checked comparison shows the added and removed
identities, refuses an incompatible continuation, and changes current content
only after explicit adoption. Earlier translation and review histories remain
readable, and the original independently checked release retains its exact bytes
through export and reopen. The stable synthetic records profile preserves
captured references and bytes; this test does not establish upgrade compatibility
for an included real format or native GUI acceptance.


An additional synthetic source test keeps an actual old-version invocation in
flight while installing and independently enabling the new version through the
registered package commands:

```text
cargo test -p tsumugi-desktop actual_live_version_update -- --ignored --test-threads=1
```

It checks the original channel, authorization and deadline while the new version
starts independently. Exact old-version approval removal terminates and reaps
only its worker without accepting a result; cooperative JavaScript cleanup is
not required before termination. Repeating its original cleanup callbacks and
registered request leaves the new instance and its independent grant intact.
After owner drain and project reopen, a fresh new-version invocation is compared
with the live-update result, while original source and translation history remain
unchanged. The original two-version journey above also covers shared fixture
helpers. These are temporary, complete synthetic packages and actual Node
processes, separate from included-format upgrade and native GUI acceptance.

The JavaScript Host lifecycle suite separately runs two actual channels. A
cooperatively cancelled old callback resolves after cancellation, emits no
result, and cannot register from its disposed facade while the new channel is
still invoking. The new channel then returns its own exactly bound result.
This protocol check is separate from Desktop grant and installation checks.

The experimental, standalone [plugin SDK](crates/plugin-sdk) provides
data contracts and a schema/validation harness without depending on Core. It
validates declarations, content/execution frames and captured check coverage;
production plugin loading and runtime binding are not yet supplied by this SDK
unit. See [plugin declarations](crates/plugin-sdk/docs/declarations.md) and
[content exchange](crates/plugin-sdk/docs/exchange.md). The [experimental process Host](crates/plugin-host)
adds SDK-owned [framing](crates/plugin-sdk/docs/process.md) and actual native/JavaScript
conformance processes on macOS; production catalog/Core integration remains pending.

The desktop supports Windows x64 and macOS (Apple Silicon and Intel build targets), and uses Rust 1.98+, React 19, TypeScript 7, Vite 8, Tauri 2, and pnpm 12. The native Windows build requires Visual Studio C++ Build Tools, a Windows SDK, and the Microsoft Edge WebView2 Runtime. The macOS build requires Xcode Command Line Tools and uses the system WKWebView. Install the platform prerequisites from the [Tauri guide](https://v2.tauri.app/start/prerequisites/). macOS application bundles target macOS 11 or later; each architecture must be built with its corresponding Rust target.

Project lifecycle, application plugin controls, command error, change notification, execution, source content, translation, resource, review, release, AI and Arena DTOs use the Rust/Serde definitions as their wire source. After changing these definitions, run `pnpm --dir apps/desktop generate:contracts`; `pnpm --dir apps/desktop check:contracts` verifies that the checked-in schemas, TypeScript types and precompiled validators are current. Generation is partitioned by domain; add `--domain=project`, `--domain=plugins`, `--domain=execution`, `--domain=source`, `--domain=translation`, `--domain=resource`, `--domain=review`, `--domain=release`, `--domain=ai` or `--domain=arena` for a focused update or check. The optional `wire-schema` Cargo feature is used for generation; the application does not compile schemas dynamically. AI display counters use exact decimal strings; their persisted execution inputs and results retain their original representation.

Command failures retain their original structured evidence. When a saved basis has changed, expandable diagnostics show the submitted and rejecting values; recovery guidance explains the next read or decision without automatically retrying a write. Diagnostic references correlate command-boundary logs containing only operation labels, error classifications and the reference, without request bodies or project paths. Unknown results keep the original action for reconciliation.

Source proposals retain SDK references with explicit UTF-8-byte, UTF-16 or grapheme encoding and half-open offsets. The source workbench shows the captured file and declared encoding without interpreting offsets as JavaScript string indices. Original identity display evidence is separate from the canonical matching value. The bundled importers and translation capture use half-open UTF-8 byte offsets before escape decoding or newline normalization. The shared `crates/core/tests/fixtures/source-unicode.contract.json` covers BOM, CRLF, Chinese text, emoji, combining characters and JSON escapes, with UTF-16 positions as a test oracle for Rust and TypeScript.

From the repository root:

```text
pnpm install
pnpm --dir apps/desktop build
cargo test --workspace
pnpm --dir apps/desktop tauri dev
```

Run the normal Core content regressions separately:

```text
cargo test -p tsumugi-core --test source_production --test translation_production --test build_production
```

This checks production source/translation/build input rejection, schema 32 refusal of
previous formats, manual history and original save receipts.
Workspace tests enable the explicit `execution-test-host` fixture through
development dependencies; this focused command uses normal Core features.

For a standalone Windows executable without an installer, run:

```text
pnpm --dir apps/desktop tauri build --no-bundle
```

For a macOS application bundle, run on a Mac:

```text
pnpm --dir apps/desktop tauri build
open target/release/bundle/macos/Tsumugi.app
```

The platform configuration bundles the current architecture as a `.app`. Apple Silicon has been verified with a native build and local project workflow. To build Intel on Apple Silicon, install the Rust `x86_64-apple-darwin` target and pass `--target x86_64-apple-darwin`; the Intel build and macOS 11 runtime have not yet been verified. Code signing, notarization, and distributing a release are separate operations. Development builds can run with `pnpm --dir apps/desktop tauri dev`.

Launch `target/release/tsumugi-desktop.exe` directly. This build embeds the frontend and does not need a development server or console window. The Microsoft Edge WebView2 Runtime is still required. `tauri dev` and debug builds retain the development console.

The desktop workbench suppresses page reload, browser navigation, printing, page-source and page-save shortcuts so they cannot bypass the editing workflow. Ctrl+S (Command+S on macOS) still belongs to the active editor. Text fields retain their native editing menus; other text can be selected and copied with Ctrl+C or Command+C. The navigation and toolbar stay in place while the workspace scrolls.

The desktop shell supports creating, opening, renaming, closing, and reconciling local projects, adding target locales, importing source content, managing translation revisions, working with project terminology and context, reviewing current translations, and building verified SMAPI language files for local export. These operations use Tauri commands.

The global **Extensions** panel reviews a locally selected plugin folder, its declared publisher, requested permissions and exact fingerprint. Explicit manual approval saves trust before installing fixed bytes; a new package starts disabled. Enablement is a separate action, and selected capabilities require exact current approval and verified installed bytes. If a change has an uncertain result, read current state and retry the original operation; this preserves its original action and request. Reopening the panel retains that request. Interrupted installation can also recover after explicitly reviewing and approving the matching package again. An [opt-in Apple silicon macOS build](runtimes/javascript-host/README.md#opt-into-the-desktop-extension-bundle) includes a fixed Node and Host environment requiring macOS 13.5. Its [offline artifact preparer](docs/plugin-distribution.md) verifies exact WebVTT/SMAPI archive and SDK pins before delivering a complete resource set. Runtime approval and installation are separate from package approval and execution permission; exact installed files can be verified from the panel. Ordinary builds explicitly report that no runtime is bundled. These controls do not authenticate a publisher or start plugin code; final clean-system release acceptance remains under development.

The experimental Rust `ExecutionRuntime::begin_package_quiesce` API stops one
full plugin identity and package digest across its registered environments.
Retain its original action ID and opaque `PackageQuiescence` token; retry the
same action after a storage failure and poll `finish_package_quiesce` until the
original workers and active query calls drain. Completion removes only the
target registrations, preserves unrelated packages' generation and permits,
and never renews permission. Descendants still obey existing parent controls.
Captured old query callbacks stay closed; completed old controls cannot remove
later explicit registrations. Hosts must additionally drain their own pending
calls, query threads and lifecycle resources before changing installation bytes.
These runtime controls do not revoke installed approval or uninstall a package.

The experimental Rust `PackageStore::uninstall` API removes an exact installation
after a separate settings decision has removed its approval. Disabled approval
still blocks removal. The application must stop new dispatch and drain or legally
cancel its original execution instances before calling it; the Store does not
unload a worker. `uninstallations` observes original receipts and incomplete
removals. Once an intent is recorded, any failure requires the exact original
action, expected initial settings revision and approval for recovery. A resumed
incomplete action checks current settings again and refuses an approved target.
A completed retry observes the original result even after a new install or
settings revision, without altering that new installation. Recovery bytes remain
immutable outside active inventory and loading, and package/runtime/removal
action UUIDs cannot be reused. The journal retains at most 128 removals and
performs no automatic cache collection. It never modifies projects or restores
execution permission.

The experimental **Extensions** panel exposes **Revoke approval** separately
from **Uninstall this installation**. Review the target and its effects, then
explicitly confirm each action. Revocation stops new selection and dependent
work while retaining installation files. Uninstall waits for the original
installation's dependent work to exit before removing it; disabling a package
alone does not remove approval. Saved project content, results, history and
exports remain. An uncooperative worker prevents confirmed removal.

Accepted cleanup retains its original request through a lost waiter or a Busy
continuation. Closing or refreshing the panel preserves that request; use
**Retry original operation** to continue it. **Previous installation removals**
also offers explicit original-action confirmation. Those observations alone do
not confirm filesystem durability; a completed original replay preserves a
later installation and its work. Full native lifecycle acceptance is still in
progress.

The sidebar opens each working area in the main workspace. Returning to another area preserves its project-local position and drafts; leaving an unsaved translation first offers save, keep editing, or discard. The project overview shows import or continue-editing actions according to the current source. Translations opens the editor by default, with a searchable paged list alongside source text, translation and revision controls. Search covers native keys, source text and selected translations across the complete current source, including entries beyond the displayed page. Terms, context and history are available in a collapsible reference area.

The experimental `read_plugin_source` command accepts an exact package identity/fingerprint, source Resource ID and environment digest. It reads the installed package's fixed material recipe, resolves its independent extractor/checker declarations and captures the independently approved installed Node environment under one current settings revision. Disabled packages, missing files or changed choices are refused. The generated IPC adapter preserves this read-only snapshot; native directory selection, fixed capture and per-attempt execution are separate operations. The Source content workbench now uses installed source Resources, explicitly consents to the extractor and independent checker separately, and records mandatory check validation before Core adoption. Normal builds do not register the former built-in source preflight/start commands. Child processes run with the OS user's permissions; they are not an OS sandbox. Translation/build migration, authenticated updates and default domain-package distribution remain incomplete.

The Tasks view exposes persisted execution progress, saved outputs, cancellation, eligible recovery, and explicit result adoption. Normal builds have no synthetic task creation menu. Developers can use the isolated [execution test host](docs/execution-test-host.md) to exercise these paths without a translation provider.

The collapsible **Background tasks** dock is available throughout an open
project. Its totals include every task, while the list shows at most twelve
tasks with active or queued work first. Each item's latest state is retained
across partial continuations, including still-running or uncertain earlier work.
Output saved, checks passed,
applied changes and exported files remain distinct facts. Open a row to inspect
the exact task and attempt through the normal draft-preserving navigation;
reading or refreshing the dock starts no work. Status read failures can be
retried locally without discarding current input.

Experimental [read-only tool query commands](docs/plugin-tools.md) prepare fixed single or batch inputs for an enabled installed capability, require exact current runtime/settings and per-attempt consent, and retain unadopted results in the same execution ledger. Product query interfaces and Agent orchestration remain under development.

The Source content view selects an enabled installed source package and an independently approved installed runtime. Declare the source language, capture the package-declared files, separately permit extraction and semantic checking, then review the saved strings and explicitly apply the complete checked snapshot. Existing projects can compare and adopt a new complete source snapshot while retaining earlier content and releases. Original files remain unchanged. See [supported inputs and recovery](docs/source-import.md). The Translations view imports a flat `i18n/<language>.json`, previews matches against the current source, creates candidates or checked selections, and saves immutable manual revisions. See [translation import and editing](docs/translation-import.md). Glossary and context lets you edit adopted terms, review a local glossary file one entry at a time, capture context, inspect translation suggestions, and locate potentially affected translations. See [glossary and context](docs/resources.md). Review and QA records human decisions, runs current checks, shows work by language, and assesses build readiness under the balanced policy; see [review and QA](docs/review-qa.md). Build and export turns approved translations into verified local SMAPI language files; see [local build and export](docs/build-release.md). Packaging or installing complete Mods is not implemented.

The AI workbench can prepare a manual plan without a model, or authorize assisted generation for a fixed scope and expiry. An explicit policy can select missing translations or replace the captured translations after clean mechanical checks, while persistent protection prevents replacement. Policy receipts do not grant human approval. Pause, stop and manual takeover revoke older permissions; explicitly renewed continuation retains the original budget. Opening an entry protects it before draft input is enabled, and the editor offers a scoped release confirmation. See [work plans](docs/work-plans.md).

AI translation supports an editable OpenAI-compatible Chat Completions endpoint, model, credential environment variable name, and budget. Connection presets remain editable. Source text is required; terms and context are shared only when enabled. Preview and confirm the exact data before sending. Successful results can be saved as candidates, then compared and selected in Translations. Partial failures retain successful results; starting new requests requires a fresh preview and budget. See [direct AI translation](docs/ai-translation.md).

Arena comparison generates two to four schemes under a shared round budget or compares saved revisions offline. Optional blind comparison keeps fixed anonymous labels until an explicit reveal. Save candidates, select a revision or edit an atomic manual merge with contributing provenance, then continue normal Review and QA. See [AI translation and Arena comparison](docs/ai-translation.md).

New projects use database schema 37. Only the current schema is supported; other development snapshots are refused before application schema changes. Tsumugi preserves their directories without upgrading or rebuilding them; SQLite may complete its own hot-journal recovery when opening a database. Keep those directories and create a new project to reimport the original source files. Current project reopening verifies the complete layout and persisted associations; it never resets the directory. The application is in the unreleased `0.2.0-alpha.1` development batch. See the [changelog](CHANGELOG.md) and [versioning policy](docs/versioning.md) for changes, compatibility and future version decisions.

Current projects use SQLite DELETE journaling and FULL synchronization. Unsupported storage settings are refused separately from corrupt schemas, broken references or altered artifacts; Tsumugi preserves the directory and does not convert the storage mode or reset its contents. Keep a refused directory intact and select another supported project in the opening dialog to continue. Do not change SQLite settings manually as a substitute for a supported storage profile. Saved releases remain available after a failed delivery and export uses their verified original bytes. Uncertain deliveries must be reconciled before another delivery to the same destination; explicit retries use the existing action identity, or a fresh confirmed destination preview for a new delivery.

Early development snapshots do not have a historical compatibility or migration contract. Current project identity, stored manifests, release bytes and receipts remain integrity requirements. Core Rust callers with exhaustive matches on `PersistenceError` or `PersistenceErrorCode` must handle `UnsupportedStorage`; desktop errors use the existing `unsupported-schema` code with `reason: "storage-mode"`.

The bundled WebVTT integration supports a limited plain-text caption profile with explicit cue IDs. It preserves timing, layout and original non-text structure through import, translation, source maintenance and checked local subtitle export. See [bundled integrations and compatibility](docs/integrations.md) for supported syntax and interface maturity.

## Status

Tsumugi is in early development. Current work focuses on the foundations for complete localization workflows:

- project and language boundaries
- content identity and lineage
- translation and review state
- dependency and impact analysis
- task execution and result adoption
- build and release semantics
- extension contracts
- persistence and recovery

Detailed APIs, storage schemas, transport protocols, and public extension contracts are still under design. There is no stable plugin API yet.
