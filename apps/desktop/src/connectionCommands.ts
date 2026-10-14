import { checkedInvoke } from "./ipc";
import * as validators from "./generated/connections.validators";
import type { ModelConnectionChange, ConnectionActionRequest, ConnectionResolveRequest } from "./generated/connections.requests";
import type { ConnectionReadView, ModelConnectionSnapshot, ModelConnectionReceipt, AiConnection } from "./generated/connections.responses";
export type { ModelConnectionChange, ConnectionActionRequest, ConnectionResolveRequest } from "./generated/connections.requests";
export type { ConnectionReadView, ModelConnectionProfile, ModelConnectionReference, ModelConnectionReceipt, AiConnection } from "./generated/connections.responses";

const digest = (value: string) => /^[0-9a-f]{64}$/.test(value);
function invalid(): never { throw new Error("Invalid IPC acknowledgement: model connections"); }
function snapshotValid(value: ModelConnectionSnapshot): boolean {
  if (value.revision === "0") return value.storeId === null && value.lastActionId === null && value.profiles.length === 0;
  if (!value.storeId || !value.lastActionId || value.profiles.length === 0 || value.profiles.length > 64) return false;
  const names = new Set<string>();
  return value.profiles.every((profile, index) => {
    if (BigInt(profile.revision) === 0n || BigInt(profile.revision) > BigInt(value.revision)
      || (index > 0 && value.profiles[index - 1].id >= profile.id)
      || !profile.name.trim() || Array.from(profile.name).length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(profile.name)
      || (!profile.archived && names.has(profile.name))) return false;
    if (!profile.archived) names.add(profile.name);
    return true;
  });
}
function confirmView(view: ConnectionReadView): ConnectionReadView {
  const { snapshot, basis, references } = view;
  const active = snapshot.profiles.filter(profile => !profile.archived);
  if (!snapshotValid(snapshot) || basis.storeId !== snapshot.storeId || basis.revision !== snapshot.revision || !digest(basis.digest)
    || references.length !== active.length || references.some((reference, index) => reference.storeId !== snapshot.storeId
      || reference.profileId !== active[index].id || reference.revision !== active[index].revision || !digest(reference.digest))) invalid();
  return view;
}
function sameConnection(a: AiConnection, b: AiConnection): boolean {
  return a.endpoint === b.endpoint && a.model === b.model && a.credentialEnv === b.credentialEnv && a.tokenField === b.tokenField;
}
/** Check the original request's result, including a historical exact replay.
 * A receipt does not claim to be the current settings snapshot or grant consent. */
export function confirmConnectionReceipt(request: ModelConnectionChange, receipt: ModelConnectionReceipt): ModelConnectionReceipt {
  const { snapshot } = receipt;
  const profile = snapshot.profiles.find(profile => profile.id === request.edit.profileId);
  if (!snapshotValid(snapshot) || receipt.actionId !== request.actionId || snapshot.lastActionId !== request.actionId
    || !digest(receipt.requestDigest) || !snapshot.storeId || BigInt(snapshot.revision) !== BigInt(request.expected.revision) + 1n
    || (request.expected.storeId != null && snapshot.storeId !== request.expected.storeId) || !profile) invalid();
  if (request.edit.kind === "save") {
    if (profile.name !== request.edit.name || !sameConnection(profile.connection, request.edit.connection)) invalid();
  } else if (profile.archived !== (request.edit.kind === "archive")) invalid();
  return receipt;
}

export const connectionCommands = {
  read: async () => confirmView(await checkedInvoke("read_model_connections", {}, validators.validateResponseSnapshot)),
  change: async (request: ModelConnectionChange) => confirmConnectionReceipt(request,
    await checkedInvoke("change_model_connections", request, validators.validateResponseReceipt)),
  action: async (request: ConnectionActionRequest) => {
    const receipt = await checkedInvoke("read_model_connection_action", request, validators.validateResponseAction);
    if (receipt && (receipt.actionId !== request.actionId || receipt.snapshot.lastActionId !== request.actionId
      || !digest(receipt.requestDigest) || !snapshotValid(receipt.snapshot))) invalid();
    return receipt;
  },
  resolve: (request: ConnectionResolveRequest) => checkedInvoke("resolve_model_connection", request, validators.validateResponseConnection),
};
