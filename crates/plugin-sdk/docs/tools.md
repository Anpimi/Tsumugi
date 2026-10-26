# Read-Only Capability Tools

A non-executable JSON resource with schema `tsumugi.capability-tool-declaration` (`1/1`) exposes a read-only capability from the same plugin package as a reusable query tool for manual reference lookups, batch preparation, or Agent tool calls.

## Tool Declaration and Binding (`CapabilityToolDeclaration`)

`CapabilityToolDeclaration` (up to 16 KiB encoded) contains:

- `name`, `title` (up to 256 UTF-8 bytes), and `description` (up to 4,096 UTF-8 bytes).
- `capabilityId`: the target capability contribution ID in the same package.
- `profile`: an exact `ContractRef` (required if the target capability declares supported profiles; must be `null` or omitted if the capability has no profiles).
- `supportingResources`: up to 16 unique non-executable `Resource` contribution IDs in the same package.
- `skill`: an optional non-executable `Skill` contribution ID in the same package.
- `query`: an optional structured presentation and payload template (`ToolQueryDeclaration`).

The target capability retains ownership of its input, output, and error schemas, resource limits, and permissions:

- Only capabilities with a `read-only` project effect and either empty permissions or `captured-input` permission are accepted. Capabilities requesting `proposal` or `external` effects, `project-service` access, staged writes, network access, or subprocess execution are rejected.
- `parse_tool_declaration` validates field bounds and rejects unknown or duplicate fields, invalid tool names, blank text, and duplicate resource IDs.
- `CapabilityToolDeclaration::bind` resolves the capability, supporting resources, and skill against the package's `ValidatedManifest` and attaches the package digest. When staging a package, the Host verifies that all referenced resource and skill files are non-executable.

Schema generation and CLI validation are driven by the Rust definition (`validate-tool-declaration`).

## Host-Rendered UI Selector (`reference-query` Slot)

A manifest `Ui { slot, schema }` contribution (owned by a JavaScript component) can target the Host's `reference-query` slot with schema `tsumugi.capability-tool-declaration` (`1/1`). To bind cleanly in the Host, that component and package must own exactly one matching tool resource declaration, its referenced query capability, and a `query` presentation block (`ToolQueryDeclaration`). Ambiguous multi-resource bindings are rejected rather than resolved by manifest order.

## Structured Query Presentation (`ToolQueryDeclaration`)

Adding a `query` object to `CapabilityToolDeclaration` allows the Host to render a structured reference lookup UI and construct capability payloads without executing arbitrary plugin UI scripts or custom HTML/CSS:

- `inputTemplate`: a fixed JSON template (fitting within the capability's `maxInputBytes`) pre-populated with package data such as resource SHA-256 pins.
- `inputSchema` and `outputSchema`: must match the underlying capability's schemas (`1/1`).
- `textPath` and `maxTextBytes`: a path into `inputTemplate` where the user's query string is inserted, bounded by `maxTextBytes` (which cannot exceed `maxInputBytes`).
- Target and category/sense selectors: one explicit single-value target selector and one multi-value category/sense selector, each specifying its path in `inputTemplate`, allowed option values, labels, descriptions, and selection count bounds (up to 64 options total).
- Result columns: up to 8 columns, with an output array path (up to 128 result entries per response) and per-column string field paths.

### Path Rules

Template and output paths are arrays of 1 to 8 object keys or zero-based array indices (for example, `["queries", 0, "text"]`):

- Every path in `inputTemplate` must point to an already existing placeholder value of the matching type (string for text and target; array for category selections).
- The text, target, and category paths must not overlap.
- Disallowed keys (`__proto__`, `constructor`, `prototype`), control characters, and out-of-bounds indices are rejected.

### Constructing Payloads and Extracting Rows

- **JavaScript (`javascript/tool-query.mjs`)**: `createToolQuery(binding)` returns `{ prepare, entries }`:
  - `prepare({ text, target, selections })` validates the user input against `maxTextBytes`, the allowed selector options, and the capability's complete encoded `maxInputBytes` ceiling (including JSON escaping), returning a fresh payload object with all fixed template fields preserved.
  - `entries(output)` extracts the declared string columns from a capability response (rejecting missing, wrongly typed, or >128-entry outputs) without interpreting HTML or links.
  - Validation failures throw `ToolQueryError` with a stable `code` and `field` for UI localization.
- **Rust**: `ToolQueryDeclaration::prepare_payload(text, target, selections, max_input_bytes)` performs the identical template substitution and byte-budget validation in Rust.
