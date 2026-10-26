import { checkedInvoke } from "./ipc";
import * as validators from "./generated/connections.validators";
export type { ChatGptAccountStatus, ChatGptLoginView, ChatGptModelCatalog } from "./generated/connections.responses";

/** Credentials remain in the native account owner. These commands expose only
 * account references, local login status and an explicitly requested catalog. */
export const chatGptCommands = {
  read: () => checkedInvoke("read_chatgpt_account", {}, validators.validateResponseChatGptStatus),
  begin: (registration: string | null) => checkedInvoke("begin_chatgpt_login", { registration }, validators.validateResponseChatGptLogin),
  cancel: (sessionId: string) => checkedInvoke("cancel_chatgpt_login", { sessionId }, validators.validateResponseChatGptStatus),
  logout: (account: string) => checkedInvoke("logout_chatgpt_account", { account }, validators.validateResponseChatGptStatus),
  retryStorage: () => checkedInvoke("retry_chatgpt_storage", {}, validators.validateResponseChatGptStatus),
  models: (account: string) => checkedInvoke("read_chatgpt_models", { account }, validators.validateResponseChatGptCatalog),
};
