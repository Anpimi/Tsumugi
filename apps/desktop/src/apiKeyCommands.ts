import { checkedInvoke } from "./ipc";
import * as validators from "./generated/connections.validators";
import type { ApiKeyStatus } from "./generated/connections.responses";
import { confirmConnectionReceipt, type ModelConnectionChange } from "./connectionCommands";

export const apiKeyReadKey = (reference: string) => ["model-connection-key", reference] as const;
export const apiKeyHistoryKey = (profile: string) => ["model-connection-keys", profile] as const;
function confirm(reference: string, status: ApiKeyStatus) {
  if (status.reference !== reference) throw new Error("Invalid IPC acknowledgement: API-key status");
  return status;
}
export const apiKeyCommands = {
  history: async (profileId: string) => checkedInvoke("read_model_connection_keys", { profileId }, validators.validateResponseKeyHistory),
  read: async (reference: string) => confirm(reference,
    await checkedInvoke("read_model_connection_key", { reference }, validators.validateResponseKeyStatus)),
  remove: async (reference: string) => {
    const status = confirm(reference, await checkedInvoke("remove_model_connection_key", { reference }, validators.validateResponseKeyStatus));
    if (status.availability !== "missing") throw new Error("Invalid IPC acknowledgement: API-key removal");
    return status;
  },
  save: async (change: ModelConnectionChange, secret: string) => confirmConnectionReceipt(change,
    await checkedInvoke("save_model_connection_key", { change, secret }, validators.validateResponseReceipt)),
  discard: async (change: ModelConnectionChange) => {
    const receipt = await checkedInvoke("discard_model_connection_key", change, validators.validateResponseAction);
    return receipt ? confirmConnectionReceipt(change, receipt) : null;
  },
  resume: async (change: ModelConnectionChange) => confirmConnectionReceipt(change,
    await checkedInvoke("resume_model_connection_key", change, validators.validateResponseReceipt)),
};
