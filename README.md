# Tsumugi

**紡ぎ**

[English](README.md) · [简体中文](README.zh-CN.md)

Tsumugi is an extensible localization workbench built for translating and maintaining content that changes over time.

Instead of treating localization as a one-off export, Tsumugi keeps source snapshots, translations, terminology, context, review decisions, QA checks, AI workflows, and release artifacts inside a single project—preserving useful work as upstream content evolves.

## Overview

Software strings, game mods, and subtitles rarely stay still. Source text is revised, keys move, and terminology shifts between versions. Work that was finished for one release often needs targeted updates in the next.

Tsumugi models these updates as part of the normal project lifecycle:

```text
Import → Translate → Review → Validate → Build → Release → Update
```

When you import a new upstream snapshot, Tsumugi compares it against existing project history rather than discarding prior work. It identifies what still applies, flags entries that need re-verification or fresh translation, and keeps an audit trail of how each change was resolved.

## Core Concepts

### Project Model

A project tracks localization work across upstream revisions, including:

- Source snapshots, content units, and their original file locations
- Target locales and immutable translation revisions
- Glossaries, unit context, and translation memory suggestions
- Human review decisions, QA check runs, and scoped waivers
- Background task history, AI candidates, and Arena comparisons
- Verified release builds and local export receipts

**Content identity** is tracked independently from raw text and file position. Two identical strings are not assumed to be the same unit, and a string that moves or changes wording across revisions can keep its logical identity.

**Translation, review, applicability, and validation** are tracked as separate states. Saving a translation does not mark it reviewed, editing a translation clears prior approval, and upstream source or terminology changes can flag previously approved entries for reassessment.

### Upstream Maintenance

When upstream content updates, Tsumugi uses content lineage and dependency tracking to classify existing work into entries that:

- Remain applicable as-is
- Need QA checks re-run
- Require re-translation or human review
- Have ambiguous lineage that needs a manual decision

Earlier translations, review notes, and releases stay in project history even after entries are modified or removed upstream.

### Extensions and Domain Plugins

Tsumugi separates core localization workflows from format- and domain-specific logic. The Rust Core owns project state, storage, task orchestration, and result adoption, while domain capabilities run through explicit contracts:

- **[Plugin SDK](crates/plugin-sdk/README.md)** (`crates/plugin-sdk`): Standalone Rust data contracts, a conformance CLI, and generated JavaScript bindings.
- **[Plugin Host](crates/plugin-host/README.md)** (`crates/plugin-host`): Package inspection, local Store and trust management, and isolated Native/JavaScript worker channels.
- **[Desktop Plugin Management](docs/plugin-distribution.md)**: Explicit package installation, runtime approval, and per-project domain binding.

Built-in and plugin-backed workflows currently cover Stardew Valley SMAPI mods (`manifest.json` + flat `i18n/*.json`) and an experimental WebVTT plain-text subtitle profile with explicit cue IDs (preserving timing, layout, and non-text bytes). See [Bundled Integrations and Compatibility](docs/integrations.md) and the [Plugin Authoring Guide](docs/plugin-authoring.md).

### AI, Arena, and Agent Work Plans

AI features are optional and work alongside manual editing:

