import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import type { Preview } from "@storybook/react-vite";
import { i18n } from "../src/i18n";
import "../src/design-system/tokens.css";
import "../src/design-system/global.css";

function PreviewSettings({ children, theme, locale, fontScale }: { children: React.ReactNode; theme: string; locale: string; fontScale: string }) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
    document.documentElement.style.setProperty("--font-scale", fontScale);
    void i18n.changeLanguage(locale);
  }, [theme, locale, fontScale]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

const preview: Preview = {
  parameters: { layout: "fullscreen" },
  initialGlobals: { theme: "light", locale: "zh-CN", fontScale: "1" },
  globalTypes: {
    theme: { toolbar: { title: "Theme", items: ["light", "dark"], dynamicTitle: true } },
    locale: { toolbar: { title: "Language", items: ["zh-CN", "en-US"], dynamicTitle: true } },
    fontScale: { toolbar: { title: "Text size", items: [{ value: "1", title: "100%" }, { value: "2", title: "200%" }], dynamicTitle: true } },
  },
  decorators: [(Story, context) => <PreviewSettings theme={context.globals.theme} locale={context.globals.locale} fontScale={context.globals.fontScale}><Story /></PreviewSettings>],
};
export default preview;
