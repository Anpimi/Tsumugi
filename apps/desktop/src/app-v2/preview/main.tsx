import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { i18n } from "../../i18n";
import { WorkbenchPreview, type PreviewScreen, type PreviewState } from "./WorkbenchPreview";
import "../../design-system/tokens.css";
import "../../design-system/global.css";

const params = new URLSearchParams(location.search);
const screen = params.get("screen");
const state = params.get("state");
const screens: readonly PreviewScreen[] = ["entries", "decisions", "delivery", "runs"];
const states: readonly PreviewState[] = ["normal", "empty", "loading", "error", "conflict", "pending", "unknown"];
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.style.setProperty("--font-scale", params.get("fontScale") === "2" ? "2" : "1");
const language = params.get("lng") === "en-US" ? "en-US" : "zh-CN";
document.documentElement.lang = language;
void i18n.changeLanguage(language).then(() => {
  createRoot(document.getElementById("root")!).render(<StrictMode><I18nextProvider i18n={i18n}>
    <WorkbenchPreview screen={screens.find((value) => value === screen)} state={states.find((value) => value === state)} />
  </I18nextProvider></StrictMode>);
});
