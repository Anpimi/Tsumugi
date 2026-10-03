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

The first desktop scaffold targets Windows x64 and uses Rust 1.98+, React 19, TypeScript 7, Vite 8, Tauri 2, and pnpm 12. The native Windows build requires Visual Studio C++ Build Tools, a Windows SDK, and the Microsoft Edge WebView2 Runtime.

Project lifecycle, command error, change notification, execution and source content DTOs use the Rust/Serde definitions as their wire source. After changing these definitions, run `pnpm --dir apps/desktop generate:contracts`; `pnpm --dir apps/desktop check:contracts` verifies that the checked-in schemas, TypeScript types and precompiled validators are current. Generation is partitioned by domain; add `--domain=project`, `--domain=execution` or `--domain=source` for a focused update or check. The optional `wire-schema` Cargo feature is used for generation; the application does not compile schemas dynamically. Other workbench DTOs are still being migrated.

From the repository root:

```text
pnpm install
pnpm --dir apps/desktop build
cargo test --workspace
pnpm --dir apps/desktop tauri dev
```

For a standalone Windows executable without an installer, run:

```text
pnpm --dir apps/desktop tauri build --no-bundle
```

Launch `target/release/tsumugi-desktop.exe` directly. This build embeds the frontend and does not need a development server or console window. The Microsoft Edge WebView2 Runtime is still required. `tauri dev` and debug builds retain the development console.

The desktop workbench suppresses page reload, browser navigation, printing, page-source and page-save shortcuts so they cannot bypass the editing workflow. Ctrl+S still belongs to the active editor. Text fields retain their native editing menus; other text can be selected and copied with Ctrl+C. The navigation and toolbar stay in place while the workspace scrolls.

The desktop shell supports creating, opening, renaming, closing, and reconciling local projects, adding target locales, importing source content, managing translation revisions, working with project terminology and context, reviewing current translations, and building verified SMAPI language files for local export. These operations use Tauri commands.

The sidebar opens each working area in the main workspace. Returning to another area preserves its project-local position and drafts; leaving an unsaved translation first offers save, keep editing, or discard. The project overview shows import or continue-editing actions according to the current source. Translations opens the editor by default, with a searchable paged list alongside source text, translation and revision controls. Search covers native keys, source text and selected translations across the complete current source, including entries beyond the displayed page. Terms, context and history are available in a collapsible reference area.

The Tasks view exposes persisted execution progress, saved outputs, cancellation, eligible recovery, and explicit result adoption. Normal builds have no synthetic task creation menu. Developers can use the isolated [execution test host](docs/execution-test-host.md) to exercise these paths without a translation provider.

The Source content view imports a SMAPI Mod's `manifest.json` and flat `i18n/default.json` through the bundled integration. Declare the source language, check the files, review the saved strings, and explicitly apply a complete snapshot. Existing projects can compare and adopt a new complete source snapshot while retaining earlier content and releases. Original files remain unchanged. See [supported inputs and recovery](docs/source-import.md). The Translations view imports a flat `i18n/<language>.json`, previews matches against the current source, creates candidates or checked selections, and saves immutable manual revisions. See [translation import and editing](docs/translation-import.md). Glossary and context lets you edit adopted terms, review a local glossary file one entry at a time, capture context, inspect translation suggestions, and locate potentially affected translations. See [glossary and context](docs/resources.md). Review and QA records human decisions, runs current checks, shows work by language, and assesses build readiness under the balanced policy; see [review and QA](docs/review-qa.md). Build and export turns approved translations into verified local SMAPI language files; see [local build and export](docs/build-release.md). Packaging or installing complete Mods is not implemented.

AI translation supports an editable OpenAI-compatible Chat Completions endpoint, model, credential environment variable name, and budget. Connection presets remain editable. Source text is required; terms and context are shared only when enabled. Preview and confirm the exact data before sending. Successful results can be saved as candidates, then compared and selected in Translations. Partial failures retain successful results; starting new requests requires a fresh preview and budget. See [direct AI translation](docs/ai-translation.md).

Arena comparison generates two to four schemes under a shared round budget or compares saved revisions offline. Optional blind comparison keeps fixed anonymous labels until an explicit reveal. Save candidates, select a revision or edit an atomic manual merge with contributing provenance, then continue normal Review and QA. See [AI translation and Arena comparison](docs/ai-translation.md).

New projects use database schema 11. Valid schema 3 through 10 projects are backed up in their project directory and upgraded when opened. Other schema versions are rejected without resetting the directory. The application is in the unreleased `0.2.0-alpha.1` development batch. See the [changelog](CHANGELOG.md) and [versioning policy](docs/versioning.md) for changes, compatibility and future version decisions.

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
