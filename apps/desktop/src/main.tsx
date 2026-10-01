import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { installDesktopBehavior } from "./desktopBehavior";
import "./styles.css";

const removeDesktopBehavior = isTauri() ? installDesktopBehavior() : undefined;
import.meta.hot?.dispose(() => removeDesktopBehavior?.());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
