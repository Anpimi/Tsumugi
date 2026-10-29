import { checkedInvoke } from "./ipc";
import { jsonIdentity } from "./pluginToolChoices";
import type { Requests } from "./generated/draft.requests";
import type { Responses, StrategyDraftPending, StrategyDraftValue } from "./generated/draft.responses";
import * as validators from "./generated/draft.validators";

export type { StrategyDraftHead, StrategyDraftValue, StrategyDraftPending } from "./generated/draft.responses";
export type StrategyDraftWriteRequest = Requests["strategyWrite"];
export type StrategyDraftResolveRequest = Requests["strategyResolve"];
type Head = Responses["strategyRead"];
const same = (a: unknown, b: unknown) => jsonIdentity(a) === jsonIdentity(b);
export type StrategyNumberDrafts = NonNullable<StrategyDraftValue["numberDrafts"]>;
type StrategyDraftNumber = keyof StrategyNumberDrafts;
type StoredValue = StrategyDraftValue | StrategyDraftWriteRequest["write"]["value"];
type StoredPending = NonNullable<StoredValue["pending"]>;
type NumericInput = Pick<StrategyDraftValue, "config" | "sourceContext">;
type ConfigNumber = "maxItems" | "concurrency" | "maxRequests" | "maxOutputTokens" | "maxRetries" | "timeoutSeconds";
function configNumber(field: StrategyDraftNumber, key: ConfigNumber) {
  return { field, read: (value: NumericInput) => value.config[key], write: (value: NumericInput, number: number) => { value.config[key] = number; } };
}
function contextNumber(field: StrategyDraftNumber, key: "maxBytes" | "maxItems") {
  return { field, read: (value: NumericInput) => value.sourceContext[key], write: (value: NumericInput, number: number) => { value.sourceContext[key] = number; } };
}
const numberFields = [contextNumber("source-context-max-bytes", "maxBytes"), contextNumber("source-context-max-items", "maxItems"),
  configNumber("config-max-items", "maxItems"), configNumber("config-concurrency", "concurrency"), configNumber("config-max-requests", "maxRequests"),
  configNumber("config-max-output-tokens", "maxOutputTokens"), configNumber("config-max-retries", "maxRetries"), configNumber("config-timeout-seconds", "timeoutSeconds")];
/** Keep the actual unfinished input apart from its last representable storage basis. */
export function strategyNumberDrafts(before: NumericInput, after: NumericInput, previous: StrategyNumberDrafts): StrategyNumberDrafts {
  const drafts = { ...previous };
  for (const field of numberFields) {
    const value = field.read(after);
    if (Number.isInteger(value) && value >= 0 && value <= 4_294_967_295) delete drafts[field.field];
    else drafts[field.field] = { text: Number.isFinite(value) ? String(value) : "", previous: previous[field.field]?.previous ?? field.read(before) };
  }
  return drafts;
}
export function restoredStrategyNumbers(value: StrategyDraftValue): NumericInput {
  const restored = { config: { ...value.config }, sourceContext: { ...value.sourceContext } };
  for (const field of numberFields) {
    const draft = value.numberDrafts?.[field.field];
    if (draft) field.write(restored, draft.text.trim() ? Number(draft.text) : Number.NaN);
  }
  return restored;
}
function config<T extends StrategyDraftValue["config"]>(value: T): T {
  const copy = { ...value };
  if (copy.connectionProfile == null) delete copy.connectionProfile;
  if (copy.chatgptAccount == null) delete copy.chatgptAccount;
  return copy;
}
function suite<T extends NonNullable<StoredValue["suite"]>>(value: T): T {
  const copy = structuredClone(value);
  copy.request.config = config(copy.request.config);
  copy.preview.config.variants.forEach((variant, index) => { copy.preview.config.variants[index] = config(variant); });
  return copy;
}
/** Match the existing AiConfig Serde omission for absent optional provenance. */
export function canonicalStrategyPending<T extends StoredPending>(pending: T): T {
  const copy = structuredClone(pending);
  if (copy.kind === "suite") copy.request.capture.config = config(copy.request.capture.config);
  if (copy.kind === "prepare") copy.suite = suite(copy.suite);
  return copy;
}
export function canonicalStrategyDraft<T extends StoredValue>(value: T): T {
  const projected = structuredClone(value), numberDrafts = projected.numberDrafts;
  projected.config = config(projected.config);
  if (projected.suite) projected.suite = suite(projected.suite);
  if (projected.pending) projected.pending = canonicalStrategyPending(projected.pending);
  for (const field of numberFields) {
    const draft = numberDrafts?.[field.field];
    if (draft) field.write(projected, draft.previous);
  }
  if (!numberDrafts || !Object.keys(numberDrafts).length) delete projected.numberDrafts;
  return projected;
}

function head(value: Head, projectId: string) {
  return value.key.projectId === projectId && (value.value === null ? value.writerId === null : value.writerId !== null && BigInt(value.revision) > 0n);
}
function written(value: Head, write: StrategyDraftWriteRequest["write"]) {
  return head(value, write.key.projectId) && value.writerId === write.writerId && same(value.value, canonicalStrategyDraft(write.value))
    && BigInt(value.revision) > BigInt(write.expectedRevision);
}
export function strategyPendingActionId(pending: StrategyDraftPending): string {
  switch (pending.kind) {
    case "candidate": case "suite": case "prepare": return pending.request.capture.actionId;
    case "judgment": return pending.request.judgment.actionId;
    case "promote": return pending.request.promotion.actionId;
    case "withdraw": return pending.request.withdrawal.actionId;
    case "save-candidate": return pending.request.actionId;
    case "prepare-check": return pending.request.check.actionId;
    case "check": return pending.request.check.check.actionId;
    case "start": return pending.request.attemptId;
  }
}

/** The shared local journal retains input, never execution authority. */
export const strategyDraftCommands = {
  action: (input: Requests["strategyAction"]) => {
    const request = structuredClone(input);
    return checkedInvoke("read_local_strategy_action", request,
      (value): value is Responses["strategyAction"] => validators.validateResponseStrategyAction(value) && same(value.pending, request.pending)
        && (value.disposition !== "rejected" || !!value.rejection));
  },
  close: (input: Requests["strategyClose"]) => {
    const request = structuredClone(input);
    return checkedInvoke("close_local_strategy_action", request,
      (value): value is Responses["strategyClosed"] => validators.validateResponseStrategyClosed(value) && same(value.pending, request.pending)
        && (value.disposition !== "rejected" || !!value.rejection));
  },
  read: (request: Requests["strategyRead"]) => checkedInvoke("read_local_strategy_draft", request,
    (value): value is Head => validators.validateResponseStrategyRead(value) && head(value, request.key.projectId)),
  write: (input: StrategyDraftWriteRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("write_local_strategy_draft", request,
      (value): value is Head => validators.validateResponseStrategyWritten(value) && written(value, request.write));
  },
  resolve: (input: StrategyDraftResolveRequest) => {
    const request = structuredClone(input);
    return checkedInvoke("resolve_local_strategy_draft", request,
      (value): value is Head => validators.validateResponseStrategyResolved(value) && written(value, request.resolve.write) && value.value?.pending === null);
  },
};
