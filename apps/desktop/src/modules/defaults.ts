import type { DesktopModuleLoader } from "./runtime.js";
import type { DesktopHost } from "./host.js";

/**
 * The host knows only how to discover modules. Each import is a separate fault
 * domain and Vite chunk; adding a feature does not add another static import to
 * App.tsx.
 */
export const defaultModuleLoaders: readonly DesktopModuleLoader<DesktopHost>[] = [
  {
    id: "agent",
    name: "Thread workspace",
    load: () => import("./features/agent.js"),
  },
  {
    id: "code",
    name: "Code workspace",
    load: () => import("./features/code.js"),
  },
  {
    id: "terminal",
    name: "Terminal",
    load: () => import("./features/terminal.js"),
  },
  {
    id: "activity",
    name: "Project activity",
    load: () => import("./features/activity.js"),
  },
  {
    id: "quick-actions",
    name: "Quick actions",
    load: () => import("./features/quick-actions.js"),
  },
  {
    id: "app-menu",
    name: "Application menu",
    load: () => import("./features/app-menu.js"),
  },
  {
    id: "palette",
    name: "Command palette",
    load: () => import("./features/palette.js"),
  },
  {
    id: "fibers",
    name: "Plugin diagnostics",
    load: () => import("./features/fibers.js"),
  },
  {
    id: "archive",
    name: "Thread archive",
    load: () => import("./features/archive.js"),
  },
  {
    id: "handoff",
    name: "Thread handoff",
    load: () => import("./features/handoff.js"),
  },
];
