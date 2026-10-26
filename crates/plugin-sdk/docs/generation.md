# Work-Plan Generation Service Contracts

The `tsumugi.work-plan-generation` service (`1/1`) allows an authorized generation component to enqueue model generation tasks for a subset of source units within an active application `WorkPlan`. A companion component input contract, `tsumugi.generation-component-input` (`1/1`), bundles a generation request with pre-authorized read-only tool queries.

## Service Binding (`tsumugi.work-plan-generation`)

When binding a `ProjectService` handle for work-plan generation, the Host's `ServiceBinding` must match these exact contract identifiers (`validate_generation_service_binding`):

| Field | Contract ID | Schema / Behavior |
| --- | --- | --- |
| `contract` | `tsumugi.work-plan-generation` | `1/1` |
| `inputSchema` | `tsumugi.work-plan-generation-input` | `1/1` |
| `outputSchema` | `tsumugi.work-plan-generation-receipt` | `1/1` |
| `errorSchema` | `tsumugi.work-plan-generation-error` | `1/1` |

Because enqueuing generation sends source text to the plan's approved external model endpoint, the service has an `external` effect. The calling component must declare the matching `project-service` permission and hold an active execution grant for the current `WorkPlan`.

## Request, Receipt, and Error Payloads

### `GenerationServiceInput` (`parse_generation_service_input`)

`GenerationServiceInput` contains exactly three fields and is bounded to 16 KiB of JSON:

```json
{
  "taskId": "00000000-0000-4000-8000-000000000001",
  "attemptId": "00000000-0000-4000-8000-000000000002",
  "unitIds": ["00000000-0000-4000-8000-000000000003"]
}
```

- `taskId` and `attemptId`: ASCII identifiers (up to 128 bytes) identifying the child task and attempt to enqueue.
- `unitIds`: 1 to 100 unique source unit IDs (each up to 128 ASCII bytes) belonging to the outer `WorkPlan`.
- Unknown or extra fields (such as custom prompts, model overrides, or budget adjustments) are rejected. The Host adapter resolves all unit text, model parameters, endpoint credentials, data-sharing rules, and ancestor budgets directly from the authoritative `WorkPlan`.

When sent over a process channel's `ServiceRequest` frame, the outer invocation context's `inputDigest` continues to identify the outer component's invocation payload, while the `ServiceRequest` payload digest identifies the serialized `GenerationServiceInput`.

### `GenerationServiceReceipt` (`parse_generation_service_receipt`)

A successful call returns a `GenerationServiceReceipt` (up to 1 KiB) containing `taskId`, `attemptId`, and `inputDigest` (the SHA-256 digest of the child execution input recorded in the application ledger). `receipt.validate_against(&input)` verifies that `taskId` and `attemptId` match the request.

The service callback returns as soon as the child task is durably enqueued in the ledger, without blocking the worker process on model completion. The Host adapter keeps the caller's authority, `WorkPlan` scope, revocation listeners, and original deadline attached to the child task until it finishes.

### `GenerationServiceError` (`parse_generation_service_error`)

Service errors are bounded to 1 KiB and carry a single `code` field:

- `invalid-input`
- `unavailable`
- `permission-denied`
- `cancelled`
- `limit-exceeded`
- `conflict`
- `busy`
- `storage-failed`
- `outcome-unknown`

If a service call fails with `outcome-unknown` or the channel closes before a reply arrives, the caller or Host must reconcile the original `(taskId, attemptId)` against the ledger rather than blindly submitting a new child identity.

## Prepared Component Tool Queries (`tsumugi.generation-component-input`)

When a `WorkPlan` configures a `Project`- or `Attempt`-scoped JavaScript generation component alongside read-only query tools, the component receives `tsumugi.generation-component-input` (`1/1`, up to 1 MiB encoded):

- `generation`: the `GenerationServiceInput` (`taskId`, `attemptId`, `unitIds`).
- `preparedTools`: an array of 0 to 15 pre-built tool query descriptors, each containing a unique `handleId`, `callId`, `toolHandle`, and `input: EncodedPayload`.

Each entry in `preparedTools` is constructed ahead of time by Core's tool preparation pipeline for a selected source unit and disclosed in the user's execution preview. Supported tools include read-only `Project` JavaScript tools and read-only `Application` tools (JavaScript multi-capability rosters or Native singletons, which require their own independent instance lifetime consent).

### Executing Prepared Queries from JavaScript

Inside an `api.register(contributionId, handler)` callback on the JavaScript Host:

1. To run a prepared tool query, call `metadata.services.call(entry.handleId, entry.input.utf8, entry.callId)`. The Host verifies that `handleId`, `input.utf8`, and `callId` match the prepared descriptor for the active caller before dispatching the tool under its own binding and grant.
2. To enqueue the generation task, call the `tsumugi.work-plan-generation` service with `JSON.stringify(input.generation)` and return the resulting `GenerationServiceReceipt` from the handler. Tool query outputs are reference data only and cannot be returned in place of a `GenerationServiceReceipt`.

Rust consumers parse this input with `parse_generation_component_input`, and the `tsumugi-plugin-contract` CLI provides `schema-generation-component-input` and `validate-generation-component-input` (which generate `javascript/generation-component.d.ts` and its standalone validator).
