import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import { installDesktopBehavior } from "../desktopBehavior";
import WorkbenchApp from "./WorkbenchApp";
import "../design-system/global.css";

const preference = matchMedia("(prefers-color-scheme: dark)");
const setTheme = () => { document.documentElement.dataset.theme = preference.matches ? "dark" : "light"; };
setTheme(); preference.addEventListener("change", setTheme);
document.documentElement.dataset.platform = navigator.platform.includes("Mac") ? "macos" : "other";
const removeDesktopBehavior = isTauri() ? installDesktopBehavior() : undefined;
import.meta.hot?.dispose(() => { preference.removeEventListener("change", setTheme); removeDesktopBehavior?.(); });
createRoot(document.getElementById("root")!).render(<StrictMode><I18nextProvider i18n={i18n}><WorkbenchApp /></I18nextProvider></StrictMode>);
