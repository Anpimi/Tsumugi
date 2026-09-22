import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_OPEN_PROJECT_STORAGE_KEY,
  MAX_RECENT_PROJECTS,
  RECENT_PROJECTS_STORAGE_KEY,
  clearLastOpenProject,
  normalizeLocator,
  readLastOpenProject,
  readRecentProjects,
  rememberProject,
  removeRecentProject,
} from "./recentProjects";
import type { ProjectView } from "./projectCommands";

function project(locator: string, displayName = "Demo"): ProjectView {
  return {
    sessionToken: "session-1",
    locator,
    metadata: {
      projectId: "123e4567-e89b-42d3-a456-426614174000",
      displayName,
      sourceLocale: "en-US",
      targetLocales: ["zh-Hans"],
      metadataRevision: "1",
    },
    reconciliationState: "settled",
  };
}

describe("recent project convenience state", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps convenience storage failures from blocking project operations", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(readRecentProjects()).toEqual([]);
    expect(readLastOpenProject()).toBeNull();
    expect(rememberProject(project("C:\\Projects\\demo"))).toEqual([{ locator: "C:\\Projects\\demo", lastOpenedAt: expect.any(Number) }]);
    expect(removeRecentProject("C:\\Projects\\demo")).toEqual([]);
    expect(() => clearLastOpenProject()).not.toThrow();
  });

  it("normalizes equivalent Windows spellings without persisting project metadata", () => {
    expect(normalizeLocator("C:/Projects/./Demo/../demo/")).toBe("c:\\projects\\demo");
    expect(normalizeLocator("\\\\?\\C:\\Projects\\demo")).toBe(normalizeLocator("C:/Projects/./demo/"));
    expect(normalizeLocator("\\\\?\\UNC\\server\\share\\demo")).toBe(normalizeLocator("\\\\server\\share\\demo"));

    rememberProject(project("C:\\Projects\\demo", "Private name"));

    expect(JSON.parse(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY) ?? "null")).toEqual([
      { locator: "C:\\Projects\\demo", lastOpenedAt: expect.any(Number) },
    ]);
    expect(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY)).not.toContain("Private name");
    expect(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY)).not.toContain("session-1");
    expect(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY)).not.toContain("projectId");
  });

  it("deduplicates, bounds, removes, and clears last-open state", () => {
    for (let index = 0; index < MAX_RECENT_PROJECTS + 2; index += 1) {
      rememberProject(project(`C:\\Projects\\project-${index}`));
    }

    expect(readRecentProjects()).toHaveLength(MAX_RECENT_PROJECTS);
    rememberProject(project("c:/Projects/PROJECT-1", "Updated"));
    expect(readRecentProjects().filter((item) => normalizeLocator(item.locator) === "c:\\projects\\project-1")).toHaveLength(1);

    const remaining = removeRecentProject("C:/Projects/PROJECT-1");
    expect(remaining.some((item) => normalizeLocator(item.locator) === "c:\\projects\\project-1")).toBe(false);
    expect(readLastOpenProject()?.locator).toBe("c:/Projects/PROJECT-1");
    clearLastOpenProject();
    expect(readLastOpenProject()).toBeNull();
    expect(localStorage.getItem(LAST_OPEN_PROJECT_STORAGE_KEY)).toBeNull();
  });

  it("ignores malformed stored values", () => {
    localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify([{ locator: 1 }, "bad"]));
    localStorage.setItem(LAST_OPEN_PROJECT_STORAGE_KEY, JSON.stringify({ locator: "C:\\Projects" }));

    expect(readRecentProjects()).toEqual([]);
    expect(readLastOpenProject()).toBeNull();
  });

  it("replaces only a confirmed previous locator while preserving unrelated recent projects", () => {
    rememberProject(project("C:\\Projects\\unrelated"));
    rememberProject(project("C:\\Projects\\old"));
    rememberProject(project("C:\\Projects\\new"), "c:/projects/OLD");
    expect(readRecentProjects().map((item) => item.locator)).toEqual(["C:\\Projects\\new", "C:\\Projects\\unrelated"]);
    expect(readLastOpenProject()?.locator).toBe("C:\\Projects\\new");
  });
});
