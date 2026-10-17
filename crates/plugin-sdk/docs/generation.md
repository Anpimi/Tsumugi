# Work-plan generation service data

The experimental `tsumugi.work-plan-generation` service uses schema/behavior
`1/1`. Its data interface refers to an already authorized application WorkPlan.
The SDK owns the public data shapes and parsers; it has no Core, project database,
model, credential, queue or authorization dependency. An application adapter owns
actual component selection, per-dispatch service scope, child execution and its
authorized effects. These data contracts do not establish that adapter's runtime
or native product acceptance.

A Host adapter must select the exact service provider, handle, project, scope, activation
generation and configuration digest in the existing `ServiceBinding`. The
descriptor's input, output and error references must be:

| Field | Contract | Schema/behavior |
| --- | --- | --- |
| `contract` | `tsumugi.work-plan-generation` | `1/1` |
| `inputSchema` | `tsumugi.work-plan-generation-input` | `1/1` |
| `outputSchema` | `tsumugi.work-plan-generation-receipt` | `1/1` |
| `errorSchema` | `tsumugi.work-plan-generation-error` | `1/1` |

Its effect is `external`: generation can send the original captured source to
the plan's already approved model destination. The ordinary outer component
needs its own matching `project-service` permission and explicit execution grant.
Read-only tool consent cannot authorize this call. A selected descriptor or a
valid payload grants no permission, opens no plan scope and renews no authority.

`GenerationServiceInput` has exactly three fields:

```json
{
  "taskId": "00000000-0000-4000-8000-000000000001",
  "attemptId": "00000000-0000-4000-8000-000000000002",
  "unitIds": ["00000000-0000-4000-8000-000000000003"]
}
```

The SDK bounds identifiers to 128 ASCII bytes and requires 1–100 distinct source
unit IDs. The actual input, including whitespace, is at most 16 KiB. A Host adapter must
resolve these identities against the exact original project and plan; SDK
syntax validation cannot prove membership. The adapter must derive source text, model,
configuration, destination, sharing, effects, current authority and cumulative
ancestor budget from that original plan. Extra fields, including payload,
configuration, lease, consent or budget overrides, are refused.

The existing process `ServiceRequest` carries the original outer invocation
context and a separate `EncodedPayload` for this input. Its context input digest
identifies the encoded outer item payload, rather than the complete application
execution envelope. The service payload SHA identifies these generation bytes;
the digests have different meanings.

A successful `GenerationServiceReceipt` contains only `taskId`, `attemptId` and
`inputDigest`, where the digest identifies the actual captured child execution
input. It is at most 1 KiB. `validate_against` checks its child identities against
the original proposed input. The receipt says the original ledger accepted that
child. A repeated call may already be terminal: it does not promise that a model
request is currently queued, that generation finished, or that a candidate was
adopted. It exposes no grant, lease, credential or renewal handle.

`GenerationServiceError` is at most 1 KiB and has one `code` field:
`invalid-input`, `unavailable`, `permission-denied`, `cancelled`, `limit-exceeded`,
`conflict`, `busy`, `storage-failed` or `outcome-unknown`. Unknown codes and extra
diagnostic, authority or retry fields are refused. The existing `ServiceResponse`
preserves failed versus unknown outcomes and original call association. A lost
reply or an uncertain enqueue is not proof that nothing happened. Reconcile the
original call identity against the original ledger; do not automatically submit
a new call or replace its child identities.

An application service callback must return after bounded enqueue/receipt work,
without waiting for model completion. Its adapter must retain the actual caller,
original ordinary grant, WorkPlan scope, installed-settings revocation and
original absolute deadline through child execution and authorized effects.
Closing the component channel cannot discard that authority association while
its children or effects remain unsettled. Historical receipts cannot reconstruct
live authority.

Rust consumers use `parse_generation_service_input`,
`parse_generation_service_receipt`, `parse_generation_service_error` and
`validate_generation_service_binding`. Schemas and JavaScript types/standalone
validators are generated from that same Rust definition through the existing
contract harness and `runtimes/javascript-host` generator. JavaScript structural
validation does not replace Host identity, permission or scope checks.

## Prepared component tool queries

`tsumugi.generation-component-input` schema/behavior `1/1` is a separate input
contract for an explicitly selected generation component. It contains
`generation: GenerationServiceInput` and `preparedTools`, an array of at most
15 entries. Each entry contains `handleId`, `callId`, `toolHandle` and the exact
`EncodedPayload` input. Handles, call IDs and tool handles must each be unique;
the complete JSON encoding, including escaped payload text, is at most 1 MiB.
An empty array is valid. The old generation-service input keeps exactly its
original three fields and is not implicitly upgraded.

The Desktop adapter supports Project and Attempt JavaScript callers and selected read-only
Project JavaScript or supported Application query tools from the same
human-authorized WorkPlan. Application tools retain their existing JavaScript
capability roster or Native singleton profile. Their exact instance and complete
roster need independent lifetime consent; the normal WorkPlan tool grant remains
separate. The original instance owner finishes the real activation handshake
before the caller starts. Cancelling an Application query retires that shared
instance, including its queued calls, rather than replacing it under an old plan.
It prepares each query for one selected source unit through the original Core
tool preparation. The preview shows the exact query content shared with both
components. A caller's process consent cannot replace the tool's independent
WorkPlan consent, grant, original deadline or budget. Neither payloads nor
`toolHandle` values are execution authority.

The normal `api.register` handler receives this input. For a prepared entry it
can call `metadata.services.call(entry.handleId, entry.input.utf8, entry.callId)`.
The Host matches all three values and the original caller, and dispatches the
selected tool through the original Core runtime and ledger. The response retains
the tool's own output/error schema. Transport or authorization failures do not
invent a payload under that schema. A service provider ID is a Host-selected
index; the original prepared tool binding determines the actual package,
capability, profile and environment.

Tool results are query data. A generation component still calls the original
`tsumugi.work-plan-generation` service with `JSON.stringify(input.generation)`
and returns its real generation receipt. A query result must never be presented
as that receipt. The Host retains the tool's exact caller association until its
actual producer is terminal and reaped; cancellation and channel closure request
withdrawal rather than claiming rollback or immediate drainage. Historical
receipts do not restore live consent after reopening.

Rust consumers use `parse_generation_component_input`. The contract harness
exports `schema-generation-component-input` and
`validate-generation-component-input`; the existing generator produces
`generation-component.d.ts` and its standalone structural validator from Rust.

An explicitly declared component input can also be used by an Attempt JavaScript
caller. Its captured query-service descriptors use that exact outer attempt;
the selected tool still executes with its own Project or Application binding
and independent grant. Legacy generation input retains its original service
shape. Application callers and recursively assembled dependency graphs remain
unsupported by this prepared-tool path.
