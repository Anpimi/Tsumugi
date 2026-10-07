# Read-only capability tools

A Resource with `tsumugi.capability-tool-declaration` schema/behavior `1/1`
adapts one capability from the same package. It does not introduce another
executor, installation identity, model provider or permission owner. A manual
query, batch consumer or Agent can select the same original capability.

`CapabilityToolDeclaration` contains `name`, `title`, `description`,
`capabilityId`, an exact optional `profile`, `supportingResources` and an
optional `skill`. The manifest's original capability owns input/output/error
contracts, limits and permissions. The tool does not repeat or override them.
If that capability declares profiles, the adapter must explicitly select one
matching both its schema and behavior versions. A capability with no profiles
requires a null or absent profile.

The current tool contract admits only `read-only` capabilities whose requested
permissions are empty or `captured-input`. It refuses proposal/external effects,
project services, staged writes, network and child-process requests. The Host's
approved runtime and per-attempt execution consent remain separate requirements;
these data checks make no OS sandbox claim.

`parse_tool_declaration` refuses unknown and duplicate fields, invalid names,
blank or unbounded guidance, repeated Resource IDs and more than 16 supporting
Resources. The complete encoded declaration is bounded to 16 KiB; titles use a
256-byte bound and descriptions 4096 bytes. Text is retained as supplied.
`CapabilityToolDeclaration::bind` selects the original capability, verifies
Resource/Skill kinds in the actual validated manifest and retains the independently
supplied whole-package digest. Two tools with the same name remain separate
provider selections; consumers must resolve collisions explicitly.

The public Host's `PackageImage::capability_tool` reads this exact Resource
contract, binds against its immutable image and verifies all selected Resource
and Skill files are nonexecutable. Supporting Resource content stays opaque;
its consumer owns domain validation. A new package's changed support bytes yield
a new whole-package identity. A deserialized binding is a claim and must be
rebound against actual captured package bytes, never treated as authority.

Schemas, JavaScript types and the standalone structural validator are generated
from Rust through the existing `runtimes/javascript-host` contract generator.
The CLI `validate-tool-declaration` additionally applies bounded semantic checks.
Neither JSON structure nor package guidance grants tools or makes instructions
trusted. Application discovery, current component availability, execution
authorization and complete product journeys are separate integration work.
