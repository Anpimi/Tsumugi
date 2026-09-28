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

From the repository root:

```text
pnpm install
pnpm --dir apps/desktop build
cargo test --workspace
pnpm --dir apps/desktop tauri dev
```

The desktop shell supports creating, opening, renaming, closing, and reconciling local projects, adding target locales, importing source content, managing translation revisions, working with project terminology and context, and reviewing current translations with deterministic pre-build checks. These operations use Tauri commands. Artifact validation and release workflows are planned for later development.

The Tasks view exposes persisted execution progress, saved outputs, cancellation, eligible recovery, and explicit result adoption. Normal builds have no synthetic task creation menu. Developers can use the isolated [execution test host](docs/execution-test-host.md) to exercise these paths without a translation provider.

The Source content view imports a SMAPI Mod's `manifest.json` and flat `i18n/default.json` through the bundled integration. Declare the source language, check the files, review the saved strings, and explicitly apply the complete first snapshot. Original files remain unchanged. See [supported inputs and recovery](docs/source-import.md). The Translations view imports a flat `i18n/<language>.json`, previews matches against the current source, creates candidates or checked selections, and saves immutable manual revisions. See [translation import and editing](docs/translation-import.md). Glossary and context lets you edit adopted terms, review a local glossary file one entry at a time, capture context, inspect translation suggestions, and locate potentially affected translations. See [glossary and context](docs/resources.md). Review and QA records human decisions, runs current checks, shows work by language, and assesses build readiness under the balanced policy; see [review and QA](docs/review-qa.md). Replacing existing source content and building translated Mods are not implemented.

New projects use database schema 7. Valid schema 3, 4, 5, and 6 projects are backed up in their project directory and upgraded when opened. Other schema versions are rejected without resetting the directory. The application remains in the unreleased 0.1.0 development batch.

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
