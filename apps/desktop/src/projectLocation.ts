import { sep } from "@tauri-apps/api/path";

export function previewDestination(parentDirectory: string, directoryName: string): string {
  const parent = parentDirectory.trim(), child = directoryName.trim();
  return parent && child ? `${parent.replace(/[\\/]+$/, "")}${sep()}${child}` : "";
}

export function isSafeChildDirectoryName(value: string): boolean {
  const child = value.trim();
  if (!child || child !== value || child === "." || child === "..") return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(child) || /[. ]$/.test(child)) return false;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(child);
}