- **[Direct AI Translation](docs/ai-translation.md)**: Configurable OpenAI-compatible Chat Completions connections (plus macOS ChatGPT subscription sign-in) with explicit data-sharing previews, request budgets, and candidate saving.
- **[Arena Comparison](docs/ai-translation.md#arena-comparison)**: Side-by-side comparison of two to four generated schemes or saved revisions, with optional blind labels and manual merge tracking.
- **[Agent Work Plans](docs/work-plans.md)**: Multi-step localization tasks powered by `pi-agent-core` and `pi-ai`, supporting dynamic team discussions, read-only capability tools ([Plugin Tools](docs/plugin-tools.md), [MCP Retrieval](docs/mcp-retrieval.md), [MCP Sharing](docs/mcp-sharing.md)), request budgets, and human guidance or takeover.

AI and Agent outputs never overwrite active translations directly; they are saved as candidates or proposals that go through the same selection, review, and QA workflow as human edits.

### Build and Release

Editing, building, releasing, and exporting are distinct steps:

```text
Project state
    ↓
Pinned release inputs
    ↓
Pre-build validation
    ↓
Build
    ↓
Post-build artifact validation
    ↓
Recorded Release
    ↓
Local export / delivery
```

A build validates both project readiness and the generated output files before recording an immutable release. If a subsequent file export fails or is interrupted, the recorded release remains intact and can be reconciled or re-exported from its verified bytes. See [Local Build and Export](docs/build-release.md).

## Desktop Workbench

The desktop app organizes work into dedicated views accessible from the sidebar. Switching views preserves scroll positions, filters, and unsaved drafts; leaving an unsaved translation prompts to save, keep editing, or discard.

- **Source Content**: Import and inspect source snapshots, compare upstream updates, and resolve content lineage. See [Source Import and Maintenance](docs/source-import.md).
- **Translations**: Paged, searchable editor covering native keys, source text, and active translations across the full source snapshot, with collapsible panels for glossary terms, context, and revision history. Also supports importing existing translation files. See [Translation Import and Editing](docs/translation-import.md).
- **Glossary & Context**: Manage project terms, step through local glossary files, pin unit context, and inspect translations affected by terminology changes. See [Glossary and Context](docs/resources.md).
- **Review & QA**: Record human approvals or change requests, run built-in or plugin QA checks, manage waivers, and check build readiness per target language. See [Review and QA](docs/review-qa.md).
- **AI Translation, Arena & Work Plans**: Run scoped AI translations, compare candidates in Arena, or coordinate multi-member Agent work plans.
- **Tasks**: Monitor persisted execution progress, cancel running work, reconcile interrupted operations, and adopt completed outputs.
- **Build & Export**: Build verified language files from approved translations and export them to local folders.

Browser-style shortcuts (refresh, back/forward navigation, print, view source, save page) are disabled in the workbench so they do not interfere with editing. `Ctrl+S` (`Cmd+S` on macOS) saves the active editor draft, and standard text selection/copy (`Ctrl+C` / `Cmd+C`) and input context menus work as expected.

## Architecture

```text
React 19 + TypeScript 7 + i18next
               │
            Tauri 2
               │
           Rust Core
               │
      Capability Protocol
               │
Workers / Domain Plugins / Agent Service
```

The React frontend renders workspace state and dispatches Tauri commands. The Rust Core enforces state transitions, SQLite persistence, concurrency guards, and result adoption. Long-running or domain-specific work runs out-of-process through language-neutral capability contracts that do not depend on the Rust ABI.

## Development

### Prerequisites

- **Supported platforms**: Windows x64 and macOS (Apple Silicon and Intel targets; minimum macOS 11)
- **Toolchain**: Rust 1.98+, Node.js, pnpm 12, Vite 8, Tauri 2
- **Windows native dependencies**: Visual Studio C++ Build Tools, Windows SDK, and Microsoft Edge WebView2 Runtime
- **macOS native dependencies**: Xcode Command Line Tools (uses system `WKWebView`)

See the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for platform setup details.

### Building and Running

From the repository root:

```sh
pnpm install
pnpm --dir apps/desktop build
cargo test --workspace
pnpm --dir apps/desktop tauri dev
```

To build a standalone Windows executable without an installer (embeds the frontend; requires WebView2 Runtime at runtime):

```sh
pnpm --dir apps/desktop tauri build --no-bundle
# Output: target/release/tsumugi-desktop.exe
```

To build a macOS application bundle:

```sh
pnpm --dir apps/desktop tauri build
open target/release/bundle/macos/Tsumugi.app
```

On Apple Silicon, cross-compiling for Intel requires installing the `x86_64-apple-darwin` Rust target and passing `--target x86_64-apple-darwin`. Code signing, notarization, and release distribution are handled separately.

### Wire Contracts and Text Offsets

IPC DTOs across project lifecycle, execution, source, translation, resources, review, release, AI, Arena, connections, plugins, strategy, and MCP use Rust/Serde definitions as their single source of truth. After modifying wire types, regenerate and verify the checked-in schemas, TypeScript definitions, and precompiled validators:

```sh
pnpm --dir apps/desktop generate:contracts
pnpm --dir apps/desktop check:contracts
```

You can target a single domain with `--domain=<name>` (for example `--domain=project`, `--domain=execution`, `--domain=source`, `--domain=translation`, `--domain=resource`, `--domain=review`, `--domain=release`, `--domain=ai`, `--domain=arena`, `--domain=connections`, `--domain=plugins`, `--domain=strategy`, `--domain=mcp`, or `--domain=mcpRetrieval`). Contract generation uses the optional `wire-schema` Cargo feature; the desktop app never compiles schemas dynamically at runtime.

Source and translation capture ranges use half-open UTF-8 byte offsets in the raw captured file (before escape decoding or newline normalization), rather than JavaScript UTF-16 string indices. The shared fixture at `crates/core/tests/fixtures/source-unicode.contract.json` tests BOM, CRLF, CJK text, emoji, combining marks, and JSON escapes across Rust and TypeScript.

### Storage, Diagnostics, and Test Host

- **Database schema**: Current projects use SQLite schema **61** with `DELETE` journaling and `FULL` synchronization. Earlier development schemas or unsupported SQLite storage modes are refused without modifying, resetting, or auto-migrating the project directory (`PersistenceError::UnsupportedStorage` in Rust, or `unsupported-schema` with `reason: "storage-mode"` over desktop IPC). To use content from an older development snapshot, keep the old directory intact and re-import the original source files into a new project.
- **Diagnostics and recovery**: Command failures preserve structured evidence. When a save conflicts with newer state, expandable diagnostics show both the submitted and current values alongside recovery steps without automatically re-running writes. Boundary log reference IDs record only operation labels and error categories, omitting project paths and request payloads.
- **Execution test host**: Developers can test task lifecycle, cancellation, and recovery flows without configuring an external AI provider by using the isolated [Execution Test Host](docs/execution-test-host.md).

## Version and Status

The repository is currently in the unreleased **`0.2.0-alpha.1`** development batch. See the [Changelog](CHANGELOG.md) and [Versioning Policy](docs/versioning.md) for release history and compatibility rules.
