import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { SettingsApp } from "./SettingsApp.js";
import { isSettingsWindow } from "./bridge.js";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");

// One bundle, two windows. The settings window loads the same HTML with
// `#view=settings`, which is cheaper than a second entry point and keeps the
// theme, tokens and appearance plumbing identical in both.
const Root = isSettingsWindow() ? SettingsApp : App;
document.documentElement.classList.toggle("is-settings", isSettingsWindow());

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
