import registry from "./language-names.json";

const names: Readonly<Record<string, string>> = registry.names;
const displayNames = {
  "en-US": new Intl.DisplayNames(["en-US"], { type: "language", fallback: "none" }),
  "zh-CN": new Intl.DisplayNames(["zh-CN"], { type: "language", fallback: "none" }),
};

export function languageName(tag: string, uiLocale: string): string {
  try {
    const localized = displayNames[uiLocale === "zh-CN" ? "zh-CN" : "en-US"].of(tag);
    if (localized && localized !== tag) return localized;
  } catch (error) {
    // Core accepts private-use/grandfathered tags that Intl cannot name.
    if (!(error instanceof RangeError)) throw error;
  }
  return names[tag.toLowerCase().split("-")[0]] ?? tag;
}
