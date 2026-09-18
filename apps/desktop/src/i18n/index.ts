import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { enUS } from "./en-US";
import { zhCN } from "./zh-CN";

export const UI_LOCALE_STORAGE_KEY = "tsumugi.uiLocale";

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

if (!i18n.isInitialized) {
  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      detection: {
        order: ["localStorage", "navigator"],
        caches: ["localStorage"],
        lookupLocalStorage: UI_LOCALE_STORAGE_KEY,
      },
      fallbackLng: "en-US",
      supportedLngs: localeOptions.map((option) => option.value),
      load: "currentOnly",
      defaultNS: "translation",
      interpolation: { escapeValue: false },
      returnNull: false,
    });
}

export function isLocale(value: string): value is Locale {
  return localeOptions.some((option) => option.value === value);
}

export { i18n };
