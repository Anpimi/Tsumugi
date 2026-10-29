import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { installDesktopBehavior } from "./desktopBehavior";
import "./styles.css";
import "./design-system/tokens.css";

const appearance = matchMedia("(prefers-color-scheme: dark)");
const applyAppearance = () => { document.documentElement.dataset.theme = appearance.matches ? "dark" : "light"; };
applyAppearance(); appearance.addEventListener("change", applyAppearance);

const removeDesktopBehavior = isTauri() ? installDesktopBehavior() : undefined;
import.meta.hot?.dispose(() => { appearance.removeEventListener("change", applyAppearance); removeDesktopBehavior?.(); });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
