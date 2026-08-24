/**
 * Preload bridge (CommonJS — sandboxed preloads cannot be ESM). Exposes the
 * minimal project-supervisor IPC surface; everything else the renderer does
 * goes over the harness HTTP/WS API directly.
 */
import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

interface Appearance {
  accent: string;
  dark: boolean;
  platform: string;
  vibrancy: boolean;
}

interface ConnectionInfo {
  url: string;
  token: string;
  rootPath: string;
  name: string;
}

type CodeContextMenuRequest =
  | {
      kind: "selection";
      path: string;
      text: string;
      lineStart?: number;
      lineEnd?: number;
    }
  | { kind: "file"; path: string; dir: boolean; expanded?: boolean };

contextBridge.exposeInMainWorld("daydream", {
  getState: () => ipcRenderer.invoke("daydream:get-state"),
  listProjects: () => ipcRenderer.invoke("daydream:list-projects"),
  openProject: (rootPath: string) =>
    ipcRenderer.invoke("daydream:open-project", rootPath),
  pickProject: () => ipcRenderer.invoke("daydream:pick-project"),
  onConnection: (callback: (info: ConnectionInfo) => void) => {
    const listener = (_event: unknown, info: ConnectionInfo): void => {
      callback(info);
    };
    ipcRenderer.on("daydream:connection", listener);
    return () => {
      ipcRenderer.removeListener("daydream:connection", listener);
    };
  },
  openSettings: () => ipcRenderer.invoke("daydream:open-settings"),
  getAppearance: () => ipcRenderer.invoke("daydream:get-appearance"),
  onAppearance: (callback: (appearance: Appearance) => void) => {
    const listener = (_event: unknown, appearance: Appearance): void => {
      callback(appearance);
    };
    ipcRenderer.on("daydream:appearance", listener);
    return () => {
      ipcRenderer.removeListener("daydream:appearance", listener);
    };
  },
  showCodeContextMenu: (request: CodeContextMenuRequest) =>
    ipcRenderer.invoke("daydream:code-context-menu", request),
});
