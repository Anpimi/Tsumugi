import { invoke } from "@tauri-apps/api/core";

/** Decode results at the transport boundary. A malformed ACK remains unknown. */
export async function checkedInvoke<T>(command: string, request: unknown, validate: (value: unknown) => value is T): Promise<T> {
  const result = await invoke<unknown>(command, { request });
  if (!validate(result)) throw new Error(`Invalid IPC response: ${command}`);
  return result;
}
