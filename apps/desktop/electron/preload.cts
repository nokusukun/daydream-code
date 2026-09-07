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

interface SessionMenuRequest {
  id: string;
  name: string;
  archived: boolean;
  live: boolean;
  current: boolean;
}

type QuickActionRequest =
  | { kind: "reveal" }
  | { kind: "terminal" }
  | { kind: "command"; command: string };

interface TerminalOpenRequest {
  terminalId: string;
  attachmentId: string;
  cols: number;
  rows: number;
}

interface TerminalAttachmentRequest {
  terminalId: string;
  attachmentId: string;
}

interface TerminalWriteRequest {
  terminalId: string;
  data: string;
}

interface TerminalResizeRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

interface TerminalEventPayload {
  type: "output" | "exit";
  terminalId: string;
  sequence: number;
  data?: string;
  exitCode?: number;
  signal?: number | null;
}

contextBridge.exposeInMainWorld("daydream", {
  getWindowState: () => ipcRenderer.invoke("daydream:window-state"),
  minimizeWindow: () => ipcRenderer.invoke("daydream:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("daydream:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("daydream:window-close"),
  onWindowState: (callback: (state: { maximized: boolean }) => void) => {
    const listener = (_event: unknown, state: { maximized: boolean }): void => callback(state);
    ipcRenderer.on("daydream:window-state", listener);
    return () => ipcRenderer.removeListener("daydream:window-state", listener);
  },
  getState: () => ipcRenderer.invoke("daydream:get-state"),
  getProjectCores: () => ipcRenderer.invoke("daydream:get-project-cores"),
  onProjectCores: (callback: (connections: ConnectionInfo[]) => void) => {
    const listener = (_event: unknown, connections: ConnectionInfo[]): void => {
      callback(connections);
    };
    ipcRenderer.on("daydream:project-cores", listener);
    return () => {
      ipcRenderer.removeListener("daydream:project-cores", listener);
    };
  },
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
  setThemeSource: (choice: "system" | "light" | "dark") =>
    ipcRenderer.invoke("daydream:set-theme-source", choice),
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
  showTextContextMenu: (text: string) =>
    ipcRenderer.invoke("daydream:text-context-menu", text),
  showSessionContextMenu: (request: SessionMenuRequest) =>
    ipcRenderer.invoke("daydream:session-context-menu", request),
  runQuickAction: (request: QuickActionRequest) =>
    ipcRenderer.invoke("daydream:quick-action", request),
  openTerminal: (request: TerminalOpenRequest) =>
    ipcRenderer.invoke("daydream:terminal-open", request),
  writeTerminal: (request: TerminalWriteRequest) =>
    ipcRenderer.invoke("daydream:terminal-write", request),
  resizeTerminal: (request: TerminalResizeRequest) =>
    ipcRenderer.invoke("daydream:terminal-resize", request),
  closeTerminal: (terminalId: string) =>
    ipcRenderer.invoke("daydream:terminal-close", terminalId),
  detachTerminal: (request: TerminalAttachmentRequest) =>
    ipcRenderer.invoke("daydream:terminal-detach", request),
  listTerminals: () => ipcRenderer.invoke("daydream:terminal-list"),
  onTerminalEvent: (callback: (event: TerminalEventPayload) => void) => {
    const listener = (_event: unknown, payload: TerminalEventPayload): void => {
      callback(payload);
    };
    ipcRenderer.on("daydream:terminal-event", listener);
    return () => {
      ipcRenderer.removeListener("daydream:terminal-event", listener);
    };
  },
});
