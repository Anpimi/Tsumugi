import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { enUS } from "./en-US";
import { zhCN } from "./zh-CN";

export const localeOptions = [
  { value: "en-US", labelKey: "languageEnglish" },
  { value: "zh-CN", labelKey: "languageChinese" },
] as const;

export type Locale = (typeof localeOptions)[number]["value"];

export const resources = {
  "en-US": { translation: enUS },
  "zh-CN": { translation: zhCN },
} as const;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: typeof resources["en-US"];
    returnNull: false;
  }
}

function initialLocale(): Locale {
  try {
    return window.localStorage.getItem("tsumugi.uiLocale") === "zh-CN" ? "zh-CN" : "en-US";
  } catch {
    return "en-US";
  }
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: initialLocale(),
    fallbackLng: "en-US",
    supportedLngs: localeOptions.map((option) => option.value),
    defaultNS: "translation",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export function isLocale(value: string): value is Locale {
  return localeOptions.some((option) => option.value === value);
}

export { i18n };
