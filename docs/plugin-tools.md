# Experimental desktop read-only tools

Desktop tool queries consume the public SDK's
[read-only tool Resource](../crates/plugin-sdk/docs/tools.md) through the existing
installed package/runtime settings and Core execution ledger. The application
owns discovery, session authorization and execution consent; each package owns
its original capability, domain input/output/error contracts and guidance.

An optional SDK `query` presentation supplies a bounded fixed input template,
explicit target and category choices, and reference-result columns. The public
SDK's `createToolQuery` helper constructs original single or batch payloads and
distinguishes empty matches from malformed output. The Desktop view captures
this metadata with the original binding; it grants no execution or adoption.
In the Resource workbench, **Reference queries** provides this shared
presentation without package-specific fields. Choose an installed reference
package and approved runtime, its explicit target and meanings, then enter one
or more separate texts. Multiple providers require an explicit choice. Review
captures the exact batch before a separate per-attempt execution consent.
New input remains editable during capture and requires a fresh review; unknown
acknowledgements retain the original request, grant and expiry for checking.

The controls read complete results through the original session query owner,
associate output with captured item identities and show escaped reference
columns or an explicit empty result. A malformed result is an error, rather
than an empty match. Hidden tabs retain drafts, leaving explicitly discards the
local draft/preflight, and cancellation targets the original execution task.
No term/translation adoption is offered. Agent scope/budget orchestration and
native acceptance remain separate work.

`read_plugin_tool` accepts an exact package identity/digest, tool Resource ID
and independently approved environment digest. It reopens the installed object,
binds its actual capability, verifies supporting Resource/Skill files and matches
the executable runtime family. The resulting view includes the installed
settings revision, exact binding and independent package/runtime origins.
Discovery starts no worker and creates no execution grant.

`prepare_plugin_tool` requires an authorized project session, caller-owned
attempt ID, the exact tool choice and one or more opaque JSON `payloads`.
The application captures one fixed Core input for a single or batch query.
Core assigns item identities; use the returned item ID and payload together
rather than depending on the submitted array's order. The returned input digest
includes the selected tool, supporting package identity, environment, settings
revision and original query values. Repeating the same attempt and preparation
returns its original capture. Changing that attempt's parameters is refused.
Each project session holds one current preflight; failed preparation preserves
the previous capture, and concurrent preparation/start is refused.

The existing Core limits bound the complete fixed input to 4 MiB and at most
2,000 items. Each payload must also fit the capability's own input limit.
Generic opaque result encoding reserves eight times the declared output size
plus 16 KiB of metadata within Core's per-result maximum, with its existing
aggregate attempt limit. An unsupported declared output bound is refused rather
than silently reduced. Domain semantics remain the original worker's authority.

`start_plugin_tool` takes the reviewed attempt/input digest and the existing
strict plugin start consent: grant ID, original expiry and explicit consent to
unsandboxed execution. Before authorizing, the application reopens and compares
the captured tool and environment, then serializes its final settings revision
check with application-owned settings changes. Disabled/replaced packages,
revoked runtime decisions and changed settings require a new preparation.
Accepted asynchronous jobs retain their continuation if IPC stops waiting;
project quiescing revokes unfinished preflight tickets.
`discard_plugin_tool_preflight` discards only the named attempt's current
preflight/pending admission and preserves any original accepted start. It does
not cancel an already queued task; use the existing task cancellation command.

Execution uses the original `RunnerProxy` and Core grant/dispatch/result checks.
Single and batch queries use this same path. Repeating an accepted original
start reconciles its stored input; substituting a grant or renewing expiry for
that attempt is refused. An unknown acknowledgement retains the original action
for reconciliation. Inspect results, progress and recovery through the existing
execution commands, and cancel running tasks through their original task ID.

Results retain the actual worker channel, authorization ID and original SDK
output/error bytes. Query results stay unadopted and create no project Resource,
terminology or translation mutation. Historical output remains readable after
a provider is disabled. Tool guidance remains untrusted material. Agent
orchestration must separately satisfy scope, budget and human-control
requirements; the manual query consent does not supply Agent authority.

Rust/Serde owns these internal IPC shapes. Regenerate frontend types, schemas
and validators with `pnpm generate:contracts`; use the centralized
`pluginCommands.tool`, `executionCommands.prepareTool` and
`executionCommands.startTool` / `executionCommands.discardTool` adapters.
