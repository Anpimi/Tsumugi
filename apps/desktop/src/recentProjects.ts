import type { ProjectView } from "./projectCommands";

export interface RecentProject {
  locator: string;
  lastOpenedAt: number;
}

export const RECENT_PROJECTS_STORAGE_KEY = "tsumugi.recentProjects";
export const LAST_OPEN_PROJECT_STORAGE_KEY = "tsumugi.lastOpenProject";
export const MAX_RECENT_PROJECTS = 5;

export function normalizeLocator(locator: string): string {
  let trimmed = locator.trim().replace(/\//g, "\\");
  if (!trimmed) return "";
  // Rust canonical paths use the Windows verbatim prefix; typed paths usually do not.
  if (trimmed.startsWith("\\\\?\\") && /^[A-Za-z]:\\/.test(trimmed.slice(4))) trimmed = trimmed.slice(4);
  else if (trimmed.toLowerCase().startsWith("\\\\?\\unc\\")) trimmed = `\\\\${trimmed.slice(8)}`;

  const drive = trimmed.match(/^([A-Za-z]):/);
  const isUnc = trimmed.startsWith("\\\\");
  const prefix = drive ? `${drive[1].toLowerCase()}:` : isUnc ? "\\\\" : "";
  const remainder = drive ? trimmed.slice(2) : isUnc ? trimmed.slice(2) : trimmed;
  const segments: string[] = [];
  for (const segment of remainder.split("\\")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join("\\");
  if (drive) return (joined ? `${prefix}\\${joined}` : prefix).toLowerCase();
  if (isUnc) return `${prefix}${joined}`.toLowerCase();
  return joined;
}

function isRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RecentProject>;
  return (
    typeof candidate.locator === "string" &&
    typeof candidate.lastOpenedAt === "number"
  );
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local convenience state must never prevent the workbench from opening.
  }
}

export function readRecentProjects(): RecentProject[] {
  const value = readJson<unknown>(RECENT_PROJECTS_STORAGE_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter(isRecentProject).slice(0, MAX_RECENT_PROJECTS);
}

export function readLastOpenProject(): RecentProject | null {
  const value = readJson<unknown>(LAST_OPEN_PROJECT_STORAGE_KEY);
  return isRecentProject(value) ? value : null;
}

export function recentProjectName(locator: string): string {
  const normalized = locator.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? locator;
}

export function rememberProject(view: ProjectView, replacedLocator?: string): RecentProject[] {
  const entry: RecentProject = {
    locator: view.locator,
    lastOpenedAt: Date.now(),
  };
  const identity = normalizeLocator(entry.locator);
  const replacedIdentity = replacedLocator === undefined ? undefined : normalizeLocator(replacedLocator);
  const recent = [entry, ...readRecentProjects().filter((item) => {
    const itemIdentity = normalizeLocator(item.locator);
    return itemIdentity !== identity && itemIdentity !== replacedIdentity;
  })].slice(
    0,
    MAX_RECENT_PROJECTS,
  );
  writeJson(RECENT_PROJECTS_STORAGE_KEY, recent);
  writeJson(LAST_OPEN_PROJECT_STORAGE_KEY, entry);
  return recent;
}

export function clearLastOpenProject(): void {
  try {
    localStorage.removeItem(LAST_OPEN_PROJECT_STORAGE_KEY);
  } catch {
    // Local convenience state must never block a deliberate close.
  }
}

export function removeRecentProject(locator: string): RecentProject[] {
  const identity = normalizeLocator(locator);
  const recent = readRecentProjects().filter((item) => normalizeLocator(item.locator) !== identity);
  writeJson(RECENT_PROJECTS_STORAGE_KEY, recent);
  return recent;
}
