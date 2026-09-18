import { describe, expect, it, beforeEach } from "vitest";
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

  it("uses the registry for detection order, cache and supported locales", () => {
    expect(i18n.options.detection?.order).toEqual(["localStorage", "navigator"]);
    expect(i18n.options.detection?.caches).toEqual(["localStorage"]);
    expect(i18n.options.detection?.lookupLocalStorage).toBe(UI_LOCALE_STORAGE_KEY);
    expect(i18n.options.supportedLngs).toEqual(expect.arrayContaining(localeOptions.map(({ value }) => value)));
  });

  it("allows a test-only third resource without a product language branch", async () => {
    i18n.addResourceBundle("test-locale", "translation", enUS, true, true);
    await i18n.changeLanguage("test-locale");
    expect(i18n.t("brandDescription")).toBe(enUS.brandDescription);
    await i18n.changeLanguage("en-US");
    expect(resources["en-US"].translation.brandDescription).toBe(enUS.brandDescription);
  });
});
