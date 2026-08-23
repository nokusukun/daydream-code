/**
 * Preload bridge (CommonJS — sandboxed preloads cannot be ESM). Exposes the
 * minimal project-supervisor IPC surface; everything else the renderer does
 * goes over the harness HTTP/WS API directly.
 */
import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

interface ConnectionInfo {
  url: string;
  token: string;
  rootPath: string;
  name: string;
}

contextBridge.exposeInMainWorld("daydream", {
  getState: () => ipcRenderer.invoke("daydream:get-state"),
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
});
