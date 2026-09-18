# Tsumugi

**紡ぎ**

An extensible localization workbench for translating and maintaining evolving content.

Tsumugi keeps source content, translations, terminology, review, validation, and releases in one project, with a focus on preserving useful work as the source changes over time.

## Overview

Localization is rarely a one-off task.

Source content changes, translations are revised, terminology evolves, and previously completed work may or may not still apply.

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

When new source content is imported, existing work is compared against the new state instead of being discarded by default.

The goal is to preserve what is still applicable, identify what needs attention, and retain enough history to explain why.

## Project Model

A project is the long-lived unit of localization work.

It contains source revisions, localization units, target-locale work, terminology, review decisions, validation results, and release history.

Content identity is separate from text equality and physical location. Identical text does not necessarily represent the same content, and content that moves or changes location may still retain its identity across revisions.

Translation state is also kept separate from review, applicability, and validation.

A translation may exist without being reviewed. A reviewed translation may later require reassessment if its relevant source or context changes. Editing a translation does not silently carry forward an earlier approval.

These states remain explicit rather than being compressed into a single status.

## Maintenance

Upstream changes are handled through content lineage and dependency information.

Tsumugi can distinguish between work that:

- remains applicable
- needs validation again
- requires translation or review
- cannot be resolved automatically

Previous translations and decisions remain part of project history even when they are no longer current.

Updates therefore build on existing work instead of treating every source revision as a new project.

## Extension Model

Tsumugi separates localization semantics from domain-specific knowledge.

The Core defines project state, lifecycle rules, authoritative decisions, and the boundaries through which additional capabilities participate.

Extensions provide bounded capabilities through explicit contracts. A single extension may provide several related capabilities, while others may contribute only data or reusable resources.

Extensions do not own the project model. Their results are returned to the Core, validated, and adopted through the same rules as other project changes.

Public extension contracts remain separate from internal storage and implementation details. Executable extensions communicate through language-neutral boundaries and are not tied to the implementation language of the Core.

The goal is to support different localization domains without turning each integration into its own workflow or source of truth.

## AI

AI is optional.

It may produce translation candidates, review signals, comparisons, contextual findings, or other structured results.

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

Validation therefore applies not only to translation state but also to the artifact that was actually produced.

A failed build does not become a release, and a failed delivery attempt does not erase an already recorded release.

## Architecture

The current reference architecture is:

```text
React + TypeScript
        │
      Tauri
        │
    Rust Core
        │
Capability Protocol
        │
Workers / Data Extensions / External Tools
```

The desktop interface requests operations but does not own authoritative state transitions.

The Core owns project semantics, persistence, orchestration, result adoption, and release state.

Long-running or domain-specific operations can run outside the Core through bounded capability contracts.

Public contracts are intended to remain independent from the Rust ABI.

## Development

The first desktop scaffold targets Windows x64 and uses Rust 1.98+, React 19, TypeScript 7, Vite 8, Tauri 2, and pnpm 12. The native Windows build requires Visual Studio C++ Build Tools, a Windows SDK, and the Microsoft Edge WebView2 Runtime.

From the repository root:

```text
pnpm install
pnpm --dir apps/desktop build
cargo test --workspace
pnpm --dir apps/desktop tauri dev
```

The current shell does not expose lifecycle controls yet. The Tauri host now provides the internal project lifecycle command boundary; user-facing project behavior is delivered by the following foundation tasks.

## Status

Tsumugi is in early development.

Current work is focused on the foundations required for complete localization workflows:

- project and language boundaries
- content identity and lineage
- translation and review state
- dependency and impact analysis
- task execution and result adoption
- build and release semantics
- extension contracts
- persistence and recovery

Detailed APIs, storage schemas, transport protocols, and stable public extension contracts are still under design.

There is no stable plugin API yet.
