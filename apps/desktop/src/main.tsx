import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { SettingsApp } from "./SettingsApp.js";
import { isSettingsWindow } from "./bridge.js";
import { defaultModuleLoaders } from "./modules/defaults.js";
import { DesktopModulesProvider, ModuleBoundary } from "./modules/react.js";
import { DesktopModuleRuntime } from "./modules/runtime.js";
import type { DesktopHost } from "./modules/host.js";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");

// One bundle, two windows. The settings window loads the same HTML with
// `#view=settings`, which is cheaper than a second entry point and keeps the
// theme, tokens and appearance plumbing identical in both.
const settingsWindow = isSettingsWindow();
const Root = settingsWindow ? SettingsApp : App;
document.documentElement.classList.toggle("is-settings", settingsWindow);

const modules = new DesktopModuleRuntime<DesktopHost>();
if (!settingsWindow) modules.load(defaultModuleLoaders);

createRoot(container).render(
  <StrictMode>
    <DesktopModulesProvider runtime={modules}>
      <ModuleBoundary moduleId="desktop-shell" surface="root">
        <Root />
      </ModuleBoundary>
    </DesktopModulesProvider>
  </StrictMode>,
);
