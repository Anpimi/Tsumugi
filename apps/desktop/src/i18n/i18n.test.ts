import { describe, expect, it, beforeEach } from "vitest";
import { createInstance } from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { enUS } from "./en-US";
import { i18n, localeOptions, resources, UI_LOCALE_STORAGE_KEY } from "./index";
import { zhCN } from "./zh-CN";

type LeafEntry = readonly [string, string];

function leafValues(value: unknown, prefix = ""): LeafEntry[] {
  if (typeof value === "string") return [[prefix, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => leafValues(child, prefix ? `${prefix}.${key}` : key));
}

function interpolationParameters(value: string): string[] {
  return [...value.matchAll(/{{\s*([^,}\s]+)[^}]*}}/g)].map((match) => match[1]).sort();
}

describe("i18n resources", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("derives shipped locale keys and interpolation parameters from English", () => {
    const english = new Map(leafValues(enUS));
    const chinese = new Map(leafValues(zhCN));
    expect([...chinese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, message] of english) {
      expect(interpolationParameters(chinese.get(key) ?? "")).toEqual(interpolationParameters(message));
    }
  });

  it.each([
    ["en-US", ["0 questions in the original proposal", "1 question in the original proposal", "2 questions in the original proposal"],
      "Uncertain matches: 3 · Possible renames: 1", "Preview rows 1–2 of 3; showing the uncertain matches on this page."],
    ["zh-CN", ["原提议中有 0 个问题", "原提议中有 1 个问题", "原提议中有 2 个问题"],
      "3 处对应不确定 · 1 处可能改名", "读取预览第 1–2 行，共 3 行；下方显示其中待核对的对应关系。"],
  ])("renders decision counts and interpolation in %s", async (locale, questions, matches, page) => {
    await i18n.changeLanguage(locale);
    expect([0, 1, 2].map(count => i18n.t("workbenchV2.decisionsProposalQuestions", { count }))).toEqual(questions);
    expect(i18n.t("workbenchV2.decisionsSourceMatches", { ambiguous: 3, renamed: 1 })).toBe(matches);
    expect(i18n.t("workbenchV2.decisionDetailsSourcePage", { from: 1, to: 2, total: 3 })).toBe(page);
  });

  it("uses the registry for detection order, cache and supported locales", () => {
    expect(i18n.options.detection?.order).toEqual(["localStorage", "navigator"]);
    expect(i18n.options.detection?.caches).toEqual(["localStorage"]);
    expect(i18n.options.detection?.lookupLocalStorage).toBe(UI_LOCALE_STORAGE_KEY);
    expect(i18n.options.supportedLngs).toEqual(expect.arrayContaining(localeOptions.map(({ value }) => value)));
  });

  it("caches an interface choice and restores it through a fresh detector without replacing the UI singleton", async () => {
    const originalStorage = localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    const originalLanguage = i18n.language, restored = createInstance();
    try {
      await i18n.changeLanguage("zh-CN");
      expect(localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("zh-CN");
      await restored.use(LanguageDetector).init({ ...i18n.options, lng: undefined });
      expect(restored.resolvedLanguage).toBe("zh-CN");
      await restored.changeLanguage("en-US");
      expect(restored.resolvedLanguage).toBe("en-US");
      expect(i18n.resolvedLanguage).toBe("zh-CN");
    } finally {
      await i18n.changeLanguage(originalLanguage);
      if (originalStorage === null) localStorage.removeItem(UI_LOCALE_STORAGE_KEY);
      else localStorage.setItem(UI_LOCALE_STORAGE_KEY, originalStorage);
    }
  });

  it("allows a test-only third resource without a product language branch", async () => {
    i18n.addResourceBundle("test-locale", "translation", enUS, true, true);
    await i18n.changeLanguage("test-locale");
    expect(i18n.t("brandDescription")).toBe(enUS.brandDescription);
    await i18n.changeLanguage("en-US");
    expect(resources["en-US"].translation.brandDescription).toBe(enUS.brandDescription);
  });
});
