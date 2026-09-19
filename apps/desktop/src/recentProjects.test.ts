import { beforeEach, describe, expect, it } from "vitest";
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

  it("normalizes equivalent Windows spellings without persisting project metadata", () => {
    expect(normalizeLocator("C:/Projects/./Demo/../demo/")).toBe("c:\\projects\\demo");

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
});
